import type {
  ICoreBankingAdapter,
  UserAccount,
  RewardNotification,
  BalanceSyncRequest,
} from '../interfaces/ICoreBankingAdapter';
import { InternalGatewayClient } from './InternalGatewayClient';

/**
 * KyoboCoreBankingAdapter ??ICoreBankingAdapter 援ы쁽泥?
 *
 * 紐⑤뱺 ?몄텧? internal/internal-ledger (Java Spring Boot)瑜?寃쎌쑀?쒕떎.
 * issuer-service(?대?留???Core Banking ?덇굅???쒖뒪?쒖뿉 吏곸젒 ?묒냽?섏? ?딅뒗??
 *
 * ?몄텧 ?먮쫫:
 *   issuer-service(?대?留?
 *     ??KyoboCoreBankingAdapter
 *       ??InternalGatewayClient (HTTP)
 *         ??internal/internal-ledger (:8080)
 *           ??Core Banking WAS (?덇굅??
 */
export class KyoboCoreBankingAdapter implements ICoreBankingAdapter {
  constructor(private readonly gateway: InternalGatewayClient) {}

  // ?? ?ъ슜?먃룰퀎????????????????????????????????????????????????????????????????

  async getUserAccount(userId: string): Promise<UserAccount | null> {
    const resp = await this.gateway.getUserAccount(userId);
    if (!resp) return null;
    return {
      userId:     resp.userId,
      accountId:  resp.userId,         // 援먮낫DTS API ?ㅽ럺 ?뺤젙 ??蹂꾨룄 accountId ?꾨뱶濡?援먯껜
      walletAddr: resp.walletAddress ?? '',
      status:     resp.isActive ? 'active' : 'suspended',
    };
  }

  // ?? 由ъ썙???뚮┝ ???????????????????????????????????????????????????????????????

  async notifyReward(notification: RewardNotification): Promise<void> {
    await this.gateway.notifyReward({
      userId:     notification.userId,
      rewardType: notification.rewardType,
      tokenId:    notification.tokenId,
      txHash:     notification.txHash,
      issuedAt:   notification.issuedAt,
      ...(notification.metadata !== undefined && { metadata: notification.metadata }),
    });
  }

  // ?? Phase 2 stub ??????????????????????????????????????????????????????????????

  async syncBalance(req: BalanceSyncRequest): Promise<{ confirmed: boolean }> {
    // Phase 2: ?먰솕 ???ㅽ뀒?대툝肄붿씤 ?붿븸 ?숆린??
    // Java Gateway /api/internal/balance/sync ?붾뱶?ъ씤???ㅽ럺 ?뺤젙 ?꾧퉴吏
    // confirmed: false 諛섑솚 ???몄텧?먭? pending ?곹깭濡?泥섎━.
    console.warn(`[KyoboCoreBankingAdapter] syncBalance degraded (Phase 2 endpoint pending): txHash=${req.txHash}`);
    return { confirmed: false };
  }

  // ?? 媛먯궗쨌?먯옣 (Java ?곴뎄 ??? ?????????????????????????????????????????????????

  async recordTransaction(tx: {
    txHash:    string;
    userId:    string;
    type:      string;
    amount:    string;
    status:    string;
    timestamp: number;
  }): Promise<void> {
    await this.gateway.recordAuditLog({
      actor:        tx.userId,
      action:       tx.type,
      resourceType: 'TRANSACTION',
      resourceId:   tx.txHash,
      beforeState:  null,
      afterState:   JSON.stringify(tx),
    });
  }

  async recordNftHolding(params: {
    userId:       string;
    tokenId:      bigint;
    contractAddr: string;
    chainId:      number;
    acquiredAt:   Date;
    onChainTx:    string;
  }): Promise<void> {
    await this.gateway.recordNftHolding(params.userId, {
      tokenId:      Number(params.tokenId),  // bigint ??number (ERC-1155 tokenId 踰붿쐞 ?덉쟾)
      contractAddr: params.contractAddr,
      chainId:      params.chainId,
      acquiredAt:   params.acquiredAt.toISOString(),
      onChainTx:    params.onChainTx,
    });
  }

  async recordAuditLog(entry: {
    actor:        string;
    action:       string;
    resourceType: string;
    resourceId:   string;
    beforeState?: unknown;
    afterState:   unknown;
  }): Promise<void> {
    await this.gateway.recordAuditLog({
      actor:        entry.actor,
      action:       entry.action,
      resourceType: entry.resourceType,
      resourceId:   entry.resourceId,
      beforeState:  entry.beforeState !== undefined
                      ? JSON.stringify(entry.beforeState)
                      : null,
      afterState:   JSON.stringify(entry.afterState),
    });
  }
}
