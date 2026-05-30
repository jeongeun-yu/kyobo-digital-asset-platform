# M7 S42 — UUPS 업그레이드 실습 — Storage Layout 규칙과 reinitializer

> 모듈 7 · 세션 42 · 1시간  
> 강의 40분 + 실습 20분  
> 실습 환경: Hardhat + Sepolia (S41에서 배포한 KyoboNFT v1)

---

## [강사 배경] — 120분 분량 심화 지식

> 이 섹션은 강의에서 직접 읽지 않는다. 수강생 질문에 즉시 답하고, 개념 설명에 자신감을 갖기 위한 배경이다.

### A. Storage Layout 자동 검증 도구 — 내부 동작 완전 이해

**`@openzeppelin/hardhat-upgrades`의 layout 검증 흐름:**

```
upgrades.upgradeProxy() 호출
         ↓
1. 현재 컨트랙트(KyoboNFTV2) 컴파일 → storage layout 추출
   각 상태변수: { label, type, slot, offset, contract }

2. .openzeppelin/sepolia.json에서 이전 layout 로드

3. 두 layout 비교:
   - 슬롯 번호가 같은 위치에 동일한 타입의 변수가 있는가?
   - 변수가 삭제되지 않았는가?
   - 변수 순서가 바뀌지 않았는가?

4. 비교 결과:
   - 이상 없음 → TX 실행 (구현체 배포 + upgradeToAndCall)
   - 이상 있음 → Error 출력, TX 실행 안 함 (체인에 변화 없음)

5. 성공 시 .openzeppelin/sepolia.json 업데이트
```

**허용되는 변경 vs 오류가 나는 변경:**

```
허용:
  - 새 변수를 기존 변수 "뒤에" 추가
  - 변수 이름 변경 (타입·슬롯이 같으면)
  - constant/immutable 추가 (슬롯 차지 안 함)

오류:
  - 기존 변수 삭제
  - 기존 변수 순서 변경
  - 기존 변수 타입 크기 변경 (uint256 → uint128)
  - 기존 변수를 삭제하고 새 변수로 교체 (같은 슬롯에 다른 타입)

감지 못하는 변경 (수동 검증 필요):
  - mapping의 value 타입 변경
    예: mapping(address => uint256) → mapping(address => uint128)
    슬롯 번호는 동일하므로 OZ가 오류를 내지 않음
    그러나 내부 데이터 인코딩이 달라져 기존 값을 잘못 읽음
  - struct 내부 필드 변경
```

**`unsafeAllow` 예외 처리:**  
드물게 OZ의 오류를 무시하고 진행해야 할 경우가 있다. 예를 들어 의도적으로 슬롯을 재배치하고 별도 마이그레이션 로직으로 데이터를 이전하는 경우.

```typescript
await upgrades.upgradeProxy(PROXY_ADDR, NewImpl, {
  unsafeAllow: ['delegatecall'],  // delegatecall 사용 허용
  unsafeSkipStorageCheck: true,   // storage 검증 건너뜀 (극히 위험)
});
```

`unsafeSkipStorageCheck`는 정말 위험하다. 검증을 건너뛰면 데이터 손상을 감지할 방법이 없다. 절대 프로덕션에서 사용하지 말 것.

**hardhat-storage-layout 플러그인:**

```bash
npm install --save-dev hardhat-storage-layout

# hardhat.config.ts에 추가
import 'hardhat-storage-layout';

# 실행
npx hardhat compile
npx hardhat storage-layout --contract KyoboNFT
```

출력 예시:
```
KyoboNFT:
| Name           | Slot | Offset | Type              | Contract      |
|----------------|------|--------|-------------------|---------------|
| _balances      | 0    | 0      | mapping(addr=>m)  | ERC1155       |
| _opApprovals   | 1    | 0      | mapping(addr=>m)  | ERC1155       |
| _roles         | 2    | 0      | mapping(bytes32)  | AccessControl |
| _paused        | 3    | 0      | bool              | Pausable      |
| _initialized   | 4    | 0      | uint64            | Initializable |
```

이 출력을 v1과 v2 모두에 대해 실행하고 비교하면, 어떤 슬롯에 어떤 변수가 있는지 숫자로 확인할 수 있다.

---

### B. `reinitializer(N)` 내부 동작 완전 이해

**`_initialized` 변수의 역할:**

```solidity
// Initializable.sol 내부 (단순화)
uint64 private _initialized;

modifier initializer() {
    require(_initialized == 0, "Already initialized");
    _initialized = 1;
    _;
}

modifier reinitializer(uint64 version) {
    require(_initialized < version, "Already initialized");
    _initialized = version;
    _;
}

function _disableInitializers() internal {
    _initialized = type(uint64).max;  // 2^64 - 1 = 18446744073709551615
    // 이후 모든 initializer/reinitializer 호출 차단
}
```

실제 OZ 구현에서는 `uint64`를 사용하지만 개념적으로 버전 카운터다.

**버전 N을 반드시 증가시켜야 하는 이유:**  
`reinitializer(2)`가 완료되면 `_initialized = 2`. 이후 `reinitializer(1)` 또는 `reinitializer(2)` 재호출 시 `_initialized < N` 조건이 false이므로 revert. 이전 버전 초기화로 "다운그레이드"하는 것을 방지한다.

**v3에서 reinitializer(3)이 필요한 이유:**  
v2에서 `_initialized = 2`. v3에서 `reinitializer(2)`를 쓰면 `2 < 2`가 false → revert. 반드시 `reinitializer(3)`으로 써야 한다.

**`_initializing` 플래그:**  
초기화 함수 실행 중에 다른 initializer가 호출되는 것을 허용하기 위한 재진입 플래그. `__ERC1155_init()`, `__AccessControl_init()` 같은 내부 초기화들이 체인 호출되는데, 이때 모두 `_initializing == true` 상태를 확인하고 `_initialized` 값을 무시한다.

---

### C. 프록시 주소 불변성의 실제 의미

**사용자 관점:**  
NFT를 보유한 사용자의 지갑에는 "KyoboNFT 프록시 주소"가 저장되어 있다. 업그레이드 후에도 동일한 주소이므로 사용자는 아무것도 할 필요가 없다. 새 기능(`uri()`, `version()`)은 자동으로 사용 가능해진다.

**프론트엔드 관점:**

```typescript
// 프론트엔드 코드 (업그레이드 전후 동일)
const KYOBO_NFT_ADDRESS = '0xAbCd...'; // 변하지 않음

// v1에서는 uri() 함수 없음
// v2 업그레이드 후 같은 주소로 uri() 호출 가능
const uri = await nft.uri(tokenId); // v2 업그레이드 후 작동
```

ABI만 v2로 업데이트하면 프록시 주소는 그대로 사용한다.

**Etherscan에서 "Read as Proxy":**  
프록시 주소로 접속하면 Etherscan이 현재 구현체의 ABI를 자동으로 읽어 "Read as Proxy" 탭에 표시한다. 업그레이드 후 새 함수(`uri`, `version`)가 자동으로 나타난다. 별도 설정 없이 투명하게 처리된다.

---

### D. 실제 업그레이드 사고 사례

**Compound Finance 업그레이드 버그 (2021년 9월):**

```
상황:
  Compound v2 Governor Bravo 컨트랙트 업그레이드
  새 버전에 분배 로직 버그가 있었음

결과:
  약 8천만 달러 상당의 COMP 토큰이
  오류 조건을 만족하는 사용자에게 과다 분배됨

원인:
  - 충분한 테스트 없이 mainnet 직접 업그레이드
  - TimeLock 대기 시간이 있었으나 커뮤니티 검토 미흡
  - 테스트 커버리지가 해당 경계 케이스를 놓침

교훈:
  1. Sepolia 검증 → 커뮤니티 코드 리뷰 → 감사(Audit) → mainnet
  2. TimeLock 기간을 충분히 길게 설정 (최소 48시간 권장)
  3. 경계 케이스와 수학적 오버플로우 테스트 필수
```

**Nomad Bridge 해킹 (2022년 8월):**

```
상황:
  Nomad 브릿지 업그레이드 시 메시지 검증 루트 초기화 오류

결과:
  190M 달러 손실

원인:
  업그레이드 후 메시지 검증 루트가 0x00으로 초기화됨
  → 0x00은 "모든 메시지 허용"으로 해석됨
  → 누구나 임의 메시지를 "유효한 메시지"로 처리 가능
  → 수백 명이 동시에 자금을 탈취

교훈:
  reinitializer를 사용해 업그레이드 후 즉시 올바른 초기값을 설정해야 함
  초기화되지 않은 중간 상태가 외부에 노출되면 치명적
```

**KyoboNFT 안전 업그레이드 프로세스 제안:**

```
1단계: Sepolia 검증
   → KyoboNFTV2 테스트 100% passing
   → Sepolia 업그레이드 성공 확인
   → 24시간 Sepolia 모니터링

2단계: 내부 감사
   → Storage Layout 변경사항 문서화
   → reinitializer 로직 검토
   → 새 함수 권한 검토

3단계: Gnosis Safe 멀티시그 승인
   → UPGRADER_ROLE 보유 계정이 Gnosis Safe
   → 3-of-5 서명 수집 (예: CTO, CSO, CEO 등)

4단계: TimeLock (옵션)
   → 업그레이드 TX를 48시간 지연 실행
   → 이 기간 동안 이상 발견 시 취소 가능

5단계: Mainnet 실행
   → upgradeToAndCall (업그레이드 + 초기화 atomic)
   → 즉시 Etherscan에서 version(), baseURI() 확인
```

---

### E. upgradeToAndCall과 Atomic 처리

**왜 atomic이 중요한가:**

```
비atomic 방식 (두 TX):
  TX1: upgradeProxy (구현체 교체)
  ↓ 이 사이에 다른 사람이 TX를 보낼 수 있음
  TX2: initializeV2('https://api.kyobo.com/nft/')

  문제: TX1과 TX2 사이에 공격자가 initializeV2()를 먼저 호출할 수 있음
        → baseURI를 악의적인 URI로 설정
        → 모든 토큰의 메타데이터 URI가 오염됨
```

```
Atomic 방식 (upgradeToAndCall):
  하나의 TX에서:
    1. upgradeToAndCall(newImpl, encodedInitData) 호출
    2. 프록시가 새 구현체로 포인터 변경
    3. 즉시 같은 TX에서 initializeV2() delegatecall
    → TX1과 TX2 사이 간격 없음 → 탈취 불가
```

**`upgradeToAndCall` vs 별도 `initializeV2` TX:**

```typescript
// 방법 1: upgradeToAndCall (권장) — atomic
await upgrades.upgradeProxy(PROXY_ADDR, KyoboNFTV2Factory, {
  kind: 'uups',
  call: {
    fn: 'initializeV2',
    args: ['https://api.kyobo.com/nft/'],
  },
});

// 방법 2: 별도 TX (비권장) — 틈새 존재
const v2 = await upgrades.upgradeProxy(PROXY_ADDR, KyoboNFTV2Factory);
// ← 여기서 다른 사람이 initializeV2() 호출 가능
await v2.initializeV2('https://api.kyobo.com/nft/');
```

**`reinitializer(2)`가 탈취를 막는 방법:**  
설령 공격자가 방법 2의 틈새에서 `initializeV2(악의적_URI)`를 호출했다고 해도, 그것이 성공하면 `_initialized = 2`. 이후 정상적인 `initializeV2()` 호출은 `_initialized < 2`가 false이므로 revert된다. 결국 공격자의 URI가 설정된 채로 굳어진다. `upgradeToAndCall`로 atomic 처리하면 이 위험 자체가 없다.

---

### F. `.openzeppelin/sepolia.json` 관리

**이 파일이 중요한 이유:**

```json
{
  "manifestVersion": "3.2",
  "proxies": [
    {
      "address": "0xAbCd...",      // 프록시 주소
      "txHash": "0x...",           // 배포 TX
      "kind": "uups"
    }
  ],
  "impls": {
    "abc123...": {                 // 구현체 bytecode hash
      "address": "0x1111...",      // v1 구현체 주소
      "layout": {
        "storage": [               // 각 변수의 슬롯 정보
          { "label": "_balances", "slot": "0", "type": "mapping" },
          ...
        ]
      }
    }
  }
}
```

이 파일이 없으면 `upgradeProxy` 시 이전 layout과 비교할 수 없어 Storage 검증이 불가능하다. 반드시 git으로 추적해야 하며, 팀원이 공유해야 한다.

**업그레이드 후 파일 변화:**

```json
// 업그레이드 후 새 구현체가 추가됨
"impls": {
  "abc123...": { "address": "0x1111...", ... },  // v1
  "def456...": { "address": "0x2222...", ... }   // v2 (새로 추가)
}
```

---

## 강의 파트 (40분)

### 1. 업그레이드가 필요한 상황

S41에서 KyoboNFT v1을 Sepolia에 배포했다. 운영 중 다음 요건이 추가됐다고 가정하자:

```
① 메타데이터 URI를 온체인에서 관리해야 한다 → baseURI 상태변수 추가
② 현재 배포된 버전을 조회할 수 있어야 한다 → version 상태변수 추가
③ v2 초기화 시 baseURI를 설정해야 한다 → reinitializer 필요
```

새 컨트랙트를 배포하면 주소가 바뀐다. VASP, M2 WebhookReceiver, M4 원장 서비스가 모두 새 주소로 바꿔야 한다. UUPS 업그레이드는 **프록시 주소를 유지한 채 구현체만 교체**한다.

---

### 2. Storage Layout 복습 — 슬롯 충돌의 실제 결과

S40에서 개념을 배웠다. 오늘은 실제로 충돌을 만들어서 결과를 확인한다.

**EVM Storage 슬롯 구조:**

```
슬롯 0: ERC1155 내부 — _balances (mapping)
슬롯 1: ERC1155 내부 — _operatorApprovals (mapping)
슬롯 2: AccessControl 내부 — _roles (mapping)
슬롯 3: Pausable 내부 — _paused (bool)
슬롯 4: KyoboNFT — (현재 v1에는 추가 상태변수 없음)
...
```

`constant`와 `immutable` 변수는 슬롯을 차지하지 않는다. `MINTER_ROLE = keccak256(...)` 같은 상수는 bytecode에 직접 포함된다.

**충돌 시나리오 — 잘못된 v2:**

```solidity
// KyoboNFT v1 — 슬롯 4 이후 비어 있음
contract KyoboNFT { /* 추가 상태변수 없음 */ }

// KyoboNFTV2 ❌ 잘못된 업그레이드
contract KyoboNFTV2 is KyoboNFT {
    string public baseURI;   // 슬롯 4 ← OK
    uint8  public version;   // 슬롯 5 ← OK
}

// KyoboNFTV3 ❌❌ 더 잘못된 업그레이드
contract KyoboNFTV3 is KyoboNFT {
    uint8  public version;   // 슬롯 4 ← v2의 baseURI 자리!
    string public baseURI;   // 슬롯 5 ← 위치 밀림
}
// v2에서 baseURI에 "https://..."를 저장했다면
// v3로 업그레이드 후 version을 읽으면 "https://..."의 바이트가 반환됨
// 기존 데이터 전부 오염
```

**`@openzeppelin/hardhat-upgrades`의 자동 보호:**

```bash
npx hardhat run scripts/upgrade.ts --network sepolia
# → Error: New storage layout is incompatible
#   Inserted `version` before `baseURI`
#   (incompatible: deleted storage field from slot 4)
```

배포 전에 잡아준다. 이 오류를 무시하고 넘어가면 데이터가 깨진다.

**오류 메시지 해석:**

```
Inserted `version` before `baseURI`
→ version이 baseURI보다 앞에 선언됨
→ 기존 슬롯 4의 baseURI가 version으로 교체됨
→ 기존 baseURI 데이터가 version의 타입(uint8)으로 해석됨
→ 데이터 오염
```

---

### 3. 올바른 KyoboNFTV2 작성

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./KyoboNFT.sol";

/**
 * @title KyoboNFTV2
 * @notice KyoboNFT v2 — baseURI 관리 + 버전 추적 추가
 *
 * Storage Layout 규칙 준수:
 *   - KyoboNFT(v1)의 모든 상태변수 순서 유지
 *   - 새 변수(baseURI, version)는 상속 체인 끝에만 추가
 *
 * 업그레이드 절차:
 *   upgrades.upgradeProxy(PROXY_ADDR, KyoboNFTV2)
 *   → reinitializer(2) 자동 호출 (initializeV2)
 */
contract KyoboNFTV2 is KyoboNFT {

    // ── 새 상태변수 — 반드시 끝에만 추가 ────────────────────────────────
    string public baseURI;   // 슬롯 4 (v1에는 없던 슬롯)
    uint8  public version;   // 슬롯 5

    // ── v2 초기화 — reinitializer(2) ─────────────────────────────────────
    /**
     * @notice v2 전용 초기화 함수
     * @dev    reinitializer(2): 버전 2로 1회만 실행 가능
     *         upgradeProxy 후 자동 호출되지 않음 — 별도 트랜잭션 또는
     *         upgradeToAndCall()에 calldata로 전달해야 함
     */
    function initializeV2(string memory _baseURI) public reinitializer(2) {
        baseURI = _baseURI;
        version = 2;
    }

    // ── 새 함수 — URI 관리 ────────────────────────────────────────────────
    function setBaseURI(string memory _baseURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseURI = _baseURI;
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        if (bytes(baseURI).length == 0) {
            return super.uri(tokenId);
        }
        return string.concat(baseURI, _toHexString(tokenId), ".json");
    }

    // ── 내부 헬퍼 ─────────────────────────────────────────────────────────
    function _toHexString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 length = 0;
        while (temp != 0) { length++; temp >>= 4; }
        bytes memory buffer = new bytes(2 + length * 2);
        buffer[0] = '0'; buffer[1] = 'x';
        for (uint256 i = 2 + length * 2 - 1; i >= 2; i--) {
            buffer[i] = _HEX_SYMBOLS[value & 0xf];
            value >>= 4;
            if (i == 2) break;
        }
        return string(buffer);
    }

    bytes16 private constant _HEX_SYMBOLS = "0123456789abcdef";
}
```

---

### 4. `reinitializer` — 버전별 초기화

```solidity
// initializer — initialize()에 붙임. 딱 1회만 실행 가능
function initialize(address admin) public initializer { ... }

// reinitializer(N) — 버전 N으로 1회만 실행 가능
// N은 이전 버전보다 반드시 커야 함
function initializeV2(string memory uri) public reinitializer(2) { ... }
function initializeV3(uint256 cap)       public reinitializer(3) { ... }
```

**`_initialized` 상태 추적:**

```
초기 상태:           _initialized = 0
initialize() 실행 후: _initialized = 1
initializeV2() 실행 후: _initialized = 2
_disableInitializers() 실행 후: _initialized = type(uint64).max
```

**실행 보장 방법:**

```typescript
// 방법 1: upgradeToAndCall — 업그레이드 + 초기화를 1개 트랜잭션으로 (권장)
await upgrades.upgradeProxy(PROXY_ADDR, KyoboNFTV2Factory, {
  call: { fn: 'initializeV2', args: ['https://api.kyobo.com/nft/'] }
});

// 방법 2: upgradeProxy 후 별도 트랜잭션 (비권장 — 틈새 있음)
const nftV2 = await upgrades.upgradeProxy(PROXY_ADDR, KyoboNFTV2Factory);
await nftV2.initializeV2('https://api.kyobo.com/nft/');
```

방법 1이 안전하다. 업그레이드와 초기화 사이에 다른 트랜잭션이 끼어들어 초기화되지 않은 상태로 호출되는 위험이 없다.

**`reinitializer` 없이 새 변수를 초기화하면:**

```solidity
// reinitializer 없는 경우
function initializeV2(string memory _baseURI) public {
    // 누구나 호출 가능! → 악의적인 주소가 먼저 호출해 baseURI 탈취
    baseURI = _baseURI;
}
```

`reinitializer(2)` modifier가 "버전 2 초기화는 1회만"을 보장한다.

---

### 5. 업그레이드 스크립트

```typescript
// scripts/deploy/upgrade-kyobonft.ts
import { ethers, upgrades } from 'hardhat';

async function main() {
  const PROXY_ADDR = process.env.KYOBO_NFT_PROXY_ADDR;
  if (!PROXY_ADDR) throw new Error('KYOBO_NFT_PROXY_ADDR 미설정');

  console.log('업그레이드 대상 프록시:', PROXY_ADDR);

  // ① Storage Layout 검증 + 구현체 배포 + 프록시 업그레이드 + initializeV2 호출
  const KyoboNFTV2 = await ethers.getContractFactory('KyoboNFTV2');

  const nftV2 = await upgrades.upgradeProxy(PROXY_ADDR, KyoboNFTV2, {
    kind: 'uups',
    call: {
      fn:   'initializeV2',
      args: ['https://api.kyobo.com/nft/'],
    },
  });
  await nftV2.waitForDeployment();

  console.log('업그레이드 완료. 프록시 주소 불변:', PROXY_ADDR);
  console.log('version:', await nftV2.version());
  console.log('baseURI:', await nftV2.baseURI());

  // ② 구현체 주소 확인
  const implAddr = await upgrades.erc1967.getImplementationAddress(PROXY_ADDR);
  console.log('새 구현체 주소:', implAddr);

  // ③ Etherscan 검증
  console.log('\n10초 후 Etherscan 검증...');
  await new Promise(r => setTimeout(r, 10_000));
  const { run } = await import('hardhat');
  try {
    await run('verify:verify', { address: implAddr, constructorArguments: [] });
    console.log('Etherscan 검증 완료');
  } catch (e: any) {
    if (e.message.includes('Already Verified')) console.log('이미 검증됨');
    else console.warn('검증 실패:', e.message);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
```

**`upgrades.upgradeProxy`가 하는 일:**

```
① KyoboNFTV2 구현체 컨트랙트 배포
② .openzeppelin/sepolia.json의 기존 layout과 새 layout 비교
   → 충돌 시 여기서 중단 (트랜잭션 실행 전)
③ 프록시의 _IMPLEMENTATION_SLOT 값을 새 구현체 주소로 변경
④ call.fn이 있으면 initializeV2() 호출을 같은 트랜잭션에 포함
⑤ .openzeppelin/sepolia.json 업데이트
```

---

### 6. 업그레이드 전후 상태 비교

```
업그레이드 전 (v1)               업그레이드 후 (v2)
─────────────────────            ─────────────────────────────
프록시 주소: 0xAbCd (동일)       프록시 주소: 0xAbCd (동일)
구현체 주소: 0x1111              구현체 주소: 0x2222 (교체)
_balances: 기존 데이터 유지      _balances: 기존 데이터 유지 ✓
baseURI: (없음)                  baseURI: "https://api.kyobo.com/nft/"
version: (없음)                  version: 2
```

기존 NFT 보유자의 `_balances`가 그대로 유지되는 것이 핵심이다. 업그레이드는 코드만 바꾸고 데이터는 건드리지 않는다.

---

### 7. 의도적 충돌 실험 — 오류 메시지 직접 보기

학습 목적으로 충돌을 만들어 OZ의 검증이 어떻게 작동하는지 확인한다.

```solidity
// KyoboNFTV2_BAD.sol — 고의로 잘못 작성
contract KyoboNFTV2_BAD is KyoboNFT {
    uint8  public version;   // ← baseURI보다 먼저 선언 (순서 뒤바뀜)
    string public baseURI;
}
```

```bash
npx hardhat run scripts/deploy/upgrade-kyobonft-bad.ts --network sepolia
```

```
Error: New storage layout is incompatible with the old one
  Slot 4: Changed type from `string` to `uint8`
  Previous: baseURI (string)
  New:      version (uint8)
  → Incompatible storage layout change
```

트랜잭션 실행 전에 오류를 잡는다. 체인에 아무 변화가 없다. 이것이 `@openzeppelin/hardhat-upgrades`의 역할이다.

**"체인에 변화가 없다"가 중요한 이유:**  
오류가 난 것이 TX 실행 전이기 때문이다. TX가 실행됐다가 실패했다면 gas가 소비되고 잘못된 상태 변경이 부분적으로 기록될 수 있다. OZ 플러그인은 로컬에서 검증을 완료하고 문제가 없을 때만 TX를 보낸다.

---

### 8. v2 테스트

```typescript
// test/KyoboNFTV2.test.ts
import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';

describe('KyoboNFTV2 업그레이드', () => {
  let proxy: any;
  let admin: any, minter: any, user: any;

  beforeEach(async () => {
    [admin, minter, user] = await ethers.getSigners();

    // v1 배포
    const V1 = await ethers.getContractFactory('KyoboNFT');
    proxy = await upgrades.deployProxy(V1, [admin.address], { kind: 'uups' });
    await proxy.waitForDeployment();

    // minter에 역할 부여 + v1 상태 만들기
    const MINTER_ROLE = await proxy.MINTER_ROLE();
    await proxy.connect(admin).grantRole(MINTER_ROLE, minter.address);
    const tokenId = await proxy.encodeTokenId(1n, 1n);
    await proxy.connect(minter).mint(user.address, tokenId, 3);
  });

  it('업그레이드 후 기존 잔액 유지', async () => {
    const tokenId = await proxy.encodeTokenId(1n, 1n);
    const balanceBefore = await proxy.balanceOf(user.address, tokenId);

    // v2로 업그레이드
    const V2 = await ethers.getContractFactory('KyoboNFTV2');
    const v2 = await upgrades.upgradeProxy(await proxy.getAddress(), V2, {
      kind: 'uups',
      call: { fn: 'initializeV2', args: ['https://api.kyobo.com/nft/'] },
    });

    const balanceAfter = await v2.balanceOf(user.address, tokenId);
    expect(balanceAfter).to.equal(balanceBefore);  // 3 유지
  });

  it('v2 신규 상태변수 초기화 확인', async () => {
    const V2 = await ethers.getContractFactory('KyoboNFTV2');
    const v2 = await upgrades.upgradeProxy(await proxy.getAddress(), V2, {
      kind: 'uups',
      call: { fn: 'initializeV2', args: ['https://api.kyobo.com/nft/'] },
    });

    expect(await v2.version()).to.equal(2);
    expect(await v2.baseURI()).to.equal('https://api.kyobo.com/nft/');
  });

  it('initializeV2 재호출 불가 (reinitializer 보호)', async () => {
    const V2 = await ethers.getContractFactory('KyoboNFTV2');
    const v2 = await upgrades.upgradeProxy(await proxy.getAddress(), V2, {
      kind: 'uups',
      call: { fn: 'initializeV2', args: ['https://api.kyobo.com/nft/'] },
    });

    await expect(v2.initializeV2('https://evil.com/'))
      .to.be.revertedWithCustomError(v2, 'InvalidInitialization');
  });

  it('setBaseURI — admin만 가능', async () => {
    const V2 = await ethers.getContractFactory('KyoboNFTV2');
    const v2 = await upgrades.upgradeProxy(await proxy.getAddress(), V2, {
      kind: 'uups',
      call: { fn: 'initializeV2', args: ['https://api.kyobo.com/nft/'] },
    });

    await expect(v2.connect(user).setBaseURI('https://evil.com/'))
      .to.be.revertedWithCustomError(v2, 'AccessControlUnauthorizedAccount');

    await v2.connect(admin).setBaseURI('https://new.kyobo.com/nft/');
    expect(await v2.baseURI()).to.equal('https://new.kyobo.com/nft/');
  });

  it('프록시 주소 불변 확인', async () => {
    const proxyAddr = await proxy.getAddress();
    const V2 = await ethers.getContractFactory('KyoboNFTV2');
    const v2 = await upgrades.upgradeProxy(proxyAddr, V2, {
      kind: 'uups',
      call: { fn: 'initializeV2', args: ['https://api.kyobo.com/nft/'] },
    });
    expect(await v2.getAddress()).to.equal(proxyAddr);  // 동일 주소
  });
});
```

---

## 실습 파트 (20분)

### KyoboNFTV2 작성 + 업그레이드 실행

**① KyoboNFTV2.sol 파일 작성 (5분)**

```bash
# blockchain/src/rewards/ 에 새 파일 생성
```

위 강의 파트의 `KyoboNFTV2` 코드를 `blockchain/src/rewards/KyoboNFTV2.sol`에 작성.

**② 테스트 실행 (5분)**

```bash
cd blockchain
npx hardhat compile
npx hardhat test test/KyoboNFTV2.test.ts

# 기대 결과:
# KyoboNFTV2 업그레이드
#   ✓ 업그레이드 후 기존 잔액 유지
#   ✓ v2 신규 상태변수 초기화 확인
#   ✓ initializeV2 재호출 불가
#   ✓ setBaseURI — admin만 가능
#   ✓ 프록시 주소 불변 확인
# 5 passing
```

**③ 고의 충돌 실험 (3분)**

순서 뒤바뀐 `KyoboNFTV2_BAD.sol` 작성 후:

```bash
# upgrade 스크립트에서 KyoboNFTV2_BAD를 사용해 실행
# → Storage layout incompatible 오류 메시지 직접 확인
# → 트랜잭션 없이 오류 발생 (체인 변화 없음)
```

**④ Sepolia 업그레이드 (7분)**

```bash
npx hardhat run scripts/deploy/upgrade-kyobonft.ts --network sepolia

# 출력 확인:
# 업그레이드 완료. 프록시 주소 불변: 0xAbCd...
# version: 2
# baseURI: https://api.kyobo.com/nft/
# 새 구현체 주소: 0x2222...
```

Etherscan에서 프록시 주소 접속 → Read as Proxy → `version()` = 2 확인.

---

## 완료 기준

- [ ] `KyoboNFTV2.sol` 작성 — 새 변수를 끝에만 추가한 올바른 구조
- [ ] `npx hardhat test test/KyoboNFTV2.test.ts` → 5개 케이스 모두 passing
- [ ] 고의 충돌(`version`/`baseURI` 순서 뒤바꿈) → OZ 오류 메시지 직접 확인
- [ ] `upgrade-kyobonft.ts --network sepolia` 실행 → 업그레이드 완료
- [ ] Etherscan Read as Proxy → `version()` = 2, `baseURI` 값 확인
- [ ] "업그레이드 후에도 기존 NFT 보유자 잔액이 유지되는 이유" 설명 가능
- [ ] "`reinitializer(2)`가 없으면 발생하는 보안 위험" 설명 가능
- [ ] M7 전체 흐름 설명 가능: KyoboNFT 구현 → 테스트 → 배포 → 업그레이드

---

## 강사 노트

**반드시 짚을 것:**  
고의 충돌 실험을 직접 보여줄 것. "Storage Layout incompatible" 오류가 얼마나 친절하게 어떤 슬롯에서 충돌했는지를 알려주는지 보여주면 OZ 플러그인의 가치를 체감한다. 그리고 "이 검증 없이 운영 컨트랙트를 업그레이드하면 어떻게 되는가" — 토큰 전량 손실이라는 결과를 강조할 것.

**`reinitializer` 재호출 테스트:**  
`initializeV2`를 2번 호출하려 할 때 `InvalidInitialization` revert가 나오는 것을 직접 보여줄 것. "이 보호가 없으면 누군가 먼저 initializeV2를 호출해 baseURI를 악의적으로 설정할 수 있다"는 시나리오와 연결.

**Compound 사례로 교훈 강조:**  
"2021년 Compound는 충분한 테스트 없이 메인넷 업그레이드를 진행해 8천만 달러의 COMP가 잘못 분배됐다. 업그레이드는 새 배포보다 훨씬 위험하다. Sepolia 검증 → 코드 리뷰 → 멀티시그 승인 → TimeLock → 메인넷 순서를 반드시 지켜야 한다."

**upgradeToAndCall atomic 처리 강조:**  
"업그레이드 후 초기화를 두 TX로 나누면 그 사이에 공격자가 끼어들 수 있다. upgradeToAndCall로 한 TX에 묶으면 이 위험이 사라진다."

**`.openzeppelin/sepolia.json` 파일:**  
업그레이드 후 이 파일이 변경된다. git으로 관리해야 하는 파일이다. 팀원과 공유해야 이후 업그레이드 시 layout 비교가 가능하다. 커밋하도록 안내할 것.

**mapping value 타입 변경은 자동 감지 안 됨:**  
"OZ 플러그인이 모든 것을 감지하지는 않는다. mapping의 value 타입을 변경하면 오류가 안 나지만 실제로는 데이터가 깨진다. storage layout 변경 시에는 항상 슬롯 번호를 직접 확인하는 습관을 들여야 한다."

**M7 완료 의미:**  
M7이 끝나면 KyoboNFT가 Sepolia에 올라가 있고 업그레이드까지 가능한 상태다. Phase 1의 온체인 레이어가 완성됐다. M8에서는 이 컨트랙트에 보안 취약점이 없는지 검증한다.
