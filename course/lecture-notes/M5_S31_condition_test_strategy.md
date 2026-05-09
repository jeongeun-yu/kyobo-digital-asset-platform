# M5 S31 — 조건 평가 로직의 테스트 전략과 플러그인 확장성 검증

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.

> 모듈 5 · 세션 31 · 1시간  
> 스켈레톤: `dmz/apps/issuer-service/src/services/EventConditionService.ts`

---

## 강의 파트 (15분)

### 1. 왜 조건 평가 테스트 커버리지가 중요한가

S30에서 "false positive가 false negative보다 위험하다"고 배웠다.

조건 평가 로직의 버그는 두 가지 결과를 낳는다:

1. **버그 유형 A**: 조건 충족 사용자에게 NFT가 발행 안 됨 → 재발행 가능, 운영 처리 가능
2. **버그 유형 B**: 조건 미충족 사용자에게 NFT가 발행됨 → 온체인 영구 기록, 취소 불가

버그 유형 B가 가장 무서운 케이스: 10만명에게 조건 없이 NFT가 발행되면 보험 상품 전체를 취소해야 할 수도 있다.

따라서 조건 평가 로직은 **완전한 테스트 커버리지**가 필요하다.

---

### 2. 테스트 케이스 분류 원칙

| 케이스 유형 | 예시 | 목적 |
|---|---|---|
| 충족 케이스 | steps=15000, goal=10000 | 정상 발행 경로 확인 |
| 미충족 케이스 | steps=5000, goal=10000 | 발행 차단 확인 |
| 경계값 (exactly) | steps=10000 (목표와 동일) | off-by-one 버그 방지 |
| 이벤트 데이터 누락 | `data={}` (steps 없음) | null 방어 코드 확인 |
| 미지원 이벤트 타입 | `eventType='NEW_UNKNOWN'` | graceful 거부 확인 |

경계값 테스트가 특히 중요하다. "10000보다 커야 하나, 10000 이상이어야 하나"는 명세에 따라 다른데, off-by-one 실수가 가장 많이 발생하는 지점이다.

---

### 3. 플러그인 교체 테스트 — 전략 교체가 실제로 동작하는가

Strategy 패턴의 핵심 주장은 "이벤트를 건드리지 않고 조건만 교체할 수 있다"는 것이다. 이것을 테스트로 검증해야 한다.

```typescript
// 같은 이벤트, 다른 전략 → 다른 결과
const strictService  = new EventConditionService([strictStrategy]);   // 더 높은 기준
const lenientService = new EventConditionService([lenientStrategy]);   // 더 낮은 기준

const sameEvent = { eventType: 'WALK_GOAL_MET', data: { steps: 12000 }, ... };

const strictResult  = await strictService.evaluate(sameEvent);   // false (기준: 20000)
const lenientResult = await lenientService.evaluate(sameEvent);  // true (기준: 5000)
```

이 테스트가 통과해야 "전략이 교체 가능하다"고 주장할 수 있다.

---

### 4. Mock vs Stub vs Fake — 테스트 더블 구분

조건 평가 로직은 외부 의존성을 많이 사용한다. 테스트에서 어떤 대체물을 사용할지 구분해야 한다.

| 이름 | 특징 | 사용 시점 |
|---|---|---|
| Mock | 호출 기록 검증 가능 (jest.fn()) | "이 메서드가 몇 번 호출됐는가" 확인 필요 시 |
| Stub | 고정 값 반환, 검증 없음 | 외부 서비스 응답을 고정해 줄 때 |
| Fake | 실제 동작하는 가벼운 구현 | InMemory DB, 단순 계산 로직 |

`CouponConditionStrategy`의 `eligibilityChecker`는 외부 서비스 호출이므로 **Stub**으로 대체:

```typescript
// Stub: 고정 응답만 반환 (호출 횟수 검증 불필요)
const stubChecker = {
  async isEligible(userId: string) { return userId === 'eligible-user'; },
};
```

반면 "eligibilityChecker가 실제로 호출됐는가"를 검증해야 한다면 **Mock**:

```typescript
const mockChecker = { isEligible: jest.fn().mockResolvedValue(true) };
// 테스트 후:
expect(mockChecker.isEligible).toHaveBeenCalledWith('user1', 'COUPON_CLAIM');
```

---

### 5. 테스트 구조 설계 원칙 — AAA 패턴

```
테스트 구조: Arrange → Act → Assert

it('steps=9999 → eligible=false', async () => {
  // Arrange: 테스트 데이터 준비
  const event = {
    userId: 'u1', eventType: 'WALK_GOAL_MET',
    eventCode: 1, data: { steps: 9999 }, occurredAt: new Date(),
  };

  // Act: 실제 호출
  const result = await strategy.evaluate(event);

  // Assert: 결과 검증
  expect(result.eligible).toBe(false);
  expect(result.reason).toContain('9999 < goal');
});
```

AAA를 명확히 분리하면 테스트 의도가 한눈에 보인다.

---

## 실습 파트 (40분)

### ActivityConditionStrategy 경계값 테스트

```typescript
describe('ActivityConditionStrategy', () => {
  const strategy = new ActivityConditionStrategy();

  // 충족 케이스
  it('steps=15000 → eligible=true', async () => {
    const result = await strategy.evaluate({
      userId: 'u1', eventType: 'WALK_GOAL_MET',
      eventCode: 1, data: { steps: 15000 }, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(true);
  });

  // 미충족 케이스
  it('steps=5000 → eligible=false', async () => {
    const result = await strategy.evaluate({
      userId: 'u1', eventType: 'WALK_GOAL_MET',
      eventCode: 1, data: { steps: 5000 }, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('5000 < goal 10000');
  });

  // 경계값 테스트 — 목표치 정확히 도달
  it('steps=10000 (exactly goal) → eligible=true', async () => {
    const result = await strategy.evaluate({
      userId: 'u1', eventType: 'WALK_GOAL_MET',
      eventCode: 1, data: { steps: 10000 }, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(true);  // 10000 이상이므로 통과
  });

  // off-by-one 테스트
  it('steps=9999 (1 below goal) → eligible=false', async () => {
    const result = await strategy.evaluate({
      userId: 'u1', eventType: 'WALK_GOAL_MET',
      eventCode: 1, data: { steps: 9999 }, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(false);
  });

  // 데이터 누락 방어
  it('steps 누락 (data={}) → eligible=false, 예외 없음', async () => {
    const result = await strategy.evaluate({
      userId: 'u1', eventType: 'WALK_GOAL_MET',
      eventCode: 1, data: {}, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(false);
    // 예외를 던지지 않고 eligible=false로 안전하게 처리
  });

  // 건강검진은 steps와 무관
  it('HEALTH_CHECK_DONE → steps 없어도 eligible=true', async () => {
    const result = await strategy.evaluate({
      userId: 'u1', eventType: 'HEALTH_CHECK_DONE',
      eventCode: 2, data: {}, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(true);
  });

  // tokenId 인코딩 검증
  it('WALK_GOAL_MET tokenId = (0x01 << 64) | eventCode', async () => {
    const result = await strategy.evaluate({
      userId: 'u1', eventType: 'WALK_GOAL_MET',
      eventCode: 5, data: { steps: 15000 }, occurredAt: new Date(),
    });
    const expected = (BigInt(0x01) << BigInt(64)) | BigInt(5);
    expect(result.tokenId).toBe(expected);
  });
});
```

### CouponConditionStrategy 테스트 — 외부 의존성 Mock

```typescript
describe('CouponConditionStrategy', () => {
  const mockChecker = {
    async isEligible(userId: string) {
      return userId === 'eligible-user';  // 특정 userId만 자격 부여
    },
  };
  const strategy = new CouponConditionStrategy(mockChecker);

  it('자격 있는 사용자 → eligible=true', async () => {
    const result = await strategy.evaluate({
      userId: 'eligible-user', eventType: 'COUPON_CLAIM',
      eventCode: 10, data: {}, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(true);
  });

  it('자격 없는 사용자 → eligible=false + reason', async () => {
    const result = await strategy.evaluate({
      userId: 'no-privilege', eventType: 'COUPON_CLAIM',
      eventCode: 10, data: {}, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('user not in eligibility list');
  });
});
```

### 플러그인 교체 통합 테스트

```typescript
describe('EventConditionService - plugin 교체', () => {
  it('같은 이벤트에 다른 Strategy → 다른 결과', async () => {
    // 더 높은 기준 전략
    const strictStrategy: IConditionStrategy = {
      supportedEventTypes: ['WALK_GOAL_MET'],
      async evaluate(event) {
        const steps = Number(event.data['steps'] ?? 0);
        return { eligible: steps >= 20000 };  // 20000보 기준
      },
    };

    // 더 낮은 기준 전략
    const lenientStrategy: IConditionStrategy = {
      supportedEventTypes: ['WALK_GOAL_MET'],
      async evaluate() {
        return { eligible: true };  // 무조건 충족
      },
    };

    const event: ActivityEvent = {
      userId: 'u1', eventType: 'WALK_GOAL_MET',
      eventCode: 1, data: { steps: 12000 }, occurredAt: new Date(),
    };

    const strictService  = new EventConditionService([strictStrategy]);
    const lenientService = new EventConditionService([lenientStrategy]);

    const strictResult  = await strictService.evaluate(event);
    const lenientResult = await lenientService.evaluate(event);

    expect(strictResult.eligible).toBe(false);   // 12000 < 20000
    expect(lenientResult.eligible).toBe(true);   // 무조건 통과
  });

  it('미등록 이벤트 타입 → eligible=false gracefully', async () => {
    const service = new EventConditionService([]);  // 전략 없음
    const result = await service.evaluate({
      userId: 'u1', eventType: 'TOTALLY_NEW_EVENT',
      eventCode: 1, data: {}, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('unsupported');
  });

  it('동일 eventType 재등록 → 나중 전략으로 덮어쓰기', async () => {
    const service = new EventConditionService();
    const first  = { supportedEventTypes: ['WALK_GOAL_MET'], async evaluate() { return { eligible: false }; } };
    const second = { supportedEventTypes: ['WALK_GOAL_MET'], async evaluate() { return { eligible: true }; } };

    service.registerStrategy(first);
    service.registerStrategy(second);  // 덮어쓰기

    const result = await service.evaluate({
      userId: 'u1', eventType: 'WALK_GOAL_MET',
      eventCode: 1, data: {}, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(true);  // 나중 전략이 적용됨
  });
});
```

### 보험 납입 Evaluator 단위 테스트 (S30 과제 연결)

```typescript
describe('PremiumConditionStrategy', () => {
  const THRESHOLD = BigInt(100_000);  // 10만원 기준
  const strategy = new PremiumConditionStrategy(THRESHOLD);

  it('금액 충족 → eligible=true', async () => {
    const result = await strategy.evaluate({
      userId: 'u1', eventType: 'PREMIUM_PAID',
      eventCode: 1, data: { amount: 200_000 }, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(true);
  });

  it('금액 미충족 → eligible=false', async () => {
    const result = await strategy.evaluate({
      userId: 'u1', eventType: 'PREMIUM_PAID',
      eventCode: 1, data: { amount: 50_000 }, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(false);
  });

  it('경계값 (amount == threshold) → eligible=true', async () => {
    const result = await strategy.evaluate({
      userId: 'u1', eventType: 'PREMIUM_PAID',
      eventCode: 1, data: { amount: 100_000 }, occurredAt: new Date(),
    });
    expect(result.eligible).toBe(true);  // 이상(≥)이므로 통과
  });
});
```

---

## 완료 기준

- [ ] 조건 미충족 → eligible=false, reason 포함하여 반환
- [ ] 플러그인 교체 테스트 통과 (같은 이벤트, 다른 전략 → 다른 결과)
- [ ] 경계값(steps=10000 정확히 목표치) 테스트 PASS
- [ ] off-by-one(steps=9999) 테스트 PASS
- [ ] steps 누락(data={}) → 예외 없이 eligible=false
- [ ] HEALTH_CHECK_DONE → steps와 무관하게 eligible=true
- [ ] tokenId 비트 인코딩 계산값이 기대값과 일치 확인
- [ ] 미등록 eventType → eligible=false, reason에 'unsupported' 포함
- [ ] 동일 eventType 재등록 → 나중 전략으로 덮어쓰기 동작 확인
- [ ] CouponConditionStrategy의 eligibilityChecker가 실제로 호출됐는지 Mock으로 검증
- [ ] PremiumConditionStrategy 경계값(amount == threshold) → eligible=true (이상≥)
