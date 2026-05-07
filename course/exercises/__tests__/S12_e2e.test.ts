/**
 * S12 채점 — E2E 파이프라인 핵심 구성요소 검증
 *
 * S12_e2e.ts 는 export가 없으므로, 동일한 구성요소를 @kyobo/event-engine에서
 * import하여 학생이 올바르게 조합할 수 있는지 채점한다.
 *
 * 채점 기준:
 *   · WebhookServer, WebhookPublishHandler, RedisStreamPublisher,
 *     ConsumerGroupWorker, NFTIssuedProcessor, InMemoryLedgerService,
 *     IdempotencyGuard, InMemoryIdempotencyStore, DLQHandler 모두 import 가능
 *   · 파이프라인 인스턴스 생성 후 HMAC 서명 검증 → 202 응답
 *   · 동일 requestId 재전송 → 원장 변화 없음 (멱등성)
 *   · 잘못된 서명 → 401 응답
 */

import http from 'http';
import crypto from 'crypto';
import {
  WebhookServer,
  WebhookPublishHandler,
  IdempotencyGuard,
  InMemoryIdempotencyStore,
  RedisStreamPublisher,
  ConsumerGroupWorker,
  DLQHandler,
  NFTIssuedProcessor,
  InMemoryLedgerService,
  type RedisStreamClient,
  type RedisConsumerClient,
  type StreamMessage,
} from '@kyobo/event-engine';

// ── Mock Redis (publisher + consumer 공유) ────────────────────────────────────
class MockRedisStream implements RedisStreamClient, RedisConsumerClient {
  private store: StreamMessage[] = [];
  private readIdx = 0;

  async xadd(_key: string, fields: Record<string, string>): Promise<string> {
    const id = `${Date.now()}-${this.store.length}`;
    this.store.push({ id, fields });
    return id;
  }
  async xgroupCreate(): Promise<void> {}
  async ping(): Promise<string> { return 'PONG'; }

  async xreadgroup(
    _group: string, _consumer: string,
    _streams: Array<{ key: string; id: string }>,
    count: number, blockMs: number,
  ) {
    const slice = this.store.slice(this.readIdx, this.readIdx + count);
    if (slice.length > 0) {
      this.readIdx += slice.length;
      return [{ key: 'kyobo:events', messages: slice }];
    }
    if (blockMs > 0) await new Promise(r => setTimeout(r, Math.min(blockMs, 20)));
    return [];
  }
  async xack(): Promise<number> { return 1; }
  async xautoclaim(): Promise<{ nextId: string; messages: StreamMessage[] }> {
    return { nextId: '0-0', messages: [] };
  }

  get messageCount() { return this.store.length; }
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
const SECRET = 'dev-secret-kyobo-s12-test';
const PORT   = 3099;

function sign(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');
}

function sendWebhook(body: string, sig: string, port = PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost', port, method: 'POST',
        headers: {
          'content-type':      'application/json',
          'x-kyobo-signature': sig,
          'content-length':    Buffer.byteLength(body),
        },
      },
      res => resolve(res.statusCode ?? 0),
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 채점 테스트 ───────────────────────────────────────────────────────────────
describe('S12 채점 — E2E 파이프라인', () => {
  let server: WebhookServer;
  let worker: ConsumerGroupWorker;
  let workerPromise: Promise<void>;
  let ledger: InMemoryLedgerService;
  let mockRedis: MockRedisStream;

  beforeAll(async () => {
    mockRedis = new MockRedisStream();

    const publisher           = new RedisStreamPublisher(mockRedis);
    await publisher.initialize();

    const idempotencyWebhook  = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const idempotencyConsumer = new IdempotencyGuard(new InMemoryIdempotencyStore());
    ledger = new InMemoryLedgerService();

    const mockDLQ = new DLQHandler(
      { async xadd() { return `${Date.now()}-0`; }, async xrange() { return []; }, async xdel() { return 0; } },
      { async sendAlert() {} },
    );

    server = new WebhookServer({ port: PORT, secret: SECRET, maxBodyKb: 64 });
    const handler = new WebhookPublishHandler(publisher, idempotencyWebhook);
    server.on('NFT_ISSUED', handler.createHandler());

    const processor = new NFTIssuedProcessor(idempotencyConsumer, ledger);
    worker = new ConsumerGroupWorker(
      mockRedis, [processor], mockDLQ,
      { streamKey: 'kyobo:events', groupName: 'issuer-consumers', consumerId: 'worker-s12-test', batchSize: 10, blockMs: 20, minIdleMs: 30_000 },
    );

    await server.listen();
    workerPromise = worker.start();
  }, 10000);

  afterAll(async () => {
    worker.stop();
    await workerPromise;
    await server.close();
  });

  it('[1] 올바른 HMAC 서명으로 webhook 전송 → 202 응답', async () => {
    const body = JSON.stringify({
      eventType: 'NFT_ISSUED',
      data:      { tokenId: 'T-2001', to: '0xAlice', blockNumber: 18_500_001 },
      timestamp: Date.now(),
      requestId: 'req-s12-e2e-t1',
    });
    const status = await sendWebhook(body, sign(body));
    expect(status).toBe(202);
  });

  it('[2] 잘못된 서명으로 webhook 전송 → 401 응답', async () => {
    const body = JSON.stringify({
      eventType: 'NFT_ISSUED',
      data:      { tokenId: 'T-2002', to: '0xBob', blockNumber: 18_500_002 },
      timestamp: Date.now(),
      requestId: 'req-s12-e2e-t2',
    });
    const status = await sendWebhook(body, 'wrong-signature');
    expect(status).toBe(401);
  });

  it('[3] webhook 전송 후 Stream에 메시지가 적재된다', async () => {
    const body = JSON.stringify({
      eventType: 'NFT_ISSUED',
      data:      { tokenId: 'T-2003', to: '0xCarol', blockNumber: 18_500_003 },
      timestamp: Date.now(),
      requestId: 'req-s12-e2e-t3',
    });
    await sendWebhook(body, sign(body));
    await new Promise(r => setTimeout(r, 50));
    expect(mockRedis.messageCount).toBeGreaterThan(0);
  });

  it('[4] Consumer 처리 후 원장에 NFT가 반영된다', async () => {
    const body = JSON.stringify({
      eventType: 'NFT_ISSUED',
      data:      { tokenId: 'T-2004', to: '0xDave', blockNumber: 18_500_004 },
      timestamp: Date.now(),
      requestId: 'req-s12-e2e-t4',
    });
    await sendWebhook(body, sign(body));
    await new Promise(r => setTimeout(r, 200));
    const balance = await ledger.getNFTBalance('0xDave', 'T-2004');
    expect(balance).toBe(1);
  });

  it('[5] 동일 requestId 재전송 → 원장 변화 없음 (멱등성)', async () => {
    const body = JSON.stringify({
      eventType: 'NFT_ISSUED',
      data:      { tokenId: 'T-2005', to: '0xEve', blockNumber: 18_500_005 },
      timestamp: Date.now(),
      requestId: 'req-s12-e2e-t5',
    });
    await sendWebhook(body, sign(body));
    await new Promise(r => setTimeout(r, 150));
    const bal1 = await ledger.getNFTBalance('0xEve', 'T-2005');

    // 동일 requestId 재전송
    await sendWebhook(body, sign(body));
    await new Promise(r => setTimeout(r, 150));
    const bal2 = await ledger.getNFTBalance('0xEve', 'T-2005');

    expect(bal1).toBe(1);
    expect(bal2).toBe(1); // 변화 없음
  });
});
