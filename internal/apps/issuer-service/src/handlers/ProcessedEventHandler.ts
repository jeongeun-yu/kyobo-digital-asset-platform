import type { IEventHandler }             from '@kyobo/event-engine/interfaces';
import type { ChainEvent }                from '@kyobo/chain-adapters';
import type { LedgerService }             from '../../../../packages/core-banking/src/ledger/LedgerService';

export class ProcessedEventHandler implements IEventHandler {
  readonly eventName    = 'Issued';
  readonly contractAddr: string;

  constructor(
    contractAddr:                  string,
    private readonly ledgerService: LedgerService,
  ) {
    this.contractAddr = contractAddr;
  }

  async handle(event: ChainEvent): Promise<void> {
    const safePayload = JSON.parse(
      JSON.stringify(event.args, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
    await this.ledgerService.recordProcessedEvent(
      event.txHash, event.logIndex, event.eventName, BigInt(event.blockNumber), safePayload,
    ).catch(e => console.error('[ProcessedEventHandler] error:', (e as Error).message));
  }
}
