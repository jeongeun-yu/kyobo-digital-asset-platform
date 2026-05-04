# Custody Track → 교보생명 커리큘럼 개념 반영도 분석 리포트

> 작성일: 2026-05-04  
> 분석 대상: Custody Track Session 2·3·5·6 vs 교보생명 커리큘럼 (M1~M8, S1~S58)

---

## 요약 판정

| Custody 세션 | 반영도 | 판정 |
|---|---|---|
| Session 2: Reference Architecture | 40% | ⚠️ 부분 반영 — 핵심 개념 누락 다수 |
| Session 3: Withdrawal Lifecycle | 35% | 🔴 미반영 다수 — 두 레이어 분리가 핵심 누락 |
| Session 5: Multi-Chain Abstraction | 60% | ⚠️ 부분 반영 — 전체 틀은 있으나 심화 내용 미포함 |
| Session 6: Reliability Design | 50% | ⚠️ 부분 반영 — 핵심 패턴은 있으나 체계 미흡 |

---

## Session 2: Custody Reference Architecture — 7모듈 커스터디 아키텍처

### 커스터디 S2 핵심 개념 목록

| 개념 | 교보 커리큘럼 반영 | 위치 | 비고 |
|---|---|---|---|
| 7모듈 커스터디 아키텍처 전체 | ⚠️ 부분 | M1 (전체 아키텍처) | 커스터디 전용 독립 Custody 서비스 프레임으로 교육하지 않음 |
| Policy Engine 모듈 | ❌ 없음 | — | 교보는 조건 판단 (M5 S30)에 있지만 Policy 결재 레이어가 없음 |
| Approval 모듈 (다중 서명 승인) | ✅ 있음 | M8 S46~S48 | Gnosis Safe 2-of-3 서명으로 충분히 커버 |
| Signer 모듈 (HSM/MPC) | ⚠️ 일부 | M8 S46 | HSM 개념만 언급, MPC와 비교표 없음 |
| HSM vs MPC 하드웨어 비교표 | ❌ 없음 | — | 커스터디 S2의 핵심 내용이나 교보 커리큘럼에 없음 |
| Signer Input Contract (서명 입력 명세) | ❌ 없음 | — | request_id, attempt_id, deadline, policy_decision_id 등 필드 체계 없음 |
| Broadcaster 모듈 | ⚠️ 일부 | M3 S20 | gas bump 구현에 포함되어 있으나 독립 모듈로 교육 안 함 |
| Confirmation Tracker 모듈 | ⚠️ 일부 | M3 S22 | pollStaleRequests로 구현하나 Broadcaster와 분리 교육 없음 |
| Internal Ledger 4단계 잔액 모델 | ❌ 없음 | — | Available/Reserved/Pending/Settled 구분 없음 |
| 화이트리스트 주소 상태머신 | ❌ 없음 | — | REGISTERED→APPROVAL_PENDING→HOLDING(48h)→ACTIVE/REJECTED |
| 정책 변경 상태머신 | ❌ 없음 | — | PROPOSED→QUORUM_APPROVED→DELAYED(24~72h)→APPLIED/REJECTED |
| 입금(Deposit) 감지 파이프라인 | ❌ 없음 | — | Deposit Detector→AML→Ledger Pending→Settled 흐름 없음 |
| AML 스크리닝 통합 | ⚠️ 일부 | M5 S29 | EIP-191 서명 검증 있음, AML 주소 스크리닝은 screenAddress() 인터페이스 정의에만 등장 |
| 조정(Reconciliation) 설계 | ✅ 있음 | M4 S25 | ReconcileService로 충분히 커버 |
| 감사 로그 체계 | ✅ 있음 | M4 S26 | SHA-256 체인 무결성까지 커버 |

### 교보 커리큘럼 부재 상위 3개 개념 (Session 2 기준)

**① Internal Ledger 4단계 잔액 모델**

커스터디 S2에서는 고객 자산을 다음 4단계로 구분해 관리한다:
```
Available  — 인출 가능한 실제 잔액
Reserved   — 인출 요청 승인 시점에 잠긴 금액 (출금 중 이중 사용 방지)
Pending    — TX 브로드캐스트 후 온체인 확정 대기 중
Settled    — 온체인 Finalized 후 최종 정산 완료
```
교보 커리큘럼은 `mint_requests` 상태머신으로 TX 추적만 하고, 금액이 이중 인출되지 않도록 선제적으로 잠그는 `Reserved` 개념이 없다.

**② 화이트리스트/정책 상태머신**

출금 주소 화이트리스트 등록 → 48시간 대기(HOLDING) → ACTIVE 흐름은 내부 통제의 핵심이다. 교보 커리큘럼에서 지갑 주소 검증은 EIP-191 서명(M5 S29)으로 처리하지만, "등록 후 대기 기간"과 "승인 큐" 개념은 없다.

**③ HSM vs MPC 비교 및 Signer Input Contract**

어떤 키 관리 방식을 쓰는지(HSM 단독 / MPC 분산)와 서명 요청에 포함되어야 하는 필드 명세(`attempt_id`, `policy_decision_id`, `signing_scope`, `deadline`)가 없다. 교보 커리큘럼은 Gnosis Safe 서명에 집중되어 있어, VASP-to-Blockchain 레이어의 키 관리 체계를 다루지 않는다.

---

## Session 3: Withdrawal Lifecycle — 두 레이어 분리 모델

### 커스터디 S3 핵심 개념 목록

| 개념 | 교보 커리큘럼 반영 | 위치 | 비고 |
|---|---|---|---|
| Withdrawal(비즈니스) vs TxAttempt(체인) 분리 | 🔴 없음 | — | 교보는 MintRequest 단일 레이어 |
| Withdrawal 10단계 상태머신 (W0~W10) | 🔴 없음 | — | 교보 8상태는 기술 TX 추적 전용 |
| TxAttempt 7단계 상태머신 (A0~A6) | 🔴 없음 | — | 개념 자체가 없음 |
| 예외 6종 분류 체계 | ⚠️ 일부 | M3 S18~S19 | REVERT/TIMEOUT/REORG 3종만. DROPPED/REPLACED/RPC_INCONSISTENT 없음 |
| Nonce 관리 전담 모듈 | ⚠️ 일부 | M3 S20 | gas bump에서 Nonce 등장하나 독립 모듈 아님 |
| Nonce 갭(gap) 감지 및 복구 | ❌ 없음 | — | 커스터디 S3의 핵심 운영 시나리오 |
| RESERVE→SETTLE 2단계 원장 패턴 | ❌ 없음 | — | 교보는 PENDING→CONFIRMED 단순 전이 |
| Replace-by-Fee (RBF) 전략 체계 | ⚠️ 일부 | M3 S20 | gas bump(1.2배) 구현 있으나 RBF를 명시적 전략으로 교육 안 함 |
| Speed-up / Cancel TX 개념 | ❌ 없음 | — | 동일 Nonce 재사용 전략의 세부 분기 없음 |

### 가장 큰 구조적 갭: 단일 레이어 vs 두 레이어

커스터디 S3의 핵심은 **비즈니스 단위(Withdrawal)와 체인 실행 단위(TxAttempt)를 분리**하는 것이다.

```
[커스터디 S3 모델]
Withdrawal (business)   W0_REQUESTED → W3_APPROVED → W9_LEDGER_POSTED → W10_COMPLETED
    │ 1:N
TxAttempt  (chain)      A0_CREATED → A2_SENT_TO_RPC → A4_INCLUDED → A6_FINALIZED
                               ↘ REPLACED (gas bump 시 이전 Attempt 종료)
                               ↘ DROPPED (mempool에서 제거)
```

```
[교보 커리큘럼 모델]
MintRequest (단일)      PENDING → SUBMITTED → MINED → FINALIZED → CONFIRMED
                              ↘ FAILED
                              ↘ REORGED → MINED (재처리)
```

**교보 모델의 한계:**
- gas bump 발행 시 `tx_hash`를 덮어쓰는 방식 → "이전 TX가 어떻게 됐나"를 추적 불가
- 한 발행 요청에서 몇 번 재전송했는지 이력 없음
- REPLACED 상태(동일 Nonce로 다른 TX 대체됨)를 표현할 자리 없음
- 비즈니스 관점("이 사용자의 NFT 발행 요청은 결국 어떻게 됐나")과 체인 관점("이 TX는 실제로 어떤 상태인가")이 혼재

**실무 영향:** 커스터디 규모에서 Nonce 갭 발생 시 교보 모델로는 어떤 Attempt가 살아있는지 판단 불가. VASP(월렛원)가 대신 처리해 주는 Phase 1에서는 숨어있는 문제이나, Phase 3 직접 Custody 전환 시 반드시 두 레이어 분리가 필요하다.

---

## Session 5: Multi-Chain Abstraction — 멀티체인 추상화 심화

### 커스터디 S5 핵심 개념 목록

| 개념 | 교보 커리큘럼 반영 | 위치 | 비고 |
|---|---|---|---|
| EVM Account 모델 (nonce 기반) | ✅ 있음 | M3 S19, S20 | Nonce, gas bump 상세 설명 |
| UTXO 모델 (Bitcoin) | ❌ 없음 | — | IBlockchainAdapter의 `chainType: 'UTXO'`만 있음 |
| Cosmos Account 모델 (account_number + sequence) | ❌ 없음 | — | — |
| Solana Durable Nonce | ❌ 없음 | — | — |
| EIP-1559 수수료 구조 (Base/Priority/Max Fee) | ❌ 없음 | — | gas bump만 있고 EIP-1559 3요소 설명 없음 |
| Finality 모델 분류 체계 | ⚠️ 일부 | M3 S19 | PoS MINED/FINALIZED/CONFIRMED만. PoW 확률적, BFT 즉시 등 분류 없음 |
| RPC 불완전성 대응 (multi-RPC + quorum) | ❌ 없음 | — | 교보는 단일 RPC 가정 |
| RPC 저하 모드 5단계 | ❌ 없음 | — | NORMAL/DEGRADED_READ/DEGRADED_WRITE/MANUAL_APPROVAL_ONLY/STOP_THE_LINE |
| 어댑터 설계 7원칙 | ⚠️ 일부 | M3 S14 | IBlockchainAdapter 전체 설계는 있으나 7원칙 명시 프레임워크 없음 |
| Nonce 전략 분류 (Serial/Pipelined/Pinned) | ❌ 없음 | — | 전략 선택 기준 없음 |
| feePolicyId 체계 (NORMAL/FAST/SURGE) | ❌ 없음 | — | 수수료 정책 객체화 없음 |
| prepareSend / broadcast / getTxStatus / getHeads 4메서드 | ⚠️ 일부 | M3 S14, S15 | 교보는 mintNFT / subscribeEvents / queryEvents 중심 |

### 교보 커리큘럼이 잘 커버한 부분

- **IBlockchainAdapter Strategy Pattern** (M3 S14): EVM/XRPL/Circle 3체인 비교, DI 기반 교체 패턴, `chainType` 구분 — 충분히 커버
- **subscribeEvents vs queryEvents 이중 채널** (M3 S14): Finalized 범위 조회 이유, 재시작 후 missed event 복구 — 커스터디 S5보다 오히려 상세함

### 주요 누락: EIP-1559와 RPC 다중화

**EIP-1559 (London 하드포크 이후 표준)**는 현재 Ethereum mainnet의 기본 수수료 구조이다:
```
실제 납부 = min(MaxFee, BaseFee + PriorityFee)
BaseFee:     네트워크 혼잡도에 따라 프로토콜이 자동 결정 (소각됨)
PriorityFee: 채굴자/검증자에게 지불하는 팁
MaxFee:      사용자가 설정하는 최대 납부 한도
```
gas bump 시 `gasPrice * 1.2`라는 교보의 접근은 EIP-1559 이전 Legacy TX 방식이다. 실무에서는 `maxPriorityFeePerGas * 1.1` + `maxFeePerGas` 조정이 필요하다.

---

## Session 6: Reliability Design — 신뢰성 설계 체계

### 커스터디 S6 핵심 개념 목록

| 개념 | 교보 커리큘럼 반영 | 위치 | 비고 |
|---|---|---|---|
| Broadcaster vs Confirmation Tracker 분리 | ❌ 없음 | — | 교보는 TxStateMachineService 단일 서비스 |
| Idempotency 3요소 (API level + DB UNIQUE + chain level) | ✅ 있음 | M3 S16 | requestId + UNIQUE 제약 상세 커버 |
| Replay Protection (EIP-155 chainId) | ❌ 없음 | — | 내부 식별자 체계만 있음 |
| Exponential Backoff + Jitter | ✅ 있음 | M3 S17 | Thundering Herd, 429 Rate Limit까지 커버 |
| 중복 방지 4대 안전장치 | ⚠️ 일부 | 여러 세션에 분산 | (1)단방향 상태머신 ✅, (2)DB UNIQUE ✅, (3)append-only ✅, (4)Outbox ❌ |
| Outbox Pattern | ❌ 없음 | — | 교보는 직접 DB→VASP 호출 |
| 5대 통합 식별자 체계 | ❌ 없음 | — | withdrawal_id/attempt_id/idempotency_key/nonce_key/tx_hash 프레임워크 없음 |
| 운영 KPI 지표 세트 | ⚠️ 일부 | M8 S58 | 교보는 DLQ/Consumer/VASP 지표. time_to_broadcast 등 체인 레이턴시 KPI 없음 |
| 멀티 티어 알람 설계 | ⚠️ 일부 | M8 S58 | 교보도 알람 커버하나 심각도 계층 없음 |
| 운영 KPI: time_to_broadcast | ❌ 없음 | — | VASP SLA 지표만 있음 |
| 운영 KPI: time_to_inclusion | ❌ 없음 | — | — |
| 운영 KPI: time_to_safe / time_to_finalized | ❌ 없음 | — | — |
| 운영 KPI: dropped_count / reorged_out_count | ❌ 없음 | — | — |
| 운영 KPI: pending_age_p95 | ❌ 없음 | — | — |

### 가장 큰 누락: Broadcaster vs Confirmation Tracker 분리 + Outbox

**커스터디 S6의 핵심 설계 결정:**

```
Broadcaster          빠른 재시도, 짧은 주기 (초 단위)
  ├ TX 전송 즉시 재시도
  ├ 전송 실패 → 수 초 이내 재시도
  └ 관심사: "TX가 mempool에 들어갔는가"

Confirmation Tracker 느린 추적, 긴 주기 (분~시간 단위)
  ├ 블록 포함 확인
  ├ REORG 감지
  └ 관심사: "TX가 최종 확정됐는가"
```

교보 커리큘럼의 `pollStaleRequests` (M3 S22)는 두 역할을 하나의 폴링 루프로 처리한다. 이는 Phase 1 규모에서 충분하나, 커스터디 규모의 TX 수(수백~수천 건/일)에서는 타임스케일이 다른 두 루프가 서로 간섭한다.

**Outbox Pattern 누락:**

커스터디 S6에서는 "DB 트랜잭션과 외부 호출의 원자성"을 Outbox로 해결한다:
```
[Outbox Pattern]
  DB 트랜잭션: mint_requests INSERT + outbox_events INSERT (원자적)
  별도 worker: outbox_events → VASP API 호출 → 성공 시 DELETE

[교보 현재 방식]
  mint_requests INSERT 후 → 직접 VASP API 호출
  → DB 커밋 후 VASP 호출 실패 시 → DB는 PENDING, VASP는 미전송 → 불일치
```

---

## 교보 커리큘럼이 독자적으로 우수한 부분

커스터디 교육에 없거나 얕게 다룬 내용 중 교보 커리큘럼이 더 깊이 다루는 영역:

| 교보 커리큘럼 강점 | 위치 |
|---|---|
| ERC-1155 토큰 설계 (비보험/건강/특약 인코딩) | M6 S35 |
| UUPS 프록시 업그레이드 패턴 전체 | M6 S36~S40 |
| Storage Layout 충돌 검증 | M6 S40 |
| Slither 정적 분석 + Reentrancy Guard | M7 S41~S42 |
| EIP-191 서명 기반 지갑 인증 | M5 S29 |
| Redis Streams Consumer Group 전체 | M2 S7~S12 |
| DLQ 운영 절차 + Runbook | M2 S51~S52 |
| Travel Rule 100만원 임계값 | M8 S49 |
| SHA-256 감사 로그 체인 무결성 | M4 S26 |

---

## 종합 권고사항

### 1순위 — Phase 1 완료 후 Phase 3 전환 시 추가 필요한 핵심 개념

| 개념 | 추가 위치 제안 |
|---|---|
| Withdrawal vs TxAttempt 두 레이어 분리 설계 | M3 S13 이론 보강 또는 M3 심화 세션 추가 |
| Internal Ledger 4단계 잔액 (RESERVE→SETTLE) | M4 S23 이후 M4 심화로 추가 |
| Broadcaster vs Confirmation Tracker 분리 | M3 S22 이후 아키텍처 토론으로 추가 |
| Nonce 갭 감지·복구 시나리오 | M3 S20 실습에 시나리오 추가 |

### 2순위 — 실무 적용 시 알아야 할 심화 내용

| 개념 | 추가 위치 제안 |
|---|---|
| EIP-1559 수수료 구조 | M3 S19~S20 이론 보강 |
| HSM vs MPC 키 관리 비교 | M8 S46 보강 |
| 체인 레이턴시 KPI (time_to_broadcast 등) | M8 S58 보강 |
| RPC 다중화·저하 모드 | M3 S14 또는 S53 운영 세션 보강 |

### 3순위 — Phase 1 범위 내 추가 시 교육 효과 있는 내용

| 개념 | 추가 위치 제안 |
|---|---|
| 화이트리스트 주소 상태머신 | M5 S27~S28 지갑 프로비저닝 보강 |
| Outbox Pattern | M3 S16 멱등성 세션 심화 |
| 5대 통합 식별자 프레임워크 | M3 S13 이론 정리에 포함 |

---

## 결론

교보생명 커리큘럼은 **NFT 발행 파이프라인** (Redis Streams → VASP → TX 상태머신 → 원장)을 매우 완성도 높게 다루고 있으며, TX 상태머신(8상태 FINALIZED 포함), 멱등성, 감사 로그, 멀티체인 어댑터 설계는 커스터디 교육 수준과 대등하거나 더 상세하다.

**주요 갭은 구조적 성격**에 있다:

1. **단일 MintRequest vs 두 레이어(Withdrawal + TxAttempt)** — Phase 3 직접 Custody 전환 시 리팩터링 필요
2. **Reserved 잔액 모델 부재** — 동시 출금 요청 시 이중 사용 방어 메커니즘 없음
3. **Broadcaster/Confirmation Tracker 분리** — TX 수가 늘어날 때 단일 폴링 루프의 한계
4. **EIP-1559 수수료 구조** — gas bump 로직이 Legacy TX 방식

Phase 1 목표(교보생명 내부 NFT 발행 파이프라인 구축)에는 현재 커리큘럼이 충분하다. 커스터디 개념은 Phase 3 전환 시점에 별도 심화 과정으로 다루는 것이 적합하다.
