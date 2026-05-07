/**
 * S12 실습 — M2 DMZ 이벤트 파이프라인 E2E 검증
 *
 * 강의 노트: M2_S12_finalized_e2e.md
 *
 * 실행 방법 (dmz/packages/event-engine 폴더에서):
 *   npx ts-node src/exercises/S12_e2e.ts
 *
 * 목표:
 *   Mock Redis + Mock LedgerService로 전체 파이프라인을 로컬에서 완주한다.
 *
 *   VASP → WebhookServer(HMAC) → WebhookPublishHandler(멱등성)
 *       → RedisStreamPublisher(XADD) → [Mock Stream]
 *       → ConsumerGroupWorker(XREADGROUP) → NFTIssuedProcessor
 *       → InMemoryLedgerService → XACK
 *
 * 완료 기준:
 *   [1] Webhook 전송 → 202 응답
 *   [2] Stream에 메시지 1건 적재
 *   [3] Consumer 처리 후 원장에 NFT 1건 반영
 *   [4] 동일 requestId 재전송 → 원장 변화 없음 (멱등성)
 *   [5] 잘못된 서명 → 401
 */

import http from 'http';
import crypto from 'crypto';

import {
  WebhookServer, WebhookPublishHandler, IdempotencyGuard, InMemoryIdempotencyStore,
  RedisStreamPublisher, ConsumerGroupWorker, DLQHandler, NFTIssuedProcessor, InMemoryLedgerService,
  type RedisStreamClient, type RedisConsumerClient, type StreamMessage,
} from '@kyobo/event-engine';

// ────────────────────────────────────────────────────────────────────────
// Mock Redis — publisher + consumer 공유 (메모리 스트림)
// ────────────────────────────────────────────────────────────────────────

class MockRedisStream implements RedisStreamClient, RedisConsumerClient {
  private store: StreamMessage[] = [];
  private readIdx = 0;

  // RedisStreamClient
  async xadd(_key: string, fields: Record<string, string>): Promise<string> {
    const id = `${Date.now()}-${this.store.length}`;
    this.store.push({ id, fields });
    console.log(`  [XADD] → ${id} | eventType=${fields['eventType']}`);
    return id;
  }
  async xgroupCreate(): Promise<void> {}
  async ping(): Promise<string> { return 'PONG'; }

  // RedisConsumerClient
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
    if (blockMs > 0) await new Promise(r => setTimeout(r, Math.min(blockMs, 30)));
    return [];
  }
  async xack(): Promise<number> {
    console.log('  [XACK] 처리 완료');
    return 1;
  }
  async xautoclaim(): Promise<{ nextId: string; messages: StreamMessage[] }> {
    return { nextId: '0-0', messages: [] };
  }

  get messageCount() { return this.store.length; }
}

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

const SECRET = 'dev-secret-kyobo-s12';
const PORT   = 3012;

function sign(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');
}

function sendWebhook(body: string, sig: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost', port: PORT, method: 'POST',
        headers: {
          'content-type':       'application/json',
          'x-kyobo-signature':  sig,
          'content-length':     Buffer.byteLength(body),
        },
      },
      res => resolve(res.statusCode ?? 0),
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S12 E2E: DMZ 이벤트 파이프라인 완주 ===\n');

  // ── 인프라 인스턴스 생성 ──────────────────────────────────────────────

  const mockRedis = new MockRedisStream();

  const publisher  = new RedisStreamPublisher(mockRedis);
  await publisher.initialize();

  const idempotencyWebhook  = new IdempotencyGuard(new InMemoryIdempotencyStore());
  const idempotencyConsumer = new IdempotencyGuard(new InMemoryIdempotencyStore());

  const ledger = new InMemoryLedgerService();

  const mockDLQ = new DLQHandler(
    { async xadd() { return `${Date.now()}-0`; }, async xrange() { return []; }, async xdel() { return 0; } },
    { async sendAlert(msg) { console.log('  [DLQ ALERT]', msg.split('\n')[0]); } },
  );

  // ── 실습 1: WebhookPublishHandler를 생성하고 server에 등록하라 ──────────
  const server  = new WebhookServer({ port: PORT, secret: SECRET, maxBodyKb: 64 });
  const handler = new WebhookPublishHandler(publisher, idempotencyWebhook);
  server.on('NFT_ISSUED', handler.createHandler());

  // ── 실습 2: NFTIssuedProcessor 인스턴스를 생성하라 ───────────────────
  const processor = new NFTIssuedProcessor(idempotencyConsumer, ledger);

  // ── 실습 3: ConsumerGroupWorker 인스턴스를 생성하라 ──────────────────
  const worker = new ConsumerGroupWorker(
    mockRedis, [processor], mockDLQ,
    { streamKey: 'kyobo:events', groupName: 'issuer-consumers', consumerId: 'worker-s12', batchSize: 10, blockMs: 30, minIdleMs: 30_000 },
  );

  // ── 서버 + Worker 시작 ────────────────────────────────────────────────
  await server.listen();
  console.log(`[server] WebhookServer :${PORT} 시작\n`);

  const workerPromise = worker.start();

  // ── [1] 정상 서명 → 202 ───────────────────────────────────────────────
  console.log('[검증 1] 올바른 서명 → 202');
  const BODY = JSON.stringify({
    eventType: 'NFT_ISSUED',
    data:      { tokenId: 'T-1001', to: '0xAlice', blockNumber: 18_500_001 },
    timestamp: Date.now(),
    requestId: 'req-s12-e2e-001',
  });
  const status1 = await sendWebhook(BODY, sign(BODY));
  check(`HTTP 상태: ${status1} (기대: 202)`, status1 === 202);

  await new Promise(r => setTimeout(r, 80));

  // ── [2] Stream 적재 확인 ─────────────────────────────────────────────
  console.log('\n[검증 2] Stream 메시지 1건 적재');
  check(`Stream 메시지 수: ${mockRedis.messageCount} (기대: 1)`, mockRedis.messageCount === 1);

  // ── [3] Consumer 처리 → 원장 확인 ───────────────────────────────────
  await new Promise(r => setTimeout(r, 100));
  console.log('\n[검증 3] Consumer 처리 후 원장 업데이트');
  const balance1 = await ledger.getNFTBalance('0xAlice', 'T-1001');
  check(`0xAlice T-1001 잔고: ${balance1} (기대: 1)`, balance1 === 1);

  // ── [4] 동일 requestId 재전송 → 멱등성 ───────────────────────────────
  console.log('\n[검증 4] 동일 requestId 재전송 → 원장 변화 없음');

  // ── 실습 4: 동일 BODY(동일 requestId)를 한 번 더 전송하라 ────────────
  const status2 = await sendWebhook(BODY, sign(BODY));
  check(`HTTP 상태: ${status2} (기대: 202)`, status2 === 202);

  await new Promise(r => setTimeout(r, 150));

  const balance2 = await ledger.getNFTBalance('0xAlice', 'T-1001');
  check(`0xAlice T-1001 잔고: ${balance2} (기대: 여전히 1)`, balance2 === 1);

  // ── [5] 잘못된 서명 → 401 ────────────────────────────────────────────
  console.log('\n[검증 5] 잘못된 서명 → 401');

  // ── 실습 5: 잘못된 서명으로 요청을 전송하고 상태 코드를 확인하라 ────────
  const status3 = await sendWebhook(BODY, 'wrong-signature');
  check(`HTTP 상태: ${status3} (기대: 401)`, status3 === 401);

  // ── 정리 ─────────────────────────────────────────────────────────────
  worker.stop();
  await workerPromise;
  await server.close();

  console.log('\n=== S12 E2E 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
})();
