/**
 * S31 채점 — 조건 평가 로직의 테스트 전략과 플러그인 확장성 검증
 *
 * 채점 기준:
 *   · 경계값(steps=10000) / off-by-one(steps=9999) 테스트
 *   · 이벤트 데이터 누락(data={}) → 예외 없이 eligible=false
 *   · 플러그인 교체 — 같은 이벤트, 다른 전략 → 다른 결과
 *   · Mock vs Stub — isEligible() 호출 횟수 검증
 *   · PremiumConditionStrategy 경계값
 */

import {
  IConditionStrategy,
  EventConditionService,
  ActivityConditionStrategy,
  CouponConditionStrategy,
  PremiumConditionStrategy,
} from '../M5/S31_condition_test_strategy';

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function makeEvent(overrides: { eventType: string } & Record<string, unknown>) {
  return {
    userId:     'u1',
    eventCode:  1,
    data:       {} as Record<string, unknown>,
    occurredAt: new Date(),
    ...overrides,
  };
}

// ── 채점 테스트 ───────────────────────────────────────────────────────────────

describe('S31 채점 — 조건 평가 테스트 전략', () => {

  describe('[1] ActivityConditionStrategy — 경계값 테스트', () => {
    let strategy: ActivityConditionStrategy;
    beforeEach(() => { strategy = new ActivityConditionStrategy(); });

    it('TODO: steps=15000 → eligible=true', async () => {
      const result = await strategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 15_000 } }));
      expect(result.eligible).toBe(true);
    });

    it('TODO: steps=5000 → eligible=false', async () => {
      const result = await strategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 5_000 } }));
      expect(result.eligible).toBe(false);
    });

    it('TODO: reason에 "5000 < goal 10000" 포함', async () => {
      const result = await strategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 5_000 } }));
      expect(result.reason).toContain('5000 < goal 10000');
    });

    it('TODO: steps=10000 (exactly goal) → eligible=true (이상≥)', async () => {
      const result = await strategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 10_000 }, eventCode: 5 }));
      expect(result.eligible).toBe(true);
    });

    it('TODO: steps=9999 (off-by-one) → eligible=false', async () => {
      const result = await strategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 9_999 } }));
      expect(result.eligible).toBe(false);
    });
  });

  describe('[2] 이벤트 데이터 누락 방어', () => {
    it('TODO: steps 누락 → 예외 없음 (안전한 처리)', async () => {
      const strategy = new ActivityConditionStrategy();
      let errCaught = false;
      try {
        await strategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: {} }));
      } catch {
        errCaught = true;
      }
      expect(errCaught).toBe(false);
    });

    it('TODO: steps 누락 → eligible=false', async () => {
      const strategy = new ActivityConditionStrategy();
      const result   = await strategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: {} }));
      expect(result.eligible).toBe(false);
    });

    it('TODO: HEALTH_CHECK_DONE → data 없어도 eligible=true', async () => {
      const strategy = new ActivityConditionStrategy();
      const result   = await strategy.evaluate(makeEvent({ eventType: 'HEALTH_CHECK_DONE', data: {}, eventCode: 2 }));
      expect(result.eligible).toBe(true);
    });
  });

  describe('[3] tokenId 비트 인코딩 검증', () => {
    let strategy: ActivityConditionStrategy;
    beforeEach(() => { strategy = new ActivityConditionStrategy(); });

    it('TODO: WALK tokenId = (0x01 << 64) | eventCode', async () => {
      const result   = await strategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 15_000 }, eventCode: 5 }));
      const expected = (BigInt(0x01) << BigInt(64)) | BigInt(5);
      expect(result.tokenId).toBe(expected);
    });

    it('TODO: HEALTH tokenId = (0x02 << 64) | eventCode', async () => {
      const result   = await strategy.evaluate(makeEvent({ eventType: 'HEALTH_CHECK_DONE', data: {}, eventCode: 7 }));
      const expected = (BigInt(0x02) << BigInt(64)) | BigInt(7);
      expect(result.tokenId).toBe(expected);
    });
  });

  describe('[4] CouponConditionStrategy — Stub vs Mock', () => {
    it('TODO: Stub — 자격 있는 사용자 → eligible=true', async () => {
      const stubChecker = {
        async isEligible(userId: string) { return userId === 'eligible-user'; },
      };
      const strategy = new CouponConditionStrategy(stubChecker);
      const result   = await strategy.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'eligible-user', eventCode: 10 }));
      expect(result.eligible).toBe(true);
    });

    it('TODO: Stub — 자격 없는 사용자 → eligible=false', async () => {
      const stubChecker = {
        async isEligible(userId: string) { return userId === 'eligible-user'; },
      };
      const strategy = new CouponConditionStrategy(stubChecker);
      const result   = await strategy.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'no-privilege', eventCode: 10 }));
      expect(result.eligible).toBe(false);
    });

    it('TODO: Stub — reason = "user not in eligibility list"', async () => {
      const stubChecker = { async isEligible() { return false; } };
      const strategy    = new CouponConditionStrategy(stubChecker);
      const result      = await strategy.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'no-privilege', eventCode: 10 }));
      expect(result.reason).toBe('user not in eligibility list');
    });

    it('TODO: Mock — isEligible() 실제로 1회 호출됨', async () => {
      let callCount = 0;
      const mockChecker = {
        async isEligible(userId: string, _eventType: string): Promise<boolean> {
          callCount++;
          return userId === 'eligible-user';
        },
      };
      const strategy = new CouponConditionStrategy(mockChecker);
      await strategy.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'eligible-user' }));
      expect(callCount).toBe(1);
    });
  });

  describe('[5] PremiumConditionStrategy — 보험 납입 경계값', () => {
    const THRESHOLD = BigInt(100_000);
    let strategy: PremiumConditionStrategy;
    beforeEach(() => { strategy = new PremiumConditionStrategy(THRESHOLD); });

    it('TODO: 20만원 → eligible=true', async () => {
      const result = await strategy.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 200_000 }, eventCode: 1 }));
      expect(result.eligible).toBe(true);
    });

    it('TODO: 5만원 → eligible=false', async () => {
      const result = await strategy.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 50_000 }, eventCode: 1 }));
      expect(result.eligible).toBe(false);
    });

    it('TODO: 10만원 (amount == threshold) → eligible=true (이상≥)', async () => {
      const result = await strategy.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 100_000 }, eventCode: 1 }));
      expect(result.eligible).toBe(true);
    });

    it('TODO: reason에 금액 포함', async () => {
      const result = await strategy.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 50_000 }, eventCode: 1 }));
      expect(result.reason).toContain('50000');
    });
  });

  describe('[6] 플러그인 교체 통합 테스트', () => {
    it('TODO: 12000보 + 높은 기준(20000) → eligible=false', async () => {
      const strictStrategy: IConditionStrategy = {
        supportedEventTypes: ['WALK_GOAL_MET'],
        async evaluate(event) {
          const steps = Number(event.data['steps'] ?? 0);
          return { eligible: steps >= 20_000 };
        },
      };
      const svc    = new EventConditionService([strictStrategy]);
      const result = await svc.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 12_000 } }));
      expect(result.eligible).toBe(false);
    });

    it('TODO: 12000보 + 낮은 기준(무조건) → eligible=true', async () => {
      const lenientStrategy: IConditionStrategy = {
        supportedEventTypes: ['WALK_GOAL_MET'],
        async evaluate() { return { eligible: true, tokenId: 42n }; },
      };
      const svc    = new EventConditionService([lenientStrategy]);
      const result = await svc.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 12_000 } }));
      expect(result.eligible).toBe(true);
    });

    it('TODO: 전략 교체로 같은 이벤트 결과가 달라짐', async () => {
      const strictSvc = new EventConditionService([{
        supportedEventTypes: ['WALK_GOAL_MET'],
        async evaluate(event) { return { eligible: Number(event.data['steps'] ?? 0) >= 20_000 }; },
      }]);
      const lenientSvc = new EventConditionService([{
        supportedEventTypes: ['WALK_GOAL_MET'],
        async evaluate() { return { eligible: true }; },
      }]);
      const sameEvent   = makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 12_000 } });
      const strictRes   = await strictSvc.evaluate(sameEvent);
      const lenientRes  = await lenientSvc.evaluate(sameEvent);
      expect(strictRes.eligible).not.toBe(lenientRes.eligible);
    });
  });

  describe('[7] 미등록 eventType → eligible=false gracefully', () => {
    it('TODO: 미등록 이벤트 → eligible=false (예외 없음)', async () => {
      const svc    = new EventConditionService([]);
      const result = await svc.evaluate(makeEvent({ eventType: 'TOTALLY_NEW_EVENT' }));
      expect(result.eligible).toBe(false);
    });

    it('TODO: reason에 "unsupported" 포함', async () => {
      const svc    = new EventConditionService([]);
      const result = await svc.evaluate(makeEvent({ eventType: 'TOTALLY_NEW_EVENT' }));
      expect(result.reason).toMatch(/unsupported/i);
    });
  });

  describe('[8] 동일 eventType 재등록 → 나중 전략 우선', () => {
    it('TODO: 재등록 → 나중 전략 적용', async () => {
      const svc = new EventConditionService();
      svc.registerStrategy({ supportedEventTypes: ['WALK_GOAL_MET'], async evaluate() { return { eligible: false }; } });
      svc.registerStrategy({ supportedEventTypes: ['WALK_GOAL_MET'], async evaluate() { return { eligible: true, tokenId: 777n }; } });
      const result = await svc.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET' }));
      expect(result.eligible).toBe(true);
    });
  });
});
