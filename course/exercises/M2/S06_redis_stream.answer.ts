/**
 * S06 실습 — Redis Streams 전체 흐름 (답안)
 *
 * 강의 노트: M2_S6_redis_streams_theory.md
 *
 * 실행 방법 (루트에서): npm run exercise:s06:answer
 *
 * 사전 조건: 없음 (Mock Redis 사용 — 실제 Docker 불필요)
 *
 * 목표:
 *   Part 1 — RedisStreamPublisher: initialize() → publish()
 *   Part 2 — ConsumerGroupWorker:  EventProcessor 구현 → XREADGROUP → XACK
 */

import {
  RedisStreamPublisher, ConsumerGroupWorker, DLQHandler,
  type StreamEvent, type EventProcessor, type StreamMessage,
} from '@kyobo/event-engine';

// ────────────────────────────────────────────────────────────────────────
// Part 1 — RedisStreamPublisher
// ────────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────────
// Part 2 — ConsumerGroupWorker
// ────────────────────────────────────────────────────────────────────────

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
// 첫 번째 호출에서 메시지 1개 반환, 이후 빈 배열
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

// ── 실습 1 답안: SimpleNFTProcessor ────────────────────────────────────────
class SimpleNFTProcessor implements EventProcessor {
  readonly eventTypes = ['NFT_ISSUED'];   // TODO 1 완성

  async process(message: StreamMessage): Promise<void> {
    // TODO 2 완성
    const payload = JSON.parse(message.fields['payload'] ?? '{}');
    // TODO 3 완성
    console.log(`[SimpleNFTProcessor] NFT 처리 완료: tokenId=${payload.tokenId}, owner=${payload.owner}`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실행
// ────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== Part 1: RedisStreamPublisher ===\n');

  const publisher = new RedisStreamPublisher(publisherRedis);

  await publisher.initialize();
  await publisher.initialize(); // 두 번째 호출 → BUSYGROUP 무시 확인

  const event: StreamEvent = {
    streamKey:   'kyobo:events',
    eventType:   'NFT_ISSUED',
    payload:     { tokenId: '42', owner: '0xKYOBO' },
    txHash:      '0xdeadbeef001',
    blockNumber: 18500001,
    requestId:   'req-001',
  };

  // TODO 실습 4 완성
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

  // TODO 실습 5 완성
  const worker = new ConsumerGroupWorker(
    consumerRedis,
    [new SimpleNFTProcessor()],
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

  setTimeout(() => {
    console.log('[worker] stop() 호출');
    worker.stop();
  }, 3000);

  await worker.start();
  console.log('[worker] 종료 완료');
})();
