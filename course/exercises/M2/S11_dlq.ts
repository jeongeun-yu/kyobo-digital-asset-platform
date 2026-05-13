/**
 * S11 실습 — Dead Letter Queue 운영 패턴 관찰
 *
 * 실행 방법: npm run exercise:s11
 *
 * 아래 실험 변수를 바꾸고 실행하면서 출력이 어떻게 달라지는지 확인하세요.
 * 각 실험의 의미는 실습 가이드(M2_S11_dlq_design.md)를 참고하세요.
 */

// ══════════════════════════════════════════════════════════════════
//  실험 변수 — 여기 값을 바꿔가며 실행해보세요
// ══════════════════════════════════════════════════════════════════

/** 실험 1: DLQ 이동까지 최대 재시도 횟수 (1, 2, 3 으로 바꿔보세요) */
const MAX_RETRIES = 3;

/** 실험 2: 재큐잉할 항목 수 ('first' 또는 'all' 로 바꿔보세요) */
const REQUEUE_MODE: 'first' | 'all' = 'first';

// ══════════════════════════════════════════════════════════════════
//  아래는 수정하지 않아도 됩니다
// ══════════════════════════════════════════════════════════════════

process.env['LOG_LEVEL'] = 'error';

import { ConsumerGroupWorker, DLQHandler, type EventProcessor, type StreamMessage } from '@kyobo/event-engine';

// ── Mock Redis (DLQ용 인메모리) ──────────────────────────────────
const dlqStore: Map<string, Array<{ id: string; fields: Record<string, string> }>> = new Map();
function getStream(key: string) {
  if (!dlqStore.has(key)) dlqStore.set(key, []);
  return dlqStore.get(key)!;
}

const dlqRedis = {
  async xadd(key: string, fields: Record<string, string>): Promise<string> {
    const id = `${Date.now()}-0`;
    getStream(key).push({ id, fields });
    return id;
  },
  async xrange(key: string, start: string, end: string, count?: number) {
    const stream = getStream(key);
    if (start !== '-' && start === end) return stream.filter(i => i.id === start);
    return stream.slice(0, count ?? stream.length);
  },
  async xdel(key: string, ...ids: string[]): Promise<number> {
    const stream = getStream(key);
    let removed = 0;
    for (const id of ids) {
      const idx = stream.findIndex(i => i.id === id);
      if (idx !== -1) { stream.splice(idx, 1); removed++; }
    }
    return removed;
  },
};

// ── Consumer Mock ────────────────────────────────────────────────
function makeConsumerRedis(msg: StreamMessage) {
  let count = 0;
  return {
    async xreadgroup() {
      if (count++ < MAX_RETRIES + 1) return [{ key: 'kyobo:events', messages: [msg] }];
      await new Promise(r => setTimeout(r, 30));
      return [];
    },
    async xack(_k: string, _g: string, ...ids: string[]) { return ids.length; },
    async xautoclaim() { return { nextId: '0-0', messages: [] }; },
  };
}

// ── 항상 실패하는 Processor ──────────────────────────────────────
const brokenProcessor: EventProcessor = {
  eventTypes: ['NFT_BURNED'],
  async process(): Promise<void> { throw new Error('DB connection failed'); },
};

// ── DLQ 운영 절차 ────────────────────────────────────────────────
async function runOperatorWorkflow(dlqHandler: DLQHandler): Promise<void> {
  const LINE = '─'.repeat(52);
  console.log('\n' + LINE);
  console.log('  Part 2 — 운영자 DLQ 처리 절차');
  console.log(LINE);

  const pending = await dlqHandler.listPending();
  console.log(`\n  DLQ 항목 수: ${pending.length}`);
  for (const item of pending) {
    console.log(`    ${item.event['eventType']} | ${item.reason}`);
  }

  if (pending.length === 0) { console.log('  (DLQ 비어 있음)'); return; }

  const toRequeue = REQUEUE_MODE === 'all' ? pending : [pending[0]!];
  console.log(`\n  REQUEUE_MODE = '${REQUEUE_MODE}' → ${toRequeue.length}건 재큐잉`);
  for (const item of toRequeue) {
    await dlqHandler.requeueMessage(item.messageId);
  }

  const after = await dlqHandler.listPending();
  const reduced = pending.length - after.length;
  console.log(`\n  재큐잉 후 DLQ 항목 수: ${after.length}`);
  console.log(`  ${reduced === toRequeue.length ? '✅' : '❌'} ${reduced}건 감소 (기대: ${toRequeue.length})`);
}

// ── 실험 실행 ────────────────────────────────────────────────────
(async () => {
  const LINE = '─'.repeat(52);
  console.log('\n' + LINE);
  console.log('  S11 실습 — DLQ 운영 패턴 관찰');
  console.log(LINE);
  console.log(`  MAX_RETRIES  = ${MAX_RETRIES}`);
  console.log(`  REQUEUE_MODE = '${REQUEUE_MODE}'`);
  console.log(LINE);
  console.log('\n  Part 1 — 실패 반복 → DLQ 이동\n');

  const dlqHandler = new DLQHandler(dlqRedis, { async sendAlert() {} }, 'kyobo:events');

  const msg: StreamMessage = {
    id: `${Date.now()}-0`,
    fields: {
      eventType: 'NFT_BURNED', payload: JSON.stringify({ tokenId: 'T-999' }),
      requestId: 'req-s11-001', publishedAt: String(Date.now()), _retryCount: '0',
    },
  };

  const redis  = makeConsumerRedis(msg);
  const worker = new ConsumerGroupWorker(
    redis, [brokenProcessor], dlqHandler,
    { streamKey: 'kyobo:events', groupName: 'issuer-consumers',
      consumerId: 'consumer-s11', batchSize: 1, blockMs: 0, minIdleMs: 30_000 },
  );
  const timeout = setTimeout(() => worker.stop(), 3000);
  await worker.start();
  clearTimeout(timeout);

  const dlqStream = getStream('kyobo:events:dlq');
  console.log(`  DLQ 항목 수: ${dlqStream.length}`);
  console.log(`  ${dlqStream.length >= 1 ? '✅' : '❌'} DLQ 이동 확인`);

  await runOperatorWorkflow(dlqHandler);

  console.log('\n' + LINE + '\n');
  console.log('[ 다음 실험을 해보세요 ]');
  console.log(`  1. MAX_RETRIES = 1 → 1회 실패만으로 DLQ 이동`);
  console.log(`  2. MAX_RETRIES = 2 → 2회 실패 후 DLQ 이동`);
  console.log(`  3. REQUEUE_MODE = 'all' → 전체 재큐잉\n`);
})();
