# M6 S33 — 스마트컨트랙트 및 솔리디티 개요

> 모듈 6 · 세션 33 · 1시간  
> 강의 50분 + 실습 10분  
> 실습 환경: [Remix IDE](https://remix.ethereum.org) (설치 없음, 브라우저)  
> 강사 준비: 120분 분량의 배경지식을 숙지하고 50분을 소화한다

---

## [강사 배경] 강사가 반드시 숙지해야 할 깊은 배경지식

> 이 섹션은 슬라이드에 넣지 않는다. 강사의 내면 이해를 위한 것이다.  
> 수강생 질문에 막힘없이 답하고, 맥락 있는 비유를 구사하려면 이 수준의 이해가 있어야 한다.

---

### [강사 배경 1] 블록체인 → 스마트컨트랙트 역사적 맥락

#### Bitcoin Script의 한계

비트코인에도 스크립트 언어가 있다. 하지만 의도적으로 제한적으로 설계되었다.

```
Bitcoin Script 특성:
  - Turing-incomplete — 반복문(loop), 조건 분기 제한
  - 상태(state) 없음 — "A가 B에게 얼마를 보냈다" 이상의 복잡한 상태 추적 불가
  - 목적: 결제(payment) 특화. UTXO 소비 조건 검증만

Bitcoin Script로 가능한 것:
  - "이 UTXO를 쓰려면 서명 2개 중 1개 필요" (멀티시그)
  - "특정 시간 이후에만 사용 가능" (타임락)

Bitcoin Script로 불가능한 것:
  - "사용자별 잔액 추적"
  - "조건에 따라 다른 주체에게 자동 전송"
  - "NFT 소유권 기록 및 이전"
```

Satoshi가 비트코인 Script를 제한한 이유: **보안**. Turing-complete 언어는 무한 루프로 노드를 공격할 수 있다. Satoshi는 결제만 하면 된다고 판단했다.

#### Vitalik의 2013년 핵심 아이디어

Vitalik Buterin은 2013년 말, 19세에 이더리움 백서를 썼다. 핵심 통찰:

> "블록체인에 범용 Turing-complete 상태 머신을 올리면,  
> 결제 외의 모든 합의 기반 애플리케이션을 만들 수 있다."

이것이 EVM(Ethereum Virtual Machine)이다.

```
Satoshi의 선택:                Vitalik의 선택:
결제에 특화한 제한된 스크립트   범용 프로그래밍 가능한 상태 머신
안전하지만 표현력 낮음          표현력 높지만 보안은 개발자 책임
```

Gas 메커니즘이 Turing-complete의 위험(무한 루프)을 해결했다. Gas가 소진되면 실행이 강제 중단된다. Satoshi가 Turing-complete를 피한 이유를 Gas로 해결한 것이다.

#### 이더리움 메인넷 출시 (2015년)

```
2013-11  Vitalik 백서 공개
2014-01  이더리움 팀 공식 구성 (Gavin Wood, Jeffrey Wilcke 등)
2014-07  ICO — 당시 역대 최대 규모 크라우드펀딩
2015-07  Frontier 메인넷 출시 (v0.1, 명령줄 전용)
2015-08  첫 번째 스마트컨트랙트 배포
2016-04  The DAO 해킹 — 360만 ETH(3.6M ETH) 탈취, 하드포크 논쟁
2016-07  ETH/ETC 체인 분리
2020-12  Beacon Chain 출시 (PoS 준비)
2022-09  The Merge — PoW → PoS 전환
```

The DAO 해킹은 스마트컨트랙트의 보안이 얼마나 중요한지를 보여주는 역사적 사건이다. "배포 후 수정 불가"의 무게를 설명할 때 이 사례를 언급할 수 있다.

#### Solidity 버전 진화 — 강사가 알아야 할 주요 변화

```
버전        주요 변화
─────────────────────────────────────────────────────────────
0.1.x       최초 릴리즈 (2014). 기본적인 문법만 존재
0.4.x       event, modifier 등 핵심 기능 안정화
0.5.x       breaking changes — 명시적 타입 캐스팅 필수
0.6.x       try/catch 도입, abstract 키워드
0.7.x       Unicode 리터럴, 상태 변수 visibility 기본값 변경
0.8.0       ⭐ 산술 오버플로우 자동 revert (SafeMath 불필요)
0.8.x       사용자 정의 오류(custom error), unchecked 블록
0.8.20+     현재 주류. EIP-3860 등 opcode 업데이트 반영
```

**0.8.0이 왜 중요한가:**

0.8.0 이전에는 uint256 최댓값(2^256 - 1)에 1을 더하면 0이 됐다. 오버플로우가 silent하게 발생했다. 이를 막기 위해 OpenZeppelin SafeMath 라이브러리를 모든 산술 연산에 써야 했다.

```solidity
// 0.8.0 이전 — SafeMath 없이 쓰면 위험
uint256 x = type(uint256).max;
x = x + 1;  // 오버플로우 → x = 0 (silent bug!)

// SafeMath 사용 (0.8.0 이전)
x = x.add(1);  // revert 발생 → 안전

// 0.8.0 이후 — 자동으로 revert
uint256 x = type(uint256).max;
x = x + 1;  // 자동 revert! SafeMath 불필요
```

우리 KyoboNFT는 `pragma solidity ^0.8.20`을 사용한다. SafeMath 없이도 안전하다.

---

### [강사 배경 2] EVM 내부 구조 깊이 이해

#### 스택 기반 VM vs 레지스터 기반 VM

EVM은 스택 기반(stack-based) VM이다. 왜인가?

```
레지스터 기반 VM (예: JVM, Lua VM):
  - 가상 레지스터를 고정 개수 운영 (r0, r1, r2 ...)
  - 명령어: ADD r0, r1, r2  (r0 = r1 + r2)
  - 구현 복잡, 최적화 유리, 성능 좋음

스택 기반 VM (예: EVM, CPython):
  - 스택만 사용. 피연산자를 push, 연산 후 pop
  - 명령어: PUSH1 3 / PUSH1 5 / ADD  (→ 스택에 8 남음)
  - 구현 단순, 검증 용이, 플랫폼 독립적
```

EVM이 스택 기반을 택한 이유: **검증 단순성**. 수천 개의 노드가 동일한 실행 결과를 내야 한다. 스택 기반은 실행 의미론(semantics)이 명확하고, 구현 버그를 줄이기 쉽다.

EVM 스택 제한: 최대 1024 depth. 1024개를 초과하면 Stack Overflow로 revert.

#### 256비트 워드 크기의 이유

EVM의 기본 연산 단위는 256비트(32바이트)다. 왜인가?

```
keccak256("임의의 데이터") → 256비트 해시값

이더리움에서 keccak256이 핵심 도처에 쓰인다:
  - 주소 계산: keccak256(공개키)[12:] → 20바이트 주소
  - 스토리지 슬롯: keccak256(key, slot) → 슬롯 위치
  - 함수 선택자: keccak256("함수시그니처")[0:4]
  - 트랜잭션 해시, 블록 해시

→ 256비트 워드가 해시 연산과 자연스럽게 맞아떨어진다
```

uint256이 Solidity의 기본 정수형인 이유도 여기에 있다. EVM 워드 하나가 uint256 하나다. 더 작은 타입(uint8, uint128)은 내부적으로 256비트로 패딩되어 처리된다.

#### EVM 실행 환경 4가지

```
┌─────────────────────────────────────────────────────────┐
│                     EVM 실행 환경                         │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │  Stack   │  │  Memory  │  │ Storage  │  │Calldata │ │
│  │          │  │          │  │          │  │         │ │
│  │연산 전용  │  │실행 중   │  │영구 저장  │  │읽기전용  │ │
│  │임시 공간  │  │임시 공간  │  │슬롯 기반  │  │입력 데이터│ │
│  │          │  │          │  │          │  │         │ │
│  │최대 1024  │  │바이트배열  │  │32바이트   │  │tx.data  │ │
│  │256비트    │  │함수 종료  │  │슬롯 단위  │  │변경 불가  │ │
│  │depth      │  │시 소멸   │  │영구 유지  │  │         │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
│                                                          │
│     비용: Storage >> Memory > Calldata ≈ Stack (거의 무료)│
└─────────────────────────────────────────────────────────┘
```

| 공간 | 특성 | Solidity 대응 | 비용 |
|---|---|---|---|
| Stack | 256비트 값, 1024 depth 제한 | 지역 변수(값 타입) | 최소 |
| Memory | 바이트 배열, 함수 종료 시 소멸 | `memory` 키워드 | 중간 (비선형 증가) |
| Storage | 32바이트 슬롯, 영구 | `storage` 키워드, 상태변수 | 매우 높음 |
| Calldata | 읽기 전용, 트랜잭션 입력 | `calldata` 키워드 | 낮음 (읽기만) |

**Memory 비용이 비선형인 이유:** Memory 확장 비용이 사용량의 제곱에 비례한다. 큰 배열을 Memory에 올리면 갑자기 비싸진다.

#### EVM Opcode — 강사가 알아야 할 주요 코드

```
Opcode        의미                              gas
──────────────────────────────────────────────────────────
PUSH1 0x60    스택에 1바이트 값 push              3
ADD           스택 top 2개를 더해 push           3
MUL           곱하기                             5
SLOAD         storage에서 값 읽기               100~2100
SSTORE        storage에 값 쓰기             20000~100
MLOAD         memory에서 32바이트 읽기            3
MSTORE        memory에 32바이트 쓰기             3
CALL          다른 컨트랙트 호출               700+
DELEGATECALL  caller의 context로 다른 코드 실행  700+
CALLDATALOAD  calldata에서 32바이트 읽기         3
RETURN        실행 결과 반환                      0
REVERT        실행 취소 + 남은 gas 반환          0
```

SLOAD의 gas가 100~2100 범위인 이유: EIP-2929(Berlin 하드포크)에서 "접근 목록(access list)" 개념이 도입됐다. 같은 트랜잭션에서 처음 접근하는 슬롯은 2100, 이미 접근한 슬롯은 100이다.

Solidity 코드 `mapping(address => uint256) private _balances`에서 `_balances[user]`를 한 함수 안에서 두 번 읽으면, 첫 번째는 2100 gas, 두 번째는 100 gas다. 이것이 "local caching" 패턴의 gas 절감 근거다.

```solidity
// 비효율 — storage 2번 읽기: 2100 + 2100 gas
if (_balances[user] > 0) {
    emit Transfer(user, _balances[user]);
}

// 효율 — storage 1번 읽기: 2100 + 스택 읽기(3) gas
uint256 bal = _balances[user];  // 1번만 SLOAD
if (bal > 0) {
    emit Transfer(user, bal);
}
```

---

### [강사 배경 3] Gas 메커니즘 완전 이해

#### Gas는 왜 존재하는가 — 할팅 문제

컴퓨터과학에서 **할팅 문제(Halting Problem)**: 임의의 프로그램이 유한 시간 내에 종료하는지 일반적으로 판별 불가능하다(Turing, 1936).

EVM에 Turing-complete 코드를 실행하면, 노드가 영원히 계산해야 할 수도 있다. Gas가 이를 막는다.

```
Gas가 해결하는 문제:
① 할팅 문제 — gas 소진 시 실행 강제 중단
② DoS 공격 — 무거운 연산을 공격에 사용하려면 gas 비용 지불
③ 희소 자원 배분 — 블록당 gas limit이 있어 처리량 제한
④ 검증자 보상 — 연산 자원 제공의 경제적 동기
```

#### Gas Price vs Gas Limit vs Gas Used

```
거래 전 설정:
  gasLimit  = 내가 이 트랜잭션에 허용하는 최대 gas 사용량
              (초과 시 Out of Gas → revert)
  maxFeePerGas = 내가 낼 의향이 있는 최대 gas 단가

실행 중:
  gasUsed   = 실제 소비된 gas
  baseFee   = 네트워크가 요구하는 최소 단가 (자동 결정)

비용 계산:
  실제 비용 = gasUsed × (baseFee + priorityFee)
  환불      = (gasLimit - gasUsed) × maxFeePerGas
```

중요: gasLimit을 초과하면 revert이지만 **gas는 환불되지 않는다**. 노드가 연산을 했으니까. gasLimit을 너무 낮게 설정하는 것은 사용자 실수다.

#### EIP-1559 — 2021년 London 하드포크

EIP-1559 이전: 경매 방식. 가장 높은 gas price를 제시한 순서대로 처리.

```
문제점:
  - gas price 예측 어려움 (과대 지불 일상화)
  - 채굴자와 사용자 간 게임이론적 비효율
  - 네트워크 혼잡 시 급격한 gas 폭등
```

EIP-1559 이후: base fee + priority fee (팁) 이중 구조.

```
baseFee:
  - 프로토콜이 자동 계산
  - 이전 블록이 gas limit의 50% 초과 → 다음 블록 baseFee 최대 12.5% 상승
  - 이전 블록이 50% 미만 → 최대 12.5% 하락
  - 소각(burn)됨 → ETH 공급량 감소

priorityFee (tip):
  - 사용자가 검증자에게 주는 팁
  - 혼잡 시 높은 팁으로 빠른 처리 요청
  - 검증자 수익
```

base fee 소각의 중요성: ETH 발행량(신규 블록 보상)과 소각량이 균형을 이루면 ETH는 디플레이션 자산이 된다. The Merge(PoS 전환) 이후 실제로 ETH 공급량이 순감소하는 구간이 발생한다.

#### Out of Gas 발생 시 정확히 무슨 일이 일어나는가

```
시나리오: gasLimit = 50,000 으로 트랜잭션 제출
          실행 중 gasUsed가 50,000 초과

결과:
  1. EVM 실행 즉시 중단 (Out of Gas exception)
  2. 해당 트랜잭션의 모든 상태 변경 revert
     (storage에 쓴 것도 없었던 일로)
  3. 소비된 gas (= gasLimit 전체) 환불 없음
     (노드가 연산을 했으므로)
  4. nonce는 증가 (트랜잭션은 처리됨, 실패했을 뿐)
  5. 이더스캔에 "Fail" 상태로 기록됨

비유: 택시 타고 목적지 못 가도 미터기는 올라간 만큼 냄
```

---

### [강사 배경 4] ABI 완전 이해

#### ABI란 정확히 무엇인가

ABI(Application Binary Interface)는 두 시스템 간 바이너리 수준 인터페이스 규약이다. C 라이브러리의 ABI가 "이 함수는 첫 번째 인자를 rdi 레지스터로 받는다"를 정의하듯, EVM ABI는 "이 함수를 호출하려면 calldata를 이렇게 인코딩해라"를 정의한다.

#### 함수 선택자 (Function Selector) — 핵심 메커니즘

EVM 바이트코드에는 함수 이름이 없다. "mint" 같은 문자열은 컴파일 후 사라진다. 대신 **4바이트 함수 선택자**로 식별한다.

```
함수 선택자 계산:
  keccak256("mint(address,uint256,uint256,bytes)") 
  = 0x731133e9ebb09be3f374bc25dce3e2ddcde70b3c5ada0f5d7b64...
  
  앞 4바이트만 취함:
  = 0x731133e9
```

ethers.js로 직접 계산:

```javascript
import { ethers } from "ethers";

// 방법 1: ethers.id 사용
const sig = "mint(address,uint256,uint256,bytes)";
const selector = ethers.id(sig).slice(0, 10);
// → "0x731133e9"

// 방법 2: keccak256 직접
const selector2 = ethers.keccak256(ethers.toUtf8Bytes(sig)).slice(0, 10);
// → "0x731133e9"

console.log(selector);  // 0x731133e9
```

컨트랙트는 calldata 첫 4바이트를 읽어 어떤 함수를 실행할지 결정한다. 이것이 fallback function이 호출되는 원리다 — 4바이트가 어떤 함수와도 매칭되지 않으면 fallback 실행.

#### ABI 인코딩 규칙

calldata 구조:
```
[4바이트 selector] [파라미터 인코딩]
```

파라미터 인코딩:
```
정적 타입 (고정 크기):
  uint256, address, bool → 32바이트 패딩
  예) address 0xAbCd...  → 000...000AbCd... (32바이트)
  예) uint256 100        → 000...000064     (32바이트, hex 64 = dec 100)

동적 타입 (가변 크기):
  string, bytes, 동적 배열 → 오프셋 + 데이터
  예) "hello" → [오프셋: 32바이트] [길이: 5] [데이터: 68 65 6c 6c 6f + 패딩]
```

실제 calldata 예시 (`mint(0xUser, 1, 100, "0x")`):

```
0x731133e9                                          ← 함수 선택자 (4바이트)
000000000000000000000000[UserAddress20바이트]        ← address to (32바이트)
0000000000000000000000000000000000000000000000000000000000000001  ← uint256 tokenId = 1
0000000000000000000000000000000000000000000000000000000000000064  ← uint256 amount = 100
0000000000000000000000000000000000000000000000000000000000000080  ← bytes data 오프셋 (128)
0000000000000000000000000000000000000000000000000000000000000000  ← bytes data 길이 (0)
```

#### ABI JSON 구조 — 상세

```json
{
  "type": "function",           // function / event / constructor / error
  "name": "mint",
  "inputs": [
    { "name": "to",      "type": "address" },
    { "name": "tokenId", "type": "uint256" },
    { "name": "amount",  "type": "uint256" },
    { "name": "data",    "type": "bytes"   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
  // nonpayable: ETH 받지 않음, 상태 변경 가능
  // payable:    ETH 받음, 상태 변경 가능
  // view:       상태 읽기만, 트랜잭션 불필요
  // pure:       상태 접근 없음, 순수 계산
}
```

이벤트 ABI:

```json
{
  "type": "event",
  "name": "NFTIssued",
  "inputs": [
    { "name": "to",      "type": "address", "indexed": true  },
    { "name": "tokenId", "type": "uint256", "indexed": true  },
    { "name": "amount",  "type": "uint256", "indexed": false }
  ],
  "anonymous": false
}
```

`indexed: true`인 필드는 이더스캔에서 필터링 가능하다. M2에서 구현한 WebhookReceiver가 특정 tokenId의 NFTIssued 이벤트만 수신하려면 indexed 필터를 쓴다.

#### ethers.js에서 ABI가 필요한 이유

```javascript
// ABI 없이는 이렇게 해야 함 (raw calldata)
const iface = new ethers.Interface([]);
const selector = "0x731133e9";
const encoded = iface.encodeFunctionData(...);  // ABI 필요!

// raw calldata 직접 조립 (개념 이해용, 실제로는 쓰지 않음)
const rawCalldata = "0x731133e9" + 
  "000000000000000000000000" + toAddress.slice(2) +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000064" +
  "0000000000000000000000000000000000000000000000000000000000000080" +
  "0000000000000000000000000000000000000000000000000000000000000000";

// ABI 있을 때 (실제 사용)
const contract = new ethers.Contract(address, abi, signer);
await contract.mint(toAddress, 1n, 100n, "0x");
// ethers.js가 ABI를 보고 자동으로 calldata 인코딩
```

ABI는 "바이트코드 ↔ 사람이 읽을 수 있는 함수명" 사이의 번역 사전이다.

---

### [강사 배경 5] Solidity 컴파일 체인 완전 이해

#### .sol → 배포까지 전체 흐름

```
Hello.sol
  │
  ▼ solc 컴파일러 (Solidity compiler)
  │
  ├── bytecode (hex string)
  │     ├── creation code  ← 배포 시 딱 1번 실행되는 코드 (constructor 포함)
  │     └── runtime code   ← 실제 배포된 컨트랙트 코드 (영구 저장)
  │
  └── ABI (JSON)           ← 함수 명세 (외부 호출자가 사용)

배포 트랜잭션:
  to: null (컨트랙트 생성 트랜잭션)
  data: creation code + constructor 인자 인코딩

실행:
  EVM이 creation code 실행
  → constructor 로직 수행
  → runtime code를 storage에 저장
  → 새로운 주소 생성 (keccak256(sender, nonce)[12:])
```

Hardhat 컴파일 아티팩트 위치:

```
artifacts/
  contracts/
    KyoboNFT.sol/
      KyoboNFT.json   ← ABI + bytecode 포함
      KyoboNFT.dbg.json  ← 디버그 정보
```

`KyoboNFT.json` 구조:

```json
{
  "contractName": "KyoboNFT",
  "abi": [...],
  "bytecode": "0x608060...",          // creation code
  "deployedBytecode": "0x608060...", // runtime code
  "linkReferences": {},
  "deployedLinkReferences": {}
}
```

#### Optimizer — runs=200의 의미

```
solc --optimize --optimize-runs 200

runs 값의 의미:
  "이 컨트랙트가 평균 200번 호출될 것으로 가정하고 최적화"

runs 낮음 (예: 1):
  - 배포 비용 최소화 (bytecode 짧게)
  - 각 함수 실행 비용 높아짐
  - 1회성 컨트랙트에 적합

runs 높음 (예: 1000):
  - 배포 비용 높아짐 (bytecode 길어짐)
  - 각 함수 실행 비용 최소화
  - 자주 호출되는 컨트랙트에 적합

기본값 200:
  - 균형점. OpenZeppelin 기본값도 200
```

KyoboNFT는 `mint()`가 빈번히 호출될 것이므로 runs=200 또는 더 높게 설정할 수 있다.

---

### [강사 배경 6] Remix vs Hardhat 심층 비교

#### Remix의 내부 구조

Remix는 브라우저에서 실행되는 전체 개발 환경이다. 내부적으로:

```
Remix VM (Cancun/London):
  - 브라우저 내 JavaScript EVM 구현 (ethereumjs-vm)
  - 10개의 테스트 계정, 각 100 ETH 초기화
  - 네트워크 연결 없음 → 완전 로컬
  - 탭 닫으면 상태 초기화
  - 블록 타임이 즉각적 (실제 ~12초 아님)

Remix Compiler:
  - solc-js (WebAssembly 컴파일된 Solidity 컴파일러)
  - 브라우저에서 직접 컴파일
  - 여러 버전 선택 가능
```

#### Hardhat의 내부 구조

```
Hardhat Network:
  - Node.js 기반 로컬 이더리움 구현
  - Mining mode: 트랜잭션마다 즉시 블록 생성 (기본)
                또는 interval mining (정해진 주기)
  - console.log() 지원 (Solidity 안에서!)
  - Stack trace: 실패 시 정확한 위치 표시
  - mainnet forking: 실제 메인넷 상태를 로컬에서 포크

플러그인 생태계:
  @nomicfoundation/hardhat-toolbox     ← 기본 패키지 (ethers, chai 등)
  @openzeppelin/hardhat-upgrades       ← 업그레이더블 컨트랙트 배포
  hardhat-gas-reporter                 ← 함수별 gas 보고서
  hardhat-contract-sizer               ← 컨트랙트 크기 확인 (24KB 제한)
```

#### 언제 무엇을 쓰는가

```
Remix 사용 시점:
  ✓ 새 문법 빠르게 실험
  ✓ 강의/튜토리얼 (설치 불필요)
  ✓ 단일 컨트랙트 즉흥 테스트
  ✓ 이더스캔에서 소스코드 확인

Hardhat 사용 시점:
  ✓ 팀 개발 (git 기반 프로젝트)
  ✓ 자동화 테스트 (mocha/chai)
  ✓ CI/CD 파이프라인
  ✓ 배포 스크립트 (재현 가능한 배포)
  ✓ 업그레이더블 컨트랙트 관리
  ✓ 메인넷 포크 테스트
```

S33~S39: Remix. S40~S42: Hardhat.

---

---

## [강의] 실제 수업에서 전달할 내용 (50분)

---

### 1. 스마트컨트랙트란 무엇인가 (8분)

M2~M5에서 우리는 VASP에 NFT 발행을 요청했다. VASP는 내부적으로 무언가를 호출해 온체인에 NFT를 기록한다. 그 "무언가"가 **스마트컨트랙트**다.

스마트컨트랙트의 세 가지 특성:

**① 배포 후 수정 불가**

```
일반 서버 코드                  스마트컨트랙트
─────────────────              ─────────────────────
버그 발견 → 수정 → 재배포       배포하면 코드 고정
코드가 서버에 있음              블록체인 주소에 영구 기록
롤백 가능                      롤백 불가
```

한번 배포된 컨트랙트의 코드는 바꿀 수 없다. 상태(데이터)는 트랜잭션으로 변경되지만 코드 자체는 불변이다. 2016년 The DAO 해킹 사례를 생각해보자 — 360만 ETH(약 $60M)가 탈취됐지만 코드를 수정할 수 없었다. 이더리움 커뮤니티는 결국 체인을 하드포크해서 해결했고, 이 결정 때문에 ETH와 ETC로 갈라졌다. 그만큼 "배포 후 수정 불가"의 무게가 크다.

그래서 **업그레이드 패턴**(M7에서 구현)이 필요하다.

**② 누구나 호출 가능**

컨트랙트 주소와 ABI(함수 명세)가 있으면 누구나 함수를 호출할 수 있다. 이더스캔에서 컨트랙트 주소를 검색하면 누구나 함수 목록을 보고 직접 호출할 수 있다.  
→ 그래서 `onlyRole(MINTER_ROLE)` 같은 **접근 제어**가 필수다. 접근 제어 없이 배포하면 누구나 NFT를 발행할 수 있다.

**③ 결과가 온체인에 기록**

함수 실행 결과는 블록체인 상태로 저장된다. 조작 불가, 누구나 검증 가능.  
→ Phase 1에서 내부 원장(M4)이 온체인과 항상 일치해야 하는 이유다. 온체인이 진실의 원천(source of truth)이다.

---

### 2. EVM — 스마트컨트랙트가 실행되는 환경 (10분)

**EVM(Ethereum Virtual Machine)** 은 스마트컨트랙트를 실행하는 가상 컴퓨터다. 전 세계 수천 개의 이더리움 노드가 동일한 EVM을 구동한다.

```
사용자 → 트랜잭션 서명 → 네트워크 브로드캐스트
                              ↓
                    전체 노드가 동일한 EVM으로 실행
                              ↓
                    결과를 블록에 기록 (합의)
```

**EVM 실행 환경 — 네 가지 저장소**

```
┌──────────────────────────────────────────────────────────────┐
│                      EVM 실행 환경                             │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
│  │  Stack   │  │  Memory  │  │ Storage  │  │  Calldata   │  │
│  │          │  │          │  │          │  │             │  │
│  │연산 전용  │  │실행 중   │  │영구 저장  │  │읽기전용     │  │
│  │임시 공간  │  │임시 공간  │  │슬롯 기반  │  │트랜잭션 입력 │  │
│  │          │  │          │  │          │  │             │  │
│  │지역변수   │  │memory    │  │상태변수   │  │함수 인자    │  │
│  │(값 타입)  │  │키워드    │  │storage   │  │calldata     │  │
│  │          │  │          │  │키워드    │  │키워드       │  │
│  └──────────┘  └──────────┘  └──────────┘  └─────────────┘  │
│                                                               │
│  비용 (낮음) ────────────────────────────── (높음)            │
│  Calldata ≈ Stack < Memory << Storage                        │
└──────────────────────────────────────────────────────────────┘
```

Solidity 코드를 쓸 때 `storage` / `memory` 위치를 지정하는 이유가 이 구조 때문이다.

```solidity
// storage: 블록체인에 영구 저장, gas 비쌈
string public greeting;          // 상태변수 = storage 자동

// memory: 함수 실행 중만 존재, 종료 시 소멸
function greet() public view returns (string memory) {
    return greeting;  // 반환값은 memory에 임시 저장
}

// calldata: 읽기 전용, 외부 호출의 인자에 사용 (가장 저렴)
function setGreeting(string calldata newGreeting) public {
    greeting = newGreeting;  // calldata → storage 복사
}
```

**트랜잭션 = 함수 호출**

```
POST /api/mint              vs      mint(to, tokenId, amount) 트랜잭션
────────────────────                ────────────────────────────────────
HTTP 요청                           블록체인 트랜잭션
서버가 처리                         모든 노드가 동일하게 실행
결과를 DB에 저장                    결과를 블록에 저장
서버가 없으면 실패                  네트워크가 살아 있으면 실행됨
```

REST API 호출과 구조가 같다. 함수명, 인자, 반환값이 있다. 차이는 **실행 주체가 중앙 서버가 아닌 블록체인 네트워크 전체**라는 것이다.

---

### 3. Gas — 실행 비용 (8분)

EVM 연산은 무료가 아니다. 모든 명령어(opcode)에 가스 비용이 있다.

**Gas가 필요한 이유:**

```
① 무한 루프 공격 방지 — gas 소진되면 실행 강제 중단
② 네트워크 자원 남용 방지 — 계산이 비쌀수록 gas 많이 소비
③ 검증자에게 보상 — 블록 포함 대가로 gas fee 지급
```

비유: **도시가스 미터기**. 가스 불을 켜는 순간부터 미터기가 돌아간다. 얼마나 세게 얼마나 오래 켰느냐에 따라 요금이 다르다. EVM도 마찬가지 — 연산마다 요금이 청구된다. 미터기 한도(gasLimit)를 넘으면 가스가 잠긴다(revert).

**Gas 계산 (EIP-1559, 2021년 London 하드포크 이후):**

```
실제 비용(ETH) = gasUsed × (baseFeePerGas + priorityFeePerGas)

baseFeePerGas    — 네트워크 혼잡도에 따라 자동 조정, 소각됨 (ETH 줄어듦)
priorityFeePerGas — 검증자에게 주는 팁 (빠른 처리 요청 시 올림)
gasLimit         — 내가 허용하는 최대 gas (초과 시 revert)
```

**주요 연산별 gas 비용:**

| 연산 | Opcode | gas 비용 | Solidity 대응 |
|---|---|---|---|
| 기본 덧셈 | ADD | 3 | a + b |
| 기본 곱셈 | MUL | 5 | a * b |
| storage 읽기 (첫 접근) | SLOAD | 2,100 | 상태변수 읽기 |
| storage 읽기 (재접근) | SLOAD | 100 | 동일 슬롯 2번째 읽기 |
| storage 쓰기 (새 슬롯) | SSTORE | 20,000 | 상태변수 초기 쓰기 |
| storage 쓰기 (기존 슬롯) | SSTORE | 2,900 | 상태변수 업데이트 |
| 이벤트 emit | LOG1~4 | ~375 + 데이터 | emit Event(...) |
| 트랜잭션 기본 | - | 21,000 | 모든 트랜잭션 |

→ `_balances[user][tokenId] += amount` 한 줄이 storage 읽기(2100) + 쓰기(2900~20000)다. KyoboNFT에서 불필요한 storage 접근을 줄이는 것이 gas 최적화의 핵심이다.

**Out of Gas 발생 시:**

```
gasLimit 초과 → 트랜잭션 revert (상태 복구)
                gas는 환불 안 됨 (연산을 했으므로)
                nonce는 증가
```

**Sepolia 테스트넷:** ETH를 faucet에서 무료로 받는다. 실습에서는 gas 비용을 신경 쓰지 않아도 된다.

---

### 4. ABI — 컨트랙트의 함수 명세 (8분)

ABI(Application Binary Interface)는 컨트랙트 함수 목록과 인자 타입을 JSON으로 정의한 명세다.

**ABI가 필요한 이유:**

Solidity 코드를 컴파일하면 EVM 바이트코드가 된다. 바이트코드에는 함수 이름 같은 사람이 읽을 수 있는 정보가 없다. ABI는 "이 함수를 호출하려면 calldata를 이렇게 만들어라"는 번역 사전이다.

**함수 선택자 — ABI 핵심 메커니즘:**

```
keccak256("mint(address,uint256,uint256,bytes)") 앞 4바이트
= 0x731133e9
```

ethers.js로 직접 확인:

```javascript
import { ethers } from "ethers";

const selector = ethers.id("mint(address,uint256,uint256,bytes)").slice(0, 10);
console.log(selector);  // "0x731133e9"

// transfer(address,uint256)
const erc20Transfer = ethers.id("transfer(address,uint256)").slice(0, 10);
console.log(erc20Transfer);  // "0xa9059cbb"
```

**ABI JSON 구조:**

```json
[
  {
    "name": "mint",
    "type": "function",
    "inputs": [
      { "name": "to",      "type": "address" },
      { "name": "tokenId", "type": "uint256" },
      { "name": "amount",  "type": "uint256" },
      { "name": "data",    "type": "bytes"   }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  }
]
```

stateMutability 값:

| 값 | 의미 | 트랜잭션 | ETH 수신 |
|---|---|---|---|
| `view` | 읽기 전용 | 불필요 | 불가 |
| `pure` | 상태 접근 없음 | 불필요 | 불가 |
| `nonpayable` | 상태 변경 | 필요 | 불가 |
| `payable` | 상태 변경 + ETH 수신 | 필요 | 가능 |

VASP가 KyoboNFT를 호출할 때 이 ABI를 사용한다. ethers.js의 `new ethers.Contract(address, abi, signer)` 호출이 이 구조다(M7에서 실제로 작성).

**ABI 없이는 호출 불가:** 컨트랙트 주소만 알아도 ABI 없이는 어떤 함수가 있는지 모른다. 이더스캔에 소스코드를 검증(verify)하는 이유가 ABI를 공개하기 위해서다.

---

### 5. Solidity — EVM을 위한 언어 (12분)

```
Solidity 코드 (.sol)
      ↓  solc 컴파일러
EVM 바이트코드 + ABI JSON
      ↓  배포 트랜잭션 (to: null)
블록체인 주소에 runtime code 저장
      ↓  호출 트랜잭션
EVM이 바이트코드 실행
```

Solidity는 EVM 바이트코드로 컴파일되는 **고수준 언어**다. C와 어셈블리의 관계와 같다. 우리는 Solidity로 코드를 쓰고, EVM은 바이트코드를 실행한다.

**버전 관리:**

```solidity
pragma solidity ^0.8.20;
// ^ : 0.8.20 이상 0.9.0 미만에서 컴파일 허용
// 0.8.0 이후: 산술 오버플로우가 기본으로 revert — SafeMath 불필요
// 0.8.20: EIP-3855(PUSH0 opcode) 등 최신 기능 지원
```

**Hello.sol — 전체 코드 + 상세 설명:**

```solidity
// SPDX-License-Identifier: MIT          ← 라이선스 선언
//   없으면 컴파일 경고. MIT = 자유 사용 허가
pragma solidity ^0.8.20;                 ← 컴파일러 버전 지정

contract Hello {                         ← 컨트랙트 선언
    // 상태변수: 블록체인 storage에 영구 저장
    // public → 자동으로 getter 함수 생성 (greeting() 함수)
    string public greeting = "Hello";

    // constructor: 배포 시 딱 1번 실행
    // 이후에는 절대 호출 불가 — 초기화 전용
    constructor() {
        greeting = "Hello, Kyobo!";
    }

    // view: storage 읽기만, 상태 변경 없음
    // → 트랜잭션 불필요, gas 없음, 즉시 반환
    // returns (string memory): string은 참조 타입 → memory 위치 명시 필수
    function greet() public view returns (string memory) {
        return greeting;
    }

    // event: 트랜잭션 로그에 기록
    // indexed: 이더스캔에서 필터 검색 가능
    event Greeted(address indexed who, string message);

    // 상태 변경 없음 but event emit → 트랜잭션 필요 (로그가 블록에 기록됨)
    function sayHello() public {
        emit Greeted(msg.sender, greeting);
        // msg.sender: 이 함수를 호출한 EOA 또는 컨트랙트 주소
    }

    // 상태 변경 함수 → 트랜잭션 필요 → gas 소비
    // memory: 함수 실행 중 임시 저장 (storage에 복사 후 소멸)
    function setGreeting(string memory newGreeting) public {
        greeting = newGreeting;
    }
}
```

**핵심 키워드 테이블:**

| 키워드 | 위치 | 의미 | gas 여부 |
|---|---|---|---|
| `public` | 함수/변수 | 누구나 호출 가능 (외부+내부) | - |
| `private` | 함수/변수 | 이 컨트랙트 내부에서만 | - |
| `internal` | 함수/변수 | 이 컨트랙트 + 상속 컨트랙트 | - |
| `external` | 함수 | 외부에서만 호출 가능 (calldata 사용) | - |
| `view` | 함수 | 상태 읽기만, 변경 없음 | 없음 |
| `pure` | 함수 | 상태 접근 없음 (순수 계산) | 없음 |
| `payable` | 함수/변수 | ETH를 받을 수 있음 | 있음 |
| `memory` | 타입 위치 | 함수 실행 중 임시 저장 | 낮음 |
| `storage` | 타입 위치 | 블록체인 영구 저장 | 높음 |
| `calldata` | 타입 위치 | 읽기 전용 입력 (가장 저렴) | 최저 |
| `emit` | 구문 | 이벤트 발행 → 트랜잭션 로그 | 낮음 |
| `msg.sender` | 전역변수 | 현재 호출자 주소 | - |
| `msg.value` | 전역변수 | 함께 전송된 ETH 양 (wei) | - |
| `block.timestamp` | 전역변수 | 현재 블록 타임스탬프 (초) | - |
| `constructor` | 특수 함수 | 배포 시 1회 실행 | 배포비용 |

---

### 6. Remix vs Hardhat — 지금 왜 Remix인가 (4분)

| 항목 | Remix | Hardhat |
|---|---|---|
| 설치 | 없음, 브라우저 | Node.js, npm 패키지 |
| 용도 | 빠른 실험, 학습 | 프로덕션 배포, 자동화 테스트 |
| 테스트 | 수동 클릭 | 코드로 작성 (Mocha/Chai) |
| 네트워크 | Remix VM (로컬 인메모리) | Hardhat Network / Anvil |
| 협업 | 불편 (개인 브라우저) | git 기반 |
| CI/CD | 불가 | 가능 |
| 이 과정 | S33~S39 기초 실습 | S40~S42 KyoboNFT 구현·배포 |

S33~S39에서는 Remix로 빠르게 개념을 확인한다. S40부터 실제 Phase 1 코드 구조에서 Hardhat을 사용한다.

---

### 7. Phase 1과의 연결 — 우리가 만들 컨트랙트 (8분)

M2~M5에서 구현한 흐름을 기억하자:

```
앱 이벤트 → 조건 판단(M5) → VASP 요청(M3) → [???] → DMZ 콜백(M2) → 원장(M4)
```

`[???]` 자리가 스마트컨트랙트다. VASP가 `KyoboNFT.mint()`를 호출하면 온체인에 NFT가 기록되고, VASP는 그 결과(txHash)를 우리 시스템에 콜백으로 전달한다.

```
M5 VaspAdapter.submitMint()
  → VASP 서버
    → KyoboNFT.mint(to, tokenId, amount)   ← M6~M7에서 이것을 만든다
      → NFTIssued 이벤트 발행
        → M2 WebhookReceiver 수신
          → M4 원장 업데이트
```

M3에서 만든 TX 상태머신이 추적하는 txHash가 바로 이 `mint()` 트랜잭션의 해시다. M6~M7이 끝나면 Phase 1 전체 흐름이 처음으로 완결된다.

**우리가 만들 KyoboNFT의 핵심 구조 미리보기:**

```solidity
contract KyoboNFT is ERC1155Upgradeable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    //      ↑ keccak256 해시값 = 256비트 = bytes32
    //      ↑ 이것이 EVM이 256비트 워드를 쓰는 이유

    function mint(address to, uint256 tokenId, uint256 amount, bytes memory data)
        public onlyRole(MINTER_ROLE) {  // ← 접근 제어: MINTER_ROLE 없으면 revert
        _mint(to, tokenId, amount, data);
        emit NFTIssued(to, tokenId, amount);  // ← M2가 이 이벤트를 감청
    }
}
```

S33~S39에서 이 코드를 이해하는 데 필요한 모든 개념을 배운다.

---

## 실습 파트 (10분)

### 실습 1: Remix에서 첫 컨트랙트 배포 + view vs 트랜잭션 차이 확인 (5분)

**① Remix 접속 + 파일 생성**

브라우저에서 https://remix.ethereum.org 접속.  
좌측 파일 탐색기 → `contracts/` 폴더 → 새 파일 → `Hello.sol`

**② 코드 작성 + 컴파일 + 배포**

위 강의 파트의 `Hello` 컨트랙트 코드 그대로 작성.  
Solidity Compiler 탭 → Compiler 버전 `0.8.20` 선택 → `Compile Hello.sol` → 초록 체크 확인.  
Deploy & Run 탭 → Environment: `Remix VM (Cancun)` → `Deploy`.

**③ view vs 트랜잭션 차이 직접 확인**

```
greet()                      → 하단 로그: [call]                   ← gas 없음, 즉시 반환
sayHello()                   → 하단 로그: [vm] gas used: 27xxx     ← 트랜잭션
setGreeting("안녕, 교보!")    → 하단 로그: [vm] gas used: 약 34xxx  ← 상태 변경 트랜잭션
greet() 다시                 → "안녕, 교보!" 반환                   ← 상태변수 변경 확인
```

**④ ABI 직접 확인**

Solidity Compiler 탭 → `Compilation Details` 버튼 → ABI 탭 → JSON 구조 확인.  
M7에서 ethers.js가 이 ABI를 그대로 사용한다는 것을 미리 연결해준다.

---

### 실습 2: Gas 소비 실험 — storage vs memory (3분)

Remix에 새 파일 `GasTest.sol` 생성:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract GasTest {
    uint256 public storedValue;

    // storage 쓰기 — gas 많이 소비
    function writeStorage(uint256 value) public {
        storedValue = value;  // SSTORE: 20,000 gas (첫 쓰기)
    }

    // memory만 사용 — gas 적게 소비
    function computeOnly(uint256 a, uint256 b) public pure returns (uint256) {
        uint256 result = a + b;  // 스택/메모리만, SSTORE 없음
        return result;
    }

    // storage를 비효율적으로 읽는 예
    function inefficientRead() public view returns (uint256) {
        // storedValue를 두 번 읽음 (실제로는 캐싱해야 함)
        if (storedValue > 0) {
            return storedValue;  // 2번째 SLOAD: 100 gas (첫 번째: 2100)
        }
        return 0;
    }
}
```

배포 후 Remix에서 각 함수 호출 → `gas used` 값 비교:

```
writeStorage(42)    → gas used: ~43,000 (SSTORE 20,000 포함)
computeOnly(3, 5)   → gas used: ~21,400 (기본 21,000만)
```

---

### 실습 3: 함수 선택자 직접 계산 (2분)

Remix Console (하단 터미널)에서:

```javascript
// Remix 브라우저 콘솔에서는 web3 객체 사용
const sig = "greet()";
const hash = web3.utils.keccak256(sig);
console.log("keccak256:", hash);
console.log("selector:", hash.slice(0, 10));
// → "0xcfae3217"

// mint 함수 선택자
const mintSig = "mint(address,uint256,uint256,bytes)";
const mintHash = web3.utils.keccak256(mintSig);
console.log("mint selector:", mintHash.slice(0, 10));
// → "0x731133e9"
```

수강생이 직접 계산한 선택자를 Remix에서 실제 calldata와 비교하면서 ABI 인코딩의 실체를 확인한다.

---

## 완료 기준

- [ ] Remix에서 Hello.sol 컴파일 + 배포 성공
- [ ] `greet()` [call] vs `sayHello()` [vm] 로그 차이 직접 확인
- [ ] `setGreeting()` 후 상태변수 변경 확인
- [ ] "Gas가 필요한 이유 3가지" 설명 가능
- [ ] "ABI가 무엇이며 왜 필요한가" 설명 가능
- [ ] "스마트컨트랙트가 Phase 1 흐름에서 어디에 위치하는가" 설명 가능
- [ ] GasTest.sol에서 storage write vs pure 함수의 gas 차이 확인
- [ ] 함수 선택자 계산 원리 이해 (`keccak256` 앞 4바이트)

---

## 강사 노트

**반드시 이해시킬 것 하나:**  
"트랜잭션 = 함수 호출" — M3에서 구현한 TX 상태머신이 결국 이 함수 호출의 결과를 추적하는 것임을 연결해 줄 것. 수강생들이 이미 구현한 코드와 연결되면 동기부여가 올라간다.

**흔한 혼동 1 — view vs 트랜잭션:**  
`view` 함수 호출은 gas가 없다 → "그럼 왜 ETH가 필요하냐"는 질문이 나온다. 상태를 **변경**하는 함수만 트랜잭션이 필요하고 gas가 소비된다고 명확히 설명할 것. `sayHello()`는 event emit을 하므로 트랜잭션 필요.

**흔한 혼동 2 — memory 키워드:**  
"왜 `returns (string memory)`라고 써야 하냐?" → string, bytes, 배열 같은 참조 타입은 데이터 위치를 명시해야 한다. 기본 타입(uint256, address, bool)은 위치 명시 불필요. EVM 저장 공간 구조에서 설명한 4가지 공간과 연결하면 이해가 빠르다.

**흔한 혼동 3 — gas 환불:**  
Out of Gas 발생 시 "gas 환불 안 되냐?"고 묻는다. 노드가 실제로 연산을 했으므로 환불 없다. 하지만 gasLimit을 **초과하지 않으면** 남은 gas는 환불된다. gasLimit = 소비한 gas + 환불된 gas.

**ABI 설명 팁:**  
Remix 컴파일 후 Compilation Details 버튼 → ABI 탭에서 JSON을 직접 보여줄 것. M7에서 ethers.js가 이 ABI를 그대로 사용한다고 미리 연결.

**실습 중 Remix가 느릴 경우:**  
Environment를 `Remix VM (Cancun)` 또는 `Remix VM (London)`으로 설정. 네트워크 연결 불필요, 로컬에서 실행됨.

**수강생 수준에 따른 조절:**  
- 기초 수준: 함수 선택자 실습(실습 3)은 생략 가능. 개념 설명만.
- 심화 수준: GasTest.sol의 `inefficientRead()`에서 로컬 캐싱 패턴으로 개선하는 실습 추가 가능.
