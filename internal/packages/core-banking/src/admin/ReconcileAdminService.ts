import type { ReconcileService }  from '../reconcile/ReconcileService';
import type { AuditLogService }    from '../audit/AuditLogService';

// ── 공유 타입 ─────────────────────────────────────────────────

interface DatabaseClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface NotifierAdapter {
  sendAlert(payload: {
    title:    string;
    severity: 'P1' | 'P2' | 'P3';
    body:     string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface ReconcileRunResult {
  runAt:           Date;
  runType:         'HOURLY' | 'DAILY' | 'MANUAL';
  targetCount:     number;
  mismatchCount:   number;
  mismatchUserIds: string[];
  durationMs:      number;
}

// ── ReconcileAdminService ────────────────────────────────────

/**
 * ReconcileAdminService — Reconcile 운영 레이어 (S54)
 *
 * S25 ReconcileService는 단일 사용자 검증 로직만 가진다.
 * 이 서비스는 "언제, 누구를, 어떻게 실행하는가"를 담당한다.
 *
 * 실행 유형:
 *   HOURLY — 최근 1시간 변경된 사용자만 (비용 절감)
 *   DAILY  — 전체 사용자 순회 (누적 오차 감지)
 *   MANUAL — 운영자 수동 트리거 (보정 후 재검증)
 */
export class ReconcileAdminService {
  constructor(
    private readonly db:               DatabaseClient,
    private readonly reconcileService: ReconcileService,
    private readonly auditLog:         AuditLogService,
    private readonly notifier:         NotifierAdapter,
  ) {}

  // ── 실습 1-A: Hourly Reconcile ───────────────────────────────
  async runHourlyReconcile(): Promise<ReconcileRunResult> {
    const start = Date.now();
    const runAt = new Date();

    // TODO: 최근 1시간 내 업데이트된 user_nft_holdings 사용자 조회
    //   SELECT DISTINCT user_id FROM user_nft_holdings
    //   WHERE updated_at >= NOW() - INTERVAL '1 hour'
    const userIds: string[] = [];

    return this._runReconcileForUsers(userIds, 'HOURLY', start, runAt);
  }

  // ── 실습 1-B: Daily Reconcile ────────────────────────────────
  async runDailyReconcile(): Promise<ReconcileRunResult> {
    const start = Date.now();
    const runAt = new Date();

    // TODO: 전체 사용자 조회
    //   SELECT DISTINCT user_id FROM user_nft_holdings ORDER BY user_id
    const userIds: string[] = [];

    return this._runReconcileForUsers(userIds, 'DAILY', start, runAt);
  }

  // ── 실습 1-C: Manual Reconcile ───────────────────────────────
  async runManualReconcile(userId: string, operator: string): Promise<ReconcileRunResult> {
    const start = Date.now();
    const runAt = new Date();

    // TODO: 수동 트리거 감사 로그 기록
    //   this.auditLog.log({ actor: operator, action: 'RECONCILE_MANUAL_TRIGGER', ... })

    return this._runReconcileForUsers([userId], 'MANUAL', start, runAt);
  }

  // ── 공통 실행 로직 ────────────────────────────────────────────
  private async _runReconcileForUsers(
    userIds:  string[],
    runType:  ReconcileRunResult['runType'],
    startMs:  number,
    runAt:    Date,
  ): Promise<ReconcileRunResult> {
    const mismatchUserIds: string[] = [];

    for (const userId of userIds) {
      try {
        // TODO: reconcileService.reconcileNftHoldings(userId) 호출
        //   결과가 !isHealthy이면 mismatchUserIds에 추가
        //   불일치 발견 시 auditLog.log({ action: 'RECONCILE_MISMATCH_DETECTED', ... }) 기록
        void userId;
      } catch (err) {
        console.error(`[ReconcileAdmin] reconcile 오류 userId=${userId}`, err);
      }
    }

    const durationMs = Date.now() - startMs;
    const runResult: ReconcileRunResult = {
      runAt,
      runType,
      targetCount:    userIds.length,
      mismatchCount:  mismatchUserIds.length,
      mismatchUserIds,
      durationMs,
    };

    // TODO: reconcile_history 테이블에 runResult 저장
    //   INSERT INTO reconcile_history (run_at, run_type, target_count, ...) VALUES (...)

    // TODO: _sendMismatchAlert() 호출
    void runResult;

    return runResult;
  }

  // ── 실습 1-D: 불일치 알림 ────────────────────────────────────
  private async _sendMismatchAlert(
    mismatchCount: number,
    runType:       string,
    result:        ReconcileRunResult,
  ): Promise<void> {
    if (mismatchCount === 0) return;

    // TODO: 건수별 심각도 결정
    //   10건+ → 'P1' / 5~9건 → 'P2' / 1~4건 → 'P3'
    // TODO: this.notifier.sendAlert() 호출
    void runType; void result;
  }
}
