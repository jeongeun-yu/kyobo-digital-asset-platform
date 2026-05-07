# Day 10 — M6: ERC-1155 컨트랙트 완전 구현 (S37~S40)

**세션**: S37~S40 | **모듈**: M6 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: mint/mintBatch/burn/pause + Sepolia 배포 + Etherscan 검증 + v2 업그레이드

---

## S37: 온체인 역할 기반 접근 제어와 발행 권한 체계 (강의 20분 + 실습 35분)

### 강의

**역할 설계:**
- `MINTER_ROLE`: VASP 주소 — NFT 발행 권한
- `PAUSER_ROLE`: Admin — 컨트랙트 일시 중지
- `DEFAULT_ADMIN_ROLE`: 역할 부여/회수 권한

**mintBatch 가스 한도:**
- 1회 500건 초과 시 block gas limit 초과
- 배치 분할 필요 (M5 BulkIssueService에서 이미 처리)

**TX Nonce 관리:**
- 순서 보장
- Replace-by-Fee로 stuck TX 복구

### 🔴 실습 (35분) — 수강생 직접 작성

**Step 1**: mint 함수 구현
```solidity
// TODO: mint 구현
// - onlyRole(MINTER_ROLE) 체크
// - whenNotPaused 체크

function mint(
  address to,
  uint256 tokenId,
  uint256 amount,
  bytes memory data
) external onlyRole(MINTER_ROLE) whenNotPaused {
  // TODO: _mint(to, tokenId, amount, data) 호출
}
```

**Step 2**: mintBatch 함수 구현
```solidity
// TODO: mintBatch 구현 — 동일 modifier 적용

function mintBatch(
  address to,
  uint256[] memory tokenIds,
  uint256[] memory amounts,
  bytes memory data
) external onlyRole(MINTER_ROLE) whenNotPaused {
  // TODO: _mintBatch(to, tokenIds, amounts, data) 호출
}
```

**Step 3**: 테스트
```typescript
// MINTER_ROLE 없는 주소 → revert 테스트
it('MINTER_ROLE 없는 주소 mint → revert', async () => {
  // TODO: attacker 주소로 mint 시도 → revert 확인
});

// Pause 상태 → revert 테스트
it('Pause 상태 mint → revert', async () => {
  // TODO: pause() 호출 후 mint 시도 → revert 확인
});

// mintBatch 500건 가스 측정
it('mintBatch 500건 가스 측정', async () => {
  // TODO: tokenIds 500개 배열 생성
  // TODO: mintBatch 호출 → gasUsed 측정
  // TODO: block gas limit(30M) 대비 여유 확인
});
```

### ✅ 답안

```solidity
// mint 완성
function mint(address to, uint256 tokenId, uint256 amount, bytes memory data)
  external
  onlyRole(MINTER_ROLE)
  whenNotPaused
{
  _mint(to, tokenId, amount, data);
}

// mintBatch 완성
function mintBatch(
  address to,
  uint256[] memory tokenIds,
  uint256[] memory amounts,
  bytes memory data
) external onlyRole(MINTER_ROLE) whenNotPaused {
  _mintBatch(to, tokenIds, amounts, data);
}
```

```typescript
// 테스트 완성
it('MINTER_ROLE 없는 주소 mint → revert', async () => {
  await expect(
    nft.connect(attacker).mint(attacker.address, 1001n, 1n, '0x')
  ).to.be.revertedWithCustomError(nft, 'AccessControlUnauthorizedAccount');
});

it('Pause 상태 mint → revert', async () => {
  await nft.connect(pauser).pause();
  await expect(
    nft.connect(minter).mint(user.address, 1001n, 1n, '0x')
  ).to.be.revertedWithCustomError(nft, 'EnforcedPause');
});

it('mintBatch 500건 가스 측정', async () => {
  const tokenIds = Array.from({ length: 500 }, (_, i) => BigInt(i + 1));
  const amounts  = new Array(500).fill(1n);
  const tx = await nft.connect(minter).mintBatch(user.address, tokenIds, amounts, '0x');
  const receipt = await tx.wait();
  console.log('gasUsed:', receipt.gasUsed.toString());
  expect(receipt.gasUsed).to.be.lessThan(30_000_000n);
});
```

### ✅ 완료 기준
- [ ] MINTER_ROLE 없는 주소 mint → revert
- [ ] mintBatch 500건 가스 측정 완료

---

## S38: 컨트랙트 생명주기 관리 — 소각·일시정지·업그레이드 (강의 15분 + 실습 40분)

### 강의

**burn 권한 설계:**
- 소유자 또는 approved 주소만 소각
- 잔액 0 상태 소각 방어 (OZ에서 자동 처리)

**`_authorizeUpgrade`에 UPGRADER_ROLE:**
- 아무나 업그레이드 못하게 막는 핵심 방어

**Pause 권한 단일점 위험:**
- Admin 키 분실 시 영구 정지
- 다중 Pauser 설계 필요

### 🔴 실습 (40분) — 수강생 직접 작성

**Step 1**: burn / pause / unpause / _authorizeUpgrade 구현
```solidity
// TODO: burn 구현
function burn(address from, uint256 tokenId, uint256 amount) external {
  // TODO: msg.sender가 from이거나 approved인지 확인
  // TODO: _burn(from, tokenId, amount) 호출
}

// TODO: pause / unpause
function pause()   external onlyRole(PAUSER_ROLE)  { _pause(); }
function unpause() external onlyRole(PAUSER_ROLE)  { _unpause(); }

// TODO: _authorizeUpgrade
function _authorizeUpgrade(address newImplementation)
  internal
  override
  // TODO: 적절한 role 체크
{}
```

**Step 2**: 테스트
```typescript
// Pause 상태 mint/burn → revert
it('Pause 상태 burn → revert', async () => {
  await nft.connect(minter).mint(user.address, 1001n, 5n, '0x');
  await nft.connect(pauser).pause();
  
  // TODO: burn 시도 → revert 확인
});

it('unpause 후 정상 동작', async () => {
  await nft.connect(pauser).pause();
  await nft.connect(pauser).unpause();
  
  // TODO: mint 성공 확인
});

// 전체 단위 테스트 실행
// npx hardhat test → all PASS 확인
```

### ✅ 답안

```solidity
// burn 완성
function burn(address from, uint256 tokenId, uint256 amount) external {
  require(
    from == msg.sender || isApprovedForAll(from, msg.sender),
    "KyoboNFT: caller is not owner or approved"
  );
  _burn(from, tokenId, amount);
}

// _authorizeUpgrade 완성
function _authorizeUpgrade(address newImplementation)
  internal
  override
  onlyRole(UPGRADER_ROLE)
{}

// supportsInterface override (다중 상속 필수)
function supportsInterface(bytes4 interfaceId)
  public view override(ERC1155Upgradeable, AccessControlUpgradeable)
  returns (bool)
{
  return super.supportsInterface(interfaceId);
}
```

### ✅ 완료 기준
- [ ] Pause 상태 mint/burn → revert
- [ ] 전체 단위 테스트 PASS

---

## S39: 스마트컨트랙트 배포 파이프라인과 온체인 코드 검증 (강의 15분 + 실습 40분)

### 강의

**Upgradeable 배포 절차:**
1. implementation 컨트랙트 배포
2. 프록시 배포 (implementation 주소 참조)
3. initialize 호출 (프록시를 통해)

**Etherscan 검증:**
- proxy + implementation 둘 다 등록 필요
- API 키: ETHERSCAN_API_KEY 환경변수

**배포 후 프록시 주소 저장:**
- 환경변수 + 배포 관리 파일 (deployments/)

### 🔴 실습 (40분) — 수강생 직접 작성

**Step 1**: 업그레이드 가능 배포 스크립트
```typescript
// blockchain/scripts/deploy-kyobo-nft.ts
// TODO: 배포 스크립트 작성

import { ethers, upgrades } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('배포 계정:', deployer.address);

  const KyoboNFT = await ethers.getContractFactory('KyoboNFT');
  
  // TODO: upgrades.deployProxy로 배포
  // TODO: 프록시 주소 콘솔 출력
  // TODO: deployments/ 파일에 주소 저장
}

main().catch(console.error);
```

**Step 2**: Sepolia 배포 실행
```bash
# TODO: Sepolia ETH 충전 확인 (최소 0.1 ETH)
# TODO: 배포 실행
npx hardhat run scripts/deploy-kyobo-nft.ts --network sepolia

# TODO: Etherscan 트랜잭션 확인
```

**Step 3**: Etherscan 소스코드 검증
```bash
# TODO: 검증 실행
npx hardhat verify --network sepolia [PROXY_ADDRESS]

# TODO: Etherscan Read Contract에서 직접 함수 호출 테스트
# - balanceOf(address, tokenId) 조회
# - supportsInterface 조회
```

### ✅ 답안

```typescript
// deploy-kyobo-nft.ts 완성
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('배포 계정:', deployer.address);
  console.log('잔액:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  const KyoboNFT = await ethers.getContractFactory('KyoboNFT');
  const nft = await upgrades.deployProxy(KyoboNFT, [deployer.address], {
    initializer: 'initialize',
    kind: 'uups',
  });
  await nft.waitForDeployment();
  
  const proxyAddress = await nft.getAddress();
  console.log('KyoboNFT 프록시:', proxyAddress);

  // 배포 정보 저장
  const fs = await import('fs');
  fs.writeFileSync(
    'deployments/sepolia.json',
    JSON.stringify({ KyoboNFT: proxyAddress, deployer: deployer.address, network: 'sepolia' }, null, 2),
  );
}
```

```bash
# Etherscan 검증
npx hardhat verify --network sepolia $(cat deployments/sepolia.json | jq -r '.KyoboNFT')
```

### ✅ 완료 기준
- [ ] Sepolia 배포 성공
- [ ] Etherscan verify 통과
- [ ] Read Contract에서 함수 호출 확인

---

## S40: 프록시 업그레이드 안전성 — Storage Layout 규칙과 버전 관리 (강의 15분 + 실습 40분)

### 강의

**Storage layout 규칙:**
- 기존 슬롯 변경·삭제 **절대 불가**
- 끝에만 추가 가능
- 위반 시 토큰 전량 파괴 (슬롯 재정의로 기존 값 덮어쓰기)

**`reinitializer(2)`:**
- 업그레이드 후 initialize 재호출 방지
- 버전 번호 관리

**hardhat-upgrades 레이아웃 체커:**
- 슬롯 충돌 자동 감지
- `upgrades.validateUpgrade` 또는 `upgrades.upgradeProxy` 시 자동 검증

### 🔴 실습 (40분) — 수강생 직접 작성

**Step 1**: 의도적 슬롯 충돌 재현 → 원복
```solidity
// KyoboNFT.sol에 임시 변수 추가 (잘못된 위치)
// TODO: 기존 변수들 사이에 새 변수 삽입 (슬롯 충돌 발생)
// → 업그레이드 시 값 파괴 확인
// → 원복: 끝에 추가하는 올바른 방법으로 재시도
```

**Step 2**: KyoboNFTV2.sol 작성
```solidity
// blockchain/contracts/KyoboNFTV2.sol
// TODO: 새 변수를 끝에만 추가
// TODO: reinitializer(2) 적용

contract KyoboNFTV2 is KyoboNFT {
  // TODO: 새 변수 (끝에 추가)
  uint256 public maxSupply;
  
  // TODO: v2 초기화
  function initializeV2(uint256 _maxSupply) public reinitializer(2) {
    maxSupply = _maxSupply;
  }
}
```

**Step 3**: 업그레이드 스크립트 실행
```typescript
// TODO: 기존 tokenId 보존 확인

async function main() {
  const proxyAddr = process.env.KYOBO_NFT_PROXY_ADDR!;
  
  // v1에서 mint 1건
  const nftV1 = await ethers.getContractAt('KyoboNFT', proxyAddr);
  await nftV1.mint(user.address, 1001n, 1n, '0x');
  const balanceBefore = await nftV1.balanceOf(user.address, 1001n);
  
  // v2로 업그레이드
  const KyoboNFTV2 = await ethers.getContractFactory('KyoboNFTV2');
  // TODO: upgrades.upgradeProxy 호출
  
  // 기존 tokenId 보존 확인
  const nftV2 = await ethers.getContractAt('KyoboNFTV2', proxyAddr);
  const balanceAfter = await nftV2.balanceOf(user.address, 1001n);
  console.log('업그레이드 전:', balanceBefore.toString());
  console.log('업그레이드 후:', balanceAfter.toString());
  // 같아야 함
}
```

### ✅ 답안

```solidity
// KyoboNFTV2.sol
contract KyoboNFTV2 is KyoboNFT {
  // 새 변수는 반드시 끝에만 추가
  uint256 public maxSupply;
  mapping(uint256 => string) public tokenMetadata;

  function initializeV2(uint256 _maxSupply) public reinitializer(2) {
    maxSupply = _maxSupply;
  }
}
```

```typescript
// 업그레이드 스크립트
const KyoboNFTV2 = await ethers.getContractFactory('KyoboNFTV2');
const upgraded = await upgrades.upgradeProxy(proxyAddr, KyoboNFTV2);
await upgraded.waitForDeployment();

// v2 초기화
await upgraded.initializeV2(1_000_000n);
console.log('maxSupply:', await upgraded.maxSupply());

// 기존 토큰 보존 확인
const balance = await upgraded.balanceOf(user.address, 1001n);
console.log('기존 tokenId 1001 보유량:', balance.toString()); // 1
```

### ✅ M6 완료 기준
- [ ] Sepolia 배포 + Etherscan 검증
- [ ] v2 업그레이드 후 기존 tokenId 보존
- [ ] Storage layout 충돌 없음
