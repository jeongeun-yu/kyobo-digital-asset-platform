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

    const result = await reconcileAdmin.getHistory(limit, runType);
    res.status(200).json({ history: result });
  });

  // ── 실습 2-B: 수동 reconcile 트리거 ──────────────────────────
  router.post('/admin/reconcile/run', async (req: Request, res: Response) => {
    const { userId, operator, reason } = req.body as {
      userId:   string;
      operator: string;
      reason?:  string;
    };

    if (!userId || !operator) {
      res.status(400).json({ error: 'userId and operator are required' });
      return;
    }

    void reason;
    const result = await reconcileAdmin.runManualReconcile(userId, operator);
    res.status(200).json({
      userId,
      mismatch:      result.mismatchCount > 0,
      mismatchCount: result.mismatchCount,
      durationMs:    result.durationMs,
    });
  });
}
