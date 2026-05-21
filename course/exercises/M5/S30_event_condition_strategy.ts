/**
 * S30 실습 — 이벤트 조건 판단 서비스 설계 · Strategy 패턴 적용
 *
 * 강의 노트: M5_S30_event_condition_strategy.md
 *
 * 실행 방법 (루트에서): npm run exercise:s30
 *
 * 목표:
 *   [1] IConditionStrategy 인터페이스 + EventConditionService
 *   [2] ActivityConditionStrategy — steps 검증 + tokenId 비트 인코딩
 *   [3] CouponConditionStrategy — eligibility 외부 서비스 조회
 *   [4] PremiumConditionStrategy — 보험 납입 금액 threshold 비교
 *   [5] registerStrategy() — OCP 준수 확인 (EventConditionService 코드 변경 없음)
 */

// ────────────────────────────────────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────────────────────────────────────

interface ActivityEvent {
  userId:      string;
  eventType:   string;
  eventCode:   number;
  data:        Record<string, unknown>;
  occurredAt:  Date;
}

interface ConditionResult {
  eligible: boolean;
  tokenId?: bigint;
  amount?:  bigint;
  reason?:  string;
}

// ────────────────────────────────────────────────────────────────────────
// Strategy 인터페이스 (완성 코드 — 수정 불필요)
//
// 새 이벤트 추가 시: EventConditionService는 건드리지 않는다.
// 새 IConditionStrategy 구현체를 만들고 registerStrategy() 한 줄이면 끝.
// → OCP(개방-폐쇄 원칙): 확장에 열려있고, 수정에는 닫혀있다.
// ────────────────────────────────────────────────────────────────────────

export interface IConditionStrategy {
  supportedEventTypes: string[];
  evaluate(event: ActivityEvent): Promise<ConditionResult>;
}

// ────────────────────────────────────────────────────────────────────────
// EventConditionService (완성 코드 — 수정 불필요)
//
// 이 파일을 수정하지 않고 새 전략을 추가하는 것이 OCP 핵심.
// ────────────────────────────────────────────────────────────────────────

export class EventConditionService {
  private readonly strategies = new Map<string, IConditionStrategy>();

  /** 전략 등록 — 같은 eventType 재등록 시 나중 전략이 우선 */
  registerStrategy(strategy: IConditionStrategy): void {
    for (const eventType of strategy.supportedEventTypes) {
      this.strategies.set(eventType, strategy);
    }
  }

  /**
   * 이벤트 조건 판단
   * 미등록 eventType → eligible=false (예외 아님 — false positive 위험 차단)
   * false positive가 false negative보다 훨씬 위험하다:
   *   false positive = 조건 미충족 사용자에게 NFT 발행 → 온체인 영구 기록, 취소 불가
   *   false negative = 조건 충족 사용자에게 미발행 → 재발행 가능
   */
  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    const strategy = this.strategies.get(event.eventType);
    if (!strategy) {
      return { eligible: false, reason: `unsupported event type: ${event.eventType}` };
    }
    return strategy.evaluate(event);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 1: ActivityConditionStrategy.evaluate()를 구현하라
//
// 지원 이벤트: ['WALK_GOAL_MET', 'HEALTH_CHECK_DONE']
//
// WALK_GOAL_MET 처리:
//   - event.data['steps']를 Number로 변환 (없으면 0)
//   - steps < 10_000 → { eligible: false, reason: `steps ${steps} < goal 10000` }
//   - steps >= 10_000 → eligible=true
//
// HEALTH_CHECK_DONE 처리:
//   - steps 체크 없이 항상 통과 (완료 여부만 체크)
//
// tokenId 비트 인코딩 (M6 KyoboNFT.sol과 반드시 동기화):
//   tokenId = (productCode << 64n) | BigInt(event.eventCode)
//   WALK:   productCode = BigInt(0x01)
//   HEALTH: productCode = BigInt(0x02)
//
// 반환: { eligible: true, tokenId, amount: 1n }
// ────────────────────────────────────────────────────────────────────────

export class ActivityConditionStrategy implements IConditionStrategy {
  readonly supportedEventTypes = ['WALK_GOAL_MET', 'HEALTH_CHECK_DONE'];

  private static readonly PRODUCT_WALK         = BigInt(0x01);
  private static readonly PRODUCT_HEALTH       = BigInt(0x02);
  private static readonly PRODUCT_CODE_SHIFT   = BigInt(64);
  private static readonly GOAL_STEPS           = 10_000;

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    if (event.eventType === 'WALK_GOAL_MET') {
      const steps = Number(event.data['steps'] ?? 0);
      if (steps < ActivityConditionStrategy.GOAL_STEPS) {
        return { eligible: false, reason: `steps ${steps} < goal ${ActivityConditionStrategy.GOAL_STEPS}` };
      }
      const tokenId = (ActivityConditionStrategy.PRODUCT_WALK << ActivityConditionStrategy.PRODUCT_CODE_SHIFT) | BigInt(event.eventCode);
      return { eligible: true, tokenId, amount: 1n };
    }

    // HEALTH_CHECK_DONE — 완료 여부만 체크, steps 무관
    const tokenId = (ActivityConditionStrategy.PRODUCT_HEALTH << ActivityConditionStrategy.PRODUCT_CODE_SHIFT) | BigInt(event.eventCode);
    return { eligible: true, tokenId, amount: 1n };
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 2: CouponConditionStrategy.evaluate()를 구현하라
//
// 지원 이벤트: ['COUPON_CLAIM', 'CAMPAIGN_REWARD']
//
// 처리 순서:
//   - eligibilityChecker.isEligible(event.userId, event.eventType) 호출
//   - eligible === false → { eligible: false, reason: 'user not in eligibility list' }
//   - eligible === true → tokenId 계산 후 반환
//
// tokenId 비트 인코딩:
//   tokenId = (BigInt(0x10) << BigInt(64)) | BigInt(event.eventCode)
//
// 반환: { eligible: true, tokenId, amount: 1n }
// ────────────────────────────────────────────────────────────────────────

interface EligibilityChecker {
  isEligible(userId: string, eventType: string): Promise<boolean>;
}

export class CouponConditionStrategy implements IConditionStrategy {
  readonly supportedEventTypes = ['COUPON_CLAIM', 'CAMPAIGN_REWARD'];

  private static readonly PRODUCT_COUPON      = BigInt(0x10);
  private static readonly PRODUCT_CODE_SHIFT  = BigInt(64);

  constructor(private readonly eligibilityChecker: EligibilityChecker) {}

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    const eligible = await this.eligibilityChecker.isEligible(event.userId, event.eventType);
    if (!eligible) {
      return { eligible: false, reason: 'user not in eligibility list' };
    }
    const tokenId = (CouponConditionStrategy.PRODUCT_COUPON << CouponConditionStrategy.PRODUCT_CODE_SHIFT) | BigInt(event.eventCode);
    return { eligible: true, tokenId, amount: 1n };
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 3: PremiumConditionStrategy.evaluate()를 구현하라
//
// 지원 이벤트: ['PREMIUM_PAID']
//
// 처리 순서:
//   - event.data['amount']를 Number로 변환 후 BigInt로 변환 (없으면 0)
//   - amount < this.threshold → { eligible: false, reason: `amount ${amount} < threshold ${this.threshold}` }
//   - amount >= this.threshold → tokenId 계산 후 반환
//
// tokenId 비트 인코딩:
//   tokenId = (BigInt(0x03) << BigInt(64)) | BigInt(event.eventCode)
//
// 반환: { eligible: true, tokenId, amount: 1n }
// ────────────────────────────────────────────────────────────────────────

export class PremiumConditionStrategy implements IConditionStrategy {
  readonly supportedEventTypes = ['PREMIUM_PAID'];

  private static readonly PRODUCT_PREMIUM     = BigInt(0x03);
  private static readonly PRODUCT_CODE_SHIFT  = BigInt(64);

  constructor(private readonly threshold: bigint) {}

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    const amount = BigInt(Number(event.data['amount'] ?? 0));
    if (amount < this.threshold) {
      return { eligible: false, reason: `amount ${amount} < threshold ${this.threshold}` };
    }
    const tokenId = (PremiumConditionStrategy.PRODUCT_PREMIUM << PremiumConditionStrategy.PRODUCT_CODE_SHIFT) | BigInt(event.eventCode);
    return { eligible: true, tokenId, amount: 1n };
  }
}

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

function makeEvent(overrides: Partial<ActivityEvent> & Pick<ActivityEvent, 'eventType'>): ActivityEvent {
  return {
    userId:     'u1',
    eventCode:  1,
    data:       {},
    occurredAt: new Date(),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

if (require.main === module) (async () => {
  console.log('=== S30: 이벤트 조건 판단 — Strategy 패턴 ===\n');

  // ── [1] EventConditionService + 미등록 이벤트 ────────────────────────
  console.log('[검증 1] 미등록 eventType → eligible=false (예외 아님)');
  const service = new EventConditionService();
  const unknown = await service.evaluate(makeEvent({ eventType: 'TOTALLY_UNKNOWN' }));
  check('미등록 → eligible=false',               unknown.eligible === false);
  check('reason에 "unsupported" 포함',           unknown.reason?.includes('unsupported') === true);

  // ── [2] ActivityConditionStrategy — 걷기 달성 ─────────────────────────
  console.log('\n[검증 2] ActivityConditionStrategy — WALK_GOAL_MET');
  service.registerStrategy(new ActivityConditionStrategy());

  const walkPass = await service.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 15_000 } }));
  const walkFail = await service.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 5_000 } }));
  const walkEdge = await service.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 10_000 }, eventCode: 5 }));

  check('15000보 → eligible=true',               walkPass.eligible === true);
  check('5000보  → eligible=false',              walkFail.eligible === false);
  check('reason에 steps 수 포함',                walkFail.reason?.includes('5000') === true);
  check('10000보 (경계값) → eligible=true',       walkEdge.eligible === true);

  const expectedTokenId = (BigInt(0x01) << BigInt(64)) | BigInt(5);
  check('tokenId = (0x01 << 64) | eventCode',    walkEdge.tokenId === expectedTokenId);

  // ── [3] ActivityConditionStrategy — 건강검진 ──────────────────────────
  console.log('\n[검증 3] ActivityConditionStrategy — HEALTH_CHECK_DONE');
  const health = await service.evaluate(makeEvent({ eventType: 'HEALTH_CHECK_DONE', data: {}, eventCode: 2 }));
  check('HEALTH_CHECK_DONE → eligible=true',     health.eligible === true);
  const healthTokenId = (BigInt(0x02) << BigInt(64)) | BigInt(2);
  check('HEALTH tokenId = (0x02 << 64) | 2',     health.tokenId === healthTokenId);

  // ── [4] CouponConditionStrategy ───────────────────────────────────────
  console.log('\n[검증 4] CouponConditionStrategy — COUPON_CLAIM');
  const stubChecker: EligibilityChecker = {
    async isEligible(userId) { return userId === 'eligible-user'; },
  };
  service.registerStrategy(new CouponConditionStrategy(stubChecker));

  const couponPass = await service.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'eligible-user', eventCode: 10 }));
  const couponFail = await service.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'no-privilege', eventCode: 10 }));

  check('자격 있는 사용자 → eligible=true',       couponPass.eligible === true);
  check('자격 없는 사용자 → eligible=false',      couponFail.eligible === false);
  check('reason: "user not in eligibility list"', couponFail.reason === 'user not in eligibility list');

  // ── [5] PremiumConditionStrategy ─────────────────────────────────────
  console.log('\n[검증 5] PremiumConditionStrategy — PREMIUM_PAID (threshold: 10만원)');
  const THRESHOLD = BigInt(100_000);
  service.registerStrategy(new PremiumConditionStrategy(THRESHOLD));

  const premPass  = await service.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 200_000 } }));
  const premFail  = await service.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 50_000 } }));
  const premEdge  = await service.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 100_000 } }));
  const premNull  = await service.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: {} }));

  check('20만원 → eligible=true',                premPass.eligible === true);
  check('5만원  → eligible=false',               premFail.eligible === false);
  check('10만원 (경계값) → eligible=true (≥)',    premEdge.eligible === true);
  check('amount 누락 → eligible=false (0으로 처리)', premNull.eligible === false);

  // ── [6] OCP 검증 ──────────────────────────────────────────────────────
  console.log('\n[검증 6] OCP — 새 전략 등록 시 EventConditionService 코드 무변경');
  const customStrategy: IConditionStrategy = {
    supportedEventTypes: ['CUSTOM_REWARD'],
    async evaluate() { return { eligible: true, tokenId: BigInt(0xFF), amount: 1n }; },
  };
  service.registerStrategy(customStrategy);

  const custom = await service.evaluate(makeEvent({ eventType: 'CUSTOM_REWARD' }));
  check('커스텀 전략 등록 후 동작',                custom.eligible === true);
  check('커스텀 tokenId = 0xFF',                   custom.tokenId === BigInt(0xFF));

  // ── [7] 동일 eventType 재등록 → 나중 전략으로 덮어쓰기 ────────────────
  console.log('\n[검증 7] 동일 eventType 재등록 → 나중 전략 우선');
  const newService = new EventConditionService();
  const first: IConditionStrategy = {
    supportedEventTypes: ['WALK_GOAL_MET'],
    async evaluate() { return { eligible: false, reason: 'first strategy' }; },
  };
  const second: IConditionStrategy = {
    supportedEventTypes: ['WALK_GOAL_MET'],
    async evaluate() { return { eligible: true, tokenId: 999n }; },
  };
  newService.registerStrategy(first);
  newService.registerStrategy(second);
  const overridden = await newService.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET' }));
  check('재등록 → 나중 전략 적용',                  overridden.eligible === true);

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S30 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. Strategy 패턴 → OCP: 새 이벤트 추가 시 EventConditionService 수정 없음');
  console.log('  2. false positive > false negative: 발행된 NFT는 온체인 영구 기록, 취소 불가');
  console.log('  3. 미등록 eventType → eligible=false (예외 아님) — 보수적 설계');
  console.log('  4. tokenId 비트 레이아웃: (productCode << 64) | eventCode — M6 Solidity와 동기화 필수');
  console.log('  5. ActivityConditionStrategy: WALK=0x01, HEALTH=0x02 / Coupon=0x10 / Premium=0x03');
})();
