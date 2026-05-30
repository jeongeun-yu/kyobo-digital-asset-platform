# M7 S41 — Hardhat 배포 스크립트 + Sepolia 배포 + Etherscan 검증

> 모듈 7 · 세션 41 · 1시간  
> 강의 40분 + 실습 20분  
> 실습 환경: Hardhat + Sepolia 테스트넷

---

## [강사 배경] — 120분 분량 심화 지식

> 이 섹션은 강의에서 직접 읽지 않는다. 수강생 질문에 즉시 답하고, 개념 설명에 자신감을 갖기 위한 배경이다.

### A. Sepolia 테스트넷 — 왜 테스트넷이 필요하며 어떻게 동작하는가

**테스트넷의 존재 이유:**  
메인넷 배포는 실제 ETH를 소비하고, 코드 버그가 실제 자산 손실로 이어진다. 테스트넷은 동일한 이더리움 프로토콜을 사용하지만, ETH가 무가치(faucet으로 무료 수령)하고 실수해도 실제 손해가 없다. 개발자는 테스트넷에서 배포, 트랜잭션, 이벤트, 업그레이드 전 과정을 실제 네트워크 환경에서 검증한 후 메인넷에 올린다.

**이더리움 테스트넷 역사:**

```
Ropsten (2016~2022):
  PoW 기반. 채굴 난이도가 낮아 스팸 공격에 취약.
  2022년 Merge(PoS 전환) 이후 deprecated.

Rinkeby (2017~2022):
  PoA(Clique 합의). 빠르지만 중앙화. 2022년 deprecated.

Goerli (2019~2023):
  PoA → PoS 전환. 오랫동안 표준. 2023년 이후 deprecated 방향.

Sepolia (2021~현재):
  현재 이더리움 재단 공식 권장 테스트넷.
  PoS 기반. 메인넷과 동일한 합의 메커니즘.
  블록 시간: ~12초 (메인넷과 동일).
  밸리데이터 집합이 제한적(허가형) → 안정적.
```

**Sepolia vs 메인넷 주요 차이:**

| 항목 | Sepolia | Mainnet |
|---|---|---|
| 체인 ID | 11155111 | 1 |
| ETH 가치 | 무가치 (faucet 수령) | 실제 가치 |
| 컨트랙트 주소 | 메인넷과 다름 | 메인넷 기준 |
| 블록 시간 | ~12초 | ~12초 |
| 합의 | PoS | PoS |
| Etherscan | sepolia.etherscan.io | etherscan.io |

**컨트랙트 주소가 메인넷과 다른 이유:**  
컨트랙트 주소는 `keccak256(deployer_address, nonce)`로 결정된다. 동일한 deployer 주소를 사용해도, 메인넷과 Sepolia에서 nonce가 다르므로 컨트랙트 주소가 달라진다. Sepolia에서 `0xAbCd...` 주소에 배포했다고 메인넷에서도 같은 주소가 되는 것이 아니다.

---

### B. Hardhat 배포 방식 — 스크립트 vs Ignition

**Hardhat 구버전 방식 (우리가 사용):**  
`scripts/deploy.ts`를 직접 작성하고 `npx hardhat run`으로 실행한다. JavaScript/TypeScript의 제어 흐름 전체를 활용할 수 있어 조건부 배포, 환경 변수 분기, 복잡한 초기화 순서 처리가 용이하다.

**Hardhat Ignition (신버전, Hardhat 2.22+):**  
2023년 도입된 선언적 배포 시스템. 배포 "모듈"을 정의하면 Ignition이 배포 순서를 자동으로 결정하고, 이미 배포된 컨트랙트는 재배포하지 않는다(멱등성). 배포 상태를 JSON으로 추적하므로 중단 후 재개가 가능하다.

```typescript
// Ignition 방식 예시 (참고용)
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const KyoboModule = buildModule("KyoboModule", (m) => {
  const kyoboNFT = m.contract("KyoboNFT");
  return { kyoboNFT };
});
```

**우리가 스크립트 방식을 쓰는 이유:**  
- Ignition은 UUPS `upgradeProxy` 같은 OZ 플러그인 함수를 직접 지원하지 않는다
- 배포 순서가 컨트랙트 간 의존성으로 명확히 고정되어 있어 선언적 방식의 이점이 적다
- 환경 변수 분기(oracle signer 주소 등)가 스크립트로 더 직관적이다

---

### C. Etherscan 검증 실패 원인과 대응

**검증이란 무엇인가:**  
Etherscan은 배포된 bytecode를 받아 제출한 소스코드로 컴파일한 결과와 비교한다. bytecode가 일치하면 소스코드 공개 처리된다. 일치하지 않으면 "컴파일 설정이 다르다"는 의미다.

**실패 원인 1 — 컴파일러 설정 불일치:**

```
배포 시:    optimizer.runs=200, evmVersion='cancun'
검증 시도:  runs=300 으로 제출
결과:       bytecode 불일치 → 검증 실패
```

`hardhat.config.ts`의 설정값이 배포 시와 검증 시 완전히 동일해야 한다. `hardhat verify` 플러그인은 `hardhat.config.ts`에서 컴파일러 설정을 자동으로 읽어 제출하므로, 설정을 변경하지 않은 채 verify를 실행하면 대부분 일치한다.

**실패 원인 2 — constructor arguments 인코딩 오류:**

```bash
# constructor에 인자가 있는 컨트랙트
npx hardhat verify --network sepolia <주소> "arg1" "arg2"

# KyoboNFT는 constructor 인자 없음 (initializer로 처리하므로)
npx hardhat verify --network sepolia <구현체 주소>
```

constructor 인자가 있는데 생략하거나, 없는데 추가하면 검증 실패.

**실패 원인 3 — 타임아웃 (contract not found):**  
배포 트랜잭션이 채굴된 후 Etherscan indexer가 컨트랙트를 인식하는 데 10~30초 걸린다. 즉시 verify를 시도하면 "contract not found" 오류가 난다. 배포 스크립트에서 `await new Promise(r => setTimeout(r, 10_000))`으로 10초 대기하는 이유다.

**수동 verify 방법 (스크립트 실패 시):**

```
1. sepolia.etherscan.io/address/<컨트랙트 주소> 접속
2. Contract 탭 → Verify and Publish 클릭
3. 컴파일러 버전: 0.8.24 선택
4. Optimization: Enabled, Runs: 200
5. 소스코드 붙여넣기 (Flattened 또는 Multi-file)
6. Submit
```

**"Is this a proxy?" 수동 클릭이 필요한 이유:**  
Etherscan은 ERC1967 슬롯을 자동으로 감지하지만, UUPS의 경우 자동 감지가 실패하는 경우가 있다. 수동으로 "More Options → Is this a proxy?" → Verify를 클릭하면 Etherscan이 Implementation Slot(`_IMPLEMENTATION_SLOT`)을 읽어 구현체 주소를 연결한다. 이 과정이 완료되어야 "Read as Proxy" / "Write as Proxy" 탭이 활성화된다.

---

### D. nonce 관리 실무

**nonce란:**  
이더리움 계정마다 트랜잭션 카운터(nonce)가 있다. 첫 번째 TX는 nonce=0, 두 번째는 nonce=1. 같은 nonce로 두 TX가 제출되면 먼저 채굴된 것만 유효하고, 나머지는 무효화된다.

**배포 스크립트에서 nonce 충돌이 생기는 상황:**

```
시나리오: 배포 스크립트를 두 번 동시 실행했을 때
  스크립트 A: TX1 (nonce=5, ActivityOracle 배포)
  스크립트 B: TX1 (nonce=5, ActivityOracle 배포)
  → 두 TX가 동일 nonce로 전송됨
  → 먼저 채굴된 TX만 성공
  → 나중 TX는 "nonce too low" 오류로 드롭됨
```

배포 스크립트는 동시에 두 번 실행하지 않는 것이 기본 원칙이다.

**Pending TX 취소 방법 (실수로 잘못된 TX를 전송했을 때):**

```bash
# 같은 nonce로 빈 트랜잭션을 더 높은 gas price로 전송
# 목적: 잘못된 TX를 "대체(replace)"하여 채굴 방지
cast send --rpc-url $SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --nonce <잘못된 TX의 nonce> \
  --gas-price <기존보다 10% 이상 높게> \
  <deployer 자신의 주소> \
  --value 0
```

Metamask에서는 Settings → Advanced → Reset Account로 pending TX를 취소할 수 있다.

**nonce 확인 방법:**

```typescript
const nonce = await ethers.provider.getTransactionCount(deployer.address);
console.log('현재 nonce:', nonce);
// 또는 pending 포함
const pendingNonce = await ethers.provider.getTransactionCount(
  deployer.address, 'pending'
);
```

---

### E. RPC 엔드포인트 선택

**Public RPC vs 유료 서비스:**

```
Public RPC (rpc.sepolia.org, sepolia.drpc.org 등):
  - 무료
  - rate limit 있음 (초당 요청 제한)
  - 간헐적 불안정 (다운타임, 느린 응답)
  - 강의 실습용으로 충분

Alchemy (https://alchemy.com):
  - 무료 tier: 월 3억 Compute Units (일반 사용에 충분)
  - 안정적, 빠름
  - 추가 기능: NFT API, Webhook, Gas Manager

Infura (https://infura.io):
  - 무료 tier: 일 10만 건 요청
  - 오랜 역사, 안정적
  - 메타마스크 기본 RPC 제공자

QuickNode:
  - 유료 중심, 가장 빠름
  - 프로덕션 환경에 적합
```

**WebSocket vs HTTPS:**  
HTTPS는 요청-응답 방식. 이벤트를 받으려면 주기적으로 폴링해야 한다.  
WebSocket(`wss://`)은 연결을 유지하며 실시간 이벤트 구독이 가능하다.

```typescript
// HTTPS: 폴링 방식
const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);

// WebSocket: 실시간 구독
const wsProvider = new ethers.WebSocketProvider(SEPOLIA_WSS_URL);
wsProvider.on('block', (blockNumber) => {
  console.log('새 블록:', blockNumber);
});

// 이벤트 구독 (WebSocket 필요)
nft.on('TransferSingle', (operator, from, to, id, value) => {
  console.log('NFT 전송:', { from, to, id: id.toString(), value });
});
```

M3 TxStateMachine의 이벤트 추적은 WebSocket이 더 효율적이다.

---

### F. Hardhat Ignition vs 스크립트: 실무 선택 기준 심화

**대규모 프로토콜 배포 시 스크립트의 함정:**

```typescript
// 문제: 배포 중간에 실패하면 어디서부터 재시작해야 하나?
async function main() {
  const oracle = await Oracle.deploy(...);       // 성공
  const compliance = await Compliance.deploy(); // 성공
  const nft = await upgrades.deployProxy(...);  // 실패! (gas 부족)
  // oracle, compliance는 이미 배포됨
  // 전체 재실행하면 중복 배포됨
}
```

해결 방법: 배포된 주소를 파일에 기록하고, 재실행 시 이미 배포된 컨트랙트는 skip한다.

```typescript
import fs from 'fs';

const DEPLOYMENT_FILE = '.deployment.json';
let deployed: Record<string, string> = {};

if (fs.existsSync(DEPLOYMENT_FILE)) {
  deployed = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
}

function saveDeployment() {
  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(deployed, null, 2));
}

// Oracle 배포 (이미 배포된 경우 skip)
let oracleAddr = deployed['ActivityOracle'];
if (!oracleAddr) {
  const oracle = await Oracle.deploy(...);
  await oracle.waitForDeployment();
  oracleAddr = await oracle.getAddress();
  deployed['ActivityOracle'] = oracleAddr;
  saveDeployment();  // 즉시 저장
}
```

---

## 강의 파트 (40분)

### 1. 배포 전 체크리스트

S40에서 KyoboNFT.sol 코드와 테스트를 완성했다. Sepolia에 올리기 전에 확인할 것들:

```
① 테스트 전부 passing
   npx hardhat test test/KyoboNFT.test.ts → 전체 green

② 컴파일 오류 없음
   npx hardhat compile

③ .env 필수 항목 채워짐
   DEPLOYER_PRIVATE_KEY   — 배포 전용 EOA 개인키
   SEPOLIA_RPC_URL        — Sepolia RPC 엔드포인트
   ETHERSCAN_API_KEY      — Etherscan 검증용 API 키

④ 배포 계정에 Sepolia ETH 잔액
   faucet: https://sepoliafaucet.com
   최소 0.1 ETH 필요 (컨트랙트 4개 배포 비용)
```

**DEPLOYER_PRIVATE_KEY 보안 원칙:**
- 운영 계정 키와 절대 공유하지 않는다
- `.env`는 `.gitignore`에 반드시 포함
- 강의용 키는 강의 종료 후 폐기

---

### 2. .env 설정

```bash
# .env (프로젝트 루트)
DEPLOYER_PRIVATE_KEY=0x...    # 배포 전용 계정 개인키 (Sepolia 전용)
SEPOLIA_RPC_URL=https://rpc.sepolia.org
ETHERSCAN_API_KEY=...         # https://etherscan.io/myapikey 에서 발급
```

**SEPOLIA_RPC_URL 옵션:**

| 서비스 | URL | 특징 |
|---|---|---|
| Public RPC | `https://rpc.sepolia.org` | 무료, 간헐적 불안정 |
| Alchemy | `https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY` | 안정적, 무료 tier 있음 |
| Infura | `https://sepolia.infura.io/v3/YOUR_KEY` | 안정적, 무료 tier 있음 |

강의 실습에서는 Public RPC로 충분하다. 자주 끊기면 Alchemy 무료 키 발급.

---

### 3. hardhat.config.ts — 네트워크 설정 확인

```typescript
// blockchain/hardhat.config.ts (현재 설정)
const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'cancun',
    },
  },
  networks: {
    sepolia: {
      url:      process.env.SEPOLIA_RPC_URL ?? '',
      accounts: process.env.DEPLOYER_PRIVATE_KEY
                  ? [process.env.DEPLOYER_PRIVATE_KEY]
                  : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? '',
  },
  paths: {
    sources:   './src',
    tests:     './test',
    artifacts: './artifacts',
  },
};
```

**`optimizer.runs: 200` 의미:**  
솔리디티 컴파일러 최적화 파라미터. "이 함수가 200번 호출되는 것을 기준으로 trade-off를 결정하라"는 의미. 높게 설정할수록 실행 gas는 낮아지지만 배포 bytecode 크기(배포 gas)가 커진다. `runs=200`은 OZ 기본값이며, 대부분의 컨트랙트에 적합하다.

**`viaIR: true`:**  
컴파일 과정에서 Yul(중간 표현 언어)을 경유한다. 더 강력한 최적화가 가능하지만 컴파일 시간이 증가한다. 다중 상속, 복잡한 override 구조에서 "Stack too deep" 오류를 방지하는 효과도 있다.

**`evmVersion: 'cancun'`:**  
Cancun 업그레이드(EIP-4844, transient storage 등)의 EVM opcode를 사용. 메인넷과 Sepolia 모두 Cancun을 지원한다.

---

### 4. deploy-rewards.ts 전체 흐름

```typescript
// blockchain/scripts/deploy/deploy-rewards.ts 핵심 흐름

import { ethers, upgrades } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('배포 계정:', deployer.address);
  console.log('잔액:', ethers.formatEther(
    await ethers.provider.getBalance(deployer.address)
  ), 'ETH');

  // ① ActivityOracle 배포 — 일반 컨트랙트, constructor로 초기화
  const Oracle = await ethers.getContractFactory('ActivityOracle');
  const oracle = await Oracle.deploy(
    process.env.ORACLE_SIGNER_ADDRESS ?? deployer.address,
  );
  await oracle.waitForDeployment();
  console.log('ActivityOracle:', await oracle.getAddress());

  // ② PermissiveCompliance 배포 — Phase 1 최소 컴플라이언스
  const Compliance = await ethers.getContractFactory('PermissiveCompliance');
  const compliance = await Compliance.deploy();
  await compliance.waitForDeployment();

  // ③ KyoboNFT UUPS Proxy 배포
  //    deployProxy = 구현체 + ERC1967Proxy 동시 배포
  //    반환값 = 프록시 인스턴스 (이 주소가 실제 사용 주소)
  const KyoboNFT = await ethers.getContractFactory('KyoboNFT');
  const nft = await upgrades.deployProxy(
    KyoboNFT,
    [deployer.address],           // initialize(admin) 인자
    { kind: 'uups', initializer: 'initialize' },
  );
  await nft.waitForDeployment();
  const nftProxyAddr = await nft.getAddress();
  console.log('KyoboNFT (proxy):', nftProxyAddr);

  // ④ NFTIssuer 배포 — 발행 게이트웨이
  const Issuer = await ethers.getContractFactory('NFTIssuer');
  const issuer = await Issuer.deploy(nftProxyAddr, await oracle.getAddress());
  await issuer.waitForDeployment();
  const issuerAddr = await issuer.getAddress();

  // ⑤ KyoboNFT에 NFTIssuer MINTER_ROLE 부여
  //    배포자(deployer)가 MINTER_ROLE을 갖고 있으므로 grantRole 가능
  const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('MINTER_ROLE'));
  await nft.grantRole(MINTER_ROLE, issuerAddr);
  console.log('MINTER_ROLE → NFTIssuer 완료');

  // 결과 출력
  console.log(`KYOBO_NFT_PROXY_ADDR=${nftProxyAddr}`);
  console.log(`NFT_ISSUER_ADDR=${issuerAddr}`);
}

main().catch(err => { console.error(err); process.exit(1); });
```

**배포 순서가 중요한 이유:**

```
ActivityOracle (선행) → NFTIssuer 생성자에 주소 전달
KyoboNFT (선행)       → NFTIssuer 생성자에 프록시 주소 전달
NFTIssuer (후)        → 배포 후 KyoboNFT에 MINTER_ROLE 부여
```

순서를 바꾸면 생성자 인자로 넘길 주소를 모른다.

**`waitForDeployment()` vs `deployed()` (구버전):**  
Ethers v6부터 `deployed()`가 `waitForDeployment()`로 이름이 바뀌었다. 의미는 동일하다: 배포 TX가 채굴될 때까지 대기. 이 라인이 없으면 다음 TX에서 이전 컨트랙트 주소를 참조할 때 아직 채굴이 완료되지 않아 오류가 날 수 있다.

---

### 5. upgrades.deployProxy 내부 동작

```
upgrades.deployProxy(KyoboNFT, [deployer.address], { kind: 'uups' })
          ↓
① KyoboNFT 구현체 컨트랙트 배포 (constructor 실행 → _disableInitializers)
② ERC1967Proxy 배포
③ Proxy → 구현체 delegatecall로 initialize(deployer.address) 호출
④ .openzeppelin/sepolia.json에 storage layout 기록
⑤ 프록시 인스턴스 반환
```

**배포 후 생성되는 것:**

```
Sepolia Etherscan에서 확인 가능한 컨트랙트:
  [프록시 주소]     ERC1967Proxy   ← 사용자가 상호작용하는 주소
  [구현체 주소]     KyoboNFT       ← 실제 코드가 있는 주소
  [issuer 주소]     NFTIssuer
  [oracle 주소]     ActivityOracle
```

프록시 주소는 변하지 않는다. 업그레이드해도 동일한 주소를 유지한다. VASP, 내부 시스템, 오프체인 서비스 모두 프록시 주소를 사용한다.

**구현체 주소 확인 방법:**

```typescript
// 방법 1: upgrades 헬퍼
const implAddr = await upgrades.erc1967.getImplementationAddress(
  await nft.getAddress()
);

// 방법 2: .openzeppelin/sepolia.json 파일 직접 확인
// { "proxies": [{ "address": "프록시", "implementation": "구현체" }] }

// 방법 3: storage 슬롯 직접 읽기 (검증용)
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const rawImpl = await ethers.provider.getStorage(proxyAddr, IMPL_SLOT);
const implFromSlot = '0x' + rawImpl.slice(-40);
```

---

### 6. Etherscan 소스코드 검증

배포만으로는 Etherscan에서 소스코드를 볼 수 없다. `verify:verify` 명령으로 소스를 제출해야 한다.

**왜 검증이 중요한가:**
- VASP, 규제기관, 감사자가 온체인 코드를 직접 확인할 수 있다
- ABI를 Etherscan에서 바로 확인·호출 가능
- 신뢰 수단 — "이 주소에 배포된 코드가 우리가 감사한 코드와 동일하다"

**UUPS 프록시 검증 — 2단계 필요:**

```bash
# 1단계: 구현체 검증
npx hardhat verify --network sepolia <구현체 주소>

# 2단계: 프록시 검증 (Etherscan이 구현체와 연결)
# Etherscan 사이트에서 직접:
# 프록시 주소 → More Options → Is this a proxy? → Verify
# → 구현체 주소 자동 감지 → Confirm
```

검증 완료 후 Etherscan에서:
- 프록시 주소 → "Read as Proxy" / "Write as Proxy" 탭 활성화
- ABI에서 `mint`, `balanceOf` 등 직접 호출 가능

**자동 verify 스크립트 패턴:**

```typescript
// 배포 스크립트 끝에 추가
console.log('10초 대기 후 Etherscan 검증...');
await new Promise(r => setTimeout(r, 10_000));

try {
  await run('verify:verify', {
    address: implAddress,       // 구현체 주소 (프록시 아님)
    constructorArguments: [],   // KyoboNFT constructor는 인자 없음
  });
  console.log('Etherscan 검증 완료');
} catch (e: any) {
  if (e.message.includes('Already Verified')) {
    console.log('이미 검증된 컨트랙트');
  } else {
    console.warn('검증 실패 — 수동으로 재시도:', e.message);
  }
}
```

10초 대기 이유: Etherscan indexer가 트랜잭션을 인식하는 데 시간이 걸린다. 바로 검증을 시도하면 "contract not found" 오류가 난다.

**검증 시 "Already Verified" 처리:**  
동일한 bytecode가 이전에 다른 주소에서 검증된 경우 Etherscan은 소스코드를 재사용한다. "Already Verified" 메시지는 오류가 아니라 성공을 의미한다.

---

### 7. 배포 후 .env 업데이트 + 시스템 연결

배포 스크립트 출력:

```
KyoboNFT (proxy): 0xAbCd...
NFTIssuer:        0x1234...
ActivityOracle:   0x5678...

KYOBO_NFT_PROXY_ADDR=0xAbCd...
NFT_ISSUER_ADDR=0x1234...
ORACLE_ADDR=0x5678...
```

이 주소들을 `.env`에 기록한다:

```bash
# .env에 추가
KYOBO_NFT_PROXY_ADDR=0xAbCd...
NFT_ISSUER_ADDR=0x1234...
ORACLE_ADDR=0x5678...
```

**Phase 1 시스템 연결:**

```
M5 VaspAdapter
  → VASP_API_URL + VASP_API_KEY로 VASP 서버 호출
    → VASP 서버가 KYOBO_NFT_PROXY_ADDR 주소의 KyoboNFT.mint() 호출
      → Sepolia에서 실제 트랜잭션 발생
        → M3 TxStateMachine이 txHash 추적
          → M2 WebhookReceiver 콜백 수신
            → M4 원장 업데이트
```

프록시 주소 하나로 전체 Phase 1 흐름이 연결된다.

---

### 8. 배포 검증 — Etherscan에서 확인할 것들

```
① 프록시 주소 접속
   → Contract 탭 → "ERC1967 Proxy" 표시 확인
   → Implementation 주소 표시 (구현체 주소)

② Read as Proxy 탭
   → MINTER_ROLE (bytes32 값 확인)
   → hasRole(MINTER_ROLE, NFTIssuer주소) → true 확인
   → paused() → false 확인

③ Write as Proxy 탭 (MetaMask 연결 후)
   → grantRole 호출 가능 (DEFAULT_ADMIN_ROLE 보유 계정만)

④ 구현체 주소 접속
   → Contract 탭 → 소스코드 표시 확인
   → "This contract is an ERC1967 proxy" 배지 확인
```

---

## 실습 파트 (20분)

### Sepolia 배포 전 과정 실행

**① 환경 확인 (3분)**

```bash
cd F:\Workplace\kyobo-digital-asset-platform\blockchain

# .env 확인 (값이 채워져 있는지)
cat ../.env | grep -E "DEPLOYER_PRIVATE_KEY|SEPOLIA_RPC_URL|ETHERSCAN_API_KEY"

# 컴파일
npx hardhat compile
# Compiled X Solidity files successfully

# 테스트 전부 green 확인
npx hardhat test test/KyoboNFT.test.ts
```

**② Sepolia 배포 (10분)**

```bash
npx hardhat run scripts/deploy/deploy-rewards.ts --network sepolia
```

예상 출력:

```
배포 계정: 0x91ff...
잔액: 0.234 ETH

ActivityOracle: 0x...
PermissiveCompliance: 0x...
KyoboNFT (proxy): 0x...       ← 이 주소를 .env에 기록
NFTIssuer: 0x...
MINTER_ROLE granted to NFTIssuer

── 배포 완료 ──────────────────────────
KYOBO_NFT_PROXY_ADDR=0x...
NFT_ISSUER_ADDR=0x...
ORACLE_ADDR=0x...
```

**③ Etherscan 검증 (5분)**

```bash
# 구현체 주소는 deployProxy 로그에서 확인
# (또는 .openzeppelin/sepolia.json 에서 impl 주소 확인)
npx hardhat verify --network sepolia <구현체 주소>
```

**④ Etherscan에서 확인 (2분)**

```
https://sepolia.etherscan.io/address/<프록시 주소>

Read as Proxy 탭
→ hasRole(MINTER_ROLE, <NFTIssuer 주소>) → true 확인
→ paused() → false 확인
```

---

## 완료 기준

- [ ] `npx hardhat compile` 오류 없음
- [ ] `npx hardhat test test/KyoboNFT.test.ts` 전부 passing
- [ ] `deploy-rewards.ts --network sepolia` 실행 → 4개 컨트랙트 배포 완료
- [ ] `.env`에 `KYOBO_NFT_PROXY_ADDR` / `NFT_ISSUER_ADDR` 기록 완료
- [ ] Etherscan에서 구현체 소스코드 검증 완료
- [ ] Etherscan Read as Proxy → `hasRole(MINTER_ROLE, issuerAddr)` = true 확인
- [ ] "프록시 주소가 업그레이드 후에도 불변인 이유" 설명 가능
- [ ] "배포 순서가 고정인 이유" 설명 가능

---

## 강사 노트

**흔한 오류 1 — RPC 연결 실패:**

```
Error: could not detect network
→ SEPOLIA_RPC_URL 확인. 공개 RPC가 불안정하면 Alchemy/Infura 키 사용
→ npx hardhat run ... --network sepolia 실행 전 .env 로드 확인
```

**흔한 오류 2 — 잔액 부족:**

```
Error: insufficient funds
→ sepoliafaucet.com 또는 alchemy faucet에서 ETH 추가 수령
→ 컨트랙트 4개 배포: 약 0.05~0.15 ETH 소비 (gas price에 따라 변동)
```

**흔한 오류 3 — Etherscan verify 실패:**

```
Error: contract not found
→ 트랜잭션이 아직 indexing 중. 2~3분 후 재시도
→ 또는 ETHERSCAN_API_KEY 미설정

Error: bytecode mismatch
→ hardhat.config.ts의 compiler settings를 확인
→ optimizer runs, evmVersion이 배포 시와 동일한지 확인

Error: constructor arguments mismatch
→ KyoboNFT는 constructor 인자가 없음. --constructor-args 플래그 없이 verify
```

**verify 명령에 구현체 vs 프록시 주소 혼동:**  
가장 흔한 실수다. `verify`는 구현체 주소에 해야 한다. 프록시 주소로 verify를 시도하면 "ERC1967 proxy detected, verify the implementation instead" 오류가 난다.

**프록시 주소 확인 방법:**  
배포 스크립트 출력의 `KYOBO_NFT_PROXY_ADDR`가 프록시다. 구현체 주소는 `.openzeppelin/sepolia.json`을 열어 `"address"` 필드로 확인. 두 주소를 혼동하면 verify나 업그레이드에서 오류가 난다.

**Sepolia ETH faucet이 모두 막혔을 때:**  
- Google "Sepolia faucet" → Alchemy Faucet, QuickNode Faucet, Chainlink Faucet 순으로 시도
- 일부 faucet은 메인넷 잔액 요건이 있음 (Alchemy는 0.001 ETH 메인넷 요건)
- 강의용으로 배포자가 Sepolia ETH를 미리 확보해 수강생에게 소량 전송하는 방법도 있음

**S42 예고:**  
다음 시간은 UUPS 업그레이드 실습. 오늘 배포한 KyoboNFT v1에 새 기능(`baseURI`, `version`)을 추가한 v2를 작성하고 `upgradeProxy`로 교체한다. Storage Layout 충돌을 의도적으로 만들어 에러를 확인한 뒤 올바른 방법으로 수정하는 과정을 직접 겪는다.
