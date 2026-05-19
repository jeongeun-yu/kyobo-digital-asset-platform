import type { ReconcileAdminService } from './ReconcileAdminService';

// express 타입 로컬 정의 (core-banking 패키지에 express 미포함)
interface Request  { query: Record<string, unknown>; body: unknown; }
interface Response { status(c: number): this; json(body: unknown): void; }
interface Router   {
  get(path: string, handler: (req: Request, res: Response) => Promise<void>): void;
  post(path: string, handler: (req: Request, res: Response) => Promise<void>): void;
}

/**
 * ReconcileAdminRouter — Reconcile 관리 API (S54 실습 2)
 *
 * 엔드포인트:
 *   GET  /admin/reconcile/history   — 실행 이력 조회
 *   POST /admin/reconcile/run       — 특정 userId 수동 트리거
 */
export function registerReconcileAdminRoutes(
  router:        Router,
  reconcileAdmin: ReconcileAdminService,
): void {

  // ── 실습 2-A: 실행 이력 조회 ──────────────────────────────────
  router.get('/admin/reconcile/history', async (req: Request, res: Response) => {
    const limit   = Number(req.query['limit'])   || 20;
    const runType = req.query['runType'] as string | undefined;

    // TODO: reconcile_history 테이블에서 조회
    //   SELECT run_at, run_type, target_count, mismatch_count,
    //          mismatch_user_ids, duration_ms
    //   FROM reconcile_history
    //   WHERE run_type = $runType (있을 때만)
    //   ORDER BY run_at DESC
    //   LIMIT $limit
    //
    // 응답 형식:
    //   { history: [ { run_at, run_type, target_count, mismatch_count,
    //                  mismatch_user_ids, duration_ms }, ... ] }
    void limit; void runType;
    res.status(501).json({ error: 'Not implemented' });
  });

  // ── 실습 2-B: 수동 reconcile 트리거 ──────────────────────────
  router.post('/admin/reconcile/run', async (req: Request, res: Response) => {
    const { userId, operator, reason } = req.body as {
      userId:   string;
      operator: string;
      reason?:  string;
    };

    // TODO: userId, operator 유효성 검사 (없으면 400)

    // TODO: reconcileAdmin.runManualReconcile(userId, operator) 호출
    //   결과를 아래 형식으로 응답:
    //   {
    //     userId,
    //     mismatch:      result.mismatchCount > 0,
    //     mismatchCount: result.mismatchCount,
    //     durationMs:    result.durationMs,
    //   }
    void userId; void operator; void reason; void reconcileAdmin;
    res.status(501).json({ error: 'Not implemented' });
  });
}
