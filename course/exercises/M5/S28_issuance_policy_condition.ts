/**
 * S28 실습 — IssuancePolicyService + EventConditionService · Strategy 패턴
 *
 * 사전 준비:
 *   npm run exercise:s27:db:up      ← S27과 같은 DB 사용
 *
 * 실행:
 *   npm run exercise:s28            → 전체 실행
 *   npm run exercise:s28:1          → [1] IssuancePolicyService — DB 정책 조회
 *   npm run exercise:s28:2          → [2] EventConditionService — 미등록 이벤트 → false
 *   npm run exercise:s28:3          → [3] ActivityConditionStrategy — 걸음수 검증
 *   npm run exercise:s28:4          → [4] ActivityConditionStrategy — tokenId 비트 인코딩
 *   npm run exercise:s28:5          → [5] CouponConditionStrategy — eligibility 조회
 *   npm run exercise:s28:6          → [6] PremiumConditionStrategy — threshold 비교
 *   npm run exercise:s28:7          → [7] OCP 검증 — 새 전략 등록 시 서비스 수정 없음
 */

import { Pool } from 'pg';

// ── 타입 정의 ─────────────────────────────────────────────────────────────────

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

interface IssuancePolicy {
  eventType: string;
  tokenId:   bigint;
  amount:    bigint;
}

// ── NoPolicyError ─────────────────────────────────────────────────────────────

export class NoPolicyError extends Error {
  constructor(eventType: string) {
    super(`발행 정책 없음: ${eventType}`);
    this.name = 'NoPolicyError';
  }
}

// ── IssuancePolicyService — 실제 PostgreSQL 기반 ──────────────────────────────
//
// issuance_policies 테이블에서 eventType별 tokenId·amount 조회.
// IssuerService는 이 서비스를 통해 간접 접근한다 (DB 직접 접근 금지).

export class IssuancePolicyService {
  constructor(private readonly pool: Pool) {}

  async getPolicy(eventType: string): Promise<IssuancePolicy> {
    const res = await this.pool.query<{ event_type: string; token_id: string; amount: string }>(
      `SELECT event_type, token_id, amount FROM issuance_policies WHERE event_type = $1`,
      [eventType],
    );
    console.log(`  [DB] SELECT token_id, amount FROM issuance_policies WHERE event_type='${eventType}'`);
    console.log(`       → rowCount=${res.rowCount}`);

    if (!res.rowCount) throw new NoPolicyError(eventType);

    const row = res.rows[0]!;
    const policy = {
      eventType: row.event_type,
      tokenId:   BigInt(row.token_id),
      amount:    BigInt(row.amount),
    };
    console.log(`       → tokenId=${policy.tokenId}  amount=${policy.amount}`);
    return policy;
  }

  async registerPolicy(p: { eventType: string; tokenId: bigint; amount: bigint }): Promise<void> {
    await this.pool.query(
      `INSERT INTO issuance_policies (event_type, token_id, amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_type) DO UPDATE
         SET token_id = EXCLUDED.token_id,
             amount   = EXCLUDED.amount`,
      [p.eventType, p.tokenId.toString(), p.amount.toString()],
    );
    console.log(`  [DB] UPSERT issuance_policies event_type='${p.eventType}'  token_id=${p.tokenId}  amount=${p.amount}`);
  }
}

// ── IConditionStrategy 인터페이스 ─────────────────────────────────────────────
//
// 새 이벤트 추가 시: EventConditionService는 건드리지 않는다.
// 새 IConditionStrategy 구현체를 만들고 registerStrategy() 한 줄이면 끝.
// → OCP(개방-폐쇄 원칙): 확장에 열려있고, 수정에는 닫혀있다.

export interface IConditionStrategy {
  supportedEventTypes: string[];
  evaluate(event: ActivityEvent): Promise<ConditionResult>;
}

// ── EventConditionService ─────────────────────────────────────────────────────
//
// 전략 미등록 eventType → eligible=false (예외 아님)
// false positive가 false negative보다 훨씬 위험하다:
//   false positive = 조건 미충족 사용자에게 NFT 발행 → 온체인 영구 기록, 취소 불가
//   false negative = 조건 충족 사용자에게 미발행 → 재발행 가능

export class EventConditionService {
  private readonly strategies = new Map<string, IConditionStrategy>();

  registerStrategy(strategy: IConditionStrategy): void {
    for (const eventType of strategy.supportedEventTypes) {
      this.strategies.set(eventType, strategy);
      console.log(`  [STRATEGY] 등록: eventType='${eventType}'  strategy=${strategy.constructor.name}`);
    }
  }

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    const strategy = this.strategies.get(event.eventType);
    if (!strategy) {
      const result = { eligible: false, reason: `unsupported event type: ${event.eventType}` };
      console.log(`  [CONDITION] eventType='${event.eventType}'  → eligible=false (미등록 전략)`);
      return result;
    }
    const result = await strategy.evaluate(event);
    console.log(`  [CONDITION] eventType='${event.eventType}'  userId='${event.userId}'  → eligible=${result.eligible}${result.tokenId ? `  tokenId=${result.tokenId}` : ''}${result.reason ? `  reason=${result.reason}` : ''}`);
    return result;
  }
}

// ── ActivityConditionStrategy ─────────────────────────────────────────────────
//
// WALK_GOAL_MET:  steps >= 10,000 → eligible
// HEALTH_CHECK_DONE: 완료 여부만 체크 (steps 무관)
// tokenId = (productCode << 64n) | BigInt(eventCode)
//   WALK:   productCode = 0x01n
//   HEALTH: productCode = 0x02n

export class ActivityConditionStrategy implements IConditionStrategy {
  readonly supportedEventTypes = ['WALK_GOAL_MET', 'HEALTH_CHECK_DONE'];

  private static readonly PRODUCT_WALK   = BigInt(0x01);
  private static readonly PRODUCT_HEALTH = BigInt(0x02);
  private static readonly SHIFT          = BigInt(64);
  private static readonly GOAL_STEPS     = 10_000;

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    if (event.eventType === 'WALK_GOAL_MET') {
      const steps = Number(event.data['steps'] ?? 0);
      if (steps < ActivityConditionStrategy.GOAL_STEPS) {
        return { eligible: false, reason: `steps ${steps} < goal ${ActivityConditionStrategy.GOAL_STEPS}` };
      }
      const tokenId = (ActivityConditionStrategy.PRODUCT_WALK << ActivityConditionStrategy.SHIFT) | BigInt(event.eventCode);
      return { eligible: true, tokenId, amount: 1n };
    }

    // HEALTH_CHECK_DONE — 완료 여부만 체크
    const tokenId = (ActivityConditionStrategy.PRODUCT_HEALTH << ActivityConditionStrategy.SHIFT) | BigInt(event.eventCode);
    return { eligible: true, tokenId, amount: 1n };
  }
}

// ── EligibilityChecker 인터페이스 ────────────────────────────────────────────

interface EligibilityChecker {
  isEligible(userId: string, eventType: string): Promise<boolean>;
}

// ── CouponConditionStrategy ───────────────────────────────────────────────────
//
// eligibilityChecker.isEligible() 외부 서비스 조회 후 판단
// tokenId = (0x10n << 64n) | BigInt(eventCode)

export class CouponConditionStrategy implements IConditionStrategy {
  readonly supportedEventTypes = ['COUPON_CLAIM', 'CAMPAIGN_REWARD'];

  private static readonly PRODUCT_COUPON = BigInt(0x10);
  private static readonly SHIFT          = BigInt(64);

  constructor(private readonly eligibilityChecker: EligibilityChecker) {}

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    const eligible = await this.eligibilityChecker.isEligible(event.userId, event.eventType);
    if (!eligible) {
      return { eligible: false, reason: 'user not in eligibility list' };
    }
    const tokenId = (CouponConditionStrategy.PRODUCT_COUPON << CouponConditionStrategy.SHIFT) | BigInt(event.eventCode);
    return { eligible: true, tokenId, amount: 1n };
  }
}

// ── PremiumConditionStrategy ──────────────────────────────────────────────────
//
// amount >= threshold → eligible
// tokenId = (0x03n << 64n) | BigInt(eventCode)

export class PremiumConditionStrategy implements IConditionStrategy {
  readonly supportedEventTypes = ['PREMIUM_PAID'];

  private static readonly PRODUCT_PREMIUM = BigInt(0x03);
  private static readonly SHIFT           = BigInt(64);

  constructor(private readonly threshold: bigint) {}

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    const amount = BigInt(Number(event.data['amount'] ?? 0));
    if (amount < this.threshold) {
      return { eligible: false, reason: `amount ${amount} < threshold ${this.threshold}` };
    }
    const tokenId = (PremiumConditionStrategy.PRODUCT_PREMIUM << PremiumConditionStrategy.SHIFT) | BigInt(event.eventCode);
    return { eligible: true, tokenId, amount: 1n };
  }
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ActivityEvent> & Pick<ActivityEvent, 'eventType'>): ActivityEvent {
  return { userId: 'K-28001', eventCode: 1, data: {}, occurredAt: new Date(), ...overrides };
}

async function showPolicies(pool: Pool): Promise<void> {
  const res = await pool.query(`SELECT id, event_type, token_id, amount, created_at FROM issuance_policies ORDER BY id`);
  console.table(res.rows);
}

// ── 섹션 함수 ─────────────────────────────────────────────────────────────────

async function section1(pool: Pool): Promise<void> {
  console.log('[1] IssuancePolicyService — DB 정책 조회');
  const svc = new IssuancePolicyService(pool);

  // 정책 등록
  const walkTokenId = (BigInt(0x01) << BigInt(64)) | BigInt(1);
  await svc.registerPolicy({ eventType: 'WALK_GOAL_MET',    tokenId: walkTokenId,             amount: 1n });
  await svc.registerPolicy({ eventType: 'HEALTH_CHECK_DONE', tokenId: BigInt(0x02) << BigInt(64), amount: 1n });
  await showPolicies(pool);

  // 정책 조회
  const policy = await svc.getPolicy('WALK_GOAL_MET');
  console.log('  getPolicy(WALK_GOAL_MET):', policy);

  // 미등록 정책 → NoPolicyError
  try {
    await svc.getPolicy('UNKNOWN_EVENT');
  } catch (err) {
    console.log('  미등록 이벤트 에러:', (err as Error).constructor.name, (err as Error).message);
  }
}

async function section2(_pool: Pool): Promise<void> {
  console.log('[2] EventConditionService — 미등록 이벤트 → eligible=false');
  const service = new EventConditionService();

  const result = await service.evaluate(makeEvent({ eventType: 'TOTALLY_UNKNOWN' }));
  console.log('  result:', result);
  console.log('  eligible:', result.eligible, '← false (예외 아님)');
  console.log('  reason:', result.reason);
}

async function section3(_pool: Pool): Promise<void> {
  console.log('[3] ActivityConditionStrategy — WALK_GOAL_MET 걸음수 검증');
  const service = new EventConditionService();
  service.registerStrategy(new ActivityConditionStrategy());

  const pass = await service.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 15_000 } }));
  const fail = await service.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 5_000 } }));
  const edge = await service.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 10_000 } }));

  console.log('  15000보:', pass.eligible, '← true');
  console.log('   5000보:', fail.eligible, `← false  reason: ${fail.reason}`);
  console.log('  10000보 (경계값):', edge.eligible, '← true (≥ 10000)');
}

async function section4(_pool: Pool): Promise<void> {
  console.log('[4] ActivityConditionStrategy — tokenId 비트 인코딩');
  const service = new EventConditionService();
  service.registerStrategy(new ActivityConditionStrategy());

  const walkResult   = await service.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET',    data: { steps: 12_000 }, eventCode: 5 }));
  const healthResult = await service.evaluate(makeEvent({ eventType: 'HEALTH_CHECK_DONE', data: {},               eventCode: 2 }));

  const expectedWalk   = (BigInt(0x01) << BigInt(64)) | BigInt(5);
  const expectedHealth = (BigInt(0x02) << BigInt(64)) | BigInt(2);

  console.log(`  WALK   tokenId: ${walkResult.tokenId}`);
  console.log(`  기댓값:         ${expectedWalk}  일치: ${walkResult.tokenId === expectedWalk}`);
  console.log(`  HEALTH tokenId: ${healthResult.tokenId}`);
  console.log(`  기댓값:         ${expectedHealth}  일치: ${healthResult.tokenId === expectedHealth}`);
  console.log(`  구조: (productCode << 64) | eventCode`);
  console.log(`    WALK   productCode = 0x01 = ${BigInt(0x01)}`);
  console.log(`    HEALTH productCode = 0x02 = ${BigInt(0x02)}`);
}

async function section5(_pool: Pool): Promise<void> {
  console.log('[5] CouponConditionStrategy — eligibility 외부 서비스 조회');
  const service = new EventConditionService();

  const stubChecker: EligibilityChecker = {
    async isEligible(userId) {
      console.log(`  [ELIGIBILITY] isEligible(userId='${userId}') 호출`);
      return userId === 'K-eligible';
    },
  };
  service.registerStrategy(new CouponConditionStrategy(stubChecker));

  const pass = await service.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'K-eligible',   eventCode: 10 }));
  const fail = await service.evaluate(makeEvent({ eventType: 'COUPON_CLAIM', userId: 'K-no-privilege', eventCode: 10 }));

  console.log('  K-eligible    eligible:', pass.eligible, '← true');
  console.log('  K-no-privilege eligible:', fail.eligible, `← false  reason: ${fail.reason}`);
}

async function section6(_pool: Pool): Promise<void> {
  console.log('[6] PremiumConditionStrategy — threshold 비교 (경계값 포함)');
  const service = new EventConditionService();
  service.registerStrategy(new PremiumConditionStrategy(BigInt(100_000)));

  const pass = await service.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 200_000 } }));
  const fail = await service.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount:  50_000 } }));
  const edge = await service.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: { amount: 100_000 } }));
  const none = await service.evaluate(makeEvent({ eventType: 'PREMIUM_PAID', data: {} }));

  console.log('  20만원:', pass.eligible, '← true');
  console.log('   5만원:', fail.eligible, `← false  reason: ${fail.reason}`);
  console.log('  10만원 (경계값):', edge.eligible, '← true (≥ threshold)');
  console.log('  amount 누락:', none.eligible, '← false (0으로 처리)');
}

async function section7(_pool: Pool): Promise<void> {
  console.log('[7] OCP 검증 — 새 전략 등록 시 EventConditionService 코드 변경 없음');
  const service = new EventConditionService();

  // 기존 전략 등록
  service.registerStrategy(new ActivityConditionStrategy());
  service.registerStrategy(new PremiumConditionStrategy(BigInt(100_000)));

  // 새 이벤트 추가 — EventConditionService 코드 수정 없이
  const loyaltyStrategy: IConditionStrategy = {
    supportedEventTypes: ['LOYALTY_REWARD'],
    async evaluate() {
      return { eligible: true, tokenId: BigInt(0xFF) << BigInt(64), amount: 1n };
    },
  };
  service.registerStrategy(loyaltyStrategy);

  const result = await service.evaluate(makeEvent({ eventType: 'LOYALTY_REWARD' }));
  console.log('  LOYALTY_REWARD eligible:', result.eligible, '← true');
  console.log('  tokenId:', result.tokenId);
  console.log();
  console.log('  → EventConditionService 소스 한 줄도 수정하지 않음');
  console.log('  → registerStrategy() 1회 호출로 새 이벤트 지원 추가 = OCP');

  // 동일 eventType 재등록 → 나중 전략 우선
  const newActivity: IConditionStrategy = {
    supportedEventTypes: ['WALK_GOAL_MET'],
    async evaluate() { return { eligible: true, tokenId: 999n, amount: 5n }; },
  };
  service.registerStrategy(newActivity);
  const overridden = await service.evaluate(makeEvent({ eventType: 'WALK_GOAL_MET', data: { steps: 5_000 } }));
  console.log('  재등록 후 WALK_GOAL_MET eligible:', overridden.eligible, '← true (새 전략 덮어쓰기)');
}

// ── 진입점 ───────────────────────────────────────────────────────────────────

const SECTIONS: Record<string, (pool: Pool) => Promise<void>> = {
  '1': section1,
  '2': section2,
  '3': section3,
  '4': section4,
  '5': section5,
  '6': section6,
  '7': section7,
};

(async () => {
  const pool = new Pool({
    host:     'localhost',
    port:     5434,
    database: 'kyobo_exercise',
    user:     'kyobo',
    password: 'kyobo',
  });

  const arg = process.argv[2];

  if (arg && SECTIONS[arg]) {
    if (arg === '1') await pool.query('TRUNCATE TABLE issuance_policies RESTART IDENTITY');
    console.log(`=== S28: 섹션 [${arg}] ===\n`);
    await SECTIONS[arg]!(pool);
  } else {
    await pool.query('TRUNCATE TABLE issuance_policies RESTART IDENTITY');
    console.log('=== S28: IssuancePolicyService + EventConditionService + Strategy 패턴 — 전체 실행 ===\n');
    for (const fn of Object.values(SECTIONS)) {
      await fn(pool);
      console.log();
    }
    console.log('[최종] issuance_policies 전체 조회');
    const res = await pool.query(`SELECT * FROM issuance_policies ORDER BY id`);
    console.table(res.rows);
  }

  await pool.end();
  console.log('\nS28 완료');
})();
