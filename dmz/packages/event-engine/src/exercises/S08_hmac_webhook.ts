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
 *   2. 서명 검증 시나리오 7가지 확인
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
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected,  'hex');

  if (sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ── 헬퍼: === 로 비교하는 취약한 검증 (Timing Attack 시연용) ─────────────────
function verifySignatureUnsafe(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return signature === expected;  // ← Timing Attack에 취약
}

// ── 헬퍼: JSON 재직렬화 후 서명 계산하는 잘못된 방식 ─────────────────────────
function verifySignatureWrongSerialization(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature) return false;
  const reparsed  = JSON.parse(rawBody.toString('utf8'));  // 객체로 파싱
  const reJson    = JSON.stringify(reparsed);              // 다시 직렬화
  const expected  = crypto
    .createHmac('sha256', secret)
    .update(Buffer.from(reJson))  // ← 재직렬화된 문자열로 계산 (함정)
    .digest('hex');
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected,  'hex');
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ── 공통 상수 ─────────────────────────────────────────────────────────────────

const SECRET = 'kyobo-test-secret-2024';

// 발신자가 원본 바이트 그대로 직렬화한 페이로드
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

// ── 시나리오 실행 ─────────────────────────────────────────────────────────────

(async () => {
  console.log('=== 기본 검증 시나리오 ===\n');

  // 시나리오 1: 서명 헤더 없음 → false
  const r1 = verifySignature(PAYLOAD, '', SECRET);
  console.log(`[시나리오 1] 서명 없음           → ${r1}  (기대: false)`);

  // 시나리오 2: 완전히 틀린 서명 → false
  const r2 = verifySignature(PAYLOAD, '0'.repeat(64), SECRET);
  console.log(`[시나리오 2] 잘못된 서명          → ${r2}  (기대: false)`);

  // 시나리오 3: 올바른 서명 → true
  const r3 = verifySignature(PAYLOAD, CORRECT_SIG, SECRET);
  console.log(`[시나리오 3] 올바른 서명          → ${r3}  (기대: true)`);

  // 시나리오 4: 다른 시크릿으로 만든 서명 → false
  const sigWithWrongSecret = crypto
    .createHmac('sha256', 'wrong-secret')
    .update(PAYLOAD)
    .digest('hex');
  const r4 = verifySignature(PAYLOAD, sigWithWrongSecret, SECRET);
  console.log(`[시나리오 4] 다른 시크릿으로 서명 → ${r4}  (기대: false)`);

  console.log('\n=== Timing Attack: === vs timingSafeEqual ===\n');

  // 시나리오 5: === 로 비교해도 올바른 서명이면 true — 기능은 같다
  //            하지만 내부적으로 첫 번째 다른 바이트에서 즉시 종료한다는 게 문제
  //            → 응답 시간 측정으로 서명 한 자리씩 추측 가능 (Timing Attack)
  const r5 = verifySignatureUnsafe(PAYLOAD, CORRECT_SIG, SECRET);
  console.log(`[시나리오 5] === 비교 (올바른 서명) → ${r5}  (기대: true)`);
  console.log('  ↑ 기능은 맞지만 Timing Attack에 취약. 운영에서 절대 사용 금지.');

  const r5b = verifySignatureUnsafe(PAYLOAD, '0'.repeat(64), SECRET);
  console.log(`[시나리오 5b] === 비교 (틀린 서명)  → ${r5b}  (기대: false)`);
  console.log('  ↑ 첫 바이트에서 즉시 false → 응답 시간이 짧아 공격자가 감지 가능.');

  console.log('\n=== rawBody 재직렬화 함정 ===\n');

  // 시나리오 6: 같은 내용이지만 키 순서가 다른 페이로드
  //            발신자(교보 앱 서버)가 보낸 원본과 키 순서가 다르면 서명 불일치
  const PAYLOAD_REORDERED = Buffer.from(JSON.stringify({
    requestId: 'test-s08',        // ← 키 순서 변경
    timestamp: 1714000000,
    eventType: 'ACTIVITY_ACHIEVED',
    data:      { activityId: 'steps-10k', userId: 'u-001' },
  }));
  const sigForReordered = crypto
    .createHmac('sha256', SECRET)
    .update(PAYLOAD_REORDERED)
    .digest('hex');

  // CORRECT_SIG는 원본 PAYLOAD 기준으로 만들어짐 → 재정렬된 페이로드엔 불일치
  const r6 = verifySignature(PAYLOAD_REORDERED, CORRECT_SIG, SECRET);
  console.log(`[시나리오 6] 키 순서 다른 페이로드 + 원본 서명  → ${r6}  (기대: false)`);
  console.log('  ↑ 내용은 같아도 바이트가 다르면 HMAC 결과가 완전히 달라진다.');

  // 재정렬된 페이로드에 맞는 서명은 올바르게 통과
  const r6b = verifySignature(PAYLOAD_REORDERED, sigForReordered, SECRET);
  console.log(`[시나리오 6b] 키 순서 다른 페이로드 + 맞는 서명 → ${r6b}  (기대: true)`);

  // 시나리오 7: JSON 재직렬화로 서명 계산하면 — JS끼리는 우연히 맞을 수 있지만
  //            발신자가 Python/Go 등 다른 언어면 키 순서가 달라 불일치
  const r7 = verifySignatureWrongSerialization(PAYLOAD, CORRECT_SIG, SECRET);
  console.log(`\n[시나리오 7] 재직렬화 방식으로 검증 (같은 JS 환경) → ${r7}  (기대: true, 우연히 일치)`);
  console.log('  ↑ JS→JS는 키 순서가 보존돼 우연히 통과. 하지만 Python 발신자면 불일치.');

  const r7b = verifySignatureWrongSerialization(PAYLOAD_REORDERED, sigForReordered, SECRET);
  console.log(`[시나리오 7b] 재직렬화 방식 + 키 순서 다른 페이로드 → ${r7b}  (기대: ???)`);
  console.log('  ↑ 재직렬화 후 키 순서가 바뀌어 발신자 서명과 불일치할 수 있다.');

  console.log('\n=== timingSafeEqual 길이 불일치 throw ===\n');

  // 시나리오 8: 짧은 서명(hex 32글자 = 16바이트) → 길이 불일치 → throw 발생
  //            verifySignature는 사전 차단하므로 throw 없이 false 반환
  const shortSig = 'a'.repeat(32);  // 16바이트 (정상은 32바이트)
  const r8 = verifySignature(PAYLOAD, shortSig, SECRET);
  console.log(`[시나리오 8] 짧은 서명 (길이 불일치) → verifySignature: ${r8}  (기대: false, throw 없음)`);

  // 길이 체크 없이 직접 timingSafeEqual 호출하면 throw
  try {
    const sigBuf = Buffer.from(shortSig, 'hex');  // 16바이트
    const expBuf = Buffer.from(CORRECT_SIG, 'hex');  // 32바이트
    crypto.timingSafeEqual(sigBuf, expBuf);
    console.log('[시나리오 8b] 길이 체크 없이 timingSafeEqual 직접 호출 → throw 없음 (예상치 못한 결과)');
  } catch (err) {
    console.log(`[시나리오 8b] 길이 체크 없이 timingSafeEqual 직접 호출 → throw 발생: ${(err as Error).message}`);
    console.log('  ↑ 이래서 length 사전 체크가 필수다.');
  }
})();
