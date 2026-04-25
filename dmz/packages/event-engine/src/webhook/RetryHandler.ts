/**
 * RetryHandler — 실패한 Webhook 외부 발송의 재시도 관리
 *
 * 교보 core banking 등 외부 시스템에 이벤트를 push할 때 사용.
 * 지수 백오프 + 최대 재시도 횟수. 최종 실패는 DeadLetterQueue로.
 *
 * 멱등성: requestId를 외부 시스템에 전달 → 수신측도 requestId로 중복 처리 방지.
 */

export interface RetryConfig {
  maxAttempts:    number;
  initialDelayMs: number;
  maxDelayMs:     number;
  backoffFactor:  number;
}

export interface OutboundEvent {
  requestId: string;
  targetUrl: string;
  payload:   Record<string, unknown>;
  secret:    string;
}

export class RetryHandler {
  constructor(
    private readonly config: RetryConfig,
    private readonly dlq: DeadLetterQueue,
  ) {}

  async send(event: OutboundEvent): Promise<void> {
    let attempt  = 0;
    let delayMs  = this.config.initialDelayMs;

    while (attempt < this.config.maxAttempts) {
      try {
        await this._post(event);
        return;
      } catch (err) {
        attempt++;
        if (attempt >= this.config.maxAttempts) {
          await this.dlq.push({ event, error: String(err), attempts: attempt });
          throw err;
        }
        await this._sleep(Math.min(delayMs, this.config.maxDelayMs));
        delayMs *= this.config.backoffFactor;
      }
    }
  }

  private async _post(event: OutboundEvent): Promise<void> {
    const body      = JSON.stringify({ ...event.payload, requestId: event.requestId });
    const signature = await this._sign(body, event.secret);

    const res = await fetch(event.targetUrl, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-Kyobo-Signature': signature,
        'X-Request-Id':      event.requestId,
      },
      body,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  private async _sign(body: string, secret: string): Promise<string> {
    const { createHmac } = await import('crypto');
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

/**
 * DeadLetterQueue — 최종 실패 이벤트 보관
 * Phase 1: 로그 기록 + DB 저장 (수동 재처리)
 * Phase 2+: 메시지 큐(Kafka/SQS) 연동으로 교체 가능
 */
export class DeadLetterQueue {
  async push(item: { event: OutboundEvent; error: string; attempts: number }): Promise<void> {
    // TODO: DB 저장 또는 Kafka DLQ 발행
    console.error('[DLQ] failed event:', JSON.stringify(item, null, 2));
  }
}
