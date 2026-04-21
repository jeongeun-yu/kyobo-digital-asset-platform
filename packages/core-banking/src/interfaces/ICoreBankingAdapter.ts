/**
 * ICoreBankingAdapter — 교보생명 Core Banking 시스템 연동 인터페이스
 *
 * Phase 1: NFT 발행 후 포인트/쿠폰 상태 업데이트 알림
 * Phase 2: KRW 스테이블코인 발행/소각 ↔ 실계좌 잔액 동기화
 * Phase 3: STO 매수 결제 처리 ↔ 증권 계좌 연동
 *
 * Core Banking API 스펙은 교보DTS 내부 시스템에 따라 결정.
 * 이 인터페이스가 확정되면 양측이 독립적으로 구현 가능.
 */

export interface UserAccount {
  userId:     string;
  accountId:  string;
  walletAddr: string;
  status:     'active' | 'suspended' | 'closed';
}

export interface RewardNotification {
  userId:      string;
  rewardType:  string;
  tokenId:     string;
  txHash:      string;
  issuedAt:    number;
  metadata?:   Record<string, unknown>;
}

export interface BalanceSyncRequest {
  accountId:  string;
  tokenAddr:  string;
  amount:     bigint;
  direction:  'mint' | 'burn';
  txHash:     string;
}

export interface ICoreBankingAdapter {
  /**
   * 사용자 계정 조회 — KYC 상태·지갑 주소 매핑 확인
   */
  getUserAccount(userId: string): Promise<UserAccount | null>;

  /**
   * NFT 발행 완료 알림 → 포인트·쿠폰 시스템 상태 업데이트
   */
  notifyReward(notification: RewardNotification): Promise<void>;

  /**
   * Phase 2: 원화 입금 → 스테이블코인 발행 요청
   */
  syncBalance(req: BalanceSyncRequest): Promise<{ confirmed: boolean }>;

  /**
   * 거래 이력 기록 — 감사 추적 (ISMS-P 요건)
   */
  recordTransaction(tx: {
    txHash:   string;
    userId:   string;
    type:     string;
    amount:   string;
    status:   string;
    timestamp: number;
  }): Promise<void>;
}
