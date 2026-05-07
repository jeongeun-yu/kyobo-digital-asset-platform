/**
 * S06 실습 — HMAC-SHA256 서명 검증 구현
 *
 * 강의 노트: M2_S6_hmac_queue_service.md
 *
 * 실행 방법 (dmz/packages/event-engine 폴더에서):
 *   npx ts-node src/exercises/S06_hmac_webhook.ts
 *
 * 목표:
 *   1. verifySignature() 직접 구현 (HMAC + timingSafeEqual)
 *   2. 서명 검증 시나리오 8가지 확인
 */

import crypto from 'crypto';

// ── 실습 1: verifySignature를 구현하라 ───────────────────────────────────────
// 구현 규칙:
//   1. signature가 빈 문자열이면 즉시 false 반환
//   2. crypto.createHmac('sha256', secret).update(rawBody).digest('hex') 로 expected 계산
//   3. Buffer.from(signature, 'hex') / Buffer.from(expected, 'hex') 로 각각 버퍼 변환
//   4. 두 버퍼 길이가 다르면 false 반환 (timingSafeEqual은 길이가 다르면 throw)
//   5. crypto.timingSafeEqual(sigBuf, expBuf) 결과 반환
function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  throw new Error('TODO: 구현하세요');
}

// ── Timing Attack 시연용: === 비교 ────────────────────────────────────────────
function verifySignatureUnsafe(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return signature === expected;  // ← Timing Attack에 취약
}

// ── 재직렬화 함정 시연용 ──────────────────────────────────────────────────────
function verifySignatureWrongSerialization(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature) return false;
  const reparsed = JSON.parse(rawBody.toString('utf8'));
  const reJson   = JSON.stringify(reparsed);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.from(reJson))  // ← 재직렬화된 문자열로 계산 (함정)
    .digest('hex');
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected,  'hex');
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ── 헬퍼: 서명 계산 과정 출력 ─────────────────────────────────────────────────
function computeHmac(data: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// ── 공통 상수 ─────────────────────────────────────────────────────────────────

const SECRET = 'kyobo-test-secret-2024';

const PAYLOAD = Buffer.from(JSON.stringify({
  eventType: 'ACTIVITY_ACHIEVED',
  data:      { userId: 'u-001', activityId: 'steps-10k' },
  timestamp: 1714000000,
  requestId: 'test-s08',
}));

const CORRECT_SIG = computeHmac(PAYLOAD, SECRET);

// ── 시나리오 실행 ─────────────────────────────────────────────────────────────

(async () => {
  console.log('=== 기본 검증 시나리오 ===\n');

  // 시나리오 1: 서명 없음
  console.log('[시나리오 1] 서명 없음');
  console.log(`  received : ""  (빈 문자열)`);
  console.log(`  결과     : ${verifySignature(PAYLOAD, '', SECRET)}  (기대: false)\n`);

  // 시나리오 2: 완전히 틀린 서명
  const fakeSig = '0'.repeat(64);
  console.log('[시나리오 2] 잘못된 서명');
  console.log(`  received : ${fakeSig}`);
  console.log(`  expected : ${CORRECT_SIG}`);
  console.log(`  결과     : ${verifySignature(PAYLOAD, fakeSig, SECRET)}  (기대: false)\n`);

  // 시나리오 3: 올바른 서명
  console.log('[시나리오 3] 올바른 서명');
  console.log(`  received : ${CORRECT_SIG}`);
  console.log(`  expected : ${CORRECT_SIG}`);
  console.log(`  결과     : ${verifySignature(PAYLOAD, CORRECT_SIG, SECRET)}  (기대: true)\n`);

  // 시나리오 4: 다른 시크릿으로 만든 서명
  const wrongSecretSig = computeHmac(PAYLOAD, 'wrong-secret');
  console.log('[시나리오 4] 다른 시크릿으로 서명');
  console.log(`  received : ${wrongSecretSig}  (wrong-secret으로 계산)`);
  console.log(`  expected : ${CORRECT_SIG}  (kyobo-test-secret-2024으로 계산)`);
  console.log(`  결과     : ${verifySignature(PAYLOAD, wrongSecretSig, SECRET)}  (기대: false)\n`);

  console.log('=== Timing Attack: === vs timingSafeEqual ===\n');

  // 시나리오 5: === 비교
  console.log('[시나리오 5] === 비교 — 올바른 서명');
  console.log(`  received : ${CORRECT_SIG}`);
  console.log(`  expected : ${CORRECT_SIG}`);
  console.log(`  결과     : ${verifySignatureUnsafe(PAYLOAD, CORRECT_SIG, SECRET)}  (기대: true)`);
  console.log('  ↑ 기능은 맞지만 첫 번째 다른 바이트에서 즉시 종료 → Timing Attack 취약\n');

  console.log('[시나리오 5b] === 비교 — 틀린 서명');
  console.log(`  received : ${fakeSig}`);
  console.log(`  expected : ${CORRECT_SIG}`);
  console.log(`  결과     : ${verifySignatureUnsafe(PAYLOAD, fakeSig, SECRET)}  (기대: false)`);
  console.log('  ↑ 첫 바이트 "0" ≠ "a" 에서 즉시 종료 → 응답 시간이 올바른 서명 비교보다 짧음\n');

  console.log('=== rawBody 재직렬화 함정 ===\n');

  // 시나리오 6: 키 순서가 다른 페이로드
  const PAYLOAD_REORDERED = Buffer.from(JSON.stringify({
    requestId: 'test-s08',
    timestamp: 1714000000,
    eventType: 'ACTIVITY_ACHIEVED',
    data:      { activityId: 'steps-10k', userId: 'u-001' },
  }));
  const sigForReordered = computeHmac(PAYLOAD_REORDERED, SECRET);

  console.log('[시나리오 6] 키 순서 다른 페이로드 + 원본 서명');
  console.log(`  payload  : ${PAYLOAD_REORDERED.toString()}`);
  console.log(`  received : ${CORRECT_SIG}  (원본 키순서 기준 서명)`);
  console.log(`  expected : ${sigForReordered}  (재정렬 페이로드 기준 서명)`);
  console.log(`  결과     : ${verifySignature(PAYLOAD_REORDERED, CORRECT_SIG, SECRET)}  (기대: false)`);
  console.log('  ↑ 내용은 같지만 바이트 배열이 달라 HMAC 결과가 완전히 다름\n');

  console.log('[시나리오 6b] 키 순서 다른 페이로드 + 맞는 서명');
  console.log(`  payload  : ${PAYLOAD_REORDERED.toString()}`);
  console.log(`  received : ${sigForReordered}`);
  console.log(`  expected : ${sigForReordered}`);
  console.log(`  결과     : ${verifySignature(PAYLOAD_REORDERED, sigForReordered, SECRET)}  (기대: true)\n`);

  // 시나리오 7: JSON 재직렬화 방식
  const reJson = JSON.stringify(JSON.parse(PAYLOAD.toString('utf8')));
  const reSerializedSig = computeHmac(Buffer.from(reJson), SECRET);

  console.log('[시나리오 7] 재직렬화 방식으로 검증 (같은 JS 환경)');
  console.log(`  원본     : ${PAYLOAD.toString()}`);
  console.log(`  재직렬화 : ${reJson}`);
  console.log(`  같은가?  : ${PAYLOAD.toString() === reJson}`);
  console.log(`  결과     : ${verifySignatureWrongSerialization(PAYLOAD, CORRECT_SIG, SECRET)}  (기대: true — JS끼리는 우연히 일치)`);
  console.log('  ↑ V8은 삽입 순서 보존. 하지만 Python/Go 발신자면 키 순서 달라 불일치\n');

  console.log('[시나리오 7b] 재직렬화 방식 + 키 순서 다른 페이로드');
  const reJson2 = JSON.stringify(JSON.parse(PAYLOAD_REORDERED.toString('utf8')));
  console.log(`  원본     : ${PAYLOAD_REORDERED.toString()}`);
  console.log(`  재직렬화 : ${reJson2}`);
  console.log(`  같은가?  : ${PAYLOAD_REORDERED.toString() === reJson2}`);
  console.log(`  결과     : ${verifySignatureWrongSerialization(PAYLOAD_REORDERED, sigForReordered, SECRET)}  (기대: ???)`);
  console.log('  ↑ JS끼리는 삽입 순서가 보존돼서 결국 일치 — 실제 불일치를 보려면 7c 참조\n');

  // 시나리오 7c: Python 발신자 시뮬레이션 (실제 불일치)
  const PAYLOAD_PYTHON = Buffer.from(
    '{"eventType": "ACTIVITY_ACHIEVED", "data": {"userId": "u-001", "activityId": "steps-10k"}, "timestamp": 1714000000, "requestId": "test-s08"}'
  );
  const sigForPython = computeHmac(PAYLOAD_PYTHON, SECRET);
  const reJsonPython = JSON.stringify(JSON.parse(PAYLOAD_PYTHON.toString('utf8')));

  console.log('[시나리오 7c] Python 발신자 시뮬레이션 — 실제 불일치');
  console.log(`  원본 (Python): ${PAYLOAD_PYTHON.toString()}`);
  console.log(`  재직렬화 (JS): ${reJsonPython}`);
  console.log(`  같은가?       : ${PAYLOAD_PYTHON.toString() === reJsonPython}  ← 공백 차이로 불일치`);
  console.log(`  HMAC(원본)    : ${sigForPython}`);
  console.log(`  HMAC(재직렬화): ${computeHmac(Buffer.from(reJsonPython), SECRET)}  ← 완전히 다른 해시`);
  console.log(`  올바른 검증   : ${verifySignature(PAYLOAD_PYTHON, sigForPython, SECRET)}  (기대: true)`);
  console.log(`  재직렬화 검증 : ${verifySignatureWrongSerialization(PAYLOAD_PYTHON, sigForPython, SECRET)}  (기대: false)`);
  console.log('  ↑ 이래서 rawBody를 절대 재직렬화하면 안 된다\n');

  console.log('=== timingSafeEqual 길이 불일치 throw ===\n');

  // 시나리오 8: 짧은 서명
  const shortSig = 'a'.repeat(32);  // 16바이트 (정상은 32바이트)
  const shortBuf = Buffer.from(shortSig, 'hex');
  const expBuf   = Buffer.from(CORRECT_SIG, 'hex');

  console.log('[시나리오 8] 짧은 서명 → verifySignature 사전 차단');
  console.log(`  received : "${shortSig}" (${shortBuf.length}바이트)`);
  console.log(`  expected : "${CORRECT_SIG.slice(0, 16)}..." (${expBuf.length}바이트)`);
  console.log(`  결과     : ${verifySignature(PAYLOAD, shortSig, SECRET)}  (기대: false, throw 없음)\n`);

  console.log('[시나리오 8b] 길이 체크 없이 timingSafeEqual 직접 호출');
  console.log(`  sigBuf.length : ${shortBuf.length}바이트`);
  console.log(`  expBuf.length : ${expBuf.length}바이트`);
  try {
    crypto.timingSafeEqual(shortBuf, expBuf);
  } catch (err) {
    console.log(`  throw 발생    : ${(err as Error).message}`);
    console.log('  ↑ 이래서 length 사전 체크가 필수다.');
  }
})();
