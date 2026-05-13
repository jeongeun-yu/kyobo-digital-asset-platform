/**
 * S10 실습 — 재시도 & DLQ 분기 관찰
 *
 * 실행 방법: npm run exercise:s10
 *
 * 아래 실험 변수를 바꾸고 실행하면서 출력이 어떻게 달라지는지 확인하세요.
 * 각 실험의 의미는 실습 가이드(M2_S10_event_consumer_impl.md)를 참고하세요.
 */

// ══════════════════════════════════════════════════════════════════
//  실험 변수 — 여기 값을 바꿔가며 실행해보세요
// ══════════════════════════════════════════════════════════════════

/** 실험 1: 최대 재시도 횟수 (1, 2, 3 으로 바꿔보세요) */
const MAX_RETRIES = 3;

/** 실험 2: 실패 메시지의 현재 재시도 횟수 (0, 1, 2, 3 으로 바꿔보세요) */
const FAIL_MSG_RETRY_COUNT = 1;

// ══════════════════════════════════════════════════════════════════
//  아래는 수정하지 않아도 됩니다
// ══════════════════════════════════════════════════════════════════

import { DLQHandler, type EventProcessor, type StreamMessage, type RedisConsumerClient } from '@kyobo/event-engine';

const STREAM_KEY = 'kyobo:events';
const GROUP_NAME = 'issuer-consumers';

async function handleWithRetry(
  msg:        StreamMessage,
  processors: EventProcessor[],
  redis:      Pick<RedisConsumerClient, 'xack'>,
  dlq:        DLQHandler,
): Promise<void> {
  const eventType  = msg.fields['eventType'] ?? '';
  const retryCount = parseInt(msg.fields['_retryCount'] ?? '0', 10);

  if (retryCount >= MAX_RETRIES) {
    await dlq.move({
      messageId: msg.id,
      streamKey: STREAM_KEY,
      groupName: GROUP_NAME,
      event:     msg.fields,
      reason:    `max retries (${MAX_RETRIES}) exceeded`,
      failedAt:  new Date(),
    });
    await redis.xack(STREAM_KEY, GROUP_NAME, msg.id);
    return;
  }

  const matched = processors.filter(p => p.eventTypes.includes(eventType));
  if (matched.length === 0) {
    await redis.xack(STREAM_KEY, GROUP_NAME, msg.id);
    return;
  }

  try {
    await Promise.all(matched.map(p => p.process(msg)));
    await redis.xack(STREAM_KEY, GROUP_NAME, msg.id);
  } catch (err) {
    msg.fields['_retryCount'] = String(retryCount + 1);
  }
}

// ── Mock 인프라 ──────────────────────────────────────────────────
function makeMsg(overrides: Partial<StreamMessage['fields']> = {}): StreamMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

const xackLog: string[] = [];
const mockRedis: Pick<RedisConsumerClient, 'xack'> = {
  async xack(_key, _group, ...ids) {
    xackLog.push(...ids);
    console.log(`  [XACK] ${ids.join(', ')}`);
    return ids.length;
  },
};

const dlqLog: string[] = [];
const mockDLQ = new DLQHandler(
  { async xadd() { return `${Date.now()}-0`; }, async xrange() { return []; }, async xdel() { return 0; } },
  { async sendAlert(msg) { console.log(`  [DLQ] ${msg.split('\n')[0]}`); } },
);
const _origMove = mockDLQ.move.bind(mockDLQ);
mockDLQ.move = async (item) => { dlqLog.push(item.messageId); return _origMove(item); };

const successProcessor: EventProcessor = {
  eventTypes: ['NFT_ISSUED'],
  async process(msg) { console.log(`  [processor] ${msg.fields['eventType']} → 성공`); },
};

const failProcessor: EventProcessor = {
  eventTypes: ['NFT_ISSUED'],
  async process() { throw new Error('일시적 오류'); },
};

function result(label: string, pass: boolean): void {
  console.log(`  ${pass ? '✅' : '❌'} ${label}`);
}

// ── 실험 실행 ────────────────────────────────────────────────────
(async () => {
  const LINE = '─'.repeat(52);

  console.log('\n' + LINE);
  console.log('  S10 실습 — 재시도 & DLQ 분기 관찰');
  console.log(LINE);
  console.log(`  MAX_RETRIES          = ${MAX_RETRIES}`);
  console.log(`  FAIL_MSG_RETRY_COUNT = ${FAIL_MSG_RETRY_COUNT}`);
  console.log(LINE + '\n');

  // ── 시나리오 A: retryCount >= MAX_RETRIES → DLQ ──────────────────
  console.log(`[A] retryCount=${MAX_RETRIES} (>= MAX_RETRIES=${MAX_RETRIES}) → DLQ`);
  xackLog.length = 0; dlqLog.length = 0;
  const msgA = makeMsg({ _retryCount: String(MAX_RETRIES) });
  await handleWithRetry(msgA, [successProcessor], mockRedis, mockDLQ);
  result(`DLQ 이동: ${dlqLog.length}건 (기대: 1)`,  dlqLog.length === 1);
  result(`XACK: ${xackLog.length}건 (기대: 1)`,     xackLog.length === 1);
  console.log();

  // ── 시나리오 B: 미지원 eventType → XACK만 ────────────────────────
  console.log('[B] UNKNOWN_EVENT → 매칭 processor 없음');
  xackLog.length = 0; dlqLog.length = 0;
  const msgB = makeMsg({ eventType: 'UNKNOWN_EVENT' });
  await handleWithRetry(msgB, [successProcessor], mockRedis, mockDLQ);
  result(`DLQ 이동: ${dlqLog.length}건 (기대: 0)`,  dlqLog.length === 0);
  result(`XACK: ${xackLog.length}건 (기대: 1)`,     xackLog.length === 1);
  console.log();

  // ── 시나리오 C: 정상 처리 → XACK ────────────────────────────────
  console.log('[C] NFT_ISSUED → 처리 성공 → XACK');
  xackLog.length = 0; dlqLog.length = 0;
  const msgC = makeMsg();
  await handleWithRetry(msgC, [successProcessor], mockRedis, mockDLQ);
  result(`XACK: ${xackLog.length}건 (기대: 1)`,     xackLog.length === 1);
  console.log();

  // ── 시나리오 D: 처리 실패 → retryCount + 1, XACK 없음 ──────────
  console.log(`[D] 처리 실패, 현재 retryCount=${FAIL_MSG_RETRY_COUNT}`);
  xackLog.length = 0; dlqLog.length = 0;
  const msgD = makeMsg({ _retryCount: String(FAIL_MSG_RETRY_COUNT) });
  await handleWithRetry(msgD, [failProcessor], mockRedis, mockDLQ);
  const nextRetry = parseInt(msgD.fields['_retryCount'] ?? '0', 10);
  result(`retryCount: ${nextRetry} (기대: ${FAIL_MSG_RETRY_COUNT + 1})`, nextRetry === FAIL_MSG_RETRY_COUNT + 1);
  result(`XACK: ${xackLog.length}건 (기대: 0, PEL 유지)`, xackLog.length === 0);

  console.log('\n' + LINE + '\n');
  console.log('[ 다음 실험을 해보세요 ]');
  console.log(`  1. MAX_RETRIES = 1 → 시나리오 D에서 바로 DLQ로 이동?`);
  console.log(`  2. FAIL_MSG_RETRY_COUNT = MAX_RETRIES - 1 → 딱 한 번 더 실패하면 DLQ`);
  console.log(`  3. FAIL_MSG_RETRY_COUNT = MAX_RETRIES → 이미 한계 → 시나리오 A처럼 DLQ\n`);
})();
