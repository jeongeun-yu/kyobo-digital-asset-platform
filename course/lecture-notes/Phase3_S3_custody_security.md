# Phase 3 미리보기 S3 — 직접 Custody 보안 아키텍처: HSM/MPC + 화이트리스트 + 잔액 모델

> **분류**: Phase 3 이론 미리보기 (강의 35분)  
> **연결 세션**: M8 S46 (Gnosis Safe) → 이 세션은 M8 S46 이후 삽입 권장  
> **스켈레톤 참조**: `dmz/packages/vasp/src/signer/ISignerService.ts`, `governance/WhitelistAddressService.ts`, `core-banking/src/ledger/LedgerService.ts` (`InternalLedgerBalance`)

> **[Phase 3 — 미확정]** 교보생명 직접 VASP 인가 취득 후 구현. Phase 1에서는 해당 기능을 VASP가 대행합니다.

---

## 도입 — Phase 1과 Phase 3의 보안 경계 차이

**Phase 1:**
```
교보 시스템 → 월렛원(VASP) API → [월렛원 HSM] → 블록체인
                                      ↑
                          월렛원이 키 관리, 서명, 출금 통제
```

**Phase 3 (직접 Custody):**
```
교보 시스템 → [교보 키 관리] → 블록체인
                    ↑
          교보가 직접 HSM/MPC 운영
          교보가 직접 출금 주소 통제
          교보가 직접 잔액 관리
```

Phase 1에서 월렛원이 해주던 보안 기능들을 Phase 3에서는 교보가 직접 구현해야 한다.  
이 세션에서는 그 핵심 3가지를 다룬다.

---

## 1. HSM vs MPC — 키 관리 방식 비교

### HSM (Hardware Security Module)

물리적 하드웨어 칩 안에 개인키를 저장. 키가 칩 밖으로 절대 나오지 않는다.

```
서명 요청 → HSM 장치 → 서명 결과 (키는 장치 안에 유지)
```

**특징:**
- FIPS 140-2 Level 3 인증 (물리 공격 방어)
- 감사 기관이 인정하는 표준
- 단일 장애점(SPOF): 장치 파손 시 → 백업 HSM 없으면 키 복구 불가
- TPS 낮음: 초당 수백 서명 한계

**적합한 용도:** 컨트랙트 업그레이드, 거버넌스 TX (M8의 Gnosis Safe) — 고가치, 저빈도

### MPC (Multi-Party Computation)

키 비밀(private key)을 N개 조각(shard)으로 수학적으로 분산.  
M개 이상의 조각이 모여야 서명 가능. 키 전체는 어느 한 곳에도 존재하지 않는다.

```
Shard A (서버1) ─┐
Shard B (서버2) ─┼─ 3-of-5 서명 프로토콜 → 서명 결과
Shard C (서버3) ─┘    (키 전체는 없음)
```

**특징:**
- SPOF 없음: 서버 2개가 파손돼도 나머지 3개로 서명 가능 (3-of-5)
- 지리적 분산 가능 (서울/부산/AWS)
- 한 Shard 유출 → 키 복구 불가 (M개 이상이 모여야 하므로)
- TPS 높음: 수평 확장 가능

**적합한 용도:** 일상적인 NFT 발행/소각 TX — 고빈도, 자동화 필요

### 교보 Phase 3 권장 구성

```
거버넌스 TX (컨트랙트 업그레이드 등): HSM + Gnosis Safe 2-of-3
일상 발행 TX (NFT mint/burn):         MPC (3-of-5, 지역 분산)
```

---

## 2. Signer Input Contract — 서명 요청 필드 명세

서명 서비스는 "무엇에 서명하는가"를 완전하게 알아야 한다.  
불완전한 서명 요청 → 서명자가 임의의 다른 TX에 서명할 위험.

스켈레톤 `ISignerService.ts`의 `SignRequest` 필드:

```typescript
interface SignRequest {
  requestId:           string   // UUID — 멱등성 키 (같은 요청 두 번 서명 방지)
  mintRequestId:       string   // FK → Withdrawal
  attemptId:           string   // FK → TxAttempt (어떤 Attempt에 서명하는지)
  chainId:             string   // EIP-155 — 다른 체인에 재생 방지
  fromAddress:         string   // 서명 주소
  toAddress:           string   // 수신 주소 (화이트리스트 확인 필요)
  tokenId:             bigint
  amount:              bigint
  nonce:               number   // 서명 전 Nonce 확정됨
  maxFeePerGas:        bigint
  maxPriorityFeePerGas:bigint
  deadline:            Date     // 이 시각 이후 서명 무효 (보안 창 제한)
  policyDecisionId:    string   // PolicyEngine이 승인한 결정 ID
  approvalBundleId:    string   // 다중 서명 번들 ID
  signingScope:        string   // 'NFT_MINT' | 'CONTRACT_UPGRADE' | ...
}
```

**`deadline`이 중요한 이유:**

```
deadline 없이 서명이 유출됐을 때:
  나중에 공격자가 오래된 서명을 RPC에 제출 → TX 실행됨

deadline이 있으면:
  서명 유출돼도 deadline 이후엔 무효 → 피해 창 제한
```

**`policyDecisionId` + `approvalBundleId`:**

서명 서비스가 "이 서명 요청이 정책/결재를 통과했는가"를 검증하는 링크.  
서명 서비스는 이 ID를 PolicyEngine DB에 직접 조회 → 유효하지 않으면 서명 거부.

---

## 3. 출금 주소 화이트리스트 — 48시간 대기 모델

### 왜 화이트리스트가 필요한가

내부 공격자 시나리오:
```
악의적 직원이 자신의 주소를 출금 대상으로 설정
→ 즉시 대량 출금 실행
→ 돈이 사라진 후 감지
```

화이트리스트 + 대기 기간이 있으면:
```
주소 등록 → 48시간 대기 → 담당자 이상 감지 → 취소
→ 자금 이동 없음
```

### 상태 전이

스켈레톤: `dmz/packages/vasp/src/governance/WhitelistAddressService.ts`

```
REGISTERED
    │ 결재 요청
    ▼
APPROVAL_PENDING  ──── 결재 거부 ────→ REJECTED (종단)
    │ 결재 완료
    ▼
HOLDING (48시간 대기)               ← 이 기간 동안 출금 불가
    │ 타이머 자동 전이 (사람이 바이패스 불가)
    ▼
ACTIVE                              ← 출금 허용
    │ 즉시 취소 가능
    ▼
REVOKED (종단)
```

**HOLDING → ACTIVE 전이는 시스템 타이머가 자동 처리.**  
사람(관리자 포함)이 직접 HOLDING을 건너뛸 수 없다 — 이것이 보안 핵심.

```typescript
// WhitelistAddressService.activateMatured() — 크론: 1시간 간격
// holdingUntil < NOW() 인 HOLDING 상태를 일괄 ACTIVE 전이
// 사람이 호출하는 메서드가 아닌 자동화된 타이머
```

### 출금 요청 시 검증 흐름

```
출금 요청 도착
    │
    ▼
WhitelistAddressService.isActive(toAddress, chainId)
    │
    ├── false → 요청 거부 (화이트리스트 미등록 또는 HOLDING 중)
    │
    └── true  → PolicyEngine 조회 → 승인 → 서명 → TX 전송
```

---

## 4. Internal Ledger 4단계 잔액 모델

### Phase 1의 한계

현재 교보 모델:
- 발행: NFT 발행 → 온체인 잔액 증가
- 소각: NFT 소각 → 온체인 잔액 감소
- 잔액 표시: 온체인 `balanceOf()` 결과

단방향(발행 위주)이라 문제없다. 그런데 출금(인출)이 생기면?

```
사용자 잔액: NFT 10개
동시 출금 요청 2건: 각 6개씩
→ 둘 다 balanceOf() 조회 → 10개 있으니 허용
→ TX 둘 다 전송 → 12개 출금 시도 → 컨트랙트에서 잔액 부족 REVERT

또는 악의적 활용:
→ TX 하나가 먼저 채굴 → 나머지도 채굴되면 이중 지불
```

### 4단계 잔액으로 해결

스켈레톤: `LedgerService.ts`의 `InternalLedgerBalance`

```
Available  = 출금 가능한 실제 잔액 (사용자에게 보이는 잔액)
Reserved   = 출금 요청 승인 시 즉시 잠김 (이중 출금 방지)
Pending    = TX 전송됨, 블록 미포함
Settled    = 온체인 Finalized 기준 최종 잔액

관계:
  Available = Settled - Reserved - Pending
```

**동시 출금 요청 시나리오:**

```
초기 상태: Settled=10, Reserved=0, Pending=0, Available=10

출금 요청 1 (6개) 승인:
  Reserved += 6
  Available = 10 - 6 - 0 = 4

출금 요청 2 (6개) 시도:
  Available = 4 → 6개 출금 불가 → 거부 ✅

출금 요청 1의 TX 전송됨:
  Reserved -= 6, Pending += 6
  Available = 10 - 0 - 6 = 4

TX Finalized:
  Pending -= 6, Settled -= 6
  Settled = 4, Available = 4
```

**Reserve가 "선제적 잠금"이다.** 온체인 확정 전에 이미 잔액을 잠가서 이중 출금을 원천 차단.

### RESERVE → SETTLE 2단계 원장 패턴

```
W3_APPROVED (출금 승인):   RESERVE  ← 잔액 잠금, 이중 출금 방지
W8_SAFE_FINALIZED (확정):  SETTLE   ← 온체인 확정, 잔액 최종 감소
```

Phase 1에서는 NFT 발행(mint)이 주여서 잔액이 증가만 하므로 RESERVE 개념이 불필요. 출금(withdrawal)이 생기는 Phase 3에서 핵심이 된다.

---

## 5. 보안 사고 시나리오 3종

커스터디 시스템에서 실제 발생하는 사고 유형과 각 장치가 어떻게 막는지:

| 사고 시나리오 | 방어 장치 | 작동 방식 |
|---|---|---|
| 내부자가 개인키 직접 탈취 | MPC Shard 분산 | 한 Shard만으로는 서명 불가 |
| 관리자 계정 피싱 → 임의 출금 | 화이트리스트 HOLDING 48h | 새 주소로 즉시 출금 불가 |
| 감사 로그 삭제 → 추적 불가 | Append-only + SHA-256 체인 | 삭제 시 무결성 검증 실패 감지 |

세 사고 모두 "단일 통제 실패"로는 공격 성공 안 함. **심층 방어(Defense in Depth)** 원칙.

---

## 완료 기준 (이론 이해 확인)

- [ ] HSM과 MPC의 핵심 차이 — SPOF 관점에서 설명 가능
- [ ] HSM: 거버넌스 TX / MPC: 일상 발행 TX 이유 설명 가능
- [ ] Signer Input Contract에서 `deadline`과 `policyDecisionId`의 역할 설명 가능
- [ ] 화이트리스트 HOLDING → ACTIVE 전이가 자동인 이유(보안적 의미) 설명 가능
- [ ] 4단계 잔액 모델에서 RESERVE가 해결하는 문제 설명 가능
- [ ] RESERVE → SETTLE 2단계가 각각 언제 실행되는지 설명 가능
