import type {
  ICoreBankingAdapter,
  UserAccount,
  RewardNotification,
  BalanceSyncRequest,
} from '../interfaces/ICoreBankingAdapter';

/**
 * StubCoreBankingAdapter ???뚯뒪?맞룸줈而?媛쒕컻???몃찓紐⑤━ 援ы쁽泥?
 *
 * internal/internal-ledger (Java) ?놁씠 issuer-service 濡쒖쭅???낅┰?곸쑝濡??ㅼ뒿?????ъ슜.
 * ?⑥쐞 ?뚯뒪?몄뿉??InternalGatewayClient瑜?援먯껜?섎뒗 ?⑸룄.
 *
 * ?ъ슜:
 *   const adapter = new StubCoreBankingAdapter();
 *   adapter.seedUser({ userId: 'user-001', walletAddr: '0xabc...', status: 'active' });
 */
export class StubCoreBankingAdapter implements ICoreBankingAdapter {
  private users = new Map<string, UserAccount>();
  private auditLog: unknown[] = [];
  private holdings: unknown[] = [];
  private rewards: unknown[] = [];

  // ?? ?뚯뒪???곗씠??二쇱엯 ?????????????????????????????????????????????????????????
  seedUser(user: UserAccount): void {
    this.users.set(user.userId, user);
  }

  // ?? ICoreBankingAdapter 援ы쁽 ??????????????????????????????????????????????????

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

  // ?? ?뚯뒪??寃利앹슜 ????????????????????????????????????????????????????????????
  getAuditLog(): unknown[] { return [...this.auditLog]; }
  getHoldings(): unknown[]  { return [...this.holdings]; }
  getRewards(): unknown[]   { return [...this.rewards]; }
}
