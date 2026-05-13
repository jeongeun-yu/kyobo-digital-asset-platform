# S11 실습 가이드 — Dead Letter Queue 운영 패턴

```bash
npm run exercise:s11
```

파일 상단 실험 변수를 바꾸고 실행하면서 출력이 어떻게 달라지는지 확인하세요.

```typescript
const MAX_RETRIES  = 3;       // DLQ 이동까지 최대 재시도 횟수
const REQUEUE_MODE = 'first'; // 재큐잉할 항목 수: 'first' 또는 'all'
```

---

## 실험 1 — 기본 상태 (변수 그대로)

```
MAX_RETRIES = 3 / REQUEUE_MODE = 'first'
```

**기대 출력:**
```
  Part 1 — 실패 반복 → DLQ 이동

  DLQ 항목 수: 1
  ✅ DLQ 이동 확인

  Part 2 — 운영자 DLQ 처리 절차

  DLQ 항목 수: 1
    NFT_BURNED | max retries (3) exceeded

  REQUEUE_MODE = 'first' → 1건 재큐잉

  재큐잉 후 DLQ 항목 수: 0
  ✅ 1건 감소 (기대: 1)
```

`NFT_BURNED` 이벤트가 3회 실패 후 DLQ로 이동하고, 운영자가 `requeueMessage()`로 복구하는 전체 흐름입니다.

---

## 실험 2 — MAX_RETRIES를 1로 줄이면?

```
MAX_RETRIES = 1
```

**확인 포인트:**
- DLQ 항목 수는 동일하게 1건이지만 더 빨리 도달합니다 (1회 실패만으로 이동)
- `reason` 필드가 `max retries (1) exceeded`로 바뀝니다

MAX_RETRIES가 낮을수록 일시적 오류도 DLQ로 가버립니다. 적절한 임계값 선택이 중요합니다.

---

## 실험 3 — 전체 재큐잉

```
MAX_RETRIES  = 3
REQUEUE_MODE = 'all'
```

**확인 포인트:** 이 실습에서는 DLQ 항목이 1건이라 `'first'`와 `'all'` 결과가 같습니다. 실무에서 DLQ에 여러 메시지가 누적됐을 때 `'all'`로 한 번에 재투입합니다.

---

## 완료 기준

- [ ] 실험 1: DLQ 항목 수 1 → 재큐잉 후 0 확인
- [ ] 실험 1: `reason = max retries (3) exceeded` 확인
- [ ] 실험 2: MAX_RETRIES=1 시 이동 속도 차이 관찰
- [ ] 아래 운영 절차를 말로 설명 가능:

```
실패 반복 (MAX_RETRIES회)
    → DLQ 격리 + XACK (PEL 정리)
    → 운영자 listPending() 확인
    → 원인 파악 후 requeueMessage()
    → 원 스트림 재투입 + DLQ에서 제거
    → Consumer 재처리
```
