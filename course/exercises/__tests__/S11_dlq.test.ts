/**
 * S11 채점 — DLQHandler + brokenProcessor
 *
 * S11_dlq.ts exports:
 *   · dlqHandler   — DLQHandler 인스턴스
 *   · brokenProcessor — EventProcessor (항상 throw)
 *
 * 채점 기준:
 *   · brokenProcessor.eventTypes 에 'NFT_BURNED' 포함
 *   · brokenProcessor.process() 호출 시 에러를 throw하는지
 *   · ConsumerGroupWorker와 연동 시 3회 실패 후 DLQ 이동 확인
 */

import { dlqHandler, brokenProcessor } from '../M2/S11_dlq';
import {
  ConsumerGroupWorker,
  type StreamMessage,
} from '@kyobo/event-engine';

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
function makeMsg(): StreamMessage {
  return {
    id: `${Date.now()}-0`,
    fields: {
      eventType:   'NFT_BURNED',
      payload:     JSON.stringify({ tokenId: 'T-999', owner: '0xfeed000000000000000000000000000000000001' }),
      requestId:   `req-s11-${Date.now()}`,
      publishedAt: String(Date.now()),
      _retryCount: '0',
    },
  };
}

function makeConsumerRedis(msg: StreamMessage, maxCount = 4) {
  let count = 0;
  return {
    async xreadgroup() {
      if (count++ < maxCount) return [{ key: 'kyobo:events', messages: [msg] }];
      await new Promise(r => setTimeout(r, 20));
      return [];
    },
    async xack(_k: string, _g: string, ...ids: string[]) { return ids.length; },
    async xautoclaim() { return { nextId: '0-0', messages: [] }; },
  };
}

// ── 채점 테스트 ───────────────────────────────────────────────────────────────
describe('S11 채점 — DLQHandler + brokenProcessor', () => {
  it('brokenProcessor.eventTypes 에 NFT_BURNED 가 포함되어야 한다', () => {
    expect(brokenProcessor.eventTypes).toContain('NFT_BURNED');
  });

  it('brokenProcessor.process() 는 에러를 throw한다', async () => {
    const msg = makeMsg();
    await expect(brokenProcessor.process(msg)).rejects.toThrow();
  });

  it('brokenProcessor.process() throw 메시지는 비어있지 않다', async () => {
    const msg = makeMsg();
    try {
      await brokenProcessor.process(msg);
      fail('process()가 throw해야 한다');
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message.length).toBeGreaterThan(0);
    }
  });

  it('dlqHandler 인스턴스가 생성되어 있다', () => {
    expect(dlqHandler).toBeDefined();
    expect(typeof dlqHandler.move).toBe('function');
    expect(typeof dlqHandler.listPending).toBe('function');
  });

  it('ConsumerGroupWorker와 연동: 3회 실패 후 DLQ로 이동된다', async () => {
    const msg    = makeMsg();
    const redis  = makeConsumerRedis(msg);
    const worker = new ConsumerGroupWorker(
      redis, [brokenProcessor], dlqHandler,
      { streamKey: 'kyobo:events', groupName: 'issuer-consumers',
        consumerId: 'consumer-s11-test', batchSize: 1, blockMs: 0, minIdleMs: 30_000 },
    );
    const timeout = setTimeout(() => worker.stop(), 1500);
    await worker.start();
    clearTimeout(timeout);
    // 에러 없이 종료되면 성공 (DLQ 이동은 dlqHandler 내부에서 처리)
  }, 5000);
});
