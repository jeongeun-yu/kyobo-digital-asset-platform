/**
 * S11 실습 — Dead Letter Queue 운영 패턴
 *
 * 강의 노트: M2_S11_dlq_design.md
 *
 * 실행 방법 (dmz/packages/event-engine 폴더에서):
 *   npx ts-node src/exercises/S11_dlq.ts
 *
 * 목표:
 *   Part 1 — 3회 실패 → DLQ 이동 시나리오 관찰
 *   Part 2 — DLQHandler.listPending() / requeueMessage() 운영 절차 실습
 */

import { ConsumerGroupWorker, type EventProcessor, type StreamMessage } from '../dmz/ConsumerGroupWorker';
import { DLQHandler, type DLQItem } from '../dmz/DLQHandler';

// ══════════════════════════════════════════════════════════════════════════
// Mock 인프라 (실제 Redis 없이 인메모리 시뮬레이션)
// ══════════════════════════════════════════════════════════════════════════

// DLQ 스트림 인메모리 저장소
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

// ── TODO 1: DLQHandler 인스턴스를 생성하라 ────────────────────────────────
// 인자: (dlqRedis, dlqNotifier, sourceStreamKey?)
// sourceStreamKey 기본값: 'kyobo:events'
export const dlqHandler: DLQHandler = /* TODO */ null as any;

// ══════════════════════════════════════════════════════════════════════════
// Part 1 — 3회 실패 시나리오
// ══════════════════════════════════════════════════════════════════════════

// ── TODO 2: 항상 실패하는 EventProcessor를 구현하라 ──────────────────────
// eventTypes: ['NFT_BURNED']
// process: throw new Error('DB connection failed')
export const brokenProcessor: EventProcessor = {
  eventTypes: /* TODO */ [],
  async process(_msg: StreamMessage): Promise<void> {
    // TODO: throw new Error('DB connection failed')
  },
};

// Consumer Mock (메시지를 무한 반복 공급)
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

// ══════════════════════════════════════════════════════════════════════════
// Part 2 — 운영 절차: listPending + requeueMessage
// ══════════════════════════════════════════════════════════════════════════

async function runOperatorWorkflow(): Promise<void> {
  console.log('\n=== Part 2: 운영자 DLQ 처리 절차 ===\n');

  // ── TODO 3: dlqHandler.listPending()으로 DLQ 항목을 조회하라 ─────────
  const pending: DLQItem[] = /* TODO */ [];

  console.log(`[listPending] DLQ 항목 수: ${pending.length}`);
  for (const item of pending) {
    console.log(`  - ${item.messageId} | ${item.event['eventType']} | ${item.reason}`);
  }

  if (pending.length === 0) {
    console.log('[skip] DLQ가 비어 있어 재큐잉 스킵');
    return;
  }

  // ── TODO 4: 첫 번째 DLQ 항목을 requeueMessage()로 재큐잉하라 ─────────
  // 반환값: { newMessageId: string }
  const first = pending[0]!;
  const result = /* TODO */ { newMessageId: '' };

  console.log(`[requeue] 재큐잉 완료: ${result.newMessageId}`);

  // ── TODO 5: requeueMessage() 후 listPending()을 다시 호출해 항목이 줄었는지 확인하라
  const afterRequeue: DLQItem[] = /* TODO */ [];
  console.log(`[listPending after requeue] DLQ 항목 수: ${afterRequeue.length}`);
  console.log(pending.length - afterRequeue.length === 1 ? '✅ 재큐잉 후 항목 1개 감소' : '❌ 항목 수 불일치');
}

// ══════════════════════════════════════════════════════════════════════════
// 실행
// ══════════════════════════════════════════════════════════════════════════
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

  // ── TODO 6: ConsumerGroupWorker 인스턴스를 생성하라 ───────────────────
  // (redis, [brokenProcessor], dlqHandler, config)
  // config: streamKey='kyobo:events', groupName='issuer-consumers',
  //         consumerId='consumer-s11', batchSize=1, blockMs=0, minIdleMs=30_000
  const worker: ConsumerGroupWorker = /* TODO */ null as any;

  const timeout = setTimeout(() => worker.stop(), 2000);

  await worker.start();
  clearTimeout(timeout);

  console.log('\n[check] DLQ 항목 수:', dlqStore.length);
  console.log(dlqStore.length >= 1 ? '✅ DLQ 이동 확인' : '❌ DLQ 이동 실패 — brokenProcessor 또는 dlqHandler 미구현');

  await runOperatorWorkflow();
})();
