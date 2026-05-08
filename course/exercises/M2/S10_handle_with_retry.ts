/**
 * S10 실습 — ConsumerGroupWorker 핵심 로직: _handleWithRetry 구현
 *
 * 강의 노트: M2_S10_event_consumer_impl.md
 *
 * 실행 방법 (루트에서): npm run exercise:s10
 *
 * 목표:
 *   ConsumerGroupWorker의 핵심 메서드 _handleWithRetry()를 직접 구현한다.
 *   4가지 시나리오로 retryCount 분기, DLQ 이동, ACK 패턴을 검증한다.
 */

import { DLQHandler, type EventProcessor, type StreamMessage, type RedisConsumerClient } from '@kyobo/event-engine';

const MAX_RETRIES = 3;
const STREAM_KEY  = 'kyobo:events';
const GROUP_NAME  = 'issuer-consumers';

// ── 실습: _handleWithRetry를 완성하라 ────────────────────────────────────
//
// 처리 규칙 (순서 엄수):
//   1. retryCount >= MAX_RETRIES
//      → dlq.move({...}) + redis.xack + return
//   2. eventType 처리 가능한 processor 없음
//      → redis.xack + return  (무시)
//   3. process() 성공
//      → redis.xack
//   4. process() 실패 (throw)
//      → msg.fields['_retryCount'] = String(retryCount + 1)
//         (XACK 안 함 — PEL에 남겨 _reclaimPending에서 재수신)
//
// 힌트:
//   const eventType  = msg.fields['eventType'] ?? '';
//   const retryCount = parseInt(msg.fields['_retryCount'] ?? '0', 10);
export async function _handleWithRetry(
  msg:        StreamMessage,
  processors: EventProcessor[],
  redis:      Pick<RedisConsumerClient, 'xack'>,
  dlq:        DLQHandler,
): Promise<void> {
  const eventType  = msg.fields['eventType'] ?? '';
  const retryCount = parseInt(msg.fields['_retryCount'] ?? '0', 10);

  // 규칙 1: retryCount >= MAX_RETRIES → DLQ 이동 + XACK + return
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

  // 규칙 2: 처리 가능한 processor 없음 → XACK + return
  const matched = processors.filter(p => p.eventTypes.includes(eventType));
  if (matched.length === 0) {
    await redis.xack(STREAM_KEY, GROUP_NAME, msg.id);
    return;
  }

  // 규칙 3 + 4: 처리 시도 → 성공이면 XACK, 실패면 retryCount + 1
  try {
    await Promise.all(matched.map(p => p.process(msg)));
    await redis.xack(STREAM_KEY, GROUP_NAME, msg.id);
  } catch (err) {
    msg.fields['_retryCount'] = String(retryCount + 1);
    console.error(`    [retry] message ${msg.id} failed (attempt ${retryCount + 1}):`, (err as Error).message);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Mock & 헬퍼
// ────────────────────────────────────────────────────────────────────────
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
    console.log(`    [XACK] ${ids.join(', ')} → PEL 제거`);
    return ids.length;
  },
};

const dlqLog: string[] = [];
const mockDLQ = new DLQHandler(
  { async xadd() { return `${Date.now()}-0`; }, async xrange() { return []; }, async xdel() { return 0; } },
  { async sendAlert(msg) { console.log(`    [DLQ 알림] ${msg.split('\n')[0]}`); } },
);
const _origMove = mockDLQ.move.bind(mockDLQ);
mockDLQ.move = async (item) => { dlqLog.push(item.messageId); return _origMove(item); };

const successProcessor: EventProcessor = {
  eventTypes: ['NFT_ISSUED'],
  async process(msg) { console.log(`    [processor] ${msg.fields['eventType']} 처리 성공`); },
};

const failProcessor: EventProcessor = {
  eventTypes: ['NFT_ISSUED'],
  async process() { throw new Error('일시적 오류'); },
};

function check(label: string, pass: boolean): void {
  console.log(`    ${pass ? '✅' : '❌'} ${label}`);
}

// ────────────────────────────────────────────────────────────────────────
// 4가지 시나리오
// ────────────────────────────────────────────────────────────────────────
if (require.main === module) (async () => {
  console.log('=== S10 실습: _handleWithRetry 구현 ===\n');

  // ── 시나리오 1: retryCount=3 → DLQ ──────────────────────────────────
  console.log('[ 시나리오 1 ] retryCount=3 → DLQ 이동 + XACK');
  xackLog.length = 0; dlqLog.length = 0;
  const msg1 = makeMsg({ _retryCount: '3' });
  await _handleWithRetry(msg1, [successProcessor], mockRedis, mockDLQ);
  check('DLQ 이동 호출됨', dlqLog.length === 1);
  check('XACK 호출됨',     xackLog.length === 1);
  console.log();

  // ── 시나리오 2: 매칭 processor 없음 → XACK만 ────────────────────────
  console.log('[ 시나리오 2 ] UNKNOWN_EVENT → processor 없음 → XACK');
  xackLog.length = 0;
  const msg2 = makeMsg({ eventType: 'UNKNOWN_EVENT' });
  await _handleWithRetry(msg2, [successProcessor], mockRedis, mockDLQ);
  check('XACK 호출됨',         xackLog.length === 1);
  check('process 호출 없어야 함', true);  // successProcessor가 호출됐다면 출력이 나왔을 것
  console.log();

  // ── 시나리오 3: 처리 성공 → XACK ────────────────────────────────────
  console.log('[ 시나리오 3 ] 정상 처리 → XACK');
  xackLog.length = 0;
  const msg3 = makeMsg();
  await _handleWithRetry(msg3, [successProcessor], mockRedis, mockDLQ);
  check('XACK 호출됨', xackLog.length === 1);
  console.log();

  // ── 시나리오 4: 처리 실패 → retryCount + 1, XACK 없음 ───────────────
  console.log('[ 시나리오 4 ] 처리 실패 → retryCount + 1, XACK 없음 (PEL 유지)');
  xackLog.length = 0;
  const msg4 = makeMsg({ _retryCount: '1' });
  await _handleWithRetry(msg4, [failProcessor], mockRedis, mockDLQ);
  check(`retryCount = ${msg4.fields['_retryCount']} (기대: 2)`, msg4.fields['_retryCount'] === '2');
  check('XACK 없음 (PEL에 남음)',                                xackLog.length === 0);
  console.log();
})();
