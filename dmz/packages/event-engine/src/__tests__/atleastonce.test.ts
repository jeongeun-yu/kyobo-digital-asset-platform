import { idempotentProcessor, ledger } from '../exercises/S08_atleastonce';
import { ConsumerGroupWorker, type StreamMessage } from '../dmz/ConsumerGroupWorker';
import { DLQHandler } from '../dmz/DLQHandler';

// ── Mock 헬퍼 ──────────────────────────────────────────────────────────────
const mockDLQ = new DLQHandler(
  { async xadd() { return `${Date.now()}-0`; }, async xrange() { return []; }, async xdel() { return 0; } },
  { async sendAlert() {} },
);

function makeRedis(msgs: StreamMessage[]) {
  let idx = 0;
  return {
    async xreadgroup() {
      if (idx < msgs.length) return [{ key: 'kyobo:events', messages: [msgs[idx++]!] }];
      await new Promise(r => setTimeout(r, 10));
      return [];
    },
    async xack() { return 1; },
    async xautoclaim() { return { nextId: '0-0', messages: [] }; },
  };
}

function makeMsg(requestId: string, tokenId = 'T-001'): StreamMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    fields: {
      eventType:   'NFT_ISSUED',
      payload:     JSON.stringify({ tokenId, owner: '0xKYOBO' }),
      requestId,
      publishedAt: String(Date.now()),
      _retryCount: '0',
    },
  };
}

async function run(msgs: StreamMessage[]): Promise<void> {
  const worker = new ConsumerGroupWorker(
    makeRedis(msgs), [idempotentProcessor], mockDLQ,
    { streamKey: 'kyobo:events', groupName: 'issuer-consumers', consumerId: 'c-1', batchSize: 10, blockMs: 0, minIdleMs: 30_000 },
  );
  const p = worker.start();
  await new Promise(r => setTimeout(r, 100));
  worker.stop();
  await p;
}

// ── 채점 테스트 ────────────────────────────────────────────────────────────
describe('S08 채점 — IdempotentNftProcessor', () => {
  beforeEach(() => ledger.clear());

  it('TODO: eventTypes에 NFT_ISSUED가 포함되어야 한다', () => {
    expect(idempotentProcessor.eventTypes).toContain('NFT_ISSUED');
  });

  it('TODO: NFT_ISSUED 메시지를 처리하면 원장에 반영된다', async () => {
    await run([makeMsg('req-a1')]);
    expect(ledger.get('T-001')).toBe(1);
  });

  it('TODO: 동일 requestId 메시지 2회 → 원장 1회만 반영 (멱등성)', async () => {
    const msg = makeMsg('req-a2');
    await run([msg, msg]);
    expect(ledger.get('T-001')).toBe(1);
  });

  it('TODO: 다른 requestId 메시지는 각각 별도 처리된다', async () => {
    await run([makeMsg('req-a3', 'T-002'), makeMsg('req-a4', 'T-003')]);
    expect(ledger.get('T-002')).toBe(1);
    expect(ledger.get('T-003')).toBe(1);
  });

  it('TODO: 동일 requestId 10회 반복 → 원장 정확히 1회', async () => {
    const msg = makeMsg('req-a5');
    await run(Array(10).fill(msg));
    expect(ledger.get('T-001')).toBe(1);
  });
});
