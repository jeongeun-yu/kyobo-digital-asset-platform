# Phase 3 미리보기 S1 — TX 실행 두 레이어 분리: Withdrawal + TxAttempt

> **분류**: Phase 3 이론 미리보기 (강의 30분)  
> **연결 세션**: M3 S13 (TX 상태머신) → 이 세션은 M3 S22 이후 삽입 권장  
> **스켈레톤 참조**: `dmz/packages/vasp/src/tx/TxAttempt.ts`

---

## 왜 이 세션이 필요한가

M3 S13에서 구현한 `MintRequest` 상태머신은 Phase 1에서 충분하다.  
월렛원(VASP)이 체인 레이어를 대신 처리해 주기 때문이다.

하지만 Phase 3에서 교보가 직접 VASP를 운영하면 — 지금까지 월렛원이 알아서 처리하던 문제들이 전부 교보의 책임이 된다.

그 중 가장 먼저 부딪히는 문제가 있다:

> **gas bump를 실행하면 TX hash가 바뀐다. 그런데 `MintRequest.txHash`를 덮어쓰면 이전 TX의 이력이 사라진다.**

이게 왜 문제인지, 어떻게 해결하는지가 이 세션의 핵심이다.

---

## 1. Phase 1 모델의 한계

현재 `MintRequest` 단일 레이어:

```
MintRequest
  id: "req-001"
  status: PENDING
  txHash: "0xAAA"   ← gas bump 후 "0xBBB"로 덮어씀
  retryCount: 2
```

**gas bump가 3번 일어났다고 가정:**

```
1번 TX: 0xAAA (gasPrice 10 Gwei) → mempool stuck
2번 TX: 0xBBB (gasPrice 12 Gwei) → mempool stuck
3번 TX: 0xCCC (gasPrice 14.4 Gwei) → 채굴됨
```

`MintRequest.txHash = "0xCCC"` — 최종 TX만 남는다.

질문들이 생긴다:
- 0xAAA, 0xBBB는 어떻게 됐나? DROPPED됐나? REPLACED됐나?
- 총 3번 재전송에서 수수료를 얼마나 낭비했나?
- 왜 2번째에서 안 되고 3번째에서 됐나? 가스 부족이었나?

**단일 레이어로는 이 질문에 답할 수 없다.**

---

## 2. 두 레이어 분리 — Withdrawal vs TxAttempt

해결책은 **비즈니스 단위**와 **체인 실행 단위**를 분리하는 것이다.

```
비유: 항공편 예약 vs 실제 비행편

  예약 (비즈니스)  — "서울 → 도쿄 왕복"  (KE1번 예약 번호)
  비행편 (실행)   — 실제 비행기 KE717편, KE718편
                   편명이 바뀌어도 예약은 유지됨
```

블록체인도 동일하다:

```
Withdrawal (비즈니스 단위)
  "user-001에게 tokenId #1001 NFT 1개 발행"
  상태: 요청됨 → 승인됨 → 완료됨
  변하지 않음

TxAttempt (체인 실행 단위)
  "Nonce 47, gasPrice 10 Gwei로 TX 전송"
  Attempt 1: 0xAAA → DROPPED (가스 부족)
  Attempt 2: 0xBBB → REPLACED (gas bump)
  Attempt 3: 0xCCC → INCLUDED → FINALIZED ← 성공
```

```
Withdrawal.id = "W-001"  (1개, 불변)
    │ 1:N
    ├── TxAttempt #0: 0xAAA, Nonce=47, gasPrice=10 → DROPPED
    ├── TxAttempt #1: 0xBBB, Nonce=47, gasPrice=12 → REPLACED
    └── TxAttempt #2: 0xCCC, Nonce=47, gasPrice=14.4 → A6_FINALIZED ✅
```

---

## 3. TxAttempt 상태머신 (11종)

스켈레톤: `dmz/packages/vasp/src/tx/TxAttempt.ts`

```
정상 흐름:
  A0_CREATED → A1_SIGNED → A2_SENT_TO_RPC → A3_SEEN_IN_MEMPOOL
    → A4_INCLUDED → A5_CONFIRMED → A6_FINALIZED

비정상:
  FAILED           — 시스템 오류 (서명 실패, RPC 연결 끊김 등)
  DROPPED          — mempool에서 제거 (가스 부족으로 우선순위 밀림)
  REPLACED         — 동일 Nonce로 다른 TX 대체 (gas bump)
  REVERTED         — EVM 컨트랙트 REVERT (조건 미충족)
  RPC_INCONSISTENT — 두 RPC 응답이 불일치 → 수동 확인 필요
```

**Phase 1의 `REORGED`가 여기서 없는 이유:**  
REORG는 Withdrawal 레벨에서 처리. Attempt가 A4_INCLUDED된 블록이 사라지면 해당 Attempt는 DROPPED로, Withdrawal은 다시 W7_INCLUDED 이전으로 롤백.

---

## 4. 6가지 예외 처리 — "왜 이렇게 많이 필요한가"

Phase 1에서는 REVERT, TIMEOUT, REORG 3종만 다뤘다.  
직접 Custody 운영에서 추가로 발생하는 3종:

| 예외 | 발생 조건 | 처리 |
|---|---|---|
| DROPPED | mempool 포화 → 우선순위 낮은 TX 제거 | gas bump로 새 Attempt 생성 |
| REPLACED | 동일 Nonce로 다른 TX 채굴됨 | 기존 Attempt REPLACED 처리 |
| RPC_INCONSISTENT | RPC-A: confirmed, RPC-B: not found | 수동 확인 → 알람 발송 |

**DROPPED vs REPLACED 차이:**

```
DROPPED:   TX가 아직 mempool에 있다가 제거됨
           → 온체인에 아무 흔적 없음
           → 같은 Nonce로 재전송 가능

REPLACED:  동일 Nonce로 다른 TX가 먼저 채굴됨
           → 이 TX는 영구 폐기
           → 원인 파악 필요 (내가 gas bump했나? 외부가 같은 Nonce를 사용했나?)
```

---

## 5. DB 스키마 — tx_attempts 테이블

```sql
-- Phase 3 마이그레이션
CREATE TABLE tx_attempts (
  id              UUID PRIMARY KEY,
  mint_request_id UUID NOT NULL REFERENCES mint_requests(id),
  chain_id        VARCHAR(32) NOT NULL,
  from_address    VARCHAR(42) NOT NULL,
  to_address      VARCHAR(42) NOT NULL,
  nonce           INT NOT NULL,
  tx_hash         VARCHAR(66),
  -- EIP-1559 수수료
  max_fee_per_gas         NUMERIC,
  max_priority_fee_per_gas NUMERIC,
  block_number    BIGINT,
  status          VARCHAR(32) NOT NULL DEFAULT 'A0_CREATED',
  revert_reason   TEXT,
  attempt_index   INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 핵심 제약: 같은 (체인, 주소, Nonce) 조합은 활성 Attempt 하나만
  UNIQUE (chain_id, from_address, nonce)
    DEFERRABLE INITIALLY DEFERRED  -- gas bump 시 REPLACED 처리 후 새 행 삽입
);

CREATE INDEX idx_tx_attempts_request ON tx_attempts(mint_request_id);
CREATE INDEX idx_tx_attempts_status  ON tx_attempts(status)
  WHERE status NOT IN ('A6_FINALIZED', 'FAILED', 'DROPPED', 'REPLACED', 'REVERTED');
```

`UNIQUE (chain_id, from_address, nonce)` — **이 한 줄이 Nonce 중복 방지의 전부다.**

---

## 6. Phase 1 → Phase 3 마이그레이션 경로

```
Phase 1 (현재):
  MintRequest.txHash ← gas bump 시 덮어씀
  VASP(월렛원)이 Nonce 관리

Phase 3 (직접 Custody):
  MintRequest (Withdrawal 역할)
      │ 1:N
  TxAttempt (체인 실행 단위)
  NonceManager가 Nonce 직접 할당

마이그레이션 전략:
  1. tx_attempts 테이블 생성
  2. 기존 mint_requests를 Withdrawal로 유지
  3. 신규 발행 요청부터 TxAttempt 생성
  4. 구버전/신버전 병행 기간 → 완전 전환
```

---

## 완료 기준 (이론 이해 확인)

- [ ] 왜 단일 레이어(MintRequest)로는 gas bump 이력 추적이 안 되는지 설명 가능
- [ ] Withdrawal vs TxAttempt 두 레이어 분리 이유 설명 가능
- [ ] DROPPED와 REPLACED의 차이 설명 가능
- [ ] `UNIQUE(chain_id, from_address, nonce)` 제약이 하는 역할 설명 가능
- [ ] Phase 1 → Phase 3 마이그레이션 경로 설명 가능
