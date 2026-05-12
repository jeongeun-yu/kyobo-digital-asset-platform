/**
 * CircuitBreaker ???몃? ?쒕퉬???μ븷 李⑤떒 ?⑦꽩
 *
 * M8 ISMS-P ?곌퀎: issuer-service ??internal/internal-ledger ?곌껐 ?μ븷 ??
 * 臾댄븳 ?ъ떆?????鍮좊Ⅸ ?ㅽ뙣(fail-fast)濡??꾪솚.
 *
 * ?곹깭 ?꾩씠:
 *   CLOSED    ???뺤긽. 紐⑤뱺 ?붿껌 ?듦낵.
 *   OPEN      ??李⑤떒. failureThreshold 珥덇낵 ???꾩씠. CircuitOpenError 利됱떆 諛섑솚.
 *   HALF_OPEN ??蹂듦뎄 ?먯깋. recoveryTimeMs 寃쎄낵 ??泥??붿껌留??듦낵.
 *               ?깃났 ??CLOSED / ?ㅽ뙣 ??OPEN ?ъ쭊??
 *
 *   CLOSED ??(N???ㅽ뙣)????OPEN ??(recoveryTimeMs 寃쎄낵)????HALF_OPEN
 *                                                            ???깃났 ??CLOSED
 *                                                            ???ㅽ뙣 ??OPEN
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold: number;   // OPEN ?꾪솚 湲곗? ?곗냽 ?ㅽ뙣 ?잛닔 (湲곕낯 5)
  recoveryTimeMs:   number;   // OPEN ??HALF_OPEN ?꾪솚 ?湲?ms (湲곕낯 30000)
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
    super(`Circuit breaker OPEN ??retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'CircuitOpenError';
  }
}
