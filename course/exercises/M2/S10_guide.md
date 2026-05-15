# S10 실습 가이드 — 재시도 & DLQ 분기 관찰

```bash
npm run exercise:s10
```

파일 상단 실험 변수를 바꾸고 실행하면서 출력이 어떻게 달라지는지 확인하세요.

```typescript
const MAX_RETRIES          = 3; // DLQ로 이동하는 임계값
const FAIL_MSG_RETRY_COUNT = 1; // 실패 메시지의 현재 재시도 횟수
```

---

## 실험 1 — 기본 상태 (변수 그대로)

```
MAX_RETRIES = 3 / FAIL_MSG_RETRY_COUNT = 1
```

**기대 출력:**
```
[A] retryCount=3 → DLQ
  ✅ DLQ 이동: 1건 (기대: 1)
  ✅ XACK: 1건 (기대: 1)

[B] UNKNOWN_EVENT → processor 없음
  ✅ DLQ 이동: 0건 (기대: 0)
  ✅ XACK: 1건 (기대: 1)

[C] 처리 성공
  ✅ XACK: 1건 (기대: 1)

[D] 처리 실패, retryCount=1
  ✅ retryCount: 2 (기대: 2)
  ✅ XACK: 0건 (기대: 0)
```

4가지 분기가 각각 독립적으로 동작합니다. 시나리오 D에서는 XACK가 없어 PEL에 메시지가 남습니다.

---

## 실험 2 — MAX_RETRIES를 1로 줄이면?

```
MAX_RETRIES = 1
```

**확인 포인트:**
- 시나리오 [A]는 `retryCount=1 >= MAX_RETRIES=1` → 여전히 DLQ 이동
- 시나리오 [D]의 `FAIL_MSG_RETRY_COUNT = 1`이 이미 MAX_RETRIES와 같음 → [D]가 아닌 [A] 분기로 빠짐

MAX_RETRIES를 낮출수록 일시적 오류(네트워크 지연 등)도 DLQ로 가버립니다. 너무 낮으면 과민 반응, 너무 높으면 장애 감지가 늦어집니다.

---

## 실험 3 — 경계값 확인

```
MAX_RETRIES          = 3
FAIL_MSG_RETRY_COUNT = 2
```

**확인 포인트:** 시나리오 [D]에서 retryCount 2→3이 됩니다. 다음 수신 시 [A] 분기(DLQ)로 빠지는 시점입니다. 이것이 "마지막 재시도"의 순간입니다.

---

## 실험 4 — FAIL_MSG_RETRY_COUNT = MAX_RETRIES이면?

```
MAX_RETRIES          = 3
FAIL_MSG_RETRY_COUNT = 3
```

**확인 포인트:** [D] 시나리오는 실행되지 않고 [A]에서 DLQ로 이동합니다. retryCount 체크가 processor 매칭보다 먼저 일어나기 때문입니다.

---

## 완료 기준

- [ ] 실험 1: 4개 시나리오 모두 ✅ 확인
- [ ] 실험 2: MAX_RETRIES=1 시 [D]가 [A]로 전환되는 동작 확인
- [ ] 실험 3: 경계값(MAX_RETRIES - 1)의 의미 이해
- [ ] 아래 결정 트리를 말로 설명 가능:

```
retryCount >= MAX_RETRIES? → DLQ + XACK
매칭 processor 없음?       → XACK (무시)
처리 성공?                  → XACK
처리 실패?                  → retryCount+1, XACK 없음 (PEL 잔류)
```
