# Day 03 — M2: DMZ 이벤트 파이프라인 후반부 (S9~S12)

**세션**: S9~S12 | **모듈**: M2 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: EventConsumer(멱등 처리) + DLQ + Finalized 블록 처리 + M2 E2E 완주

---

## S9: 이벤트 소비자 처리 순서 불변 규칙과 At-least-once 설계 원리 (강의 55분)

### 강의 (이론 세션 — 실습 없음)

**At-least-once 의미:**
- 최소 1번 처리 보장, 중복 가능
- Exactly-once는 분산 시스템에서 사실상 불가 → 멱등성이 필수인 이유

**잘못된 처리 순서 케이스 1 — XACK 먼저:**
```
XACK → DB 처리 실패
→ 메시지 PEL에서 제거됨 → 영구 유실 (재수신 불가)
```

**잘못된 처리 순서 케이스 2 — DB 커밋 먼저:**
```
DB 커밋 → XACK 실패 → 재시작 후 재수신
→ 멱등성 없으면 holdings +2 (중복 발행)
```

**올바른 처리 순서 (4단계):**
```
1. 멱등성 확인 (ON CONFLICT DO NOTHING)  ← 중복 차단
2. DB 트랜잭션 (LedgerService 포함)      ← 실제 처리
3. 트랜잭션 커밋                          ← 원자적 완료
4. XACK                                  ← 처리 완료 선언
```

**XACK 실패 케이스 대응:**
- 재시작 후 PEL 재수신 → 멱등성 체크에서 이미 처리됨 감지 → XACK만 재실행

**DB와 XACK 원자성 불가 문제:**
- Redis-DB 간 2PC 불가
- 멱등성이 유일한 현실적 보정 수단

**Consumer 인스턴스 확장 시 안전성:**
- 멱등성 + Consumer Group으로 중복 처리 없는 수평 확장 가능

### ✅ 완료 기준 (강의 이해 확인)
- [ ] 잘못된 처리 순서 2가지 시나리오 설명 가능
- [ ] 올바른 순서 4단계 + 각 이유 설명 가능
- [ ] 멱등성이 At-least-once를 안전하게 만드는 원리 설명 가능

---

## S10: EventConsumer 구현과 멱등 처리 통합 검증 (개요 10분 + 실습 50분)

### 개요 (10분)

올바른 처리 순서 재확인 / 멱등성 체크 위치 재확인

### 🔴 실습 (50분) — 수강생 직접 작성

**Step 1**: EventConsumer 핵심 루프 구현
```typescript
// dmz/packages/event-engine/src/consumer/EventConsumer.ts
// TODO: Consumer Group 기반 반복 폴링 루프 구현
// - XREADGROUP으로 미처리 메시지 읽기
// - 각 메시지마다 processNFTIssued 호출
// - 처리 완료 후 XACK

export class EventConsumer {
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly ledgerService: LedgerService,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      // TODO: XREADGROUP GROUP processing-group worker-1 COUNT 10 BLOCK 5000 STREAMS kyobo-events >
      // TODO: 메시지 있으면 processNFTIssued 호출
      // TODO: 처리 완료 후 XACK
    }
  }

  async processNFTIssued(event: NFTIssuedEvent): Promise<void> {
    // TODO: 올바른 처리 순서 구현
    // 1. 멱등성 확인 (recordProcessedEvent)
    // 2. DB 트랜잭션 (transitionMintRequest + holdings +1)
    // 3. 커밋
    // 4. XACK는 start() 루프에서 처리
  }
}
```

**Step 2**: 동일 이벤트 2회 주입 테스트
```typescript
// test: 같은 txHash+logIndex 이벤트 2회 → holdings 1회만 증가
it('동일 이벤트 2회 → holdings 1회만 반영', async () => {
  const event = { txHash: '0xabc', logIndex: 0, tokenId: 1001, to: '0xAlice' };
  
  // TODO: consumer.processNFTIssued(event) 2회 호출
  // TODO: holdings 조회 → 1임을 확인
});
```

### ✅ 답안

```typescript
// EventConsumer.start() 완성
async start(): Promise<void> {
  this.running = true;
  await this.queueService.initConsumerGroup();

  while (this.running) {
    const results = await this.redis.xreadgroup(
      'GROUP', 'processing-group', 'worker-1',
      'COUNT', '10',
      'BLOCK', '5000',
      'STREAMS', 'kyobo-events', '>',
    );

    if (!results) continue;

    for (const [, messages] of results) {
      for (const [msgId, fields] of messages) {
        const event = JSON.parse(fields[1]) as NFTIssuedEvent;
        try {
          await this.processNFTIssued(event);
          await this.redis.xack('kyobo-events', 'processing-group', msgId);
        } catch (err) {
          console.error('[Consumer] 처리 실패:', err);
          // DLQ 이동 로직은 S11에서 추가
        }
      }
    }
  }
}

// processNFTIssued 완성
async processNFTIssued(event: NFTIssuedEvent): Promise<void> {
  // 1. 멱등성 확인 — 이미 처리됐으면 스킵
  const alreadyProcessed = await this.ledgerService.recordProcessedEvent(
    event.txHash,
    event.logIndex,
    'NFTIssued',
    event,
  );
  if (alreadyProcessed) return;

  // 2. DB 트랜잭션 — 상태 전이 + holdings 증가
  await this.ledgerService.db.transaction(async (trx) => {
    await this.ledgerService.transitionMintRequest(event.requestId, 'CONFIRMED', trx);
    await trx('user_nft_holdings')
      .insert({ user_id: event.to, token_id: event.tokenId, amount: 1 })
      .onConflict(['user_id', 'token_id'])
      .merge({ amount: trx.raw('amount + 1') });
  });
  // 3. 커밋은 트랜잭션 블록 종료 시 자동
  // 4. XACK는 start() 루프에서 처리
}
```

### ✅ 완료 기준
- [ ] 동일 이벤트 2회 → 원장 1회만 반영
- [ ] 멱등성 체크 동작 확인

---

## S11: 처리 실패 격리 전략 — Dead Letter Queue 설계와 운영 (강의 15분 + 실습 40분)

### 강의

**DLQ 설계:**
- 3회 실패 → Dead Letter 스트림으로 이동
- 운영 알림 발송
- 수동 재큐잉 절차

**재시도 카운터 관리:**
- Redis XPENDING의 delivery count 조회 방식 vs DB 카운터 방식
- 트레이드오프: XPENDING은 Redis 재시작 시 초기화 가능 → DB 카운터가 안전

### 🔴 실습 (40분) — 수강생 직접 작성

**Step 1**: NFT 소각 이벤트 처리
```typescript
// TODO: processNFTBurned 구현
// - holdings -1
// - 소각 원장 기록
// - 감사 로그 append

async processNFTBurned(event: NFTBurnedEvent): Promise<void> {
  // TODO: 멱등성 확인
  // TODO: DB 트랜잭션: holdings 차감 + 소각 원장 + 감사 로그
}
```

**Step 2**: DLQ 이동 함수 구현
```typescript
// TODO: moveToDLQ 구현
// - Dead Letter 스트림(kyobo-dlq)으로 이동
// - 실패 이유와 함께 저장
// - 운영 알림 트리거

async moveToDLQ(
  messageId: string,
  event: unknown,
  reason: string,
): Promise<void> {
  // TODO: XADD kyobo-dlq * messageId [id] event [json] reason [reason]
  // TODO: 알림 발송 (console.error 또는 alertService 호출)
}
```

**Step 3**: 3회 실패 시 DLQ 이동 로직을 start() 루프에 통합
```typescript
// TODO: start() 루프의 catch 블록에 재시도 카운터 + DLQ 로직 추가
// - 실패 카운트 3회 이상이면 moveToDLQ 호출
// - 그 이하면 로그만 남기고 계속 폴링
```

**Step 4**: DLQ → 수동 재큐잉 확인
```bash
# DLQ에서 메시지 읽기
redis-cli XRANGE kyobo-dlq - +

# 수동으로 kyobo-events에 재적재
redis-cli XADD kyobo-events * eventData [JSON]
```

### ✅ 답안

```typescript
// processNFTBurned 완성
async processNFTBurned(event: NFTBurnedEvent): Promise<void> {
  const alreadyProcessed = await this.ledgerService.recordProcessedEvent(
    event.txHash, event.logIndex, 'NFTBurned', event,
  );
  if (alreadyProcessed) return;

  await this.ledgerService.db.transaction(async (trx) => {
    await trx('user_nft_holdings')
      .where({ user_id: event.from, token_id: event.tokenId })
      .decrement('amount', 1);
    await this.ledgerService.appendAuditLog('system', 'NFT_BURNED', event.tokenId, event);
  });
}

// moveToDLQ 완성
async moveToDLQ(messageId: string, event: unknown, reason: string): Promise<void> {
  await this.redis.xadd(
    'kyobo-dlq', '*',
    'originalMessageId', messageId,
    'event', JSON.stringify(event),
    'reason', reason,
    'failedAt', new Date().toISOString(),
  );
  console.error(`[DLQ] 메시지 이동: ${messageId}, 이유: ${reason}`);
  // 운영: alertService.send(...)
}

// start() catch 블록 완성
} catch (err) {
  const count = await this.getFailureCount(msgId);
  if (count >= 3) {
    await this.moveToDLQ(msgId, event, String(err));
    await this.redis.xack('kyobo-events', 'processing-group', msgId);
  } else {
    await this.incrementFailureCount(msgId);
    // 재시도: PEL에 잔류 (XACK 안 함)
  }
}
```

### ✅ 완료 기준
- [ ] 3회 실패 → DLQ 이동
- [ ] NFT 소각 → holdings -1 + 감사 로그

---

## S12: Finalized 블록 기준 처리와 파이프라인 장애 복원력 검증 (강의 15분 + 실습 40분)

### 강의

**Finalized 블록 처리:**
- CONFIRMED 블록에서 처리하면 Reorg로 되돌아올 수 있음
- Finalized 이후에만 처리하는 이유: 절대 불변이 보장된 이후

**Private RPC에서 Finalized 블록 이벤트 구독:**
- `eth_subscribe('newFinalizedBlock')` — 전용 노드 구독 API 활용

### 🔴 실습 (40분) — 수강생 직접 작성

**Step 1**: Consumer 강제 종료 → 재시작 후 미ACK 메시지 자동 재수신 확인
```bash
# 실습 시나리오:
# 1. Consumer 실행 중 메시지 수신 (XACK 전)
# 2. Consumer 강제 종료 (Ctrl+C)
# 3. Consumer 재시작
# 4. XPENDING 또는 XAUTOCLAIM으로 미처리 메시지 재수신 확인

# TODO: XAUTOCLAIM으로 미처리 메시지 재수신
redis-cli XAUTOCLAIM kyobo-events processing-group worker-1 0 0-0 COUNT 10
```

**Step 2**: Finalized 블록 체크 로직 추가
```typescript
// TODO: processNFTIssued에 Finalized 체크 추가
// CONFIRMED but not Finalized → Pending 유지 (처리 보류)

async processNFTIssued(event: NFTIssuedEvent): Promise<void> {
  // TODO: event.blockNumber가 현재 Finalized 블록보다 높으면 skip
  const finalizedBlock = await this.adapter.getFinalizedBlockNumber();
  if (event.blockNumber > finalizedBlock) {
    // Finalized 안 됨 → 처리 보류 (XACK 안 함)
    return;
  }
  // ... 기존 처리 로직
}
```

**Step 3**: M2 E2E 전체 흐름 1건 완주
```bash
# VASP Mock에서 Webhook 전송
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Signature: [올바른 서명]" \
  -d '{"eventType":"NFTIssued","txHash":"0xabc","logIndex":0,"tokenId":1001,"to":"0xAlice"}'

# 확인 순서:
# 1. Webhook → 202 즉시 응답
# 2. kyobo-events Stream에 메시지 적재 확인
# 3. Consumer가 메시지 소비 + 원장 업데이트 확인
# 4. XACK 완료 → PEL 비어있음 확인
```

### ✅ 답안

```typescript
// Finalized 체크 추가
async processNFTIssued(event: NFTIssuedEvent): Promise<void> {
  const finalizedBlock = await this.adapter.getFinalizedBlockNumber();
  if (event.blockNumber > finalizedBlock) {
    console.log(`[Consumer] 블록 ${event.blockNumber} 아직 Finalized 안 됨 (현재: ${finalizedBlock})`);
    return; // XACK 안 함 → 다음 폴링에서 재처리
  }

  const alreadyProcessed = await this.ledgerService.recordProcessedEvent(
    event.txHash, event.logIndex, 'NFTIssued', event,
  );
  if (alreadyProcessed) return;

  await this.ledgerService.db.transaction(async (trx) => {
    await this.ledgerService.transitionMintRequest(event.requestId, 'CONFIRMED', trx);
    await trx('user_nft_holdings')
      .insert({ user_id: event.to, token_id: event.tokenId, amount: 1 })
      .onConflict(['user_id', 'token_id'])
      .merge({ amount: trx.raw('amount + 1') });
  });
}
```

```bash
# E2E 검증 스크립트
# 1. 서명 생성
BODY='{"eventType":"NFTIssued","txHash":"0xabc","logIndex":0,"tokenId":1001,"to":"0xAlice"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "test-secret" | awk '{print $2}')

# 2. Webhook 전송
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIG" \
  -d "$BODY"
# 응답: {"received":true} (202)

# 3. Stream 확인
redis-cli XRANGE kyobo-events - +
# 메시지 1개 확인

# 4. 원장 확인 (Consumer 처리 후)
# SELECT * FROM user_nft_holdings WHERE user_id = '0xAlice';
# amount = 1
```

### ✅ M2 완료 기준
- [ ] Consumer 장애 → 재시작 후 자동 재수신
- [ ] 3회 실패 → DLQ + 알림
- [ ] NFT 발행 → 원장 업데이트 E2E 동작
