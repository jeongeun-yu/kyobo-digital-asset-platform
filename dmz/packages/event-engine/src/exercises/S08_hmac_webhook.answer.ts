/**
 * S08 답안 — HMAC-SHA256 서명 검증 + RedisStreamPublisher.publish() 구현
 * 강의 노트: M2_S8_hmac_queue_service.md
 */

import crypto from 'crypto';

// ── 1부: verifySignature 독립 함수 ──────────────────────────────────────────

function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  // TODO 1 답안
  if (!signature) return false;

  // TODO 2 답안
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // TODO 3 답안
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected,  'hex');

  // TODO 4 답안
  if (sigBuf.length !== expBuf.length) return false;

  // TODO 5 답안
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ── 2부: MockPublisher ───────────────────────────────────────────────────────

interface StreamEvent {
  streamKey:   string;
  eventType:   string;
  payload:     Record<string, unknown>;
  txHash:      string;
  blockNumber: number;
  requestId:   string;
}

const mockRedis = {
  async xadd(key: string, fields: Record<string, string>): Promise<string> {
    const messageId = `${Date.now()}-0`;
    console.log(`[XADD] ${key}`, fields);
    console.log(`[XADD] → messageId: ${messageId}`);
    return messageId;
  },
};

// TODO 6 답안
async function publish(event: StreamEvent): Promise<string> {
  const messageId = await mockRedis.xadd(
    event.streamKey,
    {
      eventType:   event.eventType,
      payload:     JSON.stringify(event.payload),
      txHash:      event.txHash,
      blockNumber: String(event.blockNumber),
      requestId:   event.requestId,
      publishedAt: String(Date.now()),
    },
  );
  return messageId;
}

// ── 3부: 검증 시나리오 실행 ──────────────────────────────────────────────────

const SECRET  = 'kyobo-test-secret-2024';
const PAYLOAD = Buffer.from(JSON.stringify({
  eventType: 'ACTIVITY_ACHIEVED',
  data:      { userId: 'u-001', activityId: 'steps-10k' },
  timestamp: 1714000000,
  requestId: 'test-s08',
}));

const CORRECT_SIG = crypto
  .createHmac('sha256', SECRET)
  .update(PAYLOAD)
  .digest('hex');

(async () => {
  console.log('=== 서명 검증 시나리오 ===\n');

  const r1 = verifySignature(PAYLOAD, '', SECRET);
  console.log(`[시나리오 1] 서명 없음    → ${r1}  (기대: false)`);

  const r2 = verifySignature(PAYLOAD, '0'.repeat(64), SECRET);
  console.log(`[시나리오 2] 잘못된 서명  → ${r2}  (기대: false)`);

  const r3 = verifySignature(PAYLOAD, CORRECT_SIG, SECRET);
  console.log(`[시나리오 3] 올바른 서명  → ${r3}  (기대: true)`);

  console.log('\n=== publish() 실습 ===\n');

  const messageId = await publish({
    streamKey:   'kyobo:events',
    eventType:   'NFT_ISSUED',
    payload:     { tokenId: '42', owner: '0xKYOBO' },
    txHash:      '0xdeadbeef001',
    blockNumber: 18500001,
    requestId:   'req-s08',
  });

  console.log('[result] messageId:', messageId);
  console.log('[check] 형식 확인:', /^\d+-\d+$/.test(messageId) ? '✅ 정상' : '❌ 오류');
})();
