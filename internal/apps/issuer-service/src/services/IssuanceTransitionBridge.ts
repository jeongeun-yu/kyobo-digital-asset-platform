/**
 * IssuanceTransitionBridge — TxStatus 전이 → IssuanceStatus 동기화
 *
 * TxStateMachineService의 'transition' 이벤트를 구독해
 * issuance_requests 상태를 동기화하고 audit_log를 기록한다.
 *
 * mint_requests 동기화는 core-banking의 TxTransitionBridge가 담당한다.
 *
 * CONFIRMED 처리 규칙:
 *   - issuance_requests → CONFIRMED + audit_log CONFIRMED 기록 (source 무관)
 *   - recordNftHolding: source='POLL_STALE' 시에만 직접 호출
 *     (정상 경로는 ChainEventListener → NFTIssuedProcessor가 담당)
 */

import type { TxTransitionEvent }          from '../../../../packages/vasp/src/tx/TxStateMachineService';
import type { TxStateMachineService }      from '../../../../packages/vasp/src/tx/TxStateMachineService';
import type { IIssuanceRequestRepository } from './IssuanceRequestRepository';
import type { ICoreBankingAdapter }        from '@kyobo/core-banking';

export class IssuanceTransitionBridge {
  constructor(
    private readonly issuanceRepo:  IIssuanceRequestRepository,
    private readonly coreBanking:   ICoreBankingAdapter,
    private readonly contractAddr:  string,
    private readonly chainId:       number,
  ) {}

  attach(txStateMachine: TxStateMachineService): void {
    txStateMachine.on('transition', (e: TxTransitionEvent) => {
      this._handle(e).catch(err =>
        console.error('[IssuanceTransitionBridge] error:', err),
      );
    });
  }

  private async _handle(e: TxTransitionEvent): Promise<void> {
    if (e.to !== 'CONFIRMED' && e.to !== 'FAILED' && e.to !== 'REORGED') return;

    const txHash = e.req.txHash;
    if (!txHash) return;

    const issuanceReq = await this.issuanceRepo.findByTxHash(txHash);
    if (!issuanceReq) return;

    if (e.to === 'REORGED') {
      // issuance_requests 스키마는 REORGED 미지원 — audit_log에만 기록
      console.log(`[IssuanceTransitionBridge] REORGED 감지 → audit_log 기록  txHash=${txHash.slice(0, 10)}…`);
      this.coreBanking.recordAuditLog({
        actor:        issuanceReq.userId,
        action:       'REORGED',
        resourceType: 'issuance_request',
        resourceId:   issuanceReq.id,
        afterState:   { status: 'REORGED', txHash },
      }).catch(err => console.error('[IssuanceTransitionBridge] audit-log 오류:', err));
      return;
    }

    if (issuanceReq.status !== 'SUBMITTED') return;

    if (e.to === 'CONFIRMED') {
      await this.issuanceRepo.updateStatus(issuanceReq.id, 'CONFIRMED', { txHash });
      this.coreBanking.recordAuditLog({
        actor:        issuanceReq.userId,
        action:       'CONFIRMED',
        resourceType: 'issuance_request',
        resourceId:   txHash,
        afterState:   { status: 'CONFIRMED', txHash },
      }).catch(err => console.error('[IssuanceTransitionBridge] audit-log 오류:', err));

      // POLL_STALE 경로: 온체인 이벤트가 없어 NFTIssuedProcessor가 실행되지 않으므로 직접 기록
      // 정상 경로(CHAIN_EVENT)는 ChainEventListener → NFTIssuedProcessor가 담당
      if (e.source === 'POLL_STALE') {
        this.coreBanking.recordNftHolding({
          userId:       issuanceReq.userId,
          tokenId:      e.req.tokenId,
          contractAddr: this.contractAddr,
          chainId:      this.chainId,
          amount:       e.req.amount,
          acquiredAt:   new Date(),
          onChainTx:    txHash,
        }).catch(err => console.error('[IssuanceTransitionBridge] recordNftHolding 오류:', err));
      }
    } else {
      const failReason = e.req.failReason ?? 'on-chain FAILED';
      await this.issuanceRepo.updateStatus(issuanceReq.id, 'FAILED', { failReason });
      this.coreBanking.recordAuditLog({
        actor:        issuanceReq.userId,
        action:       'FAILED',
        resourceType: 'issuance_request',
        resourceId:   txHash,
        afterState:   { status: 'FAILED', failReason },
      }).catch(err => console.error('[IssuanceTransitionBridge] audit-log 오류:', err));
    }
  }
}
