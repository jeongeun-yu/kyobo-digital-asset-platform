/**
 * S12 실습 — 이벤트 파이프라인 E2E 관찰
 *
 * 실행 방법: npm run exercise:s12
 *
 * 아래 실험 변수를 바꾸고 실행하면서 출력이 어떻게 달라지는지 확인하세요.
 * 각 실험의 의미는 실습 가이드(M2_S12_finalized_e2e.md)를 참고하세요.
 *
 * 파이프라인:
 *   VASP → WebhookServer(HMAC) → WebhookPublishHandler(멱등성)
 *       → RedisStream(XADD) → ConsumerGroupWorker(XREADGROUP)
 *       → NFTIssuedProcessor → InMemoryLedger → XACK
 */

// ══════════════════════════════════════════════════════════════════
//  실험 변수 — 여기 값을 바꿔가며 실행해보세요
// ══════════════════════════════════════════════════════════════════

/** 실험 1: 같은 requestId로 두 번 보낼까요? (false → true) */
const SEND_DUPLICATE = false;

/** 실험 2: 잘못된 서명으로 보낼까요? (false → true) */
const SEND_BAD_SIG = false;

// ══════════════════════════════════════════════════════════════════
//  아래는 수정하지 않아도 됩니다
// ══════════════════════════════════════════════════════════════════

process.env['LOG_LEVEL'] = 'error';

import http from 'http';
import crypto from 'crypto';

import {
  WebhookServer, WebhookPublishHandler, IdempotencyGuard, InMemoryIdempotencyStore,
  RedisStreamPublisher, ConsumerGroupWorker, DLQHandler, NFTIssuedProcessor, InMemoryLedgerService,
  type RedisStreamClient, type RedisConsumerClient, type StreamMessage,
} from '@kyobo/event-engine';

// ── Mock Redis (메모리 스트림) ────────────────────────────────────
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
    if (slice.length > 0) { this.readIdx += slice.length; return [{ key: 'kyobo:events', messages: slice }]; }
    if (blockMs > 0) await new Promise(r => setTimeout(r, Math.min(blockMs, 30)));
    return [];
  }
  async xack(): Promise<number> { return 1; }
  async xautoclaim(): Promise<{ nextId: string; messages: StreamMessage[] }> {
    return { nextId: '0-0', messages: [] };
  }

  get messageCount() { return this.store.length; }
}

// ── 헬퍼 ─────────────────────────────────────────────────────────
const SECRET = 'dev-secret-kyobo-s12';
const PORT   = 3012;

function sign(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');
}

function sendWebhook(body: string, sig: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port: PORT, method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kyobo-signature': sig,
                   'content-length': Buffer.byteLength(body) } },
      res => resolve(res.statusCode ?? 0),
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function result(label: string, pass: boolean): void {
  console.log(`  ${pass ? '✅' : '❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ── 실험 실행 ────────────────────────────────────────────────────
(async () => {
  const LINE = '─'.repeat(52);
  console.log('\n' + LINE);
  console.log('  S12 실습 — 이벤트 파이프라인 E2E 관찰');
  console.log(LINE);
  console.log(`  SEND_DUPLICATE = ${SEND_DUPLICATE}`);
  console.log(`  SEND_BAD_SIG   = ${SEND_BAD_SIG}`);
  console.log(LINE + '\n');

  const mockRedis           = new MockRedisStream();
  const publisher           = new RedisStreamPublisher(mockRedis);
  await publisher.initialize();
  const idempotencyWebhook  = new IdempotencyGuard(new InMemoryIdempotencyStore());
  const idempotencyConsumer = new IdempotencyGuard(new InMemoryIdempotencyStore());
  const ledger              = new InMemoryLedgerService();
  const mockDLQ             = new DLQHandler(
    { async xadd() { return `${Date.now()}-0`; }, async xrange() { return []; }, async xdel() { return 0; } },
    { async sendAlert() {} },
  );

  const server  = new WebhookServer({ port: PORT, secret: SECRET, maxBodyKb: 64 });
  const handler = new WebhookPublishHandler(publisher, idempotencyWebhook);
  server.on('NFT_ISSUED', handler.createHandler());

  const processor = new NFTIssuedProcessor(idempotencyConsumer, ledger);
  const worker    = new ConsumerGroupWorker(
    mockRedis, [processor], mockDLQ,
    { streamKey: 'kyobo:events', groupName: 'issuer-consumers',
      consumerId: 'worker-s12', batchSize: 10, blockMs: 30, minIdleMs: 30_000 },
  );

  await server.listen();
  const workerPromise = worker.start();

  const BODY = JSON.stringify({
    eventType: 'NFT_ISSUED',
    data:      { tokenId: 'T-1001', to: '0xAlice', blockNumber: 18_500_001 },
    timestamp: Date.now(),
    requestId: 'req-s12-e2e-001',
  });

  // ── [1] 정상 Webhook ─────────────────────────────────────────────
  console.log('[1] 정상 Webhook');
  const status1 = await sendWebhook(BODY, sign(BODY));
  result(`HTTP ${status1} (기대: 202)`, status1 === 202);
  await new Promise(r => setTimeout(r, 150));

  // ── [2] Stream 적재 ──────────────────────────────────────────────
  console.log('\n[2] Stream 적재');
  result(`${mockRedis.messageCount}건 (기대: 1)`, mockRedis.messageCount === 1);

  // ── [3] Consumer → 원장 ──────────────────────────────────────────
  console.log('\n[3] Consumer → 원장');
  const balance1 = await ledger.getNFTBalance('0xAlice', 'T-1001');
  result(`0xAlice T-1001 잔고: ${balance1} (기대: 1)`, balance1 === 1);

  // ── [4] 중복 전송 ────────────────────────────────────────────────
  if (SEND_DUPLICATE) {
    console.log('\n[4] 중복 전송 (멱등성)');
    const status2 = await sendWebhook(BODY, sign(BODY));
    result(`HTTP ${status2} (기대: 202)`, status2 === 202);
    await new Promise(r => setTimeout(r, 150));
    const balance2 = await ledger.getNFTBalance('0xAlice', 'T-1001');
    result(`Stream ${mockRedis.messageCount}건 (기대: 1)`, mockRedis.messageCount === 1);
    result(`잔고: ${balance2} (기대: 1)`,                  balance2 === 1);
  }

  // ── [5] 잘못된 서명 ──────────────────────────────────────────────
  if (SEND_BAD_SIG) {
    console.log('\n[5] 잘못된 서명');
    const status3 = await sendWebhook(BODY, 'wrong-signature');
    result(`HTTP ${status3} (기대: 401)`, status3 === 401);
  }

  worker.stop();
  await workerPromise;
  await server.close();

  console.log('\n' + LINE);
  console.log(process.exitCode ? '  ❌ 일부 검증 실패' : '  ✅ 전체 통과');
  console.log(LINE + '\n');
})();
