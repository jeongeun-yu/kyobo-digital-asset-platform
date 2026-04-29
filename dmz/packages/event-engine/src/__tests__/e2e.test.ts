/**
 * S12 채점 — M2 DMZ 이벤트 파이프라인 E2E
 *
 * Mock Redis로 전체 파이프라인을 검증한다.
 * WebhookServer는 실제 HTTP 서버를 사용하지 않고 내부 로직만 직접 호출.
 */

import { WebhookPublishHandler } from '../webhook/WebhookPublishHandler';
import { IdempotencyGuard, InMemoryIdempotencyStore } from '../webhook/IdempotencyGuard';
import { RedisStreamPublisher, type RedisStreamClient } from '../dmz/RedisStreamPublisher';
import { ConsumerGroupWorker, type RedisConsumerClient, type StreamMessage } from '../dmz/ConsumerGroupWorker';
import { DLQHandler } from '../dmz/DLQHandler';
import { NFTIssuedProcessor, InMemoryLedgerService } from '../processors/NFTIssuedProcessor';
import { type WebhookPayload } from '../webhook/WebhookServer';

// ── Mock Redis ─────────────────────────────────────────────────────────────
class MockRedisStream implements RedisStreamClient, RedisConsumerClient {
  readonly store: StreamMessage[] = [];
  readonly xackIds: string[] = [];
  private readIdx = 0;

  async xadd(_key: string, fields: Record<string, string>): Promise<string> {
    const id = `${Date.now()}-${this.store.length}`;
    this.store.push({ id, fields });
    return id;
  }
  async xgroupCreate(): Promise<void> {}
  async ping(): Promise<string> { return 'PONG'; }

  async xreadgroup(
    _g: string, _c: string,
    _s: Array<{ key: string; id: string }>,
    count: number, blockMs: number,
  ) {
    const slice = this.store.slice(this.readIdx, this.readIdx + count);
    if (slice.length > 0) { this.readIdx += slice.length; return [{ key: 'kyobo:events', messages: slice }]; }
    // blockMs=0이어도 최소 1ms 대기 — tight loop가 macrotask(setTimeout) 실행을 막는 것을 방지
    await new Promise(r => setTimeout(r, blockMs > 0 ? Math.min(blockMs, 10) : 1));
    return [];
  }
  async xack(_k: string, _g: string, ...ids: string[]): Promise<number> {
    this.xackIds.push(...ids);
    return ids.length;
  }
  async xautoclaim(): Promise<{ nextId: string; messages: StreamMessage[] }> {
    return { nextId: '0-0', messages: [] };
  }
}

function makeDLQ() {
  return new DLQHandler(
    { async xadd() { return `${Date.now()}-0`; }, async xrange() { return []; }, async xdel() { return 0; } },
    { async sendAlert() {} },
  );
}

async function runWorkerUntilIdle(worker: ConsumerGroupWorker, ms = 80): Promise<void> {
  const p = worker.start();
  await new Promise(r => setTimeout(r, ms));
  worker.stop();
  await p;
}

// ── 채점 테스트 ────────────────────────────────────────────────────────────

describe('S12 채점 — WebhookPublishHandler', () => {
  it('createHandler() 반환 함수가 RedisStreamPublisher.publish()를 호출한다', async () => {
    const redis = new MockRedisStream();
    const publisher = new RedisStreamPublisher(redis);
    const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const handler = new WebhookPublishHandler(publisher, idempotency);

    const fn = handler.createHandler();
    const payload: WebhookPayload = {
      eventType: 'NFT_ISSUED',
      data:      { tokenId: 'T-001', to: '0xAlice' },
      timestamp: Date.now(),
      requestId: 'req-e2e-001',
    };
    await fn(payload);

    expect(redis.store).toHaveLength(1);
    expect(redis.store[0]!.fields['eventType']).toBe('NFT_ISSUED');
    expect(redis.store[0]!.fields['requestId']).toBe('req-e2e-001');
  });

  it('동일 requestId 두 번 → Stream에 1건만 적재 (멱등성)', async () => {
    const redis = new MockRedisStream();
    const publisher = new RedisStreamPublisher(redis);
    const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const handler = new WebhookPublishHandler(publisher, idempotency);
    const fn = handler.createHandler();

    const payload: WebhookPayload = {
      eventType: 'NFT_ISSUED',
      data:      { tokenId: 'T-002', to: '0xBob' },
      timestamp: Date.now(),
      requestId: 'req-e2e-002',
    };
    await fn(payload);
    await fn(payload);

    expect(redis.store).toHaveLength(1);
  });
});

describe('S12 채점 — NFTIssuedProcessor', () => {
  it('NFT_ISSUED 처리 후 원장에 반영된다', async () => {
    const redis = new MockRedisStream();
    const ledger = new InMemoryLedgerService();
    const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const processor = new NFTIssuedProcessor(idempotency, ledger);
    const worker = new ConsumerGroupWorker(redis, [processor], makeDLQ(),
      { streamKey: 'kyobo:events', groupName: 'g', consumerId: 'c', batchSize: 10, blockMs: 0, minIdleMs: 30_000 },
    );

    await redis.xadd('kyobo:events', {
      eventType: 'NFT_ISSUED', requestId: 'req-e2e-003',
      payload: JSON.stringify({ tokenId: 'T-003', to: '0xCarol' }),
      publishedAt: String(Date.now()), _retryCount: '0',
    });

    await runWorkerUntilIdle(worker);

    expect(await ledger.getNFTBalance('0xCarol', 'T-003')).toBe(1);
    expect(redis.xackIds).toHaveLength(1);
  });

  it('동일 requestId 두 번 → 원장 1회만 반영', async () => {
    const redis = new MockRedisStream();
    const ledger = new InMemoryLedgerService();
    const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const processor = new NFTIssuedProcessor(idempotency, ledger);
    const worker = new ConsumerGroupWorker(redis, [processor], makeDLQ(),
      { streamKey: 'kyobo:events', groupName: 'g', consumerId: 'c', batchSize: 10, blockMs: 0, minIdleMs: 30_000 },
    );

    const fields = {
      eventType: 'NFT_ISSUED', requestId: 'req-e2e-004',
      payload: JSON.stringify({ tokenId: 'T-004', to: '0xDave' }),
      publishedAt: String(Date.now()), _retryCount: '0',
    };
    await redis.xadd('kyobo:events', fields);
    await redis.xadd('kyobo:events', fields);

    await runWorkerUntilIdle(worker, 120);

    expect(await ledger.getNFTBalance('0xDave', 'T-004')).toBe(1);
  });

  it('Finalized 미확정 blockNumber → 처리 보류 (원장 미반영)', async () => {
    const redis = new MockRedisStream();
    const ledger = new InMemoryLedgerService();
    const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const processor = new NFTIssuedProcessor(idempotency, ledger, {
      async getFinalizedBlockNumber() { return 18_000_000; },
    });
    const worker = new ConsumerGroupWorker(redis, [processor], makeDLQ(),
      { streamKey: 'kyobo:events', groupName: 'g', consumerId: 'c', batchSize: 10, blockMs: 0, minIdleMs: 30_000 },
    );

    await redis.xadd('kyobo:events', {
      eventType: 'NFT_ISSUED', requestId: 'req-e2e-005',
      payload: JSON.stringify({ tokenId: 'T-005', to: '0xEve', blockNumber: 18_500_001 }),
      publishedAt: String(Date.now()), _retryCount: '0',
    });

    await runWorkerUntilIdle(worker);

    expect(await ledger.getNFTBalance('0xEve', 'T-005')).toBe(0);
    // XACK 없음 — PEL 잔류 (재처리 대기)
    expect(redis.xackIds).toHaveLength(0);
  });
});

describe('S12 채점 — 전체 파이프라인 통합', () => {
  it('Webhook → Stream 적재 → Consumer 처리 → 원장 1건', async () => {
    const redis = new MockRedisStream();
    const publisher = new RedisStreamPublisher(redis);
    await publisher.initialize();

    const idempotencyWebhook  = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const idempotencyConsumer = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const ledger = new InMemoryLedgerService();

    const webhookHandler = new WebhookPublishHandler(publisher, idempotencyWebhook);
    const processor = new NFTIssuedProcessor(idempotencyConsumer, ledger);
    const worker = new ConsumerGroupWorker(redis, [processor], makeDLQ(),
      { streamKey: 'kyobo:events', groupName: 'g', consumerId: 'c', batchSize: 10, blockMs: 0, minIdleMs: 30_000 },
    );

    const fn = webhookHandler.createHandler();
    await fn({
      eventType: 'NFT_ISSUED',
      data:      { tokenId: 'T-999', to: '0xFrank' },
      timestamp: Date.now(),
      requestId: 'req-e2e-pipeline-001',
    });

    await runWorkerUntilIdle(worker);

    expect(redis.store).toHaveLength(1);
    expect(await ledger.getNFTBalance('0xFrank', 'T-999')).toBe(1);
  });

  it('동일 Webhook 2회 → Stream 1건 + 원장 1건 (전체 멱등성)', async () => {
    const redis = new MockRedisStream();
    const publisher = new RedisStreamPublisher(redis);
    const idempotencyWebhook  = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const idempotencyConsumer = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const ledger = new InMemoryLedgerService();

    const webhookHandler = new WebhookPublishHandler(publisher, idempotencyWebhook);
    const processor = new NFTIssuedProcessor(idempotencyConsumer, ledger);
    const worker = new ConsumerGroupWorker(redis, [processor], makeDLQ(),
      { streamKey: 'kyobo:events', groupName: 'g', consumerId: 'c', batchSize: 10, blockMs: 0, minIdleMs: 30_000 },
    );

    const fn = webhookHandler.createHandler();
    const payload: WebhookPayload = {
      eventType: 'NFT_ISSUED',
      data:      { tokenId: 'T-888', to: '0xGrace' },
      timestamp: Date.now(),
      requestId: 'req-e2e-pipeline-002',
    };
    await fn(payload);
    await fn(payload);  // 중복

    await runWorkerUntilIdle(worker, 120);

    expect(redis.store).toHaveLength(1);   // Stream에 1건만
    expect(await ledger.getNFTBalance('0xGrace', 'T-888')).toBe(1);  // 원장도 1번만
  });
});
