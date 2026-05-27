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
import type { IInternalLedgerClient }        from '../interfaces/IInternalLedgerClient';

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
    private readonly ledgerService:          LedgerService,
    private readonly issuanceRepo:           IIssuanceRequestRepository,
    private readonly internalLedgerClient?:  IInternalLedgerClient,
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
    if (!mintStatus) return;

    const txHash = e.req.txHash;
    console.log(`[TxTransitionBridge] 전이 이벤트  ${e.from} → ${e.to}  txHash=${txHash?.slice(0, 10) ?? 'none'}…`);

    // ── mint_requests 업데이트 ────────────────────────────────────────────
    // IssuanceConfirmHandler가 handleMined→handleConfirmed를 연속 호출하면
    // MINED·CONFIRMED 두 이벤트가 거의 동시에 발화된다.
    // 두 _handle() Promise가 concurrent 실행될 때 stale read→중복 전이가 발생하므로
    // InvalidStateTransitionError를 catch해 멱등 처리한다.
    if (txHash) {
      const ledgerReq = await this.ledgerService.findByTxHash(txHash);
      if (ledgerReq) {
        const cur = ledgerReq.status;
        if (mintStatus === 'MINED' && (cur === 'MINED' || cur === 'CONFIRMED' || cur === 'FINALIZED')) {
          // 이미 MINED 이상 — 스킵
        } else if (mintStatus === 'CONFIRMED' && cur === 'SUBMITTED') {
          // MINED 이벤트 핸들러가 아직 실행 전 — SUBMITTED → MINED → CONFIRMED 순차 처리
          // 단, concurrent MINED 핸들러가 먼저 MINED를 설정했을 수 있으므로 catch 처리
          try {
            await this.ledgerService.updateMintRequest(ledgerReq.id, { status: 'MINED', txHash });
          } catch (err: any) {
            if (err?.name !== 'InvalidStateTransitionError') throw err;
            // concurrent MINED 핸들러가 이미 MINED 설정 — CONFIRMED 단계로 진행
          }
          try {
            await this.ledgerService.updateMintRequest(ledgerReq.id, { status: 'CONFIRMED', txHash });
          } catch (err: any) {
            if (err?.name !== 'InvalidStateTransitionError') throw err;
            // concurrent 핸들러가 이미 CONFIRMED 설정 — issuance 업데이트로 진행
          }
        } else {
          try {
            await this.ledgerService.updateMintRequest(ledgerReq.id, { status: mintStatus, txHash });
          } catch (err: any) {
            if (err?.name !== 'InvalidStateTransitionError') throw err;
            // concurrent 핸들러가 이미 해당 상태 설정 — 스킵
          }
        }
      }
    }

    // ── issuance_requests 업데이트 ────────────────────────────────────────
    if (txHash && (e.to === 'CONFIRMED' || e.to === 'FAILED')) {
      const issuanceReq = await this.issuanceRepo.findByTxHash(txHash);
      if (issuanceReq && issuanceReq.status === 'SUBMITTED') {
        if (e.to === 'CONFIRMED') {
          console.log(`[TxTransitionBridge] issuance_requests SUBMITTED → CONFIRMED  id=${issuanceReq.id.slice(0, 8)}…`);
          await this.issuanceRepo.updateStatus(issuanceReq.id, 'CONFIRMED', { txHash });
          console.log(`[TxTransitionBridge] ✓ issuance_requests CONFIRMED 저장 완료`);
          this.internalLedgerClient?.recordAuditLog({
            actor:        issuanceReq.userId,
            action:       'ISSUANCE_CONFIRMED',
            resourceType: 'issuance_request',
            resourceId:   txHash,
            beforeState:  null,
            afterState:   { status: 'CONFIRMED', txHash },
          }).catch(err => console.error('[TxTransitionBridge] audit-log 오류:', err));
        } else {
          console.log(`[TxTransitionBridge] issuance_requests SUBMITTED → FAILED  id=${issuanceReq.id.slice(0, 8)}…`);
          const failReason = e.req.failReason ?? 'on-chain FAILED';
          await this.issuanceRepo.updateStatus(issuanceReq.id, 'FAILED', { failReason });
          this.internalLedgerClient?.recordAuditLog({
            actor:        issuanceReq.userId,
            action:       'ISSUANCE_FAILED',
            resourceType: 'issuance_request',
            resourceId:   txHash,
            beforeState:  null,
            afterState:   { status: 'FAILED', failReason },
          }).catch(err => console.error('[TxTransitionBridge] audit-log 오류:', err));
        }
      }
    }
  }
}
