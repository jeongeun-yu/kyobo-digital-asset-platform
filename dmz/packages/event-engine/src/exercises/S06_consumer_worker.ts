/**
 * S06 실습 — ConsumerGroupWorker 구조 이해 + EventProcessor 구현
 *
 * 강의 노트: M2_S6_redis_streams_theory.md
 *
 * 실행 방법 (dmz/packages/event-engine 폴더에서):
 *   npx ts-node src/exercises/S06_consumer_worker.ts
 *
 * 목표:
 *   1. EventProcessor 인터페이스 직접 구현
 *   2. ConsumerGroupWorker 인스턴스 생성
 *   3. Mock Redis로 XREADGROUP → 처리 → XACK 흐름 확인
 */

import { ConsumerGroupWorker, type EventProcessor, type StreamMessage } from '../dmz/ConsumerGroupWorker';
import { DLQHandler } from '../dmz/DLQHandler';

// ── Mock DLQ ─────────────────────────────────────────────────────────────
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

// ── Mock Redis Consumer Client ───────────────────────────────────────────
// 첫 번째 호출에서 메시지 1개 반환, 이후 빈 배열
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

// ── TODO 1: NFTIssuedProcessor를 구현하라 ────────────────────────────────
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

// ── 실행 ─────────────────────────────────────────────────────────────────
(async () => {
  console.log('[worker] 시작 — 3초 후 자동 종료');

  setTimeout(() => {
    console.log('[worker] stop() 호출');
    worker.stop();
  }, 3000);

  await worker.start();
  console.log('[worker] 종료 완료');
})();
