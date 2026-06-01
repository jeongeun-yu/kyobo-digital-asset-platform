# M8 · S44 — Slither 정적 분석 : HIGH/MEDIUM 0건 달성

> **강의노트 깊이 기준** : 강사가 50분 수업을 자신있게 소화하기 위한 120분 수준 배경지식 포함.  
> `[강사 배경]` 섹션은 수업 슬라이드에 넣지 않아도 되지만 반드시 숙지해야 하는 내용이다.  
> `[강의]` 표시 항목이 실제 수업에서 전달할 내용이다.

---

## 세션 개요

| 항목 | 내용 |
|---|---|
| 모듈 | M8 — 스마트컨트랙트 보안 |
| 세션 | S44 |
| 전달 시간 | 강의 20분 + 실습 40분 |
| 선행 지식 | S43 (Reentrancy · tx.origin · Access Control 원리 이해) |
| 이 세션의 목표 | Slither를 설치·실행해 Phase 1 코드의 HIGH/MEDIUM 0건 달성, 각 경고의 원인과 수정법을 설명할 수 있다 |

---

## 이 세션의 핵심 메시지

> **보안 감사의 첫 단계는 자동화 도구다.**  
> 전문 감사 회사도 코드를 받으면 가장 먼저 Slither를 돌린다.  
> HIGH/MEDIUM이 남아 있는 코드는 외부 감사조차 시작하지 않는다.  
> 자동화 도구로 명백한 결함을 제거한 다음, 도구가 못 잡는 논리적 취약점을 수동 리뷰한다.

---

## [강사 배경] 스마트컨트랙트 보안 도구 생태계 전체 지형

강의에서 "Slither 하나만 있는 게 아니다"는 것을 학생들이 알아야 맥락이 잡힌다.

### 도구 유형과 원리

| 도구 | 유형 | 원리 | 장점 | 한계 |
|---|---|---|---|---|
| **Slither** | 정적 분석 | AST + CFG + 데이터플로우 | 빠름(초 단위), False Positive 적음 | 런타임 상태 모름 |
| **Mythril** | 심볼릭 실행 | 바이트코드 + SMT solver (Z3) | 복잡한 실행 경로 탐색 | 느림(분~시간), 타임아웃 빈번 |
| **Echidna** | Property Fuzzing | 속성 기반 무작위 입력 | 예상치 못한 경계값 탐지 | 불변식(property)을 직접 작성해야 함 |
| **Foundry Fuzz** | 파라미터 Fuzzing | 함수 파라미터 무작위화 | Hardhat보다 빠른 테스트 환경 | Echidna보다 탐색 범위 제한 |
| **MythX** | 클라우드 서비스 | Mythril + Harvey + Maru 조합 | 자동화된 감사 리포트 생성 | 유료, 소스 공개 필요 |
| **Code4rena / Sherlock** | 크라우드소싱 감사 | 다수 보안 연구원 경쟁 | 광범위한 커버리지, 논리 취약점 포착 | 비용 $20K~$500K |

**실무 순서**: Slither(30분) → Mythril(필요시, 2~4시간) → 수동 리뷰(3~10일) → Echidna(DeFi 불변식, 선택) → 외부 감사(큰 프로토콜만)

### [강사 배경] 심볼릭 실행(Mythril)이란

Slither와 원리가 완전히 다르므로 비교 이해가 필요하다.

```
심볼릭 실행의 개념:
    일반 실행: x = 5 → x + 3 = 8 (구체적 값)
    심볼릭 실행: x = 심볼 → x + 3 = 심볼 + 3 (가능한 모든 값)

Mythril 동작:
    1. EVM 바이트코드를 해석
    2. 각 변수를 "모든 가능한 값"으로 설정
    3. SMT solver(Z3)로 "이 조건이 참이 될 수 있는 입력이 존재하는가?" 질의
    4. 존재하면 → 취약점 + 예시 입력값 리포트

장점: 코드를 실행하지 않고도 복잡한 경로 모두 탐색
단점: 경로가 폭발적으로 늘어남(Path Explosion) → 타임아웃
```

### [강사 배경] Echidna Fuzzing이란

```solidity
// Echidna 불변식 예시
contract EchidnaTest {
    KyoboNFT nft;
    
    constructor() {
        nft = new KyoboNFT();
        nft.initialize(address(this));
    }
    
    // "어떤 입력을 줘도 이 함수는 항상 true를 반환해야 한다"
    function echidna_balance_never_negative() public view returns (bool) {
        return nft.balanceOf(address(this), 1) >= 0; // uint이므로 항상 참
    }
    
    function echidna_total_supply_consistent() public view returns (bool) {
        // 발행량 = 소각량 + 현재 잔액 (도메인 불변식)
        return true; // 실제로는 복잡한 회계 검증
    }
}
// Echidna가 수천 번 랜덤 입력으로 이 함수를 호출해 false가 나오면 버그 발견
```

---

## [강사 배경] Slither 내부 동작 원리 심층

### 5단계 분석 파이프라인

```
Solidity 소스 (.sol)
    │
    ▼ 1단계: solc 컴파일 (AST 추출)
    │   solc --ast-compact-json 실행
    │   출력: 각 노드별 타입·변수·함수 정보가 담긴 JSON
    │   예: { "nodeType": "FunctionDefinition", "name": "mint", ... }
    │
    ▼ 2단계: crytic-compile (멀티 프레임워크 지원)
    │   Hardhat / Truffle / Foundry / Brownie 프로젝트 자동 감지
    │   import 경로, 라이브러리 링크 자동 처리
    │
    ▼ 3단계: SlithIR 변환 (내부 중간 표현)
    │   AST → SlithIR (SSA, Static Single Assignment 형태)
    │   모든 변수를 단 한 번만 할당하는 형태로 재작성
    │   이유: 데이터플로우 분석이 훨씬 단순해짐
    │
    ▼ 4단계: 제어 흐름 그래프(CFG) + 데이터플로우 분석
    │   CFG: 코드의 실행 경로를 노드(기본 블록) + 엣지(분기)로 표현
    │   데이터플로우: 변수 값이 어떤 경로로 흐르는가
    │   Taint Analysis: "사용자 입력이 위험한 함수에 도달할 수 있는가?"
    │
    ▼ 5단계: 디텍터 실행 (80+개 Python 클래스)
        각 디텍터: AbstractDetector를 상속한 Python 클래스
        CFG + 데이터플로우 분석 결과를 쿼리해 패턴 매칭
        결과: HIGH / MEDIUM / LOW / INFORMATIONAL / OPTIMIZATION
```

### 디텍터가 Python 클래스인 이유의 의미

Slither 디텍터는 GitHub에 오픈소스로 공개되어 있다.  
→ 커스텀 디텍터를 직접 작성해 프로젝트 특화 분석 가능.  
→ 감사 회사들은 자체 디텍터를 추가해 경쟁 우위 확보.

```python
# 커스텀 디텍터 구조 (참고용)
from slither.detectors.abstract_detector import AbstractDetector, DetectorClassification

class MissingMinterCheck(AbstractDetector):
    ARGUMENT = "missing-minter-check"
    HELP = "Functions that should require MINTER_ROLE but don't"
    IMPACT = DetectorClassification.HIGH
    CONFIDENCE = DetectorClassification.MEDIUM

    def _detect(self):
        results = []
        for contract in self.compilation_unit.contracts:
            for function in contract.functions:
                if "mint" in function.name.lower():
                    if not any("MINTER_ROLE" in str(m) for m in function.modifiers):
                        results.append(self.generate_result([function]))
        return results
```

---

## [강의] Slither 심각도 분류와 판단 기준

### 5단계 심각도

| 단계 | 의미 | 대응 방침 |
|---|---|---|
| **HIGH** | 즉각적 자산 손실 또는 컨트랙트 장악 가능 | 무조건 수정, 배포 전 0건 필수 |
| **MEDIUM** | 조건부 익스플로잇 가능 또는 잘못된 설계 패턴 | 원인 파악 후 수정 또는 False Positive 문서화 |
| **LOW** | 좋지 않은 패턴, 잠재적 문제 | 가능하면 수정, 사유 설명 |
| **INFORMATIONAL** | 코드 품질 개선 권고 | 선택적 대응 |
| **OPTIMIZATION** | gas 최적화 제안 | 선택적 대응 |

**실무 배포 기준**: HIGH = 0, MEDIUM = 0 이 최소 요건. LOW는 False Positive 판별 후 문서화.

---

## [강사 배경] 주요 디텍터 전체 — 원리와 취약 코드 예시

각 디텍터가 어떤 코드 패턴에서 발동하는지 이해해야 Phase 1 결과를 해석할 수 있다.

### HIGH 디텍터

#### `reentrancy-eth`

외부 `.call{value:}()` 실행 전 상태 변경이 없는 경우.

```solidity
// ❌ 발동 패턴
function withdraw(uint256 amount) external {
    require(balances[msg.sender] >= amount);
    (bool ok,) = msg.sender.call{value: amount}(""); // 외부 호출 먼저
    require(ok);
    balances[msg.sender] -= amount; // 상태 나중 → HIGH
}

// ✅ 수정 (CEI)
function withdraw(uint256 amount) external {
    require(balances[msg.sender] >= amount);
    balances[msg.sender] -= amount; // 상태 먼저
    (bool ok,) = msg.sender.call{value: amount}("");
    require(ok);
}
```

#### `reentrancy-no-eth`

ETH를 전송하지 않더라도 외부 호출 후 상태 변경이 있는 경우.

```solidity
// ❌ 발동 패턴
function claimReward(address token) external {
    IERC20(token).transfer(msg.sender, rewards[msg.sender]); // 외부 호출
    rewards[msg.sender] = 0; // 상태 나중 → MEDIUM (ETH 없으면 MEDIUM)
}
```

#### `unprotected-upgrade`

`upgradeTo` 또는 `_authorizeUpgrade`가 보호되지 않은 경우.

```solidity
// ❌ 발동 패턴
contract VulnerableProxy is UUPSUpgradeable {
    function _authorizeUpgrade(address) internal override {
        // 아무 검증 없음 → 누구나 업그레이드 가능 → HIGH
    }
}

// ✅ 수정
function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
```

#### `suicidal`

`selfdestruct`를 누구나 호출 가능한 경우.

```solidity
// ❌ 발동 패턴
function emergencyKill() external { // onlyOwner 없음
    selfdestruct(payable(msg.sender)); // → HIGH
}
```

#### `arbitrary-send-eth`

ETH 전송 대상 주소가 사용자 입력으로 제어되는 경우.

```solidity
// ❌ 발동 패턴
function sendFunds(address payable to, uint256 amount) external {
    // to 주소를 사용자가 임의 지정 가능
    to.transfer(amount); // → HIGH
}
```

#### `msg-value-loop`

루프 안에서 `msg.value`를 누적 사용하는 경우.  
`msg.value`는 함수 호출 1회당 하나인데, 루프에서 반복 사용하면 동일한 값이 여러 번 계산된다.

```solidity
// ❌ 발동 패턴
function multiDeposit(address[] calldata recipients) external payable {
    for (uint256 i = 0; i < recipients.length; i++) {
        balances[recipients[i]] += msg.value; // 매 반복마다 같은 msg.value → HIGH
    }
}

// ✅ 수정
function multiDeposit(address[] calldata recipients) external payable {
    uint256 perRecipient = msg.value / recipients.length;
    for (uint256 i = 0; i < recipients.length; i++) {
        balances[recipients[i]] += perRecipient;
    }
}
```

---

### MEDIUM 디텍터

#### `missing-zero-check`

주소 파라미터에 `address(0)` 검증이 없는 경우.  
`address(0)`을 관리자로 설정하면 해당 역할을 영구적으로 잃는다.

```solidity
// ❌ 발동 패턴
function transferAdmin(address newAdmin) external onlyOwner {
    owner = newAdmin; // newAdmin == address(0)이면 관리권 영구 상실 → MEDIUM
}

// ✅ 수정
function transferAdmin(address newAdmin) external onlyOwner {
    require(newAdmin != address(0), "zero address");
    owner = newAdmin;
}
```

#### `dangerous-tx.origin`

인증 목적으로 `tx.origin` 사용.

```solidity
// ❌ 발동 패턴 → MEDIUM
require(tx.origin == owner, "not owner");

// ✅ 수정
require(msg.sender == owner, "not owner");
```

#### `divide-before-multiply`

정수 나눗셈 후 곱셈 → 정밀도 손실.

```solidity
// ❌ 발동 패턴
uint256 fee = amount / 100 * feeRate; // 먼저 나누면 소수점 버림 → MEDIUM

// ✅ 수정
uint256 fee = amount * feeRate / 100; // 곱셈 먼저
```

**이유**: Solidity 정수 나눗셈은 소수점을 버린다.  
`5 / 100 = 0` → `0 * feeRate = 0` (수수료 전혀 안 걷힘)  
`5 * feeRate / 100` → `5 * 3 / 100 = 0` (이것도 작은 수에서 발생하지만 훨씬 정확)

#### `tautology`

항상 참 또는 항상 거짓인 조건.

```solidity
// ❌ 발동 패턴
uint256 x = ...;
require(x >= 0, "must be positive"); // uint는 항상 ≥ 0 → 항상 참 → MEDIUM
// 의미 없는 조건, 코드 의도를 잘못 표현

// 실수 예시: 음수 체크를 의도했다면
require(x > 0, "must be positive"); // 0 제외 필요했던 것
```

#### `calls-loop`

루프 안에서 외부 컨트랙트를 호출하는 경우.

```solidity
// ❌ 발동 패턴
function distributeRewards(address[] calldata users) external {
    for (uint256 i = 0; i < users.length; i++) {
        token.transfer(users[i], rewards[users[i]]); // 외부 호출 → MEDIUM
    }
}
```

**위험**: (1) 한 명이 revert하면 전체 배치 실패, (2) 배열이 크면 gas limit 초과.  
**대안**: Pull 패턴 — 사용자가 직접 `claimReward()` 호출.

#### `locked-ether`

ETH를 받을 수 있지만 꺼낼 방법이 없는 경우.

```solidity
// ❌ 발동 패턴
contract EtherTrap {
    receive() external payable {} // ETH 수신 가능

    // 출금 함수 없음 → ETH 영구 잠김 → MEDIUM
}
```

#### `incorrect-equality`

`==` 을 사용했지만 `>=` 를 써야 하는 경우.

```solidity
// ❌ 발동 패턴
require(block.timestamp == deadline, "not deadline");
// block.timestamp는 정확히 일치하는 순간이 없을 수 있음 → MEDIUM

// ✅ 수정
require(block.timestamp >= deadline, "not yet");
```

---

### LOW 디텍터

#### `events-access`

접근 제어 변경(역할 부여·해제, 주소 변경) 시 이벤트를 emit하지 않는 경우.

```solidity
// ❌ 발동 패턴
function updateOracle(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
    oracle = IOracle(newOracle); // 이벤트 없음 → LOW
}

// ✅ 수정
event OracleUpdated(address indexed oldOracle, address indexed newOracle);

function updateOracle(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
    emit OracleUpdated(address(oracle), newOracle);
    oracle = IOracle(newOracle);
}
```

**왜 중요한가**: 이벤트가 없으면 모니터링 시스템이 중요 설정 변경을 탐지할 수 없다.

#### `low-level-calls`

`.call()` 사용 시 발동. 리턴값 처리 여부와 무관하게 경고.

```solidity
// ❌ 발동 패턴
(bool ok,) = recipient.call{value: amount}("");
// low-level-calls → LOW (CEI 적용됐어도 경고)
```

**대응**: 대부분 False Positive. CEI + ReentrancyGuard 이미 적용된 경우 억제.

#### `missing-inheritance`

인터페이스를 implement했지만 `is Interface` 선언이 없는 경우.

```solidity
// ❌ 발동 패턴
contract MyToken {
    function transfer(address, uint256) external returns (bool) { ... }
    // IERC20를 구현했지만 is IERC20 선언 없음 → LOW
}

// ✅ 수정
contract MyToken is IERC20 {
    function transfer(address, uint256) external override returns (bool) { ... }
}
```

#### `shadowing-state`

지역 변수가 상태 변수와 같은 이름인 경우.

```solidity
// ❌ 발동 패턴
contract Shadowing {
    address public owner; // 상태 변수

    function setOwner(address owner) external { // 파라미터가 상태 변수 가림 → LOW
        owner = owner; // 자기 자신에게 대입, 상태 변수 변경 안 됨!
    }
}

// ✅ 수정
function setOwner(address _owner) external {
    owner = _owner;
}
```

---

### INFORMATIONAL / OPTIMIZATION 디텍터

#### `constable-states`

배포 후 변경되지 않는 변수를 `constant`로 선언하면 gas 절약.

```solidity
// ❌ OPTIMIZATION 발동
uint256 public MAX_BATCH_SIZE = 500;

// ✅ gas 절약 (SLOAD 대신 컴파일 타임 상수)
uint256 public constant MAX_BATCH_SIZE = 500;
```

#### `immutable-states`

생성자에서만 설정되는 변수를 `immutable`로 선언하면 gas 절약.

```solidity
// ❌ OPTIMIZATION 발동
address public owner;
constructor() { owner = msg.sender; }

// ✅ gas 절약 (storage 슬롯 대신 bytecode에 인라인)
address public immutable owner;
constructor() { owner = msg.sender; }
```

**차이**: `constant`는 컴파일 타임 리터럴, `immutable`은 배포 시 설정 후 불변.

#### `naming-convention`

Solidity 컨벤션 위반. 함수는 camelCase, 변수도 camelCase, 상수는 ALL_CAPS, 이벤트는 PascalCase.

---

## [강사 배경] False Positive 판별 방법론

전문 감사에서 False Positive 비율 약 20~40%(LOW/INFORMATIONAL 기준).  
HIGH/MEDIUM의 False Positive는 드물지만 UUPS/프록시 패턴에서 자주 발생한다.

### 판별 질문 체크리스트

| 질문 | 아니오이면 |
|---|---|
| 공격자가 해당 함수를 실제로 호출할 수 있는가? | False Positive 가능 |
| 기존 modifier/guard로 이미 방어되지 않는가? | False Positive 가능 |
| 공격 전제조건이 현실적으로 충족 가능한가? | False Positive 가능 |
| 피해(자산 손실, 권한 탈취)가 실제로 발생하는가? | False Positive 가능 |

### 억제 문법

```solidity
// 방법 1: 줄 단위 억제 (가장 일반적)
// slither-disable-next-line missing-zero-check
function foo(address x) external { ... }

// 방법 2: 블록 억제
// slither-disable-start calls-loop
for (uint256 i = 0; i < n; ) {
    _mint(to[i], id[i], amount[i], "");
    unchecked { ++i; }
}
// slither-disable-end calls-loop

// 방법 3: 파일 전체 억제 (최상단)
// slither-disable-file calls-loop
```

**반드시 주석에 이유를 명시해야 한다**:

```solidity
// slither-disable-next-line calls-loop
// 수령인은 항상 보험가입자 EOA — 컨트랙트 수령인 없음.
// Phase 1 mintBatch 수령인은 NFTIssuanceService에서 검증된 주소만 전달됨.
for (uint256 i = 0; i < to.length; ) { ... }
```

이유 없는 억제 주석은 감사에서 즉시 지적 대상이다.

---

## [강의] Phase 1 코드 실제 Slither 분석

### 실행 환경 설정

```bash
# blockchain/ 루트에서
pip install slither-analyzer
solc-select install 0.8.20
solc-select use 0.8.20

# 의존성 제외하고 운영 코드만 분석
slither src/ \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --exclude-dependencies \
  --filter-paths "test,mock"
```

---

### KyoboNFT.sol — 예상 결과 + 수정

#### 결과 1 : `missing-zero-check` MEDIUM — initialize의 admin

```
KyoboNFT.initialize(address).admin (src/rewards/KyoboNFT.sol#56)
lacks a zero-check on :
    _grantRole(DEFAULT_ADMIN_ROLE,admin) (src/rewards/KyoboNFT.sol#61)
```

**왜 위험한가**: `address(0)`을 DEFAULT_ADMIN_ROLE로 설정하면 아무도 역할을 부여·해제할 수 없다. 컨트랙트 배포 직후 영구 lock.

**수정**:
```solidity
function initialize(address admin) public initializer {
    require(admin != address(0), "KyoboNFT: admin is zero address");
    __ERC1155_init("");
    __AccessControl_init();
    __Pausable_init();
    _grantRole(DEFAULT_ADMIN_ROLE, admin);
    _grantRole(MINTER_ROLE,        admin);
    _grantRole(PAUSER_ROLE,        admin);
    _grantRole(UPGRADER_ROLE,      admin);
}
```

#### 결과 2 : `calls-loop` MEDIUM — mintBatch 루프 내 외부 호출

```
KyoboNFT.mintBatch() (src/rewards/KyoboNFT.sol#130)
has external calls inside a loop:
    _mint(to[i],tokenIds[i],amounts[i],"") (src/rewards/KyoboNFT.sol#142)
```

**왜 발동하는가**: OZ `_mint()` 내부에서 `_doSafeTransferAcceptanceCheck()`가 실행된다. 수신자가 컨트랙트이면 `onERC1155Received()` 콜백이 발동 → 루프 안 외부 호출.

```solidity
// OZ ERC1155 내부 흐름 (단순화)
function _mint(address to, uint256 id, uint256 value, bytes memory data) internal {
    _balances[id][to] += value;
    emit TransferSingle(...);
    _doSafeTransferAcceptanceCheck(...); // ← 여기서 외부 호출 가능성
}

function _doSafeTransferAcceptanceCheck(...) private {
    if (to.code.length > 0) { // to가 컨트랙트이면
        IERC1155Receiver(to).onERC1155Received(...); // ← 외부 호출
    }
}
```

**Phase 1 판단**: **False Positive에 가깝다**. 수령인은 항상 보험가입자 EOA이며, NFTIssuanceService에서 검증된 주소만 전달된다. 그러나 코드 자체는 컨트랙트 주소를 막지 않으므로 억제 + 이유 주석.

**수정**:
```solidity
function mintBatch(
    address[] calldata to,
    uint256[] calldata tokenIds,
    uint256[] calldata amounts
) external onlyRole(MINTER_ROLE) whenNotPaused {
    require(
        to.length == tokenIds.length && tokenIds.length == amounts.length,
        "KyoboNFT: length mismatch"
    );
    // slither-disable-next-line calls-loop
    // 수령인은 항상 보험가입자 EOA. 컨트랙트 수령인 없음 → onERC1155Received 불호출.
    // NFTIssuanceService가 calldata 전달 전 EOA 여부를 검증함.
    for (uint256 i = 0; i < to.length; ) {
        _mint(to[i], tokenIds[i], amounts[i], "");
        unchecked { ++i; } // gas 최적화: i < to.length 보장이므로 overflow 불가
    }
}
```

#### 결과 3 : LOW — burn의 whenNotPaused 누락

```
KyoboNFT.burn() does not have whenNotPaused modifier
while mint() and mintBatch() have it. Possible inconsistency.
```

**Phase 1 판단**: **의도적 설계**. 서비스 일시정지(pause) 중에도 MINTER_ROLE이 만료 NFT를 소각할 수 있어야 한다. 주석으로 의도 명시.

```solidity
/// @dev whenNotPaused 미적용: 의도적 결정.
///      pause 중에도 운영팀의 만료 토큰 소각, 컴플라이언스 회수 작업이 필요함.
function burn(
    address from,
    uint256 tokenId,
    uint256 amount
) external onlyRole(MINTER_ROLE) {
    _burn(from, tokenId, amount);
}
```

---

### NFTIssuer.sol — 예상 결과 + 수정

#### 결과 4 : `missing-zero-check` MEDIUM — constructor 주소 파라미터

```
NFTIssuer.constructor(address,address).nft_    lacks a zero-check
NFTIssuer.constructor(address,address).oracle_ lacks a zero-check
```

**왜 위험한가**: `nft_ = address(0)`으로 배포하면 모든 `nft.mint()` 호출이 address(0) 컨트랙트 호출 → 함수 없으므로 모든 발행 실패. 재배포 필요.

**수정**:
```solidity
constructor(address nft_, address oracle_) {
    require(nft_    != address(0), "NFTIssuer: nft is zero address");
    require(oracle_ != address(0), "NFTIssuer: oracle is zero address");
    nft    = KyoboNFT(nft_);
    oracle = IOracle(oracle_);
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(OPERATOR_ROLE, msg.sender);
}
```

#### 결과 5 : `events-access` LOW — updateOracle / updateNFT 이벤트 없음

```
NFTIssuer.updateOracle(address) should emit an event for state variable change.
NFTIssuer.updateNFT(address) should emit an event for state variable change.
```

**왜 중요한가**: 오라클 주소가 바뀌었는데 이벤트가 없으면 체인 모니터링 시스템이 감지 불가. 악의적 관리자가 오라클을 바꿔치기해도 알 수 없다.

**수정**:
```solidity
// contract 선언 바로 아래에 추가
event OracleUpdated(address indexed previousOracle, address indexed newOracle);
event NFTUpdated(address indexed previousNFT, address indexed newNFT);

function updateOracle(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(newOracle != address(0), "NFTIssuer: zero address");
    emit OracleUpdated(address(oracle), newOracle);
    oracle = IOracle(newOracle);
}

function updateNFT(address newNFT) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(newNFT != address(0), "NFTIssuer: zero address");
    emit NFTUpdated(address(nft), newNFT);
    nft = KyoboNFT(newNFT);
}
```

---

## [강사 배경] 전문 보안 감사 회사의 프로세스

### Trail of Bits / OpenZeppelin Security 기준 감사 일정

```
Day 1~2: 자동화 스캔
    └─ Slither 전체 실행 → 결과 트리아지
    └─ Mythril 심볼릭 실행 (복잡 경로, 타임아웃 제한)
    └─ Echidna 불변식 작성 + 퍼징 시작

Day 3~10: 수동 리뷰
    ├─ 비즈니스 로직 검토 (도메인 지식 필요)
    ├─ 경제적 공격 모델링 (플래시론, MEV, 오라클 조작)
    ├─ 접근 제어 정책의 적절성 (역할 설계가 의도에 맞는가)
    ├─ 업그레이드 경로 안전성 (스토리지 충돌 가능성)
    └─ 의존성 감사 (OZ 버전, 외부 오라클)

Day 11~12: 리포트 작성
    ├─ Critical / High / Medium / Low / Informational
    ├─ 각 항목: 설명 / 위험 / 공격 시나리오 / 권장 수정
    └─ Appendix: 범위, 방법론, 도구

Day 13~14: 클라이언트 수정 후 재감사 (Fix Verification)
    └─ 수정 사항 검증 → "감사 통과" 인증서 발급
```

### Slither가 절대 잡지 못하는 것들

이것을 알아야 "Slither 0건 = 안전한 코드"가 아님을 이해할 수 있다.

| 유형 | 예시 | 이유 |
|---|---|---|
| **비즈니스 로직 결함** | 수수료 계산이 도메인 규칙에 맞는가 | 도메인 지식이 없으면 판단 불가 |
| **경제적 공격** | 플래시론으로 가격 조작 후 청산 | 여러 컨트랙트 간 상호작용 필요 |
| **거버넌스 리스크** | TimeLock 없는 즉각 업그레이드 | "이게 맞는 정책인가"는 판단 불가 |
| **외부 의존성 리스크** | Chainlink 오라클 중단 시나리오 | 외부 시스템 상태를 모름 |
| **접근 제어 정책 적절성** | 역할 부여 정책이 운영 의도에 맞는가 | 정책 문서와 비교 필요 |
| **MEV 공격** | 트랜잭션 순서 조작(샌드위치) | 멤풀 레벨 공격 |

---

## [강사 배경] .slither.config.json 설정과 CI 통합

### 설정 파일

```json
// blockchain/.slither.config.json
{
    "detectors_to_exclude": [
        "naming-convention",
        "solc-version",
        "too-many-digits"
    ],
    "filter_paths": [
        "test",
        "mocks",
        "node_modules"
    ],
    "exclude_dependencies": true,
    "solc_remaps": [
        "@openzeppelin=node_modules/@openzeppelin"
    ]
}
```

### GitHub Actions CI 통합

```yaml
# .github/workflows/slither.yml
name: Slither Analysis
on: [push, pull_request]

jobs:
  slither:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-python@v4
        with:
          python-version: '3.10'
      - name: Install Slither
        run: pip install slither-analyzer solc-select
      - name: Install solc
        run: solc-select install 0.8.20 && solc-select use 0.8.20
      - name: Install node deps
        run: cd blockchain && npm install
      - name: Run Slither
        run: |
          cd blockchain
          slither src/ \
            --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
            --exclude-dependencies \
            --filter-paths "test,mock" \
            --fail-on HIGH,MEDIUM  # HIGH/MEDIUM 있으면 CI 실패
```

이 설정을 넣으면 HIGH/MEDIUM이 남아 있는 PR은 머지 자체가 차단된다.

### slither-check-upgradeability

UUPS 업그레이드 안전성 별도 검사 도구.

```bash
slither-check-upgradeability . KyoboNFT --proxy-filename src/rewards/KyoboNFT.sol

# 출력 예시:
# [✓] No storage collision detected (KyoboNFT → KyoboNFTV2)
# [✓] initialize() is protected with initializer modifier
# [!] WARNING: New state variable 'baseURI' added at slot 4 — verify no collision
```

---

## [실습] 40분

### 목표

Phase 1 실제 코드(KyoboNFT.sol, NFTIssuer.sol)에 Slither를 실행하고 HIGH/MEDIUM을 수정해 0건을 달성한다.

### Step 1 : 설치 및 초기 실행 (8분)

```bash
cd blockchain/

# 설치
pip install slither-analyzer
pip install solc-select
solc-select install 0.8.20
solc-select use 0.8.20

# 실행 (처음에는 전체 결과 확인)
slither src/rewards/ \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --exclude-dependencies
```

**결과 기록 템플릿**:

| 파일 | 디텍터 | 심각도 | 줄 | 조치 결정 |
|---|---|---|---|---|
| KyoboNFT.sol | missing-zero-check | MEDIUM | L56 | 수정 |
| KyoboNFT.sol | calls-loop | MEDIUM | L142 | 억제 (EOA만 수령) |
| NFTIssuer.sol | missing-zero-check | MEDIUM | L48-49 | 수정 |
| NFTIssuer.sol | events-access | LOW | L145,149 | 수정 |

### Step 2 : KyoboNFT.sol 수정 (12분)

위 "결과 1, 2, 3" 수정 코드 적용.

```bash
# 수정 후 재확인
slither src/rewards/KyoboNFT.sol \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --exclude-dependencies \
  --detect missing-zero-check,calls-loop
# 기대: 0 results
```

### Step 3 : NFTIssuer.sol 수정 (12분)

위 "결과 4, 5" 수정 코드 적용.

```bash
slither src/rewards/NFTIssuer.sol \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --exclude-dependencies \
  --detect missing-zero-check,events-access
# 기대: 0 results
```

### Step 4 : 전체 재실행 + 최종 확인 (5분)

```bash
slither src/ \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --exclude-dependencies \
  --filter-paths "test,mock"

# HIGH 0건, MEDIUM 0건 확인
```

### Step 5 : Markdown 감사 리포트 생성 (3분)

```bash
mkdir -p docs
slither src/ \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --exclude-dependencies \
  --filter-paths "test,mock" \
  --checklist > docs/slither-final-report.md

echo "## 수정 이력
| 항목 | 수정 전 | 수정 후 |
|---|---|---|
| KyoboNFT.initialize | admin zero-check 없음 | require(admin != address(0)) 추가 |
| KyoboNFT.mintBatch | i++ | unchecked { ++i } + 억제 주석 |
| NFTIssuer.constructor | nft_/oracle_ zero-check 없음 | require 추가 |
| NFTIssuer.updateOracle | 이벤트 없음 | OracleUpdated 이벤트 추가 |
| NFTIssuer.updateNFT | 이벤트 없음 | NFTUpdated 이벤트 추가 |" >> docs/slither-final-report.md
```

---

## 강의 진행 순서 (50분 기준)

| 시간 | 내용 | 슬라이드 포인트 |
|---|---|---|
| 0~5분 | 오프닝: 전문 감사 회사가 맨 처음 하는 것 | "코드 받으면 30분 안에 HIGH/MEDIUM 목록 뽑는다" |
| 5~10분 | 보안 도구 생태계 비교 — Slither vs Mythril vs Echidna | 도구별 역할 한 줄 요약 |
| 10~15분 | Slither 원리 + 심각도 5단계 + 주요 디텍터 | calls-loop · missing-zero-check · reentrancy 예시 코드 |
| 15~20분 | False Positive 판별 기준 + 억제 문법 | 판별 4가지 질문 |
| 20~60분 | 실습: 설치 → 초기 결과 → 수정 → 재실행 → 0건 → 리포트 | |

---

## 다음 세션 예고 (S45)

Slither가 잡지 못하는 **논리적 보안 취약점**을 수동으로 테스트하는 법을 배운다.  
"공격자 관점의 테스트"가 기능 테스트와 어떻게 다른지 설계하고, M8 최종 보안 감사 리포트를 완성한다.

---

## 핵심 용어 정리

| 용어 | 한 줄 정의 |
|---|---|
| Slither | Trail of Bits 개발. Solidity 정적 분석 도구. AST+CFG 기반 80+ 디텍터 |
| 정적 분석 | 코드를 실행하지 않고 구조적으로 취약점을 탐지하는 방법 |
| 심볼릭 실행 | 변수를 구체적 값 대신 "가능한 모든 값"으로 처리해 경로를 탐색하는 분석 |
| Fuzzing | 무작위 입력을 수천~수백만 번 주입해 예상치 못한 버그를 찾는 방법 |
| AST | Abstract Syntax Tree — 소스코드를 트리 구조로 표현한 것 |
| CFG | Control Flow Graph — 코드 실행 경로를 그래프로 표현한 것 |
| False Positive | 도구가 취약점으로 보고했지만 실제로는 안전한 경우 |
| slither-disable | Slither 경고를 코드 레벨에서 억제하는 주석 — 반드시 이유 명시 |
| calls-loop | 루프 내 외부 호출 경고 — Phase 1 mintBatch에서 False Positive 판별 |
| missing-zero-check | 주소 파라미터에 address(0) 검증이 없다는 경고 |
| Trail of Bits | Slither 개발사, 세계 최고 수준의 스마트컨트랙트 보안 감사 회사 |
| solc-select | 여러 Solidity 컴파일러 버전을 전환하는 CLI 도구 |
