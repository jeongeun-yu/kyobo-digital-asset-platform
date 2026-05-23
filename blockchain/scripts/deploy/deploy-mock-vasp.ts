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

async function main() {
  const [deployer] = await ethers.getSigners();
  const isLocal    = network.name === 'localhost' || network.name === 'hardhat';

  // operator: 로컬은 두 번째 계정, Sepolia는 deployer 또는 env 지정 주소
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

  const Factory  = await ethers.getContractFactory('MockVASP');
  const contract = await Factory.deploy(operatorAddr);
  await contract.waitForDeployment();

  const addr = await contract.getAddress();

  console.log('MockVASP deployed:', addr);
  console.log('');
  console.log('─── env (AnvilVASPAdapter / SepoliaVASPAdapter) ───');
  console.log(`MOCK_VASP_ADDR=${addr}`);

  if (isLocal) {
    const signers = await ethers.getSigners();
    const opKey   = (signers[1] as any).privateKey ?? '(hardhat account[1] — check hardhat node output)';
    console.log(`ANVIL_RPC_URL=http://127.0.0.1:8545`);
    console.log(`ANVIL_OPERATOR_KEY=${opKey}`);
  } else {
    console.log(`SEPOLIA_RPC_URL=${process.env.SEPOLIA_RPC_URL ?? '<your rpc url>'}`);
    console.log(`OPERATOR_PRIVATE_KEY=<your key>`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
