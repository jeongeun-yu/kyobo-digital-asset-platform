import { _handleWithRetry } from '../exercises/S09_handle_with_retry';
import { type EventProcessor, type StreamMessage, type RedisConsumerClient } from '../dmz/ConsumerGroupWorker';
import { DLQHandler } from '../dmz/DLQHandler';

// ── Mock 헬퍼 ──────────────────────────────────────────────────────────────
function makeMsg(overrides: Partial<StreamMessage['fields']> = {}): StreamMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    fields: {
      eventType:   'NFT_ISSUED',
      payload:     JSON.stringify({ tokenId: 'T-001' }),
      requestId:   'req-001',
      publishedAt: String(Date.now()),
      _retryCount: '0',
      ...overrides,
    },
  };
}

function makeRedis() {
  const xackIds: string[] = [];
  const redis: Pick<RedisConsumerClient, 'xack'> = {
    async xack(_k, _g, ...ids) { xackIds.push(...ids); return ids.length; },
  };
  return { redis, xackIds };
}

function makeDLQ() {
  const movedIds: string[] = [];
  const dlq = new DLQHandler(
    { async xadd() { return `${Date.now()}-0`; }, async xrange() { return []; }, async xdel() { return 0; } },
    { async sendAlert() {} },
  );
  const orig = dlq.move.bind(dlq);
  dlq.move = async (item) => { movedIds.push(item.messageId); return orig(item); };
  return { dlq, movedIds };
}

const successProcessor: EventProcessor = {
  eventTypes: ['NFT_ISSUED'],
  async process() {},
};

const failProcessor: EventProcessor = {
  eventTypes: ['NFT_ISSUED'],
  async process() { throw new Error('일시적 오류'); },
};

// ── 채점 테스트 ────────────────────────────────────────────────────────────
describe('S09 채점 — _handleWithRetry', () => {
  it('TODO 1: retryCount >= 3 → DLQ 이동 + XACK', async () => {
    const { redis, xackIds } = makeRedis();
    const { dlq, movedIds } = makeDLQ();
    const msg = makeMsg({ _retryCount: '3' });

    await _handleWithRetry(msg, [successProcessor], redis, dlq);

    expect(movedIds).toHaveLength(1);
    expect(xackIds).toHaveLength(1);
  });

  it('TODO 1: DLQ 이동 후 process()는 호출되지 않는다', async () => {
    const { redis } = makeRedis();
    const { dlq } = makeDLQ();
    const processed: string[] = [];
    const processor: EventProcessor = {
      eventTypes: ['NFT_ISSUED'],
      async process(msg) { processed.push(msg.id); },
    };
    const msg = makeMsg({ _retryCount: '3' });

    await _handleWithRetry(msg, [processor], redis, dlq);

    expect(processed).toHaveLength(0);
  });

  it('TODO 2: 매칭 processor 없음 → XACK (processor 호출 없음)', async () => {
    const { redis, xackIds } = makeRedis();
    const { dlq } = makeDLQ();
    const processed: string[] = [];
    const processor: EventProcessor = {
      eventTypes: ['NFT_ISSUED'],
      async process(msg) { processed.push(msg.id); },
    };
    const msg = makeMsg({ eventType: 'UNKNOWN_EVENT' });

    await _handleWithRetry(msg, [processor], redis, dlq);

    expect(xackIds).toHaveLength(1);
    expect(processed).toHaveLength(0);
  });

  it('TODO 3: 처리 성공 → XACK', async () => {
    const { redis, xackIds } = makeRedis();
    const { dlq } = makeDLQ();

    await _handleWithRetry(makeMsg(), [successProcessor], redis, dlq);

    expect(xackIds).toHaveLength(1);
  });

  it('TODO 4: 처리 실패 → _retryCount + 1, XACK 없음', async () => {
    const { redis, xackIds } = makeRedis();
    const { dlq } = makeDLQ();
    const msg = makeMsg({ _retryCount: '1' });

    await _handleWithRetry(msg, [failProcessor], redis, dlq);

    expect(msg.fields['_retryCount']).toBe('2');
    expect(xackIds).toHaveLength(0);
  });

  it('TODO 4: retryCount 0 → 실패 시 1로 증가', async () => {
    const { redis } = makeRedis();
    const { dlq } = makeDLQ();
    const msg = makeMsg({ _retryCount: '0' });

    await _handleWithRetry(msg, [failProcessor], redis, dlq);

    expect(msg.fields['_retryCount']).toBe('1');
  });
});
