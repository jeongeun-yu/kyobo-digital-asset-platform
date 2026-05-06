# M6 S39 — 스마트컨트랙트 배포 파이프라인과 온체인 코드 검증

> 모듈 6 · 세션 39 · 1시간  
> Hardhat upgrades, Sepolia testnet 배포

> 🔵 **Phase 3 전환 준비** — Phase 1에서 스마트 컨트랙트(Solidity 코드 작성·배포·운영)는 **월렛원(VASP)이 담당**한다. 이 세션은 Phase 3에서 당사가 직접 대체할 코드를 미리 학습하는 목적이다. **오너십(Owner Role)은 당사 보유** — 코드를 월렛원이 작성하더라도 컨트랙트 소유권은 당사가 갖는다. 스켈레톤은 최종 Phase 기준으로 설계되어 있다.

---

## 강의 파트 (25분)

### 0. 배포 파이프라인 전체 구조

```
개발자 로컬
    │
    │  npx hardhat run scripts/deploy.ts --network sepolia
    ▼
Hardhat upgrades 플러그인
    │
    ├─① Implementation 컨트랙트 배포 TX
    │       └── KyoboNFT 바이트코드 → Sepolia
    │
    ├─② ERC1967Proxy 배포 TX
    │       └── constructor(_implementation, _data)
    │           └── delegatecall → initialize(admin)
    │
    └─③ 배포 완료
           ├── Proxy 주소 (영구 주소)
           └── Implementation 주소 (업그레이드 시 변경)
                   │
                   ▼
           deployments/proxy-address.json에 저장
                   │
                   ▼
   npx hardhat verify (두 주소 각각 등록)
                   │
                   ▼
   Etherscan "Read as Proxy" → KyoboNFT 함수 노출
                   │
                   ▼
   issuer-service .env에 PROXY_ADDRESS 등록
                   │
                   ▼
   cast call로 온체인 상태 검증
```

---

### 1. Upgradeable 배포는 일반 배포와 다르다

일반 컨트랙트 배포: 하나의 트랜잭션.

UUPS 프록시 배포: 세 단계가 필요하다.

```
1단계: Implementation 컨트랙트 배포
       → KyoboNFT 로직 코드가 블록체인에 올라감
       → 아직 상태 없음, 초기화 안 됨

2단계: Proxy 컨트랙트 배포
       → Proxy가 Implementation 주소를 등록
       → 상태(storage)를 여기서 관리할 것

3단계: Proxy를 통해 initialize() 호출
       → Proxy.storage에 admin 역할 등록
       → 이후 이 Proxy 주소가 "KyoboNFT의 영구 주소"
```

`hardhat-upgrades` 플러그인이 이 3단계를 자동으로 처리한다.

---

### 2. Proxy 주소 vs Implementation 주소

배포 후 두 개의 주소가 생긴다.

| 주소 | 설명 | 변경 여부 |
|---|---|---|
| Proxy 주소 | 영구 사용 주소. 사용자·서비스가 이 주소로 호출 | 절대 변경 안 됨 |
| Implementation 주소 | 현재 로직 컨트랙트 주소 | 업그레이드 시 바뀜 |

issuer-service는 Proxy 주소만 환경변수에 저장한다. 업그레이드 후에도 변경 불필요.

---

### 2-1. Proxy 주소 vs Implementation 주소 — ERC-1967 슬롯

"Implementation 주소는 Proxy 어디에 저장되는가?"

ERC-1967 표준이 슬롯 위치를 지정한다:

```
Implementation 슬롯:
  bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
  = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc

Admin 슬롯:
  bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1)
  = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103
```

Proxy와 Implementation의 상태 변수가 같은 슬롯 번호를 쓰지 않도록, OZ는 이 특수 슬롯을 사용해 Implementation 주소를 별도로 보관한다.

`upgrades.erc1967.getImplementationAddress(proxyAddr)` 내부에서 이 슬롯을 직접 읽는다.

---

### 3. Etherscan 검증 — 왜 두 주소 모두 등록해야 하는가

Etherscan에서 "Read Contract" 탭을 쓰려면 소스코드가 등록되어 있어야 한다.

```
Proxy만 검증하면:
  Read Contract → Proxy의 함수(ERC1967Proxy의 함수)만 보임
  encodeTokenId, mint 등 KyoboNFT 함수가 안 보임
  
Implementation도 검증하면:
  Etherscan이 Proxy+Implementation 연결을 인식
  Read Contract → KyoboNFT의 모든 함수 노출
  → 직접 호출 테스트 가능
```

---

## 실습 파트 (40분)

### 배포 스크립트 작성

```typescript
// scripts/deploy.ts
import { ethers, upgrades } from 'hardhat';
import * as fs from 'fs';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deployer:', deployer.address);
  console.log('Balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)), 'ETH');

  const KyoboNFT = await ethers.getContractFactory('KyoboNFT');

  // hardhat-upgrades가 3단계를 자동 처리
  const nft = await upgrades.deployProxy(KyoboNFT, [deployer.address], {
    kind:        'uups',
    initializer: 'initialize',
  });
  await nft.waitForDeployment();

  const proxyAddr = await nft.getAddress();
  const implAddr  = await upgrades.erc1967.getImplementationAddress(proxyAddr);

  console.log('=== 배포 완료 ===');
  console.log('Proxy address:', proxyAddr);
  console.log('Implementation address:', implAddr);

  // 프록시 주소 저장 (업그레이드 스크립트에서 재사용)
  fs.mkdirSync('deployments', { recursive: true });
  fs.writeFileSync(
    'deployments/proxy-address.json',
    JSON.stringify({ proxy: proxyAddr, impl: implAddr, deployedAt: new Date().toISOString() }, null, 2),
  );

  // 초기 역할 확인
  const MINTER_ROLE = await nft.MINTER_ROLE();
  console.log('MINTER_ROLE assigned:', await nft.hasRole(MINTER_ROLE, deployer.address));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

### Sepolia 환경 설정

```bash
# .env
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_PROJECT_ID
PRIVATE_KEY=0xYourPrivateKey
ETHERSCAN_API_KEY=YourEtherscanApiKey
```

```typescript
// hardhat.config.ts
import { HardhatUserConfig } from "hardhat/config";
import "@openzeppelin/hardhat-upgrades";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  solidity: "0.8.20",
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
};

export default config;
```

### 배포 실행

```bash
# Sepolia ETH 충전 (Faucet: https://sepoliafaucet.com)
# 0.1 ETH 이상 필요

# 배포 실행
npx hardhat run scripts/deploy.ts --network sepolia

# 예상 출력:
# Deployer: 0xYourAddress
# Balance: 0.5 ETH
# === 배포 완료 ===
# Proxy address: 0xProxyAddress
# Implementation address: 0xImplAddress
```

### Etherscan 소스코드 검증

```bash
# Implementation 검증
npx hardhat verify --network sepolia IMPLEMENTATION_ADDRESS

# Proxy 검증 (OZ Proxy 플러그인 사용)
npx hardhat verify --network sepolia PROXY_ADDRESS
```

검증 후 확인:
1. https://sepolia.etherscan.io/address/PROXY_ADDRESS
2. "Contract" 탭 → "Read as Proxy" 선택
3. `encodeTokenId(1, 42)` 호출 → 예상 값 확인

### 배포 관리 파일 구조

```
deployments/
├── proxy-address.json     ← { proxy: "0x...", impl: "0x...", deployedAt: "..." }
├── upgrade-v2.json        ← v2 업그레이드 후 새 impl 주소
└── deploy-log.md          ← 배포 이력 메모
```

### 배포 후 체크리스트

```bash
# 1. 역할 확인
cast call PROXY_ADDR \
  "hasRole(bytes32,address)(bool)" \
  $(cast keccak "MINTER_ROLE") \
  YOUR_ADDRESS \
  --rpc-url $SEPOLIA_RPC_URL
# → true 확인

# 2. tokenId 인코딩 테스트
cast call PROXY_ADDR \
  "encodeTokenId(uint64,uint64)(uint256)" \
  1 42 \
  --rpc-url $SEPOLIA_RPC_URL
# → 예상: 18446744073709551658 (0x0000000000000001_000000000000002A)
```

---

### 배포 오류 트러블슈팅

| 오류 메시지 | 원인 | 해결 |
|---|---|---|
| `insufficient funds` | Sepolia ETH 부족 | Faucet에서 충전 |
| `nonce too low` | 이전 TX 처리 대기 중 | 잠시 대기 후 재시도 |
| `already verified` | 이미 등록된 소스코드 | 무시해도 됨 |
| `no bytecode at address` | 배포 전 verify 시도 | TX 확인 후 verify |
| `New storage layout is incompatible` | Storage Collision 감지 | 슬롯 레이아웃 점검 (S40 참조) |

---

## 완료 기준

- [ ] Sepolia 배포 성공 (TX 해시 기록)
- [ ] Proxy 주소 + Implementation 주소 양쪽 Etherscan verify 통과
- [ ] Etherscan "Read as Proxy" 탭에서 `encodeTokenId(1, 42)` 호출 확인
- [ ] `deployments/proxy-address.json` 저장 완료
- [ ] `cast call`로 MINTER_ROLE 보유 확인 (true 반환)
- [ ] 배포 파이프라인 전체 흐름(3단계) 순서 설명 가능
- [ ] Proxy 주소와 Implementation 주소의 차이 및 ERC-1967 슬롯 설명 가능
