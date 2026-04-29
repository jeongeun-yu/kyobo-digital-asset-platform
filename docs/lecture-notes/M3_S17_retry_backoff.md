# M3 S17 — 외부 API 장애 대응 Exponential Backoff + Jitter

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S17 · 1시간  
> 대상: `dmz/packages/event-engine/src/webhook/RetryHandler.ts`, `dmz/packages/vasp/src/recovery/VaspRecoveryService.ts`

---

## S17 — 외부 API 장애 대응 — Exponential Backoff + Jitter

### 1. 즉각 재시도가 왜 나쁜가

```
VASP 서버 과부하 상태
→ 3개 Consumer 인스턴스가 동시에 즉각 재시도
→ 3개 × 10회 = 초당 30건 요청 폭발
→ VASP 서버 더 악화
→ 재시도가 장애를 심화시킴 (Thundering Herd)
```

### 2. Exponential Backoff 원리

```
RetryConfig:
  initialDelayMs: 1_000   (1초)
  maxDelayMs:     30_000  (30초)
  backoffFactor:  2

시도 1 실패 → 1초 대기
시도 2 실패 → 2초 대기
시도 3 실패 → 4초 대기
시도 4 실패 → 8초 대기
시도 5 실패 → 16초 대기
        (30초 cap 적용 → max 30초)
```

**RetryHandler 구현 (RetryHandler.ts:70):**

```typescript
async send(event: OutboundEvent): Promise<void> {
  let attempt = 0;
  let delayMs = this.config.initialDelayMs;

  while (attempt < this.config.maxAttempts) {
    try {
      await this._post(event);
      return;                          // 성공 → 즉시 반환
    } catch (err) {
      attempt++;

      // 재시도 불가 에러 → 즉시 DLQ
      if (err instanceof NonRetryableError) {
        await this.dlq.push({ event, error: String(err), attempts: attempt });
        throw err;
      }

      // 최대 재시도 소진 → DLQ
      if (attempt >= this.config.maxAttempts) {
        await this.dlq.push({ event, error: String(err), attempts: attempt });
        throw err;
      }

      // Backoff 대기 후 재시도
      await this._sleep(Math.min(delayMs, this.config.maxDelayMs));
      delayMs *= this.config.backoffFactor;  // ← 지수 증가
    }
  }
}
```

### 3. Jitter — Thundering Herd 방지

순수 Exponential Backoff에 남은 문제: 동시에 시작한 여러 인스턴스는 **같은 시간에 재시도**한다.

```
인스턴스 3개, 모두 시도 2 실패
→ 모두 정확히 2초 후 동시에 재시도
→ 또 동시 폭발
```

**Jitter 적용:**

```typescript
// Jitter 추가 버전 — VASP retry에 적용
function calcDelay(attempt: number, config: RetryConfig): number {
  const base  = config.initialDelayMs * (config.backoffFactor ** (attempt - 1));
  const capped = Math.min(base, config.maxDelayMs);
  // Full Jitter: 0 ~ capped 사이 랜덤
  return Math.random() * capped;
}
```

```
인스턴스 3개, 시도 2 실패
→ 인스턴스 A: 0.7초 대기
→ 인스턴스 B: 1.8초 대기
→ 인스턴스 C: 1.2초 대기
→ 분산됨 → VASP 부하 완화
```

### 4. 재시도 가능 vs 불가 에러 분류

```typescript
// RetryHandler.ts:138
private _isNonRetryable(status: number): boolean {
  // 4xx 중 429(rate limit), 408(timeout)만 재시도 가능
  // 나머지 4xx는 구조적 문제 → 재시도해도 동일 결과
  if (status >= 400 && status < 500 && status !== 429 && status !== 408) {
    return true;
  }
  return false;
}
```

| HTTP 상태 | 분류 | 이유 |
|---|---|---|
| 5xx (500, 502, 503, 504) | 재시도 가능 | 서버 일시 다운 — 기다리면 해결 |
| 429 Too Many Requests | 재시도 가능 | Rate limit — 잠시 후 재시도 |
| 408 Request Timeout | 재시도 가능 | 일시적 지연 |
| 네트워크 오류 (ECONNREFUSED) | 재시도 가능 | 일시적 연결 불가 |
| 400 Bad Request | **재시도 불가** | 페이로드 자체가 잘못됨 |
| 401 Unauthorized | **재시도 불가** | 인증 키 문제 — 코드 수정 필요 |
| 403 Forbidden | **재시도 불가** | 권한 없음 |
| 404 Not Found | **재시도 불가** | 엔드포인트 없음 |
| 422 Unprocessable | **재시도 불가** | 스키마 검증 실패 |

### 5. VaspRecoveryService — retryWithBackoff 구현

```typescript
// VaspRecoveryService.ts:96
async retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = this.retryPolicy,
): Promise<T> {
  let lastError: Error | undefined;
  let delay = policy.initialDelayMs;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // TODO (실습): NonRetryable 체크 + delay sleep + delay *= backoffMultiplier
      throw new Error('Not implemented — complete the retry loop');
    }
  }
  throw lastError;
}
```

### 6. 실습 — retryWithBackoff 완성 + 429 테스트

```typescript
// TODO: retryWithBackoff 구현
async retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = this.retryPolicy,
): Promise<T> {
  let lastError: Error | undefined;
  let delay = policy.initialDelayMs;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // TODO 1: err가 NonRetryableError인지 확인 — 맞으면 즉시 throw
      // TODO 2: 마지막 시도였으면 throw lastError
      // TODO 3: delay 만큼 sleep 후 delay = min(delay * backoffMultiplier, maxDelayMs)
    }
  }
  throw lastError;
}
```

```typescript
// 답안
async retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = this.retryPolicy,
): Promise<T> {
  let lastError: Error | undefined;
  let delay = policy.initialDelayMs;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // NonRetryable 에러 → 즉시 throw (DLQ 처리는 호출자 책임)
      if (policy.nonRetryableErrors.some(e => lastError?.message.includes(e))) {
        throw lastError;
      }

      // 마지막 시도 소진
      if (attempt >= policy.maxAttempts) throw lastError;

      // Backoff 대기 (Jitter 포함)
      const jittered = delay * (0.5 + Math.random() * 0.5);
      await new Promise(r => setTimeout(r, Math.min(jittered, policy.maxDelayMs)));
      delay = Math.min(delay * policy.backoffMultiplier, policy.maxDelayMs);
    }
  }
  throw lastError;
}
```

**429 응답 테스트:**

```typescript
it('3회 429 → Backoff 후 재시도 → 4번째 성공', async () => {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    if (callCount < 4) throw new RetryableError('429', 429);
    return 'success';
  };

  const result = await recovery.retryWithBackoff(fn, {
    ...DEFAULT_RETRY_POLICY,
    maxAttempts: 5,
    initialDelayMs: 10,   // 테스트 속도를 위해 10ms
  });

  expect(result).toBe('success');
  expect(callCount).toBe(4);
});
```

**완료 기준:**
- [ ] `retryWithBackoff` 완성 — 지수 백오프 + Jitter
- [ ] 5회 재시도 후 FAILED 전이 확인
- [ ] 429 → Backoff 후 재시도 → 성공 테스트 통과
