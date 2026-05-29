/**
 * IssuanceTransitionBridge — TxStatus 전이 → IssuanceStatus 동기화
 *
 * TxStateMachineService의 'transition' 이벤트를 구독해
 * issuance_requests 상태를 동기화하고 audit_log를 기록한다.
 *
 * mint_requests 동기화는 core-banking의 TxTransitionBridge가 담당한다.
 *
 * ISSUANCE_CONFIRMED audit 기록 규칙:
 *   - CONFIRMED 전이 시 항상 기록 (source 무관)
 *   - NFT_ACQUIRED는 이후 NFTIssuedProcessor.creditNFT()에서 별도 기록
 */

import type { TxTransitionEvent }          from '../../../../packages/vasp/src/tx/TxStateMachineService';
import type { TxStateMachineService }      from '../../../../packages/vasp/src/tx/TxStateMachineService';
import type { IIssuanceRequestRepository } from './IssuanceRequestRepository';
import type { ICoreBankingAdapter }        from '@kyobo/core-banking';

export class IssuanceTransitionBridge {
  constructor(
    private readonly issuanceRepo: IIssuanceRequestRepository,
    private readonly coreBanking:  ICoreBankingAdapter,
  ) {}

  attach(txStateMachine: TxStateMachineService): void {
    txStateMachine.on('transition', (e: TxTransitionEvent) => {
      this._handle(e).catch(err =>
        console.error('[IssuanceTransitionBridge] error:', err),
      );
    });
  }

  private async _handle(e: TxTransitionEvent): Promise<void> {
    if (e.to !== 'CONFIRMED' && e.to !== 'FAILED') return;

    const txHash = e.req.txHash;
    if (!txHash) return;

    const issuanceReq = await this.issuanceRepo.findByTxHash(txHash);
    if (!issuanceReq || issuanceReq.status !== 'SUBMITTED') return;

    if (e.to === 'CONFIRMED') {
      await this.issuanceRepo.updateStatus(issuanceReq.id, 'CONFIRMED', { txHash });
      this.coreBanking.recordAuditLog({
        actor:        issuanceReq.userId,
        action:       'CONFIRMED',
        resourceType: 'issuance_request',
        resourceId:   txHash,
        afterState:   { status: 'CONFIRMED', txHash },
      }).catch(err => console.error('[IssuanceTransitionBridge] audit-log 오류:', err));
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
