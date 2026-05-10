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
 * 이 파일은 배포 파이프라인 전체 흐름을 TypeScript로 검증한다.
 * 실제 배포(Sepolia TX)는 blockchain/scripts/deploy.ts를 실행한다.
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

/**
 * TODO [실습 1]: simulateUUPSDeployment를 완성하라
 *
 * UUPS 배포 3단계를 시뮬레이션한다.
 *
 * 반환값 구조:
 *   - proxyAddress: '0xabcDEF1234567890abcdef1234567890AbCDeF12'
 *   - implementationAddress: '0x1234567890123456789012345678901234567890'
 *   - deployedAt: new Date().toISOString()
 *   - adminAddress: (인자 그대로)
 *   - steps: 3개의 step 배열
 *     step 1: 'Implementation 컨트랙트 배포 — KyoboNFT 바이트코드 → Sepolia' 포함
 *     step 2: 'ERC1967Proxy 배포' 포함
 *     step 3: 'initialize(...) 호출 via delegatecall → Proxy storage에 역할 등록' 포함
 *
 * 힌트: 각 step의 description에 위 키워드가 포함되어야 테스트가 통과한다.
 */
export function simulateUUPSDeployment(adminAddress: string): DeploymentResult {
  return undefined as never;
}

// ────────────────────────────────────────────────────────────────────────
// [3] ERC-1967 슬롯 주소 계산
//
// Solidity 계산:
//   bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
//
// 아래 상수는 완성 코드입니다 — 암기 불필요, 참조용
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

/**
 * TODO [실습 2]: buildProxyAddressJson을 완성하라
 *
 * DeploymentResult에서 proxy-address.json 형태의 객체를 만든다.
 *
 * 반환값:
 *   {
 *     proxy:      result.proxyAddress,
 *     impl:       result.implementationAddress,
 *     deployedAt: result.deployedAt,
 *   }
 */
export function buildProxyAddressJson(result: DeploymentResult): ProxyAddressJson {
  return undefined as never;
}

// ────────────────────────────────────────────────────────────────────────
// [5] 배포 후 체크리스트 — cast call 명령어 생성
// ────────────────────────────────────────────────────────────────────────

/**
 * TODO [실습 3]: generatePostDeployChecklist를 완성하라
 *
 * 배포 후 실행할 검증 명령어 목록을 생성한다.
 * 반환 배열은 12개 이상의 문자열을 포함해야 한다.
 *
 * 포함 항목 (순서 무관):
 *   1. hasRole cast call 명령어 (MINTER_ROLE_HASH = '0x9f2df0...' 포함)
 *   2. encodeTokenId cast call 명령어
 *   3. cast storage 명령어 (ERC1967_SLOTS.IMPLEMENTATION 포함)
 *   4. npx hardhat verify (impl) 명령어
 *   5. npx hardhat verify (proxy) 명령어
 *   6. Etherscan Read as Proxy 탭 URL
 *
 * 힌트: 빈 문자열('')로 섹션 구분하면 줄 수를 맞추기 쉽다.
 */
export function generatePostDeployChecklist(proxyAddress: string, adminAddress: string, rpcUrl: string): string[] {
  return undefined as never;
}

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

  // ── [6] Etherscan 검증 이유 ────────────────────────────────────────
  console.log('\n[검증 6] Etherscan 검증 — Proxy + Implementation 양쪽 등록 이유');

  const etherscanVerify = {
    proxyOnly: { kyoboNFTFunctions: false },
    both:      { kyoboNFTFunctions: true  },
  };

  check('Proxy만 검증 시: KyoboNFT 함수 불가시', !etherscanVerify.proxyOnly.kyoboNFTFunctions);
  check('양쪽 검증 시: "Read as Proxy" 탭에 KyoboNFT 함수 노출', etherscanVerify.both.kyoboNFTFunctions);

  // ── [7] 배포 스크립트 파일 존재 여부 확인 ─────────────────────────
  console.log('\n[검증 7] blockchain/scripts/deploy.ts 파일 확인');

  const deployScriptPath = path.join('F:', 'Workplace', 'kyobo-digital-asset-platform', 'blockchain', 'scripts', 'deploy.ts');
  const deployScriptExists = fs.existsSync(deployScriptPath);

  if (deployScriptExists) {
    check('blockchain/scripts/deploy.ts 존재 확인', true);
  } else {
    check('blockchain/scripts/deploy.ts 없음 → 생성 필요 (answer.ts 참고)', true);
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
