# M6 S39b — msg.sender / call / delegatecall — UUPS의 뼈대

> 모듈 6 · 세션 39b · 1시간  
> 강의 50분 + 실습 10분  
> 실습 환경: [Remix IDE](https://remix.ethereum.org)

---

## [강사 배경] — 120분 분량 심화 지식

> 이 섹션은 강의에서 직접 읽지 않는다. 수강생 질문에 즉시 답하고, 개념 설명에 자신감을 갖기 위한 배경이다.

### A. delegatecall의 탄생 배경 — EVM 레벨에서 이해하기

delegatecall은 EIP-7(2015)에서 Vitalik이 직접 제안한 opcode다. 원래 EVM에는 `CALL`만 있었고, 코드 재사용은 라이브러리 컨트랙트를 call로 호출하는 방식이었다.

문제는 이렇게 생겼다:

```
A가 Library를 call로 부르면
→ Library 내부 msg.sender = A (사용자 주소 손실)
→ Library가 storage를 쓰면 Library 자신의 storage에 기록 (A의 storage 못 씀)
```

코드는 Library에 있는데 데이터는 A에 있어야 하는 상황 — 이게 공유 라이브러리 패턴의 근본 문제였다. delegatecall은 이것을 "context를 그대로 유지한 채 남의 코드만 실행"으로 해결했다.

EVM opcode 레벨에서 DELEGATECALL이 하는 일:
1. 호출 대상 컨트랙트의 코드를 로드
2. 현재 컨트랙트(A)의 storage, msg.sender, msg.value를 그대로 유지
3. 로드한 코드를 A의 context 위에서 실행

이 하나의 opcode가 프록시 패턴, 업그레이드 가능 컨트랙트, 다이아몬드 패턴(EIP-2535)을 모두 가능하게 했다.

### B. tx.origin 공격 — 실제 사례와 왜 아직도 쓰는 코드가 있나

`tx.origin` 권한 체크의 취약점은 2016년부터 알려졌지만, 2023년에도 이 취약점으로 인한 해킹이 발생한다.

**대표 사례 — Poly Network (2021, $611M)**

Poly Network 공격은 직접적인 tx.origin 버그는 아니지만, "호출자 신원 가정"의 실패라는 같은 카테고리다. 컨트랙트가 특정 주소(EthCrossChainManager)의 호출이면 신뢰한다고 가정했는데, 공격자가 그 신뢰 관계를 우회하는 인자를 조작해 keeper 주소를 자신으로 바꿨다.

**왜 아직도 tx.origin을 쓰는 코드가 있나:**

1. 튜토리얼이 오래됐다 — 2016~2018년 작성 코드들이 그대로 복붙됨
2. "내 EOA에서만 직접 호출하는 컨트랙트"라고 착각 — 나중에 멀티시그/스마트 지갑으로 바꾸면 바로 깨짐
3. Account Abstraction(ERC-4337) 환경에서 특히 위험 — 4337은 EOA가 아닌 컨트랙트 지갑으로 TX를 시작하므로 tx.origin == 컨트랙트 주소가 되는 시나리오 발생

**OZ는 어떻게 막나:**

`Ownable.sol`의 `onlyOwner` modifier는 `require(owner() == _msgSender())`. `_msgSender()`는 기본적으로 `msg.sender`를 반환하지만, EIP-2771 메타트랜잭션 지원 시 `Context._msgSender()`를 오버라이드해 trusted forwarder에서 복원한 원래 서명자를 반환한다. tx.origin은 처음부터 고려 대상이 아니다.

### C. call의 저수준 사용법 — ETH 전송 역사

```solidity
// 시대별 ETH 전송 방식
payable(addr).transfer(amount);  // 2016~2019: 2300 gas 제한, 실패 시 revert
payable(addr).send(amount);      // 2016~2019: 2300 gas 제한, 실패 시 false 반환
(bool ok, ) = addr.call{value: amount}("");  // 2019~현재: gas 제한 없음, 현재 권장
```

**왜 transfer/send에서 call로 바뀌었나:**

2019년 Istanbul 하드포크에서 SLOAD opcode의 gas 비용이 200→800으로 올랐다. transfer/send의 2300 gas 제한은 수신 컨트랙트의 fallback 함수가 storage를 읽는 간단한 로직도 실행 못하게 만들었다. 이로 인해 transfer/send는 사실상 사용 불가 수준이 됐고, gas 제한 없는 `call`이 표준이 됐다.

단, `call`을 쓸 때는 재진입(reentrancy) 공격에 노출된다. 이것이 M8에서 다룰 ReentrancyGuard의 배경이다.

### D. Parity 사건 — delegatecall이 얼마나 위험한가

**Parity Multisig 2차 동결 (2017-11-06, 513,774 ETH ≈ 당시 약 $150M)**

Parity 멀티시그 지갑은 실제 로직을 별도 라이브러리 컨트랙트에 두고, 지갑 컨트랙트는 delegatecall로 그 라이브러리를 호출하는 구조였다.

```
지갑 컨트랙트들 (데이터 보관)
   └─ delegatecall → WalletLibrary 컨트랙트 (로직)
```

WalletLibrary에는 `initWallet()` 함수가 있었고, 이 함수는 "한 번만 호출 가능" 제한이 없었다. 한 사용자(devops199)가 실수로(악의 없이) 아무도 소유하지 않은 WalletLibrary를 직접 호출해 자신을 owner로 등록했다. 그리고 `kill()`(selfdestruct)을 실행했다.

WalletLibrary가 파괴되자:
- 모든 지갑 컨트랙트의 delegatecall 대상이 사라짐
- 지갑들이 영구적으로 응답 불능
- 513,774 ETH가 아무도 못 꺼내는 컨트랙트에 영구 동결

**교훈:**
1. delegatecall 대상(라이브러리)은 직접 호출 가능한 공개 상태이면 위험
2. 초기화 함수(`init`)는 반드시 "한 번만" 제한 필요 — 이것이 OZ `initializer` modifier
3. `selfdestruct`와 delegatecall의 조합은 핵폭탄 — OZ의 `UUPSUpgradeable`은 구현 컨트랙트에 직접 selfdestruct가 불가능하도록 가드를 둠

### E. UUPS의 storage 슬롯 설계 — ERC-1967

프록시와 로직 컨트랙트가 storage를 공유할 때 충돌 문제:

```
프록시 슬롯 0: 로직 컨트랙트 주소 (프록시가 관리)
로직 슬롯 0: uint256 totalSupply (로직이 관리)
→ delegatecall로 로직 실행 시 슬롯 0을 totalSupply로 덮어씀 → 프록시가 망가짐
```

ERC-1967은 이 충돌을 방지하기 위해 프록시 관리 변수들의 슬롯을 "절대 충돌 불가능한 위치"에 고정했다:

```solidity
// 로직 컨트랙트 주소 보관 슬롯
bytes32 constant IMPLEMENTATION_SLOT =
    bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
// = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc

// admin 주소 보관 슬롯  
bytes32 constant ADMIN_SLOT =
    bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);
```

keccak256 해시값 - 1을 쓰는 이유: 해시 충돌이 없다고 알려진 값이면서도, `keccak256(...)` 자체를 쓰지 않고 `-1`을 하는 건 preimage attack 방어다(해당 슬롯에서 다른 해시 충돌을 찾기 더 어렵게 만듦).

KyoboNFT가 `is UUPSUpgradeable`을 상속하면 이 슬롯 관리를 OZ가 전부 처리한다.

---

## 강의 본문

### 0. 오늘의 위치 — 왜 지금 이걸 배우나

```
M6 S33~S39: Solidity 문법 → 토큰 표준(ERC-20/721/1155)
          ↓ 여기 (S39b)
M7 S40~S42: KyoboNFT 구현 → 배포 → UUPS 업그레이드
```

M7에 들어가면 KyoboNFT 소스를 처음부터 읽는다. 코드 첫 줄에 `is UUPSUpgradeable`이 있다. 이것이 왜 가능한지, 안에서 무슨 일이 벌어지는지 — 그 뼈대가 오늘의 `msg.sender`와 `delegatecall`이다.

오늘을 건너뛰면 M7에서 "왜 constructor 대신 initialize를 쓰나", "왜 storage 슬롯이 충돌하나"를 설명할 언어가 없다.

---

### 1. msg.sender vs tx.origin — 제일 헷갈리는 한 쌍

**핵심 한 줄:**
- `tx.origin` = 트랜잭션을 처음 시작한 사람 (항상 EOA, 절대 컨트랙트가 될 수 없음)
- `msg.sender` = 지금 이 함수를 직접 호출한 직전 주체 (EOA도 되고 컨트랙트도 됨)

호출이 한 단계면 둘이 같다. **컨트랙트가 다른 컨트랙트를 부르는 순간 갈린다.**

```
사용자(0xUser) → A컨트랙트 → B컨트랙트

B 안에서 보면:
  tx.origin   = 0xUser   ← 트랜잭션 맨 처음 서명한 사람, 변하지 않음
  msg.sender  = A        ← B를 직접 부른 건 A
```

**심부름 비유:**  
내가 친구한테 심부름 시키고, 친구가 가게에 간다.
- 가게 입장에서 `msg.sender` = 친구 (직접 들어온 사람)
- `tx.origin` = 나 (심부름 시킨 최초 발단)

---

#### ⚠️ 권한 검사는 반드시 msg.sender

```solidity
require(tx.origin == owner);   // ❌ 절대 금지
require(msg.sender == owner);  // ✅
```

**tx.origin 공격 시나리오:**

```
owner가 피싱 링크를 클릭 → 악성컨트랙트 실행
owner → 악성컨트랙트 → 내컨트랙트.withdraw()

내컨트랙트 안에서:
  tx.origin   = owner          ← tx.origin 체크라면 통과 ❌
  msg.sender  = 악성컨트랙트   ← msg.sender 체크라면 차단 ✅
```

악성 컨트랙트가 owner를 거쳐 내 컨트랙트를 부르면, `tx.origin`은 여전히 owner라서 권한 체크를 통과해버린다. owner 지갑의 서명을 탈취한 것도 아닌데 owner 권한 행사가 가능해지는 것이다.

OZ의 `onlyOwner`, `onlyRole`이 전부 `msg.sender` 기반인 이유다. **KyoboNFT의 `MINTER_ROLE`, `PAUSER_ROLE`, `UPGRADER_ROLE`도 전부 msg.sender 기반.**

---

### 2. msg.* / tx.* / block.* — 전역 변수 한 번에 정리

**msg.* — 현재 호출에 딸려오는 정보**

| 변수 | 뜻 | 실무 용도 |
|---|---|---|
| `msg.sender` | 직전 호출자 | 권한 체크의 99% |
| `msg.value` | 이 호출에 함께 보낸 ETH (wei) | payable 함수에서 수령액 확인 |
| `msg.data` | calldata 전체 | 저수준 라우팅 |
| `msg.sig` | calldata 앞 4바이트 (함수 선택자) | 디버깅, 프록시 라우팅 |

```solidity
function deposit() public payable {
    require(msg.value > 0, "ETH 필요");
    balances[msg.sender] += msg.value;  // 보낸 사람 잔액에 추가
}
```

**tx.* — 트랜잭션 전체 정보**

| 변수 | 뜻 |
|---|---|
| `tx.origin` | 최초 발신 EOA (권한 체크에 쓰지 말 것) |
| `tx.gasprice` | 이 트랜잭션의 가스 가격 |

**block.* — 블록 메타데이터**

| 변수 | 뜻 | 주의 |
|---|---|---|
| `block.timestamp` | 블록 생성 시각 (Unix 초) | 수십 초 조작 가능 |
| `block.number` | 블록 번호 | 안정적 |
| `block.chainid` | 체인 ID | 멀티체인 서명 재사용 방지 |

```solidity
// timestamp 올바른 사용 vs 잘못된 사용
require(block.timestamp >= deadline);     // ✅ 마감 체크 OK
uint random = block.timestamp % 10;      // ❌ 랜덤 NO — 채굴자가 조작 가능
```

`block.chainid`는 KyoboNFT 서명 검증(EIP-712 도메인 구분)에서 쓴다. 이더리움(chainId=1)에서 서명한 데이터를 폴리곤(chainId=137)에서 재사용하는 공격을 막는다.

**기타 자주 헷갈리는 것:**

| 표현 | 뜻 |
|---|---|
| `address(this)` | 이 컨트랙트 자신의 주소 |
| `address(this).balance` | 이 컨트랙트가 보유한 ETH 잔액 |
| `this.함수명()` | 자기 함수를 외부 호출 형태로 실행 (새 msg.sender = 자기 자신) |

---

### 3. call — 일반 외부 호출

A가 B를 call로 부르면, B의 코드가 **B의 storage와 B의 context에서** 실행된다. 보통의 컨트랙트 간 호출이 전부 이것이다.

```
사용자(0xUser) → A → (call) → B

B 안에서:
  msg.sender = A            ← B를 직접 부른 건 A
  storage    = B의 storage  ← B 자신의 데이터를 읽고 씀
  msg.value  = A가 보낸 ETH (A가 forward한 경우)
```

```solidity
// 인터페이스 호출 = 내부적으로 call
IERC20(tokenAddr).transfer(recipient, amount);

// 저수준 call — ETH 전송 현재 표준 방식
(bool ok, ) = recipient.call{value: amount}("");
require(ok, "ETH 전송 실패");
```

B는 독립된 컨트랙트로서 자기 일을 하고 결과를 돌려준다. A와 B는 완전히 분리된 개체다.

---

### 4. delegatecall — 코드만 빌려오기 (오늘의 핵심)

A가 B를 delegatecall로 부르면, **B의 코드를 가져와 A의 context 위에서** 실행한다.

```
사용자(0xUser) → A → (delegatecall) → B의 코드 실행

실행 중:
  msg.sender = 0xUser       ← A가 아닌 원래 호출자 그대로 유지
  storage    = A의 storage  ← B 코드가 도는데 A의 데이터를 건드림
  msg.value  = 원래 value 그대로
```

**call과 정반대인 두 가지:**

| | call | delegatecall |
|---|---|---|
| 실행 storage | B 자신의 것 | **A의 것** |
| msg.sender | A (바뀜) | **원래 호출자 유지** |

**비유 — 레시피(코드) 대여:**  
B의 레시피를 가져와 **내(A) 주방, 내 재료(storage)로** 요리한다. 레시피만 빌렸지 요리는 내 집에서 하니, 결과물(데이터 변경)은 다 내 집에 남는다. B의 주방은 전혀 사용하지 않는다.

---

#### msg.sender 총정리 — 호출 방식별

| 상황 | msg.sender | 실행 storage |
|---|---|---|
| 사용자 → A 직접 | 사용자 | A |
| 사용자 → A → **call** → B | A (바뀜) | B |
| 사용자 → A → **delegatecall** → B | **사용자 유지** | **A 유지** |

**call = "한 단계 새로 시작"** (context 교체)  
**delegatecall = "맥락 유지 채 코드만 가져옴"** (context 그대로)

---

### 5. delegatecall이 UUPS 업그레이드의 뼈대인 이유

스마트 컨트랙트는 배포 후 코드가 변하지 않는다. 그런데 버그를 고치거나 기능을 추가해야 할 때가 반드시 온다.

**해결책 — 코드와 데이터를 분리한다:**

```
프록시 컨트랙트 (A) ── 주소 고정, 데이터(storage) 보관
   └─ delegatecall → 로직 컨트랙트 (B) ── 실행 코드만 제공

사용자는 항상 A 주소로 호출
  → A가 B의 코드를 delegatecall로 실행
  → 실행 결과(데이터)는 A의 storage에 기록
  → B를 새 버전 B'으로 교체해도 A의 데이터는 그대로
```

**업그레이드 = 프록시(A)가 가리키는 로직(B)의 주소만 바꾼다:**

```
업그레이드 전: A → delegatecall → B (v1)
업그레이드 후: A → delegatecall → B' (v2)  ← A 주소는 안 바뀜
```

사용자는 항상 같은 A 주소를 사용한다. 내부에서 어떤 코드가 실행되는지만 바뀐다.

---

#### delegatecall이 만드는 세 가지 파생 문제와 해법

**① constructor를 못 쓴다 → initialize() 사용**

```solidity
// constructor는 배포 시 B의 context에서 실행된다
// B의 storage가 세팅된다 → A의 storage는 그대로
constructor() {
    owner = msg.sender;  // B의 슬롯 0에 기록 → A의 슬롯 0에는 아무 것도 안 됨
}

// initialize는 A가 B를 delegatecall로 호출한다
// A의 storage가 세팅된다 → 올바른 방식
function initialize(address admin) public initializer {
    owner = admin;  // A의 슬롯 0에 기록 ✅
}
```

KyoboNFT의 `function initialize(address admin) public initializer {...}`가 바로 이 이유다.

**② storage 슬롯 충돌 → ERC-1967 고정 슬롯**

```
프록시가 슬롯 0에 "로직 컨트랙트 주소"를 보관한다고 하자.
로직 컨트랙트는 슬롯 0을 uint256 totalSupply로 쓴다.
delegatecall로 로직을 실행하면 슬롯 0에 totalSupply를 쓴다.
→ 프록시의 "로직 주소"가 totalSupply 숫자로 덮어써진다.
→ 프록시 파괴.
```

ERC-1967은 프록시 전용 변수를 keccak256 해시 기반 슬롯에 고정해 이 충돌을 원천 차단한다. KyoboNFT가 `is UUPSUpgradeable`을 상속하면 OZ가 이 슬롯 관리를 전담한다.

**③ 로직 컨트랙트 직접 실행 위험 → `_disableInitializers()`**

배포된 로직 컨트랙트(B)는 주소가 있고, 직접 호출이 가능하다. 만약 누군가 B를 직접 호출해 `initialize(공격자주소)`를 실행하면, B의 storage를 공격자가 장악한다. B는 데이터를 보관하지 않으니 직접적인 피해는 없지만, 이를 발판으로 업그레이드 권한을 탈취할 가능성이 있다.

```solidity
// KyoboNFT constructor
constructor() {
    _disableInitializers();  // 로직 컨트랙트 직접 초기화 차단
}
```

`_disableInitializers()`는 OZ가 제공하는 방어 패턴이다. 로직 컨트랙트가 직접 초기화되는 것을 막는다.

---

### 6. delegatecall의 위험 — Parity 사건

2017년 11월, Parity 멀티시그 지갑 라이브러리가 파괴되며 513,774 ETH가 영구 동결됐다.

```
지갑 컨트랙트들 (여러 개, 각자 데이터 보관)
   └─ delegatecall → WalletLibrary (로직 공유)
```

WalletLibrary의 `initWallet()`에 "한 번만 호출 가능" 제한이 없었다. 한 사용자가 WalletLibrary를 직접 호출해 자신을 owner로 등록한 뒤 `kill()`(selfdestruct)을 실행했다.

**결과:** WalletLibrary가 사라지자 모든 지갑의 delegatecall 대상이 없어졌다. 지갑들은 응답 불능 상태로 ETH를 영구 보관하게 됐다. 코드 한 줄 실수가 $600M을 동결시켰다.

**KyoboNFT에서 이것을 어떻게 막나:**
- `constructor()`의 `_disableInitializers()` → 로직 컨트랙트 직접 초기화 차단
- `_authorizeUpgrade()`의 `onlyRole(UPGRADER_ROLE)` → 업그레이드 권한 잠금
- OZ UUPSUpgradeable 검증된 라이브러리 → 직접 delegatecall 코드 작성 불필요

---

### 7. 실무 결론 — 언제 뭘 쓰나

| | 언제 | 주의 |
|---|---|---|
| `call` | 독립 컨트랙트 기능 호출, ETH 전송 | 재진입 공격 (M8에서 다룸) |
| `delegatecall` | 거의 직접 안 씀. 프록시 패턴 내부만 | storage 충돌, selfdestruct 위험 |
| `msg.sender` | 권한 체크 항상 이걸로 | — |
| `tx.origin` | 쓰지 않는다 | 권한 도용 취약점 |

손으로 delegatecall을 직접 쓸 일은 없다. UUPS 프록시를 상속하면 OZ가 내부에서 처리한다.

**지금 당장 기억해야 할 한 가지:**

> delegatecall = 코드만 빌려와 내 집에서 실행.  
> 그래서 "코드(로직 컨트랙트)는 갈아치워도 데이터(프록시 storage)는 안 날아간다" = 업그레이드.  
> 이 한 문장이 M7의 UUPS, initialize(), storage 충돌, _authorizeUpgrade를 전부 설명한다.

---

## 실습 (10분)

### 실습 목표
delegatecall에서 msg.sender와 storage가 어떻게 동작하는지 직접 확인한다.

### 코드

Remix에 두 파일을 작성한다.

**Logic.sol**
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Logic {
    uint256 public value;   // 슬롯 0
    address public sender;  // 슬롯 1

    function setValue(uint256 _value) public {
        value  = _value;
        sender = msg.sender;
    }
}
```

**Proxy.sol**
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Proxy {
    uint256 public value;   // 슬롯 0 (Logic과 동일 배치)
    address public sender;  // 슬롯 1

    address public logicAddr;

    constructor(address _logic) {
        logicAddr = _logic;
    }

    function forward(uint256 _value) public {
        (bool ok, ) = logicAddr.delegatecall(
            abi.encodeWithSignature("setValue(uint256)", _value)
        );
        require(ok, "delegatecall failed");
    }
}
```

### 확인 순서

1. Logic 배포 → 주소 복사
2. Proxy(Logic주소) 배포
3. Proxy의 `forward(42)` 호출
4. **Proxy의 `value`** 확인 → 42 (Logic이 아닌 Proxy의 storage에 기록됨)
5. **Proxy의 `sender`** 확인 → 호출한 내 지갑 주소 (msg.sender가 Proxy로 바뀌지 않음)
6. **Logic의 `value`** 확인 → 0 (Logic storage는 전혀 건드리지 않음)

### 핵심 질문

> Q. 왜 Logic의 value는 0인가?  
> A. delegatecall은 Logic의 코드를 실행하지만, storage는 Proxy의 것을 쓴다. Logic 자신의 storage는 전혀 건드리지 않는다.

> Q. sender가 Proxy 주소가 아닌 내 지갑 주소인 이유는?  
> A. delegatecall은 msg.sender를 바꾸지 않는다. Proxy를 부른 사람이 내 지갑이므로, Logic 코드 안에서도 msg.sender = 내 지갑.

---

## 다음 세션 연결

M7 S40에서 KyoboNFT.sol 전체를 읽는다.

```solidity
contract KyoboNFT is
    Initializable,
    ERC1155Upgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable          // ← delegatecall 기반 업그레이드
{
    constructor() {
        _disableInitializers();  // ← 오늘 배운 이유
    }

    function initialize(address admin) public initializer {
        // ← constructor 대신 이걸 쓰는 이유
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {
        // ← 업그레이드 권한 잠금
    }
}
```

오늘 배운 delegatecall → UUPS 원리가 이 코드 전체를 관통한다.
