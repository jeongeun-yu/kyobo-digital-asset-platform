# M6 S34 — 타입·상태변수·함수·이벤트·modifier

> 모듈 6 · 세션 34 · 1시간
> 강의 50분 + 실습 10분
> 실습 환경: [Remix IDE](https://remix.ethereum.org)

---

## [강사 배경] — 강사 숙지용. 수업에서 직접 읽지 않는다

> 이 섹션은 강사가 "왜 이렇게 설계되었는가"를 이해하기 위한 배경지식이다.
> 수업에서는 [강의] 섹션만 전달한다. 학생 질문이 심화로 가면 여기서 답한다.

---

### [강사 배경] 1. 타입 시스템 심층

#### 왜 uint256이 기본값인가: EVM 워드 크기

EVM(Ethereum Virtual Machine)의 기본 연산 단위(워드)는 **256비트(32바이트)**다. CPU가 64비트 워드로 동작하듯, EVM의 모든 스택 슬롯·연산 결과는 256비트다.

따라서 `uint256`은 EVM 네이티브 타입이다. ADD, MUL, DIV 등 모든 EVM 산술 연산은 256비트 피연산자를 그대로 처리한다 — **변환 비용 제로**.

**`uint8`이 오히려 gas를 더 소비하는 이유:**

```
uint8 x = 100;
uint8 y = 200;
uint8 z = x + y;
```

EVM 내부에서 이 연산이 벌어지는 일:
1. `x`(8비트)를 스택에 올릴 때 → 256비트로 zero-padding
2. `y`(8비트)를 스택에 올릴 때 → 256비트로 zero-padding
3. ADD 수행 (256비트끼리)
4. 결과를 `uint8` 범위로 마스킹 (`AND 0xFF`) → 추가 opcode

즉 uint8은 패딩 + 마스킹 opcode가 붙어 uint256보다 더 비싸다.

**예외: storage 패킹**

storage에서는 uint8 여러 개를 같은 32바이트 슬롯에 패킹해 **SLOAD/SSTORE 횟수를 줄인다**. 이 경우는 uint8이 유리하다. 계산 중에는 비싸지만 저장/로드 횟수 절감이 더 크다.

**결론:**
- 루프 카운터, 로컬 계산 변수 → `uint256`
- storage에 여러 개 나란히 저장, 패킹 의도 → `uint8`/`uint128` 등

#### address vs address payable: 왜 분리했나

Solidity 0.4.x에서는 `address` 하나뿐이었고 모든 address에 `.transfer()`, `.send()`가 있었다.

문제: 개발자가 실수로 임의 주소로 ETH를 보내는 코드를 쉽게 작성할 수 있었다.

0.5.0(2018년 11월)에서 **의도 명시 강제**로 분리:
- `address`: 주소 저장, 잔액 조회만 가능
- `address payable`: `.transfer()`, `.send()` 추가로 ETH 전송 가능

캐스팅 방법:
```solidity
address addr = msg.sender;
address payable payableAddr = payable(addr);  // 명시적 캐스팅 필요
payableAddr.transfer(1 ether);
```

OpenZeppelin ERC20의 `withdraw` 패턴:
```solidity
function withdraw(address payable recipient, uint256 amount) external onlyOwner {
    recipient.transfer(amount);  // payable이어야 transfer 가능
}
```

#### bytes1~bytes32 vs bytes: 고정 vs 동적

`bytes1`~`bytes32`: 고정 크기 바이트 배열. 값 타입. storage에서 패킹된다.
```solidity
bytes32 roleHash = keccak256(abi.encodePacked("MINTER_ROLE"));
// bytes32는 스택에서 직접 처리. 매우 저렴.
```

`bytes`: 동적 바이트 배열. 참조 타입. storage에서는 첫 슬롯에 길이+데이터를 저장.
```solidity
bytes memory data = abi.encode(param1, param2);
// 가변 길이. 헤더+길이+데이터 구조. 더 비쌈.
```

#### string vs bytes: string은 UTF-8 bytes 래퍼

`string`은 내부적으로 `bytes`와 동일하게 저장된다. 차이점:
- `bytes`는 인덱싱 가능: `data[0]`으로 바이트 접근
- `string`은 인덱싱 불가: UTF-8 문자는 1~4바이트가 혼재해서 `[0]`이 문자 단위가 안 됨

```solidity
bytes memory b = "hello";
b[0];             // 'h' (0x68) — OK

string memory s = "hello";
// s[0];          // 컴파일 에러
bytes(s)[0];      // 형변환 후 접근 — 바이트 단위임을 인지하고 써야 함
```

실무에서 문자열 길이 비교/처리가 필요하면 `bytes`로 형변환 후 처리한다.

#### mapping의 실제 저장 위치: keccak256 해시 슬롯

mapping은 표준 슬롯 번호가 없다. 키 `k`에 해당하는 값의 storage 슬롯:

```
slot = keccak256(abi.encode(k, mappingSlot))
```

예: `mapping(address => uint256) _balances`가 slot 1에 선언되어 있을 때,
`_balances[0xABCD...]`의 storage 슬롯 = `keccak256(0xABCD... + 0x0000...0001)`

이 슬롯은 2^256개 슬롯 공간에서 랜덤 분산되어 충돌 확률이 사실상 0이다.

**이터레이션이 불가능한 이유:** 어떤 키가 존재하는지 알 방법이 없다. 슬롯을 알아도 대응하는 키를 역추적할 수 없다. 이터레이션이 필요하면 별도 `address[]` 배열에 키를 따로 관리해야 한다.

#### struct 패킹 규칙

EVM은 struct 필드를 선언 순서대로 storage에 배치한다. 각 슬롯은 32바이트. 다음 필드가 현재 슬롯 남은 공간에 들어가면 같은 슬롯에 넣고, 안 들어가면 새 슬롯으로 넘어간다.

```solidity
// 비효율: 슬롯 4개
struct BadPacking {
    uint256 a;   // 슬롯 0 (32바이트, 꽉 참)
    uint128 b;   // 슬롯 1 (16바이트, 남은 16바이트 낭비)
    uint256 c;   // 슬롯 2 (32바이트, 꽉 참) — 슬롯 1 남은 공간 건너뜀
    uint128 d;   // 슬롯 3 (16바이트)
}

// 효율: 슬롯 2개 — 작은 타입을 인접하게
struct GoodPacking {
    uint128 b;   // 슬롯 0 앞 16바이트
    uint128 d;   // 슬롯 0 뒤 16바이트 (패킹!)
    uint256 a;   // 슬롯 1 (32바이트, 꽉 참)
    uint256 c;   // 슬롯 2
}
// GoodPacking은 슬롯 3개. 더 최적화하려면 uint256 두 개 합쳐도 슬롯 절약 안 됨.
```

KyoboNFT `PolicyHolder` struct도 필드 순서가 gas 비용에 영향을 준다.

---

### [강사 배경] 2. 함수 선택자(Function Selector) 완전 이해

#### 함수 선택자란

외부에서 컨트랙트 함수를 호출할 때, EVM은 calldata의 첫 4바이트로 어떤 함수를 실행할지 결정한다. 이 4바이트가 **함수 선택자(Function Selector)**다.

계산 방법:
```
selector = keccak256("functionName(paramType1,paramType2)")[0:4]
```

예시:
```
keccak256("transfer(address,uint256)") = 0xa9059cbb2ab09eb219583f4a59a5d0623ade346d962bcd4e46b11da047c9049b
앞 4바이트 = 0xa9059cbb
```

ethers.js로 계산:
```javascript
import { ethers } from "ethers";

// 방법 1: ethers.id (keccak256의 별칭)
const selector = ethers.id("transfer(address,uint256)").slice(0, 10);
// "0xa9059cbb"

// 방법 2: Interface 사용
const iface = new ethers.Interface(["function transfer(address to, uint256 amount)"]);
const sel = iface.getFunction("transfer").selector;
// "0xa9059cbb"
```

#### 왜 4바이트인가: 트레이드오프

- 4바이트 = 2^32 = 약 42억 가지 값
- 충돌 확률: 두 함수가 같은 선택자를 가질 확률 ≈ 1/4,294,967,296 — 우연 충돌은 무시 가능
- calldata 오버헤드: 4바이트는 비0 바이트 기준 64 gas (4바이트 × 16 gas). 충분히 작음
- 8바이트로 늘리면 충돌 거의 0이지만 calldata 비용 2배. 4바이트로 균형점

#### 선택자 충돌(Selector Clash): 실제 예시

다른 함수 이름인데 선택자가 같은 경우가 실제로 발생한다:

```
keccak256("clash590402()")  → 0x00000000
keccak256("refund()")      → 어떤 값
```

공격자가 의도적으로 선택자가 같은 함수를 만들 수 있다:
```
collide1(uint256) → 0xdeadbeef
attack9999(bytes) → 0xdeadbeef (같은 선택자!)
```

이런 충돌 쌍을 찾는 공격 도구가 실재한다.

**프록시 패턴에서 치명적인 이유:**

```
Proxy 컨트랙트 → delegatecall → Implementation 컨트랙트

Proxy에도 admin(), upgradeTo() 같은 관리 함수가 있음.
Implementation에 같은 선택자를 가진 악의적 함수가 있으면
→ Proxy가 관리 함수를 호출한다고 생각하지만
→ 실제로는 Implementation의 다른 함수가 실행됨
```

OpenZeppelin의 TransparentUpgradeableProxy가 이 문제를 해결하기 위해 admin과 일반 사용자를 분리해서 라우팅한다.

#### receive()와 fallback()이 선택자 없는 이유

`receive()`: calldata가 완전히 비어있을 때(빈 ETH 전송)
`fallback()`: calldata가 있지만 매칭되는 선택자가 없을 때

이 둘은 선택자 매칭 실패 또는 없음의 결과로 실행되므로 선택자 자체가 없다.

```solidity
receive() external payable {
    // 빈 ETH 전송 수신
}

fallback() external payable {
    // 선택자 없음 또는 매칭 실패
    // 프록시 패턴에서 delegatecall 전달에 활용
}
```

---

### [강사 배경] 3. Storage / Memory / Calldata 가스 비용 실측

#### storage 읽기: SLOAD

| 접근 시점 | 비용 | 근거 |
|---|---|---|
| 트랜잭션 내 첫 접근 | 2,100 gas | EIP-2929: cold access |
| 동일 트랜잭션 내 재접근 | 100 gas | EIP-2929: warm access |

EIP-2929 (2021년 Berlin 하드포크 적용): 트랜잭션 시작 시 "접근 목록"을 추적. 처음 읽는 슬롯은 비싸고(cold), 이미 읽은 슬롯은 저렴(warm).

실무 패턴 — 루프 안 storage 변수 캐싱:
```solidity
// 나쁜 패턴: 매 반복마다 SLOAD (2100 gas)
function sumBad() public view returns (uint256) {
    uint256 total = 0;
    for (uint i = 0; i < items.length; i++) {
        total += items[i] * multiplier;  // multiplier: SLOAD 매번
    }
    return total;
}

// 좋은 패턴: 첫 SLOAD 1회, 이후 memory 접근 (3 gas)
function sumGood() public view returns (uint256) {
    uint256 total = 0;
    uint256 _multiplier = multiplier;   // storage → memory 1회
    uint256 len = items.length;          // storage → memory 1회
    for (uint i = 0; i < len; i++) {
        total += items[i] * _multiplier;  // memory: 3 gas
    }
    return total;
}
```

#### storage 쓰기: SSTORE

| 변화 | 비용 | 설명 |
|---|---|---|
| 0 → 비0 | 20,000 gas | 새 데이터 기록. 가장 비쌈 |
| 비0 → 비0 (다른 값) | 2,900 gas | 기존 데이터 수정 |
| 비0 → 0 (삭제) | 5,000 gas + 환불 | 슬롯 비우면 트랜잭션 종료 시 최대 4,800 gas 환불 (EIP-3529 이후 환불 상한 감소) |

20,000 gas가 왜 이렇게 비싼가: 새 state 데이터를 전 세계 이더리움 노드가 영구 저장해야 하기 때문. 현실 세계의 "클라우드 저장소 비용"을 gas로 환산한 것.

#### memory: MSTORE / MLOAD

- MSTORE (memory 쓰기): 3 gas + memory 확장 비용
- MLOAD (memory 읽기): 3 gas
- memory 확장: 사용 중인 memory word(32바이트) 수에 비례. 처음에는 저렴하지만 크게 쓸수록 quadratic하게 증가

```solidity
// memory 확장 비용 예시
bytes memory data = new bytes(10000);  // 큰 배열 → memory 확장 비용 발생
```

#### calldata: 바이트당 비용

| 바이트 값 | 비용 |
|---|---|
| 0x00 (0 바이트) | 4 gas |
| 비0 바이트 | 16 gas |

calldata가 memory보다 싼 이유: calldata는 읽기 전용이라 복사나 확장이 없다. 또한 calldata는 트랜잭션 데이터로 이미 블록에 포함되어 있어 EVM이 별도 메모리 할당 없이 직접 참조한다.

```solidity
// calldata 활용: 배열 인자를 수정하지 않을 때
function processIds(uint256[] calldata ids) external view returns (uint256) {
    // ids를 memory로 복사하지 않음 → 저렴
    uint256 sum = 0;
    for (uint i = 0; i < ids.length; i++) {
        sum += ids[i];
    }
    return sum;
}
```

---

### [강사 배경] 4. modifier 내부 동작

#### modifier는 함수 호출이 아닌 코드 인라이닝

컴파일러는 modifier를 별도 함수로 만들지 않고, modifier 코드를 원래 함수 안에 인라이닝한다.

```solidity
modifier onlyOwner() {
    require(msg.sender == owner, "Not owner");
    _;
}

function mint(address to, uint256 amt) public onlyOwner {
    _mint(to, amt);
}
```

컴파일 후 실제 실행 코드는:
```solidity
// 컴파일러가 생성하는 논리적 동등 코드
function mint(address to, uint256 amt) public {
    require(msg.sender == owner, "Not owner");  // modifier 인라이닝
    _mint(to, amt);                              // _; 위치
}
```

함수 호출 오버헤드(JUMP + stack frame 설정)가 없어서 약 200 gas 절약.

#### _;의 위치: 전처리 vs 후처리

```solidity
// 전처리 (일반적)
modifier onlyOwner() {
    require(msg.sender == owner, "Not owner");
    _;  // ← 조건 통과 후 함수 실행
}

// 후처리 (드물지만 유용)
modifier ensureBalance() {
    _;  // ← 함수 먼저 실행
    require(address(this).balance >= minBalance, "Low balance");  // 실행 후 검증
}

// 전후처리 모두 (reentrancy guard가 이 패턴)
modifier nonReentrant() {
    require(!_locked, "Reentrant call");
    _locked = true;
    _;              // ← 함수 실행
    _locked = false;
}
```

#### 여러 modifier 체이닝 실행 순서

```solidity
function f() public modA modB modC { body; }

// 실행 순서:
// modA 전처리 → modB 전처리 → modC 전처리 → body → modC 후처리 → modB 후처리 → modA 후처리
// 중첩 함수 호출처럼 스택이 쌓임
```

#### modifier에서 revert 시 gas 처리

modifier에서 `require` 실패로 revert되면:
- 해당 시점까지 소비된 gas는 반환 안 됨
- 남은 gas는 호출자에게 반환됨
- modifier가 앞에서 실패하면 함수 본문 gas는 전혀 소비되지 않음

이게 modifier를 함수 초반에 두는 이유 중 하나: 조건 실패 시 비싼 연산 진입 전에 revert.

---

### [강사 배경] 5. Error Handling 심층

#### require / revert / assert 비교

| 구분 | 용도 | 남은 gas | 에러 타입 |
|---|---|---|---|
| `require(cond, msg)` | 외부 입력·조건 검증 | 환불 | Error(string) |
| `revert(msg)` | 복잡한 조건 분기 후 명시적 실패 | 환불 | Error(string) |
| `assert(cond)` | 내부 불변식, 도달 불가 코드 | 환불 (0.8.0+) | Panic(uint256) |

**0.8.0 이전 assert의 공포**: assert 실패 시 남은 gas 전부 소모. 이는 의도적 설계 — "assert는 절대 실패하면 안 되는 조건"임을 강제하기 위한 패널티.

0.8.0 이후: assert 실패도 남은 gas 환불로 변경. 하지만 여전히 Panic 에러 코드를 반환해 assert vs require 구분이 명확.

#### Custom Error: 왜 저렴한가

```solidity
// string require: "Insufficient balance" 문자열을 ABI 인코딩해서 returndata에 포함
require(balance >= amt, "Insufficient balance");
// returndata 크기: 4(selector) + 32(offset) + 32(length) + 32(string data) = 100 bytes+

// Custom Error: 4바이트 선택자 + 인자만
error InsufficientBalance(address user, uint256 required, uint256 actual);
revert InsufficientBalance(msg.sender, amt, balance);
// returndata 크기: 4(selector) + 32(user) + 32(required) + 32(actual) = 100 bytes
// 그러나 선택자 계산이 더 빠르고, 문자열 저장 자체가 없어서 bytecode 크기도 줄어듦
```

Custom Error의 실제 절감:
1. 컨트랙트 배포 gas 감소 (bytecode에 문자열 없음)
2. revert 시 returndata 인코딩 비용 감소
3. ethers.js에서 Custom Error 파싱 가능 (try-catch에서 에러 타입별 처리)

#### Panic 에러 코드

| 코드 | 원인 |
|---|---|
| 0x01 | `assert` 실패 |
| 0x11 | 산술 오버플로우/언더플로우 (0.8.0+ checked mode) |
| 0x12 | 0으로 나누기 |
| 0x21 | enum 범위 밖 값으로 캐스팅 |
| 0x22 | 잘못 인코딩된 storage byte 배열 접근 |
| 0x31 | 빈 배열에 `.pop()` |
| 0x32 | 배열 인덱스 범위 초과 |
| 0x41 | too much memory 할당 |
| 0x51 | 초기화되지 않은 함수 포인터 호출 |

ethers.js에서 Panic 코드로 디버깅:
```javascript
try {
    await contract.someFunction();
} catch (e) {
    if (e.code === 'CALL_EXCEPTION') {
        console.log(e.data);  // Panic(0x11) → 산술 오버플로우
    }
}
```

#### try/catch: 외부 컨트랙트 호출 실패 처리

```solidity
interface IOracle {
    function getPrice(address token) external view returns (uint256);
}

contract Consumer {
    IOracle oracle;

    function safeGetPrice(address token) public view returns (uint256, bool) {
        try oracle.getPrice(token) returns (uint256 price) {
            return (price, true);
        } catch Error(string memory reason) {
            // require/revert 실패 — reason 메시지 있음
            emit Failed(reason);
            return (0, false);
        } catch Panic(uint256 code) {
            // assert 실패, 산술 오버플로우 등
            emit PanicCode(code);
            return (0, false);
        } catch (bytes memory lowLevelData) {
            // Custom Error 또는 알 수 없는 revert
            return (0, false);
        }
    }
}
```

---

### [강사 배경] 6. 이벤트(Event) 심층

#### 이벤트 저장 위치: 트랜잭션 receipt의 logs

이벤트 데이터는 **storage에 저장되지 않는다**. 블록체인의 트랜잭션 receipt에 logs 배열로 포함된다.

```
블록
  └─ 트랜잭션 [txHash: 0xabcd...]
       └─ receipt
            └─ logs[]
                 ├─ address: 이벤트를 emit한 컨트랙트 주소
                 ├─ topics[]: indexed 필드 (최대 4개: topic[0] + indexed 최대 3개)
                 │    ├─ topics[0]: 이벤트 선택자 (keccak256("NFTIssued(address,uint256,uint256)"))
                 │    ├─ topics[1]: indexed to (address — 패딩하여 32바이트)
                 │    └─ topics[2]: indexed tokenId (uint256)
                 └─ data: non-indexed 필드 (ABI 인코딩)
                      └─ amount (uint256)
```

#### indexed 키워드: Bloom filter 필터링

`indexed` 필드는 topics에 들어가 **eth_getLogs** API로 필터링 가능하다.

이더리움 노드는 블록의 이벤트 로그에 Bloom filter를 적용해 "이 블록에 이 이벤트가 있는지" 빠르게 판단한다. indexed 필드로만 필터링할 수 있다.

```javascript
// ethers.js로 indexed 필드 필터링
const filter = contract.filters.NFTIssued(
    "0xUserAddress",  // indexed to 필터
    null,             // indexed tokenId 필터 없음
);
const events = await contract.queryFilter(filter, fromBlock, toBlock);
```

non-indexed 필드(data)는 필터링 불가. 모든 이벤트를 가져와서 클라이언트에서 파싱해야 한다.

최대 3개 indexed 제한: topics[0]은 이벤트 선택자가 쓰고, 나머지 topics[1~3]이 indexed용 → 3개.

#### anonymous 이벤트

```solidity
event SecretTransfer(address indexed from, address indexed to) anonymous;
```

`anonymous` 이벤트는 topics[0](이벤트 선택자)를 포함하지 않는다:
- gas 절약: 선택자 저장 비용 없음
- 단점: 어떤 이벤트인지 선택자로 식별 불가 → 오프체인 필터링 어려움
- 사용 사례: 로그를 최소화해야 하는 고빈도 호출, 이벤트 타입 숨김이 필요한 경우

#### 이벤트 비용 vs storage

```
이벤트 비용:
  - LOG 기본: 375 gas
  - topic당: 375 gas
  - data 바이트당: 8 gas

storage SSTORE (새 데이터):
  - 20,000 gas

NFTIssued(address indexed, uint256 indexed, uint256) 기준:
  375 (base) + 375*2 (topics) + 8*32 (data 32바이트) = 1,381 gas
  vs SSTORE: 20,000 gas
  → 약 14배 저렴
```

하지만 이벤트는 컨트랙트 내에서 읽을 수 없다. 기록 전용 오프체인 데이터.

---

### [강사 배경] 7. 전역 변수 심층

#### block.timestamp 조작 가능성

PoW 시절 마이너는 블록 타임스탬프를 ±15초 범위 내에서 조작할 수 있었다. PoS(이더리움 The Merge, 2022년 9월) 이후 블록 생성자(validator)도 유사한 범위 내 조작이 이론적으로 가능하다.

**절대 사용 금지: 난수 시드로 block.timestamp 사용**
```solidity
// 위험: 마이너/validator가 유리한 결과가 나올 때까지 timestamp 조정 가능
uint256 random = uint256(keccak256(abi.encodePacked(block.timestamp))) % 100;
```

**사용 가능: 정밀도가 낮은 시간 판단**
```solidity
// OK: 며칠 단위 만료 판단. 몇 초 조작은 무의미
require(block.timestamp < policy.expiresAt, "Policy expired");
```

#### block.number vs block.timestamp

PoS 이후 이더리움 블록 생성 주기: **12초 고정** (정확히는 slot 기반, 대부분 12초).
PoW 시절에는 블록 생성 시간이 가변적이었다 (평균 13초).

```solidity
// block.number로 시간 계산 — 12초 기준이지만 정확하지 않음
uint256 secondsElapsed = (block.number - startBlock) * 12;

// block.timestamp가 더 직접적
uint256 secondsElapsed = block.timestamp - startTimestamp;
```

#### msg.value가 payable 함수에서만 유효한 이유

non-payable 함수로 ETH를 보내면 컴파일러가 자동으로 `require(msg.value == 0)` 체크를 삽입한다. 이 체크에 실패하면 revert된다. 따라서 non-payable 함수에서 `msg.value`를 읽어도 항상 0이다 — 의미 없음.

#### gasleft(): 남은 gas 조회

```solidity
function complexOperation() external {
    uint256 gasAtStart = gasleft();

    // 반복 처리 중 gas 부족 방지
    for (uint i = 0; i < bigArray.length; i++) {
        if (gasleft() < 10000) {
            // 여기서 중단하고 다음 트랜잭션에서 이어받기
            emit PartiallyProcessed(i);
            return;
        }
        _process(bigArray[i]);
    }
}
```

DoS 방지 패턴: 배열이 매우 클 때 한 트랜잭션에서 다 처리하면 gas limit 초과. `gasleft()`로 중간 체크 후 분할 처리.

---

## [강의] 파트 (50분)

### 1. 타입 시스템 — 값 타입 (8분)

Solidity는 정적 타입 언어다. 변수 선언 시 타입을 명시해야 한다.

**정수형**

```solidity
uint8   a = 255;        // 0 ~ 2^8-1 (255)
uint16  b = 65535;      // 0 ~ 2^16-1
uint256 c = 1000;       // 0 ~ 2^256-1. uint = uint256 (기본값)
int256  d = -50;        // 부호 있는 정수. 양수/음수 모두 가능
```

왜 `uint256`이 기본값인가? EVM의 연산 단위가 256비트이기 때문이다. `uint256`은 변환 비용이 없어 EVM 네이티브 타입이다.

**0.8.0 이후 오버플로우 자동 revert:**

```solidity
uint8 x = 255;
x += 1;    // revert! (0.7.x 이전에는 0으로 wrap-around됨)
// 0.8.0부터 SafeMath 라이브러리 불필요
```

**주소형과 불리언**

```solidity
address owner = msg.sender;         // 20바이트 이더리움 주소
address payable receiver;           // ETH를 받을 수 있는 주소 (transfer/send 메서드 있음)
bool    active = true;
bytes32 hash   = keccak256(abi.encodePacked("MINTER_ROLE"));
```

`address`와 `address payable`의 차이: `payable(addr)`로 명시 캐스팅해야 `receiver.transfer(amt)` 호출이 가능하다. NFT 컨트랙트에서 수수료를 인출할 때 중요하다.

**열거형(enum)과 구조체(struct)**

```solidity
enum Status { PENDING, ACTIVE, PAUSED, REVOKED }

struct PolicyHolder {
    address wallet;
    uint256 policyId;
    Status  status;
    uint256 mintedAt;
}
```

enum은 정수로 저장된다(PENDING=0, ACTIVE=1, ...). KyoboNFT에서 정책 상태를 관리할 때 유용하다.

---

### 2. 타입 시스템 — 참조 타입과 저장 위치 (10분)

참조 타입은 선언 시 **저장 위치**를 반드시 명시해야 한다.

```
storage  — 블록체인에 영구 저장. 상태변수가 여기 있음. 가장 비쌈 (20,000 gas/슬롯)
memory   — 함수 실행 중 임시. 함수 종료 시 소멸. 참조 타입 인자/반환값에 필수
calldata — 외부 함수 입력 전용. 읽기만 가능. memory보다 저렴. 입력을 수정 안 할 때 권장
```

```solidity
// 상태변수는 항상 storage (위치 명시 불필요)
string private _name;
uint256[] private _tokenIds;
mapping(address => uint256) private _balances;

// 함수 인자/반환 — 위치 명시 필수
function setName(string memory newName) public {       // 수정 가능
    _name = newName;
}
function getName() public view returns (string memory) {
    return _name;
}
function burn(uint256[] calldata ids) external {       // 읽기만, 더 저렴
    for (uint i = 0; i < ids.length; i++) { /* ... */ }
}
```

**storage 포인터 — 흔한 함정:**

```solidity
// 잘못된 패턴: storage 포인터가 초기화되지 않음
PolicyHolder storage holder; // ← 위험! 슬롯 0을 가리킴

// 올바른 패턴
mapping(uint256 => PolicyHolder) private _holders;
PolicyHolder storage holder = _holders[policyId]; // 명확한 참조
```

**mapping의 특성:**

```solidity
mapping(address => uint256) private _balances;
// ① 선언은 상태변수(storage)로만 가능
// ② 모든 키에 기본값(0) 존재 — "없음"과 "0" 구별 불가
// ③ 반복 불가 (키 목록 따로 관리 필요) — 내부 저장 방식이 해시 기반이라 순회 불가
// ④ 중첩 가능: mapping(address => mapping(uint256 => uint256))
```

KyoboNFT의 `_balances[user][tokenId]`가 이 중첩 mapping이다.

**storage 패킹 — 선언 순서가 gas를 결정한다:**

EVM은 상태변수를 32바이트 슬롯에 저장한다. 작은 타입을 연속 선언하면 같은 슬롯에 묶어서 읽기 비용을 줄인다.

```solidity
// 비효율: 슬롯 3개 (큰 타입이 사이에 끼어 패킹 깨짐)
uint128 b;   // 슬롯0 앞 16바이트
uint256 a;   // 슬롯1 (32바이트라 슬롯0 잔여 16에 안 들어감)
uint128 c;   // 슬롯2

// 효율: 슬롯 2개 (작은 타입끼리 붙임)
uint256 a;   // 슬롯0
uint128 b;   // 슬롯1 앞 16
uint128 c;   // 슬롯1 뒤 16
```

---

### 3. 상태변수 가시성 (5분)

```solidity
uint256 public  totalSupply;   // 외부 읽기 가능. getter 함수 자동 생성
uint256 private _fee;          // 컨트랙트 내부만
uint256 internal _reserve;     // 이 컨트랙트 + 상속 컨트랙트
```

`public` 상태변수는 컴파일러가 자동으로 같은 이름의 getter 함수를 생성한다. `totalSupply()`를 별도로 작성할 필요 없다.

---

### 4. 함수 구조 — 가시성·상태 변경성 (10분)

```solidity
function 함수명(인자) 가시성 상태변경성 returns (반환타입) { ... }
```

**가시성 4종:**

| 키워드 | 호출 가능 범위 | 상속 시 |
|---|---|---|
| `public` | 누구나 (외부 + 내부 + 상속) | 상속됨 |
| `external` | 외부 호출만 | 상속됨, 내부 `this.f()`로만 가능 |
| `internal` | 컨트랙트 내부 + 상속 | 상속됨 |
| `private` | 컨트랙트 내부만 | 상속 안 됨 |

`external`이 `public`보다 calldata 처리 비용이 적어 외부 전용 함수에 사용하면 gas가 절약된다.

**상태 변경성 3종:**

```solidity
// pure: 상태 읽지도 쓰지도 않음. 순수 계산만. gas 없음 (외부 호출 시)
function calcFee(uint256 amt) public pure returns (uint256) {
    return amt / 100;
}

// view: 상태 읽기만. 쓰기 없음. gas 없음 (외부 호출 시)
function balanceOf(address who) public view returns (uint256) {
    return _balances[who];
}

// (수정자 없음): 상태 변경 → 트랜잭션 필요 → gas 소비
function transfer(address to, uint256 amt) public {
    require(_balances[msg.sender] >= amt, "Insufficient");
    _balances[msg.sender] -= amt;
    _balances[to] += amt;
}

// payable: ETH를 받을 수 있는 함수 (msg.value 접근 가능)
function deposit() public payable {
    _balances[msg.sender] += msg.value;
}
```

**에러 처리:**

```solidity
require(조건, "메시지");  // 조건 거짓이면 revert + 메시지. 남은 gas 반환
revert("메시지");         // 무조건 revert. 조건 분기 후 명시적 실패
assert(조건);             // 조건 거짓이면 panic. 버그 감지용. 도달하면 안 되는 코드에 사용

// Custom Error (0.8.4+) — 가장 저렴. string 없이 4바이트 선택자로 식별
error InsufficientBalance(address user, uint256 required, uint256 actual);
revert InsufficientBalance(msg.sender, amt, _balances[msg.sender]);
```

`require`는 사용자 입력 검증에, `assert`는 내부 불변식 검증에 사용한다. Custom Error는 string 메시지 저장이 없어 bytecode도 작고 revert gas도 저렴하다.

---

### 5. 전역 컨텍스트 변수 (5분)

```solidity
msg.sender      // 현재 함수를 호출한 주소
msg.value       // 같이 전송된 ETH 양 (wei 단위, payable 함수에서만 유효)
msg.data        // 호출 calldata 전체 (4바이트 선택자 + 인코딩된 인자)
block.timestamp // 현재 블록 타임스탬프 (Unix 초 단위)
block.number    // 현재 블록 번호
block.chainid   // 체인 ID (Ethereum=1, Sepolia=11155111)
tx.origin       // 트랜잭션 최초 발신자 (EOA). 컨트랙트 내부 호출 시에도 불변
```

**`msg.sender` vs `tx.origin` 차이:**

```
EOA → ContractA → ContractB 호출 시
  ContractB에서 msg.sender = ContractA
  ContractB에서 tx.origin  = EOA
```

접근 제어에 `tx.origin`을 쓰면 피싱 공격에 취약하다(M8에서 다룸). 항상 `msg.sender`를 사용해야 한다.

**block.timestamp 주의사항:**

validator가 몇 초 범위 내 조작 가능하다. 정밀한 시간 판단(랜덤 시드 등)에는 절대 사용하지 말 것. 만료 날짜 같은 며칠 단위 판단에는 허용.

---

### 6. 이벤트 — 트랜잭션 로그 (6분)

```solidity
// 선언
event NFTIssued(address indexed to, uint256 indexed tokenId, uint256 amount);

// 발행
emit NFTIssued(to, tokenId, amount);
```

**이벤트의 특성:**

- 이벤트 데이터는 storage가 아닌 **트랜잭션 receipt의 logs**에 저장된다
- `indexed` 필드(최대 3개): 이벤트 로그 필터링 가능. `eth_getLogs` API로 검색
- 상태를 변경하지 않음 — storage 쓰기(20,000 gas)보다 훨씬 저렴 (375 gas + 데이터)
- 컨트랙트 내부에서는 읽기 불가. 외부 클라이언트(M2 WebhookReceiver 등)가 구독

**M2 WebhookReceiver와의 연결:**

```
KyoboNFT.mint() 실행
  → emit NFTIssued(to, tokenId, amount)
    → 이 이벤트가 블록체인 로그에 기록
      → VASP가 로그를 감지 → txHash와 함께 콜백 전송
        → M2 WebhookReceiver 수신
```

이벤트 없이는 VASP가 발행 완료를 알릴 수 없다.

---

### 7. modifier — 함수 전·후처리 (6분)

```solidity
modifier onlyOwner() {
    require(msg.sender == owner, "Not owner");
    _;      // 여기에 원래 함수 본문이 삽입됨
}

modifier validAmount(uint256 amt) {
    require(amt > 0 && amt <= 10_000, "Invalid amount");
    _;
}

modifier whenNotPaused() {
    require(!paused, "Paused");
    _;
}

// 여러 modifier 적용 — 왼쪽부터 순서대로 실행
function mint(address to, uint256 amt)
    public
    onlyOwner
    validAmount(amt)
    whenNotPaused
{
    _mint(to, amt);
}
```

**`_;` 위치에 따른 실행 순서:**

```solidity
modifier log() {
    emit Before();
    _;          // 함수 본문 실행
    emit After();
}
// 결과: Before → 함수 본문 → After (전후처리 모두 가능)
```

**modifier는 코드 인라이닝이다:** 별도 함수 호출이 아니라 컴파일러가 modifier 코드를 함수 안에 삽입한다. 함수 호출 오버헤드 없이 코드 재사용.

**modifier는 상속된다:** OpenZeppelin의 `onlyOwner`와 `whenNotPaused`가 이 패턴이다. S36에서 OpenZeppelin을 쓸 때 이미 만들어진 modifier를 가져다 쓴다.

**constructor — 배포 시 1회 실행:**

```solidity
constructor(address admin) {
    owner = admin;          // 배포자가 아닌 지정 주소를 owner로 설정 가능
    totalSupply = 0;
}
// 배포 후 다시 호출 불가
// 업그레이드 패턴(UUPS)에서는 constructor 대신 initialize() 함수 사용 (M7에서)
```

---

## 실습 파트 (10분)

### 실습 A: VotingToken 핵심 시나리오 (5분)

S33 Hello.sol을 닫고 새 파일 `VotingToken.sol` 작성 후 아래 코드 붙여넣기:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract VotingToken {
    address public owner;
    uint256 public totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => bool)    private _hasVoted;

    event Minted(address indexed to, uint256 amount);
    event Voted(address indexed voter, uint256 weight);

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
    modifier hasTokens() { require(_balances[msg.sender] > 0, "No tokens"); _; }
    modifier notVotedYet() { require(!_hasVoted[msg.sender], "Already voted"); _; }

    constructor() { owner = msg.sender; }

    function mint(address to, uint256 amount) public onlyOwner {
        _balances[to] += amount;
        totalSupply += amount;
        emit Minted(to, amount);
    }

    function vote() public hasTokens notVotedYet {
        _hasVoted[msg.sender] = true;
        emit Voted(msg.sender, _balances[msg.sender]);
    }

    function balanceOf(address who) public view returns (uint256) { return _balances[who]; }
    function calcPower(uint256 bal) public pure returns (uint256) { return bal * 10; }
}
```

**확인 포인트 (5분):**

```
① mint(Account2, 100) → Minted 이벤트, [vm] gas used 확인
② balanceOf(Account2) → 100 반환, [call] 확인 (gas 없음)
③ Account2로 전환 → vote() → Voted 이벤트
④ vote() 재시도 → "Already voted" revert
⑤ Account3(잔액 0)으로 vote() → "No tokens" revert
```

---

### 실습 B (심화, 시간 여유 시): Storage 패킹 gas 비교

두 컨트랙트를 배포해서 **deployment gas 차이**를 직접 확인한다.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// 패킹 비효율 — 슬롯 4개
contract Unpacked {
    uint128 a;  // 슬롯 0 (b와 패킹 가능하지만 순서가 나쁨)
    uint256 b;  // 슬롯 1 (256비트로 슬롯 1 전체 사용)
    uint128 c;  // 슬롯 2
    uint256 d;  // 슬롯 3
}

// 패킹 효율 — 슬롯 3개
contract Packed {
    uint128 a;  // 슬롯 0 앞
    uint128 c;  // 슬롯 0 뒤 (a와 패킹)
    uint256 b;  // 슬롯 1
    uint256 d;  // 슬롯 2
}
```

배포 후 Remix "terminal"에서 각 컨트랙트의 `transaction cost` 비교. Packed가 더 저렴함을 확인한다.

---

### 실습 C (심화, 시간 여유 시): Custom Error vs string require gas 비교

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract StringRevert {
    uint256 public value;
    function set(uint256 v) public {
        require(v > 0, "Value must be greater than zero");
        value = v;
    }
}

error ValueMustBePositive();

contract CustomErrorRevert {
    uint256 public value;
    function set(uint256 v) public {
        if (v == 0) revert ValueMustBePositive();
        value = v;
    }
}
```

v=0으로 각각 호출 → Remix terminal의 `execution cost` 비교. CustomErrorRevert가 더 저렴함을 확인.

---

## 완료 기준

- [ ] `uint256` / `address` / `mapping` / `struct` / `enum` 각 타입 설명 가능
- [ ] `storage` / `memory` / `calldata` 차이 + 비용 순서 설명 가능
- [ ] `public` / `external` / `internal` / `private` 차이 설명 가능
- [ ] `pure` / `view` / 상태변경 함수의 gas 차이 설명 가능
- [ ] `require` / `revert` / `assert` 사용 시점 구분 가능
- [ ] `modifier` 에서 `_;` 위치가 실행 순서에 미치는 영향 설명 가능
- [ ] `indexed` 이벤트가 WebhookReceiver 수신과 어떻게 연결되는지 설명 가능
- [ ] storage 패킹이 gas에 영향을 미치는 이유 설명 가능
- [ ] Custom Error가 string require보다 저렴한 이유 설명 가능

---

## 강사 노트

**반드시 짚을 것:**

`mapping`의 "없는 키 = 기본값" 특성. `_hasVoted[msg.sender]`가 한 번도 set되지 않았을 때 `false`를 반환한다 — 이것이 "아직 투표 안 함"으로 해석된다. KyoboNFT의 `_balances`도 동일 패턴이다.

**흔한 혼동:**

`tx.origin` vs `msg.sender` — 컨트랙트에서 다른 컨트랙트를 호출할 때 `msg.sender`는 호출한 컨트랙트 주소가 된다. 이것이 피싱 공격에 악용될 수 있다(M8에서 상세).

**`require` 메시지 비용:**

긴 문자열 revert 메시지는 gas를 소비한다. 운영 코드에서는 Custom Error를 권장하지만 학습 단계에서는 `require(조건, "메시지")` 패턴이 직관적이므로 이걸로 진행.

**uint8 vs uint256 질문이 나오면:**

"EVM 워드가 256비트라 uint256이 변환 비용 없음. uint8은 패딩+마스킹 opcode 추가"로 설명. 단, storage 패킹에서는 uint8이 슬롯 절약에 유리함도 함께 언급.

**함수 선택자 질문이 나오면:**

"함수 이름+파라미터 타입 문자열의 keccak256 해시 앞 4바이트"라고 설명. Remix에서 배포 후 ABI 탭에서 각 함수의 selector 값을 직접 확인할 수 있음.

**S35 예고:**

다음 시간 상속(`is`)과 `override`를 배우면 modifier도 상속된다. OpenZeppelin의 `onlyOwner`가 바로 이 패턴이다.
