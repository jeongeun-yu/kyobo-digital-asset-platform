import type {
  ICoreBankingAdapter,
  UserAccount,
  RewardNotification,
  BalanceSyncRequest,
} from '../interfaces/ICoreBankingAdapter';

/**
 * StubCoreBankingAdapter — 테스트/로컬 환경용 인메모리 구현체
 *
 * internal/internal-ledger (Java) 없이 issuer-service 단독으로 테스트할 때 사용.
 * 유닛 테스트에서 InternalGatewayClient를 대체하는 용도.
 *
 * 사용:
 *   const adapter = new StubCoreBankingAdapter();
 *   adapter.seedUser({ userId: 'user-001', walletAddr: '0xabc...', status: 'active' });
 */
export class StubCoreBankingAdapter implements ICoreBankingAdapter {
  private users = new Map<string, UserAccount>();
  private auditLog: unknown[] = [];
  private holdings: unknown[] = [];
  private rewards: unknown[] = [];

  // ── 테스트 데이터 주입 ────────────────────────────────────────────────────────
  seedUser(user: UserAccount): void {
    this.users.set(user.userId, user);
  }

  // ── ICoreBankingAdapter 구현 ─────────────────────────────────────────────────

  async getUserAccount(userId: string): Promise<UserAccount | null> {
    return this.users.get(userId) ?? null;
  }

  async notifyReward(notification: RewardNotification): Promise<void> {
    this.rewards.push(notification);
    console.log('[Stub] notifyReward:', notification.userId, notification.tokenId);
  }

  async syncBalance(req: BalanceSyncRequest): Promise<{ confirmed: boolean }> {
    console.log('[Stub] syncBalance:', req.txHash);
    return { confirmed: true };
  }

  async recordTransaction(tx: {
    txHash: string; userId: string; type: string;
    amount: string; status: string; timestamp: number;
  }): Promise<void> {
    this.auditLog.push(tx);
  }

  async recordNftHolding(params: {
    userId: string; tokenId: bigint; contractAddr: string;
    chainId: number; acquiredAt: Date; onChainTx: string;
  }): Promise<void> {
    this.holdings.push(params);
    console.log('[Stub] recordNftHolding:', params.userId, params.tokenId.toString());
  }

  async recordAuditLog(entry: {
    actor: string; action: string; resourceType: string;
    resourceId: string; beforeState?: unknown; afterState: unknown;
  }): Promise<void> {
    this.auditLog.push(entry);
  }

  // ── 테스트 검증용 ─────────────────────────────────────────────────────────────
  getAuditLog(): unknown[] { return [...this.auditLog]; }
  getHoldings(): unknown[]  { return [...this.holdings]; }
  getRewards(): unknown[]   { return [...this.rewards]; }
}
