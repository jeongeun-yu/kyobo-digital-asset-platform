import type {
  ICoreBankingAdapter,
  UserAccount,
  RewardNotification,
  BalanceSyncRequest,
} from '../interfaces/ICoreBankingAdapter';

/**
 * KyoboCoreBankingAdapter — 교보DTS Core Banking API 연동 구현체
 *
 * API 엔드포인트·인증 방식은 교보DTS 내부 규격에 따름.
 * 현재는 stub — 교보DTS와 API 스펙 협의 후 채운다.
 *
 * 연동 방식 후보:
 *   A. REST API (교보 내부망 → DMZ 경유)
 *   B. Kafka 이벤트 스트리밍
 *   C. DB Direct (비권장 — 결합도 높음)
 * → 교보DTS와 협의하여 A 또는 B 결정 필요 (Sharon 주도)
 */
export class KyoboCoreBankingAdapter implements ICoreBankingAdapter {
  constructor(private readonly config: {
    baseUrl: string;
    clientId: string;
    clientSecret: string;  // KMS에서 주입
  }) {}

  async getUserAccount(userId: string): Promise<UserAccount | null> {
    // TODO: 교보 Core Banking API 호출
    throw new Error(`KyoboCoreBankingAdapter.getUserAccount not implemented: ${userId}`);
  }

  async notifyReward(notification: RewardNotification): Promise<void> {
    // TODO: 포인트·쿠폰 시스템 업데이트 API 호출
    console.log('[CoreBanking] notifyReward stub:', notification);
  }

  async syncBalance(req: BalanceSyncRequest): Promise<{ confirmed: boolean }> {
    // TODO: Phase 2 — 원화 ↔ 스테이블코인 잔액 동기화
    throw new Error(`KyoboCoreBankingAdapter.syncBalance not implemented: ${req.txHash}`);
  }

  async recordTransaction(tx: {
    txHash: string; userId: string; type: string;
    amount: string; status: string; timestamp: number;
  }): Promise<void> {
    // TODO: 감사 로그 DB 기록
    console.log('[CoreBanking] recordTransaction stub:', tx);
  }
}
