# M2 S12 — Finalized 블록 기준 처리와 파이프라인 장애 복원력 검증

> Block B — DMZ 이벤트 파이프라인 · M2 S12 · 강의 55분  
> 대상: `dmz/packages/event-engine/src/dmz/ConsumerGroupWorker.ts`, `dmz/packages/event-engine/src/dmz/DLQHandler.ts`, `dmz/packages/event-engine/src/processors/NFTIssuedProcessor.ts`

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
VASP (외부) → WebhookServer(DMZ)
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
M2 DMZ 이벤트 파이프라인의 신뢰성 3원칙:

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

**다음 모듈 (M3 S13~S17):**  
온체인 어댑터 계층 — EVMAdapter, ChainEventListener, TxStateMachineService  
오프체인 처리가 끝났으니 이제 온체인에서 이벤트가 어떻게 올라오는지 배운다.
