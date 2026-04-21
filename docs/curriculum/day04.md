# Day 04 — Webhook 설계 및 구현

**시간**: 3시간  
**핵심 질문**: 이벤트를 잡았다. Core Banking에 어떻게 신뢰성 있게 전달하는가?

---

## 목표

Webhook의 핵심 문제 3가지를 직접 마주치고 해결한다:  
**위변조 방지** / **중복 처리** / **전달 실패 시 재시도**

이 3가지 문제를 해결하지 않으면 금융 시스템 연동에서 쓸 수 없다.

---

## 실습 시나리오

### 실습 1 — WebhookServer 구동 및 서명 검증 이해 (50분)

```typescript
// WebhookServer를 직접 구동
import { WebhookServer } from './packages/event-engine/src/webhook/WebhookServer';

const server = new WebhookServer({
  port:      3001,
  secret:    'test-secret-key',
  maxBodyKb: 64,
});

server.on('NFT_ISSUED', async (payload) => {
  console.log('[수신]', payload);
});

await server.listen();
```

**실험 1 — 정상 요청:**
```bash
BODY='{"eventType":"NFT_ISSUED","data":{"tokenId":"1"},"timestamp":1234,"requestId":"req-001"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "test-secret-key" | awk '{print $2}')
curl -X POST http://localhost:3001 \
  -H "Content-Type: application/json" \
  -H "X-Kyobo-Signature: $SIG" \
  -d "$BODY"
```

**실험 2 — 서명 없이 요청:**
```bash
curl -X POST http://localhost:3001 \
  -H "Content-Type: application/json" \
  -d "$BODY"
# 예상 결과: 401
```

**질문:** `timingSafeEqual`을 쓰는 이유는? 일반 `===` 비교와 무엇이 다른가?

### 실습 2 — IdempotencyGuard 직접 테스트 (40분)

```typescript
import { IdempotencyGuard, InMemoryIdempotencyStore }
  from './packages/event-engine/src/webhook/IdempotencyGuard';

const guard = new IdempotencyGuard(new InMemoryIdempotencyStore());

let callCount = 0;
const handler = async () => { callCount++; console.log('처리됨', callCount); };

// 동일 requestId로 3번 호출
await guard.run('req-001', handler);  // → 처리됨 1
await guard.run('req-001', handler);  // → (무시)
await guard.run('req-001', handler);  // → (무시)

console.log('총 실행 횟수:', callCount);  // → 1
```

**시나리오:** Core Banking이 응답을 못 받아서 같은 이벤트를 3번 보냈다.  
`callCount`가 3이 되면 어떤 문제가 발생하는가? (NFT 3개 발행?)

### 실습 3 — RetryHandler 지수 백오프 확인 (50분)

```typescript
import { RetryHandler, DeadLetterQueue }
  from './packages/event-engine/src/webhook/RetryHandler';

const dlq   = new DeadLetterQueue();
const retry = new RetryHandler(
  { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000, backoffFactor: 2 },
  dlq,
);

// 항상 실패하는 목 서버로 테스트
await retry.send({
  requestId: 'test-001',
  targetUrl: 'http://localhost:9999/nonexistent',  // 존재하지 않는 서버
  payload:   { event: 'NFT_ISSUED', tokenId: '1' },
  secret:    'test-secret',
}).catch(err => console.log('최종 실패 — DLQ로:', err.message));
```

로그에서 재시도 간격이 500ms → 1000ms → 2000ms인지 확인한다.

**질문:**
- `maxAttempts`를 무한대로 늘리면 안 되는 이유는?
- DLQ에 쌓인 이벤트를 수동 재처리할 때 멱등성이 왜 다시 중요한가?

---

## 참조 파일

- `packages/event-engine/src/webhook/WebhookServer.ts`
- `packages/event-engine/src/webhook/IdempotencyGuard.ts`
- `packages/event-engine/src/webhook/RetryHandler.ts`
- `docs/adr/004-event-driven-architecture.md`
