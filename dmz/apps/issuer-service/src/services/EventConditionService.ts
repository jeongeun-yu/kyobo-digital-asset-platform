/**
 * EventConditionService — 이벤트 조건 판단 서비스
 *
 * M5 S28~S29 핵심 개념:
 *
 * Strategy 패턴 적용:
 *   - IConditionStrategy: 조건 판단 인터페이스
 *   - ActivityConditionStrategy: 걷기 달성 조건 (목표 걸음수 초과 여부)
 *   - CouponConditionStrategy: 캠페인 쿠폰 조건 (이벤트 기간·자격 여부)
 *   - EventConditionService.evaluate(): 이벤트 타입에 맞는 전략 선택 + 실행
 *
 * 플러그인 확장성 (S29):
 *   새 이벤트 타입 추가 = 새 Strategy 클래스만 추가 → 기존 코드 무변경
 *   registerStrategy() 로 런타임 주입 가능
 *
 * 결과 구조:
 *   eligible:  true  → TxStateMachineService.submitMintRequest() 호출
 *   eligible:  false → 로그만 기록, 발행 없음
 *   tokenId:   KyoboNFT.encodeTokenId(productCode, eventCode)
 *   amount:    발행 수량 (활동 달성 = 1개)
 */

// ── 인터페이스 ────────────────────────────────────────────────────────────

export interface ActivityEvent {
  userId:     string;
  eventType:  string;           // "WALK_GOAL_MET", "HEALTH_CHECK_DONE", "COUPON_CLAIM", ...
  eventCode:  number;           // 세부 이벤트 번호 → tokenId 하위 64비트
  data:       Record<string, unknown>;
  occurredAt: Date;
}

export interface ConditionResult {
  eligible:    boolean;
  tokenId?:    bigint;          // KyoboNFT.encodeTokenId(productCode, eventCode)
  amount?:     bigint;
  reason?:     string;          // 자격 미달 사유 (로깅용)
}

export interface IConditionStrategy {
  /** 이 전략이 처리하는 eventType 목록 */
  supportedEventTypes: string[];
  evaluate(event: ActivityEvent): Promise<ConditionResult>;
}

// ── 전략 구현체 ───────────────────────────────────────────────────────────

/**
 * ActivityConditionStrategy — 걷기·건강 활동 달성 조건
 *
 * M5 S28 실습:
 *   - 목표 걸음수(data.steps) ≥ GOAL_STEPS 이면 eligible
 *   - tokenId = encodeTokenId(PRODUCT_WALK, event.eventCode)
 */
export class ActivityConditionStrategy implements IConditionStrategy {
  supportedEventTypes = ['WALK_GOAL_MET', 'HEALTH_CHECK_DONE'];

  private static readonly PRODUCT_WALK         = BigInt(0x01);  // productCode
  private static readonly PRODUCT_HEALTH        = BigInt(0x02);
  private static readonly GOAL_STEPS            = 10_000;
  private static readonly PRODUCT_CODE_SHIFT    = BigInt(64);

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    // TODO (M5 S28 실습): 조건 판단 로직 구현
    //   const steps = Number(event.data['steps'] ?? 0);
    //   if (event.eventType === 'WALK_GOAL_MET' && steps < GOAL_STEPS) {
    //     return { eligible: false, reason: `steps ${steps} < goal ${GOAL_STEPS}` };
    //   }
    //   const productCode = event.eventType === 'WALK_GOAL_MET'
    //     ? ActivityConditionStrategy.PRODUCT_WALK
    //     : ActivityConditionStrategy.PRODUCT_HEALTH;
    //   const tokenId = (productCode << PRODUCT_CODE_SHIFT) | BigInt(event.eventCode);
    //   return { eligible: true, tokenId, amount: 1n };

    if (event.eventType === 'WALK_GOAL_MET') {
      const steps = Number(event.data['steps'] ?? 0);
      if (steps < ActivityConditionStrategy.GOAL_STEPS) {
        return { eligible: false, reason: `steps ${steps} < goal ${ActivityConditionStrategy.GOAL_STEPS}` };
      }
    }

    const productCode = event.eventType === 'WALK_GOAL_MET'
      ? ActivityConditionStrategy.PRODUCT_WALK
      : ActivityConditionStrategy.PRODUCT_HEALTH;

    const tokenId = (productCode << ActivityConditionStrategy.PRODUCT_CODE_SHIFT)
      | BigInt(event.eventCode);

    return { eligible: true, tokenId, amount: 1n };
  }
}

/**
 * CouponConditionStrategy — 캠페인 쿠폰 조건
 *
 * M5 S28 실습:
 *   - 이벤트 기간 이내 + 사전 자격 목록에 userId 포함 여부 확인
 *   - tokenId = encodeTokenId(PRODUCT_COUPON, event.eventCode)
 */
export class CouponConditionStrategy implements IConditionStrategy {
  supportedEventTypes = ['COUPON_CLAIM', 'CAMPAIGN_REWARD'];

  private static readonly PRODUCT_COUPON     = BigInt(0x10);
  private static readonly PRODUCT_CODE_SHIFT = BigInt(64);

  constructor(
    private readonly eligibilityChecker: {
      isEligible(userId: string, eventType: string): Promise<boolean>;
    },
  ) {}

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    // TODO (M5 S28 실습): 자격 검증 + tokenId 생성
    //   const eligible = await this.eligibilityChecker.isEligible(event.userId, event.eventType);
    //   if (!eligible) return { eligible: false, reason: 'user not in eligibility list' };
    //   const tokenId = (PRODUCT_COUPON << SHIFT) | BigInt(event.eventCode);
    //   return { eligible: true, tokenId, amount: 1n };

    const eligible = await this.eligibilityChecker.isEligible(event.userId, event.eventType);
    if (!eligible) return { eligible: false, reason: 'user not in eligibility list' };

    const tokenId = (CouponConditionStrategy.PRODUCT_COUPON << CouponConditionStrategy.PRODUCT_CODE_SHIFT)
      | BigInt(event.eventCode);

    return { eligible: true, tokenId, amount: 1n };
  }
}

// ── 서비스 ────────────────────────────────────────────────────────────────

/**
 * EventConditionService
 *
 * 모든 이벤트의 진입점. Strategy를 선택하고 evaluate() 결과를 반환.
 *
 * M5 S29 플러그인 확장:
 *   service.registerStrategy(new NewEventStrategy());
 *   → 기존 코드 변경 없이 새 이벤트 타입 지원
 */
export class EventConditionService {
  private readonly strategies: Map<string, IConditionStrategy> = new Map();

  constructor(strategies: IConditionStrategy[] = []) {
    for (const s of strategies) {
      this.registerStrategy(s);
    }
  }

  registerStrategy(strategy: IConditionStrategy): void {
    for (const eventType of strategy.supportedEventTypes) {
      this.strategies.set(eventType, strategy);
    }
  }

  /**
   * 이벤트 조건 판단
   *
   * M5 S28 실습: evaluate 흐름
   *   1. strategies.get(event.eventType) → 전략 선택
   *   2. 없으면 UNSUPPORTED_EVENT
   *   3. strategy.evaluate(event) → ConditionResult
   */
  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    const strategy = this.strategies.get(event.eventType);

    if (!strategy) {
      return { eligible: false, reason: `unsupported event type: ${event.eventType}` };
    }

    // TODO (M5 S28 실습): try-catch + 에러 로깅
    return strategy.evaluate(event);
  }

  supportedEventTypes(): string[] {
    return [...this.strategies.keys()];
  }
}

export class UnsupportedEventTypeError extends Error {
  constructor(eventType: string) {
    super(`Unsupported event type: ${eventType}`);
    this.name = 'UnsupportedEventTypeError';
  }
}
