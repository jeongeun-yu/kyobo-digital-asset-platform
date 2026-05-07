# M8 S49 — 가상자산 이전 규제 · Travel Rule 요건과 컴플라이언스 설계

> 모듈 8 · 세션 49 · 1시간  
> 스켈레톤: `dmz/packages/vasp/src/governance/KeyGovernanceService.ts`

---

## 강의 파트 (25분)

### 1. Travel Rule — 금융당국이 VASP에 요구하는 것

"Travel Rule"이라는 이름은 FATF(국제자금세탁방지기구)에서 왔다. 은행 국제 송금에서는 오래 전부터 적용되어 온 규정이다: 자금이 이동할 때 보내는 사람과 받는 사람의 정보가 함께 "여행(travel)"해야 한다.

2021년부터 한국은 특정금융정보법(특금법) §8의4에 의해 VASP(가상자산사업자)에도 동일한 의무를 부과했다.

**핵심 의무:**

```
100만원(1,000,000 KRW) 이상의 가상자산 이전 시:
  → 송신 VASP: 송신인 정보 + 수신인 정보를 수신 VASP에 전달 의무
  → 수신 VASP: 수신인 정보 검증 의무

미이행 시:
  → 금융정보분석원(KoFIU) 제재
  → 영업 정지
  → 최대 3년 이하 징역 또는 3천만원 이하 벌금 (법인 포함)
```

교보생명이 VASP 라이선스를 보유하고 NFT를 발행한다면, 이 의무가 적용된다.

---

### 2. 왜 NFT 발행에 Travel Rule이 적용되는가

일반 NFT 민팅은 새로 만드는 것이다. 기존 자산의 이전이 아니다.

그런데 교보생명 디지털 자산 프로그램에서:

```
교보생명(VASP A) → 가입자 지갑(B)에 NFT 발행
```

이것이 "가상자산 이전"으로 해석될 수 있다. 발행금액(NFT의 KRW 환산가치)이 100만원 이상이면 Travel Rule 데이터를 첨부해야 한다.

구체적으로 어떤 정보가 필요한가:

```typescript
interface TravelRuleData {
  originatorName: string;   // 교보생명 (발행 주체)
  originatorVasp: string;   // 교보생명 VASP 등록번호
  beneficiaryName: string;  // 수신인(가입자) 실명
  beneficiaryVasp: string;  // 수신 VASP (자체 보관이면 동일)
  amount: bigint;           // KRW 환산 금액
  currency: string;         // "KRW"
}
```

---

### 3. 100만원 경계값의 의미

법 조문: "100만원에 상당하는 가상자산 이전"

코드에서의 표현:
```typescript
private static readonly TRAVEL_RULE_THRESHOLD = BigInt(1_000_000);

// 100만원 미만 → Travel Rule 적용 안 됨
if (params.value < TRAVEL_RULE_THRESHOLD) {
  // travelRuleData 없어도 OK
}

// 100만원 이상 → Travel Rule 적용
if (params.value >= TRAVEL_RULE_THRESHOLD) {
  if (!params.travelRuleData) {
    throw new TravelRuleRequiredError(params.value);
  }
}
```

경계값 케이스:
| 금액 | 결과 |
|------|------|
| 999,999 KRW | Travel Rule 불요 |
| 1,000,000 KRW | Travel Rule 필요 (이상 포함) |
| 1,000,001 KRW | Travel Rule 필요 |

**'이상(>=)'인가 '초과(>)'인가?** 법령 해석상 "100만원 이상"은 100만원 포함이다. `>=`를 사용한다.

---

### 4. VASP별 보조키 정책 차이

Travel Rule 구현은 VASP 계약 시 반드시 협의해야 한다.

| VASP | 멀티시그 지원 | 보조키 정책 | 비고 |
|------|-------------|------------|------|
| 월렛원 | 지원 (2-of-3) | 콜드키 보관 | 상세 SLA 확인 필요 |
| 코다 | 선택적 | MPC 옵션 | Phase 2 검토 |
| EQBR | 제한적 | 별도 협의 | 기술 검증 필요 |

계약서에 "멀티시그 지원 여부", "키 분실 복구 절차", "Travel Rule 데이터 전달 포맷"이 명시되어야 한다.

---

### 5. proposeTx에서의 Travel Rule 통합 흐름

KeyGovernanceService.proposeTx()는 이미 Travel Rule 검증을 포함한다:

```typescript
async proposeTx(proposer: string, params: SafeTxParams): Promise<PendingTx> {
  // [1] Travel Rule 검증 — 100만원 이상이면 데이터 필수
  if (params.value >= KeyGovernanceService.TRAVEL_RULE_THRESHOLD) {
    if (!params.travelRuleData) {
      throw new TravelRuleRequiredError(params.value);
    }
  }

  // [2] SafeTx 해시 계산...
  // [3] DB 저장...
  // [4] 알림...
}
```

`params.travelRuleData`가 `SafeTxParams`에 선택적 필드로 존재한다. 100만원 미만이면 null이어도 되고, 이상이면 필수다.

travelRuleData가 채워진 경우, VASP API 요청 시 함께 전달된다:

```
VASP API 요청:
  POST /vasp/mint
  {
    "to": "0xUserWallet",
    "tokenId": "...",
    "amount": 1500000,
    "travelRuleData": {
      "originatorName": "교보생명",
      "originatorVasp": "VASP-001",
      "beneficiaryName": "홍길동",
      "beneficiaryVasp": "VASP-001",
      "amount": 1500000,
      "currency": "KRW"
    }
  }
```

---

## 실습 파트 (30분)

### checkTravelRule 함수 구현 (독립 검증 유틸리티)

```typescript
// dmz/packages/vasp/src/governance/travelRuleUtils.ts
import { TravelRuleData, TravelRuleRequiredError } from './KeyGovernanceService';

const TRAVEL_RULE_THRESHOLD = BigInt(1_000_000);

/**
 * Travel Rule 요건 검증
 * 100만원(1,000,000 KRW) 이상 → travelRuleData 필수
 */
export function checkTravelRule(
  amount: bigint,
  travelRuleData?: TravelRuleData | null,
): void {
  if (amount >= TRAVEL_RULE_THRESHOLD) {
    if (!travelRuleData) {
      throw new TravelRuleRequiredError(amount);
    }

    // 필수 필드 검증
    if (!travelRuleData.originatorName?.trim()) {
      throw new Error('Travel Rule: originatorName required');
    }
    if (!travelRuleData.beneficiaryName?.trim()) {
      throw new Error('Travel Rule: beneficiaryName required');
    }
  }
  // 100만원 미만 → 통과
}
```

### 100만원 경계값 테스트

```typescript
// test/travelRule.test.ts
import { checkTravelRule } from '../src/governance/travelRuleUtils';
import { TravelRuleRequiredError } from '../src/governance/KeyGovernanceService';

const validTravelRule = {
  originatorName: '교보생명',
  originatorVasp: 'VASP-001',
  beneficiaryName: '홍길동',
  beneficiaryVasp: 'VASP-001',
  amount: 1_000_000n,
  currency: 'KRW',
};

describe('Travel Rule 경계값 검증', () => {
  // ── 임계값 미만 ─────────────────────────────────────────────

  it('999,999원 → travelRuleData 없어도 통과', () => {
    expect(() => checkTravelRule(999_999n, null)).not.toThrow();
  });

  it('0원 → 통과', () => {
    expect(() => checkTravelRule(0n, null)).not.toThrow();
  });

  it('500,000원 → 통과', () => {
    expect(() => checkTravelRule(500_000n, undefined)).not.toThrow();
  });

  // ── 임계값 이상 ─────────────────────────────────────────────

  it('1,000,000원 + travelRuleData 없음 → TravelRuleRequiredError', () => {
    expect(() => checkTravelRule(1_000_000n, null)).toThrow(TravelRuleRequiredError);
  });

  it('1,000,001원 + travelRuleData 없음 → TravelRuleRequiredError', () => {
    expect(() => checkTravelRule(1_000_001n, undefined)).toThrow(TravelRuleRequiredError);
  });

  it('5,000,000원 + travelRuleData 없음 → TravelRuleRequiredError', () => {
    expect(() => checkTravelRule(5_000_000n, null)).toThrow(TravelRuleRequiredError);
  });

  // ── 데이터 첨부 시 통과 ──────────────────────────────────────

  it('1,000,000원 + 유효한 travelRuleData → 통과', () => {
    expect(() => checkTravelRule(1_000_000n, validTravelRule)).not.toThrow();
  });

  it('10,000,000원 + 유효한 travelRuleData → 통과', () => {
    expect(() => checkTravelRule(10_000_000n, validTravelRule)).not.toThrow();
  });

  // ── 필드 누락 ────────────────────────────────────────────────

  it('1,000,000원 + originatorName 누락 → 에러', () => {
    const incomplete = { ...validTravelRule, originatorName: '' };
    expect(() => checkTravelRule(1_000_000n, incomplete)).toThrow(/originatorName/);
  });

  it('1,000,000원 + beneficiaryName 누락 → 에러', () => {
    const incomplete = { ...validTravelRule, beneficiaryName: '' };
    expect(() => checkTravelRule(1_000_000n, incomplete)).toThrow(/beneficiaryName/);
  });
});

describe('KeyGovernanceService — proposeTx에서 Travel Rule 통합', () => {
  it('100만원 이상 TX 제안 + travelRuleData 없음 → TravelRuleRequiredError', async () => {
    const service = createKeyGovernanceService();  // Mock 주입

    await expect(
      service.proposeTx('admin', {
        to: '0x1',
        value: 1_000_000n,
        data: '0x',
        operation: 0,
        // travelRuleData 누락
      }),
    ).rejects.toThrow(TravelRuleRequiredError);
  });

  it('100만원 이상 TX 제안 + 유효한 travelRuleData → 정상 제안', async () => {
    const service = createKeyGovernanceService();

    const tx = await service.proposeTx('admin', {
      to: '0x1',
      value: 1_000_000n,
      data: '0x',
      operation: 0,
      travelRuleData: validTravelRule,
    });

    expect(tx.status).toBe('PENDING_SIGNATURES');
    expect(tx.params.travelRuleData).toEqual(validTravelRule);
  });

  it('100만원 미만 TX → travelRuleData 없어도 정상 제안', async () => {
    const service = createKeyGovernanceService();

    const tx = await service.proposeTx('admin', {
      to: '0x1',
      value: 999_999n,
      data: '0x',
      operation: 0,
    });

    expect(tx.status).toBe('PENDING_SIGNATURES');
  });
});
```

---

## 완료 기준

- [ ] 100만원 이상 + travelRuleData 없음 → `TravelRuleRequiredError` 발생
- [ ] 999,999원 → travelRuleData 없어도 통과
- [ ] 경계값 테스트 전체 통과 (0, 500K, 999,999, 1,000,000, 1,000,001)
- [ ] `proposeTx`에서 Travel Rule 검증 통합 동작 확인
- [ ] 특금법 §8의4 100만원 이상 의무 내용 설명 가능
