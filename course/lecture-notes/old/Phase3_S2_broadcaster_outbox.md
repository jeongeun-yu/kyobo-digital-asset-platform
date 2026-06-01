# Phase 3 미리보기 S2 — Broadcaster/ConfirmationTracker 분리 + Outbox 패턴

> **분류**: Phase 3 이론 미리보기 (강의 25분)  
> **연결 세션**: M3 S22 (pollStaleRequests) → 이 세션은 M3 S22 이후 삽입 권장  
> **스켈레톤 참조**: `internal/packages/vasp/src/tx/Broadcaster.ts`, `ConfirmationTracker.ts`, `outbox/OutboxWorker.ts`

> **[Phase 3 — 미확정]** 교보생명 직접 VASP 인가 취득 후 구현. Phase 1에서는 해당 기능을 VASP가 대행합니다.

---

## 1. pollStaleRequests의 한계 — "단일 루프의 문제"

M3 S22에서 구현한 `pollStaleRequests`는 하나의 함수가 두 가지 역할을 한다:

```
pollStaleRequests()
  ├── TX 전송 재시도 (빠른 관심사, 초 단위)
  └── 온체인 확정 확인 (느린 관심사, 분~시간 단위)
```

이 두 관심사가 같은 루프에 있으면 어떤 문제가 생기나?

```
시나리오: TX 100건이 PENDING 상태

fast_case: TX #1~50은 mempool에 있음 → 즉각 gas bump 필요
slow_case: TX #51~100은 이미 블록에 포함됨 → Finality 기다리는 중

단일 루프 (5분 간격):
  TX #1~50: gas bump를 5분이나 기다림 → mempool에서 DROPPED 위험
  TX #51~100: 12초마다 확인하는 게 의미 없음 → Finality는 12분 걸림
```

**타임스케일이 다른 두 작업이 같은 루프에 묶이면 — 빠른 작업은 너무 느리고, 느린 작업은 너무 자주 실행된다.**

---

## 2. Broadcaster + ConfirmationTracker 분리

해결책: 타임스케일에 따라 두 개의 독립적인 서비스로 분리한다.

```
Broadcaster          빠른 루프 (10초 간격)
  책임: TX를 RPC에 전송하고 mempool 진입 확인
  관심사: "TX가 mempool에 들어갔는가?"
  대상 상태: A0_CREATED, A1_SIGNED (전송 전 Attempt)

ConfirmationTracker  느린 루프 (1분 간격)
  책임: 블록 포함 확인 → REORG 감지 → Finality 확인
  관심사: "TX가 최종 확정됐는가?"
  대상 상태: A2_SENT_TO_RPC ~ A5_CONFIRMED
```

```
┌───────────────────────────────────────────────────────┐
│                   TX 생명주기                          │
│                                                       │
│  [Broadcaster]  10초 루프                             │
│  A0_CREATED → A1_SIGNED → A2_SENT_TO_RPC             │
│                                  │                    │
│                    [ConfirmationTracker] 1분 루프      │
│                    A3_SEEN_IN_MEMPOOL → A4_INCLUDED   │
│                    → A5_CONFIRMED → A6_FINALIZED      │
└───────────────────────────────────────────────────────┘
```

**각 서비스는 자기 타임스케일에만 최적화된다.**  
Broadcaster는 전송 실패 시 수 초 안에 재시도.  
ConfirmationTracker는 블록 이벤트 구독으로 즉각 감지 (폴링 없이).

---

## 3. Phase 1의 pollStaleRequests와의 대응 관계

```
Phase 1                         Phase 3
─────────────────────────────────────────────────────
TxStateMachineService           Withdrawal (비즈니스 레이어)
  └── submitMintRequest()         └── W0_REQUESTED → W3_APPROVED → ...

pollStaleRequests()             Broadcaster (10초 루프)
  └── VASP API 조회              └── RPC.sendRawTransaction()

                                ConfirmationTracker (1분 루프)
                                └── RPC.getTransactionReceipt()
                                └── REORG 감지 (블록 해시 비교)
```

Phase 1에서 `pollStaleRequests`가 5분마다 한 번 실행하는 작업이, Phase 3에서는 두 개의 전용 서비스로 분리되어 각자의 최적 주기로 실행된다.

---

## 4. Outbox 패턴 — "DB와 외부 호출의 원자성"

### 현재 Phase 1의 문제

```
submitMintRequest() 흐름:
  1. DB INSERT: mint_requests (status=REQUESTED)  ← 성공
  2. VASP API 호출: submitMint()                   ← 성공
  3. DB UPDATE: status=SUBMITTED                   ← 실패! (네트워크 순단)

결과: DB에는 REQUESTED, VASP에는 발행이 진행 중
     → 불일치. pollStaleRequests가 30분 후에야 복구.
```

이 30분 창이 운영 이슈가 된다. 발행 상태가 틀려서 사용자가 "내 NFT는 어디에?"라고 문의할 수 있다.

### Outbox 패턴으로 해결

핵심 아이디어: **DB 트랜잭션 안에 "해야 할 외부 호출"도 함께 기록한다.**

```
단일 DB 트랜잭션 (원자적):
  INSERT mint_requests (status=REQUESTED)
  INSERT outbox_events (type=VASP_SUBMIT_MINT, payload={...}, status=PENDING)
← 커밋

OutboxWorker (별도 프로세스, 30초 간격):
  SELECT * FROM outbox_events WHERE status='PENDING' FOR UPDATE SKIP LOCKED
  → VASP API 호출
  → 성공: outbox_events.status=PROCESSED
           mint_requests.status=SUBMITTED
  → 실패: attemptCount++, nextRetryAt=now+2^attempt초
           5회 초과: status=DEAD → DLQ
```

```
┌─────────────────────────────────────────────────────┐
│  submitMintRequest()                                 │
│                                                      │
│  BEGIN TX                                            │
│    INSERT mint_requests ────────────────────────┐    │
│    INSERT outbox_events (VASP_SUBMIT_MINT) ──── │    │
│  COMMIT  ←──────── 원자적 ─────────────────────┘    │
└─────────────────────────────────────────────────────┘
                    ↓ 30초 후
┌─────────────────────────────────────────────────────┐
│  OutboxWorker                                        │
│    VASP API 호출 → 성공                              │
│    BEGIN TX                                          │
│      UPDATE mint_requests status=SUBMITTED           │
│      UPDATE outbox_events status=PROCESSED           │
│    COMMIT                                            │
└─────────────────────────────────────────────────────┘
```

**보장:**
- DB 커밋 전 크래시 → outbox_events 없음 → VASP 호출 안 됨 → 정합
- DB 커밋 후 VASP 호출 전 크래시 → outbox_events PENDING → Worker가 재시도 → 정합
- VASP 호출 후 DB UPDATE 전 크래시 → Worker 재시도 → requestId 기반 멱등 응답 → 정합

### outbox_events 테이블 (Phase 3)

```sql
CREATE TABLE outbox_events (
  id             UUID PRIMARY KEY,
  type           VARCHAR(64) NOT NULL,   -- VASP_SUBMIT_MINT | LEDGER_UPDATE_HOLDING | ...
  payload        JSONB NOT NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  attempt_count  INT NOT NULL DEFAULT 0,
  next_retry_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_pending ON outbox_events (status, next_retry_at)
  WHERE status = 'PENDING';   -- 처리 대상만 인덱싱
```

`FOR UPDATE SKIP LOCKED` — 동시 워커 여러 개가 같은 이벤트를 중복 처리하지 않는 PostgreSQL 기능.

---

## 5. 중복 방지 4대 안전장치 (Custody Track S6 핵심)

Phase 1에서도 3개는 이미 구현되어 있다. Phase 3에서 Outbox까지 추가하면 완전해진다.

| 장치 | Phase 1 구현 여부 | 역할 |
|---|---|---|
| ① 단방향 상태머신 | ✅ VALID_TRANSITIONS 가드 | 잘못된 전이 차단 |
| ② DB UNIQUE 제약 | ✅ processed_events(tx_hash, log_index) | 중복 이벤트 차단 |
| ③ Append-only 감사 로그 | ✅ AuditLogService | 삭제·수정 불가 기록 |
| ④ Outbox Pattern | ❌ Phase 3에서 추가 | DB-외부 시스템 원자성 |

---

## 6. 5대 통합 식별자 프레임워크

장애 발생 시 "이 TX가 뭔지"를 추적하려면 여러 시스템(DB, VASP, RPC, 감사로그)에서 동일한 식별자로 조회할 수 있어야 한다.

| 식별자 | 생성 시점 | 추적 목적 |
|---|---|---|
| `withdrawal_id` | 비즈니스 요청 생성 시 | 사용자 요청 전체 생명주기 |
| `attempt_id` | TxAttempt 생성 시 | 특정 TX 전송 시도 |
| `idempotency_key` | API 요청 시 | 동일 요청 중복 방지 |
| `nonce_key` | Nonce 할당 시 | `(chainId, address, nonce)` 조합 — 체인 레벨 유일성 |
| `tx_hash` | TX 전송 후 | 온체인 조회 기준 |

Phase 1 현재: `MintRequest.id`가 `withdrawal_id`와 `idempotency_key`를 겸한다. TX 수가 적고 VASP가 중간에서 처리해 주어 충분.

Phase 3: 5개 식별자 각각이 독립적으로 관리되어야 추적·디버깅·감사가 가능해진다.

---

## 완료 기준 (이론 이해 확인)

- [ ] pollStaleRequests의 단일 루프 한계를 타임스케일 관점에서 설명 가능
- [ ] Broadcaster와 ConfirmationTracker가 각각 무엇을 담당하는지 설명 가능
- [ ] Outbox 패턴이 해결하는 문제 (DB-외부 호출 원자성)를 시나리오로 설명 가능
- [ ] `FOR UPDATE SKIP LOCKED`가 중복 처리를 막는 원리 설명 가능
- [ ] 중복 방지 4대 안전장치 순서대로 열거 가능
- [ ] 5대 통합 식별자 각각의 역할 설명 가능
