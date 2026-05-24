/**
 * OutboxWorker — DB 트랜잭션과 외부 호출의 원자성 보장 (Phase 3: 권장)
 *
 * ─ Outbox 패턴이 해결하는 문제 ─
 *
 * 현재 방식 (Phase 1):
 *   1. DB INSERT: mint_requests (status=REQUESTED)
 *   2. 외부 호출: VASP API submitMint()
 *   3. DB UPDATE: status=SUBMITTED
 *
 *   문제: 2번 성공 후 3번 실패 시 → DB는 REQUESTED, VASP는 발행 진행 중
 *         → 불일치 상태. pollStaleRequests가 30분 후에야 감지.
 *
 * Outbox 방식 (Phase 3):
 *   단일 DB 트랜잭션:
 *     INSERT mint_requests (status=REQUESTED)
 *     INSERT outbox_events (payload=VASP_SUBMIT_MINT, status=PENDING)
 *   ← 여기까지 원자적
 *
 *   OutboxWorker (별도 프로세스):
 *     outbox_events에서 PENDING 조회 → VASP API 호출
 *     성공 시: outbox_events.status=PROCESSED + mint_requests.status=SUBMITTED
 *     실패 시: 재시도 (지수 백오프)
 *
 *   보장: DB와 외부 시스템이 절대 불일치 없음
 *         OutboxWorker는 멱등하게 구현 (requestId 기반)
 *
 * Phase 1 현황:
 *   VASP(월렛원)의 신뢰성이 높고, TX 수가 적어 불일치 허용 가능.
 *   pollStaleRequests가 사후 보정 역할.
 *
 * Phase 3 권장 이유:
 *   직접 Custody 전환 시 VASP 호출 실패가 내부 로직 실패가 됨.
 *   Outbox 없이는 DB-체인 불일치 복구가 수동 개입 필요.
 *
 */

// ── 타입 ─────────────────────────────────────────────────────────────────────

export type OutboxEventType =
  | 'VASP_SUBMIT_MINT'
  | 'VASP_SUBMIT_BURN'
  | 'LEDGER_UPDATE_HOLDING'
  | 'AUDIT_LOG_EMIT';

export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'DEAD';

export interface OutboxEvent {
  id:          string;
  type:        OutboxEventType;
  payload:     Record<string, unknown>;
  status:      OutboxStatus;
  attemptCount: number;
  nextRetryAt: Date;
  processedAt?: Date;
  createdAt:   Date;
}

export type OutboxHandler = (payload: Record<string, unknown>) => Promise<void>;

// ── OutboxWorker ──────────────────────────────────────────────────────────────

/**
 * Phase 3: PENDING 이벤트 처리 워커
 *
 * DB 스키마 (Phase 3):
 *   CREATE TABLE outbox_events (
 *     id            UUID PRIMARY KEY,
 *     type          VARCHAR(64) NOT NULL,
 *     payload       JSONB NOT NULL,
 *     status        VARCHAR(16) NOT NULL DEFAULT 'PENDING',
 *     attempt_count INT NOT NULL DEFAULT 0,
 *     next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     processed_at  TIMESTAMPTZ,
 *     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *   CREATE INDEX idx_outbox_pending ON outbox_events(status, next_retry_at)
 *     WHERE status = 'PENDING';
 */
export class OutboxWorker {
  private static readonly MAX_ATTEMPTS = 5;
  private static readonly BATCH_SIZE   = 10;

  constructor(
    private readonly db: { query(sql: string, params?: unknown[]): Promise<unknown[]> },
    private readonly handlers: Partial<Record<OutboxEventType, OutboxHandler>> = {},
  ) {}

  /**
   * PENDING 이벤트 일괄 처리
   *   1. UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING
   *      → 짧은 트랜잭션으로 PROCESSING 상태로 선점 (동시 워커 중복 방지)
   *   2. 이벤트 유형별 핸들러 호출
   *   3. 성공: status=PROCESSED, processed_at=NOW()
   *   4. 실패: attempt_count++, next_retry_at=NOW()+2^attempt초, MAX_ATTEMPTS 초과 시 status=DEAD
   */
  async processPending(): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed    = 0;

    // 짧은 트랜잭션으로 배치 선점 — 락 보유 시간 최소화
    await this.db.query('BEGIN');
    let claimed: Array<{ id: string; type: OutboxEventType; payload: Record<string, unknown>; attempt_count: number }>;
    try {
      const rows = await this.db.query(
        `UPDATE outbox_events
         SET status = 'PROCESSING'
         WHERE id IN (
           SELECT id FROM outbox_events
           WHERE status = 'PENDING' AND next_retry_at <= NOW()
           ORDER BY next_retry_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, type, payload, attempt_count`,
        [OutboxWorker.BATCH_SIZE],
      );
      await this.db.query('COMMIT');
      claimed = rows as typeof claimed;
    } catch (err) {
      await this.db.query('ROLLBACK');
      throw err;
    }

    for (const event of claimed) {
      try {
        const handler = this.handlers[event.type];
        if (handler) {
          await handler(event.payload);
        }
        await this.db.query(
          `UPDATE outbox_events SET status = 'PROCESSED', processed_at = NOW() WHERE id = $1`,
          [event.id],
        );
        processed++;
      } catch (err) {
        const nextAttempt = event.attempt_count + 1;
        const isDead      = nextAttempt >= OutboxWorker.MAX_ATTEMPTS;
        const backoffSecs = Math.pow(2, nextAttempt);

        await this.db.query(
          `UPDATE outbox_events
           SET status        = $1,
               attempt_count = $2,
               next_retry_at = NOW() + ($3 * INTERVAL '1 second')
           WHERE id = $4`,
          [isDead ? 'DEAD' : 'PENDING', nextAttempt, backoffSecs, event.id],
        );
        failed++;
      }
    }

    return { processed, failed };
  }
}
