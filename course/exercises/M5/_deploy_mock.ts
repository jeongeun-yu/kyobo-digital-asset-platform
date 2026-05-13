/**
 * MockERC1155 Sepolia 배포 — hardhat 없이 ethers.js 직접 배포
 * 실행: npx ts-node src/exercises/_deploy_mock.ts
 */
import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';
import { evmConfig } from '@kyobo/shared';
import * as fs from 'fs';
import * as path from 'path';

const ARTIFACTS = path.resolve(__dirname, '..', '..', '..', '..', '..', 'blockchain', 'artifacts', 'mock');
const ABI_PATH  = path.join(ARTIFACTS, 'src_mocks_MockERC1155_sol_MockERC1155.abi');
const BIN_PATH  = path.join(ARTIFACTS, 'src_mocks_MockERC1155_sol_MockERC1155.bin');

(async () => {
  const { rpcUrl, signerKey } = evmConfig;
  if (!signerKey) { console.error('EVM_SIGNER_KEY 없음'); process.exit(1); }

  const abi      = JSON.parse(fs.readFileSync(ABI_PATH, 'utf-8'));
  const bytecode = '0x' + fs.readFileSync(BIN_PATH, 'utf-8').trim();

  const provider = new JsonRpcProvider(rpcUrl);
  const wallet   = new Wallet(signerKey, provider);

  console.log('배포 계정:', wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log('잔액:', balance / 10n ** 18n, 'ETH');

  console.log('\nMockERC1155 배포 중...');
  const factory  = new ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  console.log('\n── 배포 완료 ──────────────────────────────');
  console.log('MOCK_CONTRACT_ADDR=' + addr);
  console.log('\ninternal/.env에 아래 줄 추가:');
  console.log('MOCK_CONTRACT_ADDR=' + addr);

  process.exit(0);
})();
