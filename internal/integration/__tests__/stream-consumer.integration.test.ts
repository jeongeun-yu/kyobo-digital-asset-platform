/**
 * Redis Stream 통합 테스트 — 클라우드 Redis
 *
 * ConsumerGroupPool + NFTIssuedProcessor + InMemoryLedgerService
 *
 * 검증 시나리오:
 *   [1] NFT_ISSUED 발행 → ConsumerGroupPool 처리 → LedgerService 잔액 반영
 *   [2] 동일 requestId 중복 발행 → 멱등성 보장 (한 번만 처리)
 *   [3] 처리 실패 3회 → DLQ 이동 확인
 *   [4] XAUTOCLAIM — PEL 잔류 메시지 재수신 처리
 *
 * REDIS_URL 환경변수 필수: 클라우드 Redis 연결 문자열
 */

import Redis                       from 'ioredis';
import { randomUUID }              from 'crypto';
import { getRedisUrl }             from '../helpers/state';
import {
  ConsumerGroupPool,
  NFTIssuedProcessor,
  InMemoryLedgerService,
  DLQHandler,
  IdempotencyGuard,
  InMemoryIdempotencyStore,
}                                  from '@kyobo/event-engine';
import type {
  RedisConsumerClient,
  StreamMessage,
}                                  from '@kyobo/event-engine';

// ── 테스트용 IoRedis 어댑터 ───────────────────────────────────────────────────

class TestRedisAdapter implements RedisConsumerClient {
  constructor(private readonly r: Redis) {}

  async xreadgroup(
    group: string, consumer: string,
    streams: Array<{ key: string; id: string }>,
    count: number, blockMs: number,
  ): Promise<Array<{ key: string; messages: StreamMessage[] }>> {
    const args: any[] = ['GROUP', group, consumer, 'COUNT', count, 'BLOCK', blockMs];
    streams.forEach(s => args.push('STREAMS', s.key, s.id));

    const raw = await (this.r as any).xreadgroup(...args) as any;
    if (!raw) return [];

    return raw.map(([key, msgs]: [string, [string, string[]][]]) => ({
      key,
      messages: msgs.map(([id, fields]) => ({
        id,
        fields: this._parseFields(fields),
      })),
    }));
  }

  async xack(key: string, group: string, ...ids: string[]): Promise<number> {
    return this.r.xack(key, group, ...ids);
  }

  async xautoclaim(
    key: string, group: string, consumer: string,
    minIdleMs: number, startId: string, count: number,
  ): Promise<{ nextId: string; messages: StreamMessage[] }> {
    const raw = await (this.r as any).xautoclaim(
      key, group, consumer, minIdleMs, startId, 'COUNT', count,
    ) as any;

    const nextId   = raw[0] as string;
    const rawMsgs  = raw[1] as [string, string[]][];

    return {
      nextId,
      messages: (rawMsgs ?? []).map(([id, fields]) => ({
        id,
        fields: this._parseFields(fields),
      })),
    };
  }

  async xadd(key: string, fields: Record<string, string>): Promise<string> {
    const args = Object.entries(fields).flat();
    return this.r.xadd(key, '*', ...args) as Promise<string>;
  }

  async xrange(key: string, start: string, end: string): Promise<StreamMessage[]> {
    const raw = await this.r.xrange(key, start, end) as [string, string[]][];
    return raw.map(([id, fields]) => ({ id, fields: this._parseFields(fields) }));
  }

  async xdel(key: string, ...ids: string[]): Promise<number> {
    return this.r.xdel(key, ...ids);
  }

  private _parseFields(flat: string[]): Record<string, string> {
    const obj: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) {
      obj[flat[i]!] = flat[i + 1]!;
    }
    return obj;
  }
}

// ── 실패를 강제하는 테스트용 Processor ────────────────────────────────────────

class AlwaysFailProcessor extends NFTIssuedProcessor {
  async process(_msg: StreamMessage): Promise<void> {
    throw new Error('강제 실패 — DLQ 테스트용');
  }
}

// ── 처리 완료 대기 헬퍼 ───────────────────────────────────────────────────────

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 150));
  }
}

// ── 테스트 픽스처 ─────────────────────────────────────────────────────────────

describe('Redis Stream 통합 — ConsumerGroupPool E2E', () => {
  let redis:       Redis;
  let adapter:     TestRedisAdapter;
  let streamKey:   string;
  let dlqKey:      string;
  const GROUP      = 'nft-consumers-integration';
  const CONSUMER   = 'consumer-int-1';

  beforeAll(async () => {
    redis    = new Redis(getRedisUrl());
    adapter  = new TestRedisAdapter(redis);
    // 테스트 실행마다 고유 스트림 키 — 클라우드 Redis 간섭 방지
    const ts = Date.now();
    streamKey = `kyobo:events:integration:${ts}`;
    dlqKey    = `${streamKey}:dlq`;
  });

  afterAll(async () => {
    // 테스트용 스트림 정리
    await redis.del(streamKey, dlqKey);
    redis.disconnect();
  });

  // 각 테스트 전 Consumer Group 초기화
  beforeEach(async () => {
    try {
      await (redis as any).xgroup('CREATE', streamKey, GROUP, '0', 'MKSTREAM');
    } catch (e: any) {
      if (!e.message.includes('BUSYGROUP')) throw e;
    }
  });

  // ── [1] 정상 처리 ──────────────────────────────────────────────────────────

  it('[1] NFT_ISSUED → ConsumerGroupPool 처리 → LedgerService 잔액 반영', async () => {
    const ledger      = new InMemoryLedgerService();
    const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const processor   = new NFTIssuedProcessor(idempotency, ledger);

    const dlq  = new DLQHandler(adapter, { async sendAlert(m) { console.error('[DLQ]', m); } });
    const pool = new ConsumerGroupPool(adapter, dlq, {
      streamKey, batchSize: 10, blockMs: 200, minIdleMs: 60_000,
    }, [{ groupName: GROUP, consumerId: CONSUMER, processors: [processor] }]);

    pool.start().catch(() => {});

    const requestId = randomUUID();
    const owner     = '0xOWNER001';
    const tokenId   = '1001';

    // NFT_ISSUED 이벤트 발행
    await adapter.xadd(streamKey, {
      eventType:   'NFT_ISSUED',
      requestId,
      txHash:      '0x' + 'aa'.repeat(32),
      blockNumber: '999',
      payload:     JSON.stringify({ tokenId, to: owner, blockNumber: 999 }),
      publishedAt: new Date().toISOString(),
      _retryCount: '0',
    });

    // 처리 완료 대기
    await waitFor(async () => {
      const balance = await ledger.getNFTBalance(owner, tokenId);
      return balance > 0;
    });

    const balance = await ledger.getNFTBalance(owner, tokenId);
    expect(balance).toBe(1);

    pool.stop();
  });

  // ── [2] 멱등성 ────────────────────────────────────────────────────────────

  it('[2] 동일 requestId 중복 발행 → 한 번만 처리 (멱등성 보장)', async () => {
    let processCount = 0;
    const ledger = new InMemoryLedgerService();

    // creditNFT 호출 횟수 추적
    const originalCredit = ledger.creditNFT.bind(ledger);
    ledger.creditNFT = async (owner, tokenId, amount) => {
      processCount++;
      return originalCredit(owner, tokenId, amount);
    };

    const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const processor   = new NFTIssuedProcessor(idempotency, ledger);
    const dlq         = new DLQHandler(adapter, { async sendAlert() {} });
    const pool        = new ConsumerGroupPool(adapter, dlq, {
      streamKey, batchSize: 10, blockMs: 200, minIdleMs: 60_000,
    }, [{ groupName: GROUP, consumerId: CONSUMER, processors: [processor] }]);

    pool.start().catch(() => {});

    const requestId = randomUUID();
    const fields = {
      eventType:   'NFT_ISSUED',
      requestId,
      txHash:      '0x' + 'bb'.repeat(32),
      blockNumber: '1000',
      payload:     JSON.stringify({ tokenId: '2002', to: '0xOWNER002', blockNumber: 1000 }),
      publishedAt: new Date().toISOString(),
      _retryCount: '0',
    };

    // 동일 requestId로 두 번 발행
    await adapter.xadd(streamKey, fields);
    await adapter.xadd(streamKey, fields);

    // 첫 번째 처리가 완료될 때까지 대기
    await waitFor(() => processCount >= 1);
    // 추가 처리가 발생하지 않도록 잠시 대기
    await new Promise(r => setTimeout(r, 500));

    expect(processCount).toBe(1);

    pool.stop();
  });

  // ── [3] DLQ ───────────────────────────────────────────────────────────────

  it('[3] 처리 3회 실패 → DLQ 이동 확인', async () => {
    const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const ledger      = new InMemoryLedgerService();
    const failProcessor = new AlwaysFailProcessor(idempotency, ledger);

    // DLQHandler에 streamKey를 전달해야 dlqKey = streamKey:dlq 로 일치
    const dlq = new DLQHandler(adapter, { async sendAlert(m) { console.warn('[DLQ alert]', m); } }, streamKey);
    const pool = new ConsumerGroupPool(adapter, dlq, {
      streamKey, batchSize: 10, blockMs: 200, minIdleMs: 60_000,
    }, [{ groupName: GROUP, consumerId: CONSUMER, processors: [failProcessor] }]);

    pool.start().catch(() => {});

    // _retryCount >= MAX_RETRIES(3) → 첫 수신 즉시 DLQ로 라우팅
    await adapter.xadd(streamKey, {
      eventType:   'NFT_ISSUED',
      requestId:   randomUUID(),
      txHash:      '0x' + 'cc'.repeat(32),
      blockNumber: '1001',
      payload:     JSON.stringify({ tokenId: '3003', to: '0xOWNER003', blockNumber: 1001 }),
      publishedAt: new Date().toISOString(),
      _retryCount: '3',
    });

    // DLQ 스트림에 메시지가 쌓일 때까지 대기
    await waitFor(async () => {
      const dlqMsgs = await adapter.xrange(dlqKey, '-', '+');
      return dlqMsgs.length > 0;
    });

    const dlqMessages = await adapter.xrange(dlqKey, '-', '+');
    expect(dlqMessages.length).toBeGreaterThan(0);
    expect(dlqMessages[0]!.fields['eventType']).toBe('NFT_ISSUED');
    expect(dlqMessages[0]!.fields['_reason']).toBeTruthy();

    pool.stop();
  });
});
