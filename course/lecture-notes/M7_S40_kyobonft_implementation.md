# M7 S40 — KyoboNFT.sol 전체 구현 — UUPS + AccessControl + ERC-1155

> 모듈 7 · 세션 40 · 1시간  
> 강의 50분 + 실습 10분  
> 실습 환경: Hardhat (로컬) — `blockchain/` 디렉터리

---

## [강사 배경] — 120분 분량 심화 지식

> 이 섹션은 강의에서 직접 읽지 않는다. 수강생 질문에 즉시 답하고, 개념 설명에 자신감을 갖기 위한 배경이다.

### A. 프록시 패턴의 역사와 왜 UUPS를 선택했는가

**왜 프록시가 필요한가 — 이더리움의 근본적 제약**

이더리움 컨트랙트는 배포 후 코드가 영구 불변(immutable)이다. 이것은 보안상 장점이지만, 버그 수정이나 기능 추가가 불가능하다는 운영상 문제를 만든다. 전통 소프트웨어는 패치를 배포하면 되지만, 스마트 컨트랙트는 새 컨트랙트를 배포하면 주소가 바뀐다. 주소가 바뀌면 VASP 시스템, 지갑, 거래소 연동을 전부 업데이트해야 한다. 이 문제를 해결하기 위해 프록시 패턴이 등장했다.

**프록시 패턴 3종 비교:**

| 구분 | Transparent Proxy | UUPS | Beacon Proxy |
|---|---|---|---|
| 업그레이드 로직 위치 | Proxy 컨트랙트 | Implementation 컨트랙트 | Beacon 컨트랙트 |
| 배포 gas | 높음 (ProxyAdmin 추가) | 낮음 | 중간 |
| 호출 gas | 높음 (admin 판별 추가) | 낮음 | 중간 |
| 일괄 업그레이드 | 불가 | 불가 | 가능 (Beacon 하나로 N개 프록시) |
| 위험 요소 | admin/user 혼동 | 구현 버그 시 영구 lock | Beacon 단일장애점 |
| OZ 지원 | 구버전 방식 (deprecated 방향) | 현재 권장 | 다중 인스턴스 용 |

**Transparent Proxy의 admin/user 구분 문제:**  
Transparent에서는 ProxyAdmin이 `upgradeTo()`를 호출하고, 일반 사용자는 다른 함수를 호출한다. 함수 선택자(selector)가 충돌할 경우 admin인지 user인지 매 호출마다 확인하는 분기 로직이 실행된다. 이 분기 로직이 gas를 소비하고, 코드를 복잡하게 만든다.

**UUPS의 핵심 설계 원칙:**  
업그레이드 권한 확인 로직(`_authorizeUpgrade`)이 구현 컨트랙트 안에 있다. Proxy는 단순히 delegatecall만 한다. 이로 인해 Proxy 자체는 매우 단순해지고 gas가 줄어든다. 단, 구현 컨트랙트에 `_authorizeUpgrade`를 빠뜨리거나 버그가 있으면 업그레이드 자체가 불가능해지는 영구 lock 위험이 있다. 이것이 UUPS의 유일한 치명적 위험이다.

**KyoboNFT가 UUPS를 선택한 이유:**  
- gas 절감: `mint`는 수천 건 이상 호출되므로 호출당 gas 차이가 크다
- OZ 공식 권장: OpenZeppelin 5.x는 UUPS를 primary 방식으로 문서화
- 단순성: ProxyAdmin 컨트랙트 없이 구조가 단순

---

### B. delegatecall 완전 이해

**call vs delegatecall 차이 — context 개념이 핵심:**

```
일반 call:
  A → B.call(data)
  B의 코드가 B의 storage에서 실행됨
  msg.sender = A, msg.value = A가 보낸 ETH

delegatecall:
  A → B.delegatecall(data)
  B의 코드가 A의 storage에서 실행됨  ← 핵심 차이
  msg.sender = A의 호출자 (원래 호출자 유지)
  msg.value = 원래 트랜잭션의 ETH
```

**프록시-구현체 관계에 적용하면:**

```
사용자 EOA → Proxy.delegatecall(mint 데이터) → KyoboNFT의 mint 코드 실행
                                                   ↑
                                            실행 context는 Proxy의 storage
                                            (KyoboNFT의 storage가 아님)
```

즉, `_balances[user][tokenId]`에 값이 저장될 때, 그 슬롯은 Proxy 컨트랙트의 슬롯이다. KyoboNFT(구현체)는 코드만 제공하고, 실제 데이터는 Proxy에 산다.

**msg.sender가 유지되는 이유:**  
일반 call이라면 Proxy가 KyoboNFT를 호출할 때 `msg.sender`는 Proxy가 된다. 그러나 delegatecall은 원래 EOA의 `msg.sender`가 그대로 유지된다. 이 덕분에 `onlyRole(MINTER_ROLE)`의 역할 확인이 원래 호출자를 대상으로 작동한다.

**delegatecall이 위험한 이유:**  
악의적인 구현체가 Proxy의 storage에 마음대로 쓸 수 있다. 예를 들어 Implementation 컨트랙트에 `selfdestruct`가 있으면 Proxy 자체가 파괴될 수 있다. 이것이 `_authorizeUpgrade`로 업그레이드 권한을 엄격하게 통제해야 하는 이유다.

---

### C. Storage Layout 규칙의 EVM 근거

**EVM Storage 구조:**  
EVM은 컨트랙트마다 `2^256`개의 32바이트 슬롯을 갖는다(약 10^77개). 슬롯 번호는 0부터 시작한다. 이론상 무한에 가깝지만, 실제로 사용된 슬롯만 gas를 소비한다(cold access: 2100 gas, warm: 100 gas).

**상태변수와 슬롯 할당 규칙:**  
컴파일러(solc)는 상태변수를 **선언 순서대로** 슬롯에 할당한다.

```solidity
contract Example {
    uint256 a;  // 슬롯 0
    uint256 b;  // 슬롯 1
    address c;  // 슬롯 2 (address는 20바이트, 슬롯에 packed)
    uint96  d;  // 슬롯 2 (c와 같은 슬롯에 packing — 합계 32바이트)
    mapping(address => uint256) e;  // 슬롯 3 (mapping 자체는 슬롯 3, 실제 값은 keccak 해시)
}
```

**Proxy와 Implementation 슬롯 충돌 문제:**  
Proxy가 `_admin` 변수를 슬롯 0에 가지고 있다면, delegatecall로 실행된 Implementation의 슬롯 0 변수(`_balances`)가 `_admin`을 덮어쓴다. 이것이 Storage Collision이다.

**OZ의 ERC1967 슬롯 — 충돌 방지 해법:**  
OZ는 프록시 내부에서 관리하는 변수(구현체 주소, admin 주소)를 랜덤에 가까운 슬롯에 저장한다.

```solidity
// EIP-1967 표준
bytes32 private constant _IMPLEMENTATION_SLOT =
    bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
// = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc

bytes32 private constant _ADMIN_SLOT =
    bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);
```

이 슬롯 번호는 일반 상태변수 선언 순서로는 절대 도달할 수 없는 위치다. 충돌 확률은 사실상 0이다.

**Upgradeable 컨트랙트의 `__gap` 패턴:**  
미래에 상태변수를 추가할 여지를 미리 예약한다.

```solidity
contract BaseUpgradeable {
    uint256 public someVar;    // 슬롯 N

    // 미래 변수 추가 공간 예약: 49개 슬롯 = 50개 슬롯 블록
    uint256[49] private __gap;
}

// V2에서 __gap을 줄이고 새 변수 추가
contract BaseUpgradeableV2 {
    uint256 public someVar;    // 슬롯 N
    uint256 public newVar;     // 슬롯 N+1 (기존 __gap 첫 번째 자리)

    uint256[48] private __gap; // 48개로 줄임
}
```

OZ의 Upgradeable 컨트랙트들이 모두 이 패턴을 따른다.

---

### D. constructor vs initializer 원리

**constructor가 Proxy 패턴에서 동작하지 않는 이유:**

```
deployProxy() 실행 흐름:
  1. KyoboNFT 구현체 배포 (constructor 실행)
     → constructor에서 설정한 값은 구현체의 storage에 저장됨
     → 그러나 이 구현체 storage는 아무도 사용하지 않음

  2. ERC1967Proxy 배포
     → Proxy의 storage는 비어 있음
     → initialize()가 아직 호출되지 않았으므로 역할도 비어 있음

  3. Proxy → 구현체 delegatecall로 initialize() 호출
     → Proxy의 storage에 역할, 초기 상태 저장
     → 이제 정상 동작
```

constructor에서 `_grantRole(DEFAULT_ADMIN_ROLE, msg.sender)`를 했다면, 그 값은 구현체의 슬롯에 저장된다. Proxy는 그 슬롯을 읽지 않으므로 역할이 설정되지 않은 것처럼 동작한다.

**`_disableInitializers()` 내부 동작:**

```solidity
// OpenZeppelin Initializable.sol 내부
uint8 private _initialized;  // 현재 초기화 버전
bool  private _initializing; // 초기화 진행 중 여부

function _disableInitializers() internal {
    // _initialized를 uint8 최대값(255)으로 설정
    // 이후 모든 initializer/reinitializer(N) 호출이 revert됨
    _initialized = type(uint8).max;
    emit Initialized(type(uint8).max);
}
```

이것을 구현체 constructor에서 호출하면, 구현체를 직접 접근해서 `initialize()`를 호출하려는 시도가 모두 차단된다.

**초기화 탈취 공격 시나리오 (실제 2022년 발생):**

```
1. 개발팀이 _disableInitializers() 없이 KyoboNFT 구현체 배포
2. 공격자가 구현체 주소를 발견
3. 공격자가 KyoboNFT_구현체.initialize(공격자_주소) 호출
4. 공격자가 DEFAULT_ADMIN_ROLE 획득
5. 공격자가 upgradeToAndCall()로 악의적인 V2 배포
6. 모든 토큰 데이터 파괴 또는 탈취
```

2022년 여러 DeFi 프로토콜이 이 패턴으로 공격받았다. `_disableInitializers()` 한 줄이 이 전체 시나리오를 차단한다.

**`@custom:oz-upgrades-unsafe-allow constructor` 주석의 의미:**  
OZ의 Hardhat 플러그인은 upgradeable 컨트랙트에 constructor가 있으면 경고를 낸다. 이 주석은 "이 패턴은 의도적이며, _disableInitializers()로 안전하게 처리했음"을 플러그인에 알리는 것이다. 없으면 배포 시 오류가 발생한다.

---

### E. upgrades.deployProxy 내부 5단계 동작

```
upgrades.deployProxy(KyoboNFT, [admin], { kind: 'uups' })
         ↓
단계 1: KyoboNFT 구현체 컨트랙트 배포
        → TX 1 발생 → 구현체 주소 확보
        → constructor 실행 → _disableInitializers()

단계 2: UUPS는 ProxyAdmin 배포 불필요 (Transparent는 여기서 ProxyAdmin 배포)

단계 3: ERC1967Proxy 배포 (구현체 주소를 생성자 인자로 전달)
        → TX 2 발생 → 프록시 주소 확보

단계 4: Proxy.delegatecall(initialize(admin))
        → TX 3 발생 → Proxy storage에 역할 초기화

단계 5: .openzeppelin/[network].json에 아래 정보 기록:
        {
          "address": "프록시주소",
          "implementation": "구현체주소",
          "layout": { ... 모든 상태변수 슬롯 정보 ... }
        }
        → 이후 upgradeProxy 시 이 파일과 비교해 Storage Layout 충돌 감지
```

Hardhat 로컬 네트워크(hardhat network)에서는 `.openzeppelin/unknown-31337.json`에 저장된다. Sepolia는 `.openzeppelin/sepolia.json`. 이 파일은 반드시 git으로 관리해야 한다.

**upgrades.upgradeProxy 시 자동 비교:**

```
기존 layout (JSON) vs 새 컨트랙트 layout
     ↓
변수 추가(끝에)   → 허용
변수 삭제        → 오류
변수 순서 변경   → 오류
변수 타입 변경   → 대부분 오류 (크기 변경은 항상 오류)
```

단, mapping의 value 타입 변경은 자동으로 감지되지 않는다. 예를 들어 `mapping(address => uint256)`을 `mapping(address => uint128)`로 바꾸면 OZ가 오류를 내지 않지만 실제로는 데이터가 깨진다. 이런 경우는 수동 검증이 필요하다.

---

## 강의 파트 (50분)

### 1. Remix → Hardhat — 환경 전환 이유

S33~S39는 Remix로 개념을 확인했다. S40부터는 Hardhat을 사용한다.

```
Remix                          Hardhat
──────────────────────         ──────────────────────────────────
브라우저, 클릭 배포             CLI, 스크립트 배포
수동 테스트                    코드 기반 자동화 테스트 (Mocha/Chai)
단일 파일                      npm 패키지 관리, 다중 파일
UUPS 배포 지원 없음            @openzeppelin/hardhat-upgrades 지원
Etherscan 검증 없음            hardhat-verify 플러그인
```

M7에서 만드는 KyoboNFT는 실제 프로덕션 코드다. UUPS 프록시 배포, Sepolia 배포, Etherscan 검증까지 모두 Hardhat으로 처리한다.

**프로젝트 구조 확인:**

```
blockchain/
  src/
    rewards/
      KyoboNFT.sol        ← 오늘 완성할 파일
      NFTIssuer.sol       ← 발행 게이트웨이 (이미 구현됨)
  scripts/
    deploy/
      deploy-rewards.ts   ← S41에서 실행할 배포 스크립트
  test/
    KyoboNFT.test.ts      ← 오늘 작성할 테스트
  hardhat.config.ts
```

---

### 2. UUPS 프록시 패턴 — 왜 필요한가

S33에서 배운 것: "배포 후 코드 수정 불가". 그런데 운영 중 버그가 발견되거나 기능을 추가해야 할 때는 어떻게 하는가?

**UUPS(Universal Upgradeable Proxy Standard) 구조:**

```
사용자 / VASP
     ↓  호출
┌─────────────────────────────┐
│  ERC1967Proxy (프록시)      │  ← 주소 불변. 사용자는 이 주소만 알면 됨
│  - 상태(storage) 보관       │
│  - 호출을 구현체로 위임     │
└──────────────┬──────────────┘
               │ delegatecall
┌──────────────▼──────────────┐
│  KyoboNFT (구현체)          │  ← 업그레이드 시 이것만 교체
│  - 코드(logic)만 있음       │
│  - 상태는 프록시에 저장됨   │
└─────────────────────────────┘
```

**업그레이드 흐름:**

```
① KyoboNFTV2 구현체 배포 (새 컨트랙트)
② KyoboNFT.upgradeToAndCall(V2_ADDRESS) 호출
   → UPGRADER_ROLE 검증
   → 프록시의 구현체 포인터를 V2 주소로 교체
③ 이후 모든 호출이 V2 로직으로 처리
   (프록시 주소 불변, 기존 상태 보존)
```

**`delegatecall`의 핵심:**  
구현체의 코드가 **프록시의 storage context**에서 실행된다. 즉 `_balances`는 프록시 스토리지에 저장되고 구현체 코드는 그것을 읽고 쓴다. 구현체가 교체되어도 데이터는 프록시에 남는다.

---

### 3. Storage Layout 규칙 — 업그레이드의 함정

UUPS의 가장 위험한 부분이다. 잘못하면 기존 토큰 데이터가 전부 깨진다.

**EVM Storage 슬롯 할당 원리 (강사 배경 C 참조):**  
상태변수는 선언 순서대로 슬롯 0부터 배정된다. 업그레이드 후에도 동일한 슬롯에 동일한 변수가 있어야 한다.

**슬롯 충돌 시나리오:**

```solidity
// KyoboNFT v1
contract KyoboNFT {
    // slot 0: ERC1155 내부 (_balances mapping)
    // slot 1: AccessControl 내부
    uint256 public version;   // slot 2
}

// KyoboNFTV2 — 잘못된 업그레이드 ❌
contract KyoboNFTV2 {
    // slot 0: ERC1155 내부 (_balances mapping)
    // slot 1: AccessControl 내부
    string public baseURI;    // slot 2 ← version 자리에 string이 들어옴!
    uint256 public version;   // slot 3 ← 위치 밀림
}
// 결과: 기존 version 값이 baseURI로 해석됨 → 데이터 오염
```

**올바른 업그레이드 — 새 변수는 끝에만 추가:**

```solidity
// KyoboNFTV2 — 올바른 업그레이드 ✓
contract KyoboNFTV2 {
    // slot 0~1: 기존 그대로 유지
    uint256 public version;   // slot 2 ← 기존 위치 유지
    string  public baseURI;   // slot 3 ← 끝에 추가
}
```

**규칙 3가지:**
1. 기존 변수 순서 변경 금지
2. 기존 변수 타입 변경 금지
3. 기존 변수 삭제 금지 — 필요하면 `_deprecated_변수명`으로 이름만 변경

`@openzeppelin/hardhat-upgrades`가 배포·업그레이드 시 이 규칙을 자동으로 검증한다. 위반 시 트랜잭션 전에 오류를 잡아준다.

**슬롯 번호 직접 확인 (강사 참고):**

```bash
# hardhat-storage-layout 플러그인 설치 후
npx hardhat check
# 또는
npx hardhat storage-layout --contract KyoboNFT
# 출력 예시:
# | Name     | Slot | Offset | Type    |
# | _balances | 0   | 0      | mapping |
# | _roles    | 2   | 0      | mapping |
```

실제 슬롯 번호를 숫자로 보여주기 때문에, 업그레이드 전후 비교 시 직관적으로 확인할 수 있다.

---

### 4. constructor vs initialize — UUPS에서의 차이

일반 컨트랙트는 constructor에서 초기화한다. UUPS에서는 이것이 불가능하다.

**이유:**  
`deployProxy()`는 두 컨트랙트를 배포한다: ① 구현체(KyoboNFT) ② ERC1967Proxy. 구현체의 constructor는 구현체 자신의 storage에서 실행된다. 그런데 실제 사용자 호출은 프록시 → 구현체 delegatecall이므로, constructor로 설정한 값은 프록시 storage에 존재하지 않는다.

```solidity
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers();
    // 구현체를 직접 초기화하려는 공격 차단
    // initialize()를 다시 호출하면 revert
}

function initialize(address admin) public initializer {
    // initializer modifier: 1회만 실행 보장
    __ERC1155_init("");               // ERC1155 초기화
    __AccessControl_init();           // AccessControl 초기화
    __Pausable_init();                // Pausable 초기화
    // UUPSUpgradeable은 별도 init 불필요

    _grantRole(DEFAULT_ADMIN_ROLE, admin);
    _grantRole(MINTER_ROLE,        admin);
    _grantRole(PAUSER_ROLE,        admin);
    _grantRole(UPGRADER_ROLE,      admin);
}
```

`_disableInitializers()` 없이 배포하면 누군가가 구현체에 직접 접근해 `initialize()`를 호출해 `DEFAULT_ADMIN_ROLE`을 탈취할 수 있다. 반드시 필요하다.

**`initializer` modifier 내부 동작:**

```solidity
// Initializable.sol 내부 (개념적 표현)
modifier initializer() {
    require(_initialized < 1, "Already initialized");
    _initializing = true;
    _;
    _initializing = false;
    _initialized = 1;
}
```

`_initialized`가 0일 때만 실행되고, 완료 후 1로 설정된다. 재호출 시 `InvalidInitialization` 오류가 발생한다.

---

### 5. KyoboNFT.sol 전체 코드

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract KyoboNFT is
    Initializable,
    ERC1155Upgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    // ── 역할 상수 ─────────────────────────────────────────────────────────
    bytes32 public constant MINTER_ROLE   = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // ── tokenId 인코딩 ────────────────────────────────────────────────────
    uint8 public constant PRODUCT_CODE_SHIFT = 64;

    // ── 초기화 차단 ───────────────────────────────────────────────────────
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ── 프록시 초기화 ─────────────────────────────────────────────────────
    function initialize(address admin) public initializer {
        __ERC1155_init("");
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE,        admin);
        _grantRole(PAUSER_ROLE,        admin);
        _grantRole(UPGRADER_ROLE,      admin);
    }

    // ── tokenId 인코딩 / 디코딩 ───────────────────────────────────────────
    function encodeTokenId(
        uint64 productCode,
        uint64 eventCode
    ) public pure returns (uint256) {
        return (uint256(productCode) << PRODUCT_CODE_SHIFT) | uint256(eventCode);
    }

    function decodeTokenId(uint256 tokenId)
        public pure returns (uint64 productCode, uint64 eventCode)
    {
        productCode = uint64(tokenId >> PRODUCT_CODE_SHIFT);
        eventCode   = uint64(tokenId);
    }

    // ── 발행 ──────────────────────────────────────────────────────────────
    function mint(
        address to,
        uint256 tokenId,
        uint256 amount
    ) external onlyRole(MINTER_ROLE) whenNotPaused {
        require(amount > 0, "KyoboNFT: zero amount");
        _mint(to, tokenId, amount, "");
    }

    function mintBatch(
        address[] calldata to,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts
    ) external onlyRole(MINTER_ROLE) whenNotPaused {
        require(
            to.length == tokenIds.length && tokenIds.length == amounts.length,
            "KyoboNFT: length mismatch"
        );
        for (uint256 i = 0; i < to.length; i++) {
            _mint(to[i], tokenIds[i], amounts[i], "");
        }
    }

    // ── 소각 ──────────────────────────────────────────────────────────────
    function burn(
        address from,
        uint256 tokenId,
        uint256 amount
    ) external onlyRole(MINTER_ROLE) {
        _burn(from, tokenId, amount);
    }

    // ── 긴급 정지 ─────────────────────────────────────────────────────────
    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ── Pausable hook — 모든 잔액 변경에 정지 상태 적용 ──────────────────
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override whenNotPaused {
        super._update(from, to, ids, values);
    }

    // ── UUPS 업그레이드 권한 ──────────────────────────────────────────────
    function _authorizeUpgrade(address /* newImpl */)
        internal override onlyRole(UPGRADER_ROLE)
    {}

    // ── 다중 상속 interface 충돌 해소 ─────────────────────────────────────
    function supportsInterface(bytes4 interfaceId)
        public view
        override(ERC1155Upgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
```

---

### 6. 코드 설계 결정 요약

**① `UPGRADER_ROLE` 분리 이유**

MINTER, PAUSER와 분리한 이유: 업그레이드는 가장 위험한 권한이다. 컨트랙트 전체 로직을 교체하므로 별도 역할로 격리하고 운영 중에도 최소 인원(Gnosis Safe 멀티시그)에게만 부여한다.

실무에서는 `UPGRADER_ROLE`을 Gnosis Safe 3-of-5 멀티시그에 부여하고, `MINTER_ROLE`은 NFTIssuer 컨트랙트에 부여한다. 이렇게 하면 단일 개인키 탈취로 업그레이드 권한을 빼앗길 수 없다.

**② `mint` vs `mintBatch` 설계**

표준 ERC-1155의 `_mintBatch`는 단일 수신자에게 여러 tokenId를 발행한다. KyoboNFT의 `mintBatch`는 **여러 수신자에게 각각** 발행한다. Phase 1 요건(사용자별 개별 발행)에 맞춘 커스텀 설계다. 함수 시그니처가 다르므로 외부에서 호출 시 혼동하지 말 것.

**③ `burn`에 `whenNotPaused` 없는 이유**

정지 상태에서도 만료 처리·운영 회수는 가능해야 한다. 발행(`mint`)은 정지하지만 소각(`burn`)은 허용하는 것이 운영 정책이다.

단, `_update` hook에는 `whenNotPaused`가 걸려 있다. `burn`도 결국 `_update`를 호출하므로 정지 시 소각이 차단되는 것처럼 보인다. 이 설계의 모순은 실제 Pausable 패턴의 함정이다. `burn`을 정지 중에도 허용하려면 `_update` override에서 burn(from == address(0)가 아닌 경우)을 예외 처리해야 한다. 현재 구현은 운영 요건에 따라 추후 검토가 필요한 부분이다.

**④ `_update` hook 위치**

ERC-1155의 모든 잔액 변경(mint·burn·safeTransferFrom)이 `_update`를 경유한다. 여기에 `whenNotPaused`를 걸면 정지 중 모든 토큰 이동이 차단된다. `mint`에 각각 걸어도 되지만 `_update` 한 곳에 걸면 누락 위험이 없다.

**⑤ `constant` 변수가 슬롯을 차지하지 않는 이유**

`MINTER_ROLE = keccak256("MINTER_ROLE")`은 컴파일 시 값이 확정되어 bytecode에 직접 포함된다. Storage 슬롯을 소비하지 않으므로 업그레이드 시 Layout에 영향을 주지 않는다. `immutable` 변수는 배포 시 값이 확정되어 역시 bytecode에 포함된다.

---

### 7. Hardhat 테스트 구조

```typescript
// test/KyoboNFT.test.ts
import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';

describe('KyoboNFT', () => {
    let nft: any;
    let admin: any, minter: any, user: any;

    const MINTER_ROLE   = ethers.keccak256(ethers.toUtf8Bytes('MINTER_ROLE'));
    const PAUSER_ROLE   = ethers.keccak256(ethers.toUtf8Bytes('PAUSER_ROLE'));
    const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADER_ROLE'));

    beforeEach(async () => {
        [admin, minter, user] = await ethers.getSigners();

        const KyoboNFT = await ethers.getContractFactory('KyoboNFT');
        nft = await upgrades.deployProxy(
            KyoboNFT,
            [admin.address],
            { kind: 'uups', initializer: 'initialize' }
        );
        await nft.waitForDeployment();

        // 별도 minter 계정에 역할 부여
        await nft.connect(admin).grantRole(MINTER_ROLE, minter.address);
    });

    it('initialize: 역할 부여 확인', async () => {
        expect(await nft.hasRole(MINTER_ROLE, admin.address)).to.be.true;
        expect(await nft.hasRole(PAUSER_ROLE, admin.address)).to.be.true;
        expect(await nft.hasRole(UPGRADER_ROLE, admin.address)).to.be.true;
    });

    it('encodeTokenId / decodeTokenId 왕복 검증', async () => {
        const tokenId = await nft.encodeTokenId(1n, 42n);
        const [productCode, eventCode] = await nft.decodeTokenId(tokenId);
        expect(productCode).to.equal(1n);
        expect(eventCode).to.equal(42n);
    });

    it('mint: MINTER_ROLE만 가능', async () => {
        const tokenId = await nft.encodeTokenId(1n, 1n);
        await expect(nft.connect(user).mint(user.address, tokenId, 1))
            .to.be.revertedWithCustomError(nft, 'AccessControlUnauthorizedAccount');
        await nft.connect(minter).mint(user.address, tokenId, 1);
        expect(await nft.balanceOf(user.address, tokenId)).to.equal(1n);
    });

    it('mint: amount=0 revert', async () => {
        const tokenId = await nft.encodeTokenId(1n, 1n);
        await expect(nft.connect(minter).mint(user.address, tokenId, 0))
            .to.be.revertedWith('KyoboNFT: zero amount');
    });

    it('mintBatch: 3명에게 각각 발행', async () => {
        const [, , u1, u2, u3] = await ethers.getSigners();
        const id = await nft.encodeTokenId(1n, 1n);
        await nft.connect(minter).mintBatch(
            [u1.address, u2.address, u3.address],
            [id, id, id],
            [1, 1, 1]
        );
        expect(await nft.balanceOf(u1.address, id)).to.equal(1n);
        expect(await nft.balanceOf(u2.address, id)).to.equal(1n);
        expect(await nft.balanceOf(u3.address, id)).to.equal(1n);
    });

    it('mintBatch: 배열 길이 불일치 revert', async () => {
        const id = await nft.encodeTokenId(1n, 1n);
        await expect(nft.connect(minter).mintBatch(
            [user.address], [id, id], [1]
        )).to.be.revertedWith('KyoboNFT: length mismatch');
    });

    it('pause → mint revert, unpause → mint 성공', async () => {
        await nft.connect(admin).pause();
        const tokenId = await nft.encodeTokenId(1n, 1n);
        await expect(nft.connect(minter).mint(user.address, tokenId, 1))
            .to.be.revertedWithCustomError(nft, 'EnforcedPause');
        await nft.connect(admin).unpause();
        await nft.connect(minter).mint(user.address, tokenId, 1);
        expect(await nft.balanceOf(user.address, tokenId)).to.equal(1n);
    });

    it('initialize 재호출 불가', async () => {
        await expect(nft.connect(admin).initialize(admin.address))
            .to.be.revertedWithCustomError(nft, 'InvalidInitialization');
    });
});
```

---

### 8. 테스트 실행 흐름

```bash
# blockchain/ 디렉터리에서
npx hardhat test test/KyoboNFT.test.ts

# 결과 예시
KyoboNFT
  ✓ initialize: 역할 부여 확인 (120ms)
  ✓ encodeTokenId / decodeTokenId 왕복 검증
  ✓ mint: MINTER_ROLE만 가능
  ✓ mint: amount=0 revert
  ✓ mintBatch: 3명에게 각각 발행
  ✓ mintBatch: 배열 길이 불일치 revert
  ✓ pause → mint revert, unpause → mint 성공
  ✓ initialize 재호출 불가

8 passing (1.8s)
```

**`upgrades.deployProxy`가 Remix와 다른 점:**  
Hardhat 테스트에서는 `deployProxy`가 구현체 + 프록시를 모두 자동 배포한다. 반환되는 `nft` 인스턴스가 프록시 주소를 가리키지만 구현체 ABI로 상호작용한다. storage layout도 `.openzeppelin/` 디렉터리에 자동 기록된다.

---

## 실습 파트 (10분)

### 테스트 실행 + 핵심 케이스 확인

**① 환경 확인:**

```bash
cd F:\Workplace\kyobo-digital-asset-platform\blockchain
npx hardhat compile
# Compiled X Solidity files successfully
```

**② 테스트 실행:**

```bash
npx hardhat test test/KyoboNFT.test.ts --grep "mint"
# mint 관련 케이스만 실행
```

**③ 확인 포인트:**

```
- "MINTER_ROLE만 가능" → user 계정으로 mint 시도 → AccessControlUnauthorizedAccount
- "amount=0 revert"    → "KyoboNFT: zero amount" 메시지 확인
- "pause → mint revert" → EnforcedPause 확인
- "initialize 재호출"  → InvalidInitialization 확인
```

**④ 전체 테스트 실행:**

```bash
npx hardhat test test/KyoboNFT.test.ts
# 8개 케이스 전부 passing 확인
```

---

## 완료 기준

- [ ] UUPS 프록시 구조(프록시/구현체/delegatecall) 그림으로 설명 가능
- [ ] `_disableInitializers()`가 없을 때 발생하는 보안 위험 설명 가능
- [ ] Storage Layout 규칙 3가지 설명 가능 (추가/변경/삭제 금지)
- [ ] `UPGRADER_ROLE`을 MINTER_ROLE과 분리한 이유 설명 가능
- [ ] `mintBatch`가 표준 `_mintBatch`와 다른 이유 설명 가능
- [ ] `_update` hook에 `whenNotPaused`를 거는 이유 설명 가능
- [ ] `npx hardhat test` 실행 → 8개 케이스 전부 passing 확인

---

## 강사 노트

**반드시 짚을 것:**  
`delegatecall` 개념 — "구현체 코드가 프록시 storage에서 실행된다"는 것이 UUPS의 핵심이자 Storage Layout 규칙이 존재하는 이유다. 이것이 명확하지 않으면 Storage Collision이 왜 위험한지 이해가 안 된다.

**Transparent vs UUPS 비교 질문이 나오면:**  
"Transparent는 ProxyAdmin이라는 별도 컨트랙트가 있고 매 호출마다 admin인지 user인지 확인하는 분기가 실행된다. UUPS는 그 분기가 없어서 gas가 낮다. 대신 구현 컨트랙트에 업그레이드 로직이 있어서 구현 버그 시 영구 lock 위험이 있다."

**`_disableInitializers()` 실제 공격 사례:**  
2022년 Ronin Network 해킹(6억 달러)과 유사한 초기화 함수 탈취 공격이 실제로 여러 프로토콜에서 발생했다. 이 한 줄의 중요성을 강조할 것.

**`constant` 변수 질문이 나오면:**  
`MINTER_ROLE`이 왜 storage layout에 안 잡히냐는 질문이 올 수 있다. "constant는 컴파일 시 bytecode에 inlining되어 storage를 쓰지 않는다. storage layout 검증 대상이 아니다."

**Storage Layout 검증 명령:**

```bash
npx hardhat check
# @openzeppelin/hardhat-upgrades가 layout 충돌 자동 감지
```

업그레이드 시 이 명령을 먼저 실행하는 습관을 들일 것. S42에서 실제 업그레이드 실습 시 다시 등장한다.

**S41 예고:**  
다음 시간에 `deploy-rewards.ts`를 실행해서 Sepolia에 실제 배포한다. ActivityOracle → PermissiveCompliance → KyoboNFT(UUPS) → NFTIssuer → MINTER_ROLE 부여 순서로 진행한다.
