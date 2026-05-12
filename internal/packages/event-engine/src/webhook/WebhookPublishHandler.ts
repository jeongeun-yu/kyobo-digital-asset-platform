/**
 * WebhookPublishHandler — WebhookServer → RedisStreamPublisher 연결
 *
 * M2 S6 구현 핵심 (2):
 *   WebhookServer에 등록되는 핸들러 팩토리.
 *   서명 검증 통과 후 비동기 실행되는 handler() 의 실제 구현체.
 *
 * 역할:
 *   1. IdempotencyGuard로 requestId 중복 차단
 *   2. 중복 아닌 경우 RedisStreamPublisher.publish() 호출
 *   3. 중복 이벤트는 로그만 남기고 무시 (202는 이미 응답됨)
 *
 * 사용:
 *   const handler = new WebhookPublishHandler(publisher, idempotency);
 *   server.on('NFT_ISSUED',         handler.createHandler());
 *   server.on('ACTIVITY_ACHIEVED',  handler.createHandler());
 */

import { type WebhookHandler, type WebhookPayload } from './WebhookServer';
import { RedisStreamPublisher } from '../dmz/RedisStreamPublisher';
import { IdempotencyGuard } from './IdempotencyGuard';
import { logger } from '../infra/logger';

export class WebhookPublishHandler {
  constructor(
    private readonly publisher:    RedisStreamPublisher,
    private readonly idempotency:  IdempotencyGuard,
    private readonly streamKey   = 'kyobo:events',
  ) {}

  /**
   * WebhookServer.on() 에 전달할 핸들러 함수 생성.
   * 이벤트 타입 별로 동일한 핸들러를 재사용할 수 있다.
   */
  createHandler(): WebhookHandler {
    return async (payload: WebhookPayload): Promise<void> => {
      const idempotencyKey = `webhook:${payload.requestId}`;

      const published = await this.idempotency.run(idempotencyKey, async () => {
        await this.publisher.publish({
          streamKey:   this.streamKey,
          eventType:   payload.eventType,
          payload:     payload.data,
          txHash:      String(payload.data['txHash']      ?? ''),
          blockNumber: Number(payload.data['blockNumber'] ?? 0),
          requestId:   payload.requestId,
        });
      });

      if (!published) {
        logger.info('duplicate webhook skipped', { requestId: payload.requestId });
      }
    };
  }
}
