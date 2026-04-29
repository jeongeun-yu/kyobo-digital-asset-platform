# M6 S35 — ERC-1155 다중 토큰 표준과 엔터프라이즈 tokenId 설계

> 모듈 6 · 세션 35 · 1시간  
> 스켈레톤: `blockchain/src/phase1/KyoboNFT.sol`

---

## 강의 파트 (25분)

### 1. ERC-721과 ERC-1155의 근본적 차이

선행 과정에서 ERC-721을 배웠다. ERC-1155는 무엇이 다를까?

**ERC-721 — "한 종류씩 따로따로"**

```
걷기 달성 쿠폰 컨트랙트: WalkNFT.sol
건강검진 쿠폰 컨트랙트: HealthNFT.sol
캠페인 쿠폰 컨트랙트: CampaignNFT.sol
...
```

쿠폰 종류가 20개면 컨트랙트도 20개다. 관리 비용이 폭발한다. 각 컨트랙트마다 별도 배포, 별도 Etherscan 검증, 별도 MINTER_ROLE 설정이 필요하다.

**ERC-1155 — "컨트랙트 하나에 여러 종류"**

```
KyoboNFT.sol (컨트랙트 1개)
  → tokenId = 0x0001...: 걷기 달성 쿠폰
  → tokenId = 0x0002...: 건강검진 쿠폰
  → tokenId = 0x0010...: 캠페인 쿠폰
```

컨트랙트 1개로 모든 NFT 종류를 관리한다. `tokenId`가 NFT 종류를 구분한다.

**가스 비용 비교:**

| 항목 | ERC-721 | ERC-1155 |
|---|---|---|
| 단건 mint | ~80,000 gas | ~50,000 gas |
| 500건 배치 | 500 × 80K = 40M gas (불가) | ~25,000,000 gas (1 TX) |
| 쿠폰 추가 | 새 컨트랙트 배포 필요 | tokenId 정의만 추가 |

교보생명 선택: 쿠폰 종류가 다양하고 대량 발행이 필요 → **ERC-1155**.

---

### 2. tokenId 비트 인코딩 설계 — 충돌 없는 주소 공간

uint256은 2^256 가지의 값을 가질 수 있다. 이 공간을 체계적으로 나눠서 사용한다.

```
uint256 tokenId 레이아웃 (128비트 사용):

  bit 127~64: productCode (상품 종류, 64비트)
  bit  63~ 0: eventCode   (세부 이벤트 번호, 64비트)
```

**productCode 정의:**

```
0x01 = 걷기 달성 (WALK_GOAL)
0x02 = 건강검진 (HEALTH_CHECK)
0x10 = 캠페인 쿠폰 (COUPON)
```

**인코딩 예시:**

```
걷기 달성 이벤트 #42:
  tokenId = encodeTokenId(0x01, 42)
          = (0x01 << 64) | 42
          = 0x0000000000000001_000000000000002A
```

왜 비트 인코딩인가?

```
잘못된 방법: tokenId = productCode * 10000 + eventCode
  문제: eventCode가 10000 이상이면 충돌 발생
        productCode=1, eventCode=10001 → 20001
        productCode=2, eventCode=1     → 20001  (충돌!)

올바른 방법: 비트 시프트
  (0x01 << 64) | 10001 → 상위 64비트에 01, 하위 64비트에 10001
  (0x02 << 64) | 1     → 상위 64비트에 02, 하위 64비트에 01
  절대 충돌 없음
```

---

### 3. M5와 M6의 동기화 — TypeScript와 Solidity가 같은 인코딩을 사용해야 한다

M5 `ActivityConditionStrategy`에서 이미 tokenId를 계산했다:

```typescript
// TypeScript (M5 S30)
const tokenId = (productCode << BigInt(64)) | BigInt(event.eventCode);
```

M6 `KyoboNFT.sol`에서도 같은 레이아웃을 사용한다:

```solidity
// Solidity (M6 S35)
uint256 tokenId = (uint256(productCode) << 64) | uint256(eventCode);
```

TypeScript에서 계산한 tokenId를 컨트랙트에 그대로 전달한다. 두 레이어의 인코딩이 다르면 엉뚱한 tokenId의 NFT가 발행된다.

---

### 4. OpenZeppelin Upgradeable 4종 조합 — 왜 이 4개인가

```solidity
contract KyoboNFT is
    Initializable,
    ERC1155Upgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
```

| 컴포넌트 | 담당 기능 | 없으면? |
|---|---|---|
| `Initializable` | constructor 대신 initialize() 사용 | 업그레이드 프록시에서 초기화 불가 |
| `ERC1155Upgradeable` | 다중 토큰 표준 | NFT 발행 불가 |
| `AccessControlUpgradeable` | MINTER/PAUSER/UPGRADER 역할 | 누구나 mint 가능한 취약점 |
| `PausableUpgradeable` | 긴급 정지 | 해킹 발생 시 즉시 중단 불가 |
| `UUPSUpgradeable` | 업그레이드 로직 | 버그 수정 불가, 영구 고착 |

왜 Upgradeable 버전인가? 일반 OZ 컨트랙트는 `constructor()`에서 상태를 초기화한다. UUPS 프록시에서는 `constructor()`가 프록시 컨텍스트에서 실행되지 않는다(S36에서 상세 설명). Upgradeable 버전은 `initialize()`에서 초기화한다.

---

## 실습 파트 (30분)

### OZ Upgradeable 4종 import + 상속 선언

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
    // 상속만 선언해도 컴파일이 통과해야 함
}
```

컴파일 확인:
```bash
npx hardhat compile
# → 에러 없이 통과해야 함
```

### `encodeTokenId` / `decodeTokenId` 구현

```solidity
uint8 public constant PRODUCT_CODE_SHIFT = 64;

function encodeTokenId(
    uint64 productCode,
    uint64 eventCode
) public pure returns (uint256) {
    // productCode를 상위 64비트로, eventCode를 하위 64비트로 결합
    return (uint256(productCode) << PRODUCT_CODE_SHIFT) | uint256(eventCode);
}

function decodeTokenId(
    uint256 tokenId
) public pure returns (uint64 productCode, uint64 eventCode) {
    // 상위 64비트 추출: 오른쪽으로 64비트 시프트
    productCode = uint64(tokenId >> PRODUCT_CODE_SHIFT);
    // 하위 64비트 추출: uint64 캐스팅이 자동으로 상위 비트를 자름
    eventCode   = uint64(tokenId);
}
```

### 단위 테스트

```solidity
function test_encodeDecodeTokenId() public {
    uint64 product = 0x01;
    uint64 event_  = 42;
    uint256 tokenId = nft.encodeTokenId(product, event_);

    (uint64 decodedProduct, uint64 decodedEvent) = nft.decodeTokenId(tokenId);

    assertEq(decodedProduct, product, "productCode mismatch");
    assertEq(decodedEvent, event_, "eventCode mismatch");
}

function test_noDuplicateTokenIds() public {
    // 다른 productCode, 같은 eventCode → 충돌 없음
    uint256 id1 = nft.encodeTokenId(0x01, 100);
    uint256 id2 = nft.encodeTokenId(0x02, 100);
    assertTrue(id1 != id2, "tokenId collision!");
}

function test_walkGoalTokenId() public {
    // M5 ActivityConditionStrategy와 동일한 결과여야 함
    uint256 tokenId = nft.encodeTokenId(0x01, 42);
    // TypeScript에서: (0x01n << 64n) | 42n
    assertEq(tokenId, (uint256(0x01) << 64) | 42);
}
```

---

## 완료 기준

- [ ] OZ Upgradeable 4종 상속 컴파일 통과
- [ ] tokenId 인코딩·디코딩 테스트 통과
- [ ] 다른 productCode + 같은 eventCode → 다른 tokenId 확인
- [ ] TypeScript M5와 Solidity M6의 인코딩 결과 동일함 확인
