# M2 S9 — EventConsumer 구현과 멱등 처리 통합 검증

> Block B — DMZ 이벤트 파이프라인 · M2 S9 · 강의 55분  
> 대상: `dmz/packages/event-engine/src/dmz/ConsumerGroupWorker.ts`

---

## 1. ConsumerGroupWorker 전체 구조

```
F:\Workplace\kyobo-digital-asset-platform\
└── dmz/packages/event-engine/src/dmz/
    ├── ConsumerGroupWorker.ts   ← 이번 주요 대상
    ├── DLQHandler.ts
    └── RedisStreamPublisher.ts
```

**ConsumerGroupWorker 의존 관계:**

```
ConsumerGroupWorker
    ├── RedisConsumerClient  — XREADGROUP, XACK, XAUTOCLAIM
    ├── EventProcessor[]     — eventType별 처리 로직
    └── DLQHandler           — 3회 실패 메시지 격리
```

**EventProcessor 인터페이스:**

```typescript
// ConsumerGroupWorker.ts:54
export interface EventProcessor {
  eventTypes: string[];
  process(message: StreamMessage): Promise<void>;
}
```

`eventTypes`에 선언된 이벤트 타입만 처리한다.  
`process()`는 **반드시 멱등성을 보장**해야 한다 (At-least-once 환경).

## 2. 실행 루프 — start()

```typescript
// ConsumerGroupWorker.ts:88
async start(): Promise<void> {
  this.running = true;

  while (this.running) {
    try {
      // 순서 중요: PEL 재수신 먼저 → 새 메시지 처리
      await this._reclaimPending();   // 미처리(PEL) 재수신
      await this._processNew();       // 새 메시지
    } catch (err) {
      console.error('[ConsumerGroupWorker] error:', err);
      await this._sleep(1000);        // 오류 시 1초 대기 후 재시도
    }
  }
}
```

왜 `_reclaimPending()`을 먼저 호출하는가?  
→ 재시작 직후 PEL에 처리 안 된 메시지가 남아 있을 수 있다.  
→ 새 메시지보다 미처리 메시지를 먼저 처리하는 것이 일관성 측면에서 유리.

## 3. 새 메시지 처리 — _processNew()

```typescript
// ConsumerGroupWorker.ts:111
private async _processNew(): Promise<void> {
  const result = await this.redis.xreadgroup(
    this.config.groupName,     // "issuer-consumers"
    this.config.consumerId,    // "consumer-1"
    [{ key: this.config.streamKey, id: '>' }],  // '>' = 새 메시지만
    this.config.batchSize,     // COUNT 10
    this.config.blockMs,       // BLOCK 5000 (5초 대기)
  );

  for (const { messages } of result ?? []) {
    for (const msg of messages) {
      await this._handleWithRetry(msg);
    }
  }
}
```

`id: '>'` 의미: **이 Consumer가 아직 한 번도 받지 않은 새 메시지만**.  
`id: '0-0'`으로 바꾸면 PEL에 있는 이전 메시지부터 재수신한다 (XAUTOCLAIM과 다른 방식).

## 4. PEL 재수신 — _reclaimPending()

```typescript
// ConsumerGroupWorker.ts:143
private async _reclaimPending(): Promise<void> {
  const { messages } = await this.redis.xautoclaim(
    this.config.streamKey,    // "kyobo:events"
    this.config.groupName,    // "issuer-consumers"
    this.config.consumerId,   // "consumer-1" (재수신 받는 쪽)
    this.config.minIdleMs,    // 30_000ms = 30초 이상 idle인 것만
    '0-0',                    // 스트림 처음부터 검색
    this.config.batchSize,
  );

  for (const msg of messages) {
    await this._handleWithRetry(msg);
  }
}
```

**XAUTOCLAIM 동작 원리:**

```
Consumer-1이 메시지 소유 (PEL)
     ↓
Consumer-1 크래시
     ↓
minIdleMs(30초) 경과
     ↓
Consumer-2가 XAUTOCLAIM 호출
     ↓
PEL 소유권: Consumer-1 → Consumer-2 이전
     ↓
Consumer-2가 정상 처리 + XACK
```

## 5. 처리 + 재시도 — _handleWithRetry()

```typescript
// ConsumerGroupWorker.ts:164
private async _handleWithRetry(msg: StreamMessage): Promise<void> {
  const eventType  = msg.fields['eventType'] ?? '';
  const retryCount = parseInt(msg.fields['_retryCount'] ?? '0', 10);

  // 3회 초과 → DLQ
  if (retryCount >= this.MAX_RETRIES) {
    await this.dlq.move({
      messageId: msg.id,
      streamKey: this.config.streamKey,
      groupName: this.config.groupName,
      event:     msg.fields,
      reason:    `max retries (${this.MAX_RETRIES}) exceeded`,
      failedAt:  new Date(),
    });
    await this.redis.xack(this.config.streamKey, this.config.groupName, msg.id);
    return;
  }

  const processors = this.processors.filter(p => p.eventTypes.includes(eventType));

  if (processors.length === 0) {
    // 처리자 없음 → ACK (무시)
    await this.redis.xack(this.config.streamKey, this.config.groupName, msg.id);
    return;
  }

  try {
    await Promise.all(processors.map(p => p.process(msg)));
    // 성공 → ACK
    await this.redis.xack(this.config.streamKey, this.config.groupName, msg.id);
  } catch (err) {
    // 실패 → retryCount 증가, XACK 안 함 → PEL 잔류
    msg.fields['_retryCount'] = String(retryCount + 1);
    console.error(`[ConsumerGroupWorker] message ${msg.id} failed (attempt ${retryCount + 1}):`, err);
  }
}
```

**핵심 설계 포인트:**

| 경우 | 동작 |
|------|------|
| 처리 성공 | XACK → PEL 제거 |
| 처리 실패 (3회 미만) | XACK 안 함 → PEL 잔류 → 다음 _reclaimPending에서 재수신 |
| 처리 실패 (3회 이상) | DLQ 이동 + XACK |
| eventType 처리자 없음 | XACK (무시) |

## 6. 실습 — NFTIssuedProcessor 구현

```typescript
// 실습: EventProcessor 구현체 — NFT 발행 이벤트 처리
import type { EventProcessor, StreamMessage } from './ConsumerGroupWorker';

export class NFTIssuedProcessor implements EventProcessor {
  readonly eventTypes = ['NFTIssued'];

  constructor(
    private readonly ledgerService: LedgerService,
    private readonly idempotencyGuard: IdempotencyGuard,
  ) {}

  async process(message: StreamMessage): Promise<void> {
    const event = JSON.parse(message.fields['payload'] ?? '{}') as NFTIssuedEvent;

    // 멱등성 키: txHash + logIndex
    const idempotencyKey = `NFTIssued:${event.txHash}:${event.logIndex}`;

    // TODO: idempotencyGuard.run()으로 중복 처리 차단 + DB 트랜잭션
    await this.idempotencyGuard.run(idempotencyKey, async () => {
      await this.ledgerService.db.transaction(async (trx) => {
        // TODO: MintRequest 상태 → CONFIRMED
        // TODO: user_nft_holdings +1
      });
    });
  }
}
```

```typescript
// 답안
async process(message: StreamMessage): Promise<void> {
  const event = JSON.parse(message.fields['payload'] ?? '{}') as NFTIssuedEvent;
  const idempotencyKey = `NFTIssued:${event.txHash}:${event.logIndex}`;

  await this.idempotencyGuard.run(idempotencyKey, async () => {
    await this.ledgerService.db.transaction(async (trx) => {
      await trx('mint_requests')
        .where({ request_id: event.requestId })
        .update({ status: 'CONFIRMED', confirmed_at: new Date() });

      await trx('user_nft_holdings')
        .insert({ user_id: event.to, token_id: event.tokenId, amount: 1 })
        .onConflict(['user_id', 'token_id'])
        .merge({ amount: trx.raw('amount + 1') });
    });
  });
}
```

**완료 기준:**
- [ ] 동일 txHash+logIndex 이벤트 2회 → `user_nft_holdings.amount = 1` (1회만 반영)
- [ ] Consumer 재시작 후 미ACK 메시지 자동 재수신
