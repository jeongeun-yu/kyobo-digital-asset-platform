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

import { ConsumerGroupWorker, DLQHandler, type EventProcessor, type StreamMessage, type DLQItem } from '@kyobo/event-engine';

// ────────────────────────────────────────────────────────────────────────
// Mock 인프라 — 수정하지 않아도 됨
// ────────────────────────────────────────────────────────────────────────

// stream key별로 분리된 저장소
const dlqStore: Map<string, Array<{ id: string; fields: Record<string, string> }>> = new Map();
function getStream(key: string) {
  if (!dlqStore.has(key)) dlqStore.set(key, []);
  return dlqStore.get(key)!;
}

const dlqRedis = {
  async xadd(key: string, fields: Record<string, string>): Promise<string> {
    const id = `${Date.now()}-0`;
    getStream(key).push({ id, fields });
    console.log(`[DLQ XADD] ${key} → ${id}`);
    return id;
  },
  async xrange(key: string, start: string, end: string, count?: number) {
    const stream = getStream(key);
    if (start !== '-' && start === end) return stream.filter(i => i.id === start);
    return stream.slice(0, count ?? stream.length);
  },
  async xdel(key: string, ...ids: string[]): Promise<number> {
    const stream = getStream(key);
    let count = 0;
    for (const id of ids) {
      const idx = stream.findIndex(i => i.id === id);
      if (idx !== -1) { stream.splice(idx, 1); count++; }
    }
    return count;
  },
};

const dlqNotifier = {
  async sendAlert(msg: string): Promise<void> {
    console.log('[DLQ ALERT]', msg.split('\n')[0]);
  },
};

// Consumer Mock — 수정하지 않아도 됨
function makeConsumerRedis(msg: StreamMessage) {
  let count = 0;
  return {
    async xreadgroup() {
      if (count++ < 4) return [{ key: 'kyobo:events', messages: [msg] }];
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

// ────────────────────────────────────────────────────────────────────────
// 실습 1 — DLQHandler 생성
// ────────────────────────────────────────────────────────────────────────
// DLQHandler는 실패 메시지를 DLQ 스트림으로 옮기고 운영자에게 알림을 보내는 클래스다.
// 생성자: new DLQHandler(redis, notifier, sourceStreamKey)
//   - redis            : 위에서 만든 dlqRedis
//   - notifier         : 위에서 만든 dlqNotifier
//   - sourceStreamKey  : 'kyobo:events'  ← DLQ 스트림 키가 'kyobo:events:dlq'로 결정됨
//
// 힌트: export const dlqHandler = new DLQHandler(dlqRedis, dlqNotifier, 'kyobo:events')
export const dlqHandler = new DLQHandler(dlqRedis, dlqNotifier, 'kyobo:events');

// ────────────────────────────────────────────────────────────────────────
// 실습 2 — 항상 실패하는 EventProcessor 구현
// ────────────────────────────────────────────────────────────────────────
// ConsumerGroupWorker에 넘길 processor를 만든다.
// eventTypes: ['NFT_BURNED']  ← 이 타입의 메시지만 처리
// process(): 항상 throw new Error('DB connection failed')
//   → 3회 재시도 후 DLQ로 이동하는 흐름을 확인하기 위해 의도적으로 실패
//
// 힌트: export const brokenProcessor: EventProcessor = { eventTypes: [...], async process() { throw ... } }
export const brokenProcessor: EventProcessor = {
  eventTypes: ['NFT_BURNED'],
  async process(_msg: StreamMessage): Promise<void> {
    throw new Error('DB connection failed');
  },
};

// ────────────────────────────────────────────────────────────────────────
// Part 2 — 운영 절차: listPending + requeueMessage
// ────────────────────────────────────────────────────────────────────────

async function runOperatorWorkflow(dlqHandler: DLQHandler): Promise<void> {
  console.log('\n=== Part 2: 운영자 DLQ 처리 절차 ===\n');

  // 실습 3 — DLQ 항목 조회
  // dlqHandler.listPending()으로 현재 DLQ에 쌓인 메시지 목록을 가져온다.
  // 반환값: DLQItem[]  (messageId, event, reason, failedAt 등 포함)
  //
  // 힌트: const pending = await dlqHandler.listPending()
  const pending = await dlqHandler.listPending();

  console.log(`[listPending] DLQ 항목 수: ${pending.length}`);
  for (const item of pending) {
    console.log(`  - ${item.messageId} | ${item.event['eventType']} | ${item.reason}`);
  }

  if (pending.length === 0) {
    console.log('[skip] DLQ가 비어 있어 재큐잉 스킵');
    return;
  }

  // 실습 4 — 첫 번째 DLQ 항목 재큐잉
  // dlqHandler.requeueMessage(messageId) → { newMessageId: string }
  //   - DLQ에서 메시지를 꺼내 kyobo:events에 다시 XADD
  //   - DLQ에서는 XDEL로 제거
  //
  // 힌트: const result = await dlqHandler.requeueMessage(pending[0]!.messageId)
  const first = pending[0]!;
  const result = await dlqHandler.requeueMessage(first.messageId);
  console.log(`[requeue] 재큐잉 완료: ${result.newMessageId}`);

  // 실습 5 — 재큐잉 후 DLQ 항목 수 확인
  // 힌트: const afterRequeue = await dlqHandler.listPending()
  const afterRequeue = await dlqHandler.listPending();
  console.log(`[listPending after requeue] DLQ 항목 수: ${afterRequeue.length}`);
  console.log(pending.length - afterRequeue.length === 1 ? '✅ 재큐잉 후 항목 1개 감소' : '❌ 항목 수 불일치');
}

// ────────────────────────────────────────────────────────────────────────
// 실행 — 실습 1~2 완성 후 실습 6 블록을 완성한다
// ────────────────────────────────────────────────────────────────────────

async function main() {
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
  const worker = new ConsumerGroupWorker(
    redis, [brokenProcessor], dlqHandler,
    { streamKey: 'kyobo:events', groupName: 'issuer-consumers',
      consumerId: 'consumer-s11', batchSize: 1, blockMs: 0, minIdleMs: 30_000 },
  );
  const timeout = setTimeout(() => worker.stop(), 2000);
  await worker.start();
  clearTimeout(timeout);

  const dlqStream = getStream('kyobo:events:dlq');
  console.log('\n[check] DLQ 항목 수:', dlqStream.length);
  console.log(dlqStream.length >= 1 ? '✅ DLQ 이동 확인' : '❌ DLQ 이동 실패');
  await runOperatorWorkflow(dlqHandler);
}

if (require.main === module) main();
