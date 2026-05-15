# S09 실습 가이드 — At-least-once + 멱등성

```bash
npm run exercise:s09
```

파일 상단 실험 변수를 바꾸고 실행하면서 출력이 어떻게 달라지는지 확인하세요.

```typescript
const DUPLICATE_COUNT    = 2;     // 같은 메시지를 몇 번 보낼까?
const USE_IDEMPOTENCY    = false; // 멱등성 켜기
const ACK_BEFORE_PROCESS = false; // XACK를 처리 전에 하면?
const SIMULATE_CRASH     = false; // 처리 도중 크래시 시뮬레이션
```

---

## 실험 1 — 기본 상태 (변수 그대로)

```
DUPLICATE_COUNT = 2 / USE_IDEMPOTENCY = false
```

**기대 출력:**
```
  메시지 1/2: 처리됨 (누적: 1회)
  메시지 2/2: 처리됨 (누적: 2회)

  최종 원장 적립 횟수: 2회
  ❌ 중복 발행 — 2회 적립
```

같은 `requestId`인데 원장에 2번 적립됩니다. 멱등성이 없을 때 발생하는 중복 발행 버그입니다.

---

## 실험 2 — 중복 횟수 늘려보기

```
DUPLICATE_COUNT = 3
```

**확인 포인트:** `처리됨 (누적: 3회)` 까지 찍힙니다. DUPLICATE_COUNT를 늘릴수록 적립 횟수도 그대로 늘어납니다.

---

## 실험 3 — 멱등성 켜기

```
DUPLICATE_COUNT = 3
USE_IDEMPOTENCY = true
```

**기대 출력:**
```
  메시지 1/3: 처리됨 (누적: 1회)
  메시지 2/3: 스킵 (멱등성)
  메시지 3/3: 스킵 (멱등성)

  최종 원장 적립 횟수: 1회
  ✅ 정상 — 1회 처리
```

3번 보내도 원장 적립은 1번만 됩니다. 멱등성이 중복을 차단합니다.

---

## 실험 4 — XACK 순서 바꾸기

```
USE_IDEMPOTENCY    = false
ACK_BEFORE_PROCESS = true
```

**기대 출력:**
```
  메시지 1/2: 처리됨 (누적: 1회)
  메시지 2/2: 처리됨 (누적: 2회)
  ❌ 중복 발행 — 2회 적립
```

ACK를 먼저 보내도 기능 자체는 같지만, 이 순간 크래시가 나면 Redis에서 메시지가 사라집니다. 원장 적립 전 크래시 → 영구 유실. XACK를 마지막에 해야 하는 이유입니다.

---

## 실험 5 — 크래시 시뮬레이션

```
USE_IDEMPOTENCY    = false
ACK_BEFORE_PROCESS = false
SIMULATE_CRASH     = true
```

**기대 출력:**
```
  메시지 1/2: 크래시 — XACK 없음
  메시지 2/2: 크래시 — XACK 없음

  최종 원장 적립 횟수: 0회
  ⚠️  크래시 — 처리 미완료
```

XACK가 없어 메시지는 Redis PEL에 남아있습니다. 재시작 후 이 메시지를 다시 받게 됩니다.

---

## 실험 6 — 크래시 + 멱등성 (안전한 재처리)

```
DUPLICATE_COUNT = 2
USE_IDEMPOTENCY = true
SIMULATE_CRASH  = true
```

**기대 출력:**
```
  메시지 1/2: 크래시 — XACK 없음
  메시지 2/2: 크래시 — XACK 없음

  ⚠️  크래시 — 처리 미완료
```

이 실습에서는 두 메시지 모두 크래시가 납니다. 실제 환경에서는 재시작 후 PEL에서 재수신하고, 그때 멱등성이 중복 처리를 막습니다. At-least-once + 멱등성의 조합이 안전한 재처리를 보장합니다.

---

## 완료 기준

- [ ] 실험 1: ❌ 중복 발행 확인
- [ ] 실험 3: ✅ 멱등성으로 중복 차단 확인
- [ ] 실험 4: XACK 순서가 왜 중요한지 말로 설명 가능
- [ ] 실험 5: 크래시 시 PEL 잔류 의미 이해
- [ ] 실험 6: At-least-once + 멱등성 조합의 역할 설명 가능

---

## 메모리 기반 멱등성의 한계

이 실습의 `processedIds`는 인메모리 `Set`입니다.

| 한계 | 설명 |
|------|------|
| 프로세스 재시작 | Set 초기화 → 이전 처리 기록 사라짐 |
| Consumer 2개 | 각자 별도 Set → 분산 환경에서 중복 차단 불가 |

실무 해결책:
- DB unique constraint: `INSERT INTO processed_events (request_id) ON CONFLICT DO NOTHING`
- Redis SETNX: `SETNX processed:{requestId} 1 EX 86400`
- 이 코드베이스의 `IdempotencyGuard` → S12 E2E에서 연결됩니다
