# M9 S46 — Gnosis Safe + EIP-712 멀티시그 원리 · 키 거버넌스 설계

> **모듈 9 · 세션 46 · 강의 40분 + 실습 15분 = 55분**
> M9는 거버넌스 + 미니프로젝트 모듈이다. S46은 M1~M8에서 쌓아온 모든 지식을 "키 거버넌스"라는 관점으로 통합하는 세션이다.

---

## 목차

1. [강사 배경] EIP-712 완전 이해
2. [강사 배경] Gnosis Safe 내부 아키텍처
3. [강사 배경] 실제 해킹 사례 — Ronin Bridge, Harmony Horizon
4. [강사 배경] MPC(Multi-Party Computation) 이해
5. [강사 배경] TimeLock 개념
6. [강의] 단일 HOT 키 위험
7. [강의] k-of-n 멀티시그 설계
8. [강의] EIP-712 SafeTx — 오프체인 서명
9. [강의] SafeTx 생명주기 4단계
10. [강의] 키 분실 복구 절차
11. [강의] MPC로의 진화
12. [실습] Hardhat에서 Gnosis Safe 배포 + EIP-712 검증
13. 강의 진행 시간표 (분 단위)
14. 핵심 용어 정리

---

# [강사 배경] — 수업 슬라이드에 없어도 강사가 반드시 숙지해야 할 깊은 내용

---

## 1. EIP-712 완전 이해

### 1-1. EIP-712 이전의 eth_sign 취약점

EIP-712 이전에는 `eth_sign`이라는 방법만 있었다. `eth_sign`은 임의 바이트에 서명할 수 있다.

```
eth_sign(keccak256("\x19Ethereum Signed Message:\n" + message))
```

문제: "임의 바이트"라는 점이다.

```
공격자가 피해자에게 메시지 서명 요청:
  "이 메시지에 서명해주세요: 0xdeadbeef..."

피해자가 서명 → 서명값 = ECDSA(privateKey, 0xdeadbeef...)

공격자가 같은 서명값을 다른 컨트랙트에서 재사용:
  → token.transfer(attacker, amount) 호출에 피해자 서명 첨부
  → 피해자가 동의한 적 없는 TX 실행
```

EIP-191의 `\x19Ethereum Signed Message:\n` 접두사를 붙여도 근본 문제는 해결되지 않는다. "무엇에 서명하는가"의 의미가 없다.

**재생 공격(Replay Attack) 원리:**

```
시나리오:
  1. 이더리움 메인넷에서 특정 TX에 서명 (서명값 S)
  2. 이더리움 클래식(포크된 체인)에서 같은 서명값 S 재사용
  → 같은 개인키에서 동일한 서명값 → 두 체인 모두 유효

해결 필요:
  - 서명에 "어느 체인의 어느 컨트랙트를 위한 서명인가" 명시
  - chainId와 verifyingContract 주소를 서명 데이터에 포함
```

### 1-2. EIP-712 TypedData 서명 완전 구조

EIP-712는 "구조화된 데이터(Typed Data)에 서명"하는 표준이다.

```
최종 서명 대상 = keccak256(
  "\x19\x01"          ← EIP-712 접두사 (EIP-191의 버전 바이트)
  + domainSeparator   ← 이 서명이 어느 앱·체인·컨트랙트용인지 식별
  + hashStruct        ← 실제 서명 대상 데이터의 해시
)
```

**DOMAIN_SEPARATOR 계산:**

```solidity
// EIP-712 도메인 타입 해시
bytes32 DOMAIN_TYPEHASH = keccak256(
  "EIP712Domain(uint256 chainId,address verifyingContract)"
);

// Gnosis Safe의 도메인 분리자 (Safe.sol에서 실제 사용)
bytes32 domainSeparator = keccak256(
  abi.encode(
    DOMAIN_TYPEHASH,
    block.chainid,          // 체인 ID
    address(this)           // Safe 컨트랙트 주소
  )
);
```

**hashStruct 계산 (SafeTx 예시):**

```solidity
bytes32 SAFE_TX_TYPEHASH = keccak256(
  "SafeTx("
    "address to,"
    "uint256 value,"
    "bytes data,"
    "uint8 operation,"
    "uint256 safeTxGas,"
    "uint256 baseGas,"
    "uint256 gasPrice,"
    "address gasToken,"
    "address refundReceiver,"
    "uint256 nonce"
  ")"
);

bytes32 hashStruct = keccak256(
  abi.encode(
    SAFE_TX_TYPEHASH,
    to,
    value,
    keccak256(data),        // bytes 타입은 keccak256으로 먼저 해시
    operation,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    nonce
  )
);
```

**핵심 포인트: `bytes` 타입 처리**

ABI 인코딩에서 `bytes`는 동적 크기 타입이다. EIP-712 스펙은 동적 타입(bytes, string, array)을 keccak256으로 먼저 해시하여 고정 크기 bytes32로 변환한 뒤 인코딩한다. 이를 모르면 SafeTx 해시 계산이 Safe 컨트랙트와 달라져 서명 검증이 실패한다.

```
abi.encode([...]) vs keccak256(bytes)
  - 정적 타입 (address, uint256, bytes32): abi.encode에 직접 포함
  - 동적 타입 (bytes, string, bytes[]): keccak256으로 먼저 해시 후 포함
```

**최종 SafeTx 해시:**

```solidity
bytes32 safeTxHash = keccak256(
  abi.encodePacked(
    bytes1(0x19),       // EIP-191 버전 바이트
    bytes1(0x01),       // EIP-712 구조화 데이터 표시자
    domainSeparator,    // 체인 + 컨트랙트 바인딩
    hashStruct          // SafeTx 구조체 해시
  )
);
```

### 1-3. chainId를 포함하는 이유

```
이더리움 메인넷(chainId=1)에서 서명한 SafeTx:
  domainSeparator = keccak256(DOMAIN_TYPEHASH, 1, 0xSafeAddress)

Sepolia 테스트넷(chainId=11155111)에서 같은 서명 재사용 시도:
  domainSeparator = keccak256(DOMAIN_TYPEHASH, 11155111, 0xSafeAddress)
  → 다른 domainSeparator → 다른 safeTxHash
  → ecrecover → 다른 주소 복원 → owners 목록에 없음 → revert

결론: chainId로 인해 크로스체인 재생 공격 원천 차단
```

### 1-4. MetaMask에서 보이는 EIP-712 서명 화면

MetaMask는 EIP-712 서명 요청을 받으면 사람이 읽을 수 있는 형태로 표시한다:

```
┌─────────────────────────────────────────┐
│  서명 요청                               │
│  출처: safe.kyobo.io                    │
├─────────────────────────────────────────┤
│  SafeTx                                  │
│  ─────────────────────────────────────  │
│  to: 0xKyoboNFT...1234                  │
│  value: 0                               │
│  data: 0xa9059cbb... (grantRole)        │
│  operation: 0 (CALL)                    │
│  nonce: 5                               │
├─────────────────────────────────────────┤
│  도메인                                  │
│  chainId: 1 (이더리움 메인넷)             │
│  verifyingContract: 0xSafe...abcd       │
└─────────────────────────────────────────┘
  [서명 거부]          [서명]
```

임의 바이트(eth_sign)와 달리 "무엇에 서명하는가"가 명확하다. 서명자가 내용을 검증하고 서명할 수 있다.

### 1-5. ethers.js v6에서 EIP-712 서명

```typescript
import { ethers } from 'ethers';

const signer = new ethers.Wallet(privateKey, provider);

// EIP-712 도메인 정의
const domain = {
  chainId: 31337,                          // Hardhat local
  verifyingContract: safeAddress,          // Safe 컨트랙트 주소
};

// 타입 정의
const types = {
  SafeTx: [
    { name: 'to',              type: 'address' },
    { name: 'value',           type: 'uint256' },
    { name: 'data',            type: 'bytes'   },
    { name: 'operation',       type: 'uint8'   },
    { name: 'safeTxGas',       type: 'uint256' },
    { name: 'baseGas',         type: 'uint256' },
    { name: 'gasPrice',        type: 'uint256' },
    { name: 'gasToken',        type: 'address' },
    { name: 'refundReceiver',  type: 'address' },
    { name: 'nonce',           type: 'uint256' },
  ],
};

// 서명 대상 값
const value = {
  to:             kyoboNftAddress,
  value:          0n,
  data:           grantRoleCalldata,
  operation:      0,
  safeTxGas:      0n,
  baseGas:        0n,
  gasPrice:       0n,
  gasToken:       ethers.ZeroAddress,
  refundReceiver: ethers.ZeroAddress,
  nonce:          5n,
};

// ethers v6 EIP-712 서명 — 내부적으로 "\x19\x01" + domainSeparator + hashStruct 계산
const signature = await signer.signTypedData(domain, types, value);

// 서명 검증 (로컬에서 주소 복원)
const recoveredAddress = ethers.verifyTypedData(domain, types, value, signature);
console.log(recoveredAddress === await signer.getAddress()); // true
```

**주의: ethers v5 vs v6 차이**

```typescript
// ethers v5 (구버전)
await signer._signTypedData(domain, types, value);   // 언더스코어 붙음

// ethers v6 (현재)
await signer.signTypedData(domain, types, value);    // 언더스코어 없음
```

---

## 2. Gnosis Safe 내부 아키텍처

### 2-1. 컨트랙트 구조와 역할

```
Gnosis Safe 컨트랙트 계층:

Safe.sol (싱글톤 구현체)
├── 실제 로직: execTransaction, addOwner, removeOwner, swapOwner
├── 서명 검증: checkNSignatures (ecrecover 루프)
└── 모듈/가드 시스템

SafeProxy.sol (각 Safe 인스턴스)
├── 최소한의 폴백(fallback) 코드만 포함
├── DELEGATECALL로 Safe.sol 로직 실행
└── 스토리지는 Proxy에 저장

SafeProxyFactory.sol (Safe 배포 팩토리)
├── createProxyWithNonce(singleton, initializer, saltNonce)
└── CREATE2로 결정적 주소 생성 (같은 설정 = 같은 주소)
```

왜 Proxy 패턴을 쓰는가?

```
대형 컨트랙트 배포 비용:
  Safe.sol 전체 배포: ~$50~100 (메인넷)
  SafeProxy 배포:    ~$2~5

Safe.sol은 한 번만 배포(싱글톤). 각 사용자는 SafeProxy만 배포.
SafeProxy가 DELEGATECALL로 Safe.sol 로직을 실행 → 스토리지는 Proxy에 기록.
```

### 2-2. SafeTx 구조체 전체 필드 설명

```solidity
struct SafeTx {
    address to;           // 실행 대상 컨트랙트 주소
    uint256 value;        // ETH 전송량 (wei 단위, 보통 0)
    bytes   data;         // ABI-encoded 함수 호출 데이터
    uint8   operation;    // 0 = CALL, 1 = DELEGATECALL
    uint256 safeTxGas;    // 내부 TX 실행에 할당할 가스 (0이면 전체 가스)
    uint256 baseGas;      // 데이터 비용 등 기본 가스 (가스 환급 계산용)
    uint256 gasPrice;     // 가스 환급 가격 (gasToken 사용 시)
    address gasToken;     // 가스비 대납 토큰 (ZeroAddress = ETH)
    address refundReceiver; // 가스비 환급받을 주소
    uint256 nonce;        // Safe 내부 nonce (재생 공격 방지)
}
```

**실무에서 대부분의 필드는 0:**

```typescript
const safeTx = {
  to:             targetContract,
  value:          0n,
  data:           encodedCalldata,
  operation:      0,               // 항상 CALL (DELEGATECALL은 위험)
  safeTxGas:      0n,              // 0 = 제한 없음
  baseGas:        0n,
  gasPrice:       0n,
  gasToken:       ethers.ZeroAddress,
  refundReceiver: ethers.ZeroAddress,
  nonce:          await safe.getNonce(),  // 반드시 현재 nonce 사용
};
```

### 2-3. operation=DELEGATECALL의 위험성

```
DELEGATECALL의 특성:
  - 호출 대상 컨트랙트의 코드를 Safe의 컨텍스트에서 실행
  - 실행 주체는 Safe, 스토리지 읽기/쓰기도 Safe에서 발생
  - msg.sender, msg.value → Safe의 것

악용 시나리오:
  1. 공격자가 악성 컨트랙트 배포:
       function attack() external {
         // Safe의 owners 슬롯을 직접 덮어씀
         assembly { sstore(2, attacker) }
       }
  
  2. operation=1(DELEGATECALL)로 악성 컨트랙트 호출하는 SafeTx 제안
  
  3. 2-of-3 서명자들이 "data" 내용을 확인하지 않고 서명
  
  4. execTransaction → DELEGATECALL → Safe 스토리지 덮어쓰기
     → owners가 공격자로 교체 → Safe 완전 장악

교훈:
  - 실무에서 operation=0(CALL)만 사용하는 것이 원칙
  - 서명자는 반드시 data 내용을 디코딩해서 확인해야 함
  - Guard 시스템으로 DELEGATECALL을 정책적으로 차단 가능
```

### 2-4. execTransaction 내부 동작

```solidity
// Safe.sol (단순화된 의사 코드)
function execTransaction(
    address to,
    uint256 value,
    bytes calldata data,
    uint8 operation,
    uint256 safeTxGas,
    uint256 baseGas,
    uint256 gasPrice,
    address gasToken,
    address payable refundReceiver,
    bytes memory signatures
) public payable returns (bool success) {

    // 1. SafeTx 해시 계산 (nonce 포함)
    bytes32 txHash = getTransactionHash(to, value, data, operation,
                                        safeTxGas, baseGas, gasPrice,
                                        gasToken, refundReceiver, nonce);

    // 2. nonce 즉시 증가 (재생 공격 방지 — 실행 전에 증가)
    nonce++;

    // 3. Guard 체크 (설정된 경우)
    if (guard != address(0)) {
        IGuard(guard).checkTransaction(...);
    }

    // 4. 서명 검증
    //    - signatures에서 서명자 주소 복원 (ecrecover)
    //    - owners 목록에 있는지 확인
    //    - 복원된 서명자 수 >= threshold 확인
    checkNSignatures(txHash, data, signatures, threshold);

    // 5. 실제 실행
    if (operation == 1) {
        success = executeDelegateCall(to, gasleft(), data);
    } else {
        success = executeCall(to, value, gasleft(), data);
    }

    // 6. Guard 후처리 체크
    if (guard != address(0)) {
        IGuard(guard).checkAfterExecution(txHash, success);
    }

    // 7. 이벤트 발행
    emit ExecutionSuccess(txHash, payment);  // 또는 ExecutionFailure
}
```

**핵심: nonce 증가가 실행 전에 발생**

nonce가 실행 전에 먼저 증가한다. 따라서 동일 nonce로 같은 SafeTx를 두 번 실행하려 해도 두 번째 시도는 다른 txHash가 된다 → 서명 불일치 → revert.

### 2-5. Safe Module 시스템

```
Module 시스템:
  - Safe에 플러그인처럼 기능 추가 가능
  - 모듈은 execTransactionFromModule()로 서명 없이 Safe TX 실행 가능
  - 단, 모듈 등록 자체는 2-of-3 멀티시그 TX로만 가능

주요 모듈:
┌─────────────────────────────────────────────────────────┐
│ TimelockController   │ 제안 후 N시간 후에만 실행         │
│ AllowanceModule      │ 특정 주소에 한도 내 출금 권한 부여 │
│ SpendingLimitModule  │ 기간별 지출 한도 설정             │
│ RecoveryModule       │ 소셜 복구 (신뢰자 승인 기반 복구)  │
└─────────────────────────────────────────────────────────┘

실무 적용:
  교보생명 Safe에 AllowanceModule 적용 시:
  → MINTER_ROLE을 가진 서버 주소가 Safe 멀티시그 없이도
    일일 한도 내에서 grantRole 가능
  → 단, 한도 초과 시 2-of-3 필요
```

### 2-6. Guard 시스템

```solidity
interface IGuard {
    // TX 실행 전 호출 — 조건 위반 시 revert 가능
    function checkTransaction(
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures,
        address msgSender
    ) external;

    // TX 실행 후 호출 — 사후 검증
    function checkAfterExecution(bytes32 txHash, bool success) external;
}
```

```
Guard 활용 예시:

1. DELEGATECALL 차단 Guard:
   checkTransaction 내부:
     require(operation != 1, "DELEGATECALL_FORBIDDEN");

2. 주소 화이트리스트 Guard:
   require(allowedTargets[to], "UNAUTHORIZED_TARGET");

3. 시간 제한 Guard:
   require(block.timestamp >= executionWindowStart, "TOO_EARLY");

4. 금액 한도 Guard:
   require(value <= dailyLimit, "DAILY_LIMIT_EXCEEDED");
```

---

## 3. 실제 해킹 사례 — 강사가 알아야 할 교훈

### 3-1. Ronin Bridge 해킹 (2022년 3월, $620M)

```
구성: 9개 validator 중 5개 서명 필요 (5-of-9 멀티시그)
해킹:
  - Sky Mavis(Axie Infinity 개발사) 측 validator 4개 보유
  - Axie DAO validator 1개 보유
  - Sky Mavis 4개 + Axie DAO 1개 = 5개 탈취

문제의 핵심:
  - Sky Mavis가 4개 validator 키를 모두 AWS에 보관
  - 코드 취약점으로 서버 접근 → 키 4개 동시 탈취
  - Axie DAO는 과거 Sky Mavis에 일시적 TX 권한 위임했고
    이 권한이 철회되지 않은 상태 → 사회공학 공격으로 1개 탈취

교훈:
  - threshold=5가 있어도 4개 키가 같은 인프라에 있으면 의미 없음
  - 키의 물리적·논리적 분리가 threshold 수보다 더 중요
  - 권한 위임 후 반드시 철회 확인 (expiry 없는 권한 위임 금지)
```

### 3-2. Harmony Horizon Bridge (2022년 6월, $100M)

```
구성: 5개 서명 중 2개 필요 (2-of-5 멀티시그)
해킹:
  - 2개 서명자 키가 동일 서버에 보관
  - 단일 서버 침해 → 2개 키 동시 탈취 → threshold 즉시 충족

문제의 핵심:
  - 2-of-5라고 해도 2개 키가 같은 위치에 있으면 1-of-1과 동일
  - "멀티시그"의 물리적 의미가 없는 구성

교훈:
  - 2-of-3 설계에서 "3개 키는 3개의 다른 곳에 있어야 한다"
  - 교보생명 구성: VASP 서버 HSM / 교보 IT 사내 HSM / 준법감시 오프라인 HSM
    → 하나의 시설이 침해되어도 나머지 2곳 중 1곳이 남으면 안전
```

### 3-3. 교보생명 2-of-3 설계의 실제 의미

```
단순히 "2-of-3"이 아니라:

┌─────────────────────┬────────────────────┬──────────────────────┐
│ 서명자               │ 소속                │ 키 보관 위치          │
├─────────────────────┼────────────────────┼──────────────────────┤
│ VASP 기술 서버       │ 기술 팀              │ AWS KMS (HSM 급)     │
│ 교보 IT 담당자       │ 교보생명 IT 부서      │ 사내 온프레미스 HSM   │
│ 준법감시인           │ 준법감시 부서         │ 오프라인 콜드 스토리지 │
└─────────────────────┴────────────────────┴──────────────────────┘

물리적 분리:
  - 클라우드(AWS) / 사내망 / 완전 오프라인
  → 세 위치를 동시에 침해하는 것은 현실적으로 불가능

조직적 분리:
  - 기술 실행 / 운영 승인 / 컴플라이언스 체크
  → 내부 공모 위험도 3인 합의가 필요하므로 감소
```

---

## 4. MPC(Multi-Party Computation) 이해

### 4-1. Multisig vs MPC 핵심 차이

```
Multisig (Gnosis Safe):
  키 A ────────── 서명자 A가 완전한 키 보유
  키 B ────────── 서명자 B가 완전한 키 보유
  키 C ────────── 서명자 C가 완전한 키 보유
  
  Safe 컨트랙트가 세 서명을 검증하고 실행
  
  위험: 키 B가 탈취되면 → 공격자가 B의 서명을 독립적으로 생성 가능
        (물론 혼자 threshold를 충족하진 못하지만 키 자체는 노출)

MPC/TSS (Threshold Signature Scheme):
  파편 a ─── 서명자 A가 보관 (전체 키의 1/3 같은 "조각", 완전한 키 아님)
  파편 b ─── 서명자 B가 보관
  파편 c ─── 서명자 C가 보관
  
  서명 필요 시: A, B, C가 통신 프로토콜에 참여 → 완전한 서명 생성
               완전한 개인키는 어디에도 존재하지 않음 (메모리에도 잠깐도 없음)
  
  온체인에서 보면: 일반 EOA 서명과 완전히 동일 → 추가 가스 없음
```

### 4-2. TSS 동작 원리 (개념)

**Shamir Secret Sharing:**

```
비밀값 s를 n개의 파편으로 분할:
  임의 다항식 f(x) = s + a₁x + a₂x² + ... + aₜ₋₁xᵗ⁻¹  (t: threshold)
  
  각 참여자 i에게 파편 (i, f(i)) 배포
  
  t개 이상의 파편이 있으면 f(0) = s 복원 가능
  t-1개 이하의 파편으로는 s에 대한 정보 없음 (정보이론적 안전)

Distributed Key Generation (DKG):
  - 완전한 키를 생성 후 나누는 것이 아님
  - 처음부터 파편 형태로 생성 → 완전한 키가 어느 순간도 존재하지 않음
```

### 4-3. 온체인에서 MPC 서명은 일반 EOA와 구분 불가

```
MPC로 서명된 TX:
  - 이더리움 TX 구조: from, to, value, data, v, r, s
  - v, r, s: 표준 ECDSA 서명값 (65바이트)
  - Safe 멀티시그와 달리 추가 바이트 없음

Safe 멀티시그 TX:
  - execTransaction 호출 TX
  - signatures 파라미터: 65바이트 × 서명자 수
  - 추가 가스 비용 발생 (서명 검증 루프)

→ MPC는 가스 비용 면에서 단일 서명과 동일
→ 온체인 프라이버시: 몇 명이 서명에 참여했는지 알 수 없음
```

### 4-4. 업계 MPC 솔루션

```
엔터프라이즈:
  Fireblocks — 가장 널리 사용, FIX API, 웹훅, 정책 엔진 포함
               교보생명 Phase 2에서 HOT 키 MPC화 시 고려 대상
  
  Copper ClearLoop — 거래소 연동 특화
  
개인용:
  ZenGo — 사용자 기기 + ZenGo 서버 2-of-2 MPC
  Coinbase MPC Wallet — 기기 + 클라우드 2-of-2

한계:
  - 통신 오버헤드: 서명 시 N라운드 통신 필요 (지연 발생)
  - 표준 부재: 각 솔루션이 독자 프로토콜 사용 (상호 호환성 없음)
  - 오프라인 서명 불가: 모든 파편 보유자가 동시 온라인 필요
  - 감사 어려움: 내부 프로토콜이 불투명한 경우 많음
```

---

## 5. TimeLock 개념

### 5-1. OpenZeppelin TimelockController

```
일반 관리 TX:
  관리자 서명 → 즉시 실행

TimeLock 적용:
  관리자 서명 → 제안 (schedule)
              → N시간 대기 (minDelay 경과)
              → 실행 가능 (execute)
```

```solidity
// TimelockController 핵심 함수
contract TimelockController {
    uint256 public minDelay;  // 최소 대기 시간 (예: 48 * 3600 = 48시간)
    
    // 작업 제안 (즉시 실행 안 됨)
    function schedule(
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 predecessor,  // 선행 작업 ID (없으면 0)
        bytes32 salt,
        uint256 delay         // 대기 시간 (>= minDelay)
    ) external onlyRole(PROPOSER_ROLE);
    
    // 대기 후 실행 (delay 경과 후에만 가능)
    function execute(
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 predecessor,
        bytes32 salt
    ) external payable onlyRole(EXECUTOR_ROLE);
    
    // 취소 (CANCELLER_ROLE만 가능)
    function cancel(bytes32 id) external;
}
```

### 5-2. Gnosis Safe + TimeLock 조합 패턴

```
일반 패턴:
  Gnosis Safe (2-of-3) → 즉시 실행

Safe + TimeLock 조합:
  Gnosis Safe (2-of-3) → TimelockController → 48시간 후 → 실행
  
구성 방법:
  - Safe의 UPGRADER_ROLE을 TimelockController에 부여
  - Safe가 TimelockController.schedule() 호출 → 제안
  - 48시간 후 Safe(또는 다른 executor)가 execute() 호출

이 조합의 의미:
  - 키 탈취 + 2-of-3 서명 수집 성공하더라도
  - 48시간 안에 감사·사용자·당국이 이상 감지 가능
  - cancel()로 취소 가능 (단, CANCELLER_ROLE 키는 별도 보관)
```

### 5-3. TimeLock이 필요한 이유 — 탈취 시 대피 시간

```
탈취 시나리오 (TimeLock 없음):
  [00:00] 공격자가 키 2개 탈취
  [00:01] 악성 컨트랙트로 upgradeToAndCall SafeTx 제안
  [00:02] 2-of-3 서명 완료 (탈취된 키 2개로)
  [00:03] execTransaction → 컨트랙트 교체 → 고객 자산 탈취
  [00:10] 감사팀 이상 감지 → 이미 완료

탈취 시나리오 (TimeLock 48시간 적용):
  [00:00] 공격자가 키 2개 탈취
  [00:01] schedule() 호출 (제안, 즉시 실행 안 됨)
  [01:00] 보안 모니터링이 TimelockController 이벤트 감지
  [02:00] 교보생명 보안팀 경보
  [06:00] CANCELLER_ROLE로 cancel() 호출 → 취소
  [47:00] (공격자가 48시간을 기다려도 취소되어 있음)
  
  → 피해 0
```

---

# [강의] — 실제 50분 수업에서 전달할 내용

---

## 6. [강의] 단일 HOT 키 위험 — "키 1개 탈취 시 전권"

### M8까지 우리가 만든 구조

M8에서 KyoboNFT.sol에 역할 기반 접근 제어를 구현했다.

```
현재 구조:
  VASP 서버 지갑 (HOT KEY)
  → UPGRADER_ROLE 보유
  → upgradeToAndCall(newImpl) 단독 호출 가능
```

HOT KEY란 무엇인가? 서버 메모리 또는 환경 변수에 저장된 개인키다. 서버가 실행되는 동안 항상 메모리에 존재한다.

```
HOT KEY 탈취 시나리오:
  공격자 → 서버 취약점(RCE) 공격 → 메모리 덤프
  → HOT KEY 탈취
  → upgradeToAndCall(악성 구현체) 실행
  
악성 구현체 내부:
  function mint(address to, uint256 id, uint256 amount) external {
      // 접근 제어 없음
      _mint(to, id, amount);  // 무제한 발행
  }
  
결과:
  → 전 가입자 NFT 잔액 무한 발행 가능
  → 교보생명 고객 전원 피해
  → 금융당국 제재 (전자금융거래법 위반)
```

**금융 시스템에서 왜 허용되지 않는가?**

```
전통 금융 내부 통제 원칙:
  "어느 단일 개인도 혼자 시스템 전체를 변경할 수 없어야 한다"
  
  → 회계 담당자 1명이 혼자 대형 이체 불가 (복수 결재 필요)
  → IT 담당자 1명이 혼자 핵심 시스템 변경 불가 (승인 프로세스 필요)
  
블록체인도 동일:
  → 서버 키 1개가 컨트랙트 업그레이드 권한 = 내부 통제 없는 구조
  → 금융규제 감독 대상이 되는 순간 허용 불가
```

---

## 7. [강의] k-of-n 멀티시그 설계

### 기본 원리

```
단일 서명 (현재):          멀티시그 (목표):
  키 1개 → 실행 가능          키 n개 중 k개 서명 필요

k-of-n의 의미:
  k = threshold (임계값)
  n = 총 서명자 수
  
  k개 미만이면 아무것도 실행 불가
  k개 이상이면 실행 가능
```

### 교보생명 2-of-3 구성

```
┌─────────────────────────────────────────────────────────────┐
│  Gnosis Safe — threshold=2, owners=3                        │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ 서명자 A      │  │ 서명자 B      │  │ 서명자 C          │  │
│  │ VASP 기술팀   │  │ 교보 IT 운영  │  │ 준법감시팀        │  │
│  │ AWS KMS      │  │ 사내 HSM     │  │ 오프라인 HSM      │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                             │
│  실행 조건: A+B 또는 A+C 또는 B+C → 2명이 동의              │
└─────────────────────────────────────────────────────────────┘
```

**어떤 TX가 멀티시그를 요구하는가?**

```
┌─────────────────────────────────┬────────────────┬──────────────┐
│ TX 종류                          │ 결재 방식        │ 이유          │
├─────────────────────────────────┼────────────────┼──────────────┤
│ 일반 NFT 발행(mint)              │ 서버 단독 서명   │ 실시간 필요   │
│ 메타데이터 업데이트               │ 서버 단독 서명   │ 빈번한 작업   │
├─────────────────────────────────┼────────────────┼──────────────┤
│ 컨트랙트 업그레이드(upgradeToAnd) │ 2-of-3 필수     │ 시스템 전체   │
│ MINTER_ROLE 추가/제거            │ 2-of-3 필수     │ 권한 변경     │
│ Safe 소유자 변경(swapOwner)       │ 2-of-3 필수     │ 거버넌스 변경 │
│ 대형 ETH/토큰 이체               │ 2-of-3 필수     │ 자산 위험     │
└─────────────────────────────────┴────────────────┴──────────────┘
```

**threshold 숫자의 의미:**

```
1-of-3: 1명이 반대해도 나머지 1명이 실행 가능 → 너무 낮음
2-of-3: 1명이 탈취/분실되어도 나머지 2명이 대응 가능 (균형)
3-of-3: 1명만 거부해도 실행 불가 → 교착 위험 높음

금융 실무에서는 2-of-3 또는 3-of-5가 일반적
```

---

## 8. [강의] EIP-712 SafeTx — 오프체인 서명으로 온체인 TX 승인

### 왜 오프체인 서명이 필요한가?

단순한 멀티시그 구현을 상상해보자:

```
순진한 멀티시그:
  서명자 A → 온체인 TX 전송 (가스비 지불)
  서명자 B → 온체인 TX 전송 (가스비 지불)
  2개 TX 확인 후 실행

문제:
  1. A가 먼저 TX 전송 → B가 TX 전송 → 순서 맞춰야 함
  2. 3번의 가스비 발생 (A 서명 TX + B 서명 TX + 실행 TX)
  3. 서명자들이 같은 시간에 온라인이어야 함
  4. 네트워크 지연 동안 상태 관리 복잡
```

Gnosis Safe의 해결 방식:

```
오프체인 EIP-712 서명:
  서명자 A → 오프체인에서 SafeTx 해시에 서명 → 서명값(65바이트) 반환
             가스비: 0원 / 시간: 즉시
  
  서명자 B → 같은 방식으로 서명
             가스비: 0원
  
  실행자(A 또는 B) → Safe.execTransaction(params, [sigA, sigB]) 호출
                   → 이 한 번의 TX만 가스 발생
  
결과:
  - 서명자는 가스비 없이 승인 가능
  - 비동기: 각자 다른 시간에 서명 가능
  - 단일 온체인 TX: 가스 효율
```

### EIP-712 서명이 "안전한" 이유

```
임의 바이트 서명 (위험):
  서명자에게 "이 해시에 서명해줘: 0xabcd..."
  → 서명자는 0xabcd...가 무엇인지 모름
  → MetaMask에 "0xabcd..."만 표시 → 서명 거부 불가능
  → 공격자가 이 서명을 다른 용도로 재사용 가능

EIP-712 구조화 서명 (안전):
  SafeTx 구조체에 서명:
  {
    to: "0xKyoboNFT...",
    value: 0,
    data: "grantRole(MINTER_ROLE, 0x...)",
    nonce: 5
  }
  → MetaMask에 인간 가독 형태로 표시
  → 서명자가 내용 확인 후 서명
  → chainId + Safe 주소 포함 → 다른 컨텍스트에서 재사용 불가
```

### 재생 공격 방지 — 두 가지 레이어

```
레이어 1: EIP-712 도메인 분리자 (크로스 컨텍스트 방지)
  domainSeparator = keccak256(chainId + verifyingContract)
  
  → 이더리움 메인넷 Safe(A) 서명을 Sepolia Safe(B)에서 재사용 불가
  → 같은 체인의 다른 Safe 주소에서도 재사용 불가

레이어 2: nonce (동일 Safe 내 재사용 방지)
  SafeTx에 nonce 필드 포함
  execTransaction 실행 시 Safe.nonce++ (실행 전에 증가)
  
  → 동일 Safe에서 같은 TX를 두 번 실행하려 해도
    nonce가 달라 txHash가 달라져 서명 불일치
```

---

## 9. [강의] SafeTx 생명주기 4단계

```
┌─────────────────────────────────────────────────────────────────────┐
│                     SafeTx 생명주기                                   │
└─────────────────────────────────────────────────────────────────────┘

[1단계] proposeTx — VASP 기술팀이 TX 제안
  ┌──────────────────────────────────────────┐
  │  실행 내용 정의:                           │
  │  to:    KyoboNFT 컨트랙트 주소             │
  │  data:  grantRole(MINTER_ROLE, 0xNew...)  │
  │  nonce: 현재 Safe nonce (예: 5)            │
  │                                          │
  │  → EIP-712 SafeTx 해시 계산               │
  │  → DB에 PENDING_SIGNATURES 상태 저장      │
  │  → 서명자 B, C에게 알림 발송               │
  └──────────────────────────────────────────┘
  
  오프체인 (블록체인에 아무것도 기록 안 됨)

      ↓

[2단계] addSignature × n — 서명자들이 순차 서명
  ┌──────────────────────────────────────────┐
  │  서명자 A (VASP):                         │
  │    SafeTx 내용 확인 → MetaMask로 서명      │
  │    signature_A → DB 저장                 │
  │                                          │
  │  서명자 B (교보 IT):                       │
  │    SafeTx 내용 확인 → 자체 시스템으로 서명  │
  │    signature_B → DB 저장                 │
  │                                          │
  │  수집 서명 수(2) >= threshold(2)           │
  │  → DB 상태 READY_TO_EXECUTE              │
  └──────────────────────────────────────────┘
  
  오프체인 (각 서명은 65바이트 ECDSA 서명값)

      ↓

[3단계] executeTx — 한 번의 온체인 TX
  ┌──────────────────────────────────────────┐
  │  DB에서 서명 A, B 로드                    │
  │  Safe.execTransaction(                   │
  │    to, value, data, operation,           │
  │    ...,                                  │
  │    signatures = [sig_A || sig_B]         │  ← 서명들 이어붙임
  │  )                                       │
  │  → Safe 컨트랙트 온체인 실행              │
  │  → 서명 검증 → grantRole 실행            │
  │  → 가스비: 실행자(A 또는 B) 부담          │
  └──────────────────────────────────────────┘
  
  온체인 (이때 처음으로 블록체인에 기록)

      ↓

[4단계] 완료
  ┌──────────────────────────────────────────┐
  │  onchain txHash → DB 기록                │
  │  DB 상태 → EXECUTED                      │
  │  감사 로그 기록 (누가, 언제, 무엇을)       │
  └──────────────────────────────────────────┘
```

**threshold 미달 시 무슨 일이 일어나는가?**

```
실행자가 1개 서명만으로 execTransaction 호출 시:

Safe 컨트랙트 내부 (의사 코드):
  validSignatures = 0
  for each 65-byte signature in signatures:
      signer = ecrecover(safeTxHash, signature)
      if signer in owners:
          validSignatures++
  
  require(validSignatures >= threshold, "GS020");
  // GS020: Gnosis Safe 에러 코드 — threshold 미달
  
  → TX revert
  → 가스비는 소모됨 (실행자 손해)
  → 컨트랙트 상태 변경 없음

교훈: 서버 레이어에서 threshold 충족 여부를 먼저 확인 후 온체인 TX 전송
```

---

## 10. [강의] 키 분실 복구 — swapOwner

### 시나리오: 서명자 B(교보 IT)가 키를 분실했다

```
현재 상황:
  owners: [A(VASP), B(교보IT), C(준법감시)]
  threshold: 2
  B의 키: 분실 (하드웨어 고장 등)

B를 D(신규 담당자)로 교체:

[1단계] A + C가 swapOwner TX 제안
  data: Safe.swapOwner(prevOwner=A, oldOwner=B, newOwner=D)
  → "B(0xOld)를 D(0xNew)로 교체"

[2단계] A와 C가 오프체인 서명 (2-of-3 충족: B 없이도 가능)

[3단계] execTransaction → Safe가 swapOwner 실행
  → owners: [A, D, C]
  → B는 더 이상 서명자 아님

[4단계] D가 서명자로 등록됨
  → 이후 D의 키로 서명 가능
```

**1-of-1(단일 키)에서는 불가능:**

```
단일 키 분실:
  → 해당 키만이 업그레이드·권한 변경 가능
  → 키 없으면 컨트랙트 영구 잠금
  → UPGRADER_ROLE을 가진 Safe 자체를 복구할 방법 없음
  → 컨트랙트 버려야 함 (재배포 필요)
  
2-of-3의 중요성:
  → 서명자 1명이 탈취되거나 분실되어도
    나머지 2명으로 복구 가능
  → 시스템 연속성 보장
```

---

## 11. [강의] MPC로의 진화 — Gnosis Safe 이후

### Gnosis Safe와 MPC의 비교

```
┌─────────────────────────┬──────────────────────┬───────────────────────┐
│ 특성                     │ Gnosis Safe           │ MPC/TSS               │
├─────────────────────────┼──────────────────────┼───────────────────────┤
│ 완전한 키 존재 여부        │ 각자 완전한 키 보유    │ 어디에도 완전한 키 없음 │
│ 키 탈취 위험              │ 개별 키 탈취 가능      │ 파편만으로 서명 불가    │
│ 온체인 흔적               │ execTransaction 보임  │ 일반 EOA처럼 보임      │
│ 가스 비용                 │ 서명 검증 추가 가스     │ 단일 서명과 동일       │
│ 복잡도                   │ 비교적 단순             │ 복잡한 통신 프로토콜    │
│ 오프라인 서명              │ 가능 (비동기)          │ 참여자 동시 온라인 필요 │
│ 표준화                   │ 완료 (EIP-712)         │ 미완료 (솔루션마다 다름) │
│ 현재 교보생명 적용         │ YES (이번 세션)        │ Phase 2 검토 예정      │
└─────────────────────────┴──────────────────────┴───────────────────────┘
```

```
진화 경로:
  
  현재 (Phase 1):
  VASP HOT KEY (단독) → [이번 세션] → Gnosis Safe 2-of-3
  
  미래 (Phase 2):
  Gnosis Safe 2-of-3 → VASP HOT KEY를 MPC로 교체
  (Safe 구조는 유지, 개별 서명자 키만 MPC화)
  
  장기 (Phase 3):
  완전 MPC TSS
  (Safe 없이 TSS로 멀티시그 효과 + 가스 효율)
```

---

## 12. [실습] Hardhat에서 Gnosis Safe 배포 + EIP-712 검증

### 라이브러리 설치

```bash
# Hardhat 프로젝트 루트에서 실행
npm install @safe-global/safe-contracts @safe-global/protocol-kit @safe-global/api-kit

# TypeScript 타입 (이미 있으면 생략)
npm install --save-dev @types/node
```

### 실습 파일 전체 코드

```typescript
// test/governance/gnosis-safe-eip712.test.ts

import { expect } from 'chai';
import { ethers } from 'hardhat';
import Safe, { EthersAdapter } from '@safe-global/protocol-kit';
import { SafeTransactionDataPartial } from '@safe-global/safe-core-sdk-types';

describe('M9-S46 Gnosis Safe + EIP-712 멀티시그 실습', () => {
  // ── 공통 변수 ──────────────────────────────────────────────────────────
  let signerA: ethers.Signer;  // VASP 기술팀
  let signerB: ethers.Signer;  // 교보 IT
  let signerC: ethers.Signer;  // 준법감시팀
  let signerD: ethers.Signer;  // 신규 교체 담당자 (복구 시나리오용)

  let addrA: string;
  let addrB: string;
  let addrC: string;
  let addrD: string;

  let safeAddress: string;

  // ── 테스트 전 공통 설정 ─────────────────────────────────────────────────
  before(async () => {
    [signerA, signerB, signerC, signerD] = await ethers.getSigners();
    addrA = await signerA.getAddress();
    addrB = await signerB.getAddress();
    addrC = await signerC.getAddress();
    addrD = await signerD.getAddress();

    console.log('서명자 A (VASP):     ', addrA);
    console.log('서명자 B (교보 IT):  ', addrB);
    console.log('서명자 C (준법감시): ', addrC);
    console.log('서명자 D (신규):     ', addrD);
  });

  // ────────────────────────────────────────────────────────────────────────
  // 실습 1: Gnosis Safe 배포 — threshold=2, 서명자 3명
  // ────────────────────────────────────────────────────────────────────────
  describe('실습 1: Safe 배포 및 기본 설정 확인', () => {
    it('threshold=2, owners=[A,B,C]로 Safe 배포', async () => {
      // EthersAdapter: ethers.js와 Safe SDK 연결
      const ethAdapterA = new EthersAdapter({
        ethers,
        signerOrProvider: signerA,
      });

      // Safe 배포 설정
      const safeAccountConfig = {
        owners: [addrA, addrB, addrC],
        threshold: 2,  // 2-of-3
      };

      // Safe 생성 (CREATE2 방식으로 배포)
      const safeSdk = await Safe.create({
        ethAdapter: ethAdapterA,
        safeAccountConfig,
      });

      safeAddress = await safeSdk.getAddress();
      console.log('\n[배포 완료]');
      console.log('Safe 주소:', safeAddress);

      // 배포 확인
      const owners    = await safeSdk.getOwners();
      const threshold = await safeSdk.getThreshold();
      const nonce     = await safeSdk.getNonce();

      console.log('owners:   ', owners);
      console.log('threshold:', threshold);
      console.log('nonce:    ', nonce, '(배포 직후 0)');

      expect(owners).to.include.members([addrA, addrB, addrC]);
      expect(threshold).to.equal(2);
      expect(nonce).to.equal(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 실습 2: EIP-712 도메인 분리자 + SafeTx 해시 수동 계산
  // ────────────────────────────────────────────────────────────────────────
  describe('실습 2: EIP-712 SafeTx 해시 계산 원리', () => {
    it('DOMAIN_SEPARATOR 수동 계산', async () => {
      const { chainId } = await ethers.provider.getNetwork();

      // EIP-712 도메인 타입 해시 (Gnosis Safe 스펙)
      const DOMAIN_TYPEHASH = ethers.keccak256(
        ethers.toUtf8Bytes(
          'EIP712Domain(uint256 chainId,address verifyingContract)'
        )
      );

      // 도메인 분리자 = keccak256(typehash, chainId, safeAddress)
      const domainSeparator = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['bytes32', 'uint256', 'address'],
          [DOMAIN_TYPEHASH, chainId, safeAddress]
        )
      );

      console.log('\n[EIP-712 도메인]');
      console.log('chainId:          ', chainId.toString());
      console.log('verifyingContract:', safeAddress);
      console.log('DOMAIN_TYPEHASH:  ', DOMAIN_TYPEHASH);
      console.log('domainSeparator:  ', domainSeparator);

      // 도메인 분리자는 항상 32바이트
      expect(domainSeparator).to.match(/^0x[0-9a-f]{64}$/);

      // chainId가 다르면 도메인 분리자가 달라짐을 확인
      const differentChainDomain = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['bytes32', 'uint256', 'address'],
          [DOMAIN_TYPEHASH, 99999n, safeAddress]  // 다른 chainId
        )
      );
      expect(domainSeparator).to.not.equal(differentChainDomain);
      console.log('\n[재생 공격 방지 확인]');
      console.log('다른 chainId의 도메인 분리자:', differentChainDomain);
      console.log('→ 두 도메인 분리자 다름:', domainSeparator !== differentChainDomain);
    });

    it('SafeTx structHash 수동 계산 — grantRole TX', async () => {
      // KyoboNFT.grantRole(MINTER_ROLE, 0xNewMinter) 인코딩
      const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('MINTER_ROLE'));
      const newMinterAddr = ethers.Wallet.createRandom().address;

      const grantRoleData = new ethers.Interface([
        'function grantRole(bytes32 role, address account)',
      ]).encodeFunctionData('grantRole', [MINTER_ROLE, newMinterAddr]);

      const safeTx = {
        to:             ethers.Wallet.createRandom().address, // KyoboNFT 주소 (테스트용 임의)
        value:          0n,
        data:           grantRoleData,
        operation:      0,              // CALL
        safeTxGas:      0n,
        baseGas:        0n,
        gasPrice:       0n,
        gasToken:       ethers.ZeroAddress,
        refundReceiver: ethers.ZeroAddress,
        nonce:          0n,
      };

      // SafeTx 타입 해시 (Gnosis Safe 스펙)
      const SAFE_TX_TYPEHASH = ethers.keccak256(
        ethers.toUtf8Bytes(
          'SafeTx(address to,uint256 value,bytes data,uint8 operation,' +
          'uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,' +
          'address gasToken,address refundReceiver,uint256 nonce)'
        )
      );

      // bytes 타입 data → 먼저 keccak256으로 해시 (EIP-712 스펙)
      const dataHash = ethers.keccak256(safeTx.data);

      // structHash 계산
      const structHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          [
            'bytes32',  // SAFE_TX_TYPEHASH
            'address',  // to
            'uint256',  // value
            'bytes32',  // keccak256(data) ← bytes는 해시 먼저
            'uint8',    // operation
            'uint256',  // safeTxGas
            'uint256',  // baseGas
            'uint256',  // gasPrice
            'address',  // gasToken
            'address',  // refundReceiver
            'uint256',  // nonce
          ],
          [
            SAFE_TX_TYPEHASH,
            safeTx.to,
            safeTx.value,
            dataHash,            // bytes → keccak256
            safeTx.operation,
            safeTx.safeTxGas,
            safeTx.baseGas,
            safeTx.gasPrice,
            safeTx.gasToken,
            safeTx.refundReceiver,
            safeTx.nonce,
          ]
        )
      );

      console.log('\n[SafeTx 구조체 해시]');
      console.log('SAFE_TX_TYPEHASH:', SAFE_TX_TYPEHASH);
      console.log('data (원본):     ', safeTx.data.slice(0, 30) + '...');
      console.log('dataHash:        ', dataHash);
      console.log('structHash:      ', structHash);

      expect(structHash).to.match(/^0x[0-9a-f]{64}$/);
    });

    it('최종 SafeTx 해시 = \\x19\\x01 + domainSeparator + structHash', async () => {
      const { chainId } = await ethers.provider.getNetwork();

      // 도메인 분리자
      const DOMAIN_TYPEHASH = ethers.keccak256(
        ethers.toUtf8Bytes(
          'EIP712Domain(uint256 chainId,address verifyingContract)'
        )
      );
      const domainSeparator = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['bytes32', 'uint256', 'address'],
          [DOMAIN_TYPEHASH, chainId, safeAddress]
        )
      );

      // 임시 structHash (이전 테스트와 독립적으로 간단한 값 사용)
      const dummyStructHash = ethers.keccak256(ethers.toUtf8Bytes('test safeTx'));

      // 최종 SafeTx 해시
      const safeTxHash = ethers.keccak256(
        ethers.concat([
          '0x1901',        // "\x19\x01" — EIP-712 접두사
          domainSeparator,
          dummyStructHash,
        ])
      );

      console.log('\n[최종 SafeTx 해시]');
      console.log('prefix:          0x1901 (\\x19\\x01)');
      console.log('domainSeparator: ', domainSeparator);
      console.log('structHash:      ', dummyStructHash);
      console.log('safeTxHash:      ', safeTxHash);

      expect(safeTxHash).to.match(/^0x[0-9a-f]{64}$/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 실습 3: 서명 수집 → threshold 도달 → 실행 / threshold 미달 → revert
  // ────────────────────────────────────────────────────────────────────────
  describe('실습 3: SafeTx 서명 수집 + threshold 검증', () => {
    let ethAdapterA: EthersAdapter;
    let ethAdapterB: EthersAdapter;
    let safeSdkA: Safe;
    let safeSdkB: Safe;

    before(async () => {
      // 각 서명자의 어댑터 생성
      ethAdapterA = new EthersAdapter({ ethers, signerOrProvider: signerA });
      ethAdapterB = new EthersAdapter({ ethers, signerOrProvider: signerB });

      // 배포된 Safe에 연결
      safeSdkA = await Safe.create({ ethAdapter: ethAdapterA, safeAddress });
      safeSdkB = await Safe.create({ ethAdapter: ethAdapterB, safeAddress });
    });

    it('서명자 A만 서명 시 threshold 미달 — 서명 수 확인', async () => {
      // grantRole TX 생성
      const safeTransactionData: SafeTransactionDataPartial = {
        to:        safeAddress,    // 자기 자신을 대상으로 (테스트)
        value:     '0',
        data:      '0x',           // 빈 데이터 (단순 테스트)
        operation: 0,              // CALL
      };

      const safeTransaction = await safeSdkA.createTransaction({
        transactions: [safeTransactionData],
      });

      // A만 서명
      const signedBySdkA = await safeSdkA.signTransaction(safeTransaction);

      const txHash  = await safeSdkA.getTransactionHash(safeTransaction);
      const sigCount = signedBySdkA.signatures.size;

      console.log('\n[threshold 미달 시나리오]');
      console.log('SafeTx 해시:        ', txHash);
      console.log('수집된 서명 수:     ', sigCount, '/ threshold: 2');
      console.log('→ threshold 미달: execTransaction 호출 불가');

      expect(sigCount).to.equal(1);  // A만 서명 → 1개
    });

    it('서명자 A + B 서명 시 threshold 도달 — 서명 수 확인', async () => {
      const safeTransactionData: SafeTransactionDataPartial = {
        to:        safeAddress,
        value:     '0',
        data:      '0x',
        operation: 0,
      };

      // A가 TX 생성 + 서명
      const safeTransaction = await safeSdkA.createTransaction({
        transactions: [safeTransactionData],
      });
      const signedBySdkA = await safeSdkA.signTransaction(safeTransaction);

      // B가 같은 TX에 서명 추가
      const signedBySdkB = await safeSdkB.signTransaction(signedBySdkA);

      const sigCount = signedBySdkB.signatures.size;

      console.log('\n[threshold 도달 시나리오]');
      console.log('수집된 서명 수:    ', sigCount, '/ threshold: 2');
      console.log('→ threshold 충족: execTransaction 호출 가능');

      // 서명자 주소 확인
      for (const [addr, sig] of signedBySdkB.signatures.entries()) {
        console.log('서명자:', addr, '/ 서명:', sig.data.slice(0, 20) + '...');
      }

      expect(sigCount).to.equal(2);  // A + B 서명 → 2개 (threshold 충족)
    });

    it('nonce 확인 — 같은 내용의 TX라도 nonce가 다르면 다른 해시', async () => {
      const txData: SafeTransactionDataPartial = {
        to:        safeAddress,
        value:     '0',
        data:      '0x',
        operation: 0,
      };

      // nonce=0으로 TX 생성
      const tx0 = await safeSdkA.createTransaction({
        transactions: [txData],
        options: { nonce: 0 },
      });

      // nonce=1로 같은 내용의 TX 생성
      const tx1 = await safeSdkA.createTransaction({
        transactions: [txData],
        options: { nonce: 1 },
      });

      const hash0 = await safeSdkA.getTransactionHash(tx0);
      const hash1 = await safeSdkA.getTransactionHash(tx1);

      console.log('\n[nonce에 따른 해시 차이]');
      console.log('nonce=0 해시:', hash0);
      console.log('nonce=1 해시:', hash1);
      console.log('→ nonce가 다르면 해시가 달라져 서명 재사용 불가');

      expect(hash0).to.not.equal(hash1);  // 재생 공격 방지 확인
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 실습 4: swapOwner TX 구조 확인 — 키 분실 복구 시나리오
  // ────────────────────────────────────────────────────────────────────────
  describe('실습 4: 키 분실 복구 — swapOwner TX 구조', () => {
    it('B 분실 시 A+C가 swapOwner TX 생성 — 구조 확인', async () => {
      const ethAdapterA = new EthersAdapter({ ethers, signerOrProvider: signerA });
      const ethAdapterC = new EthersAdapter({ ethers, signerOrProvider: signerC });

      const safeSdkA = await Safe.create({ ethAdapter: ethAdapterA, safeAddress });
      const safeSdkC = await Safe.create({ ethAdapter: ethAdapterC, safeAddress });

      // swapOwner TX 생성: B → D
      const swapOwnerTx = await safeSdkA.createSwapOwnerTx({
        oldOwnerAddress: addrB,   // 분실된 서명자 B
        newOwnerAddress: addrD,   // 신규 서명자 D
      });

      const txHash = await safeSdkA.getTransactionHash(swapOwnerTx);

      console.log('\n[swapOwner TX 구조]');
      console.log('대상 (to):       ', swapOwnerTx.data.to);
      console.log('value:           ', swapOwnerTx.data.value);
      console.log('data (앞 10자):  ', swapOwnerTx.data.data.slice(0, 10) + '...');
      console.log('SafeTx 해시:     ', txHash);
      console.log('현재 owners:     ', await safeSdkA.getOwners());
      console.log('복구 후 예상:    ', [addrA, addrD, addrC]);

      // A가 서명
      const signedByA = await safeSdkA.signTransaction(swapOwnerTx);
      // C가 서명
      const signedByC = await safeSdkC.signTransaction(signedByA);

      console.log('\n서명 수집 완료 (A + C):', signedByC.signatures.size, '/ threshold: 2');
      console.log('→ B 없이도 A + C만으로 복구 가능');

      expect(signedByC.signatures.size).to.equal(2);
      expect(txHash).to.match(/^0x[0-9a-f]{64}$/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 실습 5: ethers.js v6 signTypedData로 EIP-712 서명 직접 생성 + 검증
  // ────────────────────────────────────────────────────────────────────────
  describe('실습 5: ethers.js v6 EIP-712 서명 직접 생성', () => {
    it('signTypedData → verifyTypedData로 서명자 복원', async () => {
      const { chainId } = await ethers.provider.getNetwork();

      // EIP-712 도메인
      const domain = {
        chainId:           Number(chainId),
        verifyingContract: safeAddress,
      };

      // SafeTx 타입 정의
      const types = {
        SafeTx: [
          { name: 'to',              type: 'address' },
          { name: 'value',           type: 'uint256' },
          { name: 'data',            type: 'bytes'   },
          { name: 'operation',       type: 'uint8'   },
          { name: 'safeTxGas',       type: 'uint256' },
          { name: 'baseGas',         type: 'uint256' },
          { name: 'gasPrice',        type: 'uint256' },
          { name: 'gasToken',        type: 'address' },
          { name: 'refundReceiver',  type: 'address' },
          { name: 'nonce',           type: 'uint256' },
        ],
      };

      // 서명 대상 SafeTx 값
      const value = {
        to:             safeAddress,
        value:          0n,
        data:           '0x',
        operation:      0,
        safeTxGas:      0n,
        baseGas:        0n,
        gasPrice:       0n,
        gasToken:       ethers.ZeroAddress,
        refundReceiver: ethers.ZeroAddress,
        nonce:          0n,
      };

      // signerA가 EIP-712 서명 (ethers v6)
      const signature = await (signerA as ethers.Wallet).signTypedData(
        domain, types, value
      );

      // 서명으로부터 주소 복원
      const recovered = ethers.verifyTypedData(domain, types, value, signature);

      console.log('\n[EIP-712 서명 + 검증]');
      console.log('서명자 A 주소:    ', addrA);
      console.log('서명값 (앞 20자): ', signature.slice(0, 20) + '...');
      console.log('복원된 주소:      ', recovered);
      console.log('일치 여부:        ', recovered.toLowerCase() === addrA.toLowerCase());

      expect(recovered.toLowerCase()).to.equal(addrA.toLowerCase());

      // 다른 chain에서는 다른 주소가 복원됨 (재생 공격 방지)
      const wrongDomain = { ...domain, chainId: 99999 };
      const wrongRecovered = ethers.verifyTypedData(wrongDomain, types, value, signature);
      console.log('\n[다른 chainId로 검증 시]');
      console.log('잘못된 chainId로 복원된 주소:', wrongRecovered);
      console.log('→ 원래 서명자와 다름 (재생 공격 불가)');

      expect(wrongRecovered.toLowerCase()).to.not.equal(addrA.toLowerCase());
    });
  });
});
```

### 실행 방법

```bash
# Hardhat local 네트워크에서 테스트 실행
npx hardhat test test/governance/gnosis-safe-eip712.test.ts --network hardhat

# 특정 describe만 실행
npx hardhat test test/governance/gnosis-safe-eip712.test.ts --grep "실습 2"
```

### 예상 출력

```
M9-S46 Gnosis Safe + EIP-712 멀티시그 실습

  실습 1: Safe 배포 및 기본 설정 확인
    [배포 완료]
    Safe 주소: 0x...
    owners:    ['0xA...', '0xB...', '0xC...']
    threshold: 2
    nonce:     0 (배포 직후 0)
    ✓ threshold=2, owners=[A,B,C]로 Safe 배포

  실습 2: EIP-712 SafeTx 해시 계산 원리
    [EIP-712 도메인]
    chainId:           31337
    verifyingContract: 0x...Safe
    DOMAIN_TYPEHASH:   0x...
    domainSeparator:   0x...
    [재생 공격 방지 확인]
    다른 chainId의 도메인 분리자: 0x...
    → 두 도메인 분리자 다름: true
    ✓ DOMAIN_SEPARATOR 수동 계산

  실습 3: SafeTx 서명 수집 + threshold 검증
    [threshold 미달 시나리오]
    수집된 서명 수: 1 / threshold: 2
    ✓ 서명자 A만 서명 시 threshold 미달
    
    [threshold 도달 시나리오]
    수집된 서명 수: 2 / threshold: 2
    ✓ 서명자 A + B 서명 시 threshold 도달

    [nonce에 따른 해시 차이]
    nonce=0 해시: 0x...
    nonce=1 해시: 0x...
    → nonce가 다르면 해시가 달라져 서명 재사용 불가
    ✓ nonce 확인

  실습 4: 키 분실 복구 — swapOwner TX 구조
    [swapOwner TX 구조]
    서명 수집 완료 (A + C): 2 / threshold: 2
    → B 없이도 A + C만으로 복구 가능
    ✓ B 분실 시 A+C가 swapOwner TX 생성

  실습 5: ethers.js v6 EIP-712 서명 직접 생성
    [EIP-712 서명 + 검증]
    일치 여부: true
    [다른 chainId로 검증 시]
    → 원래 서명자와 다름 (재생 공격 불가)
    ✓ signTypedData → verifyTypedData로 서명자 복원

  5 passing (8s)
```

### 주요 오류 패턴과 해결

```
오류 1: "Safe is not a function" 또는 default import 오류
  원인: @safe-global/protocol-kit v2+ ESM/CJS 모듈 차이
  해결: import Safe, { EthersAdapter } from '@safe-global/protocol-kit';
        또는 const { default: Safe } = require('@safe-global/protocol-kit');

오류 2: "Cannot estimate gas" — Safe 배포 실패
  원인: Safe 팩토리 컨트랙트가 로컬 네트워크에 없음
  해결: hardhat.config.ts에서 fork 설정 또는
        SafeFactory.deploymentType = 'canonical' 설정

오류 3: 서명 검증 실패 — ecrecover 주소 불일치
  원인: bytes 타입 data를 keccak256 없이 직접 ABI 인코딩
  해결: keccak256(data)로 먼저 해시 후 인코딩 (EIP-712 스펙)

오류 4: threshold 변경 불가
  원인: changeThreshold도 Safe TX로만 가능 (외부에서 직접 호출 불가)
  해결: createChangeThresholdTx() 사용 → 2-of-3 서명 후 실행
```

---

## 13. 강의 진행 시간표 (분 단위)

```
┌──────┬────────────────────────────────────────────────────────┬──────────────────────────┐
│ 시간 │ 내용                                                   │ 강의/실습                 │
├──────┼────────────────────────────────────────────────────────┼──────────────────────────┤
│  0분 │ 세션 소개: M1~M8 돌아보기, M9의 위치                    │ 강의                     │
│      │ - "오늘은 배운 모든 것을 거버넌스로 연결한다"            │                          │
├──────┼────────────────────────────────────────────────────────┼──────────────────────────┤
│  3분 │ 단일 HOT 키 위험                                        │ 강의                     │
│      │ - M8의 UPGRADER_ROLE 구조 상기                         │                          │
│      │ - HOT KEY 탈취 → 시스템 전권 장악 시나리오              │                          │
│      │ - 금융 내부 통제 원칙: "단일 주체 전권 금지"            │                          │
├──────┼────────────────────────────────────────────────────────┼──────────────────────────┤
│  8분 │ 2-of-3 멀티시그 설계                                    │ 강의                     │
│      │ - k-of-n threshold 개념                                │                          │
│      │ - 교보생명 3 서명자 역할 분리 (VASP/교보IT/준법감시)    │                          │
│      │ - 어떤 TX가 멀티시그 필요한가? (테이블 설명)            │                          │
│      │ - threshold 숫자 선택의 균형 (너무 낮음/적당/너무 높음) │                          │
├──────┼────────────────────────────────────────────────────────┼──────────────────────────┤
│ 15분 │ EIP-712 SafeTx — 오프체인 서명                          │ 강의                     │
│      │ - "왜 오프체인 서명이 필요한가?" (순진한 구현의 문제)   │                          │
│      │ - EIP-712 구조: prefix + domainSeparator + hashStruct  │                          │
│      │ - domainSeparator에 chainId 포함하는 이유              │                          │
│      │ - MetaMask에서 보이는 서명 화면 (수강생에게 보여주기)   │                          │
│      │ - 재생 공격 방지 두 레이어 (도메인 분리자 + nonce)      │                          │
├──────┼────────────────────────────────────────────────────────┼──────────────────────────┤
│ 24분 │ SafeTx 생명주기 4단계                                   │ 강의                     │
│      │ - proposeTx: DB에 PENDING_SIGNATURES 저장              │                          │
│      │ - addSignature×n: 오프체인 서명 수집                   │                          │
│      │ - executeTx: 한 번의 온체인 TX                          │                          │
│      │ - 완료: txHash 기록, EXECUTED 상태                      │                          │
│      │ - threshold 미달 시 GS020 revert 원리                   │                          │
├──────┼────────────────────────────────────────────────────────┼──────────────────────────┤
│ 30분 │ 키 분실 복구 — swapOwner                                │ 강의                     │
│      │ - 시나리오: 서명자 B 퇴직/키 분실                       │                          │
│      │ - A+C가 swapOwner TX 제안 → 서명 → 실행                │                          │
│      │ - 1-of-1에서 키 분실 = 시스템 영구 잠금 비교            │                          │
├──────┼────────────────────────────────────────────────────────┼──────────────────────────┤
│ 34분 │ MPC로의 진화                                            │ 강의                     │
│      │ - Gnosis Safe: 완전한 키가 각자 보유                    │                          │
│      │ - MPC/TSS: 키 파편 분산, 완전한 키 없음                 │                          │
│      │ - 비교 테이블 (가스, 흔적, 오프라인 서명 등)            │                          │
│      │ - 교보생명 Phase 1 → Phase 2 진화 경로                  │                          │
├──────┼────────────────────────────────────────────────────────┼──────────────────────────┤
│ 40분 │ 실습 시작                                               │ 실습                     │
│      │ - 코드 배포: GitHub 또는 강사 화면 공유                 │                          │
│      │ - npm install @safe-global/...                         │                          │
├──────┼────────────────────────────────────────────────────────┼──────────────────────────┤
│ 42분 │ 실습 1+2: Safe 배포 + EIP-712 해시 계산                 │ 실습                     │
│      │ - threshold=2, owners=3 배포 확인                      │                          │
│      │ - domainSeparator 수동 계산 실행                        │                          │
│      │ - 콘솔 출력으로 해시값 확인                             │                          │
├──────┼────────────────────────────────────────────────────────┼──────────────────────────┤
│ 48분 │ 실습 3+4: threshold 검증 + swapOwner 구조               │ 실습                     │
│      │ - 서명 1개 vs 2개 비교                                  │                          │
│      │ - nonce 다를 때 해시 차이 확인                          │                          │
│      │ - swapOwner TX 해시 확인                               │                          │
├──────┼────────────────────────────────────────────────────────┼──────────────────────────┤
│ 53분 │ 실습 5: signTypedData + verifyTypedData                 │ 실습                     │
│      │ - 서명 생성 → 주소 복원 확인                           │                          │
│      │ - 다른 chainId로 검증 실패 확인                        │                          │
├──────┼────────────────────────────────────────────────────────┼──────────────────────────┤
│ 55분 │ 마무리: S47~S50 예고                                    │ 강의                     │
│      │ - S47: Travel Rule 구현                                │                          │
│      │ - S48~S50: 미니프로젝트 설계 + 구현 + 최종 발표        │                          │
└──────┴────────────────────────────────────────────────────────┴──────────────────────────┘
```

**강의 팁:**

```
- 15분 EIP-712 파트: "서명이 복잡해 보이지만 결국 keccak256을 3번 계산하는 것"으로 단순화
- 24분 생명주기: 화이트보드에 직접 4단계 박스 그리며 설명하면 효과적
- 34분 MPC: 복잡한 원리보다 "완전한 키가 어디에도 없다"는 개념 하나만 전달
- 실습 중 오류 발생 시: import 방식이 가장 흔한 원인 → 먼저 확인
```

---

## 14. 핵심 용어 정리

```
┌────────────────────────────┬───────────────────────────────────────────────────────────────┐
│ 용어                        │ 설명                                                           │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Multisig                   │ Multi-Signature. n개 서명자 중 k개 이상 서명해야 실행되는       │
│                            │ 방식. 단일 키 위험 제거.                                        │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ threshold                  │ 실행에 필요한 최소 서명자 수. 2-of-3에서 threshold=2.            │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Gnosis Safe                │ 온체인 멀티시그 스마트 컨트랙트 지갑. k-of-n 서명 검증.          │
│                            │ Safe.sol(구현) + SafeProxy.sol(인스턴스) 구조.                  │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ EIP-712                    │ 구조화된 데이터에 서명하는 이더리움 표준.                        │
│                            │ 임의 바이트 서명의 재생 공격 취약점 해결.                        │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ domainSeparator            │ EIP-712 서명의 컨텍스트 식별자. chainId + verifyingContract    │
│                            │ 포함. 다른 체인·다른 컨트랙트에서 서명 재사용 차단.              │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ hashStruct                 │ 서명 대상 구조체(SafeTx)의 EIP-712 해시. TYPEHASH +            │
│                            │ 각 필드 ABI 인코딩 후 keccak256.                               │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ SafeTx                     │ Gnosis Safe에서 실행할 트랜잭션의 구조체.                       │
│                            │ to, value, data, operation, nonce 등 10개 필드.                │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ nonce                      │ Safe 내부 카운터. execTransaction 시 증가.                      │
│                            │ 동일 Safe 내 동일 TX 재실행(재생 공격) 방지.                    │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ CALL / DELEGATECALL        │ operation 필드 값. CALL(0)=일반 함수 호출.                      │
│                            │ DELEGATECALL(1)=대상 코드를 Safe 컨텍스트에서 실행 → 위험.      │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ GS020                      │ Gnosis Safe threshold 미달 에러 코드.                           │
│                            │ "Could not finish execution"                                   │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ proposeTx                  │ SafeTx를 제안하는 단계. 오프체인(DB)에 저장.                    │
│                            │ 아직 온체인에 아무것도 기록되지 않음.                           │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ addSignature               │ 서명자가 SafeTx 해시에 오프체인 서명 추가.                      │
│                            │ 가스비 없음. DB에 서명값 저장.                                  │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ executeTx                  │ 수집된 서명을 Safe.execTransaction으로 온체인 제출.              │
│                            │ 이때 처음으로 가스비 발생.                                      │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ swapOwner                  │ Safe 서명자 교체 함수. B → D로 교체.                            │
│                            │ 실행 자체도 threshold 이상의 서명 필요.                         │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ ecrecover                  │ 서명값(v, r, s)과 메시지 해시로부터 서명자 주소 복원.            │
│                            │ Safe 컨트랙트가 서명 검증 시 사용.                              │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ MPC (Multi-Party           │ 다자 연산. 키를 파편으로 분산 보관.                             │
│ Computation)               │ 어디에도 완전한 키가 존재하지 않음.                             │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ TSS (Threshold Signature   │ 임계값 서명 방식. Shamir Secret Sharing 기반.                   │
│ Scheme)                    │ k개 파편 보유자가 참여해야 서명 생성 가능.                      │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ TimelockController         │ TX 제안 후 N시간 후에만 실행 허용.                              │
│                            │ 탈취 시 사용자에게 대피 시간 제공.                              │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Safe Module                │ Safe에 플러그인처럼 기능 추가.                                  │
│                            │ AllowanceModule, TimelockController 등.                        │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Guard                      │ Safe TX 실행 전후에 커스텀 체크 추가.                           │
│                            │ DELEGATECALL 차단, 주소 화이트리스트 등.                        │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ HOT KEY                    │ 서버 메모리에 상주하는 개인키.                                  │
│                            │ 항상 온라인 → 서버 해킹 시 탈취 위험.                          │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ HSM (Hardware Security     │ 개인키를 안전하게 보관하는 전용 하드웨어.                       │
│ Module)                    │ 키가 HSM 외부로 나오지 않음. 서명은 HSM 내부에서 수행.          │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Replay Attack              │ 재생 공격. 같은 서명을 다른 컨텍스트에서 재사용하는 공격.       │
│ (재생 공격)                 │ EIP-712 도메인 분리자 + nonce로 방지.                          │
├────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ SafeProxyFactory           │ Safe 인스턴스를 CREATE2로 배포하는 팩토리.                      │
│                            │ 같은 설정 = 같은 주소 (결정적 배포).                           │
└────────────────────────────┴───────────────────────────────────────────────────────────────┘
```

---

## 완료 기준

- [ ] 단일 HOT 키의 위험과 금융 내부 통제 위반 이유 설명 가능
- [ ] k-of-n threshold 개념과 교보생명 2-of-3 서명자 역할 분리 설명 가능
- [ ] EIP-712 서명 구조 3단계 (domainSeparator + hashStruct + 최종 해시) 설명 가능
- [ ] chainId와 nonce가 각각 어떤 재생 공격을 방지하는지 설명 가능
- [ ] SafeTx 생명주기 4단계 (proposeTx → addSignature → executeTx → 완료) 설명 가능
- [ ] swapOwner로 키 분실 복구가 가능한 이유 설명 가능
- [ ] Gnosis Safe와 MPC의 핵심 차이 ("완전한 키 존재 여부") 설명 가능
- [ ] Hardhat 실습: Safe 배포, EIP-712 해시 수동 계산, threshold 검증 코드 실행 완료

---

> **S47 예고:** Travel Rule — FATF 규제에서 요구하는 송신자·수신자 정보 전달 의무와 VASP 간 정보 교환 프로토콜 구현
> **S48~S50 예고:** 미니프로젝트 — M1~M9 전체 지식을 활용해 신규 기능을 Phase 1 시스템에 추가, 최종 데모 발표
