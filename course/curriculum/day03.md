# Day 03 — M2: DMZ 이벤트 파이프라인 후반부 (S9~S12)

**세션**: S9~S12 | **모듈**: M2 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: IdempotentProcessor 구현 + ConsumerGroupWorker `_handleWithRetry` 구현 + DLQ + Finalized 블록 처리 + M2 E2E 완주

---

## S9: 이벤트 소비자 처리 순서 불변 규칙과 At-least-once 설계 (강의 30분 + 실습 30분)

### 강의

**Exactly-once가 불가능한 이유:**
- DB 커밋과 Redis XACK는 독립된 저장소 → 2PC 불가
- At-least-once + 멱등성이 현실적 해답

**잘못된 처리 순서 케이스 1 — XACK 먼저:**
```
XACK → DB 처리 실패 → 메시지 PEL에서 제거 → 영구 유실
```

**잘못된 처리 순서 케이스 2 — DB 커밋 먼저, XACK 실패:**
```
DB 커밋 → XACK 실패 → 재시작 후 재수신 → 멱등성 없으면 holdings +2
```

**올바른 처리 순서 (4단계 불변 규칙):**
```
1. 멱등성 확인  → 중복이면 즉시 XACK + 종료
2. DB 트랜잭션  → 실제 처리
3. 트랜잭션 커밋
4. XACK         → 처리 완료 선언
```

**멱등성 키:**
- 온체인 이벤트: `txHash + logIndex`
- Webhook 이벤트: `requestId`

### 🔴 실습 (30분)

실습 파일: `src/exercises/S09_atleastonce.ts`

```
TODO 구현 목록:
  [ ] eventTypes: ['NFT_ISSUED']
  [ ] processedIds = new Set<string>()
  [ ] process(): requestId 중복 체크 → credit() → processedIds.add()
```

```bash
npx ts-node src/exercises/S09_atleastonce.ts
# 채점: npx jest --config jest.exercises.config.json src/exercises/__tests__/atleastonce.test.ts
```

### ✅ 완료 기준
- [ ] At-least-once 처리 순서 4단계 + 이유 설명 가능
- [ ] 동일 requestId 2회 → 원장 1회만 반영 확인

---

## S10: EventConsumer 구현 — ConsumerGroupWorker와 _handleWithRetry (개요 10분 + 실습 50분)

### 개요 (10분)

ConsumerGroupWorker 코드 구조 확인 / `_handleWithRetry()` 결정 트리 확인

### 🔴 실습 (50분) — 수강생 직접 작성

**목표**: `_handleWithRetry()` 함수를 직접 구현하고 4가지 시나리오로 검증

실습 파일: `src/exercises/S10_handle_with_retry.ts`

```
TODO 구현 목록:
  [ ] TODO 1: retryCount >= MAX_RETRIES → dlq.move() + xack + return
  [ ] TODO 2: matched processor 없음 → xack + return
  [ ] TODO 3: process 성공 → xack
  [ ] TODO 4: process 실패 → _retryCount + 1 (xack 없음)
```

```bash
npx ts-node src/exercises/S10_handle_with_retry.ts
# 채점: npx jest --config jest.exercises.config.json src/exercises/__tests__/handle_with_retry.test.ts
```

### ✅ 완료 기준
- [ ] 시나리오 1: DLQ 이동 ✅ + XACK ✅
- [ ] 시나리오 2: XACK ✅ (processor 호출 없음)
- [ ] 시나리오 3: XACK ✅
- [ ] 시나리오 4: retryCount 증가 ✅ + XACK 없음 ✅

---

## S11: 처리 실패 격리 전략 — Dead Letter Queue 설계와 운영 (강의 15분 + 실습 40분)

### 강의

**DLQ 설계:**
- 3회 실패 → Dead Letter 스트림(`kyobo:events:dlq`)으로 이동
- 운영 알림 발송 (비동기 — 알림 실패가 DLQ 이동을 차단하면 안 됨)
- 수동 재큐잉 절차: listPending() → requeueMessage()

**ConsumerGroupWorker와 DLQHandler 연동 구조:**
```
_handleWithRetry():
  retryCount >= 3 → dlq.move(item)  ← DLQHandler.ts
                  → redis.xack()
  처리 실패       → _retryCount + 1 (XACK 없음 → PEL 잔류)
```

### 🔴 실습 (40분)

실습 파일: `src/exercises/S11_dlq.ts`

```
TODO 구현 목록:
  [ ] TODO 1: DLQHandler 인스턴스 생성 (dlqRedis, dlqNotifier)
  [ ] TODO 2: 항상 실패하는 brokenProcessor 구현 (eventTypes: ['NFT_BURNED'])
  [ ] TODO 3: dlqHandler.listPending() 호출
  [ ] TODO 4: dlqHandler.requeueMessage(first.messageId) 호출
  [ ] TODO 5: requeueMessage() 후 listPending() 재호출 → 항목 감소 확인
  [ ] TODO 6: ConsumerGroupWorker 인스턴스 생성
```

```bash
npx ts-node src/exercises/S11_dlq.ts
# 채점: npx jest src/__tests__/dlq.test.ts
```

### ✅ 완료 기준
- [ ] 3회 실패 → DLQ 이동 + 알림 확인
- [ ] listPending() → DLQ 항목 조회
- [ ] requeueMessage() → DLQ 제거 + 원본 스트림 재발행 확인

---

## S12: Finalized 블록 기준 처리와 파이프라인 장애 복원력 검증 (강의 15분 + 실습 40분)

### 강의

**Finalized 블록 처리:**
- CONFIRMED 블록에서 처리하면 Reorg로 되돌아올 수 있음
- Finalized 이후에만 처리하는 이유: 절대 불변이 보장된 이후
- `eth_subscribe('newFinalizedBlock')` — 전용 Private RPC에서만 지원

**NFTIssuedProcessor Finalized 체크 구현 위치:**
```
src/processors/NFTIssuedProcessor.ts
  process():
    1. Finalized 체크 → 미확정이면 return (XACK 없음 → PEL 잔류)
    2. IdempotencyGuard.run() → 중복 차단
    3. LedgerService.creditNFT() → 원장 업데이트
```

### 🔴 실습 (40분)

실습 파일: `src/exercises/S12_e2e.ts`

```
TODO 구현 목록:
  [ ] TODO 1: WebhookPublishHandler 생성 + server.on('NFT_ISSUED', ...) 등록
  [ ] TODO 2: NFTIssuedProcessor 생성
  [ ] TODO 3: ConsumerGroupWorker 생성
  [ ] TODO 4: 동일 requestId 재전송 (멱등성 검증)
  [ ] TODO 5: 잘못된 서명 → 401 검증
```

```bash
npx ts-node src/exercises/S12_e2e.ts
# 채점: npx jest src/__tests__/e2e.test.ts
```

### ✅ M2 완료 기준
- [ ] Webhook → 202 즉시 응답 + Stream 적재 확인
- [ ] Consumer 처리 → 원장 업데이트 E2E 1건 완주
- [ ] 동일 requestId 2회 → 원장 1회만 반영 (전체 멱등성)
- [ ] Finalized 미확정 이벤트 → 처리 보류 + XACK 없음 확인
- [ ] 3회 실패 → DLQ 이동
- [ ] Consumer 장애 → 재시작 후 미ACK 자동 재수신
