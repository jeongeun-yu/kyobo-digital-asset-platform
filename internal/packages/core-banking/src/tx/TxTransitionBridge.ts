/**
 * TxTransitionBridge (core-banking) — TxStatus 전이 → MintStatus 동기화
 *
 * TxStateMachineService의 'transition' 이벤트를 구독해
 * tx_mint_requests 상태 변화를 mint_requests(LedgerService)에만 반영한다.
 *
 * issuance_requests 동기화는 issuer-service의 IssuanceTransitionBridge가 담당한다.
 */

import type { TxTransitionEvent, TxStatus } from '../../../vasp/src/tx/TxStateMachineService';
import type { TxStateMachineService }        from '../../../vasp/src/tx/TxStateMachineService';
import type { LedgerService, MintStatus }    from '../ledger/LedgerService';

const TX_TO_MINT: Partial<Record<TxStatus, MintStatus>> = {
  SUBMITTED: 'SUBMITTED',
  MINED:     'MINED',
  CONFIRMED: 'CONFIRMED',
  FINALIZED: 'FINALIZED',
  FAILED:    'FAILED',
  REORGED:   'REORGED',
};

export class TxTransitionBridge {
  constructor(private readonly ledgerService: LedgerService) {}

  attach(txStateMachine: TxStateMachineService): void {
    txStateMachine.on('transition', (e: TxTransitionEvent) => {
      this._handle(e).catch(err =>
        console.error('[TxTransitionBridge] error:', err),
      );
    });
  }

  private async _handle(e: TxTransitionEvent): Promise<void> {
    const mintStatus = TX_TO_MINT[e.to];
    if (!mintStatus) return;

    const txHash = e.req.txHash;
    if (!txHash) return;

    const ledgerReq = await this.ledgerService.findByTxHash(txHash);
    if (!ledgerReq) return;

    const cur = ledgerReq.status;

    if (mintStatus === 'MINED' && (cur === 'MINED' || cur === 'CONFIRMED' || cur === 'FINALIZED')) {
      return; // 이미 MINED 이상 — 스킵
    }

    if (mintStatus === 'CONFIRMED' && cur === 'SUBMITTED') {
      // MINED 이벤트가 아직 미처리 — MINED → CONFIRMED 순차 처리
      try {
        await this.ledgerService.updateMintRequest(ledgerReq.id, { status: 'MINED', txHash });
      } catch (err: any) {
        if (err?.name !== 'InvalidStateTransitionError') throw err;
      }
      try {
        await this.ledgerService.updateMintRequest(ledgerReq.id, { status: 'CONFIRMED', txHash });
      } catch (err: any) {
        if (err?.name !== 'InvalidStateTransitionError') throw err;
      }
      return;
    }

    try {
      await this.ledgerService.updateMintRequest(ledgerReq.id, { status: mintStatus, txHash });
    } catch (err: any) {
      if (err?.name !== 'InvalidStateTransitionError') throw err;
    }
  }
}
