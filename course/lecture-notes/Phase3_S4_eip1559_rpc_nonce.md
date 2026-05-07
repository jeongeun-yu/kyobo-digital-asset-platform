# Phase 3 미리보기 S4 — EIP-1559 수수료 + RPC 다중화 + Nonce 전략

> **분류**: Phase 3 이론 미리보기 (강의 25분)  
> **연결 세션**: M3 S14 (IBlockchainAdapter) → 이 세션은 M3 S14 이후 삽입 권장  
> **스켈레톤 참조**: `chain-adapters/src/interfaces/IBlockchainAdapter.ts` (`Eip1559FeeParams`, `FeePolicyId`, `RpcDegradeMode`), `vasp/src/nonce/NonceManager.ts`

---

## 도입 — "gas * gasPrice"는 이미 낡은 방식

M3 S20에서 gas bump를 구현할 때 `gasPriceGwei * 1.2`를 사용했다.  
이 방식은 **EIP-1559 이전(2021년 8월 이전) Legacy TX**다.

현재 Ethereum mainnet은 EIP-1559 기반으로 작동한다.  
Phase 1에서는 VASP(월렛원)가 수수료를 알아서 설정해 주니 문제없다.  
Phase 3에서 TX를 직접 생성하면 — EIP-1559 방식으로 직접 수수료를 설정해야 한다.

---

## 1. EIP-1559 수수료 구조 (London 하드포크, 2021.08)

### Legacy 방식 vs EIP-1559 방식

```
Legacy (EIP-1559 이전):
  납부 = gasUsed × gasPrice
  채굴자: gasPrice 전액 수령
  단점: 수수료 예측 어려움 — 혼잡할 때 얼마나 올려야 할지 모름

EIP-1559:
  납부 = gasUsed × min(MaxFeePerGas, BaseFee + MaxPriorityFeePerGas)
  소각: BaseFee (→ ETH 공급 감소)
  채굴자: MaxPriorityFeePerGas (팁)
  장점: BaseFee가 시장이 결정 → 적정 수수료 예측 가능
```

### 3개 파라미터 이해

```
BaseFee        프로토콜이 자동 결정 (전 블록 사용률 기준)
               블록이 50% 이상 찼으면 BaseFee 증가, 이하면 감소
               소각됨 — 채굴자/검증자에게 가지 않음
               내가 설정 불가 (읽기만 가능)

MaxPriorityFeePerGas  내가 검증자에게 주는 팁
               높을수록 우선 처리됨
               너무 낮으면 다음 블록으로 밀림

MaxFeePerGas   내가 납부할 최대 금액 (BaseFee + MaxPriorityFeePerGas ≤ MaxFeePerGas)
               실제 납부 = min(MaxFeePerGas, BaseFee + MaxPriorityFeePerGas)
               잔여분은 환불됨
```

**설정 예시:**

```
현재 BaseFee: 20 Gwei
내 설정:
  MaxPriorityFeePerGas = 2 Gwei (팁)
  MaxFeePerGas = 30 Gwei (여유 있게 설정)

실제 납부 = min(30, 20 + 2) = 22 Gwei
환불 = 30 - 22 = 8 Gwei ← 최대 금액을 초과하면 환불
```

**gas bump (RBF, Replace-by-Fee) EIP-1559 방식:**

```
Legacy:  gasPriceGwei * 1.2
EIP-1559: maxPriorityFeePerGas * 1.1 이상 (최소 10% 인상)
          maxFeePerGas도 함께 증가시켜야 함
          동일 Nonce로 재전송
```

### FeePolicyId — 수수료 전략 추상화

스켈레톤 `IBlockchainAdapter.ts`:

```typescript
type FeePolicyId = 'NORMAL' | 'FAST' | 'SURGE'
```

어댑터가 현재 네트워크 상황(eth_feeHistory)을 읽어 FeePolicyId에 맞는 수수료를 계산:

| FeePolicyId | 전략 | 예상 포함 시간 |
|---|---|---|
| NORMAL | BaseFee × 1.0 + 최소 Priority Fee | ~12초 (1블록) |
| FAST | BaseFee × 1.2 + 높은 Priority Fee | ~6초 |
| SURGE | BaseFee × 1.5 + 최고 Priority Fee | ~즉시 (~1블록) |

비즈니스 레이어는 `feePolicyId`만 전달 — 실제 수수료 계산은 어댑터가 처리.

---

## 2. RPC 불완전성과 다중화 전략

### 단일 RPC의 위험

Phase 1에서는 단일 RPC 엔드포인트를 사용한다고 가정한다.  
직접 Custody 운영에서 단일 RPC는 심각한 위험이다:

```
시나리오 1: RPC 노드 일시 장애
  TX 전송 불가 → 발행 중단 → 사용자 불만

시나리오 2: RPC 노드 동기화 지연 (stuck node)
  getTransactionReceipt() → "not found" 응답
  → ConfirmationTracker가 DROPPED으로 판정
  → 실제론 TX가 포함됐는데 잘못된 FAILED 전이 🚨

시나리오 3: RPC 노드 응답 불일치
  RPC-A: "TX confirmed at block 1234"
  RPC-B: "TX not found"
  → 어느 쪽이 맞는가?
```

### 다중 RPC + Quorum

```
3개 RPC 엔드포인트 사용:
  Infura, Alchemy, 자체 노드

TX 상태 조회 시:
  3개 RPC에 동시 조회
  2개 이상 동의하는 결과를 신뢰 (Quorum = 2/3)

  RPC-A: confirmed ─┐
  RPC-B: confirmed ─┼─ 2/3 → "confirmed" 채택 ✅
  RPC-C: not found ─┘
```

### RPC 저하 모드 5단계

스켈레톤 `IBlockchainAdapter.ts`의 `RpcDegradeMode`:

| 모드 | 의미 | TX 전송 가능 여부 |
|---|---|---|
| NORMAL | 정상 (quorum 충족) | 모든 TX 허용 |
| DEGRADED_READ | 읽기 RPC 일부 장애 | 쓰기(TX 전송)는 정상 |
| DEGRADED_WRITE | 쓰기 RPC 일부 장애 | 고가치 TX만 허용 |
| MANUAL_APPROVAL_ONLY | RPC 신뢰 불가 | 모든 TX에 수동 승인 필요 |
| STOP_THE_LINE | 전체 중단 | TX 전송 완전 중단 |

`STOP_THE_LINE`은 "지금 TX를 보내면 잘못될 수 있다"고 판단했을 때 시스템이 스스로 멈추는 안전장치. 수동으로만 복구 가능.

---

## 3. Nonce 전략 3종

스켈레톤 `NonceManager.ts`:

### SERIAL_STRICT (직렬 엄격)

```
TX 1 전송 → TX 1 확정 대기 → TX 2 전송 → TX 2 확정 대기 → ...
TPS = 1 (블록 시간 12초 기준)
```

- **장점**: Nonce 갭 절대 없음. 가장 안전.
- **단점**: 처리량이 TPS 1로 제한.
- **사용**: 고가치 TX (컨트랙트 업그레이드). Phase 1 현재 방식(VASP 위임).

### PIPELINED (파이프라인)

```
TX 1 전송 (Nonce=10)
TX 2 전송 (Nonce=11) ← TX 1 확정 전에 전송
TX 3 전송 (Nonce=12)
...
TPS = 수십~수백
```

- **장점**: 높은 처리량.
- **단점**: TX 1이 DROPPED되면 Nonce 갭 발생 → TX 2,3 모두 블록킹.
- **사용**: 대량 NFT 배치 발행 (BulkIssue). 갭 발생 시 복구 로직 필수.

```
갭 복구:
  Nonce 10이 DROPPED → Nonce 10 자리에 빈 TX 채우기
  (0 ETH to self, 높은 gasPrice)
  → 갭 해소 → Nonce 11,12 정상 처리
```

### PINNED (고정)

```
특정 TX를 특정 Nonce에 미리 할당
서명은 나중에 수집 (오프체인 서명 수집 기간 동안)
Nonce가 확정된 상태로 서명 요청 전달
```

- **사용**: Gnosis Safe처럼 서명을 오프체인에서 수집한 후 나중에 실행하는 패턴. M8의 KeyGovernanceService와 연계.

### 전략 선택 기준

```
일상 발행 (NFT mint, 수백 건/일):     PIPELINED
거버넌스 TX (업그레이드, 1~2건/월):   PINNED (Gnosis Safe 방식)
안전 최우선 (장애 복구 중):            SERIAL_STRICT
```

---

## 4. 수수료·RPC·Nonce의 연결 구조

Phase 3에서 TX 하나가 전송되기까지:

```
1. FeePolicyId 선택 → 어댑터가 현재 BaseFee 조회 → EIP-1559 수수료 계산
2. NonceManager.allocate() → DB UNIQUE 제약으로 중복 방지
3. RpcDegradeMode 확인 → STOP_THE_LINE이면 중단
4. ISignerService.sign(SignRequest) → HSM/MPC 서명
5. Broadcaster.broadcast() → RPC.sendRawTransaction()
6. ConfirmationTracker가 quorum 기반으로 상태 추적
```

이 6단계가 Phase 3에서 Phase 1의 "VASP API 한 번 호출"을 대체한다.

---

## 완료 기준 (이론 이해 확인)

- [ ] EIP-1559의 BaseFee / MaxPriorityFeePerGas / MaxFeePerGas 각각의 역할 설명 가능
- [ ] gas bump를 EIP-1559 방식으로 하면 어떻게 달라지는지 설명 가능
- [ ] 단일 RPC의 위험 2가지 이상 설명 가능
- [ ] RPC 저하 모드 5단계를 심각도 순서로 나열 가능
- [ ] SERIAL_STRICT / PIPELINED / PINNED의 장단점과 적합한 용도 설명 가능
- [ ] PIPELINED에서 Nonce 갭 발생 시 복구 방법 설명 가능
