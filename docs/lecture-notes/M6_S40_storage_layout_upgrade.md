# M6 S40 — 프록시 업그레이드 안전성 · Storage Layout 규칙과 버전 관리

> 모듈 6 · 세션 40 · 1시간  
> 스켈레톤: `blockchain/src/phase1/KyoboNFT.sol` → `_authorizeUpgrade()`

---

## 강의 파트 (15분)

### 1. Storage Layout 변경이 왜 토큰을 파괴하는가

S36에서 Storage Collision을 개념적으로 배웠다. 이번에는 실제로 재현해본다.

EVM 스토리지는 슬롯(slot) 단위로 관리된다. 슬롯은 0번부터 순서대로 할당된다.

```solidity
contract KyoboNFT {
    // OZ ERC1155Upgradeable이 내부적으로 slot 0, 1, 2... 사용
    // 직접 선언한 변수가 없으면 OZ가 차지한 슬롯 이후부터 비어 있음
}
```

업그레이드 시:

```solidity
// ❌ 잘못된 v2 — 새 변수를 앞에 삽입
contract KyoboNFTV2_BAD {
    address private newFeature;  // ← slot에 삽입됨
    // OZ 변수들이 뒤로 밀림
}
```

결과:

```
slot X (원래 _balances 매핑): 이제 newFeature(address)로 해석됨
user1의 잔액: 0x0000000000000001 → address(1)로 파싱됨 → 잔액 파괴
```

복구 불가능하다. 이미 블록체인에 기록된 슬롯 값을 올바르게 해석할 방법이 없다.

---

### 2. 안전한 업그레이드 규칙 — 새 변수는 끝에만

```solidity
// ✅ KyoboNFT v1 — 직접 선언한 상태 변수 없음
contract KyoboNFT is ... {
    // OZ 상속 변수들만 있음
}

// ✅ KyoboNFTV2 — 새 변수는 맨 끝에 추가
contract KyoboNFTV2 is KyoboNFT {
    // 기존 슬롯 레이아웃은 완전히 유지됨
    string private _baseTokenURI;        // 새 슬롯에 추가됨
    uint256 private _maxSupplyPerToken;  // 새 슬롯에 추가됨
}

// ❌ 절대 금지
contract KyoboNFTV2_BAD is KyoboNFT {
    string private _baseTokenURI;  // 기존 슬롯 앞에 삽입 → 충돌
}
```

---

### 3. `reinitializer(N)` — 버전 관리된 초기화

v2에 새 변수가 생겼다면, 업그레이드 후 초기화 함수가 필요하다.

```solidity
// KyoboNFTV2.sol
function initializeV2(
    string memory baseTokenURI,
    uint256 maxSupply
) public reinitializer(2) {  // 버전 2 초기화
    _baseTokenURI = baseTokenURI;
    _maxSupplyPerToken = maxSupply;
}
```

`reinitializer(N)`:
- v1의 `initializer` = `reinitializer(1)`: 한 번만 실행
- v2의 `reinitializer(2)`: v1과 충돌 없이, 한 번만 실행
- `reinitializer(1)`(v1 initialize) 재호출 → 여전히 revert

---

### 4. hardhat-upgrades 레이아웃 체커

수동으로 슬롯 충돌을 확인하는 것은 오류가 생기기 쉽다. `hardhat-upgrades`가 자동으로 검사한다:

```typescript
// scripts/upgrade.ts
const KyoboNFTV2 = await ethers.getContractFactory('KyoboNFTV2');

// 슬롯 충돌 자동 감지 — 충돌 발견 시 배포 중단
const nft = await upgrades.upgradeProxy(PROXY_ADDRESS, KyoboNFTV2);
// 충돌 있으면 에러: "New storage layout is incompatible"
```

---

## 실습 파트 (40분)

### 의도적 Storage Collision 재현

```solidity
// 학습용 충돌 유발 버전
contract KyoboNFTV2_COLLISION is KyoboNFT {
    address private _collisionVar;  // 슬롯 충돌 유발

    function initializeV2() public reinitializer(2) {}
}
```

테스트:

```typescript
it('storage collision → token balances destroyed', async () => {
  const tokenId = await nft.encodeTokenId(1n, 1n);
  await nft.mint(user.address, tokenId, 1);

  // 충돌 버전으로 업그레이드
  const V2Bad = await ethers.getContractFactory('KyoboNFTV2_COLLISION');

  // hardhat-upgrades가 충돌 감지 → 에러 발생 확인
  await expect(
    upgrades.upgradeProxy(proxyAddr, V2Bad),
  ).to.be.rejectedWith('incompatible');

  // 수동으로 강제 업그레이드 시 (--no-validation 플래그) 잔액 파괴 확인
  // → 프로덕션에서는 절대 금지
});
```

### KyoboNFTV2.sol 작성

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./KyoboNFT.sol";

contract KyoboNFTV2 is KyoboNFT {
    // ✅ KyoboNFT에 직접 선언된 상태 변수가 없으므로
    //    슬롯 충돌 없이 새 변수를 여기에 추가 가능

    string private _baseTokenURI;        // 새 변수: 슬롯 다음에 위치
    uint256 private _maxSupplyPerToken;  // 새 변수

    function initializeV2(
        string memory baseTokenURI,
        uint256 maxSupply
    ) public reinitializer(2) {          // v2 전용 초기화
        _baseTokenURI = baseTokenURI;
        _maxSupplyPerToken = maxSupply;
    }

    function baseTokenURI() external view returns (string memory) {
        return _baseTokenURI;
    }

    function maxSupplyPerToken() external view returns (uint256) {
        return _maxSupplyPerToken;
    }
}
```

### 업그레이드 스크립트

```typescript
// scripts/upgrade.ts
import { ethers, upgrades } from 'hardhat';
import * as fs from 'fs';

async function main() {
  const deployment = JSON.parse(fs.readFileSync('deployments/proxy-address.json', 'utf8'));
  const PROXY_ADDRESS = deployment.proxy;

  console.log('업그레이드 대상 Proxy:', PROXY_ADDRESS);

  const KyoboNFTV2 = await ethers.getContractFactory('KyoboNFTV2');

  // 레이아웃 호환성 자동 검사 + 업그레이드
  const nft = await upgrades.upgradeProxy(PROXY_ADDRESS, KyoboNFTV2);
  await nft.waitForDeployment();

  const newImplAddr = await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS);
  console.log('새 Implementation 주소:', newImplAddr);

  // V2 초기화
  const nftV2 = await ethers.getContractAt('KyoboNFTV2', PROXY_ADDRESS);
  await nftV2.initializeV2(
    "https://kyobo-nft.api/metadata/",
    1000,
  );

  console.log('업그레이드 완료');

  // 업그레이드 이력 저장
  fs.writeFileSync(
    'deployments/upgrade-v2.json',
    JSON.stringify({ impl: newImplAddr, upgradedAt: new Date().toISOString() }, null, 2),
  );
}

main().catch(console.error);
```

### 기존 토큰 보존 확인

```typescript
it('v2 upgrade preserves existing token balances', async () => {
  const tokenId = await nft.encodeTokenId(1n, 1n);
  await nft.mint(user.address, tokenId, 5);

  // 업그레이드 전 잔액 확인
  expect(await nft.balanceOf(user.address, tokenId)).to.equal(5n);

  // V2로 업그레이드
  const KyoboNFTV2 = await ethers.getContractFactory('KyoboNFTV2');
  const nftV2 = await upgrades.upgradeProxy(proxyAddr, KyoboNFTV2);
  await nftV2.initializeV2("https://api.kyobo.com/", 1000);

  // 업그레이드 후에도 잔액 보존
  expect(await nftV2.balanceOf(user.address, tokenId)).to.equal(5n);  // 보존 확인!
  expect(await nftV2.baseTokenURI()).to.equal("https://api.kyobo.com/");  // 새 기능 작동
});

it('reinitializer(2) 이중 호출 → revert', async () => {
  // V2 업그레이드 + initializeV2 호출 완료
  await nftV2.initializeV2("https://api.kyobo.com/", 1000);

  // 두 번째 initializeV2 호출 → revert
  await expect(
    nftV2.initializeV2("https://other.com/", 999),
  ).to.be.reverted;
});
```

---

## M6 완료 기준

- [ ] Sepolia 배포 + Etherscan 검증
- [ ] v2 업그레이드 후 기존 tokenId 보존
- [ ] Storage layout 충돌 없음
- [ ] reinitializer(2) 이중 호출 방지 확인
