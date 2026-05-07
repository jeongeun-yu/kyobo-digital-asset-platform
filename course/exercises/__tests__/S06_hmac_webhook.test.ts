import crypto from 'crypto';
import { verifySignature } from '../M2/S06_hmac_webhook';

function computeHmac(data: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

const SECRET  = 'kyobo-test-secret-2024';
const PAYLOAD = Buffer.from(JSON.stringify({
  eventType: 'ACTIVITY_ACHIEVED',
  data:      { userId: 'u-001', activityId: 'steps-10k' },
  timestamp: 1714000000,
  requestId: 'test-s06',
}));
const CORRECT_SIG = computeHmac(PAYLOAD, SECRET);

describe('S06 채점 — verifySignature (HMAC-SHA256)', () => {
  describe('기본 검증', () => {
    it('TODO: 서명 없음(빈 문자열) → false', () => {
      expect(verifySignature(PAYLOAD, '', SECRET)).toBe(false);
    });

    it('TODO: 완전히 틀린 서명 → false', () => {
      expect(verifySignature(PAYLOAD, '0'.repeat(64), SECRET)).toBe(false);
    });

    it('TODO: 올바른 서명 → true', () => {
      expect(verifySignature(PAYLOAD, CORRECT_SIG, SECRET)).toBe(true);
    });

    it('TODO: 다른 시크릿으로 만든 서명 → false', () => {
      const wrongSecretSig = computeHmac(PAYLOAD, 'wrong-secret');
      expect(verifySignature(PAYLOAD, wrongSecretSig, SECRET)).toBe(false);
    });
  });

  describe('rawBody 바이트 무결성', () => {
    it('TODO: 키 순서가 다른 페이로드 + 원본 서명 → false', () => {
      const reordered = Buffer.from(JSON.stringify({
        requestId: 'test-s06',
        timestamp: 1714000000,
        eventType: 'ACTIVITY_ACHIEVED',
        data:      { activityId: 'steps-10k', userId: 'u-001' },
      }));
      expect(verifySignature(reordered, CORRECT_SIG, SECRET)).toBe(false);
    });
  });

  describe('timingSafeEqual 길이 불일치 방어', () => {
    it('TODO: 짧은 서명(hex 32자) → throw 없이 false 반환', () => {
      const shortSig = 'a'.repeat(32);
      expect(() => verifySignature(PAYLOAD, shortSig, SECRET)).not.toThrow();
      expect(verifySignature(PAYLOAD, shortSig, SECRET)).toBe(false);
    });
  });
});
