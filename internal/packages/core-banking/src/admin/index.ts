/**
 * ReconcileAdmin cron 등록 (S54 실습 3)
 *
 * node-cron으로 두 계층 스케줄 등록:
 *   Hourly — 매시간 정각, 최근 1시간 변경 사용자만
 *   Daily  — 새벽 3시 KST, 전체 사용자 순회
 */

import cron from 'node-cron';
import type { ReconcileAdminService } from './ReconcileAdminService';

export function registerReconcileCron(
  reconcileAdmin: ReconcileAdminService,
): void {

  // Hourly — '0 * * * *' (Asia/Seoul)
  cron.schedule('0 * * * *', async () => {
    console.log('[ReconcileCron] Hourly 시작');
    try {
      const result = await reconcileAdmin.runHourlyReconcile();
      console.log(
        `[ReconcileCron] Hourly 완료 — 대상 ${result.targetCount}명, 불일치 ${result.mismatchCount}건`,
      );
    } catch (err) {
      console.error('[ReconcileCron] Hourly 오류', err);
    }
  }, { timezone: 'Asia/Seoul' });

  // Daily — '0 3 * * *' (Asia/Seoul)
  cron.schedule('0 3 * * *', async () => {
    console.log('[ReconcileCron] Daily 시작');
    try {
      const result = await reconcileAdmin.runDailyReconcile();
      console.log(
        `[ReconcileCron] Daily 완료 — 대상 ${result.targetCount}명, 불일치 ${result.mismatchCount}건, 소요 ${result.durationMs}ms`,
      );
    } catch (err) {
      console.error('[ReconcileCron] Daily 오류', err);
    }
  }, { timezone: 'Asia/Seoul' });
}

export { ReconcileAdminService }  from './ReconcileAdminService';
export { registerReconcileAdminRoutes } from './ReconcileAdminRouter';
