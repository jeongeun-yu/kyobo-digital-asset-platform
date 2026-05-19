/**
 * ICoreBankingAdapter — 원장/Core Banking 시스템 연동 인터페이스
 *
 * Phase 1 (확정): NFT 발행 후 사용자 잔액/보유 상태 업데이트 알림
 * 향후 확장: 스테이블코인/실물 자산 정산 연동 (원장 API 확정 후 구현)
 *
 * Core Banking API 스펙은 원장 DTS API 시스템에 따라 확정.
 * 이 인터페이스가 확정되면 KyoboCoreBankingAdapter로 구현 교체.
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
   * 사용자 계정 조회 — KYC 상태/지갑 주소 보유 여부 확인
   */
  getUserAccount(userId: string): Promise<UserAccount | null>;

  /**
   * NFT 발행 완료 알림 — 사용자 보유 자산 시스템 상태 업데이트
   */
  notifyReward(notification: RewardNotification): Promise<void>;

  /**
   * Phase 2: 실시간 온체인 스테이블코인 발행 요청
   */
  syncBalance(req: BalanceSyncRequest): Promise<{ confirmed: boolean }>;

  /**
   * 원장 거래 기록 — 감사 추적 (ISMS-P 요건)
   */
  recordTransaction(tx: {
    txHash:   string;
    userId:   string;
    type:     string;
    amount:   string;
    status:   string;
    timestamp: number;
  }): Promise<void>;

  // ── 내부망 저장 요청 (Java internal-ledger가 실제 기록) ──────────────────────

  /**
   * 온체인 NFT Transfer 이벤트 수신 후 호출 — Java gateway가 user_nft_holdings 테이블에 기록
   */
  recordNftHolding(params: {
    userId: string;
    tokenId: bigint;
    contractAddr: string;
    chainId: number;
    amount: bigint;
    acquiredAt: Date;
    onChainTx: string;
  }): Promise<void>;

  /**
   * issuer-service 상태 변경시 호출 — Java gateway가 audit_log 테이블에 append-only 기록
   */
  recordAuditLog(entry: {
    actor: string;
    action: string;
    resourceType: string;
    resourceId: string;
    beforeState?: unknown;
    afterState: unknown;
  }): Promise<void>;
}
