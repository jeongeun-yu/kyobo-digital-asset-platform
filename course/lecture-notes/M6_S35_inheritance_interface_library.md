# M6 S35 — 상속·인터페이스·라이브러리

> 모듈 6 · 세션 35 · 1시간  
> 강의 50분 + 실습 10분  
> 실습 환경: [Remix IDE](https://remix.ethereum.org)  
> 강사 배경 깊이: 120분 (50분 수업을 자신있게 소화하기 위한 준비)

---

## 강의 파트 (50분)

### 1. 상속 — `is` 키워드와 `virtual` / `override`

Solidity는 컨트랙트 상속을 지원한다. 부모 컨트랙트의 상태변수·함수·modifier·이벤트가 자식 컨트랙트에 포함된다.

```solidity
contract Base {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    function greet() public virtual returns (string memory) {
        return "Hello from Base";
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }
}

contract Child is Base {
    // Base의 owner, constructor, onlyOwner modifier 모두 자동 포함

    function greet() public override returns (string memory) {
        return "Hello from Child";
    }

    function adminAction() public onlyOwner {
        // 부모의 modifier 사용
    }
}
```

**핵심 규칙:**
- 부모 함수에 `virtual` 없으면 자식이 `override` 불가 → 컴파일 오류
- 자식에서 부모 함수를 명시적으로 호출: `super.greet()`
- 생성자 인자가 있는 부모: `constructor() Base(arg) {}` 형태로 전달

**super 활용:**

```solidity
contract Child is Base {
    function greet() public override returns (string memory) {
        string memory parentMsg = super.greet();   // "Hello from Base"
        return string.concat(parentMsg, " + Child");
    }
}
```

OpenZeppelin 컨트랙트에서 `super._beforeTokenTransfer(...)` 패턴이 이것이다. 부모 로직을 먼저 실행한 뒤 자식 로직을 추가한다.

---

### 2. 다중 상속 — MRO(Method Resolution Order)

Solidity는 다중 상속을 지원하고 C3 선형화(MRO)로 Diamond 문제를 해결한다.

```solidity
contract A {
    function who() public virtual returns (string memory) { return "A"; }
}
contract B is A {
    function who() public virtual override returns (string memory) { return "B"; }
}
contract C is A {
    function who() public virtual override returns (string memory) { return "C"; }
}

// 다중 상속: is 목록에서 오른쪽 → 왼쪽 순으로 MRO 적용
contract D is B, C {
    // override(B, C): 두 부모 모두 나열해야 컴파일 가능
    function who() public override(B, C) returns (string memory) {
        return super.who();  // C.who() 호출됨 (가장 오른쪽)
    }
}
```

**KyoboNFT 다중 상속 구조:**

```solidity
contract KyoboNFT is
    ERC1155Upgradeable,          // NFT 표준 구현
    AccessControlUpgradeable,    // 역할 기반 접근 제어
    UUPSUpgradeable              // 업그레이드 패턴
{
    // 세 컨트랙트의 함수가 모두 포함됨
    // 충돌하는 함수는 override로 명시적으로 해결
}
```

이 구조를 M7에서 직접 작성한다. 오늘 다중 상속을 이해하는 것이 전제다.

---

### 3. 추상 컨트랙트 — `abstract`

인터페이스와 일반 컨트랙트의 중간 형태다. 구현된 함수와 미구현 함수를 함께 가질 수 있다.

```solidity
abstract contract BaseToken {
    string public name;
    uint256 public totalSupply;

    constructor(string memory _name) {
        name = _name;
    }

    // 구현 없는 함수 → 자식이 반드시 구현해야 함
    function _mint(address to, uint256 amount) internal virtual;

    // 구현된 함수 → 자식이 그대로 사용 가능
    function decimals() public pure virtual returns (uint8) {
        return 18;
    }
}

contract KyoboToken is BaseToken {
    mapping(address => uint256) private _balances;

    constructor() BaseToken("KyoboToken") {}

    function _mint(address to, uint256 amount) internal override {
        _balances[to] += amount;
        totalSupply += amount;
    }
}
```

`abstract` 컨트랙트는 직접 배포 불가. 반드시 상속해서 미구현 함수를 채워야 배포 가능하다. OpenZeppelin의 `ERC1155.sol` 자체가 abstract다.

---

### 4. 인터페이스 — `interface`

인터페이스는 **구현 없이 함수 시그니처와 이벤트만** 선언한다. ERC 표준이 이 방식으로 정의된다.

```solidity
interface IERC20 {
    // 함수: 구현 없음, 모두 external
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    // 이벤트 선언 가능
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}
```

**인터페이스 구현:**

```solidity
contract MyToken is IERC20 {
    mapping(address => uint256) private _bal;
    uint256 private _total;

    function totalSupply() external view override returns (uint256) { return _total; }
    function balanceOf(address a) external view override returns (uint256) { return _bal[a]; }
    function transfer(address to, uint256 amt) external override returns (bool) {
        require(_bal[msg.sender] >= amt, "Insufficient");
        _bal[msg.sender] -= amt;
        _bal[to] += amt;
        emit Transfer(msg.sender, to, amt);
        return true;
    }
    // ... 나머지 함수 구현
}
```

**인터페이스 vs 추상컨트랙트:**

| | `interface` | `abstract contract` |
|---|---|---|
| 상태변수 | 불가 | 가능 |
| 구현된 함수 | 불가 | 가능 |
| constructor | 불가 | 가능 |
| modifier | 불가 | 가능 |
| 용도 | 표준 ABI 정의 | 부분 구현 + 확장 |

**외부 컨트랙트 호출 — 인터페이스 활용:**

```solidity
// 배포된 ERC-20 주소만 있으면 호출 가능
IERC20 token = IERC20(0xAbCd...);
uint256 bal = token.balanceOf(msg.sender);   // 잔액 조회
token.transfer(recipient, 100);              // 전송
```

이것이 VASP가 KyoboNFT를 호출하는 방식이다. VASP는 KyoboNFT 소스코드를 몰라도 된다. `IKyoboNFT` 인터페이스(함수 시그니처 + 이벤트)만 있으면 ABI를 생성해서 호출할 수 있다.

---

### 5. 라이브러리 — `library`

라이브러리는 상태를 갖지 않는 재사용 가능한 함수 집합이다.

```solidity
library Strings {
    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }
}
```

**`using A for B` — 타입에 라이브러리 함수 붙이기:**

```solidity
import "@openzeppelin/contracts/utils/Strings.sol";

contract TokenURI {
    using Strings for uint256;   // uint256 타입에 Strings 함수 붙이기

    function uri(uint256 tokenId) public pure returns (string memory) {
        return string.concat(
            "https://api.kyobo.com/nft/",
            tokenId.toString()   // Strings.toString(tokenId)와 동일
        );
    }
}
```

KyoboNFT에서 `using Strings for uint256`을 쓰는 이유가 이것이다. tokenId(숫자)를 URI 문자열에 삽입하기 위해.

**internal vs external 라이브러리:**

```
internal 함수만 있는 라이브러리
  → 컴파일 시 컨트랙트 바이트코드에 인라인 삽입
  → 별도 배포 불필요 (대부분의 OZ 라이브러리)

external 함수 있는 라이브러리
  → 별도 배포 후 링크 필요 (--libraries 옵션)
  → 여러 컨트랙트가 같은 라이브러리 배포본을 공유
```

실습에서 쓰는 라이브러리는 모두 `internal` 함수만 사용한다.

---

### 6. receive() / fallback() — ETH 수신 처리

컨트랙트가 ETH를 직접 받을 때 실행되는 특수 함수다.

```solidity
contract Vault {
    event Received(address sender, uint256 amount);

    // 순수 ETH 전송 (data 없음) 시 실행
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    // ABI에 없는 함수 호출 or receive 없을 때 실행
    fallback() external payable {
        revert("Unknown function");
    }

    function withdraw(uint256 amt) public {
        payable(msg.sender).transfer(amt);
    }
}
```

KyoboNFT는 ETH를 직접 수신하지 않으므로 이 함수들이 없다. 하지만 Gnosis Safe(M9)가 ETH를 보관하므로 그때 다시 등장한다.

---

### 7. Phase 1 연결 — OpenZeppelin은 이 세 가지의 조합

```
KyoboNFT.sol
  is ERC1155Upgradeable          ← 상속 (abstract 구현 상속)
  is AccessControlUpgradeable    ← 상속 (다중 상속)
  is UUPSUpgradeable             ← 상속 (다중 상속)

IKyoboNFT.sol                    ← 인터페이스 (VASP가 이것만 보고 호출)

using Strings for uint256        ← 라이브러리 (tokenId → URI 변환)
```

**흐름 정리:**

```
VASP 서버
  → IKyoboNFT(address) 로 컨트랙트 로드 (인터페이스)
    → mint(to, tokenId, amount) 호출
      → ERC1155Upgradeable._mint() 실행 (상속받은 함수)
      → uri(tokenId) = "https://.../"+tokenId.toString() (라이브러리)
      → emit NFTIssued(to, tokenId, amount)
```

M7에서 직접 이 구조를 구현한다. 오늘 배운 세 개념이 전부 등장한다.

---

## 실습 파트 (10분)

### 실습 1 — 상속 + 인터페이스 최소 확인

Remix에서 파일 2개 작성:

**`ISimpleToken.sol`:**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISimpleToken {
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 amt) external returns (bool);
    event Transfer(address indexed from, address indexed to, uint256 amt);
}
```

**`SimpleToken.sol`:**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./ISimpleToken.sol";

contract BaseOwnable {
    address public owner;
    constructor() { owner = msg.sender; }
    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
}

contract SimpleToken is BaseOwnable, ISimpleToken {
    mapping(address => uint256) private _bal;

    function mint(address to, uint256 amt) public onlyOwner {
        _bal[to] += amt;
    }

    function balanceOf(address who) external view override returns (uint256) {
        return _bal[who];
    }

    function transfer(address to, uint256 amt) external override returns (bool) {
        require(_bal[msg.sender] >= amt, "Insufficient");
        _bal[msg.sender] -= amt;
        _bal[to] += amt;
        emit Transfer(msg.sender, to, amt);
        return true;
    }
}
```

**확인 (5분):**

```
① mint(Account2, 500) → 정상
② balanceOf(Account2) → 500
③ Account2로 전환 → transfer(Account3, 200) → Transfer 이벤트 확인
④ 배포 주소 복사 → At Address에 붙여넣기, 컨트랙트 타입 ISimpleToken으로 변경
   → balanceOf/transfer만 보임 (mint 없음) ← 인터페이스 ABI 제한 확인
```

---

### 실습 2 — 다이아몬드 상속 super 호출 순서 추적

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract A {
    event Log(string msg);

    function ping() public virtual {
        emit Log("A.ping");
    }
}

contract B is A {
    function ping() public virtual override {
        emit Log("B.ping - before super");
        super.ping();
        emit Log("B.ping - after super");
    }
}

contract C is A {
    function ping() public virtual override {
        emit Log("C.ping - before super");
        super.ping();
        emit Log("C.ping - after super");
    }
}

// MRO: D → C → B → A (is B, C 에서 오른쪽이 우선)
contract D is B, C {
    function ping() public override(B, C) {
        emit Log("D.ping - before super");
        super.ping();   // C.ping() 호출 → C 안에서 super.ping() → B.ping() → B 안에서 super.ping() → A.ping()
        emit Log("D.ping - after super");
    }
}
```

**확인:**
- D.ping() 호출 후 Logs 탭 열기
- 출력 순서: D → C → B → A → B(after) → C(after) → D(after)
- A.ping()은 단 한 번만 실행됨 → C3 MRO가 중복 호출을 막는다는 것 확인

---

### 실습 3 — interface로 배포된 컨트랙트에 연결

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// SimpleToken이 이미 배포되어 있다고 가정
interface ISimpleToken {
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 amt) external returns (bool);
}

contract TokenReader {
    ISimpleToken public token;

    constructor(address tokenAddress) {
        token = ISimpleToken(tokenAddress);
    }

    function readBalance(address who) public view returns (uint256) {
        return token.balanceOf(who);   // CALL opcode 발생
    }
}
```

**확인:**
- SimpleToken 배포 주소를 TokenReader 생성자에 전달
- TokenReader.readBalance(Account2) → 300 (이전 실습에서 남은 잔액)
- TokenReader는 SimpleToken 소스코드를 전혀 import하지 않음

---

## 완료 기준

- [ ] `virtual` / `override` 없이 함수 재정의 → 컴파일 오류 직접 확인
- [ ] `super.함수명()` 호출 시 부모 함수 실행 확인
- [ ] 다중 상속 `override(B, C)` 문법 이해
- [ ] `interface` vs `abstract contract` 차이 설명 가능
- [ ] 인터페이스 타입으로 컨트랙트 로드 → ABI 범위 제한 확인
- [ ] `using Strings for uint256` → `tokenId.toString()` 작동 원리 설명 가능
- [ ] "KyoboNFT가 ERC1155·AccessControl·UUPS를 동시에 상속하는 이유" 설명 가능
- [ ] 다이아몬드 상속에서 super 호출 순서 (D→C→B→A) 설명 가능

---

## 강사 노트

**반드시 짚을 것:**  
`interface`가 VASP 연동에서 하는 역할 — VASP는 KyoboNFT 소스 코드를 몰라도 된다. ABI만 있으면 호출 가능하다. 이것이 Phase 1에서 VASP 어댑터가 컨트랙트를 호출하는 방식이다.

**다중 상속 override 오류:**  
`override(B, C)` 괄호 안에 부모 컨트랙트를 모두 나열하지 않으면 컴파일 오류. Remix 에러 메시지가 명확하므로 에러를 보여주고 직접 수정하게 할 것.

**라이브러리 import 경로:**  
Remix에서 같은 폴더 파일은 `"./파일명.sol"` 상대 경로. 경로 오류가 가장 흔한 실수. Remix 파일 탐색기에서 실제 경로 확인 후 입력하게 할 것.

**S36 예고:**  
다음 시간에 OpenZeppelin 패키지를 직접 import해서 `Ownable`, `Pausable`, `AccessControl`을 쓴다. 오늘 만든 `BaseOwnable`이 OpenZeppelin `Ownable`로 교체되는 과정을 보여준다.

---

## [강사 배경] — 120분 깊이 (수업 전 숙지용)

> 이 섹션은 수업에서 직접 가르치지 않는다. 강사가 질문에 막히지 않기 위한 배경 지식이다.

---

### B1. 상속의 컴파일 타임 복사 — gas 관점

**핵심 사실:** Solidity 상속은 런타임 delegation이 아닌 **컴파일 타임 코드 복사**다.

Java/Python에서 상속은 런타임에 부모 클래스를 참조하는 구조다. 하지만 Solidity에서는 컴파일러가 부모 컨트랙트의 바이트코드를 자식 컨트랙트 바이트코드 안에 직접 삽입한다.

```
[컴파일 전]
Child is Base
  Base: greet(), modifier onlyOwner

[컴파일 후 — 하나의 바이트코드]
Child 바이트코드 = Base의 greet + modifier + Child의 greet(override)
                  모두 하나의 배포 파일에 포함됨
```

**gas 관점 함의:**
- 상속을 많이 써도 외부 CALL opcode가 발생하지 않음 → 부모 함수 호출 gas가 저렴
- 단, 바이트코드 크기 증가 → 배포 gas 증가 (24KB 한도 주의)
- OpenZeppelin 컨트랙트를 여러 개 상속하면 배포 비용이 커지는 이유가 이것

**런타임 delegation과 다른 것:**
- 프록시 패턴(UUPS, Transparent)에서 `fallback() → delegatecall(implementation)`은 런타임에 다른 컨트랙트를 참조 → 이것은 상속이 아니라 delegatecall 패턴
- KyoboNFT의 UUPSUpgradeable 상속은 업그레이드 로직(authorization)을 컴파일 타임에 포함하는 것 / 실제 구현 위임(delegatecall)은 별개

---

### B2. virtual / override 키워드가 0.6.0부터 필수가 된 이유

**0.5.x까지의 문제:**
```solidity
// 0.5.x — 명시적 표시 없음
contract Base {
    function foo() public returns (uint) { return 1; }
}
contract Child is Base {
    function foo() public returns (uint) { return 2; }  // 암묵적 override — 실수인지 의도인지 불명
}
```

이 코드에서 Child.foo()가 Base.foo()를 override하는 것이 의도인지, 아니면 같은 이름으로 실수로 만든 다른 함수인지 컴파일러가 판단할 수 없었다.

**0.6.0 이후 해결책:**
```solidity
// 0.6.0+ — 명시적 표시 필수
contract Base {
    function foo() public virtual returns (uint) { return 1; }  // "나는 override 가능"
}
contract Child is Base {
    function foo() public override returns (uint) { return 2; }  // "나는 의도적으로 override"
}
```

- `virtual` 없는 함수 → override 시도하면 컴파일 오류
- `override` 없이 같은 이름 함수 정의 → 컴파일 오류
- 덕분에 "실수로 부모 함수를 덮어쓰는" 버그 클래스가 사라짐

**실제 OpenZeppelin 패턴:**
```solidity
// OZ ERC20.sol
function transfer(address to, uint256 amount) public virtual override returns (bool) {
    // virtual: 자식이 다시 override 가능
    // override: IERC20.transfer를 구현
}
```

---

### B3. super 키워드와 MRO — C3 선형화 알고리즘

**super의 정확한 동작:**
`super.foo()`는 "부모 컨트랙트"가 아니라 **MRO 체인에서 자신 다음에 오는 컨트랙트**의 함수를 호출한다.

**C3 선형화 알고리즘:**
Solidity는 Python과 동일한 C3 선형화 알고리즘으로 MRO를 결정한다.

`contract D is B, C`에서:
1. `is` 목록을 오른쪽 → 왼쪽으로 읽음 (C가 B보다 우선)
2. C3 알고리즘 적용: D → C → B → A

```
contract A { function foo() virtual }
contract B is A { function foo() virtual override }
contract C is A { function foo() virtual override }
contract D is B, C { function foo() override(B, C) { super.foo() } }

MRO: D → C → B → A

super.foo()를 D에서 호출하면:
  1. D.super → C.foo() 실행
  2. C 안의 super.foo() → B.foo() 실행
  3. B 안의 super.foo() → A.foo() 실행
  4. A는 최상위이므로 종료

A.foo()는 단 한 번만 실행됨 ← 다이아몬드 문제 해결
```

**KyoboNFT MRO 실제 예시:**
```solidity
contract KyoboNFT is
    ERC1155Upgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
```
MRO (오른쪽이 우선, 그 다음 왼쪽):
```
KyoboNFT → UUPSUpgradeable → PausableUpgradeable
          → AccessControlUpgradeable → ERC1155Upgradeable
          → Initializable (공통 조상)
```

`_beforeTokenTransfer`를 KyoboNFT에서 `super._beforeTokenTransfer()` 호출하면 이 체인이 순서대로 실행된다.

---

### B4. 다이아몬드 상속 문제와 Solidity의 해결

**문제 정의:**

```
    A
   / \
  B   C
   \ /
    D
```

C++에서는 D가 A의 함수를 두 개(B경유, C경유) 갖게 된다. 어느 것을 호출해야 하는가?

**Solidity의 해결 — 강제된 super 체인:**

잘못된 패턴 (실제 함정):
```solidity
// 실수: super 없이 A를 직접 호출
contract B is A {
    function foo() public virtual override {
        A.foo();  // A.foo() 직접 호출 — MRO 체인을 끊는다
        // C.foo()는 절대 호출되지 않음
    }
}
```

올바른 패턴:
```solidity
// 정확: super를 통해 MRO 체인 유지
contract B is A {
    function foo() public virtual override {
        super.foo();  // MRO 다음 컨트랙트(C)로 위임 → C → A 순서로 체인 유지
    }
}
```

**OpenZeppelin이 `__Contract__init()` 패턴을 쓰는 이유:**

업그레이드 가능한 컨트랙트에서 constructor 대신 `initialize()`를 쓰는데, 다중 상속 시 `__ERC1155_init()`이 두 번 호출되는 것을 방지하기 위해 `__{Contract}__init_unchained()` 패턴을 쓴다.

```solidity
// OZ 내부 패턴
function __ERC1155_init(string memory uri_) internal onlyInitializing {
    __ERC1155_init_unchained(uri_);  // 실제 초기화
}

function __ERC1155_init_unchained(string memory uri_) internal onlyInitializing {
    // 실제 상태변수 설정 — 한 번만 실행 보장
    _setURI(uri_);
}
```

`onlyInitializing` modifier가 중복 실행을 막는다. MRO 체인을 통해 `__ERC1155_init`이 두 번 호출되더라도 두 번째는 revert된다.

---

### B5. abstract contract vs interface 완전 비교

**언제 interface를 쓰는가:**

1. **ERC 표준 정의** — 구현은 자유, 규약(함수 시그니처)만 강제
2. **외부 컨트랙트 호출** — 상대 컨트랙트 전체를 import하면 배포 크기가 커짐

```solidity
// 나쁜 방법: 전체 컨트랙트 import
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
// ERC20.sol 전체 바이트코드가 내 컨트랙트 배포 크기에 영향을 미침

// 좋은 방법: interface만 import
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
// ABI 정의만 가져옴 — 배포 크기 증가 없음
```

**왜 interface가 gas에 유리한가:**
- interface는 ABI(함수 시그니처)만 정의 — 바이트코드 없음
- 배포 크기 = 바이트코드 크기 → interface는 0 기여
- 외부 컨트랙트 실제 코드는 이미 그 컨트랙트 주소에 배포되어 있음
- 호출 시 CALL opcode로 해당 주소를 참조 → 내 컨트랙트 크기와 무관

**interface로 호출 시 실제 동작 (EVM 레벨):**
```
token.balanceOf(msg.sender)
  ↓ 컴파일러가 ABI 인코딩
  ↓ 함수 선택자 = keccak256("balanceOf(address)")[0:4]
  ↓ CALL opcode: to=token주소, data=selector+인코딩된 인자
  ↓ 상대 컨트랙트에서 실행 → 반환값 디코딩
```

interface가 있으면 컴파일러가 선택자와 인코딩을 자동 생성한다.

**abstract contract를 쓰는 경우:**
- 여러 자식이 공통으로 쓸 로직이 있을 때
- 상태변수를 공유해야 할 때
- modifier를 공유해야 할 때
- 예: OZ의 `ERC20.sol` — `_transfer`, `_mint` 등 구현 + `transfer`, `transferFrom` 등 구현

---

### B6. Library 내부 동작 심층

**internal library — 컴파일 타임 인라이닝:**

```solidity
library SafeMath {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 c = a + b;
        require(c >= a, "SafeMath: addition overflow");
        return c;
    }
}
```

`internal` 함수만 있는 라이브러리는 별도 배포 없음. 컴파일러가 `SafeMath.add(x, y)` 호출을 실제 함수 바이트코드로 직접 치환한다. 결과적으로 라이브러리 코드가 호출하는 컨트랙트 바이트코드 안에 삽입된다.

**external library — 별도 배포 후 DELEGATECALL:**

```solidity
library BigMath {
    function complexCalc(uint256[] memory data) external pure returns (uint256) {
        // 복잡한 계산 — external 선언
    }
}
```

- `external` 함수가 하나라도 있으면 라이브러리를 별도 주소에 배포해야 함
- 컨트랙트 배포 시 `--libraries BigMath:0x1234...` 옵션으로 라이브러리 주소 링크
- 런타임 호출: `DELEGATECALL` to 라이브러리 주소 (msg.sender, storage는 호출 컨트랙트 기준)
- 실무에서는 internal library가 압도적으로 많음 (external library는 의존성 관리가 복잡)

**SafeMath가 0.8.0 이후 불필요해진 이유:**

```solidity
// 0.7.x 이하 — overflow 감지 없음, SafeMath 필요
uint256 x = type(uint256).max;
uint256 y = x + 1;  // 조용히 wrap-around → 0이 됨

// 0.8.0 이후 — 컴파일러가 자동으로 overflow 체크 삽입
uint256 y = x + 1;  // 런타임에 revert 발생
```

0.8.0부터 모든 산술 연산에 컴파일러가 자동으로 overflow/underflow 체크를 삽입한다. SafeMath가 하던 일을 컴파일러가 대신하므로 라이브러리가 불필요해졌다. gas를 아끼려면 `unchecked { }` 블록 안에서 연산할 수 있지만 직접 overflow를 책임져야 한다.

```solidity
// 0.8.0+ 에서 gas 최적화가 필요할 때
function increment(uint256 i) public pure returns (uint256) {
    unchecked {
        return i + 1;  // overflow 체크 생략 → gas 절약. 단, i가 max이면 wrap-around
    }
}
```

---

### B7. receive() vs fallback() 완전 이해

**판단 트리:**

```
ETH 전송 도착
    │
    ├─ calldata 비어있음?
    │       YES → receive() 존재? → YES → receive() 실행
    │                               NO  → fallback() 존재? → YES → fallback() 실행
    │                                                          NO  → revert
    │
    └─ calldata 있음?
            → fallback() 존재? → YES → fallback() 실행
                                  NO  → revert
```

```solidity
contract ETHRouter {
    event Received(address sender, uint256 amount, bytes data);

    receive() external payable {
        // msg.data가 없을 때 (단순 ETH 전송)
        emit Received(msg.sender, msg.value, "");
    }

    fallback() external payable {
        // msg.data가 있거나, 매칭되는 함수 선택자가 없을 때
        emit Received(msg.sender, msg.value, msg.data);
    }
}
```

**gas 제한 — transfer/send의 2300 gas 함정:**

```solidity
// 위험: transfer/send → 2300 gas만 전달
payable(recipient).transfer(1 ether);
// receive() 내에서 emit Log 하나만 해도 2300 gas 부족으로 실패할 수 있음

// 안전: call → 남은 gas 전체 전달
(bool success, ) = payable(recipient).call{value: 1 ether}("");
require(success, "Transfer failed");
```

2300 gas는 간단한 이벤트 emit도 부족한 경우가 있다. Consensys 등 보안 지침은 `call`을 권장한다. 단, reentrancy guard와 함께 써야 한다.

**프록시 패턴에서 fallback()의 역할:**

```solidity
// EIP-1967 프록시 패턴 핵심
contract ERC1967Proxy {
    address private _implementation;

    fallback() external payable {
        address impl = _implementation;
        assembly {
            // 모든 calldata를 implementation 주소로 DELEGATECALL
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
```

프록시 컨트랙트는 자신이 알지 못하는 모든 함수 호출을 `fallback()`으로 받아 implementation 주소로 DELEGATECALL한다. KyoboNFT의 UUPS 패턴도 이 원리를 사용한다.

---

### B8. interface 실전 패턴 — IERC20·IERC721·IERC1155

**왜 표준 interface가 존재하는가:**

ERC-20이 없었을 때(2015~2017년 초): 각 토큰이 제각각 함수명을 사용했다.
```
TokenA.getBalance(address)
TokenB.balanceOf(address, bool)
TokenC.myBalance()
```
거래소·지갑이 새 토큰마다 개별 연동 코드를 써야 했다.

ERC-20 표준 이후: `IERC20.balanceOf(address)`라는 공통 규약 → 한 번 연동하면 모든 ERC-20 토큰에 작동.

**At Address로 interface만으로 붙는 방법 (Remix):**

```
1. ISimpleToken.sol 컴파일 (interface 파일)
2. Deploy & Run Transactions 패널
3. "At Address" 필드에 이미 배포된 SimpleToken 주소 입력
4. 컨트랙트 드롭다운에서 ISimpleToken 선택
5. At Address 클릭
→ ISimpleToken의 함수(balanceOf, transfer)만 UI에 나타남
→ SimpleToken의 mint 같은 추가 함수는 보이지 않음
```

**반환값 없는 함수를 interface로 호출할 때 주의:**

```solidity
interface IToken {
    function transfer(address to, uint256 amt) external returns (bool);
}

// 일부 오래된 ERC-20 구현은 반환값이 없음
// USDT(Tether) 초기 버전: function transfer(address to, uint256 amt) external; // bool 없음
```

이런 경우 interface 호출 시 ABI 디코딩 불일치로 revert 발생. 해결책:
```solidity
// SafeERC20 (OZ) — low-level call로 반환값 없는 경우도 처리
SafeERC20.safeTransfer(token, to, amount);
```

**interface 함수 호출 시 실제 동작 (CALL opcode):**

```solidity
IERC20 token = IERC20(0xAbCd...);
uint256 bal = token.balanceOf(msg.sender);
```

EVM 레벨:
```
PUSH4 0x70a08231          // balanceOf(address) 선택자
PUSH20 0xAbCd...          // 토큰 주소
PUSH20 msg.sender          // 인자
// ABI 인코딩 후
CALL to=0xAbCd..., data=0x70a08231+인코딩된주소
// 반환값 디코딩 → uint256
```

interface가 있으면 이 과정을 컴파일러가 자동으로 처리한다. 없으면 assembly로 직접 작성해야 한다.

---

### B9. KyoboNFT 다중 상속 MRO 실제 추적

```solidity
contract KyoboNFT is
    ERC1155Upgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
```

**is 목록 해석:**
- Solidity: `is A, B, C, D` → MRO는 오른쪽이 높은 우선순위
- 결과 MRO: KyoboNFT → UUPSUpgradeable → PausableUpgradeable → AccessControlUpgradeable → ERC1155Upgradeable → Initializable

**`_beforeTokenTransfer` 체인 예시:**

```solidity
// KyoboNFT 내부
function _beforeTokenTransfer(...) internal override(ERC1155Upgradeable, PausableUpgradeable) {
    super._beforeTokenTransfer(...);
    // 실행 순서: KyoboNFT → PausableUpgradeable._beforeTokenTransfer (pause 체크)
    //           → ERC1155Upgradeable._beforeTokenTransfer
}
```

PausableUpgradeable이 pause 상태를 체크하고, 그 다음 ERC1155Upgradeable이 토큰 전송 전처리를 한다. `super`를 빠뜨리면 pause 기능이 작동하지 않는 치명적 버그가 발생한다.

**`override(A, B)` 괄호에 부모를 모두 나열해야 하는 이유:**

Solidity 컴파일러가 "이 함수가 어느 부모의 것을 override하는지" 명시적으로 알아야 한다. 하나라도 빠뜨리면:
```
TypeError: Function needs to specify overridden contracts "ERC1155Upgradeable" and "PausableUpgradeable".
```

---

### B10. 강의 중 예상 질문 대비

**Q: "interface를 implements하는 것과 is를 쓰는 것이 뭐가 다른가요?"**  
A: 동일하다. Solidity에서 interface 구현도 `is` 키워드를 쓴다. Java의 `implements`와 달리 키워드가 하나다. 컴파일러가 interface인지 contract인지 판단해서 다르게 처리한다.

**Q: "super를 안 쓰면 어떻게 되나요?"**  
A: super를 안 쓰면 MRO 체인이 끊긴다. OpenZeppelin에서 `_beforeTokenTransfer`에 `super`를 빠뜨리면 PausableUpgradeable이나 ERC1155Upgradeable의 검증 로직이 실행되지 않는다. 정지(pause) 상태에서도 토큰이 전송되는 보안 취약점이 생긴다.

**Q: "라이브러리를 쓰면 gas가 줄어드나요?"**  
A: internal 라이브러리는 인라이닝되므로 gas 변화 없다. external 라이브러리는 DELEGATECALL 비용이 추가된다. 라이브러리를 쓰는 이유는 gas 절약이 아니라 코드 재사용과 24KB 배포 크기 한도 분산이다.

**Q: "0.8.0 이전 코드를 가져다 쓸 때 SafeMath를 제거해도 되나요?"**  
A: pragma가 ^0.8.0 이상이면 제거해도 된다. 단, `unchecked {}` 블록 안의 코드는 여전히 주의해야 한다. 실제로 OZ 4.x부터 SafeMath import 없이도 동작한다.

**Q: "receive()와 fallback() 둘 다 없으면 ETH 전송이 revert되나요?"**  
A: 그렇다. ETH를 받을 수 없는 컨트랙트가 된다. 단, `selfdestruct(address)`로 강제 전송하면 receive/fallback 없어도 ETH가 쌓인다 (이 경우 컨트랙트가 처리할 수 없는 ETH가 영구 잠김).

**Q: "인터페이스로 호출할 때 상대방이 실제로 그 함수를 구현하지 않으면?"**  
A: 런타임 revert 발생. 컴파일 타임에는 확인 불가. 주소가 EOA(일반 지갑)거나, 다른 함수를 구현한 컨트랙트거나, 잘못된 주소면 모두 revert된다. 실무에서는 ERC-165 `supportsInterface()`로 배포 전 확인한다.
