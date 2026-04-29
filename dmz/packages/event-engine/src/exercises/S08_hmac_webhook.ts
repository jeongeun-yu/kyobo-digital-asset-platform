/**
 * S08 실습 — HMAC-SHA256 서명 검증 구현
 *
 * 강의 노트: M2_S8_hmac_queue_service.md
 *
 * 실행 방법 (dmz/packages/event-engine 폴더에서):
 *   npx ts-node src/exercises/S08_hmac_webhook.ts
 *
 * 목표:
 *   1. verifySignature() 직접 구현 (HMAC + timingSafeEqual)
 *   2. 서명 검증 시나리오 3가지 확인 (없음/위조/올바름)
 */

import crypto from 'crypto';

/**
 * HMAC-SHA256 서명을 검증한다.
 *
 * @param rawBody   - 수신한 원본 바이트 (Buffer). JSON.parse 전 원본 사용.
 * @param signature - X-Kyobo-Signature 헤더 값 (hex string).
 * @param secret    - HMAC 공유 시크릿.
 * @returns 서명이 유효하면 true, 아니면 false.
 */
function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  // TODO 1: signature가 없으면 즉시 false 반환

  // TODO 2: crypto.createHmac('sha256', secret)으로 expected 계산
  //         - .update(rawBody)   ← Buffer 그대로 (string 변환 금지)
  //         - .digest('hex')     ← hex string 반환
  const expected = ''; // TODO

  // TODO 3: signature와 expected를 각각 Buffer.from(?, 'hex')로 변환
  const sigBuf = Buffer.alloc(0); // TODO
  const expBuf = Buffer.alloc(0); // TODO

  // TODO 4: 길이가 다르면 false 반환
  //         (timingSafeEqual은 길이가 다르면 throw — 사전 차단)

  // TODO 5: crypto.timingSafeEqual(sigBuf, expBuf) 결과 반환
  return false; // placeholder
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

  // 시나리오 1: 서명 없음 → false
  const r1 = verifySignature(PAYLOAD, '', SECRET);
  console.log(`[시나리오 1] 서명 없음    → ${r1}  (기대: false)`);

  // 시나리오 2: 잘못된 서명 → false
  const r2 = verifySignature(PAYLOAD, '0'.repeat(64), SECRET);
  console.log(`[시나리오 2] 잘못된 서명  → ${r2}  (기대: false)`);

  // 시나리오 3: 올바른 서명 → true
  const r3 = verifySignature(PAYLOAD, CORRECT_SIG, SECRET);
  console.log(`[시나리오 3] 올바른 서명  → ${r3}  (기대: true)`);
})();
