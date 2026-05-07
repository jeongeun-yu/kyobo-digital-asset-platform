# Day 08 — M5: 비즈니스 로직 레이어 (S29~S32)

**세션**: S29~S32 | **모듈**: M5 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: eth_sign 서명검증 + 조건판단 Strategy + 테스트전략 + 단건 NFT 발행 흐름

---

## S29: 블록체인 서명 기반 지갑 소유권 증명 원리 (강의 20분 + 실습 35분)

### 강의

**eth_sign 서명 검증 원리:**
- 서명에서 서명자 주소를 복원하는 원리 (ecrecover)
- Sybil 방어: 실제 개인키 보유자만 서명 가능

**서명 메시지 설계:**
- nonce 포함으로 재생 공격 방지
- 메시지 구조: `Kyobo-Wallet-Register:${userId}:${nonce}`

### 🔴 실습 (35분) — 수강생 직접 작성

**Step 1**: registerWalletAddress 구현
```typescript
// internal/packages/business/src/WalletProvisioningService.ts
// TODO: 서명 검증 + 저장

async registerWalletAddress(
  userId: string,
  address: string,
  signature: string,
): Promise<void> {
  // TODO: 사용자의 현재 nonce 조회
  const nonce = await this.getUserNonce(userId);
  
  // TODO: 예상 메시지 구성
  const message = `Kyobo-Wallet-Register:${userId}:${nonce}`;
  
  // TODO: ethers.verifyMessage로 서명자 주소 복원
  // TODO: 복원된 주소와 address 비교 (소문자로 정규화)
  // TODO: 불일치 시 SignatureVerificationError throw
  
  // TODO: DB 저장
  // TODO: nonce 갱신 (재생 공격 방지)
}
```

**Step 2**: 잘못된 서명 테스트
```typescript
it('잘못된 서명 → 403', async () => {
  const res = await request(app)
    .post('/api/wallet/provision')
    .send({
      userId: 'user-1',
      vaspType: 'walleton',
      walletAddress: '0xAlice',
      signature: '0xinvalid',
    });
  expect(res.status).toBe(403);
});

it('이미 등록된 주소 재등록 → 처리', async () => {
  // TODO: 동일 주소 두 번 등록 → 에러 없이 처리 (멱등)
});

it('다른 주소로 교체 → 기존 삭제', async () => {
  // TODO: 새 주소 등록 → 기존 is_active=false 처리
});
```

### ✅ 답안

```typescript
import { ethers } from 'ethers';

async registerWalletAddress(userId: string, address: string, signature: string): Promise<void> {
  const nonce = await this.getUserNonce(userId);
  const message = `Kyobo-Wallet-Register:${userId}:${nonce}`;

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyMessage(message, signature);
  } catch {
    throw new SignatureVerificationError('서명 파싱 실패');
  }

  if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
    throw new SignatureVerificationError('서명자 주소 불일치');
  }

  // 기존 지갑 비활성화
  await this.db('user_wallet_mapping')
    .where({ user_id: userId })
    .update({ is_active: false });

  // 새 주소 등록
  await this.db('user_wallet_mapping').insert({
    user_id: userId,
    wallet_address: address.toLowerCase(),
    vasp_type: 'walleton',
    is_active: true,
  });

  // nonce 갱신 (재생 공격 방지)
  await this.db('user_nonces').where({ user_id: userId }).update({
    nonce: knex.raw('nonce + 1'),
  });
}
```

### ✅ 완료 기준
- [ ] eth_sign 서명 검증 통과
- [ ] 잘못된 서명 → 403
- [ ] 중복 등록 처리 테스트

---

## S30: 이벤트 조건 판단 서비스 설계 — Strategy 패턴 적용 (강의 20분 + 실습 35분)

### 강의

**조건 판단 플러그인 구조:**
- 상품별 다른 조건을 코드 변경 없이 교체
- Strategy Pattern: `IConditionEvaluator` 인터페이스 주입

**false positive/negative 처리:**
- 조건 미충족인데 NFT 발행 (false positive) → 잘못된 보상
- 충족인데 미발행 (false negative) → 고객 불만

### 🔴 실습 (35분) — 수강생 직접 작성

**Step 1**: getWalletAddress 구현
```typescript
// TODO: DB 조회, 없으면 WalletNotFoundError 명시적 예외
async getWalletAddress(userId: string): Promise<string> {
  // TODO: user_wallet_mapping에서 is_active=true인 주소 조회
}
```

**Step 2**: IConditionEvaluator 인터페이스
```typescript
// internal/packages/business/src/conditions/IConditionEvaluator.ts
// TODO: 이벤트를 받아 조건 충족 여부를 반환하는 인터페이스

export interface IConditionEvaluator {
  // TODO: evaluate(event: BusinessEvent): Promise<boolean>
}
```

**Step 3**: 샘플 구현 2개
```typescript
// TODO: 보험 납입 완료 조건 Evaluator
export class InsurancePaidEvaluator implements IConditionEvaluator {
  async evaluate(event: BusinessEvent): Promise<boolean> {
    // TODO: event.type === 'INSURANCE_PAID' && event.amount >= 10000
  }
}

// TODO: 이벤트 참여 조건 Evaluator
export class EventParticipationEvaluator implements IConditionEvaluator {
  async evaluate(event: BusinessEvent): Promise<boolean> {
    // TODO: event.type === 'EVENT_PARTICIPATION' && event.participated === true
  }
}
```

### ✅ 답안

```typescript
// IConditionEvaluator 완성
export interface IConditionEvaluator {
  evaluate(event: BusinessEvent): Promise<boolean>;
  readonly conditionType: string;
}

// InsurancePaidEvaluator 완성
export class InsurancePaidEvaluator implements IConditionEvaluator {
  readonly conditionType = 'INSURANCE_PAID';

  async evaluate(event: BusinessEvent): Promise<boolean> {
    return (
      event.type === 'INSURANCE_PAID' &&
      typeof event.amount === 'number' &&
      event.amount >= 10000
    );
  }
}

// EventParticipationEvaluator 완성
export class EventParticipationEvaluator implements IConditionEvaluator {
  readonly conditionType = 'EVENT_PARTICIPATION';

  async evaluate(event: BusinessEvent): Promise<boolean> {
    return event.type === 'EVENT_PARTICIPATION' && event.participated === true;
  }
}
```

### ✅ 완료 기준
- [ ] 지갑 없는 userId → WalletNotFoundError
- [ ] IConditionEvaluator 인터페이스 + 샘플 2개

---

## S31: 조건 평가 로직의 테스트 전략과 플러그인 확장성 검증 (강의 15분 + 실습 40분)

### 강의

**조건 평가 테스트 설계:**
- 충족/미충족/경계값/이벤트 데이터 누락 케이스

**플러그인 교체 테스트:**
- 런타임에 다른 Evaluator 주입 후 동일 이벤트 다른 결과 확인

### 🔴 실습 (40분) — 수강생 직접 작성

**Step 1**: EventConditionService 구현
```typescript
// internal/packages/business/src/EventConditionService.ts
// TODO: 주입된 Evaluator 호출

export class EventConditionService {
  constructor(private readonly evaluator: IConditionEvaluator) {}

  async shouldIssueNFT(event: BusinessEvent): Promise<boolean> {
    // TODO: this.evaluator.evaluate(event) 호출
  }
}
```

**Step 2**: 보험 납입 Evaluator 단위 테스트
```typescript
describe('InsurancePaidEvaluator', () => {
  const evaluator = new InsurancePaidEvaluator();

  // TODO: 납입 완료 케이스
  it('납입 완료 + 금액 충족 → true', async () => {
    const event = { type: 'INSURANCE_PAID', amount: 50000 };
    expect(await evaluator.evaluate(event)).toBe(true);
  });

  // TODO: 미완료 케이스
  it('납입 미완료 → false', async () => {
    // TODO
  });

  // TODO: 경계값 케이스
  it('금액 9999 → false / 10000 → true', async () => {
    // TODO: 9999 테스트
    // TODO: 10000 테스트
  });
});
```

**Step 3**: 플러그인 교체 테스트
```typescript
it('다른 Evaluator 주입 → 동일 이벤트 다른 결과', async () => {
  const event = { type: 'INSURANCE_PAID', amount: 50000 };

  const service1 = new EventConditionService(new InsurancePaidEvaluator());
  const service2 = new EventConditionService(new EventParticipationEvaluator());

  // TODO: service1.shouldIssueNFT(event) === true
  // TODO: service2.shouldIssueNFT(event) === false (다른 조건 평가)
});
```

### ✅ 답안

```typescript
// EventConditionService 완성
export class EventConditionService {
  constructor(private readonly evaluator: IConditionEvaluator) {}

  async shouldIssueNFT(event: BusinessEvent): Promise<boolean> {
    return this.evaluator.evaluate(event);
  }
}

// InsurancePaidEvaluator 테스트
describe('InsurancePaidEvaluator', () => {
  const evaluator = new InsurancePaidEvaluator();

  it('납입 완료 + 금액 충족 → true', async () => {
    expect(await evaluator.evaluate({ type: 'INSURANCE_PAID', amount: 50000 })).toBe(true);
  });

  it('미완료 → false', async () => {
    expect(await evaluator.evaluate({ type: 'INSURANCE_PAID', amount: 0 })).toBe(false);
  });

  it('경계값 9999 → false', async () => {
    expect(await evaluator.evaluate({ type: 'INSURANCE_PAID', amount: 9999 })).toBe(false);
  });

  it('경계값 10000 → true', async () => {
    expect(await evaluator.evaluate({ type: 'INSURANCE_PAID', amount: 10000 })).toBe(true);
  });
});
```

### ✅ 완료 기준
- [ ] 조건 미충족 → false 반환
- [ ] 플러그인 교체 테스트 통과
- [ ] 경계값 테스트 PASS

---

## S32: 이벤트에서 NFT 요청까지 — 단건 발행 흐름 설계 (강의 15분 + 실습 40분)

### 강의

**이벤트 → 단건 요청 흐름:**
```
EventConditionService → getWalletAddress → 요청 생성 → VaspAbstractionLayer
```

**요청 객체 설계:**
- 요청 식별자, 사용자·지갑 정보, 토큰·수량·생성 시각 포함

### 🔴 실습 (40분) — 수강생 직접 작성

**Step 1**: createNftRequest 구현
```typescript
// internal/packages/business/src/NftIssuanceService.ts
// TODO: 이벤트 → NFT 요청 생성 + VASP 전달

async createNftRequest(
  userId: string,
  tokenId: bigint,
  amount: number,
): Promise<string | null> {
  // TODO: 조건 판단 — shouldIssueNFT
  // TODO: 조건 미충족 → return null
  // TODO: 지갑 주소 조회 — getWalletAddress (없으면 WalletNotFoundError)
  // TODO: vaspService.submitMintRequest(userId, tokenId, amount)
  // TODO: requestId 반환
}
```

**Step 2**: 조건 미충족 테스트
```typescript
it('조건 미충족 이벤트 → NFT 요청 생성 안 됨', async () => {
  const event = { type: 'INSURANCE_PAID', amount: 0 }; // 금액 부족
  const requestId = await service.createNftRequest('user-1', 1001n, 1);
  expect(requestId).toBeNull();
});
```

**Step 3**: E2E 흐름 1건 확인
```typescript
it('이벤트 → VASP 전달 E2E 1건', async () => {
  // 1. 사용자 지갑 등록
  // 2. 조건 충족 이벤트 설정
  // 3. createNftRequest 호출
  // 4. mint_requests DB에 SUBMITTED 상태 1건 확인
  // 5. VASP Mock에서 요청 1건 수신 확인
});
```

### ✅ 답안

```typescript
// createNftRequest 완성
async createNftRequest(userId: string, tokenId: bigint, amount: number): Promise<string | null> {
  const shouldIssue = await this.conditionService.shouldIssueNFT({ userId, tokenId, amount });
  if (!shouldIssue) return null;

  const walletAddress = await this.walletService.getWalletAddress(userId);
  if (!walletAddress) return null;

  const requestId = await this.vaspService.submitMintRequest(userId, tokenId, amount);
  return requestId;
}
```

### ✅ 완료 기준
- [ ] 조건 미충족 → 요청 생성 안 됨
- [ ] 이벤트 → VASP 전달 E2E 1건 동작
