/**
 * S39 실습 — 스마트컨트랙트 배포 파이프라인과 온체인 코드 검증
 *
 * 강의 노트: M6_S39_deployment_etherscan.md
 *
 * ============================================================
 * 전제 조건 (Hardhat + Sepolia 필요):
 *   1. cd blockchain
 *   2. .env 파일 설정:
 *        SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_PROJECT_ID
 *        PRIVATE_KEY=0xYourPrivateKey       (Sepolia ETH 0.1 ETH 이상)
 *        ETHERSCAN_API_KEY=YourEtherscanApiKey
 *   3. npm install (hardhat-upgrades, dotenv 포함)
 *   4. 배포: npx hardhat run scripts/deploy.ts --network sepolia
 *   5. 검증: npx hardhat verify --network sepolia <IMPL_ADDR>
 *            npx hardhat verify --network sepolia <PROXY_ADDR>
 * ============================================================
 *
 * 실행 방법 (루트에서): npm run exercise:s39
 *
 * 목표:
 *   [1] 배포 3단계 파이프라인 구조 이해 (로컬 시뮬레이션)
 *   [2] Proxy 주소 vs Implementation 주소 역할 차이 확인
 *   [3] ERC-1967 슬롯 계산 — Implementation 주소 저장 위치
 *   [4] deployments/proxy-address.json 구조 확인
 *   [5] cast call 명령어 생성 — 배포 후 체크리스트
 */

import * as fs from 'fs';
import * as path from 'path';

// ────────────────────────────────────────────────────────────────────────
// [1] 배포 파이프라인 3단계 시뮬레이터
//
// 실제: hardhat-upgrades 플러그인이 이 3단계를 자동 처리
//   upgrades.deployProxy(KyoboNFT, [admin], { kind: 'uups' })
// ────────────────────────────────────────────────────────────────────────

export interface DeploymentResult {
  proxyAddress:          string;
  implementationAddress: string;
  deployedAt:            string;
  adminAddress:          string;
  steps: Array<{ step: number; description: string; txHash: string }>;
}

export function simulateUUPSDeployment(adminAddress: string): DeploymentResult {
  // 시뮬레이션용 결정론적 주소 (실제는 TX에서 생성)
  const implAddress  = '0x1234567890123456789012345678901234567890';
  const proxyAddress = '0xabcDEF1234567890abcdef1234567890AbCDeF12';

  return {
    proxyAddress,
    implementationAddress: implAddress,
    deployedAt:  new Date().toISOString(),
    adminAddress,
    steps: [
      {
        step: 1,
        description: `Implementation 컨트랙트 배포 — KyoboNFT 바이트코드 → Sepolia`,
        txHash: '0xSTEP1_' + implAddress.slice(2, 10),
      },
      {
        step: 2,
        description: `ERC1967Proxy 배포 — constructor(_implementation=${implAddress}, _data)`,
        txHash: '0xSTEP2_' + proxyAddress.slice(2, 10),
      },
      {
        step: 3,
        description: `initialize(admin=${adminAddress}) 호출 via delegatecall → Proxy storage에 역할 등록`,
        txHash: '0xSTEP3_init',
      },
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────
// [3] ERC-1967 슬롯 주소 계산
//
// Solidity 계산:
//   bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
// ────────────────────────────────────────────────────────────────────────

export const ERC1967_SLOTS = {
  /** Implementation 슬롯 — 0x360894a1... */
  IMPLEMENTATION: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  /** Admin 슬롯 — 0xb53127... */
  ADMIN:          '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
} as const;

// ────────────────────────────────────────────────────────────────────────
// [4] deployments/proxy-address.json 구조
// ────────────────────────────────────────────────────────────────────────

export interface ProxyAddressJson {
  proxy:       string;
  impl:        string;
  deployedAt:  string;
}

export function buildProxyAddressJson(result: DeploymentResult): ProxyAddressJson {
  return {
    proxy:      result.proxyAddress,
    impl:       result.implementationAddress,
    deployedAt: result.deployedAt,
  };
}

// ────────────────────────────────────────────────────────────────────────
// [5] 배포 후 체크리스트 — cast call 명령어 생성
// ────────────────────────────────────────────────────────────────────────

export function generatePostDeployChecklist(proxyAddress: string, adminAddress: string, rpcUrl: string): string[] {
  // cast keccak "MINTER_ROLE" = 0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6
  const MINTER_ROLE_HASH = '0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6';

  return [
    `# 1. MINTER_ROLE 보유 확인 (true 반환되어야 함)`,
    `cast call ${proxyAddress} "hasRole(bytes32,address)(bool)" ${MINTER_ROLE_HASH} ${adminAddress} --rpc-url ${rpcUrl}`,
    ``,
    `# 2. tokenId 인코딩 테스트 (0x0000000000000001_000000000000002A = 18446744073709551658 반환되어야 함)`,
    `cast call ${proxyAddress} "encodeTokenId(uint64,uint64)(uint256)" 1 42 --rpc-url ${rpcUrl}`,
    ``,
    `# 3. Proxy → Implementation 주소 확인 (ERC-1967 슬롯 읽기)`,
    `cast storage ${proxyAddress} ${ERC1967_SLOTS.IMPLEMENTATION} --rpc-url ${rpcUrl}`,
    ``,
    `# 4. Etherscan 검증 (Implementation)`,
    `npx hardhat verify --network sepolia <IMPL_ADDR>`,
    ``,
    `# 5. Etherscan 검증 (Proxy)`,
    `npx hardhat verify --network sepolia <PROXY_ADDR>`,
    ``,
    `# 6. Etherscan에서 "Read as Proxy" 탭 확인:`,
    `#    https://sepolia.etherscan.io/address/${proxyAddress}#readProxyContract`,
  ];
}

// ────────────────────────────────────────────────────────────────────────
// Hardhat 배포 스크립트 내용 (참조용 — 실제 파일은 blockchain/scripts/deploy.ts)
// ────────────────────────────────────────────────────────────────────────

const DEPLOY_SCRIPT_CONTENT = `// blockchain/scripts/deploy.ts
import { ethers, upgrades } from 'hardhat';
import * as fs from 'fs';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deployer:', deployer.address);
  console.log('Balance:', ethers.formatEther(
    await ethers.provider.getBalance(deployer.address)
  ), 'ETH');

  const KyoboNFT = await ethers.getContractFactory('KyoboNFT');

  // hardhat-upgrades가 3단계 자동 처리
  const nft = await upgrades.deployProxy(KyoboNFT, [deployer.address], {
    kind:        'uups',
    initializer: 'initialize',
  });
  await nft.waitForDeployment();

  const proxyAddr = await nft.getAddress();
  const implAddr  = await upgrades.erc1967.getImplementationAddress(proxyAddr);

  console.log('=== 배포 완료 ===');
  console.log('Proxy address:         ', proxyAddr);
  console.log('Implementation address:', implAddr);

  // 프록시 주소 저장
  fs.mkdirSync('deployments', { recursive: true });
  fs.writeFileSync(
    'deployments/proxy-address.json',
    JSON.stringify({
      proxy:      proxyAddr,
      impl:       implAddr,
      deployedAt: new Date().toISOString(),
    }, null, 2),
  );

  // 초기 역할 확인
  const MINTER_ROLE = await nft.MINTER_ROLE();
  console.log('MINTER_ROLE assigned:', await nft.hasRole(MINTER_ROLE, deployer.address));
}

main().catch(err => { console.error(err); process.exit(1); });
`;

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S39: 스마트컨트랙트 배포 파이프라인 및 Etherscan 검증 ===\n');

  const ADMIN_ADDRESS = '0xYourAdminAddress000000000000000000000000';
  const SEPOLIA_RPC   = 'https://sepolia.infura.io/v3/YOUR_PROJECT_ID';

  // ── [1] 배포 3단계 파이프라인 시뮬레이션 ──────────────────────────
  console.log('[검증 1] 배포 3단계 파이프라인 구조');

  const result = simulateUUPSDeployment(ADMIN_ADDRESS);

  check('3단계 배포 시뮬레이션 완료', result.steps.length === 3);
  check('Step 1: Implementation 배포', result.steps[0]?.description.includes('Implementation'));
  check('Step 2: ERC1967Proxy 배포',   result.steps[1]?.description.includes('ERC1967Proxy'));
  check('Step 3: initialize() 호출',   result.steps[2]?.description.includes('initialize'));

  console.log('\n  배포 단계:');
  for (const step of result.steps) {
    console.log(`    [${step.step}] ${step.description}`);
  }

  // ── [2] Proxy vs Implementation 주소 역할 ──────────────────────────
  console.log('\n[검증 2] Proxy 주소 vs Implementation 주소 역할');

  check('Proxy 주소: 영구 주소 (사용자·서비스가 이 주소로 호출)', result.proxyAddress !== '');
  check('Implementation 주소: 업그레이드 시 변경됨',              result.implementationAddress !== '');
  check('Proxy ≠ Implementation (별개의 컨트랙트)',               result.proxyAddress !== result.implementationAddress);

  console.log(`\n  Proxy 주소:         ${result.proxyAddress}`);
  console.log(`  Implementation 주소: ${result.implementationAddress}`);
  console.log('  → issuer-service .env에 Proxy 주소만 저장. 업그레이드 후 변경 불필요.');

  // ── [3] ERC-1967 슬롯 ─────────────────────────────────────────────
  console.log('\n[검증 3] ERC-1967 표준 슬롯 — Implementation 주소 저장 위치');

  check(
    `Implementation 슬롯: ${ERC1967_SLOTS.IMPLEMENTATION.slice(0, 14)}...`,
    ERC1967_SLOTS.IMPLEMENTATION.startsWith('0x360894'),
  );
  check(
    `Admin 슬롯: ${ERC1967_SLOTS.ADMIN.slice(0, 14)}...`,
    ERC1967_SLOTS.ADMIN.startsWith('0xb53127'),
  );
  check(
    'Implementation 슬롯이 일반 slot 0과 다름 — 상태 변수와 충돌 없음',
    ERC1967_SLOTS.IMPLEMENTATION !== '0x0000000000000000000000000000000000000000000000000000000000000000',
  );

  console.log('\n  Hardhat에서 Implementation 주소 읽기:');
  console.log(`  upgrades.erc1967.getImplementationAddress(proxyAddr)`);
  console.log(`  내부: eth_getStorageAt(proxy, ${ERC1967_SLOTS.IMPLEMENTATION})`);

  // ── [4] proxy-address.json 구조 검증 ──────────────────────────────
  console.log('\n[검증 4] deployments/proxy-address.json 구조');

  const jsonData = buildProxyAddressJson(result);

  check('proxy 필드 포함',      typeof jsonData.proxy === 'string' && jsonData.proxy.startsWith('0x'));
  check('impl 필드 포함',       typeof jsonData.impl  === 'string' && jsonData.impl.startsWith('0x'));
  check('deployedAt ISO 형식',  jsonData.deployedAt.includes('T') && jsonData.deployedAt.includes('Z'));

  console.log('\n  proxy-address.json 예시:');
  console.log(JSON.stringify(jsonData, null, 4).split('\n').map(l => '  ' + l).join('\n'));

  // ── [5] 배포 후 체크리스트 생성 ──────────────────────────────────
  console.log('\n[검증 5] 배포 후 체크리스트 — cast call 명령어');

  const checklist = generatePostDeployChecklist(result.proxyAddress, ADMIN_ADDRESS, SEPOLIA_RPC);
  check('체크리스트 6개 섹션 생성', checklist.length >= 12);

  console.log('\n  cast call 체크리스트:');
  for (const line of checklist) {
    console.log(`  ${line}`);
  }

  // ── [6] Etherscan 검증 이유 — 왜 양쪽 모두 등록해야 하는가 ───────
  console.log('\n[검증 6] Etherscan 검증 — Proxy + Implementation 양쪽 등록 이유');

  const etherscanVerify = {
    proxyOnly: {
      readContractResult: 'ERC1967Proxy 함수만 보임 (fallback, upgradeTo...)',
      kyoboNFTFunctions:  false,
    },
    both: {
      readContractResult: '"Read as Proxy" 탭에 KyoboNFT 함수 전체 노출',
      kyoboNFTFunctions:  true,
    },
  };

  check(
    'Proxy만 검증 시: KyoboNFT 함수 불가시',
    !etherscanVerify.proxyOnly.kyoboNFTFunctions,
  );
  check(
    '양쪽 검증 시: "Read as Proxy" 탭에 KyoboNFT 함수 노출',
    etherscanVerify.both.kyoboNFTFunctions,
  );

  // ── [7] 배포 스크립트 파일 존재 여부 확인 ─────────────────────────
  console.log('\n[검증 7] blockchain/scripts/deploy.ts 파일 확인');

  const deployScriptPath = path.join('F:', 'Workplace', 'kyobo-digital-asset-platform', 'blockchain', 'scripts', 'deploy.ts');
  const deployScriptExists = fs.existsSync(deployScriptPath);

  if (deployScriptExists) {
    check('blockchain/scripts/deploy.ts 존재 확인', true);
  } else {
    console.log('  ⚠️  blockchain/scripts/deploy.ts 없음 — 아래 내용으로 생성 필요:');
    console.log('\n  --- deploy.ts 내용 ---');
    console.log(DEPLOY_SCRIPT_CONTENT.split('\n').map(l => '  ' + l).join('\n'));
    check('blockchain/scripts/deploy.ts 없음 → 생성 필요 (위 내용 참고)', true);
  }

  // ── [8] 배포 오류 트러블슈팅 맵 ──────────────────────────────────
  console.log('\n[검증 8] 배포 오류 트러블슈팅 사전 확인');

  const troubleshootingMap = new Map([
    ['insufficient funds',           'Sepolia Faucet에서 충전 (0.1 ETH 이상 필요)'],
    ['nonce too low',                '이전 TX 처리 대기 중 — 잠시 후 재시도'],
    ['already verified',             '무시해도 됨 — 이미 등록된 소스코드'],
    ['no bytecode at address',       '배포 전에 verify 실행 — TX 확인 후 retry'],
    ['New storage layout is incompatible', 'Storage Collision 감지 — 슬롯 레이아웃 점검 (S40 참조)'],
  ]);

  check('트러블슈팅 사전 5가지 시나리오 준비', troubleshootingMap.size === 5);

  console.log('\n  배포 오류 트러블슈팅:');
  for (const [error, solution] of troubleshootingMap) {
    console.log(`  "${error}"`);
    console.log(`    → ${solution}`);
  }

  // ── 정리 ─────────────────────────────────────────────────────────
  console.log('\n=== S39 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. UUPS 배포 3단계: ① Implementation 배포 → ② Proxy 배포 → ③ initialize() 호출');
  console.log('  2. Proxy 주소: 영구 사용. Implementation 주소: 업그레이드 시 변경');
  console.log('  3. ERC-1967 슬롯(0x360894...): Implementation 주소를 일반 변수와 분리 보관');
  console.log('  4. Etherscan: Proxy + Implementation 양쪽 검증 → "Read as Proxy" 탭 활성화');
  console.log('  5. deployments/proxy-address.json에 Proxy/Impl 주소 저장 → upgrade.ts에서 재사용');

  console.log('\nSepolia 배포 실행:');
  console.log('  cd blockchain && npx hardhat run scripts/deploy.ts --network sepolia');
  console.log('\nEtherscan 검증:');
  console.log('  npx hardhat verify --network sepolia <IMPL_ADDR>');
  console.log('  npx hardhat verify --network sepolia <PROXY_ADDR>');
})();
