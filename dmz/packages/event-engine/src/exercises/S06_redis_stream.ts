/**
 * S06 실습 — Redis Streams 전체 흐름
 *
 * 강의 노트: M2_S6_redis_streams_theory.md
 *
 * 실행 방법 (dmz/packages/event-engine 폴더에서):
 *   npx ts-node src/exercises/S06_redis_stream.ts
 *
 * 사전 조건: 없음 (Mock Redis 사용 — 실제 Docker 불필요)
 *
 * 목표:
 *   Part 1 — RedisStreamPublisher: initialize() → publish()
 *   Part 2 — ConsumerGroupWorker:  EventProcessor 구현 → XREADGROUP → XACK
 */

import { RedisStreamPublisher, type StreamEvent } from '../dmz/RedisStreamPublisher';
import { ConsumerGroupWorker, type EventProcessor, type StreamMessage } from '../dmz/ConsumerGroupWorker';
import { DLQHandler } from '../dmz/DLQHandler';

// ══════════════════════════════════════════════════════════════════════════
// Part 1 — RedisStreamPublisher
// ══════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════
// Part 2 — ConsumerGroupWorker
// ══════════════════════════════════════════════════════════════════════════

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

// ── TODO 1: NFTIssuedProcessor를 구현하라 ─────────────────────────────────
// EventProcessor 인터페이스:
//   eventTypes: string[]        — 처리할 이벤트 타입 목록
//   process(msg): Promise<void> — 실제 처리 로직 (멱등성 보장 필수)
//
// 구현 요구사항:
//   - eventTypes: ['NFT_ISSUED']
//   - process: payload(JSON) 파싱 → tokenId, owner 출력
//              requestId 출력
//              처리 완료 로그 출력
const nftIssuedProcessor: EventProcessor = {
  eventTypes: /* TODO */ [],

  async process(msg: StreamMessage): Promise<void> {
    // TODO: msg.fields['payload']를 JSON.parse
    // TODO: tokenId, owner, requestId 출력
    // TODO: '[processor] NFT_ISSUED 처리 완료' 로그
  },
};

// ── TODO 2: ConsumerGroupWorker 인스턴스를 생성하라 ───────────────────────
// 인자 순서: (redis, processors, dlq, config)
// config:
//   streamKey:  'kyobo:events'
//   groupName:  'issuer-consumers'
//   consumerId: 'consumer-1'
//   batchSize:  10
//   blockMs:    500
//   minIdleMs:  30_000
const worker: ConsumerGroupWorker = /* TODO */ null as any;

// ══════════════════════════════════════════════════════════════════════════
// 실행
// ══════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('=== Part 1: RedisStreamPublisher ===\n');

  // TODO 3: RedisStreamPublisher 인스턴스를 생성하라 (publisherRedis 주입)
  const publisher: RedisStreamPublisher = /* TODO */ null as any;

  // TODO 4: initialize()를 호출하라
  //         → [XGROUP CREATE] 로그 출력되는지 확인
  //         → 두 번 호출해도 에러 없는지 확인 (BUSYGROUP 처리)
  await /* TODO */ Promise.resolve();

  // TODO 5: 아래 이벤트를 publish()로 발행하라
  const event: StreamEvent = {
    streamKey:   'kyobo:events',
    eventType:   'NFT_ISSUED',
    payload:     { tokenId: '42', owner: '0xKYOBO' },
    txHash:      '0xdeadbeef001',
    blockNumber: 18500001,
    requestId:   'req-001',
  };

  const messageId: string = /* TODO */ '';

  console.log('[result] messageId:', messageId);
  console.log('[check] 형식 확인:', /^\d+-\d+$/.test(messageId) ? '✅ 정상' : '❌ 오류');

  console.log('\n=== Part 2: ConsumerGroupWorker ===\n');
  console.log('[worker] 시작 — 3초 후 자동 종료');

  setTimeout(() => {
    console.log('[worker] stop() 호출');
    worker.stop();
  }, 3000);

  await worker.start();
  console.log('[worker] 종료 완료');
})();
