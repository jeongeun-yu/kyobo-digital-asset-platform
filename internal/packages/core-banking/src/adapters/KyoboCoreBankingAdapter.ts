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
 * 모든 호출을 internal/internal-ledger (Java Spring Boot)로 위임합니다.
 * issuer-service(내부망)와 Core Banking 원장 시스템에 직접 접속하지 않습니다.
 *
 * 호출 경로:
 *   issuer-service(내부망)
 *     → KyoboCoreBankingAdapter
 *       → InternalGatewayClient (HTTP)
 *         → internal/internal-ledger (:8080)
 *           → Core Banking WAS (원장)
 */
export class KyoboCoreBankingAdapter implements ICoreBankingAdapter {
  constructor(private readonly gateway: InternalGatewayClient) {}

  // ── 사용자 계정 ──────────────────────────────────────────────────────────────

  async getUserAccount(userId: string): Promise<UserAccount | null> {
    const resp = await this.gateway.getUserAccount(userId);
    if (!resp) return null;
    return {
      userId:     resp.userId,
      accountId:  resp.userId,         // 원장 DTS API 스펙 확정 후 별도 accountId 필드로 교체
      walletAddr: resp.walletAddress ?? '',
      status:     resp.isActive ? 'active' : 'suspended',
    };
  }

  // ── 리워드 알림 ──────────────────────────────────────────────────────────────

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

  // ── Phase 2 stub ─────────────────────────────────────────────────────────────

  async syncBalance(req: BalanceSyncRequest): Promise<{ confirmed: boolean }> {
    // Phase 2: 실시간 온체인 스테이블코인 발행 붙을 때 구현 예정
    // Java Gateway /api/internal/balance/sync 엔드포인트 스펙 확정 대기중
    // confirmed: false 반환 → 호출자는 pending 상태로 처리
    console.warn(`[KyoboCoreBankingAdapter] syncBalance degraded (Phase 2 endpoint pending): txHash=${req.txHash}`);
    return { confirmed: false };
  }

  // ── 감사/기록 (Java 저장) ────────────────────────────────────────────────────

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
    amount:       bigint;
    acquiredAt:   Date;
    onChainTx:    string;
  }): Promise<void> {
    await this.gateway.recordNftHolding(params.userId, {
      tokenId:      Number(params.tokenId),
      contractAddr: params.contractAddr,
      chainId:      params.chainId,
      amount:       Number(params.amount),
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
