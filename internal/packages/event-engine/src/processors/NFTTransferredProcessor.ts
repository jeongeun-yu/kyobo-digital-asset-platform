import { type EventProcessor, type StreamMessage } from '../stream/ConsumerGroupWorker';
import { EventType } from '../EventTypes';
import { logger } from '../infra/logger';

// TODO: LedgerService.transferNFT() 연결
export class NFTTransferredProcessor implements EventProcessor {
  readonly eventTypes = [EventType.NFT_TRANSFERRED];

  async process(message: StreamMessage): Promise<void> {
    const { tokenId, from, to } = message.fields;
    logger.info('[NFTTransferredProcessor] stub — not yet implemented', { tokenId, from, to, messageId: message.id });
  }
}
