// S5 실습 Step 3 — 이벤트 리스너 직접 작성
// 실행: npx ts-node scripts/listen-events.ts

import { EVMAdapter } from '@kyobo/chain-adapters';
import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const NFT_ABI = [
  'event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason)',
];

async function main() {
  const adapter = new EVMAdapter({
    rpcUrl:  process.env.EVM_RPC_URL  ?? 'http://localhost:8545',
    chainId: process.env.CHAIN_ID     ?? '31337',
  });

  const connected = await adapter.isConnected();
  if (!connected) {
    console.error('노드에 연결할 수 없습니다. docker compose 확인.');
    process.exit(1);
  }

  const currentBlock = await adapter.getBlockNumber();
  console.log(`현재 블록: ${currentBlock}`);
  console.log(`컨트랙트: ${process.env.KYOBO_NFT_PROXY_ADDR}`);
  console.log('이벤트 리스닝 시작... (Ctrl+C로 종료)\n');

  const unsubscribe = await adapter.subscribeEvents(
    process.env.KYOBO_NFT_PROXY_ADDR!,
    NFT_ABI,
    ['Issued'],
    currentBlock,
    async (event) => {
      console.log('━'.repeat(50));
      console.log('[이벤트 수신!]', new Date().toISOString());
      console.log('  이벤트:      ', event.eventName);
      console.log('  txHash:      ', event.txHash);
      console.log('  blockNumber: ', event.blockNumber);
      console.log('  logIndex:    ', event.logIndex);
      console.log('  수신자(to):  ', event.args['to']);
      console.log('  tokenId:     ', event.args['tokenId']);
      console.log('  reason:      ', event.args['reason']);
      console.log('━'.repeat(50) + '\n');
    },
  );

  process.on('SIGINT', () => {
    console.log('\n리스너 종료 중...');
    unsubscribe();
    process.exit(0);
  });
}

main().catch(console.error);
