// S5 실습 Step 5 — Missed Event 복구 확인
// 실행: npx ts-node scripts/recover-events.ts

import { EVMAdapter } from '@kyobo/chain-adapters';
import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const NFT_ABI = [
  'event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason)',
];

async function main() {
  const adapter = new EVMAdapter({
    rpcUrl:  process.env.EVM_RPC_URL ?? 'http://localhost:8545',
    chainId: process.env.CHAIN_ID    ?? '31337',
  });

  // 리스너를 껐던 블록 번호 — 이전 실습에서 확인한 값으로 교체
  const lastProcessedBlock = parseInt(process.env.LAST_PROCESSED_BLOCK ?? '4', 10);
  const currentBlock       = await adapter.getBlockNumber();

  console.log(`스캔 범위: 블록 ${lastProcessedBlock} ~ ${currentBlock}`);
  console.log(`총 ${currentBlock - lastProcessedBlock}블록 스캔 중...\n`);

  const missed = await adapter.queryEvents(
    process.env.KYOBO_NFT_PROXY_ADDR!,
    NFT_ABI,
    'Issued',
    lastProcessedBlock,
    currentBlock,
  );

  if (missed.length === 0) {
    console.log('놓친 이벤트 없음.');
    return;
  }

  console.log(`놓친 이벤트 ${missed.length}개 발견:`);
  missed.forEach((event, i) => {
    console.log(`\n[${i + 1}] 복구된 이벤트`);
    console.log('  txHash:     ', event.txHash);
    console.log('  blockNumber:', event.blockNumber);
    console.log('  to:         ', event.args['to']);
    console.log('  tokenId:    ', event.args['tokenId']);
    console.log('  reason:     ', event.args['reason']);
  });
}

main().catch(console.error);
