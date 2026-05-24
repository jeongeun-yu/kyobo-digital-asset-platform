/**
 * ActivityProcessor — 활동 달성 이벤트 소비자 처리기
 *
 * 내부 인바운드 Webhook(ACTIVITY_ACHIEVED 등)이 Redis Stream을 거친 후
 * 이 프로세서가 소비하여 IActivityIssuer.issueActivityNFT()를 호출한다.
 *
 * 흐름:
 *   WebhookServer → WebhookPublishHandler → XADD kyobo:events
 *   → ConsumerGroupWorker (activity-consumers) → ActivityProcessor.process()
 *   → IActivityIssuer.issueActivityNFT()
 *
 * 멱등성:
 *   1차: WebhookPublishHandler — requestId 중복 스트림 적재 차단
 *   2차: IssuerService.findPending() — 진행 중 요청 재사용
 *   (XACK는 ConsumerGroupWorker가 처리)
 */

import { type EventProcessor, type StreamMessage } from '../stream/ConsumerGroupWorker';
import { EventType } from '../EventTypes';
import { IdempotencyGuard } from '../webhook/IdempotencyGuard';
import { logger } from '../infra/logger';

// ── IActivityIssuer ──────────────────────────────────────────────────────────
// IssuerService가 이 인터페이스를 구현한다.
// event-engine 패키지가 issuer-service 앱에 의존하지 않도록 인터페이스로 분리.

export interface IActivityIssuer {
  issueActivityNFT(params: {
    userId:     string;
    activityId: string;
    event: {
      userId:     string;
      eventType:  string;
      eventCode:  number;
      data:       Record<string, unknown>;
      occurredAt: Date;
    };
  }): Promise<unknown>;
}

// ── ActivityProcessor ────────────────────────────────────────────────────────

export class ActivityProcessor implements EventProcessor {
  readonly eventTypes = [
    EventType.ACTIVITY_ACHIEVED,
    EventType.WALK_GOAL_MET,
    EventType.HEALTH_CHECK_DONE,
    EventType.COUPON_CLAIM,
    EventType.CAMPAIGN_REWARD,
  ];

  constructor(
    private readonly issuer:      IActivityIssuer,
    private readonly idempotency: IdempotencyGuard,
  ) {}

  async process(message: StreamMessage): Promise<void> {
    const data = JSON.parse(message.fields['payload'] ?? '{}') as {
      userId:     string;
      activityId: string;
      eventType:  string;
      eventCode?: number;
      data?:      Record<string, unknown>;
    };

    const requestId = message.fields['requestId'] ?? message.id;

    if (!data.userId || !data.activityId) {
      logger.warn('[ActivityProcessor] 필수 필드 누락 — 스킵', { requestId, fields: message.fields });
      return;
    }

    const idempotencyKey = `activity:${requestId}`;

    console.log(`[ActivityProcessor] 처리 시작  userId=${data.userId}  eventType=${data.eventType}  msgId=${message.id}`);

    const processed = await this.idempotency.run(idempotencyKey, async () => {
      console.log(`[ActivityProcessor] issueActivityNFT 호출 → userId=${data.userId}  activityId=${data.activityId}`);
      await this.issuer.issueActivityNFT({
        userId:     data.userId,
        activityId: data.activityId,
        event: {
          userId:     data.userId,
          eventType:  data.eventType,
          eventCode:  data.eventCode ?? 0,
          data:       data.data ?? {},
          occurredAt: new Date(Number(message.fields['publishedAt'] ?? Date.now())),
        },
      });
      console.log(`[ActivityProcessor] issueActivityNFT 완료 → issuance_requests SUBMITTED 예정`);
    });

    if (!processed) {
      logger.info('[ActivityProcessor] 중복 이벤트 스킵', { idempotencyKey });
    }
  }
}
