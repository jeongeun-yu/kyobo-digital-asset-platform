# M5 S29-2 — 계정 추상화(ERC-4337)와 스마트 컨트랙트 지갑

> **[확장 세션]** S29(EIP-191 서명)를 먼저 수강한 후 이 세션을 진행한다.

> 모듈 5 · 세션 29-2 · 1시간  
> 사전 지식: EIP-191 서명, ECDSA ecrecover, EOA 개념 (S29)

---

## 강의 파트 (25분)

### 1. S29에서 배운 EOA 모델의 한계

S29에서 EIP-191 서명을 배웠다. 핵심 구조를 복습하면:

```
private key  →  공개키  →  주소 (EOA)
     │
     └── ECDSA 서명 → ecrecover → 주소 복원 → 소유권 증명
```

이 모델이 교보생명 시스템에서 실제로 부딪히는 한계 세 가지:

**한계 1: 사용자가 ETH를 보유해야 한다**

```
교보생명이 NFT를 발행하려면:
  사용자 지갑 → 컨트랙트 호출 → gas 지불 필요
  
  문제: "교보 NFT 받으려면 ETH 먼저 사세요"
        일반 보험 고객에게 이 요구는 비현실적
```

**한계 2: private key 분실 = 자산 영구 소실**

```
EOA:  주소 = keccak256(pubKey)[12:]
      private key가 없으면 주소에 접근 불가
      복구 수단 없음 → 기업 고객·일반 사용자에게 치명적
```

**한계 3: 서명 방식이 ECDSA로 고정**

```
EOA TX 서명: ECDSA만 가능
  → 생체인증(패스키), 다중 서명, 세션키 등 불가
  → 법인 계좌의 "2명 이상 승인" 구조 구현 불가
```

---

### 2. Account Abstraction의 핵심 아이디어

ERC-4337의 핵심 명제 하나:

> **"계정(Account)을 스마트 컨트랙트로 만들면 세 가지 한계가 모두 해결된다"**

EOA vs Smart Contract Account 비교:

```
EOA (기존):
  주소 = keccak256(pubKey)[12:]   ← 수학적으로 고정
  서명 검증 = ECDSA                ← 프로토콜에 고정
  gas 지불 = 이 주소의 ETH         ← 이 주소가 반드시 ETH 보유

Smart Contract Account (ERC-4337):
  주소 = 컨트랙트 배포 주소         ← 유연 (CREATE2로 미리 예측 가능)
  서명 검증 = validateUserOp()     ← 개발자가 커스터마이즈
  gas 지불 = Paymaster가 대납      ← 제3자(교보생명)가 지불 가능
```

"Account Abstraction"이라는 이름의 의미:
- 기존: 계정 = EOA (구체적, 고정)
- AA: 계정 = 임의의 컨트랙트 (추상화 — 구현 방식이 자유)

---

### 3. ERC-4337 구조 — 4개 컴포넌트

```
┌──────────────────────────────────────────────────────────────────┐
│                    ERC-4337 처리 흐름                              │
└──────────────────────────────────────────────────────────────────┘

[사용자 / 앱]
     │
     │  UserOperation 생성 (트랜잭션 아님)
     │  { sender, callData, signature, paymasterAndData, ... }
     │
     ▼
[Bundler]  (오프체인 서비스 — 누구나 운영 가능)
     │
     │  여러 UserOperation을 모아 배치
     │  EntryPoint.handleOps([op1, op2, ...]) 호출
     │  ← Bundler가 gas를 선지불하고 나중에 정산받음
     │
     ▼
[EntryPoint 컨트랙트]  (EVM 공용 — 체인당 1개)
     │  주소: 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789
     │
     ├─ ① account.validateUserOp(op, hash, missingFunds)
     │       → 서명 검증 (커스터마이즈 가능)
     │
     ├─ ② paymaster.validatePaymasterUserOp(op, hash, maxCost)
     │       → Paymaster가 gas 대납 승인
     │
     └─ ③ account.execute(to, value, callData)
              → 실제 비즈니스 로직 실행
              ▼
         [Smart Contract Account]
              → 임의 로직 실행 (NFT 수령, DeFi 호출 등)
```

**기존 EOA TX와 비교:**

| 항목 | EOA 트랜잭션 | UserOperation |
|---|---|---|
| 처리 레이어 | 이더리움 프로토콜 직접 | EntryPoint 컨트랙트 경유 |
| 서명 검증 | 프로토콜 고정 (ECDSA) | `validateUserOp()` 커스터마이즈 |
| Gas 지불 | `from` 주소가 반드시 지불 | Paymaster가 대납 가능 |
| 배치 처리 | 불가 | Bundler가 여러 op 묶어 처리 |

---

### 4. UserOperation 구조

```typescript
interface UserOperation {
  sender:               string;    // Smart Contract Account 주소
  nonce:                bigint;    // 재생 공격 방지 (EntryPoint가 관리)
  initCode:             string;    // 최초 배포 시 Account 생성 bytecode
                                   //   이후 호출에서는 '0x'
  callData:             string;    // execute()에 전달할 ABI 인코딩 데이터
  callGasLimit:         bigint;    // execute() 실행 gas 한도
  verificationGasLimit: bigint;    // validateUserOp() 실행 gas 한도
  preVerificationGas:   bigint;    // Bundler 오버헤드 보상용 gas
  maxFeePerGas:         bigint;    // EIP-1559 maxFeePerGas
  maxPriorityFeePerGas: bigint;
  paymasterAndData:     string;    // Paymaster 주소(20바이트) + Paymaster 서명
                                   //   없으면 '0x' (사용자가 gas 직접 지불)
  signature:            string;    // validateUserOp()에 전달되는 서명
                                   //   형식은 Account 구현에 따라 자유
}
```

S29에서 배운 EIP-191 서명과의 연결:

```
S29 흐름:
  message = "Kyobo Digital Asset Wallet: userId:nonce"
  signature = eth_sign(privateKey, message)
  → ecrecover(message, signature) == walletAddr ?

ERC-4337 흐름:
  userOpHash = EntryPoint.getUserOpHash(userOp)  // op 전체의 해시
  signature = eth_sign(privateKey, userOpHash)
  → validateUserOp()에서 검증 방식은 Account가 결정
```

---

### 5. Paymaster — 가스비 대납

교보생명 시나리오: 일반 고객이 ETH 없이 NFT를 수령해야 한다.

```
[교보생명 Paymaster 컨트랙트]

// ① 검증 단계: gas 대납 여부 결정
validatePaymasterUserOp(userOp, userOpHash, maxCost)
  → 교보 고객 여부 확인 (userId 서명 검증)
  → 일일 대납 한도 확인
  → 승인이면 (context, 0) 반환
  → 거부이면 revert

// ② 실행 후 정산
postOp(mode, context, actualGasCost)
  → 실제 소모된 gas를 교보 내부 원장에 기록
  → 고객 계정에서 차감 (fiat 기반)
```

```
Paymaster 없는 경우:
  사용자 ─── gas 0.001 ETH ───▶ 컨트랙트 실행

Paymaster 있는 경우:
  교보 Paymaster ─── gas ───▶ 컨트랙트 실행
  사용자 ETH 잔액 = 0 이어도 됨
  교보생명이 나중에 fiat으로 정산
```

Paymaster는 gas를 선지불하는 컨트랙트다. 교보가 ETH gas pool을 운영하고, 사용자는 ETH 없이 NFT를 받을 수 있다.

---

### 6. validateUserOp() — 서명 검증 커스터마이즈

EIP-191에서는 ECDSA 서명만 가능했다. ERC-4337에서는 `validateUserOp()`을 통해 임의의 검증 로직을 구현할 수 있다.

```solidity
// Simple Account — ECDSA 기본 구현
function validateUserOp(
    UserOperation calldata userOp,
    bytes32 userOpHash,
    uint256 missingAccountFunds
) external returns (uint256 validationData) {
    // EIP-191 형식으로 메시지 해시 생성
    bytes32 hash = userOpHash.toEthSignedMessageHash();
    // ECDSA 복원 → owner와 일치하면 통과
    if (owner != hash.recover(userOp.signature)) {
        return SIG_VALIDATION_FAILED;  // 1
    }
    return 0;  // 검증 성공
}
```

교보생명에서 활용 가능한 검증 방식:

| 검증 방식 | 적용 상황 | 구현 방법 |
|---|---|---|
| ECDSA (기본) | MetaMask 사용자 | `ecrecover(userOpHash, sig) == owner` |
| P256 (패스키) | 모바일 생체인증 | P256 서명 검증 라이브러리 |
| 다중 서명 | 법인 계좌 — 2명 이상 승인 | N-of-M 서명 집합 검증 |
| 세션키 | 앱 내 자동 서명 | 임시 키 + 유효기간 + 권한 범위 |
| 화이트리스트 | 특정 컨트랙트 호출만 허용 | `callData` 파싱 후 대상 검증 |

`validateUserOp()`이 `0`을 반환하면 통과, `1`(SIG_VALIDATION_FAILED)을 반환하면 거부, 상위 비트에 타임스탬프 범위를 인코딩해 "유효 기간 내 서명"도 표현할 수 있다.

---

### 7. AA 활용 사례 — Paymaster 외 3가지

Paymaster(가스 대납)는 AA의 기능 중 하나일 뿐이다. `validateUserOp()`과 `execute()`를 자유롭게 구현할 수 있다는 점에서 훨씬 더 많은 시나리오가 가능하다.

---

#### 7-1. 소셜 복구 (Social Recovery) — private key 분실 대비

EOA에서 private key를 잃으면 자산은 영구히 잠긴다. Smart Contract Account에서는 사전에 지정한 Guardian들이 새 owner를 지정할 수 있다.

```
[교보생명 Recovery Account]

Guardian 등록:
  owner가 신뢰하는 주소 3개를 컨트랙트에 등록
  예: 가족 주소, 교보 고객센터 주소, 백업 디바이스

복구 흐름:
  owner private key 분실
       │
       ▼
  Guardian 2개 이상이 새 owner 주소에 서명
       │
       ▼
  initiateRecovery(newOwner, guardianSigs[])
       │
       ▼
  시간 지연(Timelock, 예: 48시간) → 이 기간에 owner가 취소 가능
       │
       ▼
  finalizeRecovery() → owner 교체 완료

결과: 이전 주소의 NFT·잔액이 그대로 새 owner에게 이전
```

```solidity
// RecoveryAccount 핵심 로직 (의사코드)
function initiateRecovery(address newOwner, bytes[] calldata guardianSigs) external {
    uint256 approvals = 0;
    for (uint i = 0; i < guardianSigs.length; i++) {
        address signer = recoverSigner(newOwner, guardianSigs[i]);
        if (isGuardian[signer]) approvals++;
    }
    require(approvals >= threshold, "not enough guardians");  // 예: 2-of-3

    pendingOwner = newOwner;
    recoveryInitiatedAt = block.timestamp;  // Timelock 시작
}

function finalizeRecovery() external {
    require(block.timestamp >= recoveryInitiatedAt + RECOVERY_DELAY);
    owner = pendingOwner;
}
```

**교보생명 적용 시나리오:**
- 일반 고객: Guardian = 가족 지갑 + 교보 고객센터 (2-of-2)
- 분실 신고 → 교보 고객센터가 Guardian 서명 → 48시간 후 복구 완료
- 기존 EOA 방식에서는 불가능했던 "고객 지원" 가능

---

#### 7-2. 세션키 (Session Key) — 매번 서명 없이 앱 자동화

사용자가 앱을 사용할 때마다 MetaMask 팝업이 뜨면 UX가 나쁘다. 세션키는 "이 키가 이 범위 내에서만 서명할 수 있다"는 임시 권한을 부여한다.

```
[세션키 등록]

사용자가 앱 실행 시 1회만 서명:
  owner가 임시 세션키(SessionKey)에 권한 위임
  → 대상 컨트랙트: KyoboNFT만
  → 최대 금액: 1개 NFT 수령만
  → 유효기간: 24시간

[세션키 사용 흐름]

앱이 NFT 수령 UserOperation 생성
  signature = sessionKey.sign(userOpHash)
       │
       ▼
validateUserOp():
  서명이 sessionKey로 됐는지 확인
  callData가 허용된 컨트랙트(KyoboNFT)인지 확인
  유효기간 내인지 확인
  → 통과 → 실행
```

```typescript
// 세션키 등록 (앱 초기화 시 1회)
const sessionKeyPair = ethers.Wallet.createRandom();  // 임시 키

await smartAccount.addSessionKey({
  key:        sessionKeyPair.address,
  allowedTargets: [KYOBO_NFT_ADDRESS],
  maxAmount:  1n,          // NFT 1개까지
  expiresAt:  Date.now() + 24 * 60 * 60 * 1000,  // 24시간
});

// 이후 앱이 자동으로 서명 (팝업 없음)
const userOp = buildUserOp({ ... });
userOp.signature = await sessionKeyPair.signMessage(userOpHash);
await bundler.sendUserOperation(userOp);
```

**교보생명 적용 시나리오:**
- 걷기 목표 달성 시 앱이 자동으로 NFT 수령 UserOperation 전송
- 사용자는 앱 설치 시 1회만 세션키 권한 부여 → 이후 자동 실행
- 권한 범위가 컨트랙트 레벨에서 강제되므로 세션키 탈취돼도 NFT 수령 이외 동작 불가

---

#### 7-3. 배치 트랜잭션 (Batch TX) — 여러 작업을 1번의 UserOperation으로

EOA에서는 "approve → transfer"처럼 2단계 작업이 TX 2개였다. Smart Contract Account는 `execute()` 안에서 여러 호출을 순차 실행할 수 있다.

```
EOA 방식 (2 TX):
  TX1: ERC-20.approve(spender, amount)   ← 서명 1회 + gas
  TX2: DeFi.deposit(amount)              ← 서명 1회 + gas
  문제: TX1 성공 + TX2 실패 가능 → 불일치 상태

AA 배치 방식 (1 UserOperation):
  executeBatch([
    { to: ERC20,  data: approve(spender, amount)  },
    { to: DeFi,   data: deposit(amount)           },
    { to: KyoboNFT, data: safeTransferFrom(...)   },
  ])
  → 3개 작업이 1 TX 안에서 원자적 실행
  → 하나라도 실패하면 전체 롤백
```

```solidity
// SimpleAccount.executeBatch() 의사코드
function executeBatch(
    address[] calldata dest,
    bytes[]   calldata func
) external {
    require(dest.length == func.length);
    for (uint256 i = 0; i < dest.length; i++) {
        _call(dest[i], 0, func[i]);  // 실패하면 전체 revert
    }
}
```

**교보생명 적용 시나리오:**
- 보험 만기 정산: "환급금 수령 + NFT 발행 + 소각" 3단계를 1 UserOperation으로 처리
- 원자성 보장: 중간 단계 실패 시 전체 롤백 → 원장 불일치 없음

---

#### 7-4. ERC-20 가스 지불 (Token Paymaster)

ETH가 아닌 ERC-20 토큰(예: USDC, WETH)으로 gas를 지불할 수 있다. Paymaster가 ERC-20을 받고 ETH gas를 대신 지불한다.

```
[Token Paymaster 흐름]

사용자: USDC 1개 → Token Paymaster
Token Paymaster: 시세 확인 → ETH gas로 환산 → EntryPoint에 ETH 지불

사용자 입장:
  ETH 잔액 = 0
  USDC 잔액에서 gas 차감
  → ETH를 따로 살 필요 없음

paymasterAndData 구조:
  [Paymaster 주소 20바이트][ERC-20 토큰 주소 20바이트][최대 지불 금액 32바이트][서명]
```

**교보 적용 시나리오:**
- Phase 3에서 교보가 자체 스테이블코인(KRW 연동) 발행 시, 이 토큰으로 gas 지불 가능
- 사용자 경험: "ETH 없이 KRW 스테이블코인으로 모든 거래 처리"

---

**4가지 사례 정리:**

| 기능 | 해결하는 문제 | 교보 시나리오 |
|---|---|---|
| Paymaster (가스 대납) | ETH 없는 사용자 | 일반 고객 NFT 수령 |
| 소셜 복구 | private key 분실 | 고객센터 Guardian 복구 |
| 세션키 | 매번 서명 UX 나쁨 | 앱 자동 NFT 수령 |
| 배치 TX | 다단계 작업 원자성 | 만기 정산 3단계 원자 실행 |
| Token Paymaster | ETH 구매 장벽 | KRW 스테이블코인으로 gas 지불 |

---

### 8. Phase 1에서 AA를 쓰지 않는 이유 — Phase 3 로드맵

**Phase 1 (현재): AA 불필요**

```
사용자 → 교보 서버 → VASP(월렛원) API → 온체인
                          ↑
         VASP가 gas 처리, 사용자는 서명 없음
         교보 서버가 VASP에 위임 → AA 도입 비용만 증가
```

월렛원이 Custody 지갑을 관리하므로, 교보 서버는 단순히 REST API를 호출한다. 사용자가 직접 서명하거나 gas를 지불할 일이 없다. AA 도입의 이점이 없다.

**Phase 3 (자체 VASP): AA 필요**

```
사용자 앱
    │ UserOperation 서명 (생체인증 or 패스키)
    ▼
[교보 Bundler]
    │
    ▼
[EntryPoint]
    ├─ [교보 Smart Account].validateUserOp()
    │       → 다중 서명 or 패스키 검증
    └─ [교보 Paymaster].validatePaymasterUserOp()
            → ETH gas 대납
            → 실제 비용은 fiat 정산
```

Phase 3 전환 시 AA가 필요해지는 상황:
1. 교보가 직접 gas pool 운영 → Paymaster 필수
2. 법인 고객 다중 서명 요구 → `validateUserOp()` 커스터마이즈 필수
3. 모바일 앱 패스키 지원 → P256 서명 검증 필요

---

## 실습 파트 (30분)

> **[실습 과제]** 아래 내용은 현재 코드베이스에 없다. ERC-4337 개념 이해를 위한 독립 실습이다.

### UserOperation 타입 정의 + callData 인코딩

```typescript
// erc4337/types.ts

export interface UserOperation {
  sender:               string;
  nonce:                bigint;
  initCode:             string;
  callData:             string;
  callGasLimit:         bigint;
  verificationGasLimit: bigint;
  preVerificationGas:   bigint;
  maxFeePerGas:         bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData:     string;
  signature:            string;
}

// NFT 수령을 위한 callData 인코딩 (ethers.js)
import { ethers } from 'ethers';

function buildNftReceiveCallData(
  nftContractAddr: string,
  tokenId: bigint,
  amount: bigint,
): string {
  const iface = new ethers.Interface([
    'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
  ]);
  return iface.encodeFunctionData('safeTransferFrom', [
    '0xIssuerAddress',
    '0xUserSmartAccountAddress',
    tokenId,
    amount,
    '0x',
  ]);
}
```

---

### SimpleAccount validateUserOp 흐름 분석

ERC-4337 reference implementation의 `SimpleAccount.sol`:

```solidity
// SimpleAccount.sol (reference implementation)

contract SimpleAccount is BaseAccount {
    address public owner;

    // EntryPoint가 이 메서드를 호출해 서명을 검증한다
    function _validateSignature(
        UserOperation calldata userOp,
        bytes32 userOpHash
    ) internal override returns (uint256 validationData) {
        // ① userOpHash를 EIP-191 형식으로 변환
        bytes32 hash = userOpHash.toEthSignedMessageHash();

        // ② ECDSA 복원 → owner와 비교
        //    S29에서 배운 ecrecover와 동일한 원리
        if (owner != hash.recover(userOp.signature)) {
            return SIG_VALIDATION_FAILED;
        }
        return 0;
    }

    // Account가 실제 호출할 로직 실행
    function execute(
        address dest,
        uint256 value,
        bytes calldata func
    ) external {
        _requireFromEntryPointOrOwner();
        _call(dest, value, func);
    }
}
```

**S29와의 연결:**

| 항목 | S29 EIP-191 | ERC-4337 SimpleAccount |
|---|---|---|
| 서명 대상 | `"Kyobo:userId:nonce"` | `userOpHash` (전체 op 해시) |
| 검증 함수 | `ecrecover(msgHash, sig)` | `hash.recover(sig)` (동일) |
| 검증 주체 | 서버 (off-chain) | 컨트랙트 (on-chain) |
| 실패 처리 | `return false` | `return SIG_VALIDATION_FAILED` |

---

### 교보 Paymaster 스텁 구현

> **[실습 과제]** 아래 스텁을 완성하세요.

```solidity
// KyoboPaymaster.sol

contract KyoboPaymaster is BasePaymaster {

    // 교보생명 고객 주소 → gas 대납 허용 여부
    mapping(address => bool) public approvedAccounts;
    
    // 일일 대납 한도 (wei)
    uint256 public constant DAILY_GAS_LIMIT = 0.01 ether;

    /**
     * EntryPoint가 검증 단계에서 호출한다.
     * 반환: (context, validationData)
     *   context: postOp에 전달할 데이터 (예: 실제 소모량 정산용)
     *   validationData: 0 = 승인, 1 = 거부
     */
    function _validatePaymasterUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) internal override returns (bytes memory context, uint256 validationData) {
        // TODO ①: userOp.sender가 approvedAccounts에 있는지 확인
        // TODO ②: maxCost가 DAILY_GAS_LIMIT 이하인지 확인
        // TODO ③: 통과하면 context = abi.encode(userOp.sender, maxCost)
        // TODO ④: 거부하면 validationData = 1
    }

    /**
     * 실행 완료 후 정산 처리
     * actualGasCost: 실제 소모된 gas (wei)
     */
    function _postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost
    ) internal override {
        // TODO: context 디코딩 → 실제 비용 내부 원장 기록
        // (address sender, uint256 maxCost) = abi.decode(context, (address, uint256));
        // emit GasCostRecorded(sender, actualGasCost);
    }
}
```

**구현 힌트:**

1. `approvedAccounts[userOp.sender]`가 `false`이면 `validationData = 1`을 반환한다.
2. `maxCost > DAILY_GAS_LIMIT`이면 거부한다.
3. 승인 시 `context = abi.encode(userOp.sender, maxCost)` → `postOp`에서 정산에 사용한다.

---

### Bundler RPC 호출 시뮬레이션 (TypeScript)

```typescript
// bundler-client.ts

const BUNDLER_RPC = 'https://bundler.example.com/rpc';
const ENTRY_POINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';

async function sendUserOperation(op: UserOperation): Promise<string> {
  // Bundler RPC: eth_sendUserOperation
  const response = await fetch(BUNDLER_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_sendUserOperation',
      params: [
        {
          ...op,
          nonce:                '0x' + op.nonce.toString(16),
          callGasLimit:         '0x' + op.callGasLimit.toString(16),
          verificationGasLimit: '0x' + op.verificationGasLimit.toString(16),
          preVerificationGas:   '0x' + op.preVerificationGas.toString(16),
          maxFeePerGas:         '0x' + op.maxFeePerGas.toString(16),
          maxPriorityFeePerGas: '0x' + op.maxPriorityFeePerGas.toString(16),
        },
        ENTRY_POINT,
      ],
      id: 1,
    }),
  });

  const { result, error } = await response.json();
  if (error) throw new Error(`Bundler error: ${error.message}`);

  // result = userOperationHash (EOA TX의 txHash에 해당)
  return result as string;
}

// 상태 확인: eth_getUserOperationReceipt
async function waitForReceipt(userOpHash: string): Promise<void> {
  // TODO: 폴링 or Bundler 웹소켓으로 receipt 대기
  // receipt.success = true → EntryPoint에서 실행 완료
}
```

---

## 완료 기준

- [ ] EOA 모델의 한계 3가지 설명 가능 (gas, 복구, 서명 고정)
- [ ] ERC-4337 4개 컴포넌트 역할 설명: UserOperation, Bundler, EntryPoint, Account
- [ ] validateUserOp()이 S29 ecrecover와 동일한 원리임을 코드에서 확인
- [ ] Paymaster의 역할과 교보생명 적용 시나리오 설명 가능
- [ ] KyoboPaymaster 스텁 완성 (approvedAccounts 검증 + context 반환)
- [ ] Phase 1에서 AA가 불필요한 이유, Phase 3에서 필요해지는 이유 설명 가능
- [ ] UserOperation과 EOA TX의 구조적 차이 비교 가능
