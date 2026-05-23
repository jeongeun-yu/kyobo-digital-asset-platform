/**
 * TxTransitionBridge — TxStatus 전이 → MintStatus·IssuanceStatus 동기화
 *
 * TxStateMachineService의 'transition' 이벤트를 구독해
 * tx_mint_requests 상태 변화를 mint_requests(LedgerService)와
 * issuance_requests(IssuanceRequestRepository)에 반영한다.
 *
 * 상태 매핑:
 *   TxStatus          → MintStatus
 *   SUBMITTED         → SUBMITTED
 *   MINED             → MINED
 *   CONFIRMED         → CONFIRMED  + issuance_requests CONFIRMED
 *   FINALIZED         → FINALIZED
 *   FAILED            → FAILED     + issuance_requests FAILED (txHash 있을 때)
 *   REORGED           → REORGED
 *   PENDING           → (skip — MintStatus에 PENDING 없음)
 */

import type { TxTransitionEvent, TxStatus } from '../../../../packages/vasp/src/tx/TxStateMachineService';
import type { TxStateMachineService }        from '../../../../packages/vasp/src/tx/TxStateMachineService';
import type { LedgerService, MintStatus }    from '../../../../packages/core-banking/src/ledger/LedgerService';
import type { IIssuanceRequestRepository }   from './IssuanceRequestRepository';

const TX_TO_MINT: Partial<Record<TxStatus, MintStatus>> = {
  SUBMITTED: 'SUBMITTED',
  MINED:     'MINED',
  CONFIRMED: 'CONFIRMED',
  FINALIZED: 'FINALIZED',
  FAILED:    'FAILED',
  REORGED:   'REORGED',
};

export class TxTransitionBridge {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly issuanceRepo:  IIssuanceRequestRepository,
  ) {}

  attach(txStateMachine: TxStateMachineService): void {
    txStateMachine.on('transition', (e: TxTransitionEvent) => {
      this._handle(e).catch(err =>
        console.error('[TxTransitionBridge] transition handler error:', err),
      );
    });
  }

  private async _handle(e: TxTransitionEvent): Promise<void> {
    const mintStatus = TX_TO_MINT[e.to];
    if (!mintStatus) return; // PENDING 등 매핑 없는 상태 skip

    const txHash = e.req.txHash;

    // ── mint_requests 업데이트 ────────────────────────────────────────────
    // IssuanceConfirmHandler가 handleMined→handleConfirmed를 연속 호출할 때
    // bridge 이벤트가 비동기로 처리되어 MINED 핸들러보다 CONFIRMED 핸들러가 먼저
    // findByTxHash를 실행하는 경우를 대비해 중간 상태 전이를 삽입한다.
    if (txHash) {
      const ledgerReq = await this.ledgerService.findByTxHash(txHash);
      if (ledgerReq) {
        const cur = ledgerReq.status;
        if (mintStatus === 'MINED' && (cur === 'MINED' || cur === 'CONFIRMED' || cur === 'FINALIZED')) {
          // CONFIRMED 핸들러가 먼저 MINED까지 처리했으므로 스킵
        } else if (mintStatus === 'CONFIRMED' && cur === 'SUBMITTED') {
          // MINED 이벤트 핸들러가 아직 실행 전 — SUBMITTED → MINED → CONFIRMED 순차 처리
          await this.ledgerService.updateMintRequest(ledgerReq.id, { status: 'MINED', txHash });
          await this.ledgerService.updateMintRequest(ledgerReq.id, { status: 'CONFIRMED', txHash });
        } else {
          await this.ledgerService.updateMintRequest(ledgerReq.id, { status: mintStatus, txHash });
        }
      }
    }

    // ── issuance_requests 업데이트 ────────────────────────────────────────
    // CONFIRMED: SUBMITTED → CONFIRMED 전이
    // FAILED:    txHash가 있을 때만 (VASP 실패는 IssuerService가 직접 처리)
    if (txHash && (e.to === 'CONFIRMED' || e.to === 'FAILED')) {
      const issuanceReq = await this.issuanceRepo.findByTxHash(txHash);
      if (issuanceReq && issuanceReq.status === 'SUBMITTED') {
        if (e.to === 'CONFIRMED') {
          await this.issuanceRepo.updateStatus(issuanceReq.id, 'CONFIRMED', { txHash });
        } else {
          await this.issuanceRepo.updateStatus(issuanceReq.id, 'FAILED', {
            failReason: e.req.failReason ?? 'on-chain FAILED',
          });
        }
      }
    }
  }
}
