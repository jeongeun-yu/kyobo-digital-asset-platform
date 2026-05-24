import type { ChainEvent } from '@kyobo/chain-adapters';
import type { IEventHandler } from '../interfaces/IEventHandler';
import { IdempotencyGuard } from '../webhook/IdempotencyGuard';
import { RetryHandler } from '../webhook/RetryHandler';
import { EventType } from '../EventTypes';
import { logger } from '../infra/logger';

/**
 * NFTIssuedHandler — KyoboNFT.Issued 이벤트 처리기
 *
 * 이벤트 수신 → 멱등성 확인 → core banking 알림 발송
 *
 * Phase 2+:
 *   - StablecoinMintedHandler, STOTransferHandler 등 동일 패턴으로 추가
 *   - 이 핸들러는 변경 없음
 *
 */
export class NFTIssuedHandler implements IEventHandler {
  readonly eventName   = 'Issued';
  readonly contractAddr: string;

  constructor(
    contractAddr: string,
    private readonly idempotency: IdempotencyGuard,
    private readonly retry:       RetryHandler,
    private readonly config: {
      coreBankingWebhookUrl: string;
      webhookSecret:          string;
    },
  ) {
    this.contractAddr = contractAddr;
  }

  async handle(event: ChainEvent): Promise<void> {
    const idempotencyKey = `nft-issued:${event.txHash}:${event.logIndex}`;

    const processed = await this.idempotency.run(idempotencyKey, async () => {
      const { to, tokenId, reason } = event.args as {
        to: string; tokenId: bigint; reason: string;
      };

      await this.retry.send({
        requestId: idempotencyKey,
        targetUrl: this.config.coreBankingWebhookUrl,
        payload: {
          eventType:   EventType.NFT_ISSUED,
          to,
          tokenId:     tokenId.toString(),
          reason,
          txHash:      event.txHash,
          blockNumber: event.blockNumber,
          issuedAt:    Date.now(),
        },
        secret: this.config.webhookSecret,
      });
    });

    if (!processed) {
      logger.info('duplicate event skipped', { idempotencyKey });
    }
  }
}
