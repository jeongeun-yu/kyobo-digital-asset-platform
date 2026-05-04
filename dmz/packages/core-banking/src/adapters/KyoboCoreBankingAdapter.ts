import type {
  ICoreBankingAdapter,
  UserAccount,
  RewardNotification,
  BalanceSyncRequest,
} from '../interfaces/ICoreBankingAdapter';
import { InternalGatewayClient } from './InternalGatewayClient';

/**
 * KyoboCoreBankingAdapter — ICoreBankingAdapter 구현체
 *
 * 모든 호출은 internal/blockchain-gateway (Java Spring Boot)를 경유한다.
 * DMZ는 Core Banking 레거시 시스템에 직접 접속하지 않는다.
 *
 * 호출 흐름:
 *   DMZ issuer-service
 *     → KyoboCoreBankingAdapter
 *       → InternalGatewayClient (HTTP)
 *         → internal/blockchain-gateway (:8080)
 *           → Core Banking WAS (레거시)
 */
export class KyoboCoreBankingAdapter implements ICoreBankingAdapter {
  constructor(private readonly gateway: InternalGatewayClient) {}

  // ── 사용자·계정 ──────────────────────────────────────────────────────────────

  async getUserAccount(userId: string): Promise<UserAccount | null> {
    const resp = await this.gateway.getUserAccount(userId);
    if (!resp) return null;
    return {
      userId:     resp.userId,
      accountId:  resp.userId,         // TODO: 교보DTS API 스펙 확정 후 별도 accountId 필드로 교체
      walletAddr: resp.walletAddress ?? '',
      status:     resp.isActive ? 'active' : 'suspended',
    };
  }

  // ── 리워드 알림 ───────────────────────────────────────────────────────────────

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

  // ── Phase 2 stub ──────────────────────────────────────────────────────────────

  async syncBalance(req: BalanceSyncRequest): Promise<{ confirmed: boolean }> {
    // TODO Phase 2: 원화 ↔ 스테이블코인 잔액 동기화 — Java Gateway 엔드포인트 미정
    throw new Error(`KyoboCoreBankingAdapter.syncBalance not implemented (Phase 2): ${req.txHash}`);
  }

  // ── 감사·원장 (Java 영구 저장) ─────────────────────────────────────────────────

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
      tokenId:      Number(params.tokenId),  // bigint → number (ERC-1155 tokenId 범위 안전)
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
