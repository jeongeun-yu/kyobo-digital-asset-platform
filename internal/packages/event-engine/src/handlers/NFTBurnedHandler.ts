import type { ChainEvent } from '@kyobo/chain-adapters';
import type { IEventHandler } from '../interfaces/IEventHandler';
import { logger } from '../infra/logger';

// TODO: LedgerService.debitNFT() 연결 + Core Banking 알림
export class NFTBurnedHandler implements IEventHandler {
  readonly eventName = 'Revoked';
  readonly contractAddr: string;

  constructor(contractAddr: string) {
    this.contractAddr = contractAddr;
  }

  async handle(event: ChainEvent): Promise<void> {
    const { tokenId, from } = event.args as { tokenId: bigint; from: string };
    logger.info('[NFTBurnedHandler] stub — not yet implemented', {
      tokenId: tokenId.toString(), from, txHash: event.txHash,
    });
  }
}
