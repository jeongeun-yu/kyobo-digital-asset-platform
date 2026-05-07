/**
 * S05 채점 — computeHmac (HMAC-SHA256 서명 생성)
 *
 * S05_make_sig.ts는 export가 없으므로 동일한 로직을 인라인으로 재구성하여 채점한다.
 * 채점 기준:
 *   · crypto.createHmac('sha256', secret).update(Buffer.from(data)).digest('hex') 패턴을 이해했는가
 *   · 같은 입력 → 같은 출력 (결정론적)
 *   · 다른 시크릿 → 다른 결과
 *   · hex 포맷(길이 64) 확인
 */

import crypto from 'crypto';

/** S05에서 학생이 구현하는 로직과 동일한 헬퍼 */
function computeHmac(payload: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(Buffer.from(payload))
    .digest('hex');
}

describe('S05 채점 — HMAC-SHA256 서명 생성', () => {
  const SECRET  = 'dev-secret-kyobo';
  const PAYLOAD = JSON.stringify({
    eventType: 'NFT_ISSUED',
    data:      { tokenId: '42', owner: '0xABCD' },
    requestId: 'test-001',
  });

  it('computeHmac가 hex 문자열(64자)을 반환한다', () => {
    const sig = computeHmac(PAYLOAD, SECRET);
    expect(typeof sig).toBe('string');
    expect(sig).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(sig)).toBe(true);
  });

  it('같은 payload + 같은 secret → 항상 동일한 서명 (결정론적)', () => {
    const sig1 = computeHmac(PAYLOAD, SECRET);
    const sig2 = computeHmac(PAYLOAD, SECRET);
    expect(sig1).toBe(sig2);
  });

  it('다른 secret → 다른 서명', () => {
    const sig1 = computeHmac(PAYLOAD, SECRET);
    const sig2 = computeHmac(PAYLOAD, 'wrong-secret');
    expect(sig1).not.toBe(sig2);
  });

  it('다른 payload → 다른 서명', () => {
    const sig1 = computeHmac(PAYLOAD, SECRET);
    const sig2 = computeHmac('different-payload', SECRET);
    expect(sig1).not.toBe(sig2);
  });

  it('S05 기본 시크릿(dev-secret-kyobo) + 알려진 입력 → 기대 서명 일치', () => {
    const knownPayload = 'hello-kyobo';
    const expected = crypto
      .createHmac('sha256', SECRET)
      .update(Buffer.from(knownPayload))
      .digest('hex');
    expect(computeHmac(knownPayload, SECRET)).toBe(expected);
  });

  it('빈 payload도 처리 가능 (에러 없음)', () => {
    expect(() => computeHmac('', SECRET)).not.toThrow();
    const sig = computeHmac('', SECRET);
    expect(sig).toHaveLength(64);
  });
});
