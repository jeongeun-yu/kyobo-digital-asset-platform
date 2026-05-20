import type { ReconcileService }  from '../reconcile/ReconcileService';
import type { ICoreBankingAdapter } from '../interfaces/ICoreBankingAdapter';

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
    private readonly auditLog:         ICoreBankingAdapter,
    private readonly notifier:         NotifierAdapter,
  ) {}

  // ── 이력 조회 (Router 2-A 지원) ──────────────────────────────
  async getHistory(limit: number, runType?: string): Promise<Record<string, unknown>[]> {
    const conditions: string[] = [];
    const params: unknown[]    = [];

    if (runType) {
      conditions.push(`run_type = $${params.length + 1}`);
      params.push(runType);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const { rows } = await this.db.query(
      `SELECT run_at, run_type, target_count, mismatch_count,
              mismatch_user_ids, duration_ms
       FROM reconcile_history
       ${where}
       ORDER BY run_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  // ── 실습 1-A: Hourly Reconcile ───────────────────────────────
  async runHourlyReconcile(): Promise<ReconcileRunResult> {
    const start = Date.now();
    const runAt = new Date();

    const { rows } = await this.db.query(
      `SELECT DISTINCT user_id FROM user_nft_holdings
       WHERE updated_at >= NOW() - INTERVAL '1 hour'`,
    );
    const userIds = rows.map(r => r['user_id'] as string);

    return this._runReconcileForUsers(userIds, 'HOURLY', start, runAt);
  }

  // ── 실습 1-B: Daily Reconcile ────────────────────────────────
  async runDailyReconcile(): Promise<ReconcileRunResult> {
    const start = Date.now();
    const runAt = new Date();

    const { rows } = await this.db.query(
      `SELECT DISTINCT user_id FROM user_nft_holdings ORDER BY user_id`,
    );
    const userIds = rows.map(r => r['user_id'] as string);

    return this._runReconcileForUsers(userIds, 'DAILY', start, runAt);
  }

  // ── 실습 1-C: Manual Reconcile ───────────────────────────────
  async runManualReconcile(userId: string, operator: string): Promise<ReconcileRunResult> {
    const start = Date.now();
    const runAt = new Date();

    await this.auditLog.recordAuditLog({
      actor:      operator,
      action:     'RECONCILE_MANUAL_TRIGGER',
      resourceId: userId,
      resourceType: 'USER',
      afterState: { triggeredAt: runAt.toISOString() },
    });

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
        const result = await this.reconcileService.reconcileNftHoldings(userId);
        if (!result.isHealthy) {
          mismatchUserIds.push(userId);
          await this.auditLog.recordAuditLog({
            actor:        'SYSTEM',
            action:       'RECONCILE_MISMATCH_DETECTED',
            resourceId:   userId,
            resourceType: 'USER',
            afterState:   { discrepancies: result.discrepancies },
          });
        }
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

    await this.db.query(
      `INSERT INTO reconcile_history
         (run_at, run_type, target_count, mismatch_count, mismatch_user_ids, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        runResult.runAt,
        runResult.runType,
        runResult.targetCount,
        runResult.mismatchCount,
        JSON.stringify(runResult.mismatchUserIds),
        runResult.durationMs,
      ],
    );

    await this._sendMismatchAlert(runResult.mismatchCount, runType, runResult);

    return runResult;
  }

  // ── 실습 1-D: 불일치 알림 ────────────────────────────────────
  private async _sendMismatchAlert(
    mismatchCount: number,
    runType:       string,
    result:        ReconcileRunResult,
  ): Promise<void> {
    if (mismatchCount === 0) return;

    const severity = mismatchCount >= 10 ? 'P1'
                   : mismatchCount >= 5  ? 'P2'
                   :                       'P3';

    await this.notifier.sendAlert({
      title:    `[Reconcile] ${runType} 불일치 ${mismatchCount}건`,
      severity,
      body:     `대상 ${result.targetCount}명 중 ${mismatchCount}명 불일치 (소요 ${result.durationMs}ms)`,
      metadata: { mismatchUserIds: result.mismatchUserIds, runAt: result.runAt.toISOString() },
    });
  }
}
