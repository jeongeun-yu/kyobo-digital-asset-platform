/**
 * S08 실습 — HMAC-SHA256 서명 검증 + RedisStreamPublisher.publish() 구현
 *
 * 강의 노트: M2_S8_hmac_queue_service.md
 *
 * 실행 방법 (dmz/packages/event-engine 폴더에서):
 *   npx ts-node src/exercises/S08_hmac_webhook.ts
 *
 * 목표:
 *   1. verifySignature() 직접 구현 (HMAC + timingSafeEqual)
 *   2. MockPublisher.publish() 직접 구현 (XADD 필드 직렬화)
 *   3. 서명 검증 시나리오 3가지 확인 (없음/위조/올바름)
 */

import crypto from 'crypto';

// ── 1부: verifySignature 독립 함수 구현 ─────────────────────────────────────

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

// ── 2부: MockPublisher (RedisStreamPublisher.publish() 스켈레톤) ────────────

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

/**
 * TODO 6: publish() 구현
 *
 * mockRedis.xadd(streamKey, fields)를 호출하라.
 * fields에 포함할 항목:
 *   - eventType:   string 그대로
 *   - payload:     JSON.stringify(event.payload)  ← 객체는 직렬화 필수
 *   - txHash:      string 그대로
 *   - blockNumber: String(event.blockNumber)       ← number → string 변환
 *   - requestId:   string 그대로
 *   - publishedAt: String(Date.now())              ← 발행 시각
 *
 * @returns messageId (xadd 반환값)
 */
async function publish(event: StreamEvent): Promise<string> {
  // TODO 6: mockRedis.xadd 호출 후 messageId 반환
  throw new Error('not implemented');
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

  // 시나리오 1: 서명 없음 → false
  const r1 = verifySignature(PAYLOAD, '', SECRET);
  console.log(`[시나리오 1] 서명 없음    → ${r1}  (기대: false)`);

  // 시나리오 2: 잘못된 서명 → false
  const r2 = verifySignature(PAYLOAD, '0'.repeat(64), SECRET);
  console.log(`[시나리오 2] 잘못된 서명  → ${r2}  (기대: false)`);

  // 시나리오 3: 올바른 서명 → true
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
