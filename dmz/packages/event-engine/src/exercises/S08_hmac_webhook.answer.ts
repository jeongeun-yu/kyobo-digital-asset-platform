/**
 * S08 답안 — HMAC-SHA256 서명 검증 구현
 * 강의 노트: M2_S8_hmac_queue_service.md
 */

import crypto from 'crypto';

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

// ── 검증 시나리오 실행 ────────────────────────────────────────────────────────

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
})();
