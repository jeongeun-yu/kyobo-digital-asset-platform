/**
 * ReconcileAdmin cron 등록 (S54 실습 3)
 *
 * node-cron 또는 NestJS @Cron으로 두 계층 스케줄 등록:
 *   Hourly — 매시간 정각, 최근 1시간 변경 사용자만
 *   Daily  — 새벽 3시 KST, 전체 사용자 순회
 *
 * 실행 전 조건:
 *   ReconcileAdminService 인스턴스가 DI 컨테이너 또는
 *   팩토리에서 주입돼야 한다.
 */

import type { ReconcileAdminService } from './ReconcileAdminService';

export function registerReconcileCron(
  reconcileAdmin: ReconcileAdminService,
): void {

  // TODO: node-cron import 후 아래 두 스케줄 등록
  //
  // Hourly — '0 * * * *' (Asia/Seoul)
  //   시작 로그 출력
  //   reconcileAdmin.runHourlyReconcile() 실행
  //   완료 로그: 대상 N명, 불일치 N건
  //   오류 시 notifier.sendAlert({ severity: 'P2', ... })
  //
  // Daily — '0 3 * * *' (Asia/Seoul)
  //   시작 로그 출력
  //   reconcileAdmin.runDailyReconcile() 실행
  //   완료 로그: 대상 N명, 불일치 N건, 소요 Nms
  //   오류 시 notifier.sendAlert({ severity: 'P1', ... })

  void reconcileAdmin;
}

export { ReconcileAdminService }  from './ReconcileAdminService';
export { registerReconcileAdminRoutes } from './ReconcileAdminRouter';
