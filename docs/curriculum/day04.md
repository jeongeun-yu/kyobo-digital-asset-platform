# Day 04 — Webhook 설계 및 구현

**시간**: 3시간 (180분)  
**핵심 질문**: 이벤트를 잡았다. Core Banking에 어떻게 신뢰성 있게 전달하는가?

---

## 세션 구조

| 시간 | 내용 |
|---|---|
| 00:00~00:30 | 1부: Webhook의 3가지 핵심 문제 |
| 00:30~01:10 | 실습 1: WebhookServer 구동 + HMAC 서명 검증 |
| 01:10~01:40 | 2부: 멱등성 — 같은 이벤트가 두 번 오면? |
| 01:40~02:10 | 실습 2: IdempotencyGuard 직접 테스트 |
| 02:10~02:40 | 3부: 재시도와 Dead Letter Queue |
| 02:40~03:00 | 실습 3: RetryHandler 지수 백오프 확인 |

---

## 1부: Webhook의 3가지 핵심 문제 (00:00~00:30)

### 1-1. 왜 단순한 HTTP POST로는 부족한가 (15분)

**토킹포인트:**

> "이벤트를 Core Banking에 전달하는 가장 단순한 방법은 HTTP POST입니다. 그런데 금융 시스템에서 이것만으로는 3가지 문제가 생깁니다."

**문제 1 — 위변조:**
```
악의적인 제3자가 가짜 이벤트를 POST한다:
{ "eventType": "NFT_ISSUED", "tokenId": "999", "to": "해커주소" }

→ Core Banking이 속으면 포인트가 잘못 지급된다
```

**문제 2 — 중복 처리:**
```
네트워크 장애로 Core Banking이 202 응답을 못 보냄
→ RetryHandler가 같은 이벤트를 재전송
→ Core Banking이 같은 NFT 발행을 두 번 처리
→ 포인트 2배 지급 사고
```

**문제 3 — 전달 실패:**
```
Core Banking 서버 점검 중 (새벽 2시)
→ NFT 발행 이벤트 전달 실패
→ 고객은 NFT를 받았는데 포인트는 없음
→ 새벽에 수동으로 복구?
```

### 1-2. 세 가지 해결책 개요 (15분)

| 문제 | 해결책 | 이 프로젝트에서 |
|---|---|---|
| 위변조 | HMAC-SHA256 서명 | `WebhookServer._verifySignature()` |
| 중복 처리 | 멱등성 키 | `IdempotencyGuard` |
| 전달 실패 | 지수 백오프 재시도 + DLQ | `RetryHandler` + `DeadLetterQueue` |

**토킹포인트:**

> "이 세 가지를 모두 구현하면 금융 시스템 연동에 쓸 수 있는 수준이 됩니다. 패스트캠퍼스 강의에서 Webhook을 배울 때 이 세 가지를 다 다루나요? 오늘은 실제로 동작하는 코드로 직접 확인합니다."

---

## 실습 1: WebhookServer 구동 + HMAC 서명 검증 (00:30~01:10)

### Step 1 — WebhookServer 코드 읽기 (10분)

```bash
cat dmz/packages/event-engine/src/webhook/WebhookServer.ts
```

핵심 함수 집중:
```typescript
private _verifySignature(body: string, signature: string): boolean {
  const expected = crypto
    .createHmac('sha256', this.config.secret)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected),
  );
}
```

**질문:** `timingSafeEqual`을 쓰는 이유는?
- 일반 `===` 비교: 앞에서부터 비교하다 다른 문자 발견 시 즉시 리턴
- 타이밍 공격: 응답 시간으로 서명의 일치 위치를 추론 가능
- `timingSafeEqual`: 항상 동일한 시간 소요 → 타이밍 공격 방어

### Step 2 — WebhookServer 구동 (15분)

```typescript
// scripts/run-webhook-server.ts
import { WebhookServer } from '../dmz/packages/event-engine/src/webhook/WebhookServer';

const server = new WebhookServer({
  port:      3001,
  secret:    'kyobo-test-secret-2026',
  maxBodyKb: 64,
});

server.on('NFT_ISSUED', async (payload) => {
  console.log('\n[이벤트 수신!]');
  console.log('  requestId:', payload.requestId);
  console.log('  data:     ', JSON.stringify(payload.data));
  console.log('  timestamp:', new Date(payload.timestamp).toISOString());
});

await server.listen();
console.log('WebhookServer 실행 중 (port 3001)');
```

```bash
npx ts-node scripts/run-webhook-server.ts
```

### Step 3 — 서명 있는 요청 vs 서명 없는 요청 (15분)

**실험 A — 올바른 서명으로 요청:**
```bash
# BODY 생성
BODY='{"eventType":"NFT_ISSUED","data":{"tokenId":"1","to":"0xabc"},"timestamp":1713700000000,"requestId":"req-001"}'

# HMAC-SHA256 서명
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "kyobo-test-secret-2026" | awk '{print $2}')
echo "서명: $SIG"

# 요청
curl -s -X POST http://localhost:3001 \
  -H "Content-Type: application/json" \
  -H "X-Kyobo-Signature: $SIG" \
  -d "$BODY" \
  -w "\nHTTP Status: %{http_code}\n"
```

서버 터미널에서 이벤트 출력 확인.

**실험 B — 서명 없이 요청:**
```bash
curl -s -X POST http://localhost:3001 \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  -w "\nHTTP Status: %{http_code}\n"
# → HTTP Status: 401
```

**실험 C — 잘못된 서명으로 요청:**
```bash
curl -s -X POST http://localhost:3001 \
  -H "Content-Type: application/json" \
  -H "X-Kyobo-Signature: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  -d "$BODY" \
  -w "\nHTTP Status: %{http_code}\n"
# → HTTP Status: 401
```

---

## 2부: 멱등성 — 같은 이벤트가 두 번 오면? (01:10~01:40)

### 2-1. 멱등성이란 (15분)

**토킹포인트:**

> "멱등성(Idempotency)이란 같은 요청을 여러 번 해도 결과가 동일하다는 성질입니다. HTTP GET은 멱등합니다. 조회는 몇 번을 해도 DB가 바뀌지 않습니다. 그런데 HTTP POST는 기본적으로 멱등하지 않습니다. 주문을 두 번 POST하면 주문이 두 개 생깁니다."

**금융 Webhook에서의 멱등성 실패 시나리오:**
```
1. issuer-service → Core Banking에 NFT_ISSUED 전송
2. Core Banking이 처리 완료 → 포인트 1000점 지급
3. 네트워크 문제로 202 응답 유실
4. RetryHandler가 재전송
5. Core Banking이 또 처리 → 포인트 1000점 또 지급
6. 결과: 고객에게 2000점 지급 사고
```

**해결책: requestId 기반 멱등성**
```
1. 모든 이벤트에 고유한 requestId를 붙인다 (txHash + logIndex)
2. 수신 시 DB에 requestId가 이미 있으면 처리하지 않고 200 응답
3. 처음 수신이면 처리 + DB에 requestId 저장
```

### 2-2. IdempotencyGuard 설계 (15분)

```bash
cat dmz/packages/event-engine/src/webhook/IdempotencyGuard.ts
```

```typescript
async run(key: string, fn: () => Promise<void>): Promise<boolean> {
  if (await this.store.exists(key)) return false;  // 이미 처리됨
  await fn();                                       // 처리 실행
  await this.store.mark(key, this.ttlSeconds);      // 처리 기록
  return true;
}
```

**토킹포인트:**

> "주의할 점이 있습니다. `fn()`이 실행되다가 에러가 나면 `mark()`가 호출되지 않습니다. 이 경우 재시도 시 다시 처리됩니다. 이것이 맞는 동작입니다. `fn()`이 완전히 성공해야만 '처리됨'으로 기록해야 하니까요."

---

## 실습 2: IdempotencyGuard 직접 테스트 (01:40~02:10)

```typescript
// scripts/test-idempotency.ts
import {
  IdempotencyGuard,
  InMemoryIdempotencyStore,
} from '../dmz/packages/event-engine/src/webhook/IdempotencyGuard';

async function main() {
  const guard = new IdempotencyGuard(new InMemoryIdempotencyStore());

  let callCount = 0;
  const handler = async () => {
    callCount++;
    console.log(`  → 처리됨 (${callCount}번째)`);
    // 포인트 지급, DB 업데이트 등...
  };

  console.log('=== 테스트 1: 동일 requestId 3번 호출 ===');
  const r1 = await guard.run('req-nft-001', handler);  // true
  const r2 = await guard.run('req-nft-001', handler);  // false (중복)
  const r3 = await guard.run('req-nft-001', handler);  // false (중복)
  console.log('처리 결과:', r1, r2, r3);
  console.log('실제 실행 횟수:', callCount);  // → 1
  console.log();

  console.log('=== 테스트 2: 다른 requestId ===');
  const r4 = await guard.run('req-nft-002', handler);  // true (새 요청)
  console.log('처리 결과:', r4);
  console.log('실제 실행 횟수:', callCount);  // → 2

  console.log();
  console.log('=== 시나리오: 포인트 중복 지급 방지 ===');
  console.log('callCount가 2 (NFT 2개 발행) — 3이 아님 (중복 처리 없음)');
}

main();
```

**실행 결과 확인 후 토론:**
- `callCount`가 2가 아니라 3이 됐다면 어떤 사고가 발생하는가?
- `InMemoryIdempotencyStore`는 프로덕션에서 왜 쓰면 안 되는가?
  - 서버 재시작 시 메모리 초기화 → 이미 처리된 이벤트를 다시 처리할 수 있음

---

## 3부: 재시도와 Dead Letter Queue (02:10~02:40)

### 3-1. 지수 백오프 (15분)

**토킹포인트:**

> "Core Banking 서버가 점검 중일 때 우리 서비스는 어떻게 해야 할까요? 1초마다 재시도? 그러면 서버가 복구됐을 때 수천 건의 요청이 한꺼번에 몰립니다. 이걸 'thundering herd'라고 합니다."

**지수 백오프 전략:**
```
1차 실패 → 1초 대기
2차 실패 → 2초 대기
3차 실패 → 4초 대기
4차 실패 → 8초 대기
5차 실패 → DLQ로 이동
```

`RetryHandler.ts`:
```typescript
let delayMs = this.config.initialDelayMs;  // 1000
while (attempt < this.config.maxAttempts) {
  try {
    await this._post(event);
    return;  // 성공
  } catch {
    attempt++;
    await this._sleep(Math.min(delayMs, this.config.maxDelayMs));
    delayMs *= this.config.backoffFactor;  // 2배씩 증가
  }
}
```

### 3-2. Dead Letter Queue의 역할 (15분)

**토킹포인트:**

> "최대 재시도 횟수를 초과한 이벤트는 어떻게 할까요? 버리면 고객 피해가 생깁니다. 무한 재시도하면 서비스가 마비됩니다. DLQ에 보관합니다. 담당자가 알람을 받고 수동으로 확인 후 재처리합니다."

**DLQ의 운용 원칙:**
1. DLQ에 쌓이면 즉시 알람 (Slack, SMS)
2. DLQ 이벤트는 원인 파악 후 수동 재처리
3. 재처리 시에도 멱등성 덕분에 중복 처리 없음

---

## 실습 3: RetryHandler 지수 백오프 확인 (02:40~03:00)

```typescript
// scripts/test-retry.ts
import {
  RetryHandler,
  DeadLetterQueue,
} from '../dmz/packages/event-engine/src/webhook/RetryHandler';

async function main() {
  const dlq   = new DeadLetterQueue();
  const retry = new RetryHandler(
    {
      maxAttempts:    3,
      initialDelayMs: 500,
      maxDelayMs:     5000,
      backoffFactor:  2,
    },
    dlq,
  );

  console.log('존재하지 않는 서버로 전송 시작...');
  const start = Date.now();

  try {
    await retry.send({
      requestId: 'test-retry-001',
      targetUrl: 'http://localhost:9999/nonexistent',
      payload:   { eventType: 'NFT_ISSUED', tokenId: '1' },
      secret:    'test-secret',
    });
  } catch (err: unknown) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`최종 실패 (${elapsed}초 경과)`);
    console.log('→ DLQ로 이동됨');
    // 예상 경과 시간: 0.5 + 1 = 1.5초
  }
}

main();
```

**관찰 포인트:**
- 재시도 간격이 500ms → 1000ms 순서로 증가하는가?
- DLQ의 `[DLQ] failed event:` 로그가 출력되는가?
- 총 경과 시간이 약 1.5초인가?

---

## 마무리

**오늘의 핵심 3줄:**
1. HMAC 서명 없는 Webhook은 금융 시스템에서 쓸 수 없다
2. 멱등성 없는 재시도는 중복 처리 사고를 만든다
3. DLQ는 "안전하게 실패하는" 방법이다

**Day 05 예고:**  
컨트랙트 내부 — RBAC, pause, 취약점. 배포된 코드는 수정이 불가능하다는 것의 무게를 이해한다.

---

## 참조 파일

- `dmz/packages/event-engine/src/webhook/WebhookServer.ts`
- `dmz/packages/event-engine/src/webhook/IdempotencyGuard.ts`
- `dmz/packages/event-engine/src/webhook/RetryHandler.ts`
- `docs/adr/004-event-driven-architecture.md`
