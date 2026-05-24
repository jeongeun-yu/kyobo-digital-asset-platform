import type { ChainEvent }                   from '@kyobo/chain-adapters';
import type { IEventHandler }                from '@kyobo/event-engine/interfaces';
import type { TxRepository }                 from '../../../../packages/vasp/src/tx/TxStateMachineService';
import { TxStateMachineService }             from '../../../../packages/vasp/src/tx/TxStateMachineService';

/**
 * IssuanceConfirmHandler — 온체인 Issued 이벤트 → TxStateMachineService 경유 전이
 *
 * 온체인 'Issued' 이벤트 수신 시:
 *   1. txHash로 tx_mint_requests 조회 → requestId 획득
 *   2. TxStateMachineService.handleMined()    → tx_mint_requests MINED
 *   3. TxStateMachineService.handleConfirmed() → tx_mint_requests CONFIRMED
 *   4. TxTransitionBridge가 'transition' 이벤트 수신
 *      → mint_requests MINED → CONFIRMED
 *      → issuance_requests CONFIRMED
 *
 * 이전 구현(issuance_requests 직접 업데이트) 대비:
 *   - 세 상태(TxStatus·MintStatus·IssuanceStatus)가 단일 이벤트 흐름으로 동기화됨
 *   - issuance_requests는 TxTransitionBridge가 담당 (이 핸들러에서 직접 접근 안 함)
 */
export class IssuanceConfirmHandler implements IEventHandler {
  readonly eventName    = 'Issued';
  readonly contractAddr: string;

  constructor(
    contractAddr:                     string,
    private readonly txRepo:          TxRepository,
    private readonly txStateMachine:  TxStateMachineService,
  ) {
    this.contractAddr = contractAddr;
  }

  async handle(event: ChainEvent): Promise<void> {
    console.log(`[IssuanceConfirmHandler] Issued 이벤트 수신  txHash=${event.txHash?.slice(0, 10) ?? '(none)'}…  block=${event.blockNumber}`);

    const txReq = await this.txRepo.findByTxHash(event.txHash);
    if (!txReq) {
      console.log(`[IssuanceConfirmHandler] tx_mint_requests 미조회 — 스킵 (txHash=${event.txHash.slice(0, 10)}…)`);
      return;
    }
    console.log(`[IssuanceConfirmHandler] tx_mint_requests 조회  id=${txReq.id.slice(0, 8)}…  status=${txReq.status}`);

    if (txReq.status === 'CONFIRMED' || txReq.status === 'FINALIZED') {
      console.log(`[IssuanceConfirmHandler] 이미 ${txReq.status} — 스킵`);
      return;
    }

    if (txReq.status === 'SUBMITTED' || txReq.status === 'PENDING') {
      console.log(`[IssuanceConfirmHandler] handleMined() 호출 → tx_mint_requests SUBMITTED → MINED`);
      await this.txStateMachine.handleMined(txReq.id, event.blockNumber);
    }
    if (txReq.status !== 'FAILED') {
      console.log(`[IssuanceConfirmHandler] handleConfirmed() 호출 → tx_mint_requests MINED → CONFIRMED`);
      await this.txStateMachine.handleConfirmed(txReq.id);
    }
  }
}
