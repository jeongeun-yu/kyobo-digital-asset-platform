/**
 * S07 답안 — Redis Streams 전체 흐름
 * 강의 노트: M2_S7_redis_streams_theory.md
 */

import { RedisStreamPublisher, type StreamEvent } from '../dmz/RedisStreamPublisher';
import { ConsumerGroupWorker, type EventProcessor, type StreamMessage } from '../dmz/ConsumerGroupWorker';
import { DLQHandler } from '../dmz/DLQHandler';

// ── Mock Redis (Publisher용) ───────────────────────────────────────────────
const publisherRedis = {
  async xadd(key: string, fields: Record<string, string>): Promise<string> {
    const messageId = `${Date.now()}-0`;
    console.log(`[XADD] ${key}`, fields);
    console.log(`[XADD] → messageId: ${messageId}`);
    return messageId;
  },
  async xgroupCreate(key: string, group: string, id: string, mkstream: boolean): Promise<void> {
    console.log(`[XGROUP CREATE] ${key} ${group} ${id}${mkstream ? ' MKSTREAM' : ''}`);
  },
  async ping(): Promise<string> {
    return 'PONG';
  },
};

// ── Mock DLQ ──────────────────────────────────────────────────────────────
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

// ── Mock Redis (Consumer용) ───────────────────────────────────────────────
let consumerCallCount = 0;
const consumerRedis = {
  async xreadgroup(
    group: string, consumer: string,
    streams: Array<{ key: string; id: string }>,
    count: number, blockMs: number,
  ) {
    consumerCallCount++;
    if (consumerCallCount === 1) {
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
  consumerRedis,
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
  console.log('=== Part 1: RedisStreamPublisher ===\n');

  // TODO 3 답안
  const publisher = new RedisStreamPublisher(publisherRedis);

  // TODO 4 답안
  await publisher.initialize();
  await publisher.initialize(); // 두 번째 호출 → BUSYGROUP 무시 확인

  // TODO 5 답안
  const event: StreamEvent = {
    streamKey:   'kyobo:events',
    eventType:   'NFT_ISSUED',
    payload:     { tokenId: '42', owner: '0xKYOBO' },
    txHash:      '0xdeadbeef001',
    blockNumber: 18500001,
    requestId:   'req-001',
  };

  const messageId = await publisher.publish(event);
  console.log('[result] messageId:', messageId);
  console.log('[check] 형식 확인:', /^\d+-\d+$/.test(messageId) ? '✅ 정상' : '❌ 오류');

  const burned: StreamEvent = {
    streamKey:   'kyobo:events',
    eventType:   'NFT_BURNED',
    payload:     { tokenId: '41', owner: '0x0000' },
    txHash:      '0xcafebabe001',
    blockNumber: 18500002,
    requestId:   'req-002',
  };
  const burnedId = await publisher.publish(burned);
  console.log('[result] NFT_BURNED messageId:', burnedId);

  console.log('\n=== Part 2: ConsumerGroupWorker ===\n');
  console.log('[worker] 시작 — 3초 후 자동 종료');

  setTimeout(() => {
    console.log('[worker] stop() 호출');
    worker.stop();
  }, 3000);

  await worker.start();
  console.log('[worker] 종료 완료');
})();
