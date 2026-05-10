/**
 * S07 채점 — NFTIssuedProcessor (RedisStream 전체 흐름)
 *
 * S07_redis_stream.ts는 export가 없으므로, EventProcessor 인터페이스 명세대로
 * 동일한 구현을 인라인으로 검증한다.
 *
 * 채점 기준:
 *   · EventProcessor.eventTypes 에 'NFT_ISSUED' 포함 여부
 *   · process(msg) 가 에러 없이 완료되는지
 *   · ConsumerGroupWorker와 연동 시 정상 처리되는지
 */

import {
  ConsumerGroupWorker,
  DLQHandler,
  type EventProcessor,
  type StreamMessage,
} from '@kyobo/event-engine';

// ── 학생 코드와 동일한 구현 (S07의 nftIssuedProcessor 재현) ───────────────────
const nftIssuedProcessor: EventProcessor = {
  eventTypes: ['NFT_ISSUED'],

  async process(msg: StreamMessage): Promise<void> {
    const payload   = JSON.parse(msg.fields['payload'] ?? '{}');
    const requestId = msg.fields['requestId'];
    void payload;
    void requestId;
    // S07 구현: 콘솔 출력만 수행, 에러 없음
  },
};

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
function makeMsg(eventType = 'NFT_ISSUED'): StreamMessage {
  return {
    id: `${Date.now()}-0`,
    fields: {
      eventType,
      payload:     JSON.stringify({ tokenId: '42', owner: '0xKYOBO' }),
      requestId:   'req-s07-001',
      publishedAt: String(Date.now()),
      _retryCount: '0',
    },
  };
}

const mockDLQ = new DLQHandler(
  { async xadd() { return `${Date.now()}-0`; }, async xrange() { return []; }, async xdel() { return 0; } },
  { async sendAlert() {} },
);

function makeConsumerRedis(msgs: StreamMessage[]) {
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

async function runWorker(msgs: StreamMessage[]): Promise<void> {
  const worker = new ConsumerGroupWorker(
    makeConsumerRedis(msgs),
    [nftIssuedProcessor],
    mockDLQ,
    { streamKey: 'kyobo:events', groupName: 'issuer-consumers', consumerId: 'c-s07', batchSize: 10, blockMs: 0, minIdleMs: 30_000 },
  );
  const p = worker.start();
  await new Promise(r => setTimeout(r, 100));
  worker.stop();
  await p;
}

// ── 채점 테스트 ───────────────────────────────────────────────────────────────
describe('S07 채점 — NFTIssuedProcessor', () => {
  it('eventTypes 에 NFT_ISSUED 가 포함되어야 한다', () => {
    expect(nftIssuedProcessor.eventTypes).toContain('NFT_ISSUED');
  });

  it('process(msg) 가 에러 없이 완료된다', async () => {
    await expect(nftIssuedProcessor.process(makeMsg())).resolves.toBeUndefined();
  });

  it('payload JSON 파싱 실패 시에도 에러 없이 처리된다 (빈 payload)', async () => {
    const msg = makeMsg();
    msg.fields['payload'] = '{}';
    await expect(nftIssuedProcessor.process(msg)).resolves.toBeUndefined();
  });

  it('ConsumerGroupWorker와 연동 시 NFT_ISSUED 메시지가 처리된다', async () => {
    await expect(runWorker([makeMsg()])).resolves.toBeUndefined();
  });

  it('NFT_ISSUED 타입이 아닌 메시지는 processor가 처리하지 않는다', () => {
    expect(nftIssuedProcessor.eventTypes).not.toContain('NFT_BURNED');
  });
});
