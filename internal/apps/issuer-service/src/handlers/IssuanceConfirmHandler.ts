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
    const txReq = await this.txRepo.findByTxHash(event.txHash);
    if (!txReq) return;
    if (txReq.status === 'CONFIRMED' || txReq.status === 'FINALIZED') return;

    // SUBMITTED → MINED → CONFIRMED 순차 전이
    // (실제 ChainEventListener는 MINED와 CONFIRMED를 별도 이벤트로 수신하지만,
    //  온체인 'Issued' 이벤트 수신 시점에는 이미 충분한 블록 확인이 된 것으로 간주)
    if (txReq.status === 'SUBMITTED' || txReq.status === 'PENDING') {
      await this.txStateMachine.handleMined(txReq.id, event.blockNumber);
    }
    if (txReq.status !== 'FAILED') {
      await this.txStateMachine.handleConfirmed(txReq.id);
    }
  }
}
