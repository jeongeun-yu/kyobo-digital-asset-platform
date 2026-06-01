# M6 S36 — OpenZeppelin 첫 사용 — Ownable·Pausable·AccessControl

> 모듈 6 · 세션 36 · 1시간  
> 강의 50분 + 실습 10분  
> 실습 환경: [Remix IDE](https://remix.ethereum.org)  
> **강사 배경 분량: 120분 기준 — 강의 50분을 자신있게 소화하기 위한 깊이**

---

## [강사 배경] — 강의 전 반드시 숙지

> 이 섹션은 수강생에게 직접 전달하는 내용이 아니다.  
> 강사가 질문에 즉시 답변하고, 맥락을 자연스럽게 연결하기 위한 배경지식이다.  
> 강의 중 자연스럽게 녹여낼 것.

---

### [배경 1] OpenZeppelin 탄생과 "직접 구현하지 말라"의 근거

**탄생 배경:**  
2015년 Manuel Araoz 외 여러 명이 Zeppelin Solutions를 창립했다. 초기 미션은 스마트컨트랙트 **보안 감사(security audit)** 였다. 감사를 반복하다 보니 동일한 패턴의 취약점이 계속 반복됨을 발견했다. "매번 감사하는 대신, 처음부터 안전한 표준 구현체를 만들자"는 것이 OpenZeppelin 라이브러리의 출발점이다.

**"직접 구현하지 말라"의 실제 근거 — 역사적 사고들:**

| 사고 | 연도 | 손실 | 원인 |
|---|---|---|---|
| The DAO 해킹 | 2016 | $60M | 재진입(reentrancy) 취약점, 직접 구현한 자금 인출 로직 |
| Parity Wallet 1차 | 2017 | $30M | `delegatecall` + 초기화 로직 미구현 (직접 만든 멀티시그) |
| Parity Wallet 2차 | 2017 | $280M 동결 | `selfdestruct` 접근 제어 미적용, 라이브러리 컨트랙트 소각 (513,774 ETH) |
| Bancor 해킹 | 2018 | $23.5M | 직접 구현한 전송 함수의 접근 제어 버그 |

세 사고의 공통점: **직접 작성한 접근 제어·권한 코드의 실수**. OpenZeppelin이 이미 해결한 문제들이다.

**OZ 코드의 신뢰 근거:**
- 수십 개의 독립 외부 보안 감사(Trail of Bits, Certora, Sigma Prime 등)
- 수백만 달러 규모의 공개 버그바운티 운영
- GitHub에서 수천 개 프로덕션 컨트랙트가 의존
- 코드 한 줄 변경도 공개 PR + 검토 후 반영

**결론:** "OZ 코드를 수정해서 쓰는 것"이 "직접 구현"보다 위험하다. 상속받아 그대로 쓰는 것이 원칙이다.

---

### [배경 2] OZ 라이브러리 버전 체계 — contracts vs contracts-upgradeable

```
@openzeppelin/contracts              ← 일반 컨트랙트용
@openzeppelin/contracts-upgradeable ← 프록시 패턴(업그레이드 가능) 컨트랙트 전용
```

**왜 별도 패키지인가?**

업그레이드 가능한 컨트랙트(프록시 패턴)는 `constructor`를 사용할 수 없다. 이유: 프록시를 통해 로직 컨트랙트 코드를 실행할 때, 생성자는 이미 실행이 끝난 상태라 프록시 저장소에 반영되지 않는다.

대신 `initialize()` 함수를 사용하는 **initializer 패턴**이 필요하다:

```solidity
// contracts-upgradeable 버전
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract KyoboNFTUpgradeable is Initializable, AccessControlUpgradeable {
    function initialize(address admin) public initializer {
        __AccessControl_init();          // constructor 대신
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }
}
```

Phase 1에서는 일반 `@openzeppelin/contracts`를 쓴다. M9 업그레이드 패턴에서 `contracts-upgradeable`로 전환 예정.

---

### [배경 3] Ownable 내부 동작 완전 이해

**실제 OZ v5 Ownable.sol 핵심 코드:**

```solidity
abstract contract Ownable is Context {
    address private _owner;                    // private: 상속해도 직접 접근 불가

    error OwnableUnauthorizedAccount(address account);
    error OwnableInvalidOwner(address owner);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address initialOwner) {
        if (initialOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));  // v5: address(0) owner 금지
        }
        _transferOwnership(initialOwner);
    }

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    function _checkOwner() internal view virtual {
        if (owner() != _msgSender()) {
            revert OwnableUnauthorizedAccount(_msgSender());
        }
    }

    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(newOwner);
    }
}
```

**`transferOwnership`의 치명적 문제 — 실제 사고:**

`transferOwnership`은 호출 즉시 소유권이 이전된다. 새 주소가 수락할 필요가 없다.

```
사고 시나리오:
  deployer → transferOwnership("0xDEAD...beef")  # 오타로 잘못된 주소 입력
  → _owner = 0xDEAD...beef  (즉시)
  → 아무도 그 주소를 컨트롤하지 못함
  → 컨트랙트 영구 lock
```

실제로 이런 이유로 수억 원 규모의 자산이 영구 동결된 사례가 있다.

**Ownable2Step 내부 동작:**

```solidity
abstract contract Ownable2Step is Ownable {
    address private _pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    // 1단계: 제안
    function transferOwnership(address newOwner) public virtual override onlyOwner {
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner(), newOwner);
        // _owner는 아직 변경 안 됨
    }

    // 2단계: 수락 (반드시 pendingOwner가 직접 호출)
    function acceptOwnership() public virtual {
        address sender = _msgSender();
        if (pendingOwner() != sender) {
            revert OwnableUnauthorizedAccount(sender);
        }
        _transferOwnership(sender);
    }
}
```

**pending 상태 취소 방법:** 현재 owner가 `transferOwnership(currentOwner)` 를 다시 호출하면 `_pendingOwner`가 자기 자신으로 덮어씌워져 사실상 취소된다.

---

### [배경 4] AccessControl 내부 구조 완전 이해

**핵심 자료구조:**

```solidity
struct RoleData {
    mapping(address account => bool) hasRole;
    bytes32 adminRole;
}

mapping(bytes32 role => RoleData) private _roles;
```

`_roles` 매핑은 `bytes32 role ID → RoleData`로 구성된다. RoleData 안에는 두 가지가 있다:
1. `hasRole`: 어떤 주소가 이 역할을 갖는지 (주소 → bool)
2. `adminRole`: 이 역할을 부여·회수할 수 있는 상위 역할의 ID

**role이 bytes32인 이유:**
- `keccak256("MINTER_ROLE")` → 32바이트 고정 해시
- 문자열("MINTER_ROLE") 비교는 gas가 많이 든다. bytes32 비교는 단일 EVM 연산 (`==`)
- 해시 충돌 확률: 2^256분의 1 → 실질적으로 불가능

**DEFAULT_ADMIN_ROLE의 특별한 의미:**

```solidity
bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
```

`0x00`(32바이트 전부 0)이 기본값이다. 어떤 역할이든 `adminRole`을 명시적으로 설정하지 않으면, 그 역할의 admin은 DEFAULT_ADMIN_ROLE이 된다.

```
역할 X를 생성한다
→ _roles[X].adminRole = 0x00 (기본값)
→ DEFAULT_ADMIN_ROLE(0x00) 보유자만 역할 X를 부여·회수 가능
```

**`grantRole` vs `_grantRole` 차이:**

```solidity
// public — adminRole 체크 후 부여
function grantRole(bytes32 role, address account)
    public virtual override onlyRole(getRoleAdmin(role))
{
    _grantRole(role, account);
}

// internal — 체크 없이 강제 부여 (constructor, initialize에서 사용)
function _grantRole(bytes32 role, address account) internal virtual {
    if (!hasRole(role, account)) {
        _roles[role].hasRole[account] = true;
        emit RoleGranted(role, account, _msgSender());
    }
}
```

`constructor`에서 `_grantRole`을 쓰는 이유: 배포 시점에 adminRole 체크 없이 초기 역할을 강제로 부여해야 하기 때문.

---

### [배경 5] 역할 설계 실수 패턴 — 3대 안티패턴

**실수 1: DEFAULT_ADMIN_ROLE을 address(0)에 부여**

```solidity
// 잘못된 예
constructor() {
    _grantRole(DEFAULT_ADMIN_ROLE, address(0));  // 아무도 역할 관리 불가
}
```

address(0)은 아무도 컨트롤할 수 없는 주소다. 역할 관리 기능이 영구 잠긴다.

**실수 2: deployer가 모든 역할을 보유한 채 운영 시작**

```solidity
// 흔한 실수 패턴
constructor() {
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(MINTER_ROLE, msg.sender);
    _grantRole(PAUSER_ROLE, msg.sender);
    // Gnosis Safe로 이전하기 전에 운영 시작 → deployer EOA 키 탈취 시 전체 장악
}
```

배포 직후 Gnosis Safe로 이전하기 전까지 운영하지 않는 것이 원칙이다. 테스트넷에서만 deployer EOA를 사용한다.

**실수 3: adminRole 설정 없이 역할 계층만 선언**

```solidity
// 의도는 있지만 효과 없는 예
bytes32 public constant MINTER_ADMIN_ROLE = keccak256("MINTER_ADMIN_ROLE");
bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

constructor() {
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(MINTER_ADMIN_ROLE, ops_address);
    _grantRole(MINTER_ROLE, vasp_address);
    // _setRoleAdmin(MINTER_ROLE, MINTER_ADMIN_ROLE) 를 빠뜨림
    // → MINTER_ROLE의 adminRole은 여전히 DEFAULT_ADMIN_ROLE(0x00)
    // → ops_address가 MINTER_ROLE을 부여할 수 없음
}
```

**올바른 역할 계층 설계:**

```
DEFAULT_ADMIN_ROLE (Gnosis Safe)
  └─ adminRole of ADMIN_ROLE → DEFAULT_ADMIN_ROLE이 ADMIN_ROLE 부여·회수
       └─ adminRole of MINTER_ROLE → ADMIN_ROLE이 MINTER_ROLE 부여·회수
       └─ adminRole of PAUSER_ROLE → ADMIN_ROLE이 PAUSER_ROLE 부여·회수
```

```solidity
constructor() {
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(ADMIN_ROLE, admin_address);

    // 핵심: adminRole 명시적 설정
    _setRoleAdmin(MINTER_ROLE, ADMIN_ROLE);   // ADMIN_ROLE이 MINTER_ROLE 관리
    _setRoleAdmin(PAUSER_ROLE, ADMIN_ROLE);   // ADMIN_ROLE이 PAUSER_ROLE 관리
}
```

---

### [배경 6] Pausable 내부 동작과 Circuit Breaker 패턴

**내부 구조:**

```solidity
abstract contract Pausable is Context {
    bool private _paused;                // 단순한 bool

    error EnforcedPause();
    error ExpectedPause();

    event Paused(address account);
    event Unpaused(address account);

    modifier whenNotPaused() {
        _requireNotPaused();
        _;
    }

    modifier whenPaused() {
        _requirePaused();
        _;
    }

    function _pause() internal virtual whenNotPaused {
        _paused = true;
        emit Paused(_msgSender());
    }

    function _unpause() internal virtual whenPaused {
        _paused = false;
        emit Unpaused(_msgSender());
    }
}
```

단순한 bool 하나로 전체 시스템의 특정 기능을 정지시킨다. 이것이 **Circuit Breaker 패턴**이다. 전기 회로의 차단기처럼, 이상 신호 감지 시 전체 흐름을 차단한다.

**pause가 필요한 실제 상황:**
- 취약점 발견: 해킹 진행 중 추가 피해 차단
- 규제 기관 요청: 금감원, 금융위의 일시 정지 요구
- 오라클 장애: 가격 데이터 이상으로 잘못된 자산 가치 반영 방지
- 스마트컨트랙트 업그레이드 준비: 이전 버전 동작 중단

**KyoboNFT의 `_update` 훅에서 `whenNotPaused`를 쓰는 이유:**

ERC-1155의 `_update`는 모든 토큰 이동(mint, burn, transfer)의 공통 진입점이다. 여기에 `whenNotPaused`를 걸면, mint/transfer/burn 각각에 개별 modifier를 달 필요 없이 **단 한 곳에서** 전체를 통제한다.

```solidity
// _update를 선택한 이유: 모든 토큰 이동의 공통 경로
function _update(
    address from,
    address to,
    uint256[] memory ids,
    uint256[] memory values
) internal virtual override whenNotPaused {
    super._update(from, to, ids, values);
}
```

만약 `mint()`에만 `whenNotPaused`를 달면, `safeTransferFrom()`은 paused 상태에서도 동작한다. `_update` 훅이 더 완전한 보호를 제공한다.

---

### [배경 7] AccessControlEnumerable 내부 구조

**기본 AccessControl의 한계:**

표준 AccessControl은 `_roles[role].hasRole[account]` 매핑만 있다. 매핑은 단방향이다: 주소 → bool. "MINTER_ROLE을 가진 주소가 몇 명인지", "누구인지"를 온체인에서 조회할 수 없다.

**AccessControlEnumerable의 추가 구조:**

```solidity
// 내부적으로 EnumerableSet.AddressSet을 역할별로 관리
mapping(bytes32 role => EnumerableSet.AddressSet) private _roleMembers;
```

EnumerableSet은 내부적으로 `_values` 배열과 `_positions` 매핑을 조합해서 O(1) 추가·삭제·존재 확인을 구현한다. 배열만 있으면 삭제가 O(n)이고, 매핑만 있으면 열거가 불가하다. 두 가지를 동시에 유지한다.

**추가 함수:**

```solidity
function getRoleMemberCount(bytes32 role) public view returns (uint256)
function getRoleMember(bytes32 role, uint256 index) public view returns (address)
```

**언제 Enumerable을 쓰는가:**
- 관리자 UI에서 "현재 MINTER_ROLE 보유자 목록" 표시 필요 시
- 감사 보고서용 역할 보유자 스냅샷 조회
- 이벤트 로그 대신 온체인 상태 직접 조회가 필요할 때

**트레이드오프:** `grantRole`/`revokeRole` 시 gas가 약간 더 든다. 목록 조회가 필요하지 않으면 기본 AccessControl이 더 효율적이다.

---

### [배경 8] 중앙화 위험과 Gnosis Safe

**단일 EOA가 DEFAULT_ADMIN_ROLE을 갖는 위험:**

```
시나리오: 배포자 EOA의 개인키 탈취

공격자 → grantRole(MINTER_ROLE, attacker_address)
공격자 → mint(attacker_wallet, [1,2,3], [1000000, 1000000, 1000000])
공격자 → revokeRole(MINTER_ROLE, vasp_address)   # 정상 운영 차단
공격자 → revokeRole(DEFAULT_ADMIN_ROLE, deployer) # 복구 차단
```

단 몇 번의 트랜잭션으로 전체 시스템이 장악된다.

**TimeLock + Gnosis Safe 조합:**

```
Gnosis Safe (멀티시그, 예: 3-of-5)
  ↓ (모든 중요 트랜잭션은 다수결 서명 후 실행)
TimeLock Controller (예: 48시간 지연)
  ↓ (실행까지 대기 시간 → 이상 트랜잭션 감지·취소 가능)
KyoboNFT AccessControl
```

Phase 1의 한계: 배포자가 초기에 모든 역할을 보유한다. M9에서 Gnosis Safe로 DEFAULT_ADMIN_ROLE을 이전하고, deployer에서 모든 역할을 revoke한다.

---

### [배경 9] 실제 프로토콜 AccessControl 설계 사례

**Compound Protocol 역할 구조:**  
Compound는 `Timelock` 컨트랙트가 admin이다. 모든 파라미터 변경은 거버넌스 투표(COMP 토큰) → Timelock 큐 → 48시간 대기 → 실행의 단계를 거친다. 단일 EOA가 admin인 프로젝트는 DeFi 커뮤니티에서 신뢰를 받지 못한다.

**Uniswap v3 fee tier:**  
새 fee tier 추가는 `Factory.enableFeeAmount()`를 통해 `owner`만 가능하다. 여기서 `owner`는 Uniswap v3 배포 초기에는 Uniswap Labs multisig였다가, 이후 거버넌스로 이전했다.

**교보생명 Phase 1 역할 매트릭스:**

| 역할 | 부여 주체 | 회수 주체 | 가능한 작업 | 보유자 |
|---|---|---|---|---|
| DEFAULT_ADMIN_ROLE | (없음 — 최상위) | DEFAULT_ADMIN | 전체 역할 부여·회수 | Gnosis Safe |
| MINTER_ROLE | DEFAULT_ADMIN | DEFAULT_ADMIN | NFT 발행 | VASP 서버 |
| PAUSER_ROLE | DEFAULT_ADMIN | DEFAULT_ADMIN | pause/unpause | 운영팀 EOA |
| AUDITOR_ROLE | DEFAULT_ADMIN | DEFAULT_ADMIN | 감사 로그 조회 | 감사팀 EOA |

역할 변경 전체 흐름:
```
① 새 VASP 서버 온보딩
   Gnosis Safe 3-of-5 서명 수집
   → grantRole(MINTER_ROLE, new_vasp_address)
   → revokeRole(MINTER_ROLE, old_vasp_address)
   이벤트: RoleGranted, RoleRevoked → 온체인 감사 기록

② 이상 감지 → 긴급 정지
   운영팀 EOA → pause()  (단일 서명, 즉시 실행)
   → 모든 mint/transfer 차단

③ 원인 해소 → 재개
   운영팀 EOA → unpause()
```

---

## 강의 파트 (50분)

# OpenZeppelin — 접근 제어 · 긴급 정지 · 업그레이드 패턴

> S34에서 직접 만든 `onlyOwner`를 OpenZeppelin의 감사된 구현으로 대체한다. M7(KyoboNFT 구현)에서 이 컨트랙트들을 상속해 쓴다.

---

## 1. OpenZeppelin이란

OpenZeppelin은 스마트컨트랙트 표준 구현체 라이브러리다. ERC-20·ERC-721·ERC-1155 표준, 접근 제어, 업그레이드 패턴 등을 **감사(audit)된 코드**로 제공한다.

```
S34에서 직접 만든 것           OpenZeppelin이 제공하는 것
──────────────────────────    ──────────────────────────────────────────
modifier onlyOwner()        → Ownable: onlyOwner + transferOwnership + 엣지케이스
(없음)                      → Pausable: whenNotPaused + whenPaused + _pause/_unpause
(없음)                      → AccessControl: 역할 기반 + 역할별 admin + 이벤트
```

**왜 직접 짜지 않는가?**
접근 제어 로직의 작은 실수가 대형 사고로 이어진 사례가 반복됐다.

| 사건 | 시점 | 손실 (당시 기준) | 원인 |
|---|---|---|---|
| The DAO | 2016 | 약 $60M (재진입) | 재진입(reentrancy) |
| Parity Wallet 1차 | 2017.7 | 약 $32M 도난 | multisig 초기화 취약점 |
| Parity Wallet 2차 | 2017.11 | 약 513,743 ETH 동결 (당시 ~$150M) | 라이브러리 self-destruct |
| Bancor | 2018 | 보도 기준 약 $23.5M | 업그레이드 권한 지갑 탈취 |

> **수치 주의:** 손실액은 "도난·동결 시점의 ETH 가치" 기준이다. Parity 2차는 이후 ETH 가격 상승으로 $280M+로 인용되기도 하나, 이는 평가 시점이 다른 것이다. 강의에선 "동결 시점 약 $150M, 이후 평가액은 더 큼"으로 설명하는 것이 정확하다.

세 사건 모두 직접 구현한 권한/업그레이드 로직의 실수였다. OpenZeppelin은 반복되는 취약점 패턴을 표준화하고, 수십 개 외부 감사와 버그바운티를 거친 결과물이다. **상속받아 그대로 쓰는 것**이 직접 구현보다 안전하다.

**Remix에서 import 방법:**

```solidity
// @openzeppelin 경로 → Remix가 자동으로 GitHub에서 fetch
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
```

Hardhat 프로젝트에서는 `npm install @openzeppelin/contracts` 후 동일하게 import.

> **버전 주의:** 이 노트는 **OZ v5 기준**이다. v4와 v5는 에러 처리(문자열 → custom error), 생성자 시그니처 등이 다르므로, 구버전 튜토리얼을 참고할 때 주의한다.

---

## 2. Ownable — 단일 소유자 패턴

가장 단순한 접근 제어. owner 1명이 관리하는 컨트랙트에 사용한다.

```solidity
import "@openzeppelin/contracts/access/Ownable.sol";

contract MyContract is Ownable {
    // OZ v5: Ownable 생성자에 initialOwner 필수
    constructor(address initialOwner) Ownable(initialOwner) {}

    function sensitiveAction() public onlyOwner {
        // owner만 호출 가능
    }
}
```

> **생성자 인자, 왜 두 가지 형태가 있나:** `Ownable(initialOwner)`에 외부 주소를 받으면 "배포자가 아닌 다른 주소"를 초기 owner로 지정할 수 있다(예: 멀티시그). `Ownable(msg.sender)`로 고정하면 배포자가 owner가 된다. 둘 다 유효하며, 유연성이 필요하면 인자로 받는 쪽을 쓴다.

**Ownable이 제공하는 것:**

| 함수 / modifier | 설명 |
|---|---|
| `owner()` | 현재 소유자 주소 반환 |
| `onlyOwner` | owner가 아니면 revert (`OwnableUnauthorizedAccount` custom error, v5) |
| `transferOwnership(newOwner)` | 소유권 즉시 이전 (오타 시 복구 불가) |
| `renounceOwnership()` | 소유권 영구 포기 (address(0) 설정) |
| `OwnershipTransferred` 이벤트 | 소유권 변경 시 기록 |

**Ownable2Step — 소유권 이전 사고 방지:**

`transferOwnership`은 즉시 이전된다. 잘못된 주소를 입력하면 컨트랙트가 영구 lock된다. Ownable2Step은 2단계로 나눠 실수를 방지한다.

```solidity
import "@openzeppelin/contracts/access/Ownable2Step.sol";

contract SafeContract is Ownable2Step {
    constructor() Ownable(msg.sender) {}   // Ownable2Step도 Ownable 생성자를 호출
}
// 1단계: transferOwnership(newOwner) → pendingOwner 설정 (즉시 이전 안 됨)
// 2단계: newOwner가 acceptOwnership() 직접 호출해야 완료
// 취소: 현재 owner가 transferOwnership(currentOwner) 다시 호출
```

**Ownable의 한계:**
소유자가 1명뿐이다. 교보 시스템처럼 발행자·일시정지 담당자·감사자가 분리되어야 하면 AccessControl이 필요하다.

---

## 3. Pausable — 긴급 정지 (Circuit Breaker)

운영 중 발생하는 사고(해킹 탐지, 규제 요청, 버그 발견)에 즉시 대응하는 패턴이다. 블록체인의 Circuit Breaker — 이상 신호 감지 시 즉시 차단한다.

```solidity
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract KyoboBase is Ownable, Pausable {
    constructor() Ownable(msg.sender) {}

    // owner만 정지/재개 가능
    function pause()   public onlyOwner { _pause(); }
    function unpause() public onlyOwner { _unpause(); }

    // 정지 중 발행 불가
    function mint(address to, uint256 amt) public onlyOwner whenNotPaused {
        // 발행 로직
    }

    // 정지 중에도 조회는 가능 (whenNotPaused 없음)
    function balanceOf(address who) public view returns (uint256) { /* ... */ }
}
```

**Pausable이 제공하는 것:**

| modifier / 함수 | 설명 |
|---|---|
| `whenNotPaused` | paused이면 revert (v5: `EnforcedPause()` / v4: `"Pausable: paused"`) |
| `whenPaused` | paused일 때만 통과 (v5: `ExpectedPause()`) |
| `_pause()` | 내부 정지 상태 전환 (internal — 외부 노출 시 권한 modifier 필수) |
| `_unpause()` | 내부 재개 상태 전환 (internal) |
| `paused()` | 현재 상태 조회 |
| `Paused` / `Unpaused` 이벤트 | 상태 변경 시 기록 |

> **`_pause()`는 internal이다.** 그대로 두면 외부에서 못 부른다. 위 코드처럼 `pause()` public 함수로 감싸되 **반드시 권한 modifier**(`onlyOwner` / `onlyRole`)를 붙여야 한다. 안 붙이면 누구나 컨트랙트를 멈출 수 있다.

**KyoboNFT에서 `_update` 훅을 선택한 이유:**
ERC-1155의 `_update`는 mint·transfer·burn 모두의 공통 진입점이다(v5에서 `_beforeTokenTransfer`가 `_update`로 통합됨). 여기 하나에만 `whenNotPaused`를 걸면 모든 토큰 이동이 통제된다. `mint()`에만 달면 `safeTransferFrom()`은 paused 상태에서도 작동한다.

**Phase 1 적용:**
규제 기관 요청이나 해킹 탐지 시 `pause()`로 KyoboNFT 발행을 즉시 중단한다. 정지 중에는 `mint()` 호출이 모두 revert된다. 이 기능은 ISMS·금융감독원 보안 요건에서도 요구한다.

---

## 4. AccessControl — 역할 기반 접근 제어

Ownable의 "1인 소유자" 한계를 극복한다. **역할(Role)** 을 정의하고 여러 주소에 부여한다.

내부 핵심 구조: `mapping(bytes32 role => RoleData)`. role ID는 `keccak256` 해시(bytes32) — 문자열 비교보다 gas 효율적이다.

> **충돌에 대하여:** role ID는 keccak256 출력 **전체(256비트)**를 쓰므로 서로 다른 역할 문자열이 같은 ID를 가질 확률은 사실상 0이다. (함수 선택자는 앞 4바이트만 잘라 써서 충돌이 가능했던 것과 대조된다 — 차이는 "자르느냐, 전체를 쓰느냐"다.)

```solidity
import "@openzeppelin/contracts/access/AccessControl.sol";

contract KyoboNFTController is AccessControl {
    bytes32 public constant MINTER_ROLE  = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE  = keccak256("PAUSER_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");

    constructor() {
        // DEFAULT_ADMIN_ROLE: 모든 역할의 최상위 관리자 (값 = 0x00...00)
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);   // 배포자에게 발행 권한 초기 부여
    }

    function mint(address to, uint256 tokenId, uint256 amount)
        public onlyRole(MINTER_ROLE)
    {
        // MINTER_ROLE 보유자만 발행
    }

    function pause()   public onlyRole(PAUSER_ROLE) { /* _pause(); */ }
    function unpause() public onlyRole(PAUSER_ROLE) { /* _unpause(); */ }

    function getAuditLog() public view onlyRole(AUDITOR_ROLE) returns (bytes memory) { /* ... */ }
}
```

> **`_grantRole` vs `grantRole` — 헷갈리기 쉬운 핵심:**
> - `_grantRole` (internal): 권한 검사 **없이** 부여. constructor·초기 설정 전용. 아직 admin이 없는 배포 시점에 초기 권한을 심을 때 쓴다.
> - `grantRole` (external): 해당 역할의 adminRole 보유자만 호출 가능. **운영 중** 부여는 이걸 쓴다.
>
> 운영 코드에서 `_grantRole`을 외부 함수로 노출하면 권한 검사를 건너뛰는 보안 구멍이 된다.

**AccessControl이 제공하는 것:**

| 함수 / modifier | 설명 |
|---|---|
| `onlyRole(role)` | 역할 없으면 revert (v5: `AccessControlUnauthorizedAccount(account, neededRole)` custom error) |
| `hasRole(role, account)` | 역할 보유 여부 조회 |
| `grantRole(role, account)` | 역할 부여 (해당 역할의 adminRole 보유자만 가능) |
| `revokeRole(role, account)` | 역할 회수 (`onlyRole(getRoleAdmin(role))` — adminRole 보유자만) |
| `renounceRole(role, callerConfirmation)` | 자기 역할 스스로 반납 (v5: 본인 주소 확인 인자 필요) |
| `getRoleAdmin(role)` | 그 역할을 부여·회수할 수 있는 관리 역할의 해시값(bytes32) 반환 |
| `RoleGranted` / `RoleRevoked` 이벤트 | 역할 변경 시 기록 |

> **v5 에러 형태:** 권한 없이 호출하면 v4의 긴 문자열(`"AccessControl: account 0x... is missing role 0x..."`)이 아니라, custom error `AccessControlUnauthorizedAccount(account, neededRole)`가 발생한다. Remix Logs에서 이 형태로 보인다.

---

## 5. AccessControl 역할 체계 설계

**기본 역할 구조:**

```
DEFAULT_ADMIN_ROLE (0x00)       ← 모든 역할의 기본 admin
  └─ MINTER_ROLE               (VASP 서버 주소에 부여)
  └─ PAUSER_ROLE               (운영팀 주소에 부여)
  └─ AUDITOR_ROLE              (감사팀 주소에 부여)
```

**역할별 admin 커스터마이징 (올바른 패턴):**

```solidity
// MINTER_ROLE의 admin을 ADMIN_ROLE로 설정
// → DEFAULT_ADMIN이 아닌 ADMIN_ROLE 보유자만 MINTER_ROLE 부여·회수 가능
bytes32 public constant ADMIN_ROLE   = keccak256("ADMIN_ROLE");
bytes32 public constant MINTER_ROLE  = keccak256("MINTER_ROLE");
bytes32 public constant PAUSER_ROLE  = keccak256("PAUSER_ROLE");

constructor(address admin_address) {
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(ADMIN_ROLE, admin_address);

    // 반드시 명시적으로 설정 — 빠뜨리면 여전히 DEFAULT_ADMIN이 관리
    _setRoleAdmin(MINTER_ROLE, ADMIN_ROLE);
    _setRoleAdmin(PAUSER_ROLE, ADMIN_ROLE);
}
```

**역할 설계 3대 실수:**

| 실수 | 증상 | 올바른 해결 |
|---|---|---|
| DEFAULT_ADMIN_ROLE → address(0) 부여 | 역할 관리 영구 불가 | Gnosis Safe 등 실제 주소에 부여 |
| deployer EOA가 모든 역할 보유한 채 운영 | 키 탈취 시 전체 장악 | 배포 직후 Gnosis Safe로 이전 |
| `_setRoleAdmin()` 빠뜨림 | ADMIN_ROLE이 MINTER 관리 못 함 | 반드시 명시 설정 |

**Phase 1 역할 설계:**

| 역할 | 보유자 | 가능한 작업 |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Gnosis Safe (멀티시그) | 역할 부여·회수 |
| `MINTER_ROLE` | VASP 서버 주소 | NFT 발행 |
| `PAUSER_ROLE` | 운영팀 EOA | 긴급 정지·재개 |
| `UPGRADER_ROLE` | Gnosis Safe | 컨트랙트 업그레이드 |

`DEFAULT_ADMIN_ROLE`을 단일 EOA에 두면 키 탈취 시 전체 권한 장악이 가능하다. M9에서 Gnosis Safe 멀티시그로 이 역할을 관리한다.

---

## 6. Ownable vs AccessControl — 선택 기준

| | Ownable | Ownable2Step | AccessControl |
|---|---|---|---|
| 소유자 수 | 1명 | 1명 | 역할당 N명 |
| 역할 분리 | 불가 | 불가 | 가능 |
| 이전 안전성 | 즉시 이전 | 수락 필요 | N/A |
| 복잡도 | 낮음 | 낮음 | 높음 |
| 적합한 상황 | 개인 프로젝트 | 중요 자산 단일 관리자 | 기업 시스템, 역할 분리 |
| KyoboNFT | ✗ | ✗ | ✓ |

---

## 7. AccessControlEnumerable — 역할 멤버 조회

표준 AccessControl은 역할 멤버를 열거할 수 없다. (매핑은 단방향 — 주소 → bool). 조회가 필요하면 Enumerable 버전을 사용한다.

```solidity
import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";

contract KyoboNFT is AccessControlEnumerable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // 추가 함수: MINTER_ROLE을 가진 모든 주소 조회
    function getMinters() public view returns (address[] memory) {
        uint256 count = getRoleMemberCount(MINTER_ROLE);
        address[] memory minters = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            minters[i] = getRoleMember(MINTER_ROLE, i);
        }
        return minters;
    }
}
```

**언제 쓰는가:**
- 관리자 UI에서 "현재 MINTER_ROLE 보유자 목록" 표시 필요 시
- 감사 보고서용 역할 보유자 온체인 조회

**트레이드오프:** `grantRole`/`revokeRole` 시 멤버 목록을 유지하느라 gas가 약간 더 든다. 목록 조회가 불필요하면 기본 AccessControl로 충분하다.

**감사(audit) 시 유용:** "현재 MINTER_ROLE을 가진 주소가 몇 개인가?"를 온체인에서 바로 조회할 수 있다. 규제 요건 대응에 필요하다.

---

## 8. Phase 1 전체 접근 제어 흐름

```
배포 시:
  KyoboNFT 배포 (deployer = DEFAULT_ADMIN_ROLE)
  → grantRole(MINTER_ROLE, VASP_SERVER_ADDRESS)
  → grantRole(PAUSER_ROLE, OPS_TEAM_ADDRESS)
  → grantRole(DEFAULT_ADMIN_ROLE, GNOSIS_SAFE_ADDRESS)
  → revokeRole(DEFAULT_ADMIN_ROLE, deployer)   ← 반드시 마지막에

운영 중:
  VASP 서버 → mint() 호출 (MINTER_ROLE 검증)
  이상 탐지 → OPS_TEAM → pause() (PAUSER_ROLE 검증)
  원인 해소 → OPS_TEAM → unpause()
  VASP 서버 교체 → GNOSIS_SAFE 멀티시그 3-of-5 서명
    → revokeRole(MINTER_ROLE, OLD_VASP)
    → grantRole(MINTER_ROLE, NEW_VASP)
    → 이벤트: RoleRevoked, RoleGranted (온체인 감사 기록)
```

> **순서가 중요하다:** `revokeRole(DEFAULT_ADMIN_ROLE, deployer)`를 **반드시 마지막에** 한다. Gnosis Safe에 DEFAULT_ADMIN을 먼저 부여하기 전에 deployer 권한을 회수하면, 아무도 admin이 없는 상태로 컨트랙트가 영구 잠긴다.

---

## 실습 파트 (10분)

### 실습 A — KyoboMintController 핵심 시나리오 (5분)

Remix에서 `KyoboMintController.sol` 작성:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract KyoboMintController is AccessControl, Pausable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public mintCount;
    event NFTMinted(address indexed to, uint256 indexed tokenId, uint256 amount);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    function mint(address to, uint256 tokenId, uint256 amount)
        public onlyRole(MINTER_ROLE) whenNotPaused
    {
        mintCount++;
        emit NFTMinted(to, tokenId, amount);
    }

    function pause()   public onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() public onlyRole(PAUSER_ROLE) { _unpause(); }
}
```

**확인 시나리오:**

```
① grantRole(MINTER_ROLE, Account2주소) → Account2 발행 가능
② Account2로 전환 → mint(Account3, 1, 100) → NFTMinted 이벤트 확인
③ Account1로 전환 → pause() → paused() = true
④ Account2 → mint() → EnforcedPause custom error revert 확인 (v5)
⑤ Account1 → unpause() → Account2 mint 다시 성공
⑥ Account3(역할 없음) → mint() → AccessControlUnauthorizedAccount custom error 확인
   (v4의 "missing role" 문자열이 아니라 custom error 형태)
```

---

### 실습 B — 역할 계층 실험 (3분)

MINTER_ROLE의 admin을 별도 ADMIN_ROLE로 설정하고, ADMIN_ROLE 보유자만 MINTER 부여 가능하도록:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";

contract RoleHierarchyDemo is AccessControlEnumerable {
    bytes32 public constant ADMIN_ROLE  = keccak256("ADMIN_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);   // Account1
        _grantRole(ADMIN_ROLE, msg.sender);

        // MINTER_ROLE의 admin = ADMIN_ROLE (DEFAULT_ADMIN이 아님)
        _setRoleAdmin(MINTER_ROLE, ADMIN_ROLE);
    }

    function getMinterCount() public view returns (uint256) {
        return getRoleMemberCount(MINTER_ROLE);
    }

    function getMinter(uint256 index) public view returns (address) {
        return getRoleMember(MINTER_ROLE, index);
    }
}
```

**확인 시나리오:**

```
① Account1 → grantRole(ADMIN_ROLE, Account2)
② Account2(ADMIN_ROLE) → grantRole(MINTER_ROLE, Account3) → 성공
③ Account2 → getMinterCount() → 1
④ Account2 → getMinter(0) → Account3 주소 반환
⑤ Account3(MINTER 보유, ADMIN 없음) → grantRole(MINTER_ROLE, Account4) → 실패
   (MINTER_ROLE의 admin은 ADMIN_ROLE — Account3는 ADMIN 없음)
```

---

### 실습 C — Ownable2Step 2단계 이전 시연 (2분)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

contract TwoStepDemo is Ownable2Step {
    constructor() Ownable(msg.sender) {}

    function sensitiveAction() public onlyOwner {}
}
```

**확인 시나리오:**

```
① Account1 → transferOwnership(Account2) → pendingOwner() = Account2
② owner() 확인 → 아직 Account1 (이전 미완료)
③ Account1 → sensitiveAction() → 성공 (아직 Account1이 owner)
④ Account3 → acceptOwnership() → 실패 (pendingOwner 아님)
⑤ Account2 → acceptOwnership() → 성공 → owner() = Account2
⑥ Account1 → sensitiveAction() → 실패 (OwnableUnauthorizedAccount)
```

---

## 완료 기준

- [ ] `@openzeppelin/contracts` import → 컴파일 성공
- [ ] `DEFAULT_ADMIN_ROLE` / `MINTER_ROLE` / `PAUSER_ROLE` 역할 체계 설명 가능
- [ ] `_grantRole`(internal, 검사 없음) vs `grantRole`(external, admin 검사) 차이 설명 가능
- [ ] `grantRole` / `revokeRole` / `hasRole` 직접 실행 확인
- [ ] `pause()` 후 `mint()` → `EnforcedPause` custom error revert 확인 (v5)
- [ ] 역할 없는 계정 → `AccessControlUnauthorizedAccount` custom error 확인
- [ ] "DEFAULT_ADMIN_ROLE을 단일 EOA에 두면 안 되는 이유" 설명 가능
- [ ] "KyoboNFT에서 MINTER_ROLE을 VASP 주소에만 부여하는 이유" 설명 가능
- [ ] `_setRoleAdmin(MINTER_ROLE, ADMIN_ROLE)`의 의미와 효과 설명 가능
- [ ] Ownable2Step의 2단계 이전 흐름 설명 가능
- [ ] AccessControlEnumerable과 기본 AccessControl의 차이점 설명 가능
- [ ] 배포 흐름에서 `revokeRole(DEFAULT_ADMIN_ROLE, deployer)`를 마지막에 하는 이유 설명 가능


---

## 강사 노트

**반드시 짚을 것:**  
`DEFAULT_ADMIN_ROLE`의 위험성. 이 역할을 가진 주소가 모든 역할을 부여·회수할 수 있다. 단일 EOA가 admin이면 키 탈취 시 전체 권한 장악이 가능하다. M9에서 Gnosis Safe 멀티시그를 admin으로 설정하는 이유다.

**`_grantRole` vs `grantRole` 구분:**  
constructor에서는 `_grantRole`(내부, 체크 없음)을 쓴다. 운영 중에는 `grantRole`(public, adminRole 체크)만 사용 가능하다. 이 구분을 이해하면 AccessControl 내부 구조를 이해한 것이다.

**onlyRole revert 메시지:**  
`"AccessControl: account 0x... is missing role 0x9f2df0fe..."` — 뒤의 해시가 `keccak256("MINTER_ROLE")` 값임을 설명할 것. Remix 콘솔에서 직접 확인시키면 이해가 빠르다.

**`_update` 훅 vs 개별 함수 modifier:**  
"왜 `mint()`에 `whenNotPaused`를 달지 않고 `_update`에 다는가?" 를 질문으로 던질 것. `safeTransferFrom`이 pause를 우회할 수 있다는 것을 수강생 스스로 발견하게 유도한다.

**OZ v4 vs v5 생성자 차이:**  
v4: `Ownable()` — 인자 없음  
v5: `Ownable(address initialOwner)` — 명시적 전달 필수  
Remix 기본 컴파일러 버전에 따라 오류가 날 수 있다. 에러 발생 시 import 경로에 버전 고정: `import "@openzeppelin/contracts@5.0.0/access/Ownable.sol";`

**Phase 1 한계 언급:**  
"오늘 실습 코드는 배포자 EOA가 모든 역할을 갖는다. 실제 운영에서는 배포 즉시 Gnosis Safe로 DEFAULT_ADMIN_ROLE을 이전하고 deployer를 revoke해야 한다. M9에서 직접 한다."

**AccessControlEnumerable 선택 기준:**  
"목록 조회 필요 없으면 기본 AccessControl로 충분하다. Enumerable은 grantRole/revokeRole 때 gas가 더 든다. UI에서 역할 보유자 목록이 필요한 경우에만 쓴다."

**S37 예고:**  
다음 시간은 ERC-20 직접 구현. 오늘 배운 AccessControl + Pausable을 ERC-20 위에 얹는다. OpenZeppelin `ERC20` 기반 컨트랙트가 오늘 패턴의 연장선임을 미리 언급.
