/**
 * deploy-mock-vasp.ts — MockVASP 배포 스크립트 (Anvil 로컬 / Sepolia 공용)
 *
 * Anvil 로컬:
 *   npx hardhat node
 *   npx hardhat run scripts/deploy/deploy-mock-vasp.ts --network localhost
 *
 * Sepolia:
 *   SEPOLIA_RPC_URL=...  PRIVATE_KEY=...  [OPERATOR_ADDR=0x...]
 *   npx hardhat run scripts/deploy/deploy-mock-vasp.ts --network sepolia
 *
 * OPERATOR_ADDR 미지정 시: deployer 가 OPERATOR_ROLE 겸임
 *
 * 출력 예:
 *   MockVASP deployed: 0xABC...
 *   MOCK_VASP_ADDR=0xABC...
 *   OPERATOR_PRIVATE_KEY=0x...  (localhost only)
 */

import { ethers, network } from 'hardhat';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const ENV_FILE = resolve(__dirname, '../../../.env');

function readEnv(): string {
  try { return readFileSync(ENV_FILE, 'utf-8'); } catch { return ''; }
}

function getEnvVar(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

function setEnvVar(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, 'm').test(content)) {
    return content.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  }
  return content.trimEnd() + '\n' + line + '\n';
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const isLocal    = network.name === 'localhost' || network.name === 'hardhat';

  let operatorAddr: string;
  if (isLocal) {
    const signers = await ethers.getSigners();
    operatorAddr  = signers[1]?.address ?? deployer.address;
  } else {
    operatorAddr = process.env.OPERATOR_ADDR ?? deployer.address;
  }

  console.log(`Network  : ${network.name}`);
  console.log(`Deployer : ${deployer.address}`);
  console.log(`Operator : ${operatorAddr}`);
  console.log('');

  // .env의 SEPOLIA_MOCK_VASP_ADDR이 채워져 있으면 재사용
  const envContent = readEnv();
  const existing   = getEnvVar(envContent, 'SEPOLIA_MOCK_VASP_ADDR');
  if (!isLocal && existing) {
    const code = await ethers.provider.getCode(existing);
    if (code !== '0x') {
      console.log(`MockVASP 재사용: ${existing}`);
      printEnv(existing, isLocal);
      return;
    }
    console.log('기존 주소에 컨트랙트 없음 — 재배포합니다.');
  }

  const Factory  = await ethers.getContractFactory('MockVASP');
  const contract = await Factory.deploy(operatorAddr);
  await contract.waitForDeployment();

  const addr = await contract.getAddress();

  // .env에 SEPOLIA_MOCK_VASP_ADDR 기록
  if (!isLocal) {
    writeFileSync(ENV_FILE, setEnvVar(envContent, 'SEPOLIA_MOCK_VASP_ADDR', addr));
    console.log(`.env SEPOLIA_MOCK_VASP_ADDR 업데이트 완료`);
  }

  console.log(`MockVASP deployed: ${addr}`);
  console.log('');
  printEnv(addr, isLocal);
}

function printEnv(addr: string, isLocal: boolean) {
  console.log('─── env ───');
  if (isLocal) {
    console.log(`MOCK_VASP_ADDR=${addr}`);
    console.log(`ANVIL_RPC_URL=http://127.0.0.1:8545`);
  } else {
    console.log(`SEPOLIA_MOCK_VASP_ADDR=${addr}`);
    console.log(`SEPOLIA_RPC_URL=${process.env.SEPOLIA_RPC_URL ?? '<your rpc url>'}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
