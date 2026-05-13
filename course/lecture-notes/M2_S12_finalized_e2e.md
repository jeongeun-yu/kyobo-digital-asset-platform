# M2 S12 — Finalized 블록 기준 처리와 파이프라인 장애 복원력 검증

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.  
> **Phase 1 맥락:** FINALIZED 확인은 `IBlockchainAdapter.queryEvents()` / `getReceipt()` 를 통한 read-only 조회로 수행합니다. `ChainEventListener`의 직접 이벤트 구독은 Phase 2+에서 활성화됩니다. Phase 1에서 주 이벤트 수신 경로는 월렛원 Webhook → 내부망 WebhookReceiver입니다.

> Block B — 이벤트 파이프라인 · M2 S12 · 강의 55분  
> 대상: `internal/packages/event-engine/src/stream/ConsumerGroupWorker.ts`, `internal/packages/event-engine/src/stream/DLQHandler.ts`, `internal/packages/event-engine/src/processors/NFTIssuedProcessor.ts`

---

## 1. 왜 Finalized 블록 기준인가

**블록 확정 단계:**

```
PENDING    → 아직 마이닝 안 됨
CONFIRMED  → 마이닝됨, but Reorg 가능
FINALIZED  → PoS Checkpoint 통과, 절대 불변
```

**Reorg(체인 재편)가 일어나면:**

```
블록 #100에 NFT 발행 TX 포함
→ 원장 업데이트 완료
→ 체인 재편: 블록 #100이 고아 블록(Orphan)이 됨
→ TX가 없던 일이 됨
→ 원장에는 NFT 발행 기록이 남음 (불일치)
```

Finalized 이전에 처리하면 Reorg로 인한 데이터 불일치가 발생할 수 있다.

**Ethereum PoS Finality:**

```
블록 생성 → 2 epochs(약 12분) 후 Finalized
eth_subscribe('newFinalizedBlock') — 전용(Private) RPC에서만 지원
```

## 2. NFTIssuedProcessor 구조

`src/processors/NFTIssuedProcessor.ts` — `EventProcessor` 인터페이스의 구체 구현체.

```typescript
// LedgerService 인터페이스 (M4에서 PostgreSQL 구현체로 교체)
export interface LedgerService {
  creditNFT(owner: string, tokenId: string, amount?: number): Promise<void>;
  getNFTBalance(owner: string, tokenId: string): Promise<number>;
}

// Finalized 블록 번호 조회 인터페이스
export interface FinalizedBlockProvider {
  getFinalizedBlockNumber(): Promise<number>;
}

export class NFTIssuedProcessor implements EventProcessor {
  readonly eventTypes = ['NFT_ISSUED'];

  constructor(
    private readonly idempotency:             IdempotencyGuard,
    private readonly ledger:                  LedgerService,
    private readonly finalizedBlockProvider?: FinalizedBlockProvider,
  ) {}

  async process(message: StreamMessage): Promise<void> {
    const payload    = JSON.parse(message.fields['payload'] ?? '{}');
    const requestId  = message.fields['requestId'] ?? message.id;

    // Step 1: Finalized 체크
    if (this.finalizedBlockProvider && payload.blockNumber != null) {
      const finalized = await this.finalizedBlockProvider.getFinalizedBlockNumber();
      if (payload.blockNumber > finalized) {
        throw new DeferredProcessingError(`block ${payload.blockNumber} not yet finalized`);
        // Worker가 DeferredProcessingError를 잡아 XACK 없이 PEL 잔류 처리
        // retryCount 증가 없음 — 실패가 아니라 "아직 처리할 수 없음"
      }
    }

    // Step 2+3: 멱등성 확인 → 원장 업데이트
    await this.idempotency.run(`NFTIssued:${requestId}`, async () => {
      await this.ledger.creditNFT(payload.to, payload.tokenId);
    });
  }
}

// M2 실습·테스트용 (M4에서 PostgreSQL로 교체)
export class InMemoryLedgerService implements LedgerService {
  readonly holdings = new Map<string, number>();

  async creditNFT(owner: string, tokenId: string, amount = 1): Promise<void> {
    const key = `${owner}:${tokenId}`;
    this.holdings.set(key, (this.holdings.get(key) ?? 0) + amount);
  }

  async getNFTBalance(owner: string, tokenId: string): Promise<number> {
    return this.holdings.get(`${owner}:${tokenId}`) ?? 0;
  }
}
```

**처리 순서 (At-least-once 4단계 불변 규칙):**

| 단계 | 동작 | XACK 여부 |
|------|------|----------|
| Finalized 미확정 | `return` | 없음 → PEL 잔류 |
| 중복 requestId | `idempotency.run()` 스킵 | Worker가 처리 |
| 정상 처리 | `creditNFT()` 실행 | Worker가 처리 |

XACK는 `ConsumerGroupWorker._handleWithRetry()`에서 처리 — `NFTIssuedProcessor`는 호출하지 않음.

## 3. Finalized 체크 로직

**주의:** `DeferredProcessingError`를 throw하고 XACK를 호출하지 않는다.  
→ `ConsumerGroupWorker._handleWithRetry()`가 `DeferredProcessingError`를 잡아 retryCount 증가 없이 PEL 잔류  
→ `_reclaimPending()`(XAUTOCLAIM)이 minIdleMs 경과 후 재수신  
→ Finalized가 되면 그 때 정상 처리

`throw new Error()` vs `return` 차이:
- `return` → 워커가 성공으로 간주 → XACK 호출 → 메시지 영구 소실
- `throw DeferredProcessingError` → 워커가 PEL 잔류 처리 → retryCount 증가 없음
- `throw Error` (일반 오류) → retryCount++ → 3회 후 DLQ 이동 (잘못된 동작)

```typescript
// FinalizedBlockProvider 없이 생성 → Finalized 체크 스킵 (M2 실습 기본값)
const processor = new NFTIssuedProcessor(idempotency, ledger);

// FinalizedBlockProvider 주입 → 체크 활성화
const processor = new NFTIssuedProcessor(idempotency, ledger, {
  async getFinalizedBlockNumber() { return 18_000_000; },
});
```

### (1) 한 줄 요약

**NFT_ISSUED 이벤트 1건을 받아 "블록 확정 여부 → 멱등성 → 원장 업데이트" 3단계로 처리하는 EventProcessor.**

지금까지 본 ConsumerGroupWorker가 호출하는 **실제 비즈니스 로직의 1단계 구현체**.

### (2) 인터페이스 두 개 먼저 이해

#### `LedgerService`

```typescript
export interface LedgerService {
  creditNFT(owner: string, tokenId: string, amount?: number): Promise<void>;
  getNFTBalance(owner: string, tokenId: string): Promise<number>;
}
```

- **원장(ledger)** = 잔고 기록부
- `creditNFT` = 발행 (적립)
- `getNFTBalance` = 잔고 조회
- **현재는 인터페이스만, 실제 구현은 M4에서 PostgreSQL로 교체 예정**

#### `FinalizedBlockProvider`

```typescript
export interface FinalizedBlockProvider {
  getFinalizedBlockNumber(): Promise<number>;
}
```
- 블록체인의 **확정된(finalized) 블록 번호** 반환
- 이 번호 이하 블록은 "더 이상 뒤집히지 않음" 보장
- 그 위 블록은 reorg(재구성) 가능성 있음

### (3) TS 문법 새로 등장한 것

#### `implements EventProcessor`
- **`implements`** = 클래스가 인터페이스를 만족함을 명시
- 인터페이스 필드/메서드를 모두 구현해야 컴파일 통과
- 단순히 형태만 맞추는 게 아니라 **명시적 약속**

#### `readonly eventTypes = ['NFT_ISSUED'];`
- **`readonly`** = 한 번 정해지면 변경 불가
- 클래스 인스턴스마다 같은 값 (사실상 상수)
- 외부에서 `processor.eventTypes = [...]` 할당 시도 → 컴파일 에러

#### `private readonly finalizedBlockProvider?: FinalizedBlockProvider`
- **`?:`** = 선택적(optional) 매개변수
- 없으면 `undefined`로 들어옴
- 의미: "Finalized 검증을 켜고 싶으면 주입, 아니면 건너뜀"

#### `payload.blockNumber != null`
- **`!=` (느슨한 비교)** — 보통 `!==` 권장하지만 여기선 의도적
- `!= null`은 `null`과 `undefined` **둘 다** 한 번에 검사
- `!== null && !== undefined`의 단축형

#### `throw new DeferredProcessingError(...)`
- **커스텀 에러 클래스** throw
- Worker 측에서 `instanceof DeferredProcessingError`로 잡아 **특별 처리**
- 일반 Error와 다르게 "재시도 카운트 안 올림"

#### `await this.idempotency.run(key, async () => { ... })`
- **함수를 인자로 넘김** — 콜백 패턴
- `idempotency.run()`이 키 체크 후 신규일 때만 콜백 실행
- 멱등성 로직이 캡슐화됨 → 사용자는 "키 + 처리할 일"만 작성

### (4) 의존성 주입 패턴

#### 생성자 시그니처

```typescript
constructor(
  private readonly idempotency:             IdempotencyGuard,
  private readonly ledger:                  LedgerService,
  private readonly finalizedBlockProvider?: FinalizedBlockProvider,
) {}
```

**3개 의존성:**
1) **`idempotency`** — 멱등성 체크 (필수)
2) **`ledger`** — 원장 업데이트 (필수)
3) **`finalizedBlockProvider`** — 블록 확정 검증 (선택)

#### 왜 의존성 주입인가

- 테스트 시 mock 객체로 교체 가능
- 환경별로 구현체 다르게 (로컬 = 메모리, 프로덕션 = PostgreSQL)
- M4에서 LedgerService를 PostgreSQL 구현체로 교체할 때 **이 클래스 코드 변경 0**

#### 단축 문법 활용
- `private readonly` + 매개변수 직접 명시
- 별도 필드 선언 + `this.x = x` 할당 코드 생략
- TS의 강력한 보일러플레이트 절약

### (5) 3단계 처리 라인별 해부

#### Step 1: Finalized 블록 검증

```typescript
if (this.finalizedBlockProvider && payload.blockNumber != null) {
  const finalized = await this.finalizedBlockProvider.getFinalizedBlockNumber();
  if (payload.blockNumber > finalized) {
    throw new DeferredProcessingError(`block ${payload.blockNumber} not yet finalized`);
  }
}
```

**왜 필요한가 — 블록체인 reorg 문제:**
- 새 블록은 일정 시간 동안 "임시" 상태
- 다른 체인 분기가 더 길어지면 → 기존 블록 **무효화** (reorg)
- 무효화된 블록의 NFT_ISSUED 이벤트 처리하면 → **존재하지 않는 발행**으로 원장 오염

**해법: Finalized 이하만 처리**
- Ethereum: ~64블록(약 12분) 이상 지나야 finalized
- finalized 이전엔 안 처리 → reorg 위험 0

**왜 throw로 처리:**
- 정상 처리 흐름 차단
- Worker가 `DeferredProcessingError` 보고 **특수 분기** 진입
- "실패"가 아니라 "아직 때가 아님" → 카운트 안 올림

#### Step 2-3: 멱등성 가드 + 원장 업데이트

```typescript
await this.idempotency.run(`NFTIssued:${requestId}`, async () => {
  await this.ledger.creditNFT(payload.to, payload.tokenId);
});
```

**`idempotency.run`의 동작 추정:**

```typescript
// 내부 구현 (대략)
async run(key: string, callback: () => Promise<void>) {
  if (await this.has(key)) return;       // 이미 처리됨 → 무시
  await callback();                       // 신규 → 비즈니스 로직 실행
  await this.mark(key);                   // 처리 완료 기록
}
```

**키 형식: `NFTIssued:${requestId}`**
- 접두사 `NFTIssued:` — 다른 이벤트 타입과 충돌 방지
- 같은 requestId라도 다른 이벤트면 별도 키 (예: `NFTBurned:req-001` vs `NFTIssued:req-001`)

**핵심 안전장치:**
- 같은 메시지 2번 와도 ledger.creditNFT는 **1번만 호출**
- At-least-once 큐의 중복을 흡수

### (6) DeferredProcessingError vs 일반 throw

이 코드 설계의 **핵심 통찰**:

| 상황 | throw 방식 | retryCount | 결과 |
|------|-----------|-----------|------|
| DB 연결 실패 | `throw new Error(...)` | +1 | 3회 후 DLQ |
| 외부 API 타임아웃 | `throw new Error(...)` | +1 | 3회 후 DLQ |
| 블록 미확정 | `throw new DeferredProcessingError(...)` | **유지** | PEL 잔류, 시간 지나면 자동 처리됨 |

**왜 구분하는가:**
- DB 실패 = 시스템 문제 → 빨리 알아채야 함 → DLQ
- 블록 미확정 = 시간 지나면 해결 → 기다리면 됨 → 단순 잔류

**Worker 측 추정 코드:**
```typescript
try {
  await processor.process(msg);
  await xack(...);
} catch (err) {
  if (err instanceof DeferredProcessingError) {
    // 카운트 안 올림, XACK 안 함, 그냥 다음 메시지
    return;
  }
  // 일반 에러 → retryCount 증가
  msg.fields['_retryCount'] = String(retryCount + 1);
}
```

### (7) requestId fallback 전략

```typescript
const requestId = message.fields['requestId'] ?? message.id;
```

**우선순위:**
1) **명시적 requestId** — 송신자가 부여한 비즈니스 ID
2) **Redis messageId** — 큐가 자동 생성한 ID

**왜 fallback이 필요한가:**
- 외부 시스템이 requestId 안 보낼 수도 있음
- 그래도 멱등성은 보장해야 함 → messageId라도 사용
- messageId는 Redis가 보장하는 고유값 → 멱등성 키로 충분

**의미:**
- 이상적: 송신자가 의미 있는 requestId 부여
- 차선: 큐의 messageId로라도 중복 차단

### (8) payload 안전 파싱

```typescript
const payload = JSON.parse(message.fields['payload'] ?? '{}');
```

- payload 필드 없으면 `'{}'` (빈 객체 JSON)
- 파싱 결과는 빈 객체 `{}`
- `payload.blockNumber` 등 접근해도 `undefined` (throw 안 남)

**JSON.parse 자체의 위험:**
- 잘못된 JSON 문자열이면 throw
- 이 코드는 그 경우 그대로 throw → 일반 에러 → retryCount 증가
- "잘못된 메시지"로 취급해서 결국 DLQ

### (9) 의존성이 인터페이스인 이점

#### 현재 (M2)
```typescript
const ledger: LedgerService = new InMemoryLedger();  // 메모리 구현
```

#### 미래 (M4)
```typescript
const ledger: LedgerService = new PostgresLedger(pool);  // DB 구현
```

**NFTIssuedProcessor 코드는 동일.** 인터페이스만 만족하면 됨.

이게 **DIP (Dependency Inversion Principle)** — 고수준 모듈(processor)이 저수준 모듈(DB)에 직접 의존하지 않고 추상(인터페이스)에 의존.

### (10) 강의 강조 포인트

- **`implements`로 명시적 계약** — `EventProcessor` 만족 강제, 시그니처 어긋나면 컴파일 에러
- **`readonly` 클래스 필드** — 인스턴스 생성 후 변경 불가 보장
- **선택적 의존성 `?:`** — 점진적 기능 추가에 유리 (Finalized 검증 없이도 동작)
- **`!= null` 관용** — null과 undefined 한 번에 검사. 이 경우만 예외적으로 `==` 허용
- **DeferredProcessingError 패턴** — "재시도해야 하는 실패"와 "기다리면 해결될 지연"을 구분
- **블록체인 reorg 인식** — 금융 시스템에선 finalized 검증이 필수. 미확정 블록 처리 = 잠재적 손실
- **멱등성 키 네임스페이스** — `EventType:requestId` 형식으로 충돌 방지
- **콜백 패턴의 멱등성** — 키 체크와 비즈니스 로직을 분리, 사용자는 "할 일"만 작성
- **인터페이스 의존 = 미래 교체 비용 0** — M4에서 LedgerService 구현 바뀌어도 이 클래스 그대로
- **3단계의 미묘한 차이** — Finalized = 사전 조건, 멱등성 = 중복 방지, 원장 = 실제 효과

### (11) 한 줄 정리

> **`NFTIssuedProcessor`는 NFT 발행 이벤트의 비즈니스 로직 본체.**  
> "블록 확정됐나" → "이미 처리했나" → "원장에 기록"의 3단계.  
> 핵심은 `DeferredProcessingError`로 **"실패"와 "지연"을 구분**한 것 — 둘 다 throw지만 Worker는 다르게 반응한다.  
> 의존성은 모두 인터페이스 → M4에서 PostgreSQL로 교체해도 이 코드는 변경 없음.

## 4. Consumer 장애 복구 실습 시나리오

**시나리오:**

```
1. ConsumerGroupWorker 실행 중
2. 메시지 XREADGROUP으로 소유 (PEL 등록)
3. 처리 중 Ctrl+C (강제 종료)
4. XACK 안 됨 → PEL에 메시지 잔류
5. 30초 경과 (minIdleMs)
6. Consumer 재시작
7. _reclaimPending() → XAUTOCLAIM으로 재수신
8. 정상 처리 + XACK
```

**CLI로 확인:**

```bash
# 1. PEL 상태 확인
redis-cli XPENDING kyobo:events issuer-consumers - + 10
# 결과: 메시지 ID, Consumer 이름, idle 시간, 전달 횟수

# 2. XAUTOCLAIM으로 강제 재수신 (idle 0ms = 즉시)
redis-cli XAUTOCLAIM kyobo:events issuer-consumers consumer-1 0 0-0 COUNT 10
# 결과: 재수신된 메시지 목록

# 3. PEL 비어있음 확인 (처리 완료 후)
redis-cli XPENDING kyobo:events issuer-consumers - + 10
# 결과: (empty list or set)
```

## 5. M2 전체 E2E 흐름 검증

```
VASP (외부) → WebhookServer(내부망)
→ WebhookPublishHandler (IdempotencyGuard → RedisStreamPublisher)
→ kyobo:events Stream (MockRedisStream)
→ ConsumerGroupWorker → NFTIssuedProcessor
→ InMemoryLedgerService (M2 실습용)
→ XACK
```

**실습 파일:** `src/exercises/S12_e2e.ts`

```typescript
// MockRedisStream: RedisStreamClient + RedisConsumerClient 동시 구현
// 메모리 배열(store[])로 XADD/XREADGROUP/XACK를 시뮬레이션
// → Redis 서버 없이 전체 파이프라인을 로컬에서 완주

// 실행:
// npx ts-node src/exercises/S12_e2e.ts

// 채점:
// npx jest src/__tests__/e2e.test.ts
```

**5가지 검증 시나리오:**

| 검증 | 확인 방법 | 기대값 |
|------|----------|--------|
| [1] 정상 Webhook | HTTP 응답 코드 | 202 |
| [2] Stream 적재 | `mockRedis.messageCount` | 1 |
| [3] 원장 업데이트 | `ledger.getNFTBalance()` | 1 |
| [4] 멱등성 (동일 requestId 재전송) | Stream 수 + 원장 잔고 | 여전히 1 / 1 |
| [5] HMAC 검증 실패 | 잘못된 서명 전송 → | 401 |

**TODO 목록 (실습에서 직접 구현):**

```
TODO 1: WebhookPublishHandler 생성 + server.on('NFT_ISSUED', ...) 등록
TODO 2: NFTIssuedProcessor 생성 (idempotencyConsumer, ledger)
TODO 3: ConsumerGroupWorker 생성
        config: streamKey='kyobo:events', groupName='issuer-consumers',
                consumerId='worker-s12', batchSize=10, blockMs=30, minIdleMs=30_000
TODO 4: 동일 BODY(requestId) 재전송 → 멱등성 확인
TODO 5: 잘못된 서명으로 전송 → 401 확인
```

---

## E2E 실습 스켈레톤과 답안

### 스켈레톤 구조

```typescript
// src/exercises/S12_e2e.ts

import { WebhookServer }         from '../webhook/WebhookServer';
import { WebhookPublishHandler } from '../webhook/WebhookPublishHandler';
import { IdempotencyGuard, InMemoryIdempotencyStore } from '../webhook/IdempotencyGuard';
import { ConsumerGroupWorker }   from '../stream/ConsumerGroupWorker';
import { DLQHandler }            from '../stream/DLQHandler';
import { NFTIssuedProcessor, InMemoryLedgerService } from '../processors/NFTIssuedProcessor';
import { MockRedisStream }       from '../test-utils/MockRedisStream';
import crypto from 'crypto';

async function runE2E() {
  const SECRET       = 'test-secret-s12';
  const mockRedis    = new MockRedisStream();  // Redis 없이 메모리로 시뮬레이션
  const ledger       = new InMemoryLedgerService();
  const dlqHandler   = new DLQHandler(mockRedis);

  // TODO 1: WebhookPublishHandler와 서버 설정
  //   1-a. InMemoryIdempotencyStore로 IdempotencyGuard 생성 (server 측)
  //   1-b. WebhookPublishHandler 생성 (publisherIdempotency, mockRedis 발행자 사용)
  //   1-c. WebhookServer 생성 (port: 3099, secret: SECRET, maxBodyKb: 64)
  //   1-d. server.on('NFT_ISSUED', handler.createHandler())

  // TODO 2: NFTIssuedProcessor 생성
  //   2-a. InMemoryIdempotencyStore로 별도 IdempotencyGuard 생성 (consumer 측)
  //   2-b. NFTIssuedProcessor 생성 (idempotencyConsumer, ledger)

  // TODO 3: ConsumerGroupWorker 생성
  //   config: streamKey='kyobo:events', groupName='issuer-consumers',
  //           consumerId='worker-s12', batchSize=10, blockMs=30, minIdleMs=30_000
  //   processors: [nftIssuedProcessor]

  // 서버 기동
  // await server.listen();
  // worker.start();  // 백그라운드 실행 (await 없이)

  // 검증 1~5 ...
}
```

### 답안

```typescript
async function runE2E() {
  const SECRET    = 'test-secret-s12';
  const mockRedis = new MockRedisStream();
  const ledger    = new InMemoryLedgerService();
  const dlqHandler = new DLQHandler(mockRedis);

  // TODO 1 답안: WebhookPublishHandler + WebhookServer
  const publisherIdempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());
  const publisher = {
    publish: async (event: any) => {
      return await mockRedis.xadd('kyobo:events', {
        eventType:   event.eventType,
        payload:     JSON.stringify(event.payload),
        requestId:   event.requestId,
        publishedAt: String(Date.now()),
      });
    },
    initialize: async () => {},
  };
  const handler = new WebhookPublishHandler(publisher, publisherIdempotency);
  const server = new WebhookServer({ port: 3099, secret: SECRET, maxBodyKb: 64 });
  server.on('NFT_ISSUED', handler.createHandler());

  // TODO 2 답안: NFTIssuedProcessor
  const idempotencyConsumer = new IdempotencyGuard(new InMemoryIdempotencyStore());
  const nftIssuedProcessor  = new NFTIssuedProcessor(idempotencyConsumer, ledger);

  // TODO 3 답안: ConsumerGroupWorker
  const worker = new ConsumerGroupWorker({
    redis:      mockRedis,
    config: {
      streamKey:   'kyobo:events',
      groupName:   'issuer-consumers',
      consumerId:  'worker-s12',
      batchSize:   10,
      blockMs:     30,
      minIdleMs:   30_000,
    },
    processors: [nftIssuedProcessor],
    dlq:        dlqHandler,
  });

  await server.listen();
  worker.start();  // 백그라운드

  // 잠시 대기 (worker가 초기화될 시간)
  await sleep(50);

  // ──────────────── 검증 1: 정상 Webhook → 202 ────────────────
  const body1 = JSON.stringify({
    eventType: 'NFT_ISSUED',
    data:      { to: '0xABCD', tokenId: '42' },
    timestamp: Date.now(),
    requestId: 'req-e2e-001',
  });
  const sig1 = hmac(SECRET, body1);
  const res1 = await postWebhook('http://localhost:3099', body1, sig1);
  console.assert(res1 === 202, `[1] expected 202, got ${res1}`);
  console.log('[1] 정상 Webhook → 202 ✅');

  await sleep(100);  // worker 처리 대기

  // ──────────────── 검증 2: Stream 적재 ────────────────
  console.assert(mockRedis.messageCount('kyobo:events') === 1,
    `[2] expected 1 message, got ${mockRedis.messageCount('kyobo:events')}`);
  console.log('[2] Stream 적재 확인 (1건) ✅');

  // ──────────────── 검증 3: 원장 업데이트 ────────────────
  const balance1 = await ledger.getNFTBalance('0xABCD', '42');
  console.assert(balance1 === 1, `[3] expected balance=1, got ${balance1}`);
  console.log(`[3] 원장 업데이트 확인 (balance=${balance1}) ✅`);

  // ──────────────── 검증 4: 멱등성 (동일 requestId 재전송) ────────────────
  // TODO 4 답안: 같은 body + 같은 sig로 두 번 전송
  const res4 = await postWebhook('http://localhost:3099', body1, sig1);
  console.assert(res4 === 202, `[4] expected 202, got ${res4}`);
  await sleep(100);
  const balance2 = await ledger.getNFTBalance('0xABCD', '42');
  console.assert(balance2 === 1, `[4] expected balance still 1, got ${balance2}`);
  console.log(`[4] 멱등성 확인 (balance=${balance2}, Stream count=${mockRedis.messageCount('kyobo:events')}) ✅`);

  // ──────────────── 검증 5: HMAC 검증 실패 → 401 ────────────────
  // TODO 5 답안: 잘못된 서명 전송
  const res5 = await postWebhook('http://localhost:3099', body1, 'invalid-signature');
  console.assert(res5 === 401, `[5] expected 401, got ${res5}`);
  console.log('[5] HMAC 검증 실패 → 401 ✅');

  worker.stop();
  await server.close();
  console.log('\n✅ M2 E2E 검증 완료');
}

// 헬퍼 함수
function hmac(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret)
               .update(Buffer.from(body))
               .digest('hex');
}

async function postWebhook(url: string, body: string, sig: string): Promise<number> {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.request(url, {
      method:  'POST',
      headers: {
        'Content-Type':       'application/json',
        'X-Kyobo-Signature':  sig,
        'Content-Length':     Buffer.byteLength(body),
      },
    }, (res: any) => resolve(res.statusCode));
    req.write(body);
    req.end();
  });
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

runE2E().catch(console.error);
```

---

### E2E 흐름 아스키 다이어그램

```
runE2E() 실행 흐름:

[테스트 코드]
     │
     │  HTTP POST /webhook (body + HMAC 서명)
     ▼
[WebhookServer :3099]
     │  _verifySignature() → 통과
     │  202 즉시 응답
     │  handler.createHandler()(payload) → 비동기
     ▼
[WebhookPublishHandler]
     │  IdempotencyGuard.run(requestId) → 신규 확인
     │  publisher.publish()
     ▼
[MockRedisStream: kyobo:events]
     │  XADD → messageId
     │
     │  (백그라운드 worker polling)
     ▼
[ConsumerGroupWorker]
     │  _processNew(): XREADGROUP > → 메시지 수신
     │  _handleWithRetry(msg)
     │     processors.filter(NFT_ISSUED) → NFTIssuedProcessor
     ▼
[NFTIssuedProcessor]
     │  IdempotencyGuard.run(`NFTIssued:${requestId}`)
     │  ledger.creditNFT(to, tokenId)
     ▼
[InMemoryLedgerService]
     holdings: { '0xABCD:42': 1 }
     │
     └── XACK → PEL 제거

[테스트 코드]
     ledger.getNFTBalance('0xABCD', '42') === 1 ✅
```

## 6. M2 모듈 완료 기준 체크리스트

- [ ] **At-least-once + 멱등성**: 동일 이벤트 2회 → 원장 1회만 반영
- [ ] **장애 복구**: Consumer 강제 종료 → 재시작 후 미ACK 메시지 자동 재수신
- [ ] **DLQ**: 3회 실패 → DLQ 이동 + 알림
- [ ] **Finalized 체크**: Finalized 미확정 이벤트 → 처리 보류 (XACK 안 함)
- [ ] **E2E**: Webhook 수신 → Stream 적재 → Consumer 처리 → 원장 업데이트 1건 완주
- [ ] **수평 확장**: Consumer 2개 동시 실행 → 메시지 중복 처리 없음

---

## 핵심 정리

```
M2 이벤트 파이프라인의 신뢰성 3원칙:

1. At-least-once + 멱등성
   "최소 1회 처리 보장 + 중복 발행 차단"
   → DB unique constraint + ON CONFLICT DO NOTHING

2. PEL + XAUTOCLAIM
   "Consumer 장애 시 미처리 메시지 자동 복구"
   → XACK를 마지막 단계로 → PEL에 잔류 → 재수신

3. DLQ + 알림
   "3회 실패 메시지 격리 + 운영자 개입 유도"
   → 무한 재시도 대신 격리 → 원인 파악 → 수동 재큐잉
```

**다음 모듈 (M3 S13~S22):**

M2에서 배운 것들은 M3에서 그대로 재사용된다.

| M2에서 배운 것 | M3에서 다시 등장하는 곳 |
|---|---|
| `ConsumerGroupWorker` At-least-once | S22: `pollStaleRequests` 결과 처리 |
| `IdempotencyGuard` requestId 중복 차단 | S16: VASP 재전송 방어 |
| `DLQHandler` 3회 실패 격리 | S17: NonRetryableError → 즉시 DLQ |
| Finalized 블록 기준 처리 | S13: MINED → FINALIZED → CONFIRMED 전이 조건 |

M2가 "이벤트가 도착했을 때 어떻게 안전하게 처리하는가"였다면,  
M3는 "TX를 보냈을 때 블록체인이 어떤 경로로 실패하는가, 각각 어떻게 복구하는가"이다.  
`VaspTxClient` 인터페이스와 `TxStateMachineService`의 7-상태 머신부터 시작한다.
