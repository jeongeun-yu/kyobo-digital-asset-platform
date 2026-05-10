/**
 * S30 채점 — 이벤트 조건 판단 서비스 설계 · Strategy 패턴
 *
 * 채점 기준:
 *   · ActivityConditionStrategy — steps 검증 + tokenId 비트 인코딩
 *   · CouponConditionStrategy — eligibilityChecker 위임
 *   · PremiumConditionStrategy — threshold 비교
 *   · 미등록 eventType → eligible=false (예외 아님)
 *   · registerStrategy() — OCP (EventConditionService 코드 변경 없이 전략 추가)
 *   · tokenId = (productCode << 64) | eventCode 비트 레이아웃
 */

import {
  IConditionStrategy,
  EventConditionService,
  ActivityConditionStrategy,
  CouponConditionStrategy,
  PremiumConditionStrategy,
} from '../M5/S30_event_condition_strategy';

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

describe('S30 채점 — 이벤트 조건 판단 Strategy 패턴', () => {

  describe('[1] EventConditionService — 미등록 eventType', () => {
    it('TODO: 미등록 eventType → eligible=false (예외 아님)', async () => {
      const svc    = new EventConditionService();
      const result = await svc.evaluate(makeEvent({ eventType: 'TOTALLY_UNKNOWN' }));
      expect(result.eligible).toBe(false);
    });

    it('TODO: 미등록 eventType → reason에 "unsupported" 포함', async () => {
      const svc    = new EventConditionService();
      const result = await svc.evaluate(makeEvent({ eventType: 'TOTALLY_UNKNOWN' }));
      expect(result.reason).toMatch(/unsupported/i);
    });

    it('TODO: 미등록 이벤트는 throw가 아닌 eligible=false 반환 (보수적 설계)', async () => {
      const svc = new EventConditionService();
      await expect(svc.evaluate(makeEvent({ eventType: 'UNKNOWN' }))).resolves.toMatchObject({ eligible: false });
    });
  });

  describe('[2] ActivityConditionStrategy — WALK_GOAL_MET', () => {
    let svc: EventConditionService;
    beforeEach(() => {
      svc = new EventConditionService();
      svc.registerStrategy(new ActivityConditionStrategy());
    });

    it('TODO: steps=15000 → eligible=true', async () => {
      const result = await svc.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 15_000 } }));
      expect(result.eligible).toBe(true);
    });

    it('TODO: steps=5000 → eligible=false', async () => {
      const result = await svc.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 5_000 } }));
      expect(result.eligible).toBe(false);
    });

    it('TODO: steps=5000 → reason에 steps 수 포함', async () => {
      const result = await svc.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 5_000 } }));
      expect(result.reason).toContain('5000');
    });

    it('TODO: steps=10000 (경계값) → eligible=true (이상≥)', async () => {
      const result = await svc.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 10_000 }, eventCode: 5 }));
      expect(result.eligible).toBe(true);
    });

    it('TODO: tokenId = (0x01 << 64) | eventCode (비트 레이아웃)', async () => {
      const result = await svc.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 10_000 }, eventCode: 5 }));
      const expected = (BigInt(0x01) << BigInt(64)) | BigInt(5);
      expect(result.tokenId).toBe(expected);
    });
  });

  describe('[3] ActivityConditionStrategy — HEALTH_CHECK_DONE', () => {
    let svc: EventConditionService;
    beforeEach(() => {
      svc = new EventConditionService();
      svc.registerStrategy(new ActivityConditionStrategy());
    });

    it('TODO: HEALTH_CHECK_DONE → eligible=true (steps 불필요)', async () => {
      const result = await svc.evaluate(makeEvent({ eventType: 'HEALTH_CHECK_DONE', data: {}, eventCode: 2 }));
      expect(result.eligible).toBe(true);
    });

    it('TODO: HEALTH tokenId = (0x02 << 64) | eventCode', async () => {
      const result = await svc.evaluate(makeEvent({ eventType: 'HEALTH_CHECK_DONE', data: {}, eventCode: 2 }));
      const expected = (BigInt(0x02) << BigInt(64)) | BigInt(2);
      expect(result.tokenId).toBe(expected);
    });

    it('TODO: ActivityConditionStrategy가 HEALTH_CHECK_DONE을 지원함', () => {
      const strategy = new ActivityConditionStrategy();
      expect(strategy.supportedEventTypes).toContain('HEALTH_CHECK_DONE');
      expect(strategy.supportedEventTypes).toContain('WALK_GOAL_MET');
    });
  });

  describe('[4] CouponConditionStrategy — COUPON_CLAIM', () => {
    it('TODO: 자격 있는 사용자 → eligible=true', async () => {
      const svc = new EventConditionService();
      const stubChecker = {
        async isEligible(userId: string) { return userId === 'eligible-user'; },
      };
      svc.registerStrategy(new CouponConditionStrategy(stubChecker));
      const result = await svc.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'eligible-user', eventCode: 10 }));
      expect(result.eligible).toBe(true);
    });

    it('TODO: 자격 없는 사용자 → eligible=false', async () => {
      const svc = new EventConditionService();
      const stubChecker = {
        async isEligible(userId: string) { return userId === 'eligible-user'; },
      };
      svc.registerStrategy(new CouponConditionStrategy(stubChecker));
      const result = await svc.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'no-privilege', eventCode: 10 }));
      expect(result.eligible).toBe(false);
    });

    it('TODO: 자격 없는 사용자 → reason = "user not in eligibility list"', async () => {
      const svc = new EventConditionService();
      const stubChecker = { async isEligible() { return false; } };
      svc.registerStrategy(new CouponConditionStrategy(stubChecker));
      const result = await svc.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'no-privilege', eventCode: 10 }));
      expect(result.reason).toBe('user not in eligibility list');
    });

    it('TODO: CouponConditionStrategy tokenId = (0x10 << 64) | eventCode', async () => {
      const svc = new EventConditionService();
      const stubChecker = { async isEligible() { return true; } };
      svc.registerStrategy(new CouponConditionStrategy(stubChecker));
      const result = await svc.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'eligible-user', eventCode: 10 }));
      const expected = (BigInt(0x10) << BigInt(64)) | BigInt(10);
      expect(result.tokenId).toBe(expected);
    });
  });

  describe('[5] PremiumConditionStrategy — PREMIUM_PAID', () => {
    const THRESHOLD = BigInt(100_000);

    it('TODO: 20만원 → eligible=true', async () => {
      const svc = new EventConditionService();
      svc.registerStrategy(new PremiumConditionStrategy(THRESHOLD));
      const result = await svc.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 200_000 } }));
      expect(result.eligible).toBe(true);
    });

    it('TODO: 5만원 → eligible=false', async () => {
      const svc = new EventConditionService();
      svc.registerStrategy(new PremiumConditionStrategy(THRESHOLD));
      const result = await svc.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 50_000 } }));
      expect(result.eligible).toBe(false);
    });

    it('TODO: 10만원 (amount == threshold) → eligible=true (이상≥)', async () => {
      const svc = new EventConditionService();
      svc.registerStrategy(new PremiumConditionStrategy(THRESHOLD));
      const result = await svc.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 100_000 } }));
      expect(result.eligible).toBe(true);
    });

    it('TODO: amount 누락 → eligible=false (0으로 처리)', async () => {
      const svc = new EventConditionService();
      svc.registerStrategy(new PremiumConditionStrategy(THRESHOLD));
      const result = await svc.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: {} }));
      expect(result.eligible).toBe(false);
    });

    it('TODO: PremiumConditionStrategy tokenId = (0x03 << 64) | eventCode', async () => {
      const svc = new EventConditionService();
      svc.registerStrategy(new PremiumConditionStrategy(THRESHOLD));
      const result = await svc.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 200_000 }, eventCode: 3 }));
      const expected = (BigInt(0x03) << BigInt(64)) | BigInt(3);
      expect(result.tokenId).toBe(expected);
    });
  });

  describe('[6] OCP 검증 — registerStrategy() 플러그인 확장', () => {
    it('TODO: 커스텀 전략 등록 후 동작', async () => {
      const svc = new EventConditionService();
      const customStrategy: IConditionStrategy = {
        supportedEventTypes: ['CUSTOM_REWARD'],
        async evaluate() { return { eligible: true, tokenId: BigInt(0xFF), amount: 1n }; },
      };
      svc.registerStrategy(customStrategy);
      const result = await svc.evaluate(makeEvent({ eventType: 'CUSTOM_REWARD' }));
      expect(result.eligible).toBe(true);
      expect(result.tokenId).toBe(BigInt(0xFF));
    });

    it('TODO: 동일 eventType 재등록 → 나중 전략으로 덮어쓰기', async () => {
      const svc = new EventConditionService();
      const first: IConditionStrategy = {
        supportedEventTypes: ['WALK_GOAL_MET'],
        async evaluate() { return { eligible: false, reason: 'first strategy' }; },
      };
      const second: IConditionStrategy = {
        supportedEventTypes: ['WALK_GOAL_MET'],
        async evaluate() { return { eligible: true, tokenId: 999n }; },
      };
      svc.registerStrategy(first);
      svc.registerStrategy(second);
      const result = await svc.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET' }));
      expect(result.eligible).toBe(true);
    });
  });
});
