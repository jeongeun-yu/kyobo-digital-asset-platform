import { type EventProcessor, type StreamMessage } from '../stream/ConsumerGroupWorker';
import { EventType } from '../EventTypes';
import { logger } from '../infra/logger';

// TODO: CouponConditionStrategy 연결 후 자격 확인 → TxStateMachineService.submitMintRequest()
export class CouponProcessor implements EventProcessor {
  readonly eventTypes = [
    EventType.COUPON_CLAIM,
    EventType.CAMPAIGN_REWARD,
  ];

  async process(message: StreamMessage): Promise<void> {
    const { eventType, userId } = message.fields;
    logger.info('[CouponProcessor] stub — not yet implemented', { eventType, userId, messageId: message.id });
  }
}
