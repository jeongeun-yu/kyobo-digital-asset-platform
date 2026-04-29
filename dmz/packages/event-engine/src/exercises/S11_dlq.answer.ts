/**
 * S11 답안 — Dead Letter Queue 운영 패턴
 * 강의 노트: M2_S11_dlq_design.md
 */

import { ConsumerGroupWorker, type EventProcessor, type StreamMessage } from '../dmz/ConsumerGroupWorker';
import { DLQHandler, type DLQItem } from '../dmz/DLQHandler';

const dlqStore: Array<{ id: string; fields: Record<string, string> }> = [];

const dlqRedis = {
  async xadd(key: string, fields: Record<string, string>): Promise<string> {
    const id = `${Date.now()}-0`;
    dlqStore.push({ id, fields });
    console.log(`[DLQ XADD] ${key} → ${id}`);
    return id;
  },
  async xrange(key: string, start: string, end: string, count?: number) {
    const items = dlqStore.slice(0, count ?? dlqStore.length);
    if (start !== '-' && start === end) {
      return dlqStore.filter(i => i.id === start);
    }
    return items;
  },
  async xdel(key: string, ...ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      const idx = dlqStore.findIndex(i => i.id === id);
      if (idx !== -1) { dlqStore.splice(idx, 1); count++; }
    }
    return count;
  },
};

const dlqNotifier = {
  async sendAlert(msg: string): Promise<void> {
    console.log('[DLQ ALERT]', msg.split('\n')[0]);
  },
};

// TODO 1 답안
export const dlqHandler = new DLQHandler(dlqRedis, dlqNotifier, 'kyobo:events');

// TODO 2 답안
export const brokenProcessor: EventProcessor = {
  eventTypes: ['NFT_BURNED'],
  async process(_msg: StreamMessage): Promise<void> {
    throw new Error('DB connection failed');
  },
};

function makeConsumerRedis(msg: StreamMessage) {
  let count = 0;
  return {
    async xreadgroup() {
      if (count++ < 4) {
        return [{ key: 'kyobo:events', messages: [msg] }];
      }
      await new Promise(r => setTimeout(r, 50));
      return [];
    },
    async xack(_k: string, _g: string, ...ids: string[]) {
      console.log(`[XACK] ${ids.join(', ')}`);
      return ids.length;
    },
    async xautoclaim() { return { nextId: '0-0', messages: [] }; },
  };
}

async function runOperatorWorkflow(): Promise<void> {
  console.log('\n=== Part 2: 운영자 DLQ 처리 절차 ===\n');

  // TODO 3 답안
  const pending: DLQItem[] = await dlqHandler.listPending();

  console.log(`[listPending] DLQ 항목 수: ${pending.length}`);
  for (const item of pending) {
    console.log(`  - ${item.messageId} | ${item.event['eventType']} | ${item.reason}`);
  }

  if (pending.length === 0) {
    console.log('[skip] DLQ가 비어 있어 재큐잉 스킵');
    return;
  }

  // TODO 4 답안
  const first = pending[0]!;
  const result = await dlqHandler.requeueMessage(first.messageId);

  console.log(`[requeue] 재큐잉 완료: ${result.newMessageId}`);

  // TODO 5 답안
  const afterRequeue: DLQItem[] = await dlqHandler.listPending();
  console.log(`[listPending after requeue] DLQ 항목 수: ${afterRequeue.length}`);
  console.log(pending.length - afterRequeue.length === 1 ? '✅ 재큐잉 후 항목 1개 감소' : '❌ 항목 수 불일치');
}

(async () => {
  console.log('=== Part 1: 3회 실패 → DLQ 이동 시나리오 ===\n');

  const msg: StreamMessage = {
    id: `${Date.now()}-0`,
    fields: {
      eventType:   'NFT_BURNED',
      payload:     JSON.stringify({ tokenId: 'T-999', owner: '0xVICTIM' }),
      requestId:   'req-s11-001',
      publishedAt: String(Date.now()),
      _retryCount: '0',
    },
  };

  const redis = makeConsumerRedis(msg);

  // TODO 6 답안
  const worker = new ConsumerGroupWorker(
    redis, [brokenProcessor], dlqHandler,
    { streamKey: 'kyobo:events', groupName: 'issuer-consumers', consumerId: 'consumer-s11', batchSize: 1, blockMs: 0, minIdleMs: 30_000 },
  );

  const timeout = setTimeout(() => worker.stop(), 2000);
  await worker.start();
  clearTimeout(timeout);

  console.log('\n[check] DLQ 항목 수:', dlqStore.length);
  console.log(dlqStore.length >= 1 ? '✅ DLQ 이동 확인' : '❌ DLQ 이동 실패');

  await runOperatorWorkflow();
})();
