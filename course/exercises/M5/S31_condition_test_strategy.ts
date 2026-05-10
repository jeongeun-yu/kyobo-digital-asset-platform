/**
 * S31 실습 — 조건 평가 로직의 테스트 전략과 플러그인 확장성 검증
 *
 * 강의 노트: M5_S31_condition_test_strategy.md
 *
 * 실행 방법 (루트에서): npm run exercise:s31
 *
 * 목표:
 *   [1] 경계값(10000 정확히) / off-by-one(9999) 테스트
 *   [2] 이벤트 데이터 누락(data={}) → 예외 없이 eligible=false
 *   [3] 플러그인 교체 테스트 — 같은 이벤트, 다른 전략 → 다른 결과
 *   [4] Mock vs Stub 구분 — CouponStrategy eligibilityChecker
 *   [5] PremiumConditionStrategy 경계값 (amount == threshold → eligible=true)
 */

// ────────────────────────────────────────────────────────────────────────
// 인라인 구현 (S30에서 복사 — 실습 파일 간 독립 실행 보장)
// ────────────────────────────────────────────────────────────────────────

interface ActivityEvent {
  userId:     string;
  eventType:  string;
  eventCode:  number;
  data:       Record<string, unknown>;
  occurredAt: Date;
}

interface ConditionResult {
  eligible: boolean;
  tokenId?: bigint;
  amount?:  bigint;
  reason?:  string;
}

export interface IConditionStrategy {
  supportedEventTypes: string[];
  evaluate(event: ActivityEvent): Promise<ConditionResult>;
}

// ────────────────────────────────────────────────────────────────────────
// EventConditionService (완성 코드 — 수정 불필요)
// ────────────────────────────────────────────────────────────────────────

export class EventConditionService {
  private readonly strategies = new Map<string, IConditionStrategy>();

  constructor(initStrategies: IConditionStrategy[] = []) {
    for (const s of initStrategies) this.registerStrategy(s);
  }

  registerStrategy(strategy: IConditionStrategy): void {
    for (const t of strategy.supportedEventTypes) this.strategies.set(t, strategy);
  }

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    const strategy = this.strategies.get(event.eventType);
    if (!strategy) return { eligible: false, reason: `unsupported event type: ${event.eventType}` };
    return strategy.evaluate(event);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 1: ActivityConditionStrategy.evaluate()를 구현하라 (S30과 동일)
//
// 지원 이벤트: ['WALK_GOAL_MET', 'HEALTH_CHECK_DONE']
//
// WALK_GOAL_MET:
//   - steps = Number(event.data['steps'] ?? 0)
//   - steps < 10_000 → { eligible: false, reason: `steps ${steps} < goal 10000` }
//   - steps >= 10_000 → eligible=true
//
// HEALTH_CHECK_DONE:
//   - 항상 통과 (steps 불필요)
//
// tokenId: (productCode << 64n) | BigInt(event.eventCode)
//   WALK: productCode = BigInt(0x01)
//   HEALTH: productCode = BigInt(0x02)
//
// 반환: { eligible: true, tokenId, amount: 1n }
// ────────────────────────────────────────────────────────────────────────

export class ActivityConditionStrategy implements IConditionStrategy {
  readonly supportedEventTypes = ['WALK_GOAL_MET', 'HEALTH_CHECK_DONE'];
  private static readonly PRODUCT_WALK        = BigInt(0x01);
  private static readonly PRODUCT_HEALTH      = BigInt(0x02);
  private static readonly PRODUCT_CODE_SHIFT  = BigInt(64);
  private static readonly GOAL_STEPS          = 10_000;

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    return undefined as never;
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 2: CouponConditionStrategy.evaluate()를 구현하라 (S30과 동일)
//
// 지원 이벤트: ['COUPON_CLAIM', 'CAMPAIGN_REWARD']
//
// 처리:
//   - eligibilityChecker.isEligible(event.userId, event.eventType) 호출
//   - false → { eligible: false, reason: 'user not in eligibility list' }
//   - true → tokenId = (BigInt(0x10) << BigInt(64)) | BigInt(event.eventCode)
//   - 반환: { eligible: true, tokenId, amount: 1n }
// ────────────────────────────────────────────────────────────────────────

export class CouponConditionStrategy implements IConditionStrategy {
  readonly supportedEventTypes = ['COUPON_CLAIM', 'CAMPAIGN_REWARD'];
  private static readonly PRODUCT_COUPON     = BigInt(0x10);
  private static readonly PRODUCT_CODE_SHIFT = BigInt(64);

  constructor(private readonly eligibilityChecker: { isEligible(userId: string, eventType: string): Promise<boolean> }) {}

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    return undefined as never;
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 3: PremiumConditionStrategy.evaluate()를 구현하라 (S30과 동일)
//
// 지원 이벤트: ['PREMIUM_PAID']
//
// 처리:
//   - amount = BigInt(Number(event.data['amount'] ?? 0))
//   - amount < this.threshold → { eligible: false, reason: `amount ${amount} < threshold ${this.threshold}` }
//   - amount >= this.threshold → tokenId = (BigInt(0x03) << BigInt(64)) | BigInt(event.eventCode)
//   - 반환: { eligible: true, tokenId, amount: 1n }
// ────────────────────────────────────────────────────────────────────────

export class PremiumConditionStrategy implements IConditionStrategy {
  readonly supportedEventTypes = ['PREMIUM_PAID'];
  private static readonly PRODUCT_PREMIUM    = BigInt(0x03);
  private static readonly PRODUCT_CODE_SHIFT = BigInt(64);

  constructor(private readonly threshold: bigint) {}

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    return undefined as never;
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
  return { userId: 'u1', eventCode: 1, data: {}, occurredAt: new Date(), ...overrides };
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

if (require.main === module) (async () => {
  console.log('=== S31: 조건 평가 테스트 전략 · 플러그인 확장성 검증 ===\n');

  const activityStrategy = new ActivityConditionStrategy();

  // ── [1] ActivityConditionStrategy 경계값 테스트 ────────────────────────
  console.log('[검증 1] ActivityConditionStrategy — 걷기 달성 경계값');

  const walk15000 = await activityStrategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 15_000 } }));
  check('steps=15000 → eligible=true',            walk15000.eligible === true);

  const walk5000 = await activityStrategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 5_000 } }));
  check('steps=5000  → eligible=false',           walk5000.eligible === false);
  check('reason에 "5000 < goal 10000" 포함',      walk5000.reason?.includes('5000 < goal 10000') === true);

  const walk10000 = await activityStrategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 10_000 }, eventCode: 5 }));
  check('steps=10000 (exactly goal) → eligible=true (이상≥)',  walk10000.eligible === true);

  const walk9999 = await activityStrategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 9_999 } }));
  check('steps=9999  (1 below goal) → eligible=false',         walk9999.eligible === false);

  // ── [2] 이벤트 데이터 누락 방어 ─────────────────────────────────────
  console.log('\n[검증 2] 데이터 누락 방어 — data={} 에서 예외 없이 eligible=false');

  let errCaught = false;
  let nullResult: ConditionResult | undefined;
  try {
    nullResult = await activityStrategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: {} }));
  } catch {
    errCaught = true;
  }
  check('steps 누락 → 예외 없음 (안전한 처리)',    !errCaught);
  check('steps 누락 → eligible=false',             nullResult?.eligible === false);

  const healthNoData = await activityStrategy.evaluate(makeEvent({ eventType: 'HEALTH_CHECK_DONE', data: {}, eventCode: 2 }));
  check('HEALTH_CHECK_DONE → data 없어도 eligible=true', healthNoData.eligible === true);

  // ── [3] tokenId 비트 인코딩 검증 ─────────────────────────────────────
  console.log('\n[검증 3] tokenId 비트 인코딩 — (productCode << 64) | eventCode');

  const walkToken = await activityStrategy.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 15_000 }, eventCode: 5 }));
  const expected  = (BigInt(0x01) << BigInt(64)) | BigInt(5);
  check('WALK tokenId = (0x01 << 64) | 5',         walkToken.tokenId === expected);

  const healthToken = await activityStrategy.evaluate(makeEvent({ eventType: 'HEALTH_CHECK_DONE', data: {}, eventCode: 7 }));
  const expectedH   = (BigInt(0x02) << BigInt(64)) | BigInt(7);
  check('HEALTH tokenId = (0x02 << 64) | 7',       healthToken.tokenId === expectedH);

  // ── [4] CouponConditionStrategy — Stub vs Mock ────────────────────────
  console.log('\n[검증 4] CouponConditionStrategy — Stub(고정 응답)으로 외부 의존성 대체');

  const stubChecker = {
    async isEligible(userId: string) { return userId === 'eligible-user'; },
  };
  const couponStrategy = new CouponConditionStrategy(stubChecker);

  const couponPass = await couponStrategy.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'eligible-user', eventCode: 10 }));
  const couponFail = await couponStrategy.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'no-privilege', eventCode: 10 }));
  check('자격 있는 사용자 → eligible=true',           couponPass.eligible === true);
  check('자격 없는 사용자 → eligible=false',          couponFail.eligible === false);
  check('reason = "user not in eligibility list"',  couponFail.reason === 'user not in eligibility list');

  let callCount = 0;
  const mockChecker = {
    async isEligible(userId: string, eventType: string): Promise<boolean> {
      callCount++;
      return userId === 'eligible-user';
    },
  };
  const couponWithMock = new CouponConditionStrategy(mockChecker);
  await couponWithMock.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'eligible-user' }));
  check('Mock: isEligible() 실제로 1회 호출됨',      callCount === 1);

  // ── [5] PremiumConditionStrategy 경계값 ───────────────────────────────
  console.log('\n[검증 5] PremiumConditionStrategy — 보험 납입 경계값');

  const THRESHOLD       = BigInt(100_000);
  const premiumStrategy = new PremiumConditionStrategy(THRESHOLD);

  const premPass  = await premiumStrategy.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 200_000 }, eventCode: 1 }));
  const premFail  = await premiumStrategy.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 50_000 }, eventCode: 1 }));
  const premEdge  = await premiumStrategy.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 100_000 }, eventCode: 1 }));

  check('20만원 → eligible=true',                  premPass.eligible === true);
  check('5만원  → eligible=false',                 premFail.eligible === false);
  check('10만원 (amount == threshold) → eligible=true (이상≥)', premEdge.eligible === true);
  check('reason에 금액 + threshold 포함',          premFail.reason?.includes('50000') === true);

  // ── [6] 플러그인 교체 통합 테스트 ─────────────────────────────────────
  console.log('\n[검증 6] 플러그인 교체 — 같은 이벤트, 다른 전략 → 다른 결과');

  const strictStrategy: IConditionStrategy = {
    supportedEventTypes: ['WALK_GOAL_MET'],
    async evaluate(event) {
      const steps = Number(event.data['steps'] ?? 0);
      return { eligible: steps >= 20_000 };
    },
  };
  const lenientStrategy: IConditionStrategy = {
    supportedEventTypes: ['WALK_GOAL_MET'],
    async evaluate() { return { eligible: true, tokenId: 42n }; },
  };

  const sameEvent = makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 12_000 } });
  const strictSvc  = new EventConditionService([strictStrategy]);
  const lenientSvc = new EventConditionService([lenientStrategy]);

  const strictResult  = await strictSvc.evaluate(sameEvent);
  const lenientResult = await lenientSvc.evaluate(sameEvent);

  check('12000보 + 높은 기준(20000) → eligible=false',   strictResult.eligible === false);
  check('12000보 + 낮은 기준(무조건) → eligible=true',   lenientResult.eligible === true);
  check('전략 교체로 같은 이벤트 결과가 달라짐',           strictResult.eligible !== lenientResult.eligible);

  // ── [7] 미등록 이벤트 타입 → eligible=false gracefully ─────────────────
  console.log('\n[검증 7] 미등록 eventType → eligible=false (예외 없이 안전 처리)');

  const emptySvc = new EventConditionService([]);
  const unknownResult = await emptySvc.evaluate(makeEvent({ eventType: 'TOTALLY_NEW_EVENT' }));
  check('미등록 이벤트 → eligible=false',            unknownResult.eligible === false);
  check('reason에 "unsupported" 포함',              unknownResult.reason?.includes('unsupported') === true);

  // ── [8] 동일 eventType 재등록 → 나중 전략 우선 ────────────────────────
  console.log('\n[검증 8] 동일 eventType 재등록 → 나중 전략으로 덮어쓰기');

  const overrideSvc = new EventConditionService();
  overrideSvc.registerStrategy({ supportedEventTypes: ['WALK_GOAL_MET'], async evaluate() { return { eligible: false }; } });
  overrideSvc.registerStrategy({ supportedEventTypes: ['WALK_GOAL_MET'], async evaluate() { return { eligible: true, tokenId: 777n }; } });

  const overrideResult = await overrideSvc.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET' }));
  check('재등록 → 나중 전략 적용',                    overrideResult.eligible === true);

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S31 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. 조건 미충족 → eligible=false + reason 포함 — 이유 추적 가능');
  console.log('  2. 경계값(steps=10000) → eligible=true (이상≥) — off-by-one 실수 방지');
  console.log('  3. 데이터 누락(data={}) → 예외 없이 eligible=false — 방어적 설계');
  console.log('  4. Stub=고정 응답 / Mock=호출 사실 검증 — 목적에 따라 선택');
  console.log('  5. 플러그인 교체 → 서로 다른 결과 — "전략 교체 가능" 주장의 근거');
  console.log('  6. false positive 방지가 최우선 — 미발행은 수동 재처리 가능, 과발행은 불가');
})();
