import type { ReorgWatcher }          from '@kyobo/event-engine/listener';
import type { TxRepository }          from '../../../../packages/vasp/src/tx/TxStateMachineService';
import type { TxStateMachineService } from '../../../../packages/vasp/src/tx/TxStateMachineService';

/**
 * IssuanceReorgHandler — ChainEventListener.ReorgWatcher 구현체
 *
 * MINED·CONFIRMED 상태의 TX를 감시 목록으로 제공하고,
 * reorg 감지 시 TxStateMachineService.handleReorgDetected()를 위임한다.
 */
export class IssuanceReorgHandler implements ReorgWatcher {
  constructor(
    private readonly txRepo:         TxRepository,
    private readonly txStateMachine: TxStateMachineService,
  ) {}

  async getWatchedTxHashes(): Promise<Array<{ txHash: string; requestId: string }>> {
    const rows = await this.txRepo.findMinedOrConfirmed();
    return rows
      .filter(r => r.txHash)
      .map(r => ({ txHash: r.txHash!, requestId: r.id }));
  }

  async onReorg(requestId: string): Promise<void> {
    await this.txStateMachine.handleReorgDetected(requestId);
  }
}
