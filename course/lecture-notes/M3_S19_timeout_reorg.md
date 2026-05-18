# M3 S19 — TX TIMEOUT과 REORG 복구 전략 원리

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.  
> **Phase 1 맥락:** TIMEOUT 발생 시 VASP로부터 Webhook 수신이 지연된 것입니다. `pollStaleRequests()`가 `IBlockchainAdapter.getReceipt()`를 통해 on-chain 상태를 조회하여 복구합니다.

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S19 · 강의 55분  
> 대상: `internal/packages/vasp/src/tx/TxStateMachineService.ts`

---

## S19 — TX TIMEOUT과 REORG 원리

> **강의 55분** — 이론 중심 세션. 실습 없음.

---

### 0. 이론 도입 — "TX가 채굴됐다"는 것이 정말 확정인가?

```
직관적 가정 (틀림):
  TX 제출 → 채굴됨 → 완료 ✅

실제 블록체인:
  TX 제출
    │
    ├── [TIMEOUT] 아예 채굴이 안 될 수 있다 (mempool stuck)
    │
    ├── [REVERT]  채굴됐지만 실패했다 (receipt.status = 0)
    │
    └── [REORG]   채굴됐지만 나중에 취소될 수 있다 (블록 재편)

  "채굴 완료" ≠ "최종 확정"
  "채굴 완료" = "현재 체인에서 유효한 상태" (아직 REORG 가능)
  "최종 확정" = Finality 도달 후 (수학적으로 번복 불가)
```

**S18이 REVERT를 다뤘다면, S19는 TIMEOUT과 REORG를 다룬다.**

---

### 0-2. Mempool의 개념 — TX 대기소

```
블록체인 네트워크 참여자들의 TX 처리 흐름:

  사용자 A: TX1 전송 (gasPrice = 50 gwei)
  사용자 B: TX2 전송 (gasPrice = 30 gwei)
  사용자 C: TX3 전송 (gasPrice = 10 gwei)

  ┌─────────────────────────────────────────┐
  │  mempool (전세계 노드가 공유하는 대기소) │
  │                                          │
  │  [TX1: 50 gwei] ← 우선순위 높음         │
  │  [TX2: 30 gwei]                          │
  │  [TX3: 10 gwei] ← 우선순위 낮음         │
  └─────────────────────────────────────────┘
         │
         │  검증자(Validator)가 블록 생성 시
         │  gas price 높은 순서로 선택
         ▼
  [블록 #12345: TX1, TX2 포함] ← TX3 미포함 (gas 부족)

  TX3는 다음 블록을 기다리지만...
  → 네트워크 혼잡으로 gas price가 계속 높으면
  → TX3는 계속 밀림 → Stuck 상태
```

---

### 0-3. REORG 비유 — 회사 이사회 결의

```
비유: 이사회에서 안건을 결의했다.

일반 상황 (단일 체인):
  이사회 → 결의 → 의사록 작성 → 확정 ✅

REORG 상황:
  이사회가 두 곳에서 동시에 진행됨 (포크)
  
  이사회 A (7명 참석): 안건 가결 → 의사록 A 작성
  이사회 B (5명 참석): 안건 가결 → 의사록 B 작성

  실제로는 이사회가 하나여야 함
  → 더 많은 이사가 참석한 A 의사록이 최종 채택
  → B 의사록은 무효
  → B 의사록에서 처리된 사안들도 모두 무효

블록체인 REORG:
  체인 A (더 많은 해시파워/스테이크): 채택됨
  체인 B: 고아 블록 (Orphan) 됨
  체인 B에 포함된 TX: mempool로 복귀 or 소실
```

---

### 1. TX TIMEOUT — Mempool Stuck 원리

**블록체인 TX 처리 흐름:**

```
사용자(VASP) → TX 브로드캐스트
     ↓
mempool (대기 풀)
     ↓
채굴자(Validator)가 mempool에서 TX 선택
     ↓
선택 기준: Gas Price 높은 순서 (EIP-1559: Priority Fee)
     ↓
블록에 포함 → 채굴 완료
```

**TIMEOUT 발생 경로:**

```
상황: 네트워크 혼잡 시 Gas Price 급등
→ VASP가 낮은 Gas Price로 TX 전송
→ 채굴자가 더 높은 Gas Price TX를 우선 선택
→ 우리 TX는 mempool에서 대기 (Stuck)
→ 30분 이상 채굴 안 됨 → TIMEOUT 감지
```

**Nonce 관리 원칙:**

```
EVM 계정은 Nonce 순서대로 TX 처리
  Nonce 0 처리됨
  Nonce 1 처리됨
  Nonce 2: stuck (gas 부족)
  Nonce 3: 제출했지만 → Nonce 2 처리 전까지 절대 처리 안 됨

→ Stuck TX 1개가 이후 모든 TX 블로킹
→ 즉각 대응 필요
```

### 2. Gas Bump — Replace-by-Fee (RBF)

```
해결: 동일 Nonce로 더 높은 Gas Price TX 재전송
     새 TX의 Gas Price > 기존 TX Gas Price × 1.1 이상 (EIP-1559 기준)
     → mempool에서 기존 TX 자동 교체
     → 채굴자가 새 TX 선택

TxStateMachineService.ts:104
  private static readonly GAS_BUMP_PERCENT = 20;  // 20% 인상
```

```
기존 TX: gasPrice = 20 gwei, Nonce = 5, status = stuck
gas bump: gasPrice = 24 gwei (20% 인상), Nonce = 5 (동일)
→ mempool에서 교체됨
→ 새 txHash로 채굴 진행
```

**주의 — Idempotency 유지 필요:**

```
원래 TX가 나중에 채굴될 수도 있음 (network lag)
→ 두 TX 모두 채굴되면?
→ requestId 기반 Idempotency가 컨트랙트 레벨에서 중복 방어
→ 두 번째 TX는 컨트랙트 내 requestId 중복 체크로 REVERT
→ FAILED 처리 (의도된 결과)
```

### 3. REORG 발생 원리

**PoS 네트워크의 단기 Fork:**

```
블록 #100 — Validator A 제안
     ├── Chain A: #100-A → #101-A → #102-A
     └── Chain B: #100-B → #101-B

두 Validator가 거의 동시에 블록 제안
→ 잠시 Fork 상태
→ 다수 Validator가 Chain A를 지지
→ Chain B가 고아 블록(Orphan)이 됨
→ Chain B의 TX들이 소실
```

**우리 TX가 Chain B에 있었다면:**

```
Chain B의 NFT 발행 TX가 소실
→ receipt는 있었지만 → TX 없어짐
→ 원장에 발행 기록 있음 (M2 ConsumerGroupWorker가 처리)
→ 온체인에는 NFT 없음
→ 데이터 불일치 🚨
```

### 4. CONFIRMED vs FINALIZED 차이

```
CONFIRMED (= 우리 시스템의 MINED 이후)
  = 블록에 포함됨
  = 단기 REORG 가능
  = Ethereum PoS에서 ~2 에포크(약 12분) 이전까지는 이론상 가능

FINALIZED
  = 2/3+ validator가 서명한 Checkpoint 통과
  = 절대 불변 — 수학적으로 번복 불가
  = M2 S12에서 배운 것: Finalized 이후에만 원장 업데이트
```

**실용적 REORG 빈도:**

```
현실: Ethereum mainnet에서 1~2블록 REORG는 드물게 발생
     2블록 이상 REORG는 매우 드묾
     6블록 이후면 사실상 확정 (Bitcoin 기준, PoS는 더 빠름)

우리 시스템: REORG_WAIT_BLOCKS = 5 (TxStateMachineService.ts:107)
     → MINED 후 5블록 대기 → VASP 재조회 (FINALIZED 이전에만 REORG 가능)
```

### 5. 3종 복구 전략 요약

| 유형 | 발생 조건 | 감지 방법 | 복구 전략 |
|---|---|---|---|
| **REVERT** | 컨트랙트 조건 미충족 | `receipt.status = 0` + revertReason | 즉시 FAILED, reason 저장, 재시도 없음 |
| **TIMEOUT** | Gas 부족으로 mempool stuck | PENDING 30분 초과 (pollStaleRequests) | Gas 20% bump + 동일 Nonce 재전송 |
| **REORG** | 블록 재편으로 TX 소실 | MINED TX가 사라짐 감지 (FINALIZED 이전) | REORGED 전이 → 5블록 대기 → VASP 재조회 → MINED or FAILED |

---

### 6. TX 생애주기 전체 지도 — 3종 장애 발생 위치

아래 다이어그램에서 TIMEOUT / REVERT / REORG가 전이도의 어느 지점에서 발생하는지 확인한다.

```
REQUESTED ──────────────────────────────────────────── submitMintRequest()
    │
    ▼
SUBMITTED ──────────────────────────────────────────── VASP TX 전송 완료, txHash 획득
    │
    ▼
PENDING ─────────────────────────────────────────────── mempool 진입 (체인으로 전송됨)
    │                                   │
    │                            [TIMEOUT 발생 구간]
    │                            30분 초과, gas 부족
    │                            → gas bump → 동일 Nonce 재전송
    │                            → 새 txHash로 PENDING 유지
    │
    ▼
  MINED ──────────────────────────────────────────────── 블록 포함 (채굴 완료)
    │              │
    │        [REORG 발생 구간]
    │        MINED ~ FINALIZED 사이에서만 발생
    │        → REORGED 전이 → 재채굴 대기
    │        → 성공 시 MINED 재진입
    │        → 실패 시 FAILED
    │
  REVERT 발생 지점 ──────────── receipt.status = 0 (블록에는 포함됨)
  (MINED 직후 감지)             → 즉시 FAILED 전이
    │
    ▼
CONFIRMED ──────────────────────────────────────────── 충분한 블록 확인, 원장 업데이트 허용
    │
    ▼
FINALIZED ──────────────────────────────────────────── PoS 2/3+ 동의, 번복 불가 (종단)

   [FAILED] ─────────────────────────────────────────── REVERT 또는 최종 실패 (종단)
```

**핵심 구간 요약:**

```
mempool (PENDING) : TIMEOUT 가능 → gas bump로 복구
블록 내 (MINED)   : REVERT 감지 → 즉시 FAILED, REORG 가능 → REORGED
FINALIZED 이후    : 어떤 장애도 없음 — 번복 불가 확정 구간
```

---

### 7. Gas Bump 상세 — EIP-1559와 Replace-by-Fee

```
EIP-1559 이전 (Legacy):
  gasPrice = 단일 값
  RBF: 동일 Nonce + gasPrice × 1.1 이상 → mempool 교체

EIP-1559 이후 (Type-2 TX):
  maxFeePerGas        = 기꺼이 내는 최대 fee
  maxPriorityFeePerGas = 검증자에게 줄 팁 (Priority Fee)
  RBF: 동일 Nonce + maxPriorityFeePerGas × 1.1 이상

우리 시스템 GAS_BUMP_PERCENT = 20:
  기존: maxPriorityFeePerGas = 2 gwei
  bump: maxPriorityFeePerGas = 2.4 gwei (20% 인상)
  → mempool에서 기존 TX 교체 → 채굴 우선순위 상승
```

**retryCount 상한 — 왜 제한이 필요한가:**

```
gas bump 무한 반복 시:
  bump 1: 20 → 24 gwei
  bump 2: 24 → 28.8 gwei
  bump 3: 28.8 → 34.6 gwei
  ...bump 10: 123 gwei
  → 가스 비용 폭발 → 단일 NFT 발행에 수만 원 소비 가능

운영 정책:
  MintRequest.retryCount ≥ MAX_RETRIES → FAILED 전이
  (MAX_RETRIES = 3, TxStateMachineService.ts 참고)
```

---

### 8. REORG 발생 빈도와 실용적 처리

**Ethereum 메인넷에서의 실제 REORG 빈도:**

```
1블록 REORG: 드물게 발생 (수개월에 한 번)
2블록 REORG: 매우 드묾
3블록 이상:  거의 없음 (PoS 전환 이후)

우리 시스템 REORG_WAIT_BLOCKS = 5:
  "MINED 후 5블록이 더 쌓인 다음 getStatus 재조회"
  = 더 긴 체인에 포함됐을 가능성 기다림

참고: Finality는 보통 2 에포크 = 약 12분
     실용적으로 5블록 = 약 1분 대기로도 충분한 경우가 많음
```

**REORGED 상태에서의 전이 경로:**

```
REORGED
    │
    ├── 5블록 대기 후 vasp.getStatus() 재조회
    │
    ├── 'mined'     → MINED 재진입 (재채굴됨)
    │
    ├── 'confirmed' → FINALIZED → CONFIRMED (Finality 확보)
    │
    ├── 'not_found' → 재제출 필요
    │                 TxStateMachineService가 새 TX 발행
    │                 requestId 동일 → Idempotency 보장
    │
    └── 재시도 초과 → FAILED 전이
```

---

### 9. 원장 업데이트 안전 구간 — 왜 FINALIZED 이후인가

```
MINED에서 원장 업데이트 시:

  t=0: TX MINED → 원장 +1 (NFT 발행 기록)
  t=5: REORG 발생 → 해당 블록 무효
  t=5: 온체인 NFT 없음 ≠ 원장 +1 → 불일치 🚨

FINALIZED 이후 원장 업데이트 시:

  t=0: TX MINED
  t=12분: FINALIZED (PoS 2/3+ 동의) → 번복 불가
  t=12분: 원장 +1 → 온체인 NFT 존재 = 원장 +1 → 일치 ✅

원칙: "번복 가능한 상태에서 영구 기록 생성 금지"
```

**Finality 확보 후 원장 업데이트 흐름:**

```
FINALIZED 전이 (PoS 2/3+ validator 동의)
     ↓
M2 ConsumerGroupWorker가 FINALIZED 이벤트 수신
     ↓
LedgerService.recordHolding(+1)   ← M4 S23에서 구현
     ↓
user_nft_holdings 업데이트
```

---

**완료 기준:**
- [ ] TX 생애주기 전체 지도에서 TIMEOUT / REVERT / REORG 발생 위치 설명
- [ ] TIMEOUT 발생 원인 (Nonce 관리 + Stuck TX) 설명 가능
- [ ] Gas Bump (RBF) 원리 — EIP-1559 기준 maxPriorityFeePerGas 20% 인상 설명
- [ ] retryCount 상한이 필요한 이유 설명 — 가스 비용 폭발 방지
- [ ] CONFIRMED(MINED) vs FINALIZED 차이 — 원장 업데이트 안전 구간 설명
- [ ] REORGED 상태에서 vasp.getStatus() 결과별 전이 경로 (mined/confirmed/not_found) 설명
- [ ] 3종 복구 전략 (REVERT/TIMEOUT/REORG) 각각 서술 가능
- [ ] 원장 업데이트를 MINED가 아닌 FINALIZED 이후에만 허용하는 이유 — REORG 오염 시나리오 설명
