import { type EventProcessor, type StreamMessage } from '../stream/ConsumerGroupWorker';
import { EventType } from '../EventTypes';
import { logger } from '../infra/logger';

// TODO: LedgerService.debitNFT() 연결
export class NFTBurnedProcessor implements EventProcessor {
  readonly eventTypes = [EventType.NFT_BURNED];

  async process(message: StreamMessage): Promise<void> {
    const { tokenId, from } = message.fields;
    logger.info('[NFTBurnedProcessor] stub — not yet implemented', { tokenId, from, messageId: message.id });
  }
}
