/**
 * S06 답안 — ConsumerGroupWorker 구조 이해 + EventProcessor 구현
 * 강의 노트: M2_S6_redis_streams_theory.md
 */

import { ConsumerGroupWorker, type EventProcessor, type StreamMessage } from '../dmz/ConsumerGroupWorker';
import { DLQHandler } from '../dmz/DLQHandler';

const mockDLQ = new DLQHandler(
  {
    async xadd(key, fields) {
      console.log(`[DLQ XADD] ${key}`, fields);
      return `${Date.now()}-0`;
    },
    async xrange() { return []; },
    async xdel()   { return 0; },
  },
  { async sendAlert(msg) { console.log('[DLQ ALERT]', msg); } },
);

let callCount = 0;
const mockRedis = {
  async xreadgroup(
    group: string, consumer: string,
    streams: Array<{ key: string; id: string }>,
    count: number, blockMs: number,
  ) {
    callCount++;
    if (callCount === 1) {
      console.log(`[XREADGROUP] ${consumer} → 새 메시지 수신`);
      return [{
        key: 'kyobo:events',
        messages: [{
          id:     `${Date.now()}-0`,
          fields: {
            eventType:   'NFT_ISSUED',
            payload:     JSON.stringify({ tokenId: '42', owner: '0xKYOBO' }),
            txHash:      '0xdeadbeef001',
            blockNumber: '18500001',
            requestId:   'req-001',
            publishedAt: String(Date.now()),
            _retryCount: '0',
          },
        }],
      }];
    }
    await new Promise(r => setTimeout(r, 500));
    return [];
  },
  async xack(key: string, group: string, ...ids: string[]) {
    console.log(`[XACK] ${ids.join(', ')} → PEL 제거 ✅`);
    return ids.length;
  },
  async xautoclaim(
    key: string, group: string, consumer: string,
    minIdleMs: number, startId: string, count: number,
  ) {
    return { nextId: '0-0', messages: [] };
  },
};

// TODO 1 답안
const nftIssuedProcessor: EventProcessor = {
  eventTypes: ['NFT_ISSUED'],

  async process(msg: StreamMessage): Promise<void> {
    const payload   = JSON.parse(msg.fields['payload'] ?? '{}');
    const requestId = msg.fields['requestId'];
    console.log(`[processor] NFT_ISSUED — tokenId: ${payload.tokenId}, owner: ${payload.owner}`);
    console.log(`[processor] requestId: ${requestId}`);
    console.log('[processor] NFT_ISSUED 처리 완료');
  },
};

// TODO 2 답안
const worker = new ConsumerGroupWorker(
  mockRedis,
  [nftIssuedProcessor],
  mockDLQ,
  {
    streamKey:  'kyobo:events',
    groupName:  'issuer-consumers',
    consumerId: 'consumer-1',
    batchSize:  10,
    blockMs:    500,
    minIdleMs:  30_000,
  },
);

(async () => {
  console.log('[worker] 시작 — 3초 후 자동 종료');

  setTimeout(() => {
    console.log('[worker] stop() 호출');
    worker.stop();
  }, 3000);

  await worker.start();
  console.log('[worker] 종료 완료');
})();
