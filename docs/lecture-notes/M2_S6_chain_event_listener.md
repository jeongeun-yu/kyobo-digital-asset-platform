# M2 S6 — ChainEventListener 내부 구조 완전 해부

> Block B — 이벤트 파이프라인 · Day 03 후반 · 90분  
> 대상: `dmz/packages/event-engine/src/listener/ChainEventListener.ts`,  
>        `dmz/packages/event-engine/src/handlers/NFTIssuedHandler.ts`,  
>        `dmz/packages/event-engine/src/webhook/IdempotencyGuard.ts`,  
>        `dmz/packages/event-engine/src/webhook/RetryHandler.ts`

---

# 이 세션이 답하는 질문

**"서버가 재시작됐다. 꺼져있는 동안 Issued 이벤트 3개가 발생했다. 누가, 어떻게, 이것을 처리하는가?"**

S5에서 EVMAdapter가 이벤트를 구독하고 파싱하는 것을 봤다.  
S5 실습 Step 5에서 `queryEvents`로 수동 복구를 해봤다.

**이제 이것을 자동화하는 구조가 ChainEventListener다.**

이 세션이 답하는 구체적인 질문들:

```
Q1. 서버가 재시작할 때 "어디서부터 다시 읽어야 하는가"를 어떻게 아는가?
Q2. 과거 이벤트를 한꺼번에 10만 블록 조회하면 RPC가 터진다. 어떻게 나눠서 읽는가?
Q3. 이벤트 핸들러가 여러 개 있을 때, 어떻게 올바른 핸들러에 연결하는가?
Q4. 같은 이벤트가 두 번 도착하면(네트워크 재시도) 중복 처리를 어떻게 막는가?
Q5. Core Banking이 일시적으로 다운됐을 때 Webhook을 어떻게 재시도하는가?
```

이 5개 질문이 이 세션을 관통한다.

---

# 전체 흐름 — 세션 지도

## S5 → S6 연결

S5에서 배운 것:
```
EVMAdapter.subscribeEvents()  ← 실시간 구독 (WebSocket)
EVMAdapter.queryEvents()      ← 과거 이벤트 조회 (eth_getLogs)
_toChainEvent()               ← raw Log → ChainEvent 변환
```

S6가 다루는 것:
```
ChainEventListener.start()            ← 두 메서드를 조합해 안전하게 시작 ☆ To-Do : 두 메서드가 어떤 메서드를 말하는 건지??
ChainEventListener._recoverMissedEvents() ← queryEvents를 1000블록씩 잘라서 반복
ChainEventListener._dispatch()        ← ChainEvent → 올바른 핸들러로 라우팅
NFTIssuedHandler.handle()             ← 멱등성 + Retry + Webhook
```

## 파이프라인 전체에서의 위치

```
[블록체인 노드]
      │ WebSocket (구독) / HTTP (복구)
      ▼
[EVMAdapter]                          ← S5에서 해부 완료
  subscribeEvents() / queryEvents()
  _toChainEvent()
      │ ChainEvent 객체
      ▼
[ChainEventListener]                  ← S6 핵심 구간
  start()
  _recoverMissedEvents()
  _dispatch()
      │ 매칭된 핸들러 목록
      ▼
[NFTIssuedHandler]                    ← S6 핵심 구간
  IdempotencyGuard.run()
  RetryHandler.send()
      │ HTTP POST + HMAC 서명
      ▼
[Core Banking]
  원장 기록
```

## 이 세션의 구간

```
[ChainEventListener] ─────────────────────────────────────────────────► [Core Banking]
   ↑                                                                          ↑
   이 세션 시작                                                          이 세션 끝
```

---

# 1부 — ChainEventListener.start() 완전 해부 (25분)

## 1-1. 코드 전체 읽기

```bash
cat dmz/packages/event-engine/src/listener/ChainEventListener.ts
```

```typescript
// ChainEventListener.ts (전체, 103줄)
export class ChainEventListener {
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly adapter:   IBlockchainAdapter,   // ← EVMAdapter 또는 다른 체인
    private readonly handlers:  IEventHandler[],       // ← NFTIssuedHandler 등 핸들러 목록
    private readonly contracts: Array<{
      addr:       string;
      abi:        unknown[];
      eventNames: string[];
    }>,
    private readonly stateStore: {
      getLastProcessedBlock(): Promise<number>;
      setLastProcessedBlock(block: number): Promise<void>;
    },
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const fromBlock  = await this.stateStore.getLastProcessedBlock();
    const curBlock   = await this.adapter.getBlockNumber();

    // 재시작 시 missed event 복구
    if (fromBlock < curBlock) {
      await this._recoverMissedEvents(fromBlock, curBlock);
    }

    // 실시간 구독
    for (const contract of this.contracts) {
      const unsub = await this.adapter.subscribeEvents(
        contract.addr,
        contract.abi,
        contract.eventNames,
        curBlock,
        async (event) => {
          await this._dispatch(event);
          await this.stateStore.setLastProcessedBlock(event.blockNumber);
        },
      );
      this.unsubscribers.push(unsub);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.unsubscribers.forEach(unsub => unsub());
    this.unsubscribers = [];
  }
  // ... (이하 _recoverMissedEvents, _dispatch)
}
```

---

## 1-2. start()의 7단계

`start()`는 7개의 논리적 단계로 이루어진다. 각 단계를 따라가며 읽어보자.

```
Step 1: 중복 실행 방지
        if (this.running) return;
        ← start()가 두 번 호출되면 두 번째는 즉시 반환
        ← unsubscribers가 중복으로 쌓이지 않는다

Step 2: 실행 상태 기록
        this.running = true;
        ← stop() 전까지 true
        ← stop()에서 false로 바꾼다

Step 3: stateStore에서 마지막 처리 블록 조회
        const fromBlock = await this.stateStore.getLastProcessedBlock();
        ← 재시작 전 마지막으로 처리된 블록 번호
        ← DB에서 읽으므로 서버가 죽어도 보존됨
        ← 최초 실행 시 0 또는 배포 블록 번호 반환

Step 4: 현재 블록 번호 조회
        const curBlock = await this.adapter.getBlockNumber();
        ← 지금 이 순간의 블록 높이
        ← Hardhat 로컬: 즉시 / Sepolia: 최신 블록

Step 5: missed event 복구 (fromBlock < curBlock 인 경우만)
        if (fromBlock < curBlock) {
          await this._recoverMissedEvents(fromBlock, curBlock);
        }
        ← fromBlock == curBlock이면 놓친 게 없다. 바로 구독으로 넘어간다
        ← fromBlock < curBlock이면 그 사이 이벤트를 복구한다

Step 6: 실시간 구독 등록
        for (const contract of this.contracts) {
          const unsub = await this.adapter.subscribeEvents(..., async (event) => {
            await this._dispatch(event);
            await this.stateStore.setLastProcessedBlock(event.blockNumber);  ← 진행상황 저장
          });
          this.unsubscribers.push(unsub);
        }
        ← 구독 핸들러 안에서: 이벤트 처리 + stateStore 갱신
        ← 갱신 순서가 중요: dispatch() 성공 후 setLastProcessedBlock()

Step 7: stop() 호출 시 정리
        this.unsubscribers.forEach(unsub => unsub());
        ← subscribeEvents()가 반환한 unsubscribe 함수들을 실행
        ← WebSocket 구독 해제 → 메모리 해제
```

---

## 1-3. start()의 타임라인 — 재시작 시나리오

```
─────────────────────────────────────────────────────────────────────────────► 시간

[정상 운영 중]
  블록 100 ~ 500: 이벤트 처리 완료
  stateStore: lastProcessedBlock = 500

[서버 다운] (t=500)
  블록 501: Issued 이벤트 발생  ← 놓침
  블록 502: Issued 이벤트 발생  ← 놓침
  블록 503: Issued 이벤트 발생  ← 놓침

[서버 재시작] (t=530, 블록=503)
  start() 호출:

  Step 3: getLastProcessedBlock() → 500
  Step 4: getBlockNumber()        → 503
  Step 5: fromBlock(500) < curBlock(503) → _recoverMissedEvents(500, 503)
           → 블록 501~503 이벤트 처리 완료
           → stateStore: lastProcessedBlock = 503
  Step 6: subscribeEvents(fromBlock=503, ...)
           → 블록 504부터 실시간 구독 시작

─────────────────────────────────────────────────────────────────────────────► 시간
        500    501    502    503    504    505
         │      │      │      │      │
         │      └──────┴──────┘      └──► 실시간 구독 시작
         │      (복구 구간)
         │
         서버 다운 시점
```

> **강사 멘트**: "서버가 죽어있는 동안 이벤트가 얼마나 쌓였든, 재시작하면 start()가 자동으로 그 구간을 스캔합니다. 이것이 DB에 lastProcessedBlock을 저장하는 이유입니다. 메모리에 저장하면 서버가 죽는 순간 사라집니다."

---

## 1-4. 구독 핸들러 안의 순서 문제

`start()`의 구독 핸들러를 다시 보자:

```typescript
async (event) => {
  await this._dispatch(event);                              // (A) 이벤트 처리
  await this.stateStore.setLastProcessedBlock(event.blockNumber);  // (B) 블록 기록
},
```

**(A) 후 (B)** — 지금 순서

```
이벤트 처리 → 성공 → 블록 기록
이벤트 처리 → 실패 → 블록 기록 안 됨 → 재시작 시 재처리
```

이벤트 처리에 실패하면 블록 기록이 되지 않는다.  
재시작하면 같은 이벤트를 다시 처리한다.  
**→ 중복 처리 가능성 있음. 그래서 NFTIssuedHandler에 IdempotencyGuard가 필요하다.**

반대로 **(B) 후 (A)** 순서로 뒤집으면?

```
블록 기록 → 이벤트 처리 → 실패 → 재시작 → 해당 블록 건너뜀
```

이벤트 처리 전에 블록이 기록되면, 처리 실패 시 해당 이벤트가 영구히 누락된다.  
**→ 더 나쁘다. 중복은 막을 수 있지만 누락은 복구 불가.**

**결론**: 현재 순서(처리 후 기록)가 올바르다. 중복 처리 가능성은 IdempotencyGuard로 막는다.

---

# 2부 — _recoverMissedEvents(): CHUNK 기반 스캔 (20분)

## 2-1. 코드 읽기

```typescript
// ChainEventListener.ts 75~93줄
private async _recoverMissedEvents(from: number, to: number): Promise<void> {
  const CHUNK = 1000;  // 블록 청크 — RPC 과부하 방지

  for (const contract of this.contracts) {
    for (const eventName of contract.eventNames) {
      let start = from;
      while (start < to) {
        const end    = Math.min(start + CHUNK, to);
        const events = await this.adapter.queryEvents(
          contract.addr, contract.abi, eventName, start, end,
        );
        for (const event of events) {
          await this._dispatch(event);
        }
        await this.stateStore.setLastProcessedBlock(end);
        start = end + 1;
      }
    }
  }
}
```

---

## 2-2. 왜 CHUNK=1000인가

```
[질문]: 서버가 일주일 다운됐다. Ethereum 기준 7일 = 약 50,400블록.
        한 번에 조회하면 어떻게 되는가?

eth_getLogs({
  fromBlock: 100,
  toBlock:   50500,  ← 50,400블록 범위
})
```

대부분의 RPC 노드 (특히 공공 노드, Alchemy, Infura 무료 티어)는 한 번에 응답하는 블록 범위에 제한이 있다.

```
Alchemy:     최대 500~2000블록 (플랜에 따라 다름)
Infura:      최대 3500블록
Hardhat 로컬: 제한 없음 (개발용)
geth (자체): 기본 10000블록
```

제한을 초과하면:
```json
{
  "error": {
    "code": -32602,
    "message": "block range is too wide"
  }
}
```

CHUNK=1000으로 나누면:
```
50,400 블록 / 1000 = 51회 RPC 호출
각 호출: 1000블록 범위 → 제한 이내
```

---

## 2-3. CHUNK 스캔의 진행 흐름

```
from = 500, to = 503  (짧은 예시, 실제는 훨씬 클 수 있음)
CHUNK = 1000

─── 루프 1 ───────────────────────────────────
start = 500
end   = min(500 + 1000, 503) = 503
queryEvents(500, 503) → [이벤트 X, 이벤트 Y]
  _dispatch(이벤트 X)
  _dispatch(이벤트 Y)
setLastProcessedBlock(503)  ← 청크 완료마다 저장
start = 503 + 1 = 504

─── while 조건: 504 < 503 = false → 루프 종료 ───
```

실제로 10만 블록 복구가 필요한 경우:
```
from = 0, to = 100000
CHUNK = 1000

루프  1: queryEvents(0,     1000)   → setLastProcessedBlock(1000)
루프  2: queryEvents(1001,  2000)   → setLastProcessedBlock(2000)
루프  3: queryEvents(2001,  3000)   → setLastProcessedBlock(3000)
...
루프100: queryEvents(99001, 100000) → setLastProcessedBlock(100000)
```

**핵심 포인트**: `setLastProcessedBlock(end)`를 청크마다 호출한다.  
→ 복구 도중 서버가 다시 죽어도, 다시 시작하면 마지막 저장된 청크부터 이어서 복구한다.  
→ 처음부터 다시 할 필요 없다.

> **강사 멘트**: "1000블록씩 잘라서 청크마다 상태를 저장하는 것은 일종의 체크포인트입니다. 마치 긴 파일을 복사할 때 중간 진행상황을 저장해두면, 중단돼도 이어서 복사할 수 있는 것과 같습니다."

---

## 2-4. 반복 구조의 중첩 루프 — 왜 2중 루프인가

```typescript
for (const contract of this.contracts) {          // ← 컨트랙트별
  for (const eventName of contract.eventNames) {  // ← 이벤트 이름별
    // CHUNK 스캔
  }
}
```

이 구조는 여러 컨트랙트, 여러 이벤트를 감시할 때를 위한 것이다.

```
// 예: Phase 2에서 두 컨트랙트, 각각 다른 이벤트 감시
contracts = [
  {
    addr:       "0xKyoboNFT...",
    eventNames: ["Issued", "Burned"],    ← 두 이벤트
  },
  {
    addr:       "0xStablecoin...",
    eventNames: ["Minted", "Redeemed"], ← 두 이벤트
  },
]

루프 실행 순서:
  KyoboNFT   × Issued   → CHUNK 스캔
  KyoboNFT   × Burned   → CHUNK 스캔
  Stablecoin × Minted   → CHUNK 스캔
  Stablecoin × Redeemed → CHUNK 스캔
```

Phase 1 스켈레톤에서는 KyoboNFT의 Issued 하나뿐이다.  
Phase 2 이후 컨트랙트가 추가되면 `contracts` 배열에 추가하면 된다. `_recoverMissedEvents` 코드는 변경하지 않는다.

---

## 2-5. stateStore: 메모리 vs DB — 결정적 차이

> **강사 멘트**: "이것은 이 세션에서 가장 중요한 설계 질문입니다. 왜 lastProcessedBlock을 DB에 저장해야 하는가?"

```
─── 메모리에 저장하면 ───────────────────────────────────────────────────────
let lastBlock = 0;  // 전역 변수

[서버 시작]
  lastBlock = 0
  구독 시작

[블록 150: 이벤트 처리]
  lastBlock = 150

[서버 다운 (배포, 장애, OOM)]
  ← lastBlock = 150 사라짐

[서버 재시작]
  lastBlock = 0  ← 초기화됨
  블록 0부터 다시 구독
  블록 1~149: 이미 처리된 이벤트 재처리
  → IdempotencyGuard가 막아주긴 하지만
  → 불필요한 100만 블록 스캔 발생 가능
  → 최악의 경우: 이벤트가 없는 구간을 처음부터 전부 스캔
```

```
─── DB에 저장하면 ────────────────────────────────────────────────────────────
[서버 시작]
  getLastProcessedBlock() → DB에서 읽기 → 150

[서버 다운]
  DB는 살아있음

[서버 재시작]
  getLastProcessedBlock() → DB에서 읽기 → 150
  블록 151부터 복구 시작
  → 불필요한 스캔 없음
  → 정확한 구간만 복구
```

| | 메모리 | DB |
|---|---|---|
| 서버 재시작 후 복구 시작점 | 처음부터 | 마지막 처리 블록부터 |
| 복구 시간 | 비례: 운영 기간 전체 | 비례: 다운타임 동안만 |
| 구현 복잡도 | 단순 | 보통 |
| 데이터 안전성 | 없음 | 영구 보존 |

금융 시스템에서 메모리에 저장하는 것은 선택지가 아니다.

---

# 3부 — _dispatch()와 NFTIssuedHandler 내부 (25분)

## 3-1. _dispatch() — 라우팅 엔진

```typescript
// ChainEventListener.ts 95~101줄
private async _dispatch(
  event: { eventName: string; contractAddr: string; [key: string]: unknown }
): Promise<void> {

  const matched = this.handlers.filter(
    h => h.eventName === event.eventName &&
         (!h.contractAddr || h.contractAddr === event.contractAddr),
  );

  await Promise.all(matched.map(h => h.handle(event as never)));
}
```

한 줄씩 분해:

**필터링 조건**:
```typescript
h.eventName === event.eventName
// → 핸들러의 eventName과 이벤트의 eventName이 일치하는가?
// → NFTIssuedHandler.eventName = 'Issued'
// → event.eventName = 'Issued' → 일치 → 포함

!h.contractAddr || h.contractAddr === event.contractAddr
// → 핸들러에 contractAddr가 없거나(전체 감시),
//   있다면 이벤트의 contractAddr와 일치하는가?
// → NFTIssuedHandler.contractAddr = "0xe7f1..."
// → event.contractAddr = "0xe7f1..." → 일치 → 포함
```

**`Promise.all`의 의미**:
```typescript
await Promise.all(matched.map(h => h.handle(event as never)));
```

`matched`가 [핸들러A, 핸들러B]라면:
```
핸들러A.handle(event) ──┐
핸들러B.handle(event) ──┼── 동시 실행
                        └── 모두 완료될 때까지 대기
```

순서대로 실행(`for await`)하지 않는 이유: 핸들러들은 독립적이다.  
핸들러A가 Core Banking에 Webhook을 보내는 동안, 핸들러B는 감사 로그를 쓸 수 있다.  
이 둘을 기다리게 할 이유가 없다. 병렬로 실행하면 전체 처리 시간이 짧아진다.

> **강사 멘트**: "Promise.all은 '모두 동시에 시작하고, 가장 느린 것이 끝날 때까지 기다린다'는 의미입니다. 핸들러가 3개고 각각 100ms, 200ms, 150ms 걸린다면, 순차 실행은 450ms, Promise.all은 200ms입니다."

**`matched`가 0개인 경우**:
```typescript
Promise.all([])
// → 즉시 resolve ([])
// → 아무것도 하지 않음
```

감시하지 않는 이벤트가 우연히 들어와도 에러 없이 무시된다.

---

## 3-2. IEventHandler 인터페이스 — 개방-폐쇄 원칙

```typescript
// IEventHandler.ts
export interface IEventHandler {
  readonly eventName:    string;   // 어떤 이벤트를 처리하는가
  readonly contractAddr: string;   // 어떤 컨트랙트의 이벤트를 처리하는가

  handle(event: ChainEvent): Promise<void>;
  //     ↑ 멱등성 보장 필수 — 주석에 명시됨
}
```

이 인터페이스가 "개방-폐쇄 원칙"을 구현한다:

```
Phase 1: NFTIssuedHandler (Issued 이벤트)
Phase 2: StablecoinMintedHandler 추가 (Minted 이벤트)
Phase 3: STOTransferHandler 추가 (Transfer 이벤트)
```

새 핸들러를 추가할 때 `ChainEventListener` 코드는 전혀 바꾸지 않는다.  
`handlers` 배열에 새 인스턴스를 추가하기만 하면 된다.

```typescript
// 의존성 주입 (DI Container 또는 수동)
const listener = new ChainEventListener(
  adapter,
  [
    new NFTIssuedHandler(...),      // Phase 1
    new StablecoinMintedHandler(...), // Phase 2 추가
    new STOTransferHandler(...),     // Phase 3 추가
  ],
  contracts,
  stateStore,
);
```

---

## 3-3. NFTIssuedHandler.handle() — 4단계 처리

```typescript
// NFTIssuedHandler.ts
async handle(event: ChainEvent): Promise<void> {

  // Step 1: 멱등성 키 생성
  const idempotencyKey = `nft-issued:${event.txHash}:${event.logIndex}`;
  //                                    ↑ TX 해시           ↑ 같은 TX의 몇 번째 Log
  //    txHash만으로는 부족: mintBatch(100명) → 같은 TX에 100개 Log, 각각 logIndex 다름

  // Step 2: 멱등성 가드 실행
  const processed = await this.idempotency.run(idempotencyKey, async () => {

    // Step 3: args 추출
    const { to, tokenId, reason } = event.args as {
      to: string; tokenId: bigint; reason: string;
    };

    // Step 4: Retry 포함 Webhook 발송
    await this.retry.send({
      requestId: idempotencyKey,
      targetUrl: this.config.coreBankingWebhookUrl,
      payload: {
        eventType:   'NFT_ISSUED',
        to,
        tokenId:     tokenId.toString(),  // ← bigint → string (JSON 직렬화)
        reason,
        txHash:      event.txHash,
        blockNumber: event.blockNumber,
        issuedAt:    Date.now(),
      },
      secret: this.config.webhookSecret,
    });
  });

  // 중복 처리된 경우 로그
  if (!processed) {
    console.log(`[NFTIssuedHandler] duplicate skipped: ${idempotencyKey}`);
  }
}
```

---

## 3-4. IdempotencyGuard.run() — 중복 차단 메커니즘

```typescript
// IdempotencyGuard.ts
async run(key: string, fn: () => Promise<void>): Promise<boolean> {
  if (await this.store.exists(key)) return false;  // ← 이미 처리됨 → 건너뜀
  await fn();                                        // ← 처리 실행
  await this.store.mark(key, this.ttlSeconds);       // ← 처리됨 기록 (7일 TTL)
  return true;                                       // ← 새로 처리됨
}
```

이 세 줄이 중복 처리를 막는 원리:

```
[첫 번째 도착]
  exists("nft-issued:0xabc:0") → false (처음 봄)
  fn() 실행 → Core Banking Webhook 발송
  mark("nft-issued:0xabc:0", 604800)  ← 7일 TTL
  return true

[두 번째 도착: 네트워크 재시도, 재시작 후 재처리]
  exists("nft-issued:0xabc:0") → true (기록됨)
  return false
  ← fn() 실행 안 됨 → Core Banking에 중복 발송 없음
```

**TTL=7일의 의미**: 7일이 지난 키는 자동 삭제된다.  
7일 후 같은 키가 다시 도착하면 처리된다. (현실적으로 7일 후 같은 TX가 다시 올 이유 없음)

---

## 3-5. RetryHandler.send() — 지수 백오프 재시도

```typescript
// RetryHandler.ts
async send(event: OutboundEvent): Promise<void> {
  let attempt  = 0;
  let delayMs  = this.config.initialDelayMs;

  while (attempt < this.config.maxAttempts) {
    try {
      await this._post(event);  // ← HMAC 서명 + HTTP POST
      return;                   // ← 성공하면 즉시 반환
    } catch (err) {
      attempt++;
      if (attempt >= this.config.maxAttempts) {
        await this.dlq.push({ event, error: String(err), attempts: attempt });
        throw err;  // ← DLQ 저장 후 예외 전파
      }
      await this._sleep(Math.min(delayMs, this.config.maxDelayMs));
      delayMs *= this.config.backoffFactor;  // ← 지수 증가
    }
  }
}
```

**지수 백오프(Exponential Backoff)란**:

```
maxAttempts    = 5
initialDelayMs = 1000  (1초)
maxDelayMs     = 30000 (30초)
backoffFactor  = 2

시도 1: 실패 → 1초 대기
시도 2: 실패 → 2초 대기
시도 3: 실패 → 4초 대기
시도 4: 실패 → 8초 대기
시도 5: 실패 → DLQ 저장, 예외 발생
```

총 대기 시간: 1 + 2 + 4 + 8 = 15초 후 최종 실패

**왜 간격이 점점 늘어나는가**:  
Core Banking이 일시적으로 다운됐다면, 바로 재시도해봐야 또 실패한다.  
잠시 기다리면 Core Banking이 복구될 시간을 준다.  
모든 이벤트가 동시에 재시도하면 Core Banking에 폭발적 부하가 생긴다 (thundering herd).  
지수 백오프로 부하를 분산한다.

**DLQ(Dead Letter Queue)**:
```typescript
// DeadLetterQueue.ts
async push(item: { event, error, attempts }): Promise<void> {
  console.error('[DLQ] failed event:', JSON.stringify(item));
  // Phase 1: 로그 기록 (수동 재처리)
  // Phase 2+: Kafka DLQ 또는 SQS DLQ로 교체
}
```

DLQ에 들어간 이벤트는 운영자가 모니터링하다가 수동으로 재처리하거나,  
자동 DLQ 처리 워커가 나중에 재시도한다.

---

## 3-6. Webhook HMAC 서명 — 수신측 검증

```typescript
// RetryHandler._post()
private async _post(event: OutboundEvent): Promise<void> {
  const body      = JSON.stringify({ ...event.payload, requestId: event.requestId });
  const signature = await this._sign(body, event.secret);

  const res = await fetch(event.targetUrl, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'X-Kyobo-Signature': signature,  // ← HMAC-SHA256
      'X-Request-Id':      event.requestId,
    },
    body,
  });
}

private async _sign(body: string, secret: string): Promise<string> {
  const { createHmac } = await import('crypto');
  return createHmac('sha256', secret).update(body).digest('hex');
}
```

**Core Banking에서 검증하는 방법**:
```
수신한 body를 같은 secret으로 HMAC-SHA256 계산
→ 계산한 값 == X-Kyobo-Signature 헤더 값 이면 신뢰
→ 다르면 위조된 요청 → 거부
```

**X-Request-Id 헤더**: Core Banking도 이것으로 중복 수신을 막는다.  
같은 requestId가 두 번 오면 두 번째는 처리하지 않는다.  
→ 양쪽에서 이중으로 멱등성 보장.

---

# 실습 2 — ChainEventListener 직접 구동 + 재시작 복구 (55분)

## 준비 확인

S5 실습이 완료된 상태 가정:
```bash
# 로컬 노드 실행 중인지 확인
curl -s -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# 응답: {"result":"0x7",...}

# .env에 컨트랙트 주소 있는지 확인
cat .env | grep KYOBO_NFT
```

---

## Step 1 — stateStore 구현 (메모리 버전) (5분)

실습용 인메모리 stateStore를 만든다. 운영에서는 DB로 교체한다.

```bash
cat scripts/in-memory-state-store.ts
```

> 파일이 없으면 직접 작성:

```typescript
// scripts/in-memory-state-store.ts

/**
 * 실습용 인메모리 stateStore
 * 운영 환경에서는 DBStateStore로 교체
 * (DB에 last_processed_block 컬럼을 가진 chain_listener_state 테이블 사용)
 */
export class InMemoryStateStore {
  private lastBlock: number;

  constructor(initialBlock: number = 0) {
    this.lastBlock = initialBlock;
  }

  async getLastProcessedBlock(): Promise<number> {
    console.log(`[StateStore] getLastProcessedBlock → ${this.lastBlock}`);
    return this.lastBlock;
  }

  async setLastProcessedBlock(block: number): Promise<void> {
    this.lastBlock = block;
    console.log(`[StateStore] setLastProcessedBlock → ${block}`);
  }
}
```

---

## Step 2 — ChainEventListener 직접 구동 스크립트 작성 (15분)

```bash
cat scripts/run-listener.ts
```

> 파일이 없으면 직접 작성:

```typescript
// scripts/run-listener.ts
import { EVMAdapter }          from '../dmz/packages/chain-adapters/src/evm/EVMAdapter';
import { ChainEventListener }  from '../dmz/packages/event-engine/src/listener/ChainEventListener';
import { NFTIssuedHandler }    from '../dmz/packages/event-engine/src/handlers/NFTIssuedHandler';
import { IdempotencyGuard, InMemoryIdempotencyStore } from '../dmz/packages/event-engine/src/webhook/IdempotencyGuard';
import { RetryHandler, DeadLetterQueue } from '../dmz/packages/event-engine/src/webhook/RetryHandler';
import { InMemoryStateStore }  from './in-memory-state-store';
import * as dotenv from 'dotenv';
dotenv.config();

const NFT_ABI = [
  "event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason)"
];

async function main() {
  // 1. EVMAdapter 초기화
  const adapter = new EVMAdapter({
    rpcUrl:  process.env.EVM_RPC_URL  ?? 'http://localhost:8545',
    chainId: process.env.CHAIN_ID     ?? '31337',
  });

  // 2. stateStore 초기화 (마지막 처리 블록 = 0)
  const stateStore = new InMemoryStateStore(0);

  // 3. IdempotencyGuard 초기화
  const idempotencyGuard = new IdempotencyGuard(
    new InMemoryIdempotencyStore(),
    3600,  // 1시간 TTL (실습용, 운영은 7일)
  );

  // 4. RetryHandler 초기화
  const retryHandler = new RetryHandler(
    {
      maxAttempts:    3,
      initialDelayMs: 500,
      maxDelayMs:     5000,
      backoffFactor:  2,
    },
    new DeadLetterQueue(),
  );

  // 5. NFTIssuedHandler 초기화
  const nftHandler = new NFTIssuedHandler(
    process.env.KYOBO_NFT_PROXY_ADDR!,
    idempotencyGuard,
    retryHandler,
    {
      coreBankingWebhookUrl: 'http://localhost:9999/webhook',  // 실습용 더미 URL
      webhookSecret:          'test-secret',
    },
  );

  // 6. ChainEventListener 초기화
  const listener = new ChainEventListener(
    adapter,
    [nftHandler],                              // 핸들러 목록
    [
      {
        addr:       process.env.KYOBO_NFT_PROXY_ADDR!,
        abi:        NFT_ABI,
        eventNames: ['Issued'],
      },
    ],
    stateStore,
  );

  console.log('ChainEventListener 시작...');
  console.log('컨트랙트:', process.env.KYOBO_NFT_PROXY_ADDR);

  // 7. 시작
  await listener.start();
  console.log('리스닝 중... (Ctrl+C로 종료)\n');

  // 8. 종료 처리
  process.on('SIGINT', async () => {
    console.log('\n종료 중...');
    await listener.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

실행:
```bash
npx ts-node scripts/run-listener.ts
```

출력 (이벤트 없는 경우):
```
[StateStore] getLastProcessedBlock → 0
ChainEventListener 시작...
컨트랙트: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
리스닝 중... (Ctrl+C로 종료)

```

> **학습 포인트**: `_recoverMissedEvents(0, currentBlock)`이 실행된다. 블록 0부터 현재까지 스캔하는데, S5 실습에서 발행한 이벤트들이 여기서 복구되는 것을 볼 수 있다.

---

## Step 3 — 복구 시나리오 시뮬레이션 (20분)

**stateStore를 특정 블록으로 초기화해서 "서버가 그 시점에 다운됐다"를 시뮬레이션한다.**

```typescript
// InMemoryStateStore(4) → 블록 4에서 다운됐다고 가정
const stateStore = new InMemoryStateStore(4);  // ← 0 대신 4
```

S5 실습에서 블록 4~7에 Issued 이벤트 3개를 발행했다.

```bash
# scripts/run-listener.ts의 InMemoryStateStore(0) → InMemoryStateStore(4)로 수정 후
npx ts-node scripts/run-listener.ts
```

예상 출력:
```
[StateStore] getLastProcessedBlock → 4
ChainEventListener 시작...
컨트랙트: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512

[StateStore] setLastProcessedBlock → 7   ← _recoverMissedEvents 청크 완료

[NFTIssuedHandler] duplicate skipped: nft-issued:0xaaa...:0
← 이미 처리됐다면 스킵 / 아니라면 Webhook 시도 (localhost:9999 = ECONNREFUSED)

[StateStore] setLastProcessedBlock → 7
리스닝 중... (Ctrl+C로 종료)
```

> **강사 멘트**: "localhost:9999는 없는 서버라서 RetryHandler가 3번 재시도하다 DLQ에 넣습니다. 실제 Core Banking URL을 연결하면 정상 발송됩니다. 지금은 ChainEventListener가 '복구 구간을 스캔하고 핸들러를 호출한다'는 흐름을 확인하는 것이 목적입니다."

---

## Step 4 — 실시간 이벤트 + 구독 흐름 확인 (10분)

리스너를 켜둔 채로 터미널 4에서 NFT 발행:

```bash
# 터미널 4
cd blockchain
npx hardhat run scripts/test-issue.ts --network localhost
```

리스너(터미널 3) 예상 출력:
```
[NFTIssuedHandler] handle: nft-issued:0xnew...:0
[RetryHandler] POST http://localhost:9999/webhook → Error: connect ECONNREFUSED
[RetryHandler] retry 1/3 (500ms 대기)
[RetryHandler] POST http://localhost:9999/webhook → Error: connect ECONNREFUSED
[RetryHandler] retry 2/3 (1000ms 대기)
[RetryHandler] POST http://localhost:9999/webhook → Error: connect ECONNREFUSED
[DLQ] failed event: { requestId: "nft-issued:...", error: "...", attempts: 3 }
[StateStore] setLastProcessedBlock → 8
```

> **학습 포인트**: Webhook 발송 실패 → RetryHandler 3회 재시도 → DLQ 저장 → stateStore 갱신.  
> 이벤트 처리 자체는 완료됐다고 간주(stateStore 갱신). DLQ는 별도로 처리한다.

---

## Step 5 — 멱등성 동작 확인 (5분)

같은 이벤트를 다시 dispatch해보자. `_dispatch`를 직접 호출하는 것은 어렵지만, 리스너를 재시작하면 된다.

```bash
# 리스너 종료 (Ctrl+C)
# stateStore를 재시작 직전 블록으로 되돌려 같은 이벤트를 다시 처리하게 함
# → InMemoryStateStore(4)로 바꾸고 재시작
npx ts-node scripts/run-listener.ts
```

예상 출력:
```
[StateStore] getLastProcessedBlock → 4
_recoverMissedEvents 시작

[NFTIssuedHandler] duplicate skipped: nft-issued:0xaaa...:0  ← 7일 TTL 내라면 스킵
[NFTIssuedHandler] duplicate skipped: nft-issued:0xbbb...:0
[NFTIssuedHandler] duplicate skipped: nft-issued:0xccc...:0
```

> **InMemoryIdempotencyStore**는 프로세스 종료 시 초기화된다. 같은 프로세스 안에서만 유효하다.  
> 운영에서는 Redis 또는 DB를 쓰기 때문에 프로세스가 종료돼도 멱등성 기록이 남는다.  
> 이 실습에서는 TTL이 짧거나(1시간), 프로세스를 재시작했다면 멱등성 확인이 안 될 수 있다.

---

# 핵심 정리

| 개념 | 요점 |
|---|---|
| `start()` | stateStore 조회 → missed event 복구 → 실시간 구독. 중복 실행 방지(`running` 플래그). |
| stateStore | 서버 재시작에도 보존되는 영구 저장소 (DB). 메모리면 재시작 시 처음부터 스캔. |
| `_recoverMissedEvents()` | CHUNK=1000블록 단위 반복 스캔. 청크마다 stateStore 갱신 → 복구 중 죽어도 이어서 복구. |
| `_dispatch()` | `eventName + contractAddr` 조합으로 핸들러 필터링. `Promise.all`로 병렬 실행. |
| IEventHandler | 새 이벤트 추가 = 새 핸들러 추가. ChainEventListener 수정 없음. |
| 처리 후 기록 | dispatch() 성공 후 setLastProcessedBlock(). 실패 시 재시작에서 재처리(멱등성 필요). |
| IdempotencyGuard | `txHash:logIndex`를 키로 중복 처리 방지. 7일 TTL. `run()` = check → execute → mark. |
| RetryHandler | 지수 백오프(×2) 재시도. 최종 실패 → DLQ. 수신측도 `X-Request-Id`로 중복 검증. |
| HMAC 서명 | `createHmac('sha256', secret)`. 수신측이 같은 방법으로 검증 → 위조 요청 차단. |
| DLQ | 최종 실패 이벤트 보관. Phase 1=로그+DB, Phase 2+=Kafka/SQS. |

---

# 예상 질문 & 답변

**Q: `_recoverMissedEvents`에서 이벤트 dispatch가 실패하면 어떻게 됩니까?**

A: 예외가 전파된다. `_recoverMissedEvents` 전체가 중단된다. `start()`도 실패한다.  
현재 스켈레톤 코드는 이 케이스를 명시적으로 처리하지 않는다.  
운영 코드에서는 개별 이벤트 처리 실패를 catch해서 로그를 남기고 계속 진행하거나,  
DLQ에 넣고 다음 이벤트로 넘어가는 것이 일반적이다.  
핸들러 안의 RetryHandler가 재시도하므로, 임시 네트워크 오류는 대부분 커버된다.

---

**Q: `Promise.all`로 병렬 실행하면, 핸들러 하나가 실패했을 때 다른 핸들러도 영향받나요?**

A: `Promise.all`은 하나라도 reject되면 전체가 reject된다.  
현재 구현에서는 NFTIssuedHandler가 실패하면 다른 핸들러(있다면)도 영향을 받는다.  
개선 방법: `Promise.allSettled`를 사용하면 각 핸들러의 성공/실패를 독립적으로 처리할 수 있다.

```typescript
// 개선된 _dispatch
const results = await Promise.allSettled(matched.map(h => h.handle(event as never)));
results
  .filter(r => r.status === 'rejected')
  .forEach(r => console.error('[dispatch] handler failed:', (r as PromiseRejectedResult).reason));
```

스켈레톤에서 `Promise.all`을 쓴 것은 단순함을 위해서다. 핸들러가 하나뿐이기도 하다.

---

**Q: stateStore를 Redis로 구현하면 어떻게 됩니까?**

A: 인터페이스가 동일하므로 교체만 하면 된다.

```typescript
// RedisStateStore 구현 예시
class RedisStateStore {
  constructor(private redis: Redis) {}

  async getLastProcessedBlock(): Promise<number> {
    const val = await this.redis.get('chain:last_processed_block');
    return val ? parseInt(val, 10) : 0;
  }

  async setLastProcessedBlock(block: number): Promise<void> {
    await this.redis.set('chain:last_processed_block', block.toString());
  }
}

// ChainEventListener 생성자에서 교체
const listener = new ChainEventListener(adapter, handlers, contracts, new RedisStateStore(redis));
```

`ChainEventListener` 코드는 한 줄도 바꾸지 않는다. 이것이 인터페이스 기반 설계의 장점이다.

---

**Q: 서버가 여러 인스턴스로 실행될 때(수평 확장) 같은 이벤트를 중복 처리하지 않는가?**

A: 현재 스켈레톤은 단일 인스턴스를 가정한다.  
여러 인스턴스가 동시에 `subscribeEvents`를 구독하면 같은 이벤트가 여러 번 dispatch된다.  
IdempotencyGuard가 Redis 기반이면 이 중복도 막는다 (공유된 Redis에서 키 확인).  
stateStore도 공유가 필요하다.  
이것이 Phase 2+에서 Redis Cluster 기반 멱등성 가드를 쓰는 이유다.

---

**Q: CHUNK가 1000인데 이 값은 어떻게 결정합니까?**

A: RPC 노드의 `eth_getLogs` 블록 범위 제한보다 작게 설정한다.  
Alchemy 무료 티어 기준 2000, Infura 기준 3500이 상한이지만,  
여유 있게 1000으로 설정하는 것이 일반적이다.  
노드가 바뀌거나 플랜이 달라지면 조정할 수 있다.  
설정 파일로 뽑는 것이 좋은 습관이다.

```typescript
// 환경변수로 설정
const CHUNK = parseInt(process.env.EVENT_SCAN_CHUNK ?? '1000', 10);
```

---

**Q: Webhook의 `issuedAt: Date.now()`가 실제 NFT 발행 시각이 아니라 처리 시각인데 문제없나요?**

A: 정확한 발행 시각은 `event.blockNumber`에서 알 수 있다.  
블록 번호를 `eth_getBlockByNumber`로 조회하면 `timestamp`(Unix seconds)를 얻는다.  
`issuedAt: Date.now()`는 "이벤트가 처리된 서버 시각"이다.  
Core Banking이 "NFT 발행 완료 시각"을 정확히 기록해야 한다면, `blockNumber`를 기준으로 블록 타임스탬프를 별도로 조회해야 한다.  
스켈레톤에서는 단순화를 위해 처리 시각을 사용한다.

---

# 다음 세션 예고 (S7)

S7에서는 `NFTIssuedHandler`가 Core Banking에 보내는 Webhook을 **Core Banking 입장에서 받는 쪽**을 구현한다.

- Webhook 수신 엔드포인트: `POST /webhook/nft-issued`
- HMAC 서명 검증: `X-Kyobo-Signature` 헤더 검증
- 멱등성: `X-Request-Id`로 중복 수신 차단
- 원장 기록: `LedgerService.record()`
- 응답 패턴: 202 Accepted (비동기 처리) vs 200 OK (동기 처리)

그리고 전체 파이프라인을 E2E로 테스트한다:  
`NFT 발행 트랜잭션 → 이벤트 수신 → Webhook → Core Banking 원장 기록 → 확인`

---

# 참조 파일

| 파일 | 내용 |
|---|---|
| `dmz/packages/event-engine/src/listener/ChainEventListener.ts` | `start`, `stop`, `_recoverMissedEvents`, `_dispatch` |
| `dmz/packages/event-engine/src/interfaces/IEventHandler.ts` | 핸들러 인터페이스 (eventName, contractAddr, handle) |
| `dmz/packages/event-engine/src/handlers/NFTIssuedHandler.ts` | Issued 이벤트 → Core Banking Webhook |
| `dmz/packages/event-engine/src/webhook/IdempotencyGuard.ts` | 중복 처리 방지, InMemoryIdempotencyStore |
| `dmz/packages/event-engine/src/webhook/RetryHandler.ts` | 지수 백오프, DLQ |
| `scripts/run-listener.ts` | 실습 2 구동 스크립트 |
| `scripts/in-memory-state-store.ts` | 실습용 stateStore |
| `docs/adr/004-event-driven-architecture.md` | 설계 결정 근거 |
