import crypto from 'crypto';

// S08 실습에서 학생이 직접 구현하는 함수 — 테스트가 구현 명세가 된다
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

function computeHmac(data: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

const SECRET  = 'kyobo-test-secret-2024';
const PAYLOAD = Buffer.from(JSON.stringify({
  eventType: 'ACTIVITY_ACHIEVED',
  data:      { userId: 'u-001', activityId: 'steps-10k' },
  timestamp: 1714000000,
  requestId: 'test-s08',
}));
const CORRECT_SIG = computeHmac(PAYLOAD, SECRET);

describe('verifySignature (HMAC-SHA256)', () => {
  describe('기본 검증', () => {
    it('서명 없음(빈 문자열) → false', () => {
      expect(verifySignature(PAYLOAD, '', SECRET)).toBe(false);
    });

    it('완전히 틀린 서명 → false', () => {
      expect(verifySignature(PAYLOAD, '0'.repeat(64), SECRET)).toBe(false);
    });

    it('올바른 서명 → true', () => {
      expect(verifySignature(PAYLOAD, CORRECT_SIG, SECRET)).toBe(true);
    });

    it('다른 시크릿으로 만든 서명 → false', () => {
      const wrongSecretSig = computeHmac(PAYLOAD, 'wrong-secret');
      expect(verifySignature(PAYLOAD, wrongSecretSig, SECRET)).toBe(false);
    });
  });

  describe('rawBody 바이트 무결성', () => {
    it('키 순서가 다른 페이로드 + 원본 서명 → false (내용 같아도 바이트 다르면 불일치)', () => {
      const reordered = Buffer.from(JSON.stringify({
        requestId: 'test-s08',
        timestamp: 1714000000,
        eventType: 'ACTIVITY_ACHIEVED',
        data:      { activityId: 'steps-10k', userId: 'u-001' },
      }));
      expect(verifySignature(reordered, CORRECT_SIG, SECRET)).toBe(false);
    });

    it('키 순서가 다른 페이로드 + 해당 페이로드 기준 서명 → true', () => {
      const reordered = Buffer.from(JSON.stringify({
        requestId: 'test-s08',
        timestamp: 1714000000,
        eventType: 'ACTIVITY_ACHIEVED',
        data:      { activityId: 'steps-10k', userId: 'u-001' },
      }));
      const sig = computeHmac(reordered, SECRET);
      expect(verifySignature(reordered, sig, SECRET)).toBe(true);
    });
  });

  describe('Python 발신자 시뮬레이션 (재직렬화 함정)', () => {
    // Python json.dumps 기본값: 콜론·쉼표 뒤 공백 포함
    //   {"key": "value", "key2": 1}
    // JS JSON.stringify 기본값: 공백 없음
    //   {"key":"value","key2":1}
    const PAYLOAD_PYTHON = Buffer.from(
      '{"eventType": "ACTIVITY_ACHIEVED", "data": {"userId": "u-001", "activityId": "steps-10k"}, "timestamp": 1714000000, "requestId": "test-s08"}'
    );
    const SIG_PYTHON = computeHmac(PAYLOAD_PYTHON, SECRET);

    it('Python rawBody를 그대로 검증 → true', () => {
      expect(verifySignature(PAYLOAD_PYTHON, SIG_PYTHON, SECRET)).toBe(true);
    });

    it('Python rawBody를 재직렬화하면 JS와 바이트가 달라진다', () => {
      const reJson = JSON.stringify(JSON.parse(PAYLOAD_PYTHON.toString('utf8')));
      expect(PAYLOAD_PYTHON.toString()).not.toBe(reJson);
    });

    it('Python rawBody를 재직렬화한 HMAC은 원본 서명과 다르다', () => {
      const reJson    = JSON.stringify(JSON.parse(PAYLOAD_PYTHON.toString('utf8')));
      const reJsonSig = computeHmac(Buffer.from(reJson), SECRET);
      expect(reJsonSig).not.toBe(SIG_PYTHON);
    });
  });

  describe('timingSafeEqual 길이 불일치 방어', () => {
    it('짧은 서명(hex 32자 = 16바이트) → throw 없이 false 반환', () => {
      const shortSig = 'a'.repeat(32);
      expect(() => verifySignature(PAYLOAD, shortSig, SECRET)).not.toThrow();
      expect(verifySignature(PAYLOAD, shortSig, SECRET)).toBe(false);
    });

    it('길이 체크 없이 timingSafeEqual 직접 호출하면 TypeError가 발생한다', () => {
      const shortBuf = Buffer.from('a'.repeat(32), 'hex');  // 16바이트
      const expBuf   = Buffer.from(CORRECT_SIG,    'hex');  // 32바이트
      expect(() => crypto.timingSafeEqual(shortBuf, expBuf))
        .toThrow('Input buffers must have the same byte length');
    });
  });
});
