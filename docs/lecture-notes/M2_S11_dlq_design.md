# M2 S11 — 처리 실패 격리 전략 Dead Letter Queue 설계와 운영

> Block B — DMZ 이벤트 파이프라인 · M2 S11 · 강의 55분  
> 대상: `dmz/packages/event-engine/src/dmz/DLQHandler.ts`

---

## 1. DLQ가 필요한 이유

```
재시도 불가 에러 (RetryHandler의 NonRetryableError와 동일 개념):
  - 비즈니스 로직 버그 → 재시도해도 항상 실패
  - 스키마 불일치 → 파싱 오류
  - 외부 서비스 영구 장애
```

DLQ 없이 계속 재시도하면:
1. PEL이 계속 쌓임 → 메모리 압박
2. Consumer 처리 지연 (실패 메시지 계속 처리)
3. 운영자가 장애를 인지하지 못함

## 2. DLQHandler 구조

```
F:\Workplace\kyobo-digital-asset-platform\
└── dmz/packages/event-engine/src/dmz/DLQHandler.ts
```

**DLQ 스트림 키:** `kyobo:events:dlq` (`${sourceStreamKey}:dlq`)

**DLQItem 인터페이스:**

```typescript
// DLQHandler.ts:16
export interface DLQItem {
  messageId: string;    // 원본 Redis messageId (예: "1714320000000-0")
  streamKey: string;    // 원본 스트림 키 (예: "kyobo:events")
  groupName: string;    // Consumer Group 이름
  event:     Record<string, string>;  // 원본 이벤트 필드 전체
  reason:    string;    // 실패 원인 문자열
  failedAt:  Date;
}
```

## 3. move() — DLQ 이동 + 운영 알림

```typescript
// DLQHandler.ts:61
async move(item: DLQItem): Promise<string> {
  // DLQ 스트림에 원본 필드 + 메타 필드 추가해 XADD
  const dlqMessageId = await this.redis.xadd(this.dlqStreamKey, {
    ...item.event,
    _originalMessageId: item.messageId,
    _originalStream:    item.streamKey,
    _groupName:         item.groupName,
    _reason:            item.reason,
    _failedAt:          item.failedAt.toISOString(),
  });

  // 알림: 비동기 (알림 실패가 DLQ 이동을 차단하면 안 됨)
  this.notifier.sendAlert(
    `[DLQ] 메시지 처리 실패\n` +
    `- 원본 ID: ${item.messageId}\n` +
    `- 이벤트: ${item.event['eventType'] ?? 'unknown'}\n` +
    `- 원인: ${item.reason}\n` +
    `- DLQ ID: ${dlqMessageId}`
  ).catch(err => console.error('[DLQHandler] alert failed:', err));

  return dlqMessageId;
}
```

**설계 포인트 — 왜 알림은 `.catch()`로 처리하는가:**

```
알림 서비스 장애 시 두 가지 선택:
  1. await notifier.sendAlert()   → 알림 실패 시 move() 전체 실패
                                    → DLQ 이동 안 됨 → 더 나쁜 상황
  2. .catch(err => log)           → 알림 실패해도 DLQ 이동은 성공
                                    → 알림 유실이 더 나은 트레이드오프
```

## 4. listPending() — DLQ 항목 조회

```typescript
// DLQHandler.ts:90
async listPending(count = 100): Promise<DLQItem[]> {
  const entries = await this.redis.xrange(this.dlqStreamKey, '-', '+', count);

  return entries.map(entry => ({
    messageId: entry.fields['_originalMessageId'] ?? entry.id,
    streamKey: entry.fields['_originalStream']    ?? '',
    groupName: entry.fields['_groupName']         ?? '',
    event:     entry.fields,
    reason:    entry.fields['_reason']            ?? '',
    failedAt:  new Date(entry.fields['_failedAt'] ?? Date.now()),
  }));
}
```

운영자 워크플로우:

```typescript
// 1. DLQ 조회
const pending = await dlqHandler.listPending(50);
console.table(pending.map(p => ({
  id:      p.messageId,
  event:   p.event['eventType'],
  reason:  p.reason,
  failed:  p.failedAt,
})));
```

## 5. requeueMessage() — 수동 재큐잉

```typescript
// DLQHandler.ts:116
async requeueMessage(
  dlqMessageId: string,
  targetStreamKey?: string,
): Promise<{ newMessageId: string }> {
  const [entry] = await this.redis.xrange(
    this.dlqStreamKey, dlqMessageId, dlqMessageId, 1,
  );
  if (!entry) throw new DLQMessageNotFoundError(dlqMessageId);

  const targetKey = targetStreamKey ?? entry.fields['_originalStream'] ?? 'kyobo:events';

  // _로 시작하는 DLQ 메타 필드 제거 → 원본 이벤트 필드만
  const requeueFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry.fields)) {
    if (!k.startsWith('_')) requeueFields[k] = v;
  }
  requeueFields['_requeuedFrom'] = dlqMessageId;
  requeueFields['_requeuedAt']   = new Date().toISOString();

  const newMessageId = await this.redis.xadd(targetKey, requeueFields);
  await this.redis.xdel(this.dlqStreamKey, dlqMessageId);  // DLQ에서 제거

  return { newMessageId };
}
```

**운영 절차 (4단계):**

```
1. dlqHandler.listPending() → DLQ 항목 확인
        ↓
2. 원인 파악
   - 버그: 코드 수정 + 배포
   - 데이터 이상: 정정 후 재큐잉
        ↓
3. dlqHandler.requeueMessage(dlqMessageId)
   → 원본 스트림에 재발행
   → DLQ에서 제거
        ↓
4. Consumer가 재처리
   → 성공 → XACK
   → 실패 → DLQ 재진입 → 즉시 알림 (2회 DLQ = 비즈니스 로직 버그 의심)
```

## 6. 실습 — DLQ 시나리오 테스트

```typescript
// 실습: 3회 실패 → DLQ 이동 확인
it('3회 실패 → DLQ 이동', async () => {
  // Given: 항상 실패하는 processor
  const brokenProcessor: EventProcessor = {
    eventTypes: ['NFTIssued'],
    process: async () => { throw new Error('DB connection failed'); },
  };

  const worker = new ConsumerGroupWorker(redis, [brokenProcessor], dlqHandler, config);

  // When: 메시지를 3회 실패시킴
  const msg: StreamMessage = {
    id: '1714320000000-0',
    fields: { eventType: 'NFTIssued', payload: '{}', _retryCount: '2' },
  };
  await worker['_handleWithRetry'](msg);  // retryCount=2 → 이번이 3번째

  // Then: DLQ에 이동됨
  const dlqItems = await dlqHandler.listPending();
  expect(dlqItems).toHaveLength(1);
  expect(dlqItems[0].reason).toContain('max retries');
});
```

**완료 기준:**
- [ ] 3회 실패 → DLQ 이동 확인
- [ ] DLQ → `requeueMessage()` → Consumer 재처리 확인
- [ ] 알림 서비스 장애 시 DLQ 이동 성공 여부 확인
