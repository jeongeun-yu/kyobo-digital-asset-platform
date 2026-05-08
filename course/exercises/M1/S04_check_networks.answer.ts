/**
 * S04 답안 — 3가지 네트워크 직접 연결
 *
 * 실행 방법 (kyobo-digital-asset-platform/ 루트에서):
 *   npm run exercise:s04
 */

import { JsonRpcProvider, Wallet, formatEther } from 'ethers';
import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const SIGNER_KEY     = process.env['EVM_SIGNER_KEY'] ?? '';
const MY_ADDRESS     = SIGNER_KEY ? new Wallet(SIGNER_KEY).address : '';
const HARDHAT_ACCT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SEPOLIA_RPC    = process.env['SEPOLIA_RPC_URL']
  ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const MAINNET_RPC    = 'https://ethereum-rpc.publicnode.com';

function check(label: string, value: unknown): void {
  console.log(`  ✓ ${label}: ${value}`);
}

async function queryNetwork(name: string, rpcUrl: string): Promise<void> {
  console.log(`\n${'─'.repeat(52)}`);
  console.log(` ${name}`);
  console.log('─'.repeat(52));

  // [1] JsonRpcProvider 생성
  const provider = new JsonRpcProvider(rpcUrl);

  // [2] 체인 ID
  const network = await provider.getNetwork();
  check('체인 ID', network.chainId.toString());

  // [3] 블록 번호
  const blockNumber = await provider.getBlockNumber();
  check('블록 번호', blockNumber.toLocaleString());

  // [4] 내 계정 잔액 (EVM_SIGNER_KEY 파생 주소)
  if (MY_ADDRESS) {
    const myBalance = await provider.getBalance(MY_ADDRESS);
    check(`내 계정 잔액 (${MY_ADDRESS})`, formatEther(myBalance) + ' ETH');
  }

  // [5] Hardhat 기본 계정 잔액 — 로컬 노드 동작 확인용
  const acctBalance = await provider.getBalance(HARDHAT_ACCT_0);
  check(`Hardhat 계정 잔액 (${HARDHAT_ACCT_0})`, formatEther(acctBalance) + ' ETH');

  // [6] 가스 가격 (Gwei)
  const feeData = await provider.getFeeData();
  const gasPriceGwei = feeData.maxFeePerGas != null
    ? feeData.maxFeePerGas / 1_000_000_000n
    : 0n;
  check('가스 가격', gasPriceGwei.toString() + ' Gwei');
}

async function main(): Promise<void> {
  console.log('S04 — 3가지 네트워크 직접 연결');
  if (MY_ADDRESS) console.log(`내 계정: ${MY_ADDRESS}`);
  else console.log('⚠ EVM_SIGNER_KEY 없음 — .env 확인 (내 계정 잔액 조회 스킵)');

  try {
    await queryNetwork('[환경 1] 로컬 노드 (빈 체인)', 'http://127.0.0.1:8545');
  } catch {
    console.log('\n  [스킵] 로컬 노드 연결 실패 — blockchain/ 에서 npx hardhat node 먼저 실행');
  }

  try {
    await queryNetwork('[환경 2] Sepolia 테스트넷', SEPOLIA_RPC);
  } catch {
    console.log('\n  [스킵] Sepolia 연결 실패 — 인터넷 연결 확인');
  }

  // [환경 3] 메인넷 직접 조회 — Mainnet Fork가 복사한 원본 상태
  //   블록 번호가 환경 1(로컬=0)과 다르고 환경 2(Sepolia)와도 다름
  //   → Hardhat Fork는 이 메인넷 최신 블록 상태를 localhost:8545로 복제한 것
  try {
    await queryNetwork('[환경 3] 이더리움 메인넷 (Fork 원본)', MAINNET_RPC);
  } catch {
    console.log('\n  [스킵] 메인넷 연결 실패 — 인터넷 연결 확인');
  }

  console.log('\n실습 완료. 환경별 블록 번호와 잔액을 비교해보세요.');
}

main().catch(console.error);
