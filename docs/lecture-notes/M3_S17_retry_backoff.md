# M3 S17 — Retry + Backoff + Webhook 수준 Idempotency

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S17 · 강의 60분  
> 대상: `dmz/packages/event-engine/src/webhook/RetryHandler.ts`  
>       `dmz/packages/event-engine/src/webhook/IdempotencyGuard.ts`  
>       `dmz/packages/vasp/src/recovery/VaspRecoveryService.ts`

---

## S16 → S17 연결

S16에서 TxStateMachineService 레벨의 requestId 기반 Idempotency를 배웠다. S17에서는 한 레이어 위로 올라간다 — 외부 시스템(Core Banking)에 이벤트를 push할 때 발생하는 **네트워크 실패 재시도**와 그 재시도가 만드는 중복 문제를 해결하는 두 패턴을 다룬다.

```
TxStateMachineService
        │
        ▼
ChainEventListener → RetryHandler → Core Banking (Webhook)
                              │
                              └─ IdempotencyGuard (중복 방어)
```

---

## 1. 즉각 재시도가 왜 나쁜가 — Thundering Herd

```
VASP 서버 과부하 상태
→ Consumer 인스턴스 3개가 동시에 실패 감지
→ 3개 모두 즉각 재시도
→ 3 × 10 = 초당 30건 요청 폭발
→ VASP 서버 더 악화
→ 재시도가 장애를 심화 (Thundering Herd Problem)
```

해결: **Exponential Backoff + Jitter** — 재시도 간격을 점점 늘리고, 인스턴스마다 다른 시간에 시도하도록 분산.

---

## 2. RetryHandler 구조 — 에러 클래스 + send()

### 에러 클래스 계층

```typescript
// RetryHandler.ts:44
export class NonRetryableError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export class RetryableError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'RetryableError';
  }
}
```

에러를 명시적으로 두 클래스로 분리 — `instanceof`로 즉시 판별 가능. 숫자 상태코드를 매번 해석하지 않아도 된다.

### send() — 지수 백오프 루프

```typescript
// RetryHandler.ts:72
async send(event: OutboundEvent): Promise<void> {
  let attempt = 0;
  let delayMs = this.config.initialDelayMs;

  while (attempt < this.config.maxAttempts) {
    try {
      await this._post(event);
      return;   // 성공 → 즉시 반환
    } catch (err) {
      attempt++;

      // 재시도 불가 에러 → 즉시 DLQ (더 이상 시도하지 않음)
      if (err instanceof NonRetryableError) {
        await this.dlq.push({ event, error: String(err), attempts: attempt });
        throw err;
      }

      // 최대 재시도 소진 → DLQ
      if (attempt >= this.config.maxAttempts) {
        await this.dlq.push({ event, error: String(err), attempts: attempt });
        throw err;
      }

      // 재시도 가능 에러 → 지수 백오프 대기
      await this._sleep(Math.min(delayMs, this.config.maxDelayMs));
      delayMs *= this.config.backoffFactor;   // 지수 증가
    }
  }
}
```

**RetryConfig:**

```typescript
export interface RetryConfig {
  maxAttempts:    number;   // 최대 시도 횟수 (첫 시도 포함)
  initialDelayMs: number;   // 첫 재시도 전 대기 (예: 1000ms)
  maxDelayMs:     number;   // 최대 대기 상한 (예: 30_000ms)
  backoffFactor:  number;   // 증가 배수 (예: 2 → 1s, 2s, 4s, 8s...)
}
```

---

## 3. _post() — HTTP 오류 분류 + HMAC 서명

```typescript
// RetryHandler.ts:102
private async _post(event: OutboundEvent): Promise<void> {
  const body      = JSON.stringify({ ...event.payload, requestId: event.requestId });
  const signature = await this._sign(body, event.secret);

  let res: Response;
  try {
    res = await fetch(event.targetUrl, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-Kyobo-Signature': signature,    // ← HMAC-SHA256 서명
        'X-Request-Id':      event.requestId,  // ← 수신측 중복 방어용
      },
      body,
    });
  } catch (networkErr) {
    // ECONNREFUSED, ETIMEDOUT → 재시도 가능
    throw new RetryableError(`Network error: ${String(networkErr)}`);
  }

  if (res.ok) return;

  if (this._isNonRetryable(res.status)) {
    throw new NonRetryableError(`HTTP ${res.status}`, res.status);
  }
  throw new RetryableError(`HTTP ${res.status}`, res.status);
}

private _isNonRetryable(status: number): boolean {
  // 429(rate limit), 408(timeout)만 재시도 가능
  if (status >= 400 && status < 500 && status !== 429 && status !== 408) {
    return true;
  }
  return false;
}
```

**HMAC 서명 이유:**
Core Banking이 수신한 Webhook이 진짜 교보 DMZ에서 온 것인지 검증한다. secret을 공유하지 않은 제3자는 유효한 `X-Kyobo-Signature`를 만들 수 없다.

**HTTP 에러 분류:**

| 상태 | 분류 | 이유 |
|---|---|---|
| 5xx (500, 502, 503, 504) | 재시도 가능 | 서버 일시 다운 — 기다리면 해결 |
| 429 Too Many Requests | 재시도 가능 | Rate limit — 잠시 후 재시도 |
| 408 Request Timeout | 재시도 가능 | 일시적 지연 |
| 네트워크 오류 (ECONNREFUSED 등) | 재시도 가능 | 일시적 연결 불가 |
| 400 Bad Request | **재시도 불가** | 페이로드가 잘못됨 — 코드 수정 필요 |
| 401 Unauthorized | **재시도 불가** | 인증 키 문제 |
| 403 Forbidden | **재시도 불가** | 권한 없음 |
| 404 Not Found | **재시도 불가** | 엔드포인트 없음 |
| 422 Unprocessable | **재시도 불가** | 스키마 검증 실패 |

---

## 4. Jitter — 인스턴스 분산

순수 Exponential Backoff에 남은 문제: 동시에 시작한 인스턴스들이 정확히 같은 시간에 재시도한다.

```
인스턴스 3개, 시도 2 모두 실패
→ 모두 정확히 2초 후 동시 재시도
→ 또 동시 폭발
```

**Full Jitter 적용:**

```typescript
// 0 ~ capped 사이 랜덤
function calcJitteredDelay(attempt: number, config: RetryConfig): number {
  const base   = config.initialDelayMs * (config.backoffFactor ** (attempt - 1));
  const capped = Math.min(base, config.maxDelayMs);
  return Math.random() * capped;
}
```

```
인스턴스 3개, 시도 2 실패 (base = 2초)
→ A: 0.7초 대기
→ B: 1.8초 대기
→ C: 1.2초 대기
→ 분산됨 → Core Banking 부하 완화
```

현재 `RetryHandler.send()`는 Jitter 없는 순수 Backoff 구현 — **실습에서 Jitter 버전으로 개선한다.**

---

## 5. DeadLetterQueue — 최종 실패 보관

```typescript
// RetryHandler.ts:162
export class DeadLetterQueue {
  async push(item: {
    event:    OutboundEvent;
    error:    string;
    attempts: number;
  }): Promise<void> {
    // Phase 1: 로그 + DB 저장 (운영팀 수동 재처리)
    // Phase 2: Kafka DLQ 발행 (M2 S11 연계)
    logger.error('outbound event failed', {
      requestId: item.event.requestId,
      attempts:  item.attempts,
      error:     item.error,
    });
  }
}
```

M2 S11의 DLQ 개념과 동일 역할 — 3회 재시도 후 최종 실패 건을 격리해 운영팀이 확인할 수 있게 한다.

---

## 6. IdempotencyGuard — Webhook 수준 TOCTOU 방어

### 문제: exists() → fn() → mark() 패턴의 Race Condition

```typescript
// ❌ 위험한 패턴 — TOCTOU(Time-Of-Check-Time-Of-Use)
async function handleWebhook(key: string, fn: () => Promise<void>) {
  if (await store.exists(key)) return;   // check
  await fn();                            // ← 두 코루틴 모두 false 받으면?
  await store.mark(key);                 // mark
}
```

```
코루틴 A: exists('key') → false
코루틴 B: exists('key') → false  ← A가 mark하기 전에 도달
코루틴 A: fn() 실행
코루틴 B: fn() 실행 ← 중복!
코루틴 A: mark('key')
코루틴 B: mark('key')
```

### 해결: tryMark() — check + mark 원자적 결합

```typescript
// IdempotencyGuard.ts:37
export class IdempotencyGuard {
  constructor(
    private readonly store: IdempotencyStore,
    private readonly ttlSeconds: number = 86400 * 7,  // 7일 보관
  ) {}

  async run(key: string, fn: () => Promise<void>): Promise<boolean> {
    // check + mark 원자적 → Race Condition 없음
    const claimed = await this.store.tryMark(key, this.ttlSeconds);
    if (!claimed) return false;  // 이미 처리됨 → skip

    try {
      await fn();
      return true;
    } catch (err) {
      // fn() 실패 시 mark 해제 → 다음 시도가 재처리 가능
      await this.store.unmark(key);
      throw err;
    }
  }
}
```

**`tryMark()` 인터페이스:**

```typescript
export interface IdempotencyStore {
  // 원자적 check-and-mark
  // true = 이 호출이 최초 선점 (처리 진행)
  // false = 이미 선점됨 (중복 → skip)
  tryMark(key: string, ttlSeconds: number): Promise<boolean>;
  unmark(key: string): Promise<void>;
}
```

**fn() 실패 시 unmark()하는 이유:**

```
fn() 실패 → tryMark()는 이미 성공 → 키가 남아있음
  → 재시작 후 RetryHandler가 재시도
  → tryMark('key') = false (키 있음) → 처리 skip
  → 재처리 기회 없음 → 메시지 영영 처리 안 됨 🚨

fn() 실패 시 unmark() → 키 삭제
  → 재시작 후 tryMark('key') = true → 재처리 가능 ✅
```

### InMemory vs Redis 구현체

```typescript
// InMemoryIdempotencyStore — 개발/테스트용
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, number>();

  async tryMark(key: string, ttlSeconds: number): Promise<boolean> {
    // await 없음 → Map.get/set이 동기 연산 → 이 블록 전체가 원자적
    const exp = this.store.get(key);
    if (exp !== undefined && Date.now() <= exp) return false;
    this.store.set(key, Date.now() + ttlSeconds * 1000);
    return true;
  }

  async unmark(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// RedisIdempotencyStore — 프로덕션용 (다중 인스턴스 환경)
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: {
    set(key: string, value: string, mode: 'NX', flag: 'EX', ttl: number): Promise<string | null>;
    del(key: string): Promise<number>;
  }) {}

  async tryMark(key: string, ttlSeconds: number): Promise<boolean> {
    // SET key 1 NX EX ttlSeconds — 단일 Redis 명령어, 서버 수준 원자적
    const result = await this.redis.set(key, '1', 'NX', 'EX', ttlSeconds);
    return result === 'OK';  // OK = 최초 선점 / null = 이미 존재 (중복)
  }

  async unmark(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
```

**InMemory vs Redis 차이:**

| | InMemoryStore | RedisStore |
|---|---|---|
| **원자성 보장** | Node.js 단일 스레드 + await 없음 | SET NX 단일 명령어 |
| **다중 인스턴스** | 불가 (인스턴스마다 별도 Map) | 가능 (Redis 공유) |
| **용도** | 개발/테스트 | 프로덕션 |

---

## 7. VaspRecoveryService — 실패 유형별 복구 전략

```typescript
// VaspRecoveryService.ts:3
export type FailureReason =
  | 'REVERT'         // 컨트랙트 실행 실패 — 재시도 불가
  | 'OUT_OF_GAS'     // 가스 한도 초과 — gasLimit 올려서 재시도
  | 'NONCE_TOO_LOW'  // 논스 충돌 — 재동기화 후 재시도
  | 'TIMEOUT'        // mempool stuck — 폴링 대기
  | 'NETWORK_ERROR'; // 일시적 연결 오류 — 재시도 가능
```

**DEFAULT_RETRY_POLICY:**

```typescript
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts:       3,
  initialDelayMs:    1_000,
  maxDelayMs:        30_000,
  backoffMultiplier: 2,
  retryableErrors:   ['OUT_OF_GAS', 'NONCE_TOO_LOW', 'NETWORK_ERROR'],
  nonRetryableErrors: ['REVERT'],  // REVERT → 즉시 FAILED
};
```

**실패 유형별 처리 전략:**

| FailureReason | 처리 | 이유 |
|---|---|---|
| REVERT | 즉시 FAILED — 재시도 없음 | 컨트랙트 로직 오류 — 재시도해도 같은 결과 |
| OUT_OF_GAS | gasLimit 20% 인상 후 재시도 | 충분한 가스 제공하면 성공 가능 |
| NONCE_TOO_LOW | vaspClient.resyncNonce() 후 재시도 | 논스 불일치 — 재동기화 후 재시도 가능 |
| TIMEOUT | SUBMITTED 유지 + 폴링 대기 | TX는 여전히 mempool에 있음 — 채굴 대기 |
| NETWORK_ERROR | Backoff 재시도 | 일시적 연결 오류 |

### handleTxRevert — REVERT 처리 (실습 TODO)

```typescript
// VaspRecoveryService.ts:48
async handleTxRevert(requestId: string, txHash: string, reason: string): Promise<RecoveryResult> {
  // TODO:
  // 1. ledger.getMintRequest(requestId) — 없으면 MintRequestNotFoundError
  // 2. status !== 'SUBMITTED' → InvalidStateTransitionError
  // 3. ledger.updateMintRequest(requestId, { status: 'FAILED', txHash, errorMsg: reason })
  // 4. notifier.send({ type: 'TX_FAILED', requestId, txHash, reason })
  // return { requestId, action: 'FAILED', message: `TX reverted: ${reason}` }
}
```

**REVERT가 NonRetryableError인 이유:**

```
REVERT = 컨트랙트가 require() 또는 revert()를 명시적으로 호출
       = 비즈니스 규칙 위반 (예: 잔액 부족, 권한 없음)
       = 재시도해도 동일 REVERT
       → 즉시 FAILED + 운영팀 알림
```

### handleTxTimeout — TIMEOUT 처리 (실습 TODO)

```typescript
async handleTxTimeout(requestId: string, txHash: string): Promise<RecoveryResult> {
  // TODO:
  // TIMEOUT은 즉시 FAILED 아님 — SUBMITTED 유지, 폴링 대기
  // 1. ledger.getMintRequest(requestId)
  // 2. 상태 변경 없음 (SUBMITTED 유지)
  // 3. notifier.send({ type: 'TX_TIMEOUT_ALERT', requestId, txHash })
  // return { requestId, action: 'POLLING', message: 'Kept SUBMITTED, polling will resolve' }
}
```

---

## 8. retryWithBackoff 실습 — TODO 완성

```typescript
// VaspRecoveryService.ts:96 — 현재 TODO 상태
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
      // TODO 1: policy.nonRetryableErrors에 포함되면 즉시 throw
      // TODO 2: 마지막 시도면 throw lastError
      // TODO 3: Jitter 포함 sleep → delay 갱신
      throw new Error('Not implemented');
    }
  }
  throw lastError;
}
```

**완성 답안:**

```typescript
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

      // NonRetryable → 즉시 throw
      const isNonRetryable = policy.nonRetryableErrors.some(
        r => lastError?.message.includes(r),
      );
      if (isNonRetryable) throw lastError;

      // 마지막 시도 소진
      if (attempt >= policy.maxAttempts) throw lastError;

      // Full Jitter 포함 Backoff
      const jittered = delay * (0.5 + Math.random() * 0.5);
      await new Promise(r => setTimeout(r, Math.min(jittered, policy.maxDelayMs)));
      delay = Math.min(delay * policy.backoffMultiplier, policy.maxDelayMs);
    }
  }
  throw lastError;
}
```

---

## S17 핵심 요약

| 개념 | 핵심 |
|---|---|
| Thundering Herd | 즉각 재시도 → 동시 폭발 → 장애 심화 |
| Exponential Backoff | delayMs *= backoffFactor (지수 증가) + maxDelayMs cap |
| Full Jitter | `0 ~ capped` 랜덤 → 인스턴스 분산 |
| NonRetryable | 4xx (429/408 제외) → 즉시 DLQ — 재시도해도 같은 결과 |
| HMAC 서명 | Webhook 발신자 검증 — secret 공유 없이 위변조 불가 |
| IdempotencyGuard | tryMark() 원자적 check+mark → TOCTOU Race Condition 방어 |
| Redis SET NX | 다중 인스턴스 환경 원자적 선점 — InMemory는 단일 인스턴스만 |
| fn() 실패 시 unmark | 재처리 기회 보존 — unmark 안 하면 메시지 영영 처리 안 됨 |
| REVERT | NonRetryableError → 즉시 FAILED (재시도 무의미) |
| TIMEOUT (VaspRecovery 레벨) | 상태 변경 없음 + 운영팀 알림 — pollStale이 처리 |
| TIMEOUT (TxStateMachine 레벨) | PENDING → gas bump → PENDING 유지 (S20에서 구현) |

> **두 레이어의 TIMEOUT 처리 구분:**  
> `VaspRecoveryService.handleTxTimeout` = 상위 레벨 — 알림 전송, 상태 유지 (이 세션)  
> `TxStateMachineService.handleTimeout` = 하위 레벨 — gas bump 재전송, txHash 교체 (S20)

**S18 예고:** VaspRecoveryService에 남아 있는 TODO — `handleTxRevert` / `handleNonceConflict` / `handleReorg` 구현을 완성한다. REVERT reason 분류별 대응과 handleTxRevert 완성 실습이 핵심이다.

---

**완료 기준:**
- [ ] Thundering Herd 문제를 Jitter로 해결하는 원리 설명
- [ ] NonRetryableError와 RetryableError 분류 기준 — 왜 400은 재시도 불가인가
- [ ] `IdempotencyGuard.run()` — tryMark() 원자적 패턴으로 TOCTOU 해결 설명
- [ ] Redis SET NX가 InMemory보다 다중 인스턴스에 안전한 이유
- [ ] `fn()` 실패 시 `unmark()` 호출이 없으면 어떤 문제가 발생하는가
- [ ] `retryWithBackoff` TODO 완성 — Jitter + nonRetryableErrors 처리
- [ ] REVERT vs TIMEOUT 처리 전략 차이 설명
