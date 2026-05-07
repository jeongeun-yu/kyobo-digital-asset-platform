# M2 S9 — 이벤트 소비자 처리 순서 불변 규칙과 At-least-once 설계 원리

> Block B — DMZ 이벤트 파이프라인 · M2 S9 · 강의 55분  
> 대상: `dmz/packages/event-engine/src/dmz/ConsumerGroupWorker.ts`

---

## 0. 이론 도입 — "두 저장소 문제"

### 0-1. 핵심 질문: 처리 완료를 어떻게 증명하는가?

```
메시지 처리의 두 가지 완료 확인:

  저장소 A (Redis):  PEL에서 제거 (XACK)
                    = "이 메시지는 내가 책임지고 처리했다"
                    
  저장소 B (DB):    user_nft_holdings +1 커밋
                    = "실제 비즈니스 처리가 완료됐다"

  문제: 두 저장소가 독립적이다
  
  ┌──────────────────────────────────────────────────────┐
  │  이상적 세계 (존재하지 않음):                         │
  │                                                       │
  │  DB 커밋 + Redis XACK                                │
  │  → 하나의 원자적 트랜잭션으로 묶임                   │
  │  → 둘 다 성공 or 둘 다 실패 (Exactly-once)           │
  └──────────────────────────────────────────────────────┘
  
  ┌──────────────────────────────────────────────────────┐
  │  실제 세계:                                           │
  │                                                       │
  │  DB 커밋 ─────► 성공                                │
  │  [crash!]                                             │
  │  Redis XACK ──► 영영 실행 안 됨                      │
  │                                                       │
  │  OR                                                   │
  │                                                       │
  │  Redis XACK ──► 성공 (메시지 PEL에서 사라짐)         │
  │  [crash!]                                             │
  │  DB 커밋 ─────► 영영 실행 안 됨 (데이터 유실)        │
  └──────────────────────────────────────────────────────┘
```

**왜 두 저장소를 하나의 트랜잭션으로 묶을 수 없는가:**

```
2PC(Two-Phase Commit):
  Redis가 XA 프로토콜을 지원하지 않음
  → 분산 트랜잭션 코디네이터 불가능
  → 구현 복잡도 폭발 + 성능 저하 + 더 어려운 장애 복구
  
결론: 두 저장소 중 하나가 반드시 "뒤처지는 순간"이 존재한다
선택: 어느 쪽을 뒤처지게 할 것인가? → 설계의 핵심
```

---

### 0-2. 비유 — 식당 계산과 영수증

```
시나리오: 손님이 식사 후 카드로 결제한다.

방법 1: 영수증 먼저, 카드 승인 나중
  영수증 발행 → 카드 단말기 오류 → 카드 승인 실패
  → 영수증은 있는데 돈은 안 빠져나감
  → 식당 손해 (= XACK 먼저, DB 처리 나중 → 데이터 유실)

방법 2: 카드 승인 먼저, 영수증 나중
  카드 승인 → 영수증 프린터 오류 → 영수증 없음
  → 손님이 재요청하면 영수증 재발행 가능 (카드 내역이 증거)
  → 최악이어도 영수증 중복 발행 → 손님에게 확인 (= 멱등성으로 중복 차단)
  
결론: 카드 승인(DB 커밋) 먼저, 영수증(XACK) 나중이 안전하다
```

---

### 0-3. 크래시 지점별 결과 — 전체 흐름 다이어그램

```
메시지 수신 (XREADGROUP)
      │
      │  PEL 등록
      ▼
┌─────────────────────┐
│  Step 1: 멱등성 확인 │  ← 크래시 A: 재시작 → 재수신 → 멱등성 통과 → 재처리 가능
└─────────────────────┘
      │
      ▼
┌─────────────────────┐
│  Step 2: DB 트랜잭션 │  ← 크래시 B: 재시작 → 재수신 → 멱등성 블락 → XACK만 → 안전
└─────────────────────┘
      │ (트랜잭션 커밋)
      ▼
┌─────────────────────┐
│  Step 3: XACK        │  ← 크래시 C: 재시작 → 재수신 → 멱등성 블락 → XACK만 → 안전
└─────────────────────┘
      │
      ▼
    완료


크래시 A 결과:
  DB: 변경 없음 (처리 안 됨)
  PEL: 메시지 존재 (XACK 없음)
  → 재수신 → 정상 처리 → At-least-once ✅

크래시 B 결과:
  DB: 변경 없음 (트랜잭션 롤백)
  PEL: 메시지 존재 (XACK 없음)
  → 재수신 → 멱등성: 미처리 → 재처리 → At-least-once ✅

크래시 C 결과:
  DB: 변경 완료 (커밋됨)
  PEL: 메시지 존재 (XACK 실패)
  → 재수신 → 멱등성: 이미처리 → XACK만 → At-least-once ✅ (중복 없음)

모든 크래시 지점에서 정합성 유지 = At-least-once + 멱등성의 힘
```

---

## 1. Exactly-once는 왜 불가능한가

분산 시스템에서 DB 커밋과 Redis XACK는 **두 개의 독립된 저장소**다.  
두 연산을 하나의 트랜잭션으로 묶는 2PC(Two-Phase Commit)는:

- Redis가 XA 프로토콜을 지원하지 않음
- 구현 복잡도 급상승 → 장애 복구가 더 어려워짐
- 성능 저하 (코디네이터 병목)

결론: **At-least-once(최소 1회 보장) + 멱등성**이 현실적 해답이다.

```
Exactly-once = 이상
At-least-once + 멱등성 = 현실
```

### DB 커밋 vs Redis XACK 차이

| | DB COMMIT | Redis XACK |
|---|---|---|
| **확정 대상** | 데이터 변경 (insert/update/delete) | 메시지 처리 완료 표시 |
| **묻는 질문** | "이 데이터 변경을 영속화할까?" | "이 메시지 책임을 내가 다 졌나?" |
| **위치** | DB 트랜잭션의 종결자 | 큐 시스템의 영수증 |

**같은 점:** 둘 다 "확정"하는 동작  
**다른 점:** 무엇을 확정하는지가 완전히 다름

## 2. 잘못된 처리 순서 — 왜 순서가 중요한가

**케이스 1: XACK → DB 처리 (치명적)**

```
XREADGROUP → PEL 소유 취득
     ↓
XACK         ← PEL에서 제거 (처리 완료 선언)
     ↓
DB 처리 실패 ← 여기서 장애
     ↓
재시작해도 메시지 없음 → 영구 유실
```

`XACK`는 "처리를 완료했다"는 선언이다.  
처리 전에 ACK하면 실패해도 재수신할 방법이 없다.

**케이스 2: DB 커밋 → XACK (안전하지만 중복 가능)**

```
XREADGROUP → PEL 소유 취득
     ↓
DB 커밋 성공
     ↓
XACK 실패 (네트워크 순단)
     ↓
재시작 → PEL에서 재수신
     ↓
멱등성 없으면 → holdings +2 (중복 발행 🚨)
```

DB 커밋 후 XACK 실패는 복구 가능하다 — **단, 멱등성이 있을 때만**.

## 3. 올바른 처리 순서 4단계 (불변 규칙)

```
단계 1: 멱등성 확인  → 이미 처리됐으면 즉시 XACK + 종료
단계 2: DB 트랜잭션  → 원장 업데이트, 상태 전이 등 실제 처리
단계 3: 트랜잭션 커밋 → 원자적 완료
단계 4: XACK         → PEL 제거 = "처리 완료" 선언
```

각 단계의 이유:

| 단계 | 왜 이 위치인가 |
|------|--------------|
| 멱등성 먼저 | 중복 수신 시 DB 접근 없이 즉시 처리 차단 |
| XACK 마지막 | ACK 전 장애 → PEL 재수신 가능 → 멱등성이 중복 차단 |
| DB 트랜잭션 원자성 | 원장 + 상태 전이 중 장애 시 전체 롤백 |

**XACK 실패 케이스 대응 흐름:**

```
재시작 → XREADGROUP/XAUTOCLAIM으로 PEL 재수신
     ↓
멱등성 체크: 이미 DB 커밋됨 감지
     ↓
XACK만 재실행 (DB 처리 없이)
```

이 흐름이 At-least-once를 안전하게 만드는 핵심이다.

## 3-1. 코드로 보는 4단계 불변 규칙

```typescript
// ConsumerGroupWorker._handleWithRetry() — At-least-once 4단계의 실제 구현

private async _handleWithRetry(msg: StreamMessage): Promise<void> {
  const requestId  = msg.fields['requestId'] ?? msg.id;
  const retryCount = parseInt(msg.fields['_retryCount'] ?? '0', 10);

  // ─── 단계 1: 멱등성 확인 ───────────────────────────────────────────
  // processor.process() 내부에서 IdempotencyGuard.run() 호출
  // 이미 처리됐으면 run()이 callback을 건너뜀 (XACK는 여전히 호출)

  // ─── 단계 2+3: DB 트랜잭션 + 커밋 ───────────────────────────────────
  // processor.process(msg) 내부:
  //   await db.transaction(async trx => {
  //     await trx('user_nft_holdings').insert(...).onConflict().merge(...);
  //     // → 트랜잭션 커밋
  //   });
  try {
    await Promise.all(this.processors
      .filter(p => p.eventTypes.includes(msg.fields['eventType'] ?? ''))
      .map(p => p.process(msg)));

    // ─── 단계 4: XACK (처리 완료 선언) ──────────────────────────────────
    // DB 커밋 성공 확인 후에 XACK
    await this.redis.xack(this.config.streamKey, this.config.groupName, msg.id);
    //                ↑ 절대 불변 규칙: XACK는 항상 마지막

  } catch (err) {
    // DB 실패 → XACK 안 함 → PEL 잔류 → 재시도
    msg.fields['_retryCount'] = String(retryCount + 1);
  }
}
```

**각 단계가 위반됐을 때 일어나는 일:**

```
단계 1 생략 (멱등성 없음):
  DB 커밋 → XACK → 재수신 → DB 커밋 → XACK → ...
  → user_nft_holdings: amount = 2, 3, 4, ... (중복 발행)
  → NFT 이중 지급 = 금융 사고

단계 4가 단계 2보다 먼저 (XACK 선행):
  XACK → DB 커밋 실패 → PEL 없음 → 재수신 없음
  → 원장 업데이트 누락 → 블록체인에는 NFT 있는데 원장에 없음
  → 회계 불일치 = 감사 실패
```

---

## 4. Consumer 수평 확장 시 안전성

```
Consumer-1, Consumer-2, Consumer-3
    ↓ 같은 Consumer Group
Redis가 메시지 분배 (XREADGROUP: 먼저 호출한 쪽이 소유)
    ↓
각 Consumer는 독립적으로 멱등성 체크
    ↓
같은 메시지를 두 Consumer가 받아도 → 한 번만 처리됨
```

> 멱등성 키: `txHash + logIndex` (온체인) 또는 `requestId` (Webhook)  
> DB: `processed_events(tx_hash, log_index) UNIQUE` + `ON CONFLICT DO NOTHING`

---

# 실습 (30분)

실습 파일: `exercises/S09_atleastonce.ts` / 답안: `S09_atleastonce.answer.ts`

```bash
# dmz/packages/event-engine 폴더에서
npx ts-node src/exercises/S09_atleastonce.ts
```

**Part 1** — 멱등성 없는 Naive Processor 실행: 동일 메시지 2회 → 원장 +2 (버그) 확인  
**Part 2** — TODO: `IdempotentNftProcessor` 구현

---

## 실습 스켈레톤 (Part 2)

```typescript
// S09_atleastonce.ts — Part 2 스켈레톤

export class IdempotentNftProcessor implements EventProcessor {
  // TODO 1: eventTypes 선언 — NFT_ISSUED 이벤트만 처리

  private ledger = new InMemoryLedger();

  // TODO 2: 중복 처리 방지를 위한 Set 선언
  //         Set은 같은 값을 두 번 추가해도 한 번만 저장되는 자료구조

  async process(message: StreamMessage): Promise<void> {
    const requestId = message.fields['requestId'] ?? message.id;
    const payload   = JSON.parse(message.fields['payload'] ?? '{}');

    // TODO 3: requestId가 이미 처리됐으면 return (중복 차단)

    // TODO 4: 원장에 NFT 적립

    // TODO 5: processedIds에 requestId 추가 (이 requestId 완료 기록)
  }
}
```

---

## 구현 힌트

```
TODO 1:
  readonly eventTypes = ['NFT_ISSUED'];
  → EventProcessor 인터페이스의 eventTypes 필드. string[] 타입.

TODO 2:
  private readonly processedIds = new Set<string>();
  → Set<string>: 문자열 집합. has(), add(), delete() 제공.
  → new Set<string>(): 빈 집합으로 초기화.

TODO 3:
  if (this.processedIds.has(requestId)) return;
  → Set.has(value): 값이 있으면 true
  → return으로 즉시 종료 = 중복 처리 차단

TODO 4:
  await this.ledger.creditNFT(payload.to, payload.tokenId);
  → payload 구조: { to: '0xABCD', tokenId: '42', ... }
  → creditNFT는 async 함수이므로 await 필수

TODO 5:
  this.processedIds.add(requestId);
  → 처리 완료 후 기록 (중요: 처리 전이 아닌 처리 후에 추가)
  → 처리 전에 add하면 처리 실패 시에도 중복 처리로 간주 → 이벤트 유실
```

---

## 답안

```typescript
export class IdempotentNftProcessor implements EventProcessor {
  // TODO 1 답안
  readonly eventTypes = ['NFT_ISSUED'];

  private ledger = new InMemoryLedger();

  // TODO 2 답안
  private readonly processedIds = new Set<string>();

  async process(message: StreamMessage): Promise<void> {
    const requestId = message.fields['requestId'] ?? message.id;
    const payload   = JSON.parse(message.fields['payload'] ?? '{}');

    // TODO 3 답안
    if (this.processedIds.has(requestId)) {
      console.log(`[IdempotentNftProcessor] skip (already processed): ${requestId}`);
      return;
    }

    // TODO 4 답안
    await this.ledger.creditNFT(payload.to, payload.tokenId);
    console.log(`[IdempotentNftProcessor] credited NFT tokenId=${payload.tokenId} to ${payload.to}`);

    // TODO 5 답안
    this.processedIds.add(requestId);
  }
}
```

---

## 실습 시나리오와 기대 출력

### Part 1: 버그 재현 (멱등성 없음)

```typescript
// 동일 메시지를 2번 처리
const msg: StreamMessage = {
  id: '1714000001000-0',
  fields: {
    eventType: 'NFT_ISSUED',
    payload:   JSON.stringify({ to: '0xABCD', tokenId: '42' }),
    requestId: 'req-001',
  },
};

const naiveProcessor = new NaiveNftProcessor();
await naiveProcessor.process(msg);  // → ledger: { '0xABCD:42': 1 }
await naiveProcessor.process(msg);  // → ledger: { '0xABCD:42': 2 }  ← 중복!
```

**기대 출력:**
```
[NaiveProcessor] credited NFT tokenId=42 to 0xABCD (balance: 1)
[NaiveProcessor] credited NFT tokenId=42 to 0xABCD (balance: 2)
❌ 중복 발행! balance=2, expected=1
```

### Part 2: 멱등성 적용 후

```typescript
const idempotentProcessor = new IdempotentNftProcessor();
await idempotentProcessor.process(msg);  // → 처리 + processedIds.add('req-001')
await idempotentProcessor.process(msg);  // → processedIds.has('req-001') = true → skip
```

**기대 출력:**
```
[IdempotentNftProcessor] credited NFT tokenId=42 to 0xABCD
[IdempotentNftProcessor] skip (already processed): req-001
✅ 정상: balance=1
```

---

## 주의: 이 실습의 processedIds는 메모리 기반

```
현재 구현의 한계:
  processedIds = new Set<string>()
  → 프로세스 재시작 시 초기화됨
  → Consumer 2개 실행 시 각자 별도 Set → 중복 방지 불가

실무 해결 방법:
  1. DB unique constraint + ON CONFLICT DO NOTHING
     INSERT INTO processed_events (request_id, ...) ON CONFLICT DO NOTHING
     → DB가 원자적으로 중복 차단

  2. Redis SET
     SETNX processed:{requestId} 1 EX 86400   (24시간 TTL)
     → 여러 Consumer 간 공유 가능, 분산 환경 안전

  3. IdempotencyGuard (이 코드베이스의 구현체)
     → S12 E2E 실습에서 RedisIdempotencyStore와 연결
```

---

**완료 기준:**
- [ ] Part 1 실행 시 `❌ 중복 발행!` 출력 확인 (버그 재현)
- [ ] Part 2 TODO 1~5 구현 후 `✅ 정상` 출력 확인
- [ ] XACK 순서: process 완료 후 Worker가 자동 호출됨을 출력에서 확인
- [ ] processedIds가 메모리 기반임을 이해 + 실무 해법 설명 가능
