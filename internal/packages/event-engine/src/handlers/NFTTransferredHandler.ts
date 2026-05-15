import type { ChainEvent } from '@kyobo/chain-adapters';
import type { IEventHandler } from '../interfaces/IEventHandler';
import { logger } from '../infra/logger';

// TODO: LedgerService.transferNFT() 연결 + Core Banking 알림
export class NFTTransferredHandler implements IEventHandler {
  readonly eventName = 'Transfer';
  readonly contractAddr: string;

  constructor(contractAddr: string) {
    this.contractAddr = contractAddr;
  }

  async handle(event: ChainEvent): Promise<void> {
    const { from, to, tokenId } = event.args as { from: string; to: string; tokenId: bigint };
    logger.info('[NFTTransferredHandler] stub — not yet implemented', {
      tokenId: tokenId.toString(), from, to, txHash: event.txHash,
    });
  }
}
