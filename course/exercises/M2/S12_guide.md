# S12 실습 가이드 — 이벤트 파이프라인 E2E 관찰

```bash
npm run exercise:s12
```

파일 상단 실험 변수를 바꾸고 실행하면서 출력이 어떻게 달라지는지 확인하세요.

```typescript
const SEND_DUPLICATE = false; // 같은 requestId로 두 번 보낼까?
const SEND_BAD_SIG   = false; // 잘못된 서명으로 보낼까?
```

---

## 실험 1 — 기본 상태 (변수 그대로)

```
SEND_DUPLICATE = false / SEND_BAD_SIG = false
```

**기대 출력:**
```
[1] 정상 Webhook
  ✅ HTTP 202 (기대: 202)

[2] Stream 적재
  ✅ 1건 (기대: 1)

[3] Consumer → 원장
  ✅ 0xAlice T-1001 잔고: 1 (기대: 1)
```

VASP → WebhookServer(HMAC 검증) → Stream 적재 → Consumer 처리 → 원장 반영까지 전체 파이프라인이 정상 동작합니다.

---

## 실험 2 — 중복 전송 (멱등성)

```
SEND_DUPLICATE = true
```

**기대 출력:**
```
[4] 중복 전송 (멱등성)
  ✅ HTTP 202 (기대: 202)
  ✅ Stream 1건 (기대: 1)
  ✅ 잔고: 1 (기대: 1)
```

**확인 포인트:**
- HTTP 응답은 202지만 Stream에 메시지가 추가되지 않습니다 (`IdempotencyGuard`가 차단)
- 원장 잔고도 1 그대로 — 중복 발행이 없습니다
- 같은 `requestId`가 두 번 오면 WebhookPublishHandler 계층에서 조용히 무시합니다

---

## 실험 3 — 잘못된 서명

```
SEND_BAD_SIG = true
```

**기대 출력:**
```
[5] 잘못된 서명
  ✅ HTTP 401 (기대: 401)
```

**확인 포인트:**
- HMAC 서명이 틀리면 WebhookServer에서 즉시 401로 거부합니다
- Stream에 도달하지 않으므로 Stream 적재 건수와 원장에 영향 없습니다

---

## 실험 4 — 두 가지 함께

```
SEND_DUPLICATE = true
SEND_BAD_SIG   = true
```

**확인 포인트:** [4]와 [5] 시나리오가 모두 실행됩니다. 인증(서명 검증)과 멱등성은 독립된 방어선임을 확인할 수 있습니다.

---

## 완료 기준

- [ ] 실험 1: [1][2][3] 모두 ✅ 확인
- [ ] 실험 2: 중복 requestId가 Stream에 추가되지 않음 확인
- [ ] 실험 3: 잘못된 서명 → 401 확인
- [ ] 아래 E2E 흐름을 말로 설명 가능:

```
VASP 이벤트 발생
    → WebhookServer: HMAC 서명 검증 (실패 → 401)
    → WebhookPublishHandler: IdempotencyGuard (중복 → 무시)
    → RedisStreamPublisher: XADD
    → ConsumerGroupWorker: XREADGROUP
    → NFTIssuedProcessor: IdempotencyGuard → InMemoryLedger 반영
    → XACK
```
