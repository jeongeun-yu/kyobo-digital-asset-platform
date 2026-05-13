import { RedisStreamPublisher, type StreamEvent } from '../stream/RedisStreamPublisher';
import { ConsumerGroupWorker, type EventProcessor, type StreamMessage } from '../stream/ConsumerGroupWorker';
import { DLQHandler } from '../stream/DLQHandler';

// ══════════════════════════════════════════════════════════════════════════
// RedisStreamPublisher 헬퍼
// ══════════════════════════════════════════════════════════════════════════

const BASE_EVENT: StreamEvent = {
  streamKey:   'kyobo:events',
  eventType:   'NFT_ISSUED',
  payload:     { tokenId: '42', owner: '0xKYOBO' },
  txHash:      '0xdeadbeef001',
  blockNumber: 18500001,
  requestId:   'req-001',
};

function makePublisherRedis() {
  const xaddCalls:         Array<{ key: string; fields: Record<string, string> }> = [];
  const xgroupCreateCalls: Array<{ key: string; group: string }>                  = [];

  return {
    xaddCalls,
    xgroupCreateCalls,
    async xadd(key: string, fields: Record<string, string>) {
      xaddCalls.push({ key, fields });
      return `${Date.now()}-0`;
    },
    async xgroupCreate(key: string, group: string) {
      xgroupCreateCalls.push({ key, group });
    },
    async ping() { return 'PONG'; },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// ConsumerGroupWorker 헬퍼
// ══════════════════════════════════════════════════════════════════════════

function makeMessage(overrides: Partial<StreamMessage['fields']> = {}): StreamMessage {
  return {
    id: `${Date.now()}-0`,
    fields: {
      eventType:   'NFT_ISSUED',
      payload:     JSON.stringify({ tokenId: '42', owner: '0xKYOBO' }),
      txHash:      '0xdeadbeef',
      blockNumber: '18500001',
      requestId:   'req-001',
      publishedAt: String(Date.now()),
      _retryCount: '0',
      ...overrides,
    },
  };
}

function makeDLQ() {
  const moveCalls: Array<{ messageId: string; reason: string }> = [];
  const dlq = new DLQHandler(
    {
      async xadd()   { return `${Date.now()}-0`; },
      async xrange() { return []; },
      async xdel()   { return 0; },
    },
    { async sendAlert() {} },
  );
  const originalMove = dlq.move.bind(dlq);
  dlq.move = async (item) => {
    moveCalls.push({ messageId: item.messageId, reason: item.reason });
    return originalMove(item);
  };
  return { dlq, moveCalls };
}

function makeWorker(options: { messages: StreamMessage[]; processor: EventProcessor; dlq?: DLQHandler }) {
  const { dlq, moveCalls } = makeDLQ();
  const xackCalls: string[] = [];
  let msgIndex = 0;

  const redis = {
    async xreadgroup() {
      if (msgIndex < options.messages.length) {
        return [{ key: 'kyobo:events', messages: [options.messages[msgIndex++]!] }];
      }
      await new Promise(r => setTimeout(r, 10));
      return [];
    },
    async xack(_key: string, _group: string, ...ids: string[]) {
      xackCalls.push(...ids);
      return ids.length;
    },
    async xautoclaim() { return { nextId: '0-0', messages: [] }; },
  };

  const worker = new ConsumerGroupWorker(
    redis, [options.processor], options.dlq ?? dlq,
    { streamKey: 'kyobo:events', groupName: 'issuer-consumers', consumerId: 'consumer-1', batchSize: 10, blockMs: 0, minIdleMs: 30_000 },
  );

  return { worker, xackCalls, moveCalls };
}

async function runWorkerUntilIdle(worker: ConsumerGroupWorker): Promise<void> {
  const p = worker.start();
  await new Promise(r => setTimeout(r, 50));
  worker.stop();
  await p;
}

// ══════════════════════════════════════════════════════════════════════════
// 테스트
// ══════════════════════════════════════════════════════════════════════════

describe('RedisStreamPublisher', () => {
  describe('initialize()', () => {
    it('xgroupCreate를 호출한다', async () => {
      const redis = makePublisherRedis();
      const publisher = new RedisStreamPublisher(redis);
      await publisher.initialize();
      expect(redis.xgroupCreateCalls).toHaveLength(1);
      expect(redis.xgroupCreateCalls[0]!.group).toBe('issuer-consumers');
    });

    it('두 번 호출해도 BUSYGROUP 에러를 무시한다', async () => {
      let callCount = 0;
      const redis = {
        ...makePublisherRedis(),
        async xgroupCreate() {
          if (++callCount === 2) throw new Error('BUSYGROUP Consumer Group name already exists');
        },
      };
      const publisher = new RedisStreamPublisher(redis);
      await publisher.initialize();
      await expect(publisher.initialize()).resolves.toBeUndefined();
    });

    it('BUSYGROUP 외 에러는 그대로 throw한다', async () => {
      const redis = {
        ...makePublisherRedis(),
        async xgroupCreate() { throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value'); },
      };
      const publisher = new RedisStreamPublisher(redis);
      await expect(publisher.initialize()).rejects.toThrow('WRONGTYPE');
    });
  });

  describe('publish()', () => {
    it('messageId를 "{timestamp}-{seq}" 형식으로 반환한다', async () => {
      const redis = makePublisherRedis();
      const publisher = new RedisStreamPublisher(redis);
      expect(await publisher.publish(BASE_EVENT)).toMatch(/^\d+-\d+$/);
    });

    it('xadd를 올바른 streamKey로 호출한다', async () => {
      const redis = makePublisherRedis();
      const publisher = new RedisStreamPublisher(redis);
      await publisher.publish(BASE_EVENT);
      expect(redis.xaddCalls[0]!.key).toBe('kyobo:events');
    });

    it('fields에 eventType, txHash, requestId가 포함된다', async () => {
      const redis = makePublisherRedis();
      const publisher = new RedisStreamPublisher(redis);
      await publisher.publish(BASE_EVENT);
      const { fields } = redis.xaddCalls[0]!;
      expect(fields['eventType']).toBe('NFT_ISSUED');
      expect(fields['txHash']).toBe('0xdeadbeef001');
      expect(fields['requestId']).toBe('req-001');
    });

    it('payload는 JSON 문자열로 직렬화된다', async () => {
      const redis = makePublisherRedis();
      const publisher = new RedisStreamPublisher(redis);
      await publisher.publish(BASE_EVENT);
      expect(JSON.parse(redis.xaddCalls[0]!.fields['payload']!)).toEqual({ tokenId: '42', owner: '0xKYOBO' });
    });

    it('blockNumber는 문자열로 저장된다', async () => {
      const redis = makePublisherRedis();
      const publisher = new RedisStreamPublisher(redis);
      await publisher.publish(BASE_EVENT);
      expect(redis.xaddCalls[0]!.fields['blockNumber']).toBe('18500001');
    });
  });

  describe('ping()', () => {
    it('Redis가 PONG 응답하면 true를 반환한다', async () => {
      const redis = makePublisherRedis();
      await expect(new RedisStreamPublisher(redis).ping()).resolves.toBe(true);
    });

    it('Redis가 throw하면 false를 반환한다', async () => {
      const redis = { ...makePublisherRedis(), async ping() { throw new Error('connection refused'); } };
      await expect(new RedisStreamPublisher(redis).ping()).resolves.toBe(false);
    });
  });
});

describe('ConsumerGroupWorker', () => {
  it('매칭 processor의 process()가 호출된다', async () => {
    const processed: StreamMessage[] = [];
    const processor: EventProcessor = {
      eventTypes: ['NFT_ISSUED'],
      async process(msg) { processed.push(msg); },
    };
    const { worker } = makeWorker({ messages: [makeMessage()], processor });
    await runWorkerUntilIdle(worker);
    expect(processed).toHaveLength(1);
    expect(processed[0]!.fields['eventType']).toBe('NFT_ISSUED');
  });

  it('처리 성공 후 xack가 호출된다', async () => {
    const msg = makeMessage();
    const processor: EventProcessor = { eventTypes: ['NFT_ISSUED'], async process() {} };
    const { worker, xackCalls } = makeWorker({ messages: [msg], processor });
    await runWorkerUntilIdle(worker);
    expect(xackCalls).toContain(msg.id);
  });

  it('등록되지 않은 eventType → processor 호출 없이 xack', async () => {
    const processCalls: StreamMessage[] = [];
    const processor: EventProcessor = {
      eventTypes: ['NFT_BURNED'],
      async process(msg) { processCalls.push(msg); },
    };
    const msg = makeMessage({ eventType: 'UNKNOWN_EVENT' });
    const { worker, xackCalls } = makeWorker({ messages: [msg], processor });
    await runWorkerUntilIdle(worker);
    expect(processCalls).toHaveLength(0);
    expect(xackCalls).toContain(msg.id);
  });

  it('_retryCount >= 3이면 DLQ로 이동하고 xack', async () => {
    const processor: EventProcessor = {
      eventTypes: ['NFT_ISSUED'],
      async process() { throw new Error('처리 실패'); },
    };
    const msg = makeMessage({ _retryCount: '3' });
    const { dlq, moveCalls } = makeDLQ();
    const { worker, xackCalls } = makeWorker({ messages: [msg], processor, dlq });
    await runWorkerUntilIdle(worker);
    expect(moveCalls).toHaveLength(1);
    expect(moveCalls[0]!.messageId).toBe(msg.id);
    expect(xackCalls).toContain(msg.id);
  });

  it('processor가 throw하면 _retryCount가 증가한다', async () => {
    let retryCount = 0;
    const processor: EventProcessor = {
      eventTypes: ['NFT_ISSUED'],
      async process(msg) {
        retryCount = parseInt(msg.fields['_retryCount'] ?? '0', 10);
        throw new Error('일시적 실패');
      },
    };
    const msg = makeMessage({ _retryCount: '1' });
    const { worker } = makeWorker({ messages: [msg], processor });
    await runWorkerUntilIdle(worker);
    expect(retryCount).toBe(1);
    expect(msg.fields['_retryCount']).toBe('2');
  });
});
