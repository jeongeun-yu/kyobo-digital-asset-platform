/**
 * MockERC1155 Sepolia 배포 스크립트 — 강의 실습 전용
 *
 * 실행 방법:
 *   cd blockchain
 *   yarn hardhat run scripts/deploy/deploy-mock-sepolia.ts --network sepolia
 *
 * 사전 준비:
 *   .env에 아래 두 항목 설정
 *     SEPOLIA_RPC_URL=https://rpc.sepolia.org        (또는 다른 공개 RPC)
 *     DEPLOYER_PRIVATE_KEY=0x...                     (Sepolia 테스트넷 전용 계정)
 *
 *   Sepolia ETH 필요 (faucet: https://sepoliafaucet.com)
 *
 * 배포 후:
 *   출력된 MOCK_CONTRACT_ADDR 값을 .env에 추가
 *   → S15_evm_lab.ts에서 mintNFT / queryEvents 실습 활성화
 *
 * 주의:
 *   이 컨트랙트는 접근 제어가 없다 (누구나 mint 가능).
 *   Sepolia 테스트넷 전용 — 메인넷 배포 절대 금지.
 */

import { ethers, run } from 'hardhat';

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) throw new Error('No signer — DEPLOYER_PRIVATE_KEY 환경변수 확인');

  console.log('배포 계정:', deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('잔액:', ethers.formatEther(balance), 'ETH');

  if (balance === 0n) {
    throw new Error(
      'Sepolia ETH 잔액 없음\n→ https://sepoliafaucet.com 에서 테스트넷 ETH 수령 후 재시도',
    );
  }

  console.log('\nMockERC1155 배포 중...');
  const MockERC1155 = await ethers.getContractFactory('MockERC1155');
  const mock = await MockERC1155.deploy();
  await mock.waitForDeployment();

  const addr = await mock.getAddress();
  console.log('\n── 배포 완료 ─────────────────────────────────');
  console.log(`MOCK_CONTRACT_ADDR=${addr}`);

  console.log('\nEtherscan verify 중... (10초 대기)');
  await new Promise(r => setTimeout(r, 10000));
  try {
    await run('verify:verify', {
      address: addr,
      constructorArguments: [],
    });
    console.log('✓ Etherscan verify 완료');
    console.log(`  https://sepolia.etherscan.io/address/${addr}#code`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Already Verified')) {
      console.log('✓ 이미 verify된 컨트랙트');
    } else {
      console.warn('⚠ verify 실패 (수동으로 재시도 가능):', msg);
    }
  }

  console.log('\n.env에 위 주소 추가 후 S15 실습 실행:');
  console.log('  EVM_RPC_URL=https://rpc.sepolia.org');
  console.log('  EVM_CHAIN_ID=11155111');
  console.log(`  MOCK_CONTRACT_ADDR=${addr}`);
  console.log('  EVM_SIGNER_KEY=<DEPLOYER_PRIVATE_KEY와 동일>');
  console.log('\nnpx ts-node src/exercises/S15_evm_lab.ts');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
