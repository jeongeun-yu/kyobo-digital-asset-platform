/**
 * CircuitBreaker — 외부 서비스 장애 차단 패턴
 *
 * M8 ISMS-P 연계: DMZ → internal/blockchain-gateway 연결 장애 시
 * 무한 재시도 대신 빠른 실패(fail-fast)로 전환.
 *
 * 상태 전이:
 *   CLOSED    → 정상. 모든 요청 통과.
 *   OPEN      → 차단. failureThreshold 초과 시 전이. CircuitOpenError 즉시 반환.
 *   HALF_OPEN → 복구 탐색. recoveryTimeMs 경과 후 첫 요청만 통과.
 *               성공 → CLOSED / 실패 → OPEN 재진입.
 *
 *   CLOSED ──(N회 실패)──→ OPEN ──(recoveryTimeMs 경과)──→ HALF_OPEN
 *                                                            │ 성공 → CLOSED
 *                                                            └ 실패 → OPEN
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold: number;   // OPEN 전환 기준 연속 실패 횟수 (기본 5)
  recoveryTimeMs:   number;   // OPEN → HALF_OPEN 전환 대기 ms (기본 30000)
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  recoveryTimeMs:   30_000,
};

export class CircuitBreaker {
  private state:          CircuitState = 'CLOSED';
  private failures:       number       = 0;
  private lastFailedAt:   number       = 0;
  private readonly opts:  CircuitBreakerOptions;

  constructor(opts: Partial<CircuitBreakerOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailedAt >= this.opts.recoveryTimeMs) {
        this.state = 'HALF_OPEN';
      } else {
        throw new CircuitOpenError(this.opts.recoveryTimeMs - (Date.now() - this.lastFailedAt));
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  getState(): CircuitState { return this.state; }
  getFailures(): number    { return this.failures; }

  reset(): void {
    this.state        = 'CLOSED';
    this.failures     = 0;
    this.lastFailedAt = 0;
  }

  private _onSuccess(): void {
    this.failures = 0;
    this.state    = 'CLOSED';
  }

  private _onFailure(): void {
    this.failures++;
    this.lastFailedAt = Date.now();
    if (this.failures >= this.opts.failureThreshold) {
      this.state = 'OPEN';
    }
  }
}

export class CircuitOpenError extends Error {
  constructor(retryAfterMs: number) {
    super(`Circuit breaker OPEN — retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'CircuitOpenError';
  }
}
