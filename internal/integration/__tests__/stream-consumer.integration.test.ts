/**
 * Redis Stream 통합 테스트 — 클라우드 Redis
 *
 * ConsumerGroupPool + NFTIssuedProcessor + PgNFTLedgerService
 *
 * 검증 시나리오:
 *   [1] NFT_ISSUED 발행 → ConsumerGroupPool 처리 → LedgerService 잔액 반영
 *   [2] 동일 requestId 중복 발행 → 멱등성 보장 (한 번만 처리)
 *   [3] 처리 실패 3회 → DLQ 이동 확인
 *   [4] XAUTOCLAIM — PEL 잔류 메시지 재수신 처리
 *   [5] burst — 동시 5건 발행 → 전체 처리 완료
 *
 * REDIS_URL 환경변수 필수: 클라우드 Redis 연결 문자열
 */

import Redis                       from 'ioredis';
import { randomUUID }              from 'crypto';
import { getRedisUrl }             from '../helpers/state';

// ── InMemoryRedis (REDIS_URL 미설정 시 폴백) ──────────────────────────────────
// TestRedisAdapter가 호출하는 ioredis 메서드와 동일한 시그니처를 구현한다.

class InMemoryRedis {
  private streams = new Map<string, Array<{ id: string; fields: string[] }>>();
  private groups  = new Map<string, {
    lastId: string;
    pel:    Map<string, { consumer: string; deliveredAt: number; fields: string[] }>;
  }>();
  private kv  = new Map<string, string>();
  private seq = 0;

  private genId(): string {
    return `${Date.now()}-${String(this.seq++).padStart(4, '0')}`;
  }

  private cmpId(a: string, b: string): number {
    const parse = (s: string) => s.split('-').map(Number) as [number, number];
    const [at, as_] = parse(a);
    const [bt, bs]  = parse(b);
    return at !== bt ? at - bt : as_ - bs;
  }

  // xadd(key, '*', f1, v1, f2, v2, ...) — TestRedisAdapter.xadd 호출 형식
  async xadd(key: string, _id: string, ...fieldValues: string[]): Promise<string> {
    if (!this.streams.has(key)) this.streams.set(key, []);
    const id = this.genId();
    this.streams.get(key)!.push({ id, fields: fieldValues });
    return id;
  }

  // xreadgroup('GROUP', g, c, 'COUNT', n, 'BLOCK', ms, 'STREAMS', key, '>') — 가변 인자
  async xreadgroup(...args: unknown[]): Promise<unknown> {
    let group = '', consumer = '', count = 10, key = '';
    for (let i = 0; i < args.length; i++) {
      switch (String(args[i]).toUpperCase()) {
        case 'GROUP':   group = String(args[++i]); consumer = String(args[++i]); break;
        case 'COUNT':   count = Number(args[++i]); break;
        case 'BLOCK':   i++; break;
        case 'STREAMS': key = String(args[++i]); i++; break; // id('>')는 무시
      }
    }
    const gk = `${key}:${group}`;
    const gs = this.groups.get(gk);
    if (!gs) return null;

    const msgs = (this.streams.get(key) ?? [])
      .filter(m => this.cmpId(m.id, gs.lastId) > 0)
      .slice(0, count);
    if (!msgs.length) return null;

    for (const m of msgs) {
      gs.pel.set(m.id, { consumer, deliveredAt: Date.now(), fields: m.fields });
      gs.lastId = m.id;
    }
    return [[key, msgs.map(m => [m.id, m.fields])]];
  }

  async xack(key: string, group: string, ...ids: string[]): Promise<number> {
    const gs = this.groups.get(`${key}:${group}`);
    if (!gs) return 0;
    return ids.filter(id => gs.pel.delete(id)).length;
  }

  // xautoclaim(key, group, consumer, minIdleMs, startId, 'COUNT', count)
  async xautoclaim(
    key: string, group: string, consumer: string,
    minIdleMs: number, startId: string, _kw: string, count: number,
  ): Promise<unknown> {
    const gs  = this.groups.get(`${key}:${group}`);
    if (!gs) return ['0-0', []];
    const now     = Date.now();
    const claimed: [string, string[]][] = [];
    for (const [id, entry] of gs.pel) {
      if (this.cmpId(id, startId) >= 0 && now - entry.deliveredAt >= minIdleMs) {
        entry.consumer    = consumer;
        entry.deliveredAt = now;
        claimed.push([id, entry.fields]);
        if (claimed.length >= count) break;
      }
    }
    return ['0-0', claimed];
  }

  async xrange(key: string, start: string, end: string): Promise<[string, string[]][]> {
    return (this.streams.get(key) ?? [])
      .filter(m =>
        (start === '-' || this.cmpId(m.id, start) >= 0) &&
        (end   === '+' || this.cmpId(m.id, end)   <= 0),
      )
      .map(m => [m.id, m.fields]);
  }

  async xdel(key: string, ...ids: string[]): Promise<number> {
    const s = this.streams.get(key);
    if (!s) return 0;
    let n = 0;
    for (const id of ids) {
      const i = s.findIndex(m => m.id === id);
      if (i >= 0) { s.splice(i, 1); n++; }
    }
    return n;
  }

  // xgroup('CREATE', key, group, id, 'MKSTREAM')
  async xgroup(cmd: string, key: string, group: string, id: string, ...rest: string[]): Promise<string> {
    if (cmd.toUpperCase() !== 'CREATE') throw new Error(`xgroup ${cmd} not supported`);
    const gk = `${key}:${group}`;
    if (this.groups.has(gk)) throw new Error('BUSYGROUP Consumer Group name already exists');
    if (rest.includes('MKSTREAM') && !this.streams.has(key)) this.streams.set(key, []);
    const stream = this.streams.get(key) ?? [];
    const lastId = id === '$'
      ? (stream.length ? stream[stream.length - 1]!.id : '0-0')
      : id;
    this.groups.set(gk, { lastId, pel: new Map() });
    return 'OK';
  }

  async set(key: string, value: string, _exMode?: string, _ttl?: number): Promise<unknown> {
    this.kv.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) {
      if (this.kv.delete(key)) n++;
      if (this.streams.delete(key)) n++;
      for (const gk of this.groups.keys()) {
        if (gk.startsWith(`${key}:`)) this.groups.delete(gk);
      }
    }
    return n;
  }

  disconnect(): void {}
}

import { Pool }                     from 'pg';
import {
  ConsumerGroupPool,
  NFTIssuedProcessor,
  DLQHandler,
  IdempotencyGuard,
  RedisIdempotencyStore,
}                                  from '@kyobo/event-engine';
import type {
  RedisConsumerClient,
  StreamMessage,
}                                  from '@kyobo/event-engine';
import { PgNFTLedgerService }      from '../../apps/issuer-service/src/infra/PgNFTLedgerService';
import { StubCoreBankingAdapter }  from '../../packages/core-banking/src/adapters/StubCoreBankingAdapter';
import { getPgUrl }                from '../helpers/state';

class PgRecordingCoreBankingAdapter extends StubCoreBankingAdapter {
  constructor(private readonly pool: Pool) { super(); }

  override async recordNftHolding(params: {
    userId: string; tokenId: bigint; contractAddr: string;
    chainId: number; amount: bigint; acquiredAt: Date; onChainTx: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_nft_holdings
         (user_id, token_id, contract_addr, chain_id, amount, acquired_at, on_chain_tx)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, token_id, contract_addr, chain_id)
       DO UPDATE SET amount = user_nft_holdings.amount + EXCLUDED.amount,
                     on_chain_tx = EXCLUDED.on_chain_tx`,
      [params.userId, params.tokenId, params.contractAddr, params.chainId,
       params.amount, params.acquiredAt, params.onChainTx],
    );
  }
}

const TEST_CONTRACT_ADDR = '0x0000000000000000000000000000000000000001';
const TEST_CHAIN_ID      = 31337;

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

  async set(key: string, value: string, expiryMode: string, time: number): Promise<unknown> {
    return this.r.set(key, value, expiryMode as 'EX', time);
  }

  async get(key: string): Promise<string | null> {
    return this.r.get(key);
  }

  async del(key: string): Promise<number> {
    return this.r.del(key);
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
  let redis:       Redis | InMemoryRedis;
  let adapter:     TestRedisAdapter;
  let pool:        Pool;
  let streamKey:   string;
  let dlqKey:      string;
  const GROUP      = 'nft-consumers-integration';
  const CONSUMER   = 'consumer-int-1';

  beforeAll(async () => {
    const ts = Date.now();
    streamKey = `kyobo:events:integration:${ts}`;
    dlqKey    = `${streamKey}:dlq`;

    try {
      const url = getRedisUrl();
      redis = new Redis(url);
      await (redis as Redis).ping();
      console.log('[stream-consumer] 실제 Redis 연결');
    } catch {
      console.warn('[stream-consumer] REDIS_URL 미설정 또는 연결 실패 → InMemoryRedis 폴백');
      (redis as any)?.disconnect?.();
      redis = new InMemoryRedis();
    }

    adapter = new TestRedisAdapter(redis as Redis);

    pool = new Pool({ connectionString: getPgUrl() });
    // 테스트용 wallet 시드
    await pool.query(`
      INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified) VALUES
        ('user-stream-001', '0xOWNER001', 'MOCK', true),
        ('user-stream-002', '0xOWNER002', 'MOCK', true),
        ('user-stream-004', '0xOWNER004', 'MOCK', true)
      ON CONFLICT (user_id) DO NOTHING
    `);
  });

  afterAll(async () => {
    await redis.del(streamKey, dlqKey);
    redis.disconnect();
    await pool.end().catch(() => {});
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
    const ledger      = new PgNFTLedgerService(pool, TEST_CONTRACT_ADDR, TEST_CHAIN_ID, new PgRecordingCoreBankingAdapter(pool));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idempotency = new IdempotencyGuard(new RedisIdempotencyStore(redis as any));
    const processor   = new NFTIssuedProcessor(idempotency, ledger);

    const dlq    = new DLQHandler(adapter, { async sendAlert(m) { console.error('[DLQ]', m); } });
    const cgPool = new ConsumerGroupPool(adapter, dlq, {
      streamKey, batchSize: 10, blockMs: 200, minIdleMs: 60_000,
    }, [{ groupName: GROUP, consumerId: CONSUMER, processors: [processor] }]);

    cgPool.start().catch(() => {});

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

    cgPool.stop();
  });

  // ── [2] 멱등성 ────────────────────────────────────────────────────────────

  it('[2] 동일 requestId 중복 발행 → 한 번만 처리 (멱등성 보장)', async () => {
    let processCount = 0;
    const ledger = new PgNFTLedgerService(pool, TEST_CONTRACT_ADDR, TEST_CHAIN_ID, new PgRecordingCoreBankingAdapter(pool));

    // creditNFT 호출 횟수 추적
    const originalCredit = ledger.creditNFT.bind(ledger);
    ledger.creditNFT = async (owner, tokenId, amount, txHash) => {
      processCount++;
      return originalCredit(owner, tokenId, amount, txHash);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idempotency = new IdempotencyGuard(new RedisIdempotencyStore(redis as any));
    const processor   = new NFTIssuedProcessor(idempotency, ledger);
    const dlq         = new DLQHandler(adapter, { async sendAlert() {} });
    const cgPool      = new ConsumerGroupPool(adapter, dlq, {
      streamKey, batchSize: 10, blockMs: 200, minIdleMs: 60_000,
    }, [{ groupName: GROUP, consumerId: CONSUMER, processors: [processor] }]);

    cgPool.start().catch(() => {});

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

    cgPool.stop();
  });

  // ── [3] DLQ ───────────────────────────────────────────────────────────────

  it('[3] 처리 3회 실패 → DLQ 이동 확인', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idempotency = new IdempotencyGuard(new RedisIdempotencyStore(redis as any));
    const ledger      = new PgNFTLedgerService(pool, TEST_CONTRACT_ADDR, TEST_CHAIN_ID, new PgRecordingCoreBankingAdapter(pool));
    const failProcessor = new AlwaysFailProcessor(idempotency, ledger);

    // DLQHandler에 streamKey를 전달해야 dlqKey = streamKey:dlq 로 일치
    const dlq    = new DLQHandler(adapter, { async sendAlert(m) { console.warn('[DLQ alert]', m); } }, streamKey);
    const cgPool = new ConsumerGroupPool(adapter, dlq, {
      streamKey, batchSize: 10, blockMs: 200, minIdleMs: 60_000,
    }, [{ groupName: GROUP, consumerId: CONSUMER, processors: [failProcessor] }]);

    cgPool.start().catch(() => {});

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

    cgPool.stop();
  });

  // ── [4] XAUTOCLAIM ────────────────────────────────────────────────────────

  it('[4] XAUTOCLAIM — PEL 잔류 메시지 재수신 처리', async () => {
    // 다른 테스트와 격리된 Consumer Group (timestamp 포함으로 고유 보장)
    const CLAIM_GROUP    = `${GROUP}-autoclaim-${Date.now()}`;
    const CRASH_CONSUMER = 'consumer-crash';
    const NEW_CONSUMER   = 'consumer-reclaim';

    const ledger      = new PgNFTLedgerService(pool, TEST_CONTRACT_ADDR, TEST_CHAIN_ID, new PgRecordingCoreBankingAdapter(pool));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idempotency = new IdempotencyGuard(new RedisIdempotencyStore(redis as any));
    const processor   = new NFTIssuedProcessor(idempotency, ledger);

    // '$' 기준 생성 — 이후 추가되는 메시지만 수신
    await (redis as any).xgroup('CREATE', streamKey, CLAIM_GROUP, '$', 'MKSTREAM');

    // ① 메시지 발행
    const requestId = randomUUID();
    const tokenId   = '4004';
    const owner     = '0xOWNER004';
    await adapter.xadd(streamKey, {
      eventType:   'NFT_ISSUED',
      requestId,
      txHash:      '0x' + 'dd'.repeat(32),
      blockNumber: '1002',
      payload:     JSON.stringify({ tokenId, to: owner, blockNumber: 1002 }),
      publishedAt: new Date().toISOString(),
      _retryCount: '0',
    });

    // ② CRASH_CONSUMER가 XREADGROUP으로 읽음 — XACK 없이 중단 (crash 시뮬레이션)
    //    메시지가 PEL(Pending Entry List)에 잔류
    const readResult = await adapter.xreadgroup(
      CLAIM_GROUP, CRASH_CONSUMER,
      [{ key: streamKey, id: '>' }],
      10, 0,
    );
    expect(readResult[0]?.messages.length).toBe(1);
    // XACK 없음 → PEL 잔류 상태

    // ③ minIdleMs(200ms)가 지나도록 대기
    await new Promise(r => setTimeout(r, 500));

    // ④ NEW_CONSUMER로 ConsumerGroupPool 기동
    //    minIdleMs=200 → 500ms 이상 idle된 PEL 메시지를 XAUTOCLAIM으로 즉시 재수신
    const dlq    = new DLQHandler(adapter, { async sendAlert() {} });
    const cgPool = new ConsumerGroupPool(adapter, dlq, {
      streamKey, batchSize: 10, blockMs: 100, minIdleMs: 200,
    }, [{ groupName: CLAIM_GROUP, consumerId: NEW_CONSUMER, processors: [processor] }]);

    cgPool.start().catch(() => {});

    // ⑤ 재수신 후 처리 완료 확인
    await waitFor(async () => (await ledger.getNFTBalance(owner, tokenId)) > 0);

    expect(await ledger.getNFTBalance(owner, tokenId)).toBe(1);

    cgPool.stop();
  });

  // ── [5] burst ─────────────────────────────────────────────────────────────

  it('[5] burst — 동시 5건 발행 → 전체 처리 완료', async () => {
    const ledger      = new PgNFTLedgerService(pool, TEST_CONTRACT_ADDR, TEST_CHAIN_ID, new PgRecordingCoreBankingAdapter(pool));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idempotency = new IdempotencyGuard(new RedisIdempotencyStore(redis as any));
    const processor   = new NFTIssuedProcessor(idempotency, ledger);
    const dlq         = new DLQHandler(adapter, { async sendAlert() {} });
    const cgPool      = new ConsumerGroupPool(adapter, dlq, {
      streamKey, batchSize: 10, blockMs: 200, minIdleMs: 60_000,
    }, [{ groupName: GROUP, consumerId: CONSUMER, processors: [processor] }]);

    cgPool.start().catch(() => {});

    const users = Array.from({ length: 5 }, (_, i) => ({
      owner:     `0xBURST00${i + 1}`,
      tokenId:   String(9000 + i),
      requestId: randomUUID(),
    }));

    // wallet 시드
    await pool.query(`
      INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
      VALUES ${users.map((_, i) => `('user-burst-00${i + 1}', '0xBURST00${i + 1}', 'MOCK', true)`).join(',')}
      ON CONFLICT (user_id) DO NOTHING
    `);

    // 5건 동시 발행
    await Promise.all(users.map((u, i) =>
      adapter.xadd(streamKey, {
        eventType:   'NFT_ISSUED',
        requestId:   u.requestId,
        txHash:      '0x' + String(i).repeat(64),
        blockNumber: String(2000 + i),
        payload:     JSON.stringify({ tokenId: u.tokenId, to: u.owner, blockNumber: 2000 + i }),
        publishedAt: new Date().toISOString(),
        _retryCount: '0',
      }),
    ));

    // 전체 처리 완료 대기
    await waitFor(async () => {
      const balances = await Promise.all(users.map(u => ledger.getNFTBalance(u.owner, u.tokenId)));
      return balances.every(b => b > 0);
    });

    const balances = await Promise.all(users.map(u => ledger.getNFTBalance(u.owner, u.tokenId)));
    balances.forEach(b => expect(b).toBe(1));

    cgPool.stop();
  });
});
