/**
 * S04 실습 — 3가지 네트워크 직접 연결
 *
 * 실행 방법 (kyobo-digital-asset-platform/ 루트에서):
 *   npm run exercise:s04
 *
 * 전제 조건:
 *   - [환경 1] blockchain/ 폴더에서 `npx hardhat node` 기동 중
 *   - [환경 2] 인터넷 연결 (Sepolia 공개 RPC — 가입 불필요)
 *   - [환경 3] .env에 MAINNET_RPC_URL 추가 후 npx hardhat node 재기동
 *
 * 목표:
 *   [1] 로컬 노드  — 블록 번호 0, Hardhat 기본 계정 잔액 10000 ETH
 *   [2] Sepolia    — 실제 블록 번호 수백만대, 내 지갑 잔액 조회
 *   [3] Mainnet Fork — 블록 번호 수천만대 (같은 localhost:8545, 다른 결과)
 */

import { JsonRpcProvider, Wallet, formatEther } from 'ethers';
import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// 내 계정 주소 — EVM_SIGNER_KEY에서 파생 (Sepolia·Mainnet Fork 잔액 조회용)
const SIGNER_KEY  = process.env['EVM_SIGNER_KEY'] ?? '';
const MY_ADDRESS  = SIGNER_KEY ? new Wallet(SIGNER_KEY).address : '';

// Hardhat 기본 계정 0번 — 로컬 노드에서 10,000 ETH 기본 지급 확인용
const HARDHAT_ACCT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const SEPOLIA_RPC  = process.env['SEPOLIA_RPC_URL']
  ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const MAINNET_RPC  = 'https://ethereum-rpc.publicnode.com';

function check(label: string, value: unknown): void {
  console.log(`  ✓ ${label}: ${value}`);
}

async function queryNetwork(name: string, rpcUrl: string): Promise<void> {
  console.log(`\n${'─'.repeat(52)}`);
  console.log(` ${name}`);
  console.log('─'.repeat(52));

  // TODO: JsonRpcProvider 생성
  //   힌트: new JsonRpcProvider(rpcUrl)
  const provider = /* TODO */ null as unknown as JsonRpcProvider;

  // TODO: [1] 체인 ID 조회
  //   힌트: provider.getNetwork() → network.chainId
  //   예상: 로컬=31337, Sepolia=11155111, 메인넷=1

  // TODO: [2] 현재 블록 번호 조회
  //   힌트: provider.getBlockNumber()
  //   예상: 로컬=0, Sepolia=수백만, 메인넷=수천만

  // TODO: [3] 내 계정(MY_ADDRESS) 잔액 조회 — EVM_SIGNER_KEY에서 파생된 주소
  //   힌트: provider.getBalance(MY_ADDRESS) → formatEther(잔액) + ' ETH'
  //   예상: 로컬=10000.0 ETH (Hardhat 기본 지급), Sepolia=실제 잔액
  if (MY_ADDRESS) {
    // TODO: check('내 계정 잔액', ...)
  }

  // TODO: [4] Hardhat 기본 계정(HARDHAT_ACCT_0) 잔액 조회 — 로컬 노드 동작 확인용
  //   힌트: provider.getBalance(HARDHAT_ACCT_0) → formatEther(잔액) + ' ETH'
  //   예상: 로컬/Fork=10000.0 ETH, Sepolia=0.0 ETH (의미 없는 주소)

  // TODO: [5] 가스 가격 조회 (Gwei 단위)
  //   힌트: provider.getFeeData() → feeData.maxFeePerGas (BigInt, wei 단위)
  //         Gwei 변환: maxFeePerGas / 1_000_000_000n
  //   예상: 로컬=1 Gwei, Sepolia=실제 시장 가격, Fork=최신 메인넷 가격
}

async function main(): Promise<void> {
  console.log('S04 — 3가지 네트워크 직접 연결');
  if (MY_ADDRESS) console.log(`내 계정: ${MY_ADDRESS}`);
  else console.log('⚠ EVM_SIGNER_KEY 없음 — .env 확인 (내 계정 잔액 조회 스킵)');

  // [환경 1] 로컬 노드 — npx hardhat node 실행 후 진행
  try {
    await queryNetwork('[환경 1] 로컬 노드 (빈 체인)', 'http://127.0.0.1:8545');
  } catch {
    console.log('\n  [스킵] 로컬 노드 연결 실패 — blockchain/ 에서 npx hardhat node 먼저 실행');
  }

  // [환경 2] Sepolia 테스트넷
  try {
    await queryNetwork('[환경 2] Sepolia 테스트넷', SEPOLIA_RPC);
  } catch {
    console.log('\n  [스킵] Sepolia 연결 실패 — 인터넷 연결 확인');
  }

  // [환경 3] 이더리움 메인넷 (Fork 원본) — Hardhat Fork가 복사한 상태
  try {
    await queryNetwork('[환경 3] 이더리움 메인넷 (Fork 원본)', MAINNET_RPC);
  } catch {
    console.log('\n  [스킵] 메인넷 연결 실패 — 인터넷 연결 확인');
  }

  console.log('\n실습 완료. 환경별 블록 번호와 잔액을 비교해보세요.');
}

main().catch(console.error);
