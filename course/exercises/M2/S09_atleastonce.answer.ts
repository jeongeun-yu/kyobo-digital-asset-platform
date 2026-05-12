/**
 * S09 실습 — At-least-once + 멱등성 구현 (답안)
 *
 * 강의 노트: M2_S9_atleastonce_design.md
 *
 * 실행 방법 (루트에서): npm run exercise:s09
 *
 * 목표:
 *   Part 1 — 멱등성 없는 Naive 처리자: 동일 메시지 2회 → holdings +2 버그 확인
 *   Part 2 — IdempotentNftProcessor 구현: 동일 메시지 2회 → holdings +1 확인
 *   핵심: 처리 순서 불변 규칙 — 멱등성 확인 → 처리 → (XACK는 Worker가 처리)
 */

import { ConsumerGroupWorker, DLQHandler, type EventProcessor, type StreamMessage } from '@kyobo/event-engine';

// ── 인메모리 원장 (실습용 시뮬레이션) ──────────────────────────────────────
export const ledger: Map<string, number> = new Map();

function credit(tokenId: string, owner: string): void {
  const prev = ledger.get(tokenId) ?? 0;
  ledger.set(tokenId, prev + 1);
  console.log(`    [원장] ${tokenId} → ${owner} | 누적 처리 횟수: ${prev + 1}`);
}

// ────────────────────────────────────────────────────────────────────────
// Part 1 — 멱등성 없는 Naive Processor (버그 재현용, 수정하지 않는다)
// ────────────────────────────────────────────────────────────────────────
const naiveProcessor: EventProcessor = {
  eventTypes: ['NFT_ISSUED'],
  async process(msg: StreamMessage): Promise<void> {
    const { tokenId, owner } = JSON.parse(msg.fields['payload'] ?? '{}');
    credit(tokenId, owner);
  },
};

// ────────────────────────────────────────────────────────────────────────
// Part 2 — 답안: IdempotentNftProcessor
// ────────────────────────────────────────────────────────────────────────

export class IdempotentNftProcessor implements EventProcessor {
  readonly eventTypes = ['NFT_ISSUED'];                    // TODO 1 완성

  private readonly processedIds = new Set<string>();       // TODO 2 완성

  async process(message: StreamMessage): Promise<void> {
    // TODO 3 완성
    const requestId = message.fields['requestId'] ?? message.id;
    const payload   = JSON.parse(message.fields['payload'] ?? '{}');

    // TODO 4 완성
    if (this.processedIds.has(requestId)) {
      console.log(`    [멱등성] 중복 요청 무시: ${requestId}`);
      return;
    }

    // TODO 5 완성
    const { tokenId, owner } = payload;
    credit(tokenId, owner);
    this.processedIds.add(requestId);
  }
}

// ── Mock 헬퍼 ──────────────────────────────────────────────────────────────
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

// 동일 requestId로 2회 전달 — Consumer 크래시 후 PEL 재수신 시뮬레이션
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

if (require.main === module) (async () => {
  console.log('=== S09 실습: At-least-once + 멱등성 ===\n');

  console.log('[ Part 1 ] 멱등성 없음 — 동일 메시지 2회 전달');
  await runScenario(naiveProcessor);

  console.log('[ Part 2 ] 멱등성 적용 — 동일 메시지 2회 전달');
  await runScenario(new IdempotentNftProcessor());
})();
