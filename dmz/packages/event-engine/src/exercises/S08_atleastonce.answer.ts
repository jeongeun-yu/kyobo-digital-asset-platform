/**
 * S08 답안 — At-least-once + 멱등성 구현
 *
 * 강의 노트: M2_S8_atleastonce_design.md
 */

import { ConsumerGroupWorker, type EventProcessor, type StreamMessage } from '../dmz/ConsumerGroupWorker';
import { DLQHandler } from '../dmz/DLQHandler';

const ledger: Map<string, number> = new Map();

function credit(tokenId: string, owner: string): void {
  const prev = ledger.get(tokenId) ?? 0;
  ledger.set(tokenId, prev + 1);
  console.log(`    [원장] ${tokenId} → ${owner} | 누적 처리 횟수: ${prev + 1}`);
}

const naiveProcessor: EventProcessor = {
  eventTypes: ['NFT_ISSUED'],
  async process(msg: StreamMessage): Promise<void> {
    const { tokenId, owner } = JSON.parse(msg.fields['payload'] ?? '{}');
    credit(tokenId, owner);
  },
};

// Part 2 답안
const processedIds = new Set<string>();

const idempotentProcessor: EventProcessor = {
  eventTypes: ['NFT_ISSUED'],

  async process(msg: StreamMessage): Promise<void> {
    const requestId = msg.fields['requestId'] ?? '';

    if (processedIds.has(requestId)) {
      console.log(`    [멱등성] 중복 요청 무시: ${requestId}`);
      return;
    }

    const { tokenId, owner } = JSON.parse(msg.fields['payload'] ?? '{}');
    credit(tokenId, owner);
    processedIds.add(requestId);
  },
};

const mockDLQ = new DLQHandler(
  { async xadd() { return `${Date.now()}-0`; }, async xrange() { return []; }, async xdel() { return 0; } },
  { async sendAlert() {} },
);

function makeRedis(msgs: StreamMessage[]) {
  let idx = 0;
  return {
    async xreadgroup() {
      if (idx < msgs.length) {
        return [{ key: 'kyobo:events', messages: [msgs[idx++]!] }];
      }
      await new Promise(r => setTimeout(r, 10));
      return [];
    },
    async xack(_k: string, _g: string, ...ids: string[]) {
      console.log(`    [XACK] ${ids.join(', ')}`);
      return ids.length;
    },
    async xautoclaim() { return { nextId: '0-0', messages: [] }; },
  };
}

const SAMPLE_MSG: StreamMessage = {
  id: `${Date.now()}-0`,
  fields: {
    eventType:   'NFT_ISSUED',
    payload:     JSON.stringify({ tokenId: 'T-001', owner: '0xKYOBO' }),
    requestId:   'req-dup-001',
    publishedAt: String(Date.now()),
    _retryCount: '0',
  },
};

async function runScenario(processor: EventProcessor): Promise<void> {
  ledger.clear();
  const worker = new ConsumerGroupWorker(
    makeRedis([SAMPLE_MSG, SAMPLE_MSG]),
    [processor],
    mockDLQ,
    { streamKey: 'kyobo:events', groupName: 'issuer-consumers', consumerId: 'consumer-1', batchSize: 10, blockMs: 0, minIdleMs: 30_000 },
  );
  const p = worker.start();
  await new Promise(r => setTimeout(r, 100));
  worker.stop();
  await p;

  const count = ledger.get('T-001') ?? 0;
  console.log(`  → 최종 원장 처리 횟수: ${count} ${count === 1 ? '✅ 정상' : '❌ 중복 발행!'}\n`);
}

(async () => {
  console.log('=== S08 실습: At-least-once + 멱등성 ===\n');

  console.log('[ Part 1 ] 멱등성 없음 — 동일 메시지 2회 전달');
  await runScenario(naiveProcessor);

  console.log('[ Part 2 ] 멱등성 적용 — 동일 메시지 2회 전달');
  await runScenario(idempotentProcessor);
})();
