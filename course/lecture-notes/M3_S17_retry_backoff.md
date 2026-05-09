# M3 S17 — Retry + Backoff + Webhook 수준 Idempotency

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.

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

---

## 9. Decorator Pattern — 어댑터 기능 확장 (코드 무변경)

Retry 로직을 어댑터 내부에 직접 구현하면 어떤 문제가 생기는가:

```typescript
// ❌ 내부 구현 — 관심사 혼합
class EVMAdapter {
  async mintNFT(params) {
    // 비즈니스 로직 (NFT 발행)
    // + 재시도 로직
    // + 로깅 로직
    // + 측정 로직
    // → 한 클래스에 3가지 관심사 혼합
  }
}
```

Decorator Pattern: 기능을 별도 클래스로 분리하고 **원본 코드 변경 없이 감싼다**.

```
RetryAdapterDecorator
  └── LoggingAdapterDecorator
        └── EVMAdapter (원본)
```

```typescript
// ✅ 데코레이터 조합
const adapter =
  new RetryAdapterDecorator(
    new LoggingAdapterDecorator(
      new EVMAdapter({ rpcUrl, chainId }),
      logger,
    ),
    { maxAttempts: 3, initialDelayMs: 500 },
  );

// IssuerService는 어떤 데코레이터가 감싸져 있는지 모름
const issuer = new IssuerService(adapter);
```

#### AdapterDecorator 추상 기반 클래스

```typescript
// chain-adapters/src/decorators/AdapterDecorator.ts
export abstract class AdapterDecorator implements IBlockchainAdapter {
  constructor(protected readonly inner: IBlockchainAdapter) {}

  // 기본 구현: 모든 메서드를 inner로 위임
  get chainId()   { return this.inner.chainId; }
  get chainType() { return this.inner.chainType; }
  async isConnected()    { return this.inner.isConnected(); }
  async getBlockNumber() { return this.inner.getBlockNumber(); }
  async mintNFT(p)       { return this.inner.mintNFT(p); }
  // ... (나머지 메서드도 동일)
}
```

서브클래스는 **override할 메서드만 재정의** — 나머지는 자동 위임.

#### LoggingAdapterDecorator

```typescript
// chain-adapters/src/decorators/LoggingAdapterDecorator.ts
export class LoggingAdapterDecorator extends AdapterDecorator {
  constructor(inner: IBlockchainAdapter, private readonly logger: Logger) {
    super(inner);
  }

  override async mintNFT(p: MintParams): Promise<TransactionReceipt> {
    return this._wrap('mintNFT', { tokenId: p.tokenId, to: p.to }, () => this.inner.mintNFT(p));
  }

  private async _wrap<T>(method: string, meta: object, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    this.logger.info(`[${method}] start ${JSON.stringify(meta)}`);
    try {
      const result = await fn();
      this.logger.info(`[${method}] ok ${Date.now() - start}ms`);
      return result;
    } catch (err) {
      this.logger.error(`[${method}] error ${Date.now() - start}ms: ${String(err)}`);
      throw err;
    }
  }
}
```

#### RetryAdapterDecorator

```typescript
// chain-adapters/src/decorators/RetryAdapterDecorator.ts
const NON_RETRYABLE = ['execution reverted', 'insufficient funds', 'nonce too high'];

export class RetryAdapterDecorator extends AdapterDecorator {
  override async mintNFT(p: MintParams): Promise<TransactionReceipt> {
    return this._retry(() => this.inner.mintNFT(p));
  }

  private async _retry<T>(fn: () => Promise<T>): Promise<T> {
    let delayMs = this.opts.initialDelayMs;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg = String(err).toLowerCase();
        if (NON_RETRYABLE.some(p => msg.includes(p))) throw err;  // 즉시 throw
        if (attempt === this.opts.maxAttempts) throw err;          // 소진 → throw
        await new Promise(r => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * this.opts.backoffFactor, this.opts.maxDelayMs);
      }
    }
    throw new Error('unreachable');
  }
}
```

**NON_RETRYABLE 분류 이유:**

| 패턴 | 이유 |
|---|---|
| `execution reverted` | 컨트랙트 로직 오류 — 재시도해도 동일 REVERT |
| `insufficient funds` | 지갑 잔액 부족 — 잔액이 늘어나기 전까지 재시도 의미 없음 |
| `nonce too high` | Nonce 불일치 — 재시도 전에 Nonce 재동기화 필요 (S20 연계) |

---

## 10. Circuit Breaker — Fail-Fast로 복잡한 재시도 방지

Retry만으로는 부족한 상황이 있다.

```
외부 서비스 30분 다운 → RetryAdapterDecorator 3회 시도 → 실패
→ 다음 요청 3회 → 실패
→ 수백 건의 요청이 모두 3회씩 시도 → 네트워크 포화
→ 서비스 복구 후에도 타임아웃 폭발 → 복구 지연
```

Circuit Breaker: 연속 실패가 임계치를 넘으면 **즉시 실패 반환(fail-fast)** — 외부 서비스를 호출하지 않는다.

```
CLOSED  ──(N회 연속 실패)──→ OPEN ──(recoveryTimeMs 경과)──→ HALF_OPEN
  ↑                                                               │ 성공
  └───────────────────────────────────────────────────────────────┘
                                                                  │ 실패
                                                                  ▼
                                                                 OPEN
```

```typescript
// core-banking/src/adapters/CircuitBreaker.ts
export class CircuitBreaker {
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailedAt >= this.opts.recoveryTimeMs) {
        this.state = 'HALF_OPEN';  // 복구 탐색 시작
      } else {
        throw new CircuitOpenError(retryAfterMs);  // fn() 실행 없이 즉시 throw
      }
    }
    try {
      const result = await fn();
      this._onSuccess();  // → failures=0, state=CLOSED
      return result;
    } catch (err) {
      this._onFailure();  // → failures++, (threshold 초과 시) state=OPEN
      throw err;
    }
  }
}
```

**HALF_OPEN 상태의 의미:**

```
OPEN 상태에서 recoveryTimeMs 경과
→ "혹시 복구됐을지도" — 첫 번째 요청만 통과 (탐색)
→ 성공 → CLOSED (정상 운영 재개)
→ 실패 → OPEN (recoveryTimeMs 초기화, 다시 대기)
```

**InternalGatewayClient에서의 사용:**

```typescript
// core-banking/src/adapters/InternalGatewayClient.ts
class InternalGatewayClient {
  private readonly cb: CircuitBreaker;

  async request(params): Promise<unknown> {
    return this.cb.execute(async () => {
      // 실제 HTTP 요청 — OPEN 상태면 여기까지 도달하지 않음
      return fetch(params.url, ...);
    });
  }

  getCircuitState(): CircuitState { return this.cb.getState(); }
}
```

**S17 실습 [5] CircuitBreaker 섹션에서 확인할 것:**
- `failureThreshold=3, recoveryTimeMs=100ms` 설정으로 상태 전이 체험
- 3회 실패 → OPEN → CircuitOpenError 즉시 throw 확인
- 100ms 후 → HALF_OPEN → 성공 → CLOSED 복귀 확인

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
| Decorator Pattern | 어댑터 변경 없이 Logging·Retry 기능 추가 — 중첩 조합 가능 |
| NON_RETRYABLE (Adapter) | REVERT·잔액 부족·Nonce 불일치 → 즉시 throw (재시도 무의미) |
| Circuit Breaker | CLOSED→OPEN(N회 실패)→HALF_OPEN→CLOSED — 외부 장애 시 fail-fast |
| CircuitOpenError | OPEN 상태에서 fn() 실행 없이 즉시 throw — 네트워크 포화 방지 |

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
- [ ] Decorator Pattern — AdapterDecorator 상속 구조 설명 (override할 메서드만 재정의)
- [ ] RetryAdapterDecorator NON_RETRYABLE 3가지 패턴과 이유 설명
- [ ] Retry(Logging(adapter)) 중첩 시 각 레이어에서 무슨 일이 일어나는지 설명
- [ ] CircuitBreaker CLOSED/OPEN/HALF_OPEN 상태 전이도 그릴 수 있어야 함
- [ ] HALF_OPEN 상태의 목적 — "한 번만 통과"가 왜 중요한가
