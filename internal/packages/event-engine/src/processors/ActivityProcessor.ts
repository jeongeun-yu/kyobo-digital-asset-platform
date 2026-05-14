import { type EventProcessor, type StreamMessage } from '../stream/ConsumerGroupWorker';
import { EventType } from '../EventTypes';
import { logger } from '../infra/logger';

// TODO: EventConditionService 연결 후 조건 판단 → TxStateMachineService.submitMintRequest()
export class ActivityProcessor implements EventProcessor {
  readonly eventTypes = [
    EventType.WALK_GOAL_MET,
    EventType.HEALTH_CHECK_DONE,
    EventType.ACTIVITY_ACHIEVED,
  ];

  async process(message: StreamMessage): Promise<void> {
    const { eventType, userId } = message.fields;
    logger.info('[ActivityProcessor] stub — not yet implemented', { eventType, userId, messageId: message.id });
  }
}
