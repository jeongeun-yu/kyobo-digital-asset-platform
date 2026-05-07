# M5 S30 — 이벤트 조건 판단 서비스 설계 · Strategy 패턴 적용

> 모듈 5 · 세션 30 · 1시간  
> 스켈레톤: `dmz/apps/issuer-service/src/services/EventConditionService.ts`

---

## 강의 파트 (20분)

### 1. NFT 발행 조건이 상품마다 다르다

교보생명 NFT 발행은 다양한 이벤트에서 트리거된다.

| 이벤트 | 조건 | 발행 수량 |
|---|---|---|
| 걷기 달성 | steps ≥ 10,000 | 1개 |
| 건강검진 완료 | 완료 여부 확인 | 1개 |
| 캠페인 쿠폰 | 자격 목록 포함 여부 | 1개 |
| 보험 납입 완료 | 금액 ≥ threshold | 1개 |

새 상품이 추가되면 새 조건도 생긴다. 이것을 하나의 거대한 if-else로 처리하면:

```typescript
// ❌ 안티패턴 — 매번 이 파일 수정
async evaluate(event: ActivityEvent) {
  if (event.eventType === 'WALK_GOAL_MET') {
    return event.data.steps >= 10000;
  } else if (event.eventType === 'COUPON_CLAIM') {
    return eligibilityList.includes(event.userId);
  } else if (event.eventType === 'HEALTH_CHECK_DONE') {
    return true;
  } else if (event.eventType === 'PREMIUM_PAID') {
    return event.data.amount >= threshold;
  }
  // 새 이벤트마다 여기에 추가...
}
```

이 구조의 문제:
1. 새 이벤트 추가마다 이 파일을 수정해야 한다 (OCP 위반)
2. 파일이 점점 길어지고 테스트가 어려워진다
3. 여러 팀이 동시에 이 파일을 수정하면 충돌이 난다

---

### 2. Strategy 패턴 — 조건 판단을 플러그인으로 분리

핵심 아이디어: **각 이벤트 계열의 조건 판단을 독립된 클래스로 분리하고, 런타임에 주입한다.**

```typescript
// 공통 인터페이스
export interface IConditionStrategy {
  supportedEventTypes: string[];
  evaluate(event: ActivityEvent): Promise<ConditionResult>;
}
```

각 이벤트 계열별 독립 구현:

```typescript
// 활동 기반 이벤트 (걷기, 건강검진)
class ActivityConditionStrategy implements IConditionStrategy {
  supportedEventTypes = ['WALK_GOAL_MET', 'HEALTH_CHECK_DONE'];
  async evaluate(event) { ... }
}

// 쿠폰·캠페인 이벤트
class CouponConditionStrategy implements IConditionStrategy {
  supportedEventTypes = ['COUPON_CLAIM', 'CAMPAIGN_REWARD'];
  async evaluate(event) { ... }
}

// 보험 납입 이벤트 (새로 추가)
class PremiumConditionStrategy implements IConditionStrategy {
  supportedEventTypes = ['PREMIUM_PAID'];
  async evaluate(event) { ... }
}
```

`EventConditionService`는 전략 레지스트리만 관리한다:

```typescript
export class EventConditionService {
  private readonly strategies: Map<string, IConditionStrategy> = new Map();

  registerStrategy(strategy: IConditionStrategy): void {
    for (const eventType of strategy.supportedEventTypes) {
      this.strategies.set(eventType, strategy);  // eventType → 전략 매핑
    }
  }

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    const strategy = this.strategies.get(event.eventType);
    if (!strategy) {
      // 등록되지 않은 이벤트 → 안전하게 미발행 처리
      return { eligible: false, reason: `unsupported event type: ${event.eventType}` };
    }
    return strategy.evaluate(event);
  }
}
```

새 이벤트 추가:

```typescript
// 새 이벤트 추가 시: EventConditionService는 건드리지 않음
service.registerStrategy(new PremiumConditionStrategy());
// → 끝
```

---

### 3. false positive vs false negative — 어느 쪽이 더 위험한가

| 오류 유형 | 상황 | 임팩트 |
|---|---|---|
| false positive | 조건 미충족인데 NFT 발행됨 | NFT 과다 발행 → 보험 규정 위반, 온체인 기록 → 취소 불가 |
| false negative | 조건 충족인데 NFT 미발행됨 | 사용자 불편 → 재발행 가능, 감사 로그로 추적 가능 |

**false positive가 훨씬 위험하다.** 한 번 발행된 NFT는 블록체인에 영구 기록된다. 취소하려면 burn TX를 따로 보내야 하고, 그 사이 사용자가 이미 혜택을 사용했을 수 있다.

따라서 조건 판단은 **보수적으로** 설계한다. 애매한 케이스는 미발행(false negative)으로 처리하고 추후 수동 검토한다.

---

### 4. Strategy 패턴 적용 전후 구조 비교 — 아스키 다이어그램

**적용 전 (Monolithic 조건 분기):**

```
┌──────────────────────────────────────────────┐
│           EventConditionService              │
│                                              │
│  evaluate(event)                             │
│    │                                         │
│    ├─ if WALK_GOAL_MET ──── 걷기 로직         │
│    ├─ if HEALTH_CHECK_DONE ─ 건강검진 로직    │
│    ├─ if COUPON_CLAIM ──── 쿠폰 로직          │
│    ├─ if PREMIUM_PAID ──── 납입 로직          │
│    └─ if NEW_EVENT ... ─── ← 여기 추가 필요  │
│                                              │
│  새 이벤트마다 이 파일을 수정해야 함           │
└──────────────────────────────────────────────┘
```

**적용 후 (Strategy 패턴):**

```
┌───────────────────────────────────────────────────────────┐
│                EventConditionService                       │
│                                                           │
│  strategies: Map<eventType, IConditionStrategy>           │
│                                                           │
│  evaluate(event)                                          │
│    └─ strategy = strategies.get(event.eventType)          │
│         └─ strategy.evaluate(event) ──────────────────┐   │
└───────────────────────────────────────────────────────│───┘
                                                        │
         ┌──────────────────────────────────────────────┘
         │
         ▼  (런타임에 주입된 구현체 중 하나 호출)
┌────────────────────┐  ┌────────────────────┐  ┌─────────────────────┐
│ActivityCondition   │  │CouponCondition     │  │PremiumCondition     │
│Strategy            │  │Strategy            │  │Strategy             │
│                    │  │                    │  │                     │
│WALK_GOAL_MET       │  │COUPON_CLAIM        │  │PREMIUM_PAID         │
│HEALTH_CHECK_DONE   │  │CAMPAIGN_REWARD     │  │                     │
│                    │  │                    │  │← 새 이벤트 추가 시   │
│steps 검증          │  │eligibility 조회    │  │  이 파일만 새로 만듦  │
└────────────────────┘  └────────────────────┘  └─────────────────────┘
```

**OCP(개방-폐쇄 원칙)가 적용된 이유:**
- `EventConditionService`는 수정에 대해 **닫혀** 있다 (코드 변경 없음)
- 새 이벤트에 대해 **열려** 있다 (새 Strategy 클래스 추가만 하면 됨)
- `registerStrategy(new PremiumConditionStrategy())` 한 줄이 전부

---

### 5. tokenId 인코딩 — M6 컨트랙트와 동기화

`ActivityConditionStrategy`의 `evaluate()`는 조건 충족 여부뿐 아니라 `tokenId`도 계산한다:

```typescript
// M5 TypeScript
const tokenId = (productCode << BigInt(64)) | BigInt(event.eventCode);
```

```solidity
// M6 Solidity
uint256 tokenId = (uint256(productCode) << 64) | uint256(eventCode);
```

두 레이어가 같은 비트 레이아웃을 사용한다. TypeScript에서 계산한 tokenId를 그대로 컨트랙트에 전달한다. 이 동기화가 깨지면 잘못된 tokenId의 NFT가 발행된다.

```typescript
// 걷기 달성 tokenId 예시
productCode = BigInt(0x01)  // 걷기
eventCode   = BigInt(42)    // 42번 이벤트
tokenId     = (0x01n << 64n) | 42n
            = 0x0000000000000001_000000000000002An
```

---

## 실습 파트 (35분)

### ActivityConditionStrategy 구현

```typescript
export class ActivityConditionStrategy implements IConditionStrategy {
  supportedEventTypes = ['WALK_GOAL_MET', 'HEALTH_CHECK_DONE'];

  private static readonly PRODUCT_WALK   = BigInt(0x01);
  private static readonly PRODUCT_HEALTH = BigInt(0x02);
  private static readonly PRODUCT_CODE_SHIFT = BigInt(64);
  private static readonly GOAL_STEPS = 10_000;

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    // 걷기 달성: steps 검증
    if (event.eventType === 'WALK_GOAL_MET') {
      const steps = Number(event.data['steps'] ?? 0);
      if (steps < ActivityConditionStrategy.GOAL_STEPS) {
        return {
          eligible: false,
          reason: `steps ${steps} < goal ${ActivityConditionStrategy.GOAL_STEPS}`,
        };
      }
    }
    // 건강검진: 완료 여부만 체크 (steps 불필요)

    const productCode = event.eventType === 'WALK_GOAL_MET'
      ? ActivityConditionStrategy.PRODUCT_WALK
      : ActivityConditionStrategy.PRODUCT_HEALTH;

    // tokenId 계산 — M6 KyoboNFT.sol과 동일한 비트 레이아웃
    const tokenId = (productCode << ActivityConditionStrategy.PRODUCT_CODE_SHIFT)
      | BigInt(event.eventCode);

    return { eligible: true, tokenId, amount: 1n };
  }
}
```

### CouponConditionStrategy 구현

```typescript
export class CouponConditionStrategy implements IConditionStrategy {
  supportedEventTypes = ['COUPON_CLAIM', 'CAMPAIGN_REWARD'];

  private static readonly PRODUCT_COUPON = BigInt(0x10);
  private static readonly PRODUCT_CODE_SHIFT = BigInt(64);

  constructor(
    private readonly eligibilityChecker: {
      isEligible(userId: string, eventType: string): Promise<boolean>;
    },
  ) {}

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    // 자격 목록 외부 서비스에 확인
    const eligible = await this.eligibilityChecker.isEligible(event.userId, event.eventType);
    if (!eligible) {
      return { eligible: false, reason: 'user not in eligibility list' };
    }

    const tokenId = (CouponConditionStrategy.PRODUCT_COUPON << CouponConditionStrategy.PRODUCT_CODE_SHIFT)
      | BigInt(event.eventCode);

    return { eligible: true, tokenId, amount: 1n };
  }
}
```

### 서비스 초기화 및 전략 등록

```typescript
// 앱 시작 시 전략 등록
const conditionService = new EventConditionService();

conditionService.registerStrategy(new ActivityConditionStrategy());
conditionService.registerStrategy(new CouponConditionStrategy(eligibilityRepo));

// 나중에 새 이벤트 추가 — EventConditionService 코드 변경 없음
conditionService.registerStrategy(new PremiumConditionStrategy(threshold));
```

### 보험 납입 Evaluator 작성 과제

```typescript
// 실습: PremiumConditionStrategy 구현
export class PremiumConditionStrategy implements IConditionStrategy {
  supportedEventTypes = ['PREMIUM_PAID'];

  private static readonly PRODUCT_PREMIUM = BigInt(0x03);
  private static readonly PRODUCT_CODE_SHIFT = BigInt(64);

  constructor(private readonly threshold: bigint) {}

  async evaluate(event: ActivityEvent): Promise<ConditionResult> {
    // TODO: event.data.amount >= threshold 조건 확인
    // TODO: tokenId 계산 (productCode=0x03)
    // TODO: ConditionResult 반환
    throw new Error('구현하세요');
  }
}
```

**구현 힌트:**

1. `event.data['amount']`는 `number | undefined` 타입이다. `undefined`이면 `0`으로 취급한다.
2. `threshold`는 `bigint`다. `amount`를 `BigInt()`로 변환한 후 비교해야 한다.
3. `amount < threshold`이면 `eligible: false`와 `reason` 문자열을 반환한다.
4. tokenId 비트 레이아웃: `(PRODUCT_PREMIUM << PRODUCT_CODE_SHIFT) | BigInt(event.eventCode)` — ActivityConditionStrategy와 동일한 패턴.

**구현 답안 (실습 후 확인):**

```typescript
async evaluate(event: ActivityEvent): Promise<ConditionResult> {
  const amount = BigInt(Number(event.data['amount'] ?? 0));

  if (amount < this.threshold) {
    return {
      eligible: false,
      reason: `amount ${amount} < threshold ${this.threshold}`,
    };
  }

  const tokenId =
    (PremiumConditionStrategy.PRODUCT_PREMIUM << PremiumConditionStrategy.PRODUCT_CODE_SHIFT)
    | BigInt(event.eventCode);

  return { eligible: true, tokenId, amount: 1n };
}
```

**등록 방법 (앱 초기화 시):**

```typescript
// threshold: 10만원 (단위: 원)
conditionService.registerStrategy(new PremiumConditionStrategy(BigInt(100_000)));
```

---

## 완료 기준

- [ ] 지갑 없는 userId → WalletNotFoundError
- [ ] IConditionStrategy 인터페이스 + 샘플 2개 (Activity, Coupon)
- [ ] PremiumConditionStrategy 구현 완료 (threshold 비교 + tokenId 계산)
- [ ] 새 전략 registerStrategy() 한 줄로 추가 — EventConditionService 코드 변경 없음 확인
- [ ] tokenId 비트 인코딩이 M6 KyoboNFT.sol과 동일함 확인
- [ ] 미등록 eventType → `eligible: false, reason: 'unsupported ...'` (예외 아님) 확인
- [ ] false positive 위험이 false negative보다 큰 이유를 설명할 수 있음
