# M2 S9 — 이벤트 소비자 처리 순서 불변 규칙과 At-least-once 설계 원리

> Block B — DMZ 이벤트 파이프라인 · M2 S9 · 강의 55분  
> 대상: `dmz/packages/event-engine/src/dmz/ConsumerGroupWorker.ts`

---

## 1. Exactly-once는 왜 불가능한가

분산 시스템에서 DB 커밋과 Redis XACK는 **두 개의 독립된 저장소**다.  
두 연산을 하나의 트랜잭션으로 묶는 2PC(Two-Phase Commit)는:

- Redis가 XA 프로토콜을 지원하지 않음
- 구현 복잡도 급상승 → 장애 복구가 더 어려워짐
- 성능 저하 (코디네이터 병목)

결론: **At-least-once(최소 1회 보장) + 멱등성**이 현실적 해답이다.

```
Exactly-once = 이상
At-least-once + 멱등성 = 현실
```

### DB 커밋 vs Redis XACK 차이

| | DB COMMIT | Redis XACK |
|---|---|---|
| **확정 대상** | 데이터 변경 (insert/update/delete) | 메시지 처리 완료 표시 |
| **묻는 질문** | "이 데이터 변경을 영속화할까?" | "이 메시지 책임을 내가 다 졌나?" |
| **위치** | DB 트랜잭션의 종결자 | 큐 시스템의 영수증 |

**같은 점:** 둘 다 "확정"하는 동작  
**다른 점:** 무엇을 확정하는지가 완전히 다름

## 2. 잘못된 처리 순서 — 왜 순서가 중요한가

**케이스 1: XACK → DB 처리 (치명적)**

```
XREADGROUP → PEL 소유 취득
     ↓
XACK         ← PEL에서 제거 (처리 완료 선언)
     ↓
DB 처리 실패 ← 여기서 장애
     ↓
재시작해도 메시지 없음 → 영구 유실
```

`XACK`는 "처리를 완료했다"는 선언이다.  
처리 전에 ACK하면 실패해도 재수신할 방법이 없다.

**케이스 2: DB 커밋 → XACK (안전하지만 중복 가능)**

```
XREADGROUP → PEL 소유 취득
     ↓
DB 커밋 성공
     ↓
XACK 실패 (네트워크 순단)
     ↓
재시작 → PEL에서 재수신
     ↓
멱등성 없으면 → holdings +2 (중복 발행 🚨)
```

DB 커밋 후 XACK 실패는 복구 가능하다 — **단, 멱등성이 있을 때만**.

## 3. 올바른 처리 순서 4단계 (불변 규칙)

```
단계 1: 멱등성 확인  → 이미 처리됐으면 즉시 XACK + 종료
단계 2: DB 트랜잭션  → 원장 업데이트, 상태 전이 등 실제 처리
단계 3: 트랜잭션 커밋 → 원자적 완료
단계 4: XACK         → PEL 제거 = "처리 완료" 선언
```

각 단계의 이유:

| 단계 | 왜 이 위치인가 |
|------|--------------|
| 멱등성 먼저 | 중복 수신 시 DB 접근 없이 즉시 처리 차단 |
| XACK 마지막 | ACK 전 장애 → PEL 재수신 가능 → 멱등성이 중복 차단 |
| DB 트랜잭션 원자성 | 원장 + 상태 전이 중 장애 시 전체 롤백 |

**XACK 실패 케이스 대응 흐름:**

```
재시작 → XREADGROUP/XAUTOCLAIM으로 PEL 재수신
     ↓
멱등성 체크: 이미 DB 커밋됨 감지
     ↓
XACK만 재실행 (DB 처리 없이)
```

이 흐름이 At-least-once를 안전하게 만드는 핵심이다.

## 4. Consumer 수평 확장 시 안전성

```
Consumer-1, Consumer-2, Consumer-3
    ↓ 같은 Consumer Group
Redis가 메시지 분배 (XREADGROUP: 먼저 호출한 쪽이 소유)
    ↓
각 Consumer는 독립적으로 멱등성 체크
    ↓
같은 메시지를 두 Consumer가 받아도 → 한 번만 처리됨
```

> 멱등성 키: `txHash + logIndex` (온체인) 또는 `requestId` (Webhook)  
> DB: `processed_events(tx_hash, log_index) UNIQUE` + `ON CONFLICT DO NOTHING`

---

# 실습 (30분)

실습 파일: `exercises/S09_atleastonce.ts` / 답안: `S09_atleastonce.answer.ts`

```bash
# dmz/packages/event-engine 폴더에서
npx ts-node src/exercises/S09_atleastonce.ts
```

**Part 1** — 멱등성 없는 Naive Processor 실행: 동일 메시지 2회 → 원장 +2 (버그) 확인  
**Part 2** — TODO: `IdempotentNftProcessor` 구현

```
TODO 구현 목록:
  [ ] eventTypes: ['NFT_ISSUED']
  [ ] const processedIds = new Set<string>()
  [ ] process(): requestId 중복 체크 → credit() → processedIds.add()
```

**완료 기준:**
- [ ] Part 1 실행 시 `❌ 중복 발행!` 출력 확인 (버그 재현)
- [ ] Part 2 구현 후 `✅ 정상` 출력 확인
- [ ] XACK 순서: process 완료 후 Worker가 자동 호출됨을 출력에서 확인
