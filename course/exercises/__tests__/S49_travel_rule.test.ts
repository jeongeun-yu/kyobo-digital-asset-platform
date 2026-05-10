/**
 * S49 채점 — Travel Rule: 100만원 경계값 검증과 proposeTx 통합
 *
 * 채점 기준:
 *   · 경계값 999,999 / 1,000,000 / 1,000,001 — 특금법 >= 연산자 확인
 *   · TravelRuleRequiredError: name, amount 속성, 메시지 포함
 *   · 필드 누락(originatorName, beneficiaryName 빈값) → 에러
 *   · proposeTx 통합 검증
 */

import {
  TravelRuleData,
  TravelRuleRequiredError,
  checkTravelRule,
  SimpleProposeService,
  validTravelRule,
} from '../M8/S49_travel_rule';

// ─── 유효한 Travel Rule 데이터 픽스처 ────────────────────────────────────────

const VALID_TR: TravelRuleData = validTravelRule;

// ─── 채점 테스트 ─────────────────────────────────────────────────────────────

describe('S49 채점 — Travel Rule', () => {

  describe('TODO: 경계값 999,999 / 1,000,000 / 1,000,001', () => {
    it('0원 → 통과 (에러 없음)', () => {
      expect(() => checkTravelRule(0n, null)).not.toThrow();
    });

    it('500,000원 → 통과', () => {
      expect(() => checkTravelRule(500_000n, undefined)).not.toThrow();
    });

    it('999,999원 → 통과 (미만, 경계 미포함)', () => {
      expect(() => checkTravelRule(999_999n, null)).not.toThrow();
    });

    it('1,000,000원 + travelRuleData 없음 → TravelRuleRequiredError (이상 포함)', () => {
      expect(() => checkTravelRule(1_000_000n, null)).toThrow(TravelRuleRequiredError);
    });

    it('1,000,001원 + travelRuleData 없음 → TravelRuleRequiredError', () => {
      expect(() => checkTravelRule(1_000_001n, undefined)).toThrow(TravelRuleRequiredError);
    });

    it('5,000,000원 + travelRuleData 없음 → TravelRuleRequiredError', () => {
      expect(() => checkTravelRule(5_000_000n, null)).toThrow(TravelRuleRequiredError);
    });
  });

  describe('TODO: TravelRuleRequiredError 속성 검증', () => {
    it('error.name === "TravelRuleRequiredError"', () => {
      let caught: unknown;
      try { checkTravelRule(1_000_000n, null); } catch (e) { caught = e; }
      expect((caught as Error).name).toBe('TravelRuleRequiredError');
    });

    it('error.amount === 던져진 금액', () => {
      let caught: unknown;
      try { checkTravelRule(1_500_000n, null); } catch (e) { caught = e; }
      expect((caught as TravelRuleRequiredError).amount).toBe(1_500_000n);
    });

    it('에러 메시지에 amount 포함', () => {
      let caught: unknown;
      try { checkTravelRule(1_500_000n, null); } catch (e) { caught = e; }
      expect((caught as Error).message).toContain('1500000');
    });

    it('TravelRuleRequiredError 는 Error 의 인스턴스', () => {
      let caught: unknown;
      try { checkTravelRule(1_000_000n, null); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(Error);
    });
  });

  describe('TODO: 필드 누락 검증', () => {
    it('originatorName 빈 문자열 → 에러 (originatorName 언급)', () => {
      expect(() =>
        checkTravelRule(1_000_000n, { ...VALID_TR, originatorName: '' }),
      ).toThrow(/originatorName/i);
    });

    it('originatorName 공백만 → 에러', () => {
      expect(() =>
        checkTravelRule(1_000_000n, { ...VALID_TR, originatorName: '   ' }),
      ).toThrow(/originatorName/i);
    });

    it('beneficiaryName 빈 문자열 → 에러 (beneficiaryName 언급)', () => {
      expect(() =>
        checkTravelRule(1_000_000n, { ...VALID_TR, beneficiaryName: '' }),
      ).toThrow(/beneficiaryName/i);
    });

    it('originatorVasp 빈 문자열 → 에러', () => {
      expect(() =>
        checkTravelRule(1_000_000n, { ...VALID_TR, originatorVasp: '' }),
      ).toThrow(/originatorVasp/i);
    });

    it('beneficiaryVasp 빈 문자열 → 에러', () => {
      expect(() =>
        checkTravelRule(1_000_000n, { ...VALID_TR, beneficiaryVasp: '' }),
      ).toThrow(/beneficiaryVasp/i);
    });

    it('currency != KRW → 에러 (currency 언급)', () => {
      expect(() =>
        checkTravelRule(1_000_000n, { ...VALID_TR, currency: 'USD' }),
      ).toThrow(/currency/i);
    });
  });

  describe('유효한 travelRuleData 있으면 통과', () => {
    it('1,000,000원 + validTravelRule → 통과', () => {
      expect(() => checkTravelRule(1_000_000n, VALID_TR)).not.toThrow();
    });

    it('10,000,000원 + validTravelRule → 통과', () => {
      expect(() => checkTravelRule(10_000_000n, VALID_TR)).not.toThrow();
    });

    it('999,999원 이하는 travelRuleData 있어도 없어도 통과', () => {
      expect(() => checkTravelRule(500_000n, VALID_TR)).not.toThrow();
      expect(() => checkTravelRule(500_000n, undefined)).not.toThrow();
    });
  });

  describe('TODO: proposeTx 통합 — 100만원 이상 TX 제안 시 Travel Rule 연동', () => {
    it('100만원 + travelRuleData 없음 → proposeTx TravelRuleRequiredError', async () => {
      const svc = new SimpleProposeService();
      await expect(
        svc.proposeTx('admin', { to: '0x1', value: 1_000_000n, data: '0x', operation: 0 }),
      ).rejects.toMatchObject({ name: 'TravelRuleRequiredError' });
    });

    it('100만원 + validTravelRule → 정상 제안 (PENDING_SIGNATURES)', async () => {
      const svc = new SimpleProposeService();
      const tx = await svc.proposeTx('admin', {
        to: '0x1', value: 1_000_000n, data: '0x', operation: 0,
        travelRuleData: VALID_TR,
      });
      expect(tx.status).toBe('PENDING_SIGNATURES');
    });

    it('params.travelRuleData 저장됨', async () => {
      const svc = new SimpleProposeService();
      const tx = await svc.proposeTx('admin', {
        to: '0x1', value: 1_000_000n, data: '0x', operation: 0,
        travelRuleData: VALID_TR,
      });
      expect(tx.params.travelRuleData).not.toBeNull();
    });

    it('999,999원 → travelRuleData 없어도 정상 제안', async () => {
      const svc = new SimpleProposeService();
      const tx = await svc.proposeTx('admin', {
        to: '0x1', value: 999_999n, data: '0x', operation: 0,
      });
      expect(tx.status).toBe('PENDING_SIGNATURES');
    });

    it('0원 TX (pause 호출) → travelRuleData 없어도 정상 제안', async () => {
      const svc = new SimpleProposeService();
      const tx = await svc.proposeTx('admin', {
        to: '0x1', value: 0n, data: '0x8456cb59', operation: 0,
      });
      expect(tx.status).toBe('PENDING_SIGNATURES');
    });
  });
});
