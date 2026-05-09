/**
 * S07 실습 (Docker 버전) — Redis Streams 전체 흐름 / 실제 Redis 연동
 *
 * 강의 노트: M2_S7_redis_streams_theory.md
 *
 * 실행 방법:
 *   1. Docker 기동:  docker compose -f docker-compose.redis.yml up -d
 *   2. 실습 실행:    npm run exercise:s07:docker
 *   3. 정리:         docker compose -f docker-compose.redis.yml down
 *
 * Mock 버전(S07_redis_stream.ts)과의 차이:
 *   - 실제 Redis 7에 XADD / XREADGROUP / XACK 명령이 날아감
 *   - redis-cli 로 스트림 상태를 직접 확인 가능
 *       docker exec kyobo-redis redis-cli XLEN kyobo:events
 *       docker exec kyobo-redis redis-cli XRANGE kyobo:events - +
 *       docker exec kyobo-redis redis-cli XPENDING kyobo:events issuer-consumers - + 10
 *
 * 목표:
 *   Part 1 — RedisStreamPublisher: initialize() → publish()
 *   Part 2 — ConsumerGroupWorker:  EventProcessor 구현 → XREADGROUP → XACK
 */

import {
  RedisStreamPublisher, ConsumerGroupWorker, DLQHandler,
  type StreamEvent, type EventProcessor, type StreamMessage,
  type RedisStreamClient, type RedisConsumerClient, type DLQRedisClient,
} from '@kyobo/event-engine';

// ────────────────────────────────────────────────────────────────────────
// ioredis 어댑터 — RedisStreamClient / RedisConsumerClient 구현
// ────────────────────────────────────────────────────────────────────────

// ioredis 타입을 직접 import 하지 않고 동적 require로 처리
// (devDependency 설치 없이도 npm run으로 실행 가능하게)
async function createIoRedis(host = '127.0.0.1', port = 6379) {
  let Redis: any;
  try {
    Redis = (await import('ioredis')).default;
  } catch {
    console.error(
      '❌  ioredis가 설치되지 않았습니다.\n' +
      '   npm install --save-dev ioredis @types/ioredis 를 실행한 후 다시 시도하세요.',
    );
    process.exit(1);
  }
  const client = new Redis({ host, port, lazyConnect: true });
  await client.connect();
  return client;
}

/**
 * ioredis 인스턴스를 RedisStreamClient / RedisConsumerClient 인터페이스로 래핑
 *
 * ioredis 명령 시그니처가 인터페이스와 다른 부분(XREADGROUP, XAUTOCLAIM)을
 * 여기서 정규화한다.  강의 핵심 개념이므로 주석을 꼼꼼히 읽을 것.
 */
function wrapRedis(r: any): RedisStreamClient & RedisConsumerClient & DLQRedisClient {
  return {
    // ── Publisher 인터페이스 ─────────────────────────────────────────

    async xadd(key: string, fields: Record<string, string>): Promise<string> {
      // XADD key * field1 value1 field2 value2 ...
      // '*' = Redis가 자동으로 {unix-ms}-{seq} messageId 부여
      const args: string[] = [];
      for (const [k, v] of Object.entries(fields)) {
        args.push(k, v);
      }
      const id = await r.xadd(key, '*', ...args) as string;
      console.log(`  [ioredis XADD] ${key} → ${id}`);
      return id;
    },

    async xgroupCreate(key: string, group: string, id: string, mkstream: boolean): Promise<void> {
      // XGROUP CREATE key group id [MKSTREAM]
      // '$' = 이 시점 이후 메시지부터 수신 / '0' = 스트림 전체부터
      const cmd = mkstream
        ? r.xgroup('CREATE', key, group, id, 'MKSTREAM')
        : r.xgroup('CREATE', key, group, id);
      await cmd.catch((err: Error) => {
        if (err.message.includes('BUSYGROUP')) {
          console.log(`  [ioredis XGROUP] 이미 존재 — 스킵`);
          return;
        }
        throw err;
      });
      console.log(`  [ioredis XGROUP CREATE] ${key}/${group} @ ${id}`);
    },

    async ping(): Promise<string> {
      return r.ping() as Promise<string>;
    },

    // ── Consumer 인터페이스 ──────────────────────────────────────────

    async xreadgroup(
      group: string,
      consumer: string,
      streams: Array<{ key: string; id: string }>,
      count: number,
      blockMs: number,
    ): Promise<Array<{ key: string; messages: StreamMessage[] }>> {
      // XREADGROUP GROUP group consumer COUNT count BLOCK blockMs
      //   STREAMS key1 key2 id1 id2
      // '>' = 아직 다른 consumer에게 전달되지 않은 새 메시지
      const keys = streams.map(s => s.key);
      const ids  = streams.map(s => s.id);   // '>' for new messages

      const raw = await r.xreadgroup(
        'GROUP', group, consumer,
        'COUNT', count,
        'BLOCK', blockMs,
        'STREAMS', ...keys, ...ids,
      ) as Array<[string, Array<[string, string[]]>]> | null;

      if (!raw) return [];

      return raw.map(([key, msgs]) => ({
        key,
        messages: msgs.map(([id, fieldArr]) => {
          // ioredis returns flat array: [k1, v1, k2, v2, ...]
          const fields: Record<string, string> = {};
          for (let i = 0; i < fieldArr.length; i += 2) {
            fields[fieldArr[i]] = fieldArr[i + 1];
          }
          return { id, fields };
        }),
      }));
    },

    async xack(key: string, group: string, ...ids: string[]): Promise<number> {
      const n = await r.xack(key, group, ...ids) as number;
      console.log(`  [ioredis XACK] ${ids.join(', ')} → PEL 제거 ✅ (${n}개)`);
      return n;
    },

    async xautoclaim(
      key: string,
      group: string,
      consumer: string,
      minIdleMs: number,
      startId: string,
      count: number,
    ): Promise<{ nextId: string; messages: StreamMessage[] }> {
      // XAUTOCLAIM key group consumer min-idle-time start COUNT count
      // minIdleMs ms 동안 ACK 없는 메시지를 이 consumer가 소유권 이전
      const raw = await r.xautoclaim(
        key, group, consumer, minIdleMs, startId, 'COUNT', count,
      ) as [string, Array<[string, string[]]>];

      const [nextId, msgs] = raw;
      return {
        nextId,
        messages: msgs.map(([id, fieldArr]) => {
          const fields: Record<string, string> = {};
          for (let i = 0; i < fieldArr.length; i += 2) {
            fields[fieldArr[i]] = fieldArr[i + 1];
          }
          return { id, fields };
        }),
      };
    },

    // ── DLQ 인터페이스 ───────────────────────────────────────────────

    async xrange(key: string, start: string, end: string, count?: number): Promise<Array<{ id: string; fields: Record<string, string> }>> {
      const args: any[] = [key, start, end];
      if (count !== undefined) args.push('COUNT', count);
      const raw = await r.xrange(...args) as Array<[string, string[]]>;
      return raw.map(([id, fieldArr]) => {
        const fields: Record<string, string> = {};
        for (let i = 0; i < fieldArr.length; i += 2) {
          fields[fieldArr[i]] = fieldArr[i + 1];
        }
        return { id, fields };
      });
    },

    async xdel(key: string, ...ids: string[]): Promise<number> {
      return r.xdel(key, ...ids) as Promise<number>;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Part 2 — EventProcessor 구현 (Mock 버전과 동일)
// ────────────────────────────────────────────────────────────────────────

const nftIssuedProcessor: EventProcessor = {
  eventTypes: ['NFT_ISSUED'],

  async process(msg: StreamMessage): Promise<void> {
    const payload   = JSON.parse(msg.fields['payload'] ?? '{}');
    const requestId = msg.fields['requestId'];
    console.log(`  [processor] NFT_ISSUED — tokenId: ${payload.tokenId}, owner: ${payload.owner}`);
    console.log(`  [processor] requestId: ${requestId}`);
    console.log('  [processor] NFT_ISSUED 처리 완료');
  },
};

// ────────────────────────────────────────────────────────────────────────
// 유틸: Enter 대기
// ────────────────────────────────────────────────────────────────────────
import * as readline from 'readline';

function pause(hint: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`\n⏸  ${hint}\n   → 확인 후 Enter 를 누르면 계속됩니다... `, () => {
      rl.close();
      resolve();
    });
  });
}

// ────────────────────────────────────────────────────────────────────────
// 실행
// ────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('🔌 Redis 연결 중... (127.0.0.1:6379)');
  const rawRedis = await createIoRedis();
  const redis    = wrapRedis(rawRedis);
  console.log('✅ Redis 연결 완료\n');

  // ── Step 1: XGROUP CREATE ─────────────────────────────────────────
  console.log('=== Step 1: XGROUP CREATE ===\n');

  const publisher = new RedisStreamPublisher(redis);
  await publisher.initialize();
  await publisher.initialize(); // 두 번째 호출 → BUSYGROUP 무시 확인

  await pause(
    'XGROUP 생성 완료. 다른 터미널에서 확인:\n' +
    '   docker exec kyobo-redis redis-cli XINFO GROUPS kyobo:events'
  );

  // ── Step 2: XADD ─────────────────────────────────────────────────
  console.log('\n=== Step 2: XADD (메시지 발행) ===\n');

  const event: StreamEvent = {
    streamKey:   'kyobo:events',
    eventType:   'NFT_ISSUED',
    payload:     { tokenId: '42', owner: '0xKYOBO' },
    txHash:      '0xdeadbeef001',
    blockNumber: 18500001,
    requestId:   `req-${Date.now()}`,
  };
  const messageId = await publisher.publish(event);
  console.log('\n[result] messageId:', messageId);
  console.log('[check] 형식 확인:', /^\d+-\d+$/.test(messageId) ? '✅ 정상' : '❌ 오류');

  const burned: StreamEvent = {
    streamKey:   'kyobo:events',
    eventType:   'NFT_BURNED',
    payload:     { tokenId: '41', owner: '0x0000' },
    txHash:      '0xcafebabe001',
    blockNumber: 18500002,
    requestId:   `req-${Date.now() + 1}`,
  };
  const burnedId = await publisher.publish(burned);
  console.log('[result] NFT_BURNED messageId:', burnedId);

  await pause(
    '메시지 2건 발행 완료. 다른 터미널에서 확인:\n' +
    '   docker exec kyobo-redis redis-cli XLEN kyobo:events\n' +
    '   docker exec kyobo-redis redis-cli XRANGE kyobo:events - +'
  );

  // ── Step 3: XREADGROUP + XACK ────────────────────────────────────
  console.log('\n=== Step 3: XREADGROUP + XACK (컨슈머 처리) ===\n');

  const dlq = new DLQHandler(wrapRedis(rawRedis), {
    async sendAlert(msg: string) { console.log('[DLQ ALERT]', msg); },
  });

  const worker = new ConsumerGroupWorker(
    redis,
    [nftIssuedProcessor],
    dlq,
    {
      streamKey:  'kyobo:events',
      groupName:  'issuer-consumers',
      consumerId: 'consumer-1',
      batchSize:  10,
      blockMs:    500,
      minIdleMs:  30_000,
    },
  );

  // 메시지를 1회 처리하고 멈추도록 2초 후 stop
  console.log('[worker] 시작 — XREADGROUP 실행 중...\n');
  setTimeout(() => worker.stop(), 2000);
  await worker.start();

  await pause(
    'XREADGROUP + XACK 완료. PEL 이 비어 있어야 정상:\n' +
    '   docker exec kyobo-redis redis-cli XPENDING kyobo:events issuer-consumers - + 10\n' +
    '   docker exec kyobo-redis redis-cli XLEN kyobo:events   (스트림은 남아 있음)'
  );

  // ── Step 4: 정리 ─────────────────────────────────────────────────
  console.log('\n=== Step 4: 스트림 초기화 (선택) ===');
  console.log('   docker exec kyobo-redis redis-cli DEL kyobo:events');

  await rawRedis.quit();
  console.log('\n🔌 Redis 연결 종료. 실습 완료!');
})();
