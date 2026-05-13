import type { WebhookServer, WebhookPayload } from '@kyobo/event-engine/webhook';
import type { IdempotencyGuard }               from '@kyobo/event-engine/webhook';
import type { IssuerService }                  from '../services/IssuerService';

/**
 * ActivityRouter — 교보 앱 서버 → 활동 달성 이벤트 수신 라우터
 *
 * WebhookServer에 이벤트 타입별 핸들러를 등록한다.
 * Phase 2/3에서 새 이벤트 타입이 추가되면 이 클래스에 핸들러만 추가.
 */
export class ActivityRouter {
  constructor(
    private readonly issuer:      IssuerService,
    private readonly idempotency: IdempotencyGuard,
  ) {}

  register(server: WebhookServer): void {
    server.on('ACTIVITY_ACHIEVED', this._handleActivityAchieved.bind(this));
    server.on('COUPON_ISSUED',     this._handleCouponIssued.bind(this));
    // Phase 2+: 'KRW_DEPOSITED', 'STO_SUBSCRIBED' 추가
  }

  private async _handleActivityAchieved(payload: WebhookPayload): Promise<void> {
    const { userId, activityId, oracleData } = payload.data as {
      userId:     string;
      activityId: string;
      oracleData: { dataType: string; value: number; timestamp: number; signature: string };
    };

    await this.idempotency.run(`activity:${payload.requestId}`, async () => {
      await this.issuer.issueActivityNFT({ userId, activityId, oracleData });
    });
  }

  private async _handleCouponIssued(payload: WebhookPayload): Promise<void> {
    const { userId, couponId, oracleData } = payload.data as {
      userId:     string;
      couponId:   string;
      oracleData: { dataType: string; value: number; timestamp: number; signature: string };
    };

    await this.idempotency.run(`coupon:${payload.requestId}`, async () => {
      await this.issuer.issueActivityNFT({ userId, activityId: couponId, oracleData });
    });
  }
}
