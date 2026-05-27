/**
 * RetryHandler — 실패한 Webhook 외부 발송의 재시도 관리
 *
 * 교보 core banking 등 외부 시스템에 이벤트를 push할 때 사용.
 * 지수 백오프 + 최대 재시도 횟수. 최종 실패는 DeadLetterQueue로.
 *
 * 멱등성: requestId를 외부 시스템에 전달 → 수신측도 requestId로 중복 처리 방지.
 *
 * ## 에러 분류 — 재시도 가능 vs 불가
 *
 * 재시도 가능 (일시적 문제 — 기다리면 해결됨):
 *   - 5xx: 서버 일시 다운 (500, 502, 503, 504)
 *   - 429: Too Many Requests (rate limit — 잠시 후 재시도)
 *   - 408: Request Timeout
 *   - 네트워크 오류: ECONNREFUSED, ETIMEDOUT (Core Banking 일시 다운)
 *
 * 재시도 불가 (구조적 문제 — 재시도해도 동일 결과):
 *   - 400: Bad Request — 페이로드가 잘못됨. 재시도해도 같은 400.
 *   - 401: Unauthorized — 인증 키 문제. 재시도해도 같은 401.
 *   - 403: Forbidden — 권한 없음. 재시도해도 같은 403.
 *   - 404: Not Found — 엔드포인트 없음. 재시도해도 같은 404.
 *   - 422: Unprocessable Entity — 스키마 검증 실패.
 *   - 410: Gone — 영구 제거된 리소스.
 *   → 즉시 DLQ로 보내 개발자가 원인 파악 후 수정해야 함.
 *     재시도 지연만 발생시키고 Core Banking에 불필요한 부하를 줌.
 *
 */

import { logger } from '../infra/logger';

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

/** 재시도 불가 에러 — 즉시 DLQ로 */
export class NonRetryableError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/** 재시도 가능 에러 — 지수 백오프 후 재시도 */
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
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

        // 재시도 불가 에러 — 즉시 DLQ, 더 이상 시도하지 않음
        if (err instanceof NonRetryableError) {
          await this.dlq.push({ event, error: String(err), attempts: attempt });
          throw err;
        }

        // 최대 재시도 소진 — DLQ
        if (attempt >= this.config.maxAttempts) {
          await this.dlq.push({ event, error: String(err), attempts: attempt });
          throw err;
        }

        // 재시도 가능 에러 — 지수 백오프 후 재시도
        await this._sleep(Math.min(delayMs, this.config.maxDelayMs));
        delayMs *= this.config.backoffFactor;
      }
    }
  }

  private async _post(event: OutboundEvent): Promise<void> {
    const body      = JSON.stringify({ ...event.payload, requestId: event.requestId });
    const signature = await this._sign(body, event.secret);

    let res: Response;
    try {
      res = await fetch(event.targetUrl, {
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'X-Kyobo-Signature': signature,
          'X-Request-Id':      event.requestId,
        },
        body,
      });
    } catch (networkErr) {
      // ECONNREFUSED, ETIMEDOUT 등 네트워크 레벨 오류 → 재시도 가능
      throw new RetryableError(`Network error: ${String(networkErr)}`);
    }

    if (res.ok) return;

    // HTTP 에러 분류
    if (this._isNonRetryable(res.status)) {
      throw new NonRetryableError(
        `HTTP ${res.status} — 재시도 불가 (클라이언트 오류, 코드/설정 수정 필요)`,
        res.status,
      );
    }

    // 5xx, 429, 408 등 → 재시도 가능
    throw new RetryableError(`HTTP ${res.status}`, res.status);
  }

  /**
   * 재시도 불가 HTTP 상태 코드 판별.
   * 4xx 중 429(rate limit)만 재시도 가능 — 나머지 4xx는 구조적 문제.
   */
  private _isNonRetryable(status: number): boolean {
    if (status >= 400 && status < 500 && status !== 429 && status !== 408) {
      return true;
    }
    return false;
  }

  private async _sign(body: string, secret: string): Promise<string> {
    const { createHmac } = await import('crypto');
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// ── DLQ 영속성 인터페이스 ──────────────────────────────────────────────────────

export interface DLQItem {
  id:         string;
  requestId:  string;
  targetUrl:  string;
  payload:    Record<string, unknown>;
  error:      string;
  attempts:   number;
  failedAt:   Date;
}

/** DLQ 저장소 — DB / Kafka / SQS 등으로 교체 가능 */
export interface DLQStore {
  save(item: DLQItem): Promise<void>;
}

/**
 * DeadLetterQueue — 최종 실패 이벤트 영속 보관
 *
 * store 주입 시 → DB/Kafka에 저장 (수동 재처리 가능)
 * store 미주입 시 → 로그만 기록 (개발/테스트 환경)
 */
export class DeadLetterQueue {
  constructor(private readonly store?: DLQStore) {}

  async push(item: { event: OutboundEvent; error: string; attempts: number }): Promise<void> {
    logger.error('outbound event failed', {
      requestId: item.event.requestId,
      attempts:  item.attempts,
      error:     item.error,
    });

    if (this.store) {
      const dlqItem: DLQItem = {
        id:        `dlq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        requestId: item.event.requestId,
        targetUrl: item.event.targetUrl,
        payload:   item.event.payload,
        error:     item.error,
        attempts:  item.attempts,
        failedAt:  new Date(),
      };
      await this.store.save(dlqItem);
    }
  }
}
