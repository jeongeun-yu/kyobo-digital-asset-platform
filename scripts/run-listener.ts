// S6 실습 Step 2 — ChainEventListener 직접 구동
// 실행: npx ts-node scripts/run-listener.ts

import { EVMAdapter }         from '../dmz/packages/chain-adapters/src/evm/EVMAdapter';
import { ChainEventListener } from '../dmz/packages/event-engine/src/listener/ChainEventListener';
import { NFTIssuedHandler }   from '../dmz/packages/event-engine/src/handlers/NFTIssuedHandler';
import {
  IdempotencyGuard,
  InMemoryIdempotencyStore,
} from '../dmz/packages/event-engine/src/webhook/IdempotencyGuard';
import {
  RetryHandler,
  DeadLetterQueue,
} from '../dmz/packages/event-engine/src/webhook/RetryHandler';
import { InMemoryStateStore } from './in-memory-state-store';
import * as dotenv from 'dotenv';
dotenv.config();

const NFT_ABI = [
  'event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason)',
];

async function main() {
  const adapter = new EVMAdapter({
    rpcUrl:  process.env.EVM_RPC_URL  ?? 'http://localhost:8545',
    chainId: process.env.CHAIN_ID     ?? '31337',
  });

  // Step 3 시나리오: 숫자를 바꿔서 "그 블록에서 다운됐다"를 시뮬레이션
  // 예) InMemoryStateStore(4) → 블록 4 이후 이벤트를 복구
  const stateStore = new InMemoryStateStore(0);

  const idempotencyGuard = new IdempotencyGuard(
    new InMemoryIdempotencyStore(),
    3600, // 1시간 TTL (실습용)
  );

  const retryHandler = new RetryHandler(
    {
      maxAttempts:    3,
      initialDelayMs: 500,
      maxDelayMs:     5000,
      backoffFactor:  2,
    },
    new DeadLetterQueue(),
  );

  const nftHandler = new NFTIssuedHandler(
    process.env.KYOBO_NFT_PROXY_ADDR!,
    idempotencyGuard,
    retryHandler,
    {
      coreBankingWebhookUrl: process.env.CORE_BANKING_WEBHOOK_URL ?? 'http://localhost:9999/webhook',
      webhookSecret:          process.env.WEBHOOK_SECRET           ?? 'test-secret',
    },
  );

  const listener = new ChainEventListener(
    adapter,
    [nftHandler],
    [
      {
        addr:       process.env.KYOBO_NFT_PROXY_ADDR!,
        abi:        NFT_ABI,
        eventNames: ['Issued'],
      },
    ],
    stateStore,
  );

  console.log('ChainEventListener 시작...');
  console.log('컨트랙트:', process.env.KYOBO_NFT_PROXY_ADDR);

  await listener.start();
  console.log('리스닝 중... (Ctrl+C로 종료)\n');

  process.on('SIGINT', async () => {
    console.log('\n종료 중...');
    await listener.stop();
    process.exit(0);
  });
}

main().catch(console.error);
