import type { WebhookServer, WebhookPayload } from '@kyobo/event-engine/webhook';
import type { IdempotencyGuard }               from '@kyobo/event-engine/webhook';
import type { IssuerService }                  from '../services/IssuerService';
import type { ActivityEvent }                  from '../services/EventConditionService';

/**
 * ActivityRouter — 교보 앱 서버 → 활동 달성 이벤트 수신 라우터
 *
 * WebhookServer에 이벤트 타입별 핸들러를 등록한다.
 * Phase 2/3에서 새 이벤트 타입이 추가되면 이 클래스에 핸들러만 추가.
 *
 * ── 교육생 안내 ──────────────────────────────────────────────────────────────
 * 역할: 참고용 구현체 — 수정하지 말 것
 * 관련 모듈: M5 S29 (ActivityRouter · Webhook 이벤트 라우팅)
 */
export class ActivityRouter {
  constructor(
    private readonly issuer:      IssuerService,
    private readonly idempotency: IdempotencyGuard,
  ) {}

  register(server: WebhookServer): void {
    server.on('ACTIVITY_ACHIEVED', this._handleActivityAchieved.bind(this));
    server.on('COUPON_ISSUED',     this._handleCouponIssued.bind(this));
    server.on('VASP_TX_FAILED',    this._handleVaspTxFailed.bind(this));
    // Phase 2+: 'KRW_DEPOSITED', 'STO_SUBSCRIBED' 추가
  }

  private async _handleActivityAchieved(payload: WebhookPayload): Promise<void> {
    const data = payload.data as {
      userId:     string;
      activityId: string;
      eventType:  string;
      eventCode?: number;
      data?:      Record<string, unknown>;
    };

    const event: ActivityEvent = {
      userId:     data.userId,
      eventType:  data.eventType,
      eventCode:  data.eventCode ?? 0,
      data:       data.data ?? {},
      occurredAt: new Date(payload.timestamp),
    };

    await this.idempotency.run(`activity:${payload.requestId}`, async () => {
      await this.issuer.issueActivityNFT({ userId: data.userId, activityId: data.activityId, event });
    });
  }

  private async _handleVaspTxFailed(payload: WebhookPayload): Promise<void> {
    const data = payload.data as { txHash: string; reason?: string };
    await this.issuer.handleVaspTxFailed({ txHash: data.txHash, reason: data.reason });
  }

  private async _handleCouponIssued(payload: WebhookPayload): Promise<void> {
    const data = payload.data as {
      userId:    string;
      couponId:  string;
      eventType: string;
      eventCode?: number;
      data?:     Record<string, unknown>;
    };

    const event: ActivityEvent = {
      userId:     data.userId,
      eventType:  data.eventType,
      eventCode:  data.eventCode ?? 0,
      data:       data.data ?? {},
      occurredAt: new Date(payload.timestamp),
    };

    await this.idempotency.run(`coupon:${payload.requestId}`, async () => {
      await this.issuer.issueActivityNFT({ userId: data.userId, activityId: data.couponId, event });
    });
  }
}
