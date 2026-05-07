# Day 13 — M8 마무리: Travel Rule + Phase 1 통합 완성 (S49~S50)

**세션**: S49~S50 | **모듈**: M8 | **시간**: 2시간 (2세션 × 1시간)  
**산출물**: Travel Rule 100만원 체크 + Phase 1 전체 E2E + 장애 주입 3종 + 프로토타입 데모

---

## S49: 가상자산 이전 규제 — Travel Rule 요건과 컴플라이언스 설계 (강의 25분 + 실습 30분)

### 강의

**Travel Rule (특금법 §8의4):**
- 100만원 이상 NFT 전송 시 송수신인 정보 첨부 의무
- 미이행 시 VASP 제재 (영업 정지 포함)

**당사 구현 포인트:**
- 발행 금액 임계값 확인 + 정보 첨부 흐름
- VASP API 요청에 TravelRule 정보 필드 추가

**VASP별 보조키 정책 차이:**
- 월렛원 / 코다 / EQBR: 멀티시그·보조키 제공 여부 상이
- 계약 협의 시 반드시 확인 필요

### 🔴 실습 (30분) — 수강생 직접 작성

**Step 1**: checkTravelRule 구현
```typescript
// internal/packages/business/src/compliance/TravelRuleService.ts
// TODO: 발행 금액 임계값 확인

const TRAVEL_RULE_THRESHOLD = 1_000_000; // 100만원

export class TravelRuleRequired extends Error {
  constructor(amount: number) {
    super(`Travel Rule 필수: ${amount}원 (기준: ${TRAVEL_RULE_THRESHOLD}원)`);
    this.name = 'TravelRuleRequired';
  }
}

export class TravelRuleService {
  checkTravelRule(amount: number): void {
    // TODO: amount >= TRAVEL_RULE_THRESHOLD 이면 TravelRuleRequired throw
  }

  attachTravelRuleInfo(
    vaspRequest: VaspMintRequest,
    senderInfo: TravelRuleInfo,
    receiverInfo: TravelRuleInfo,
  ): VaspMintRequest {
    // TODO: vaspRequest에 travelRule 필드 추가하여 반환
  }
}
```

**Step 2**: 경계값 테스트
```typescript
describe('TravelRuleService', () => {
  const service = new TravelRuleService();

  // TODO: 999,999원 → 예외 없음
  it('999,999원 → Travel Rule 불필요', () => {
    expect(() => service.checkTravelRule(999_999)).not.toThrow();
  });

  // TODO: 1,000,000원 → TravelRuleRequired
  it('1,000,000원 → TravelRuleRequired', () => {
    expect(() => service.checkTravelRule(1_000_000)).toThrow(TravelRuleRequired);
  });

  // TODO: 5,000,000원 → TravelRuleRequired
  it('5,000,000원 → TravelRuleRequired', () => {
    expect(() => service.checkTravelRule(5_000_000)).toThrow(TravelRuleRequired);
  });
});
```

**Step 3**: VASP 요청에 TravelRule 정보 첨부 로직 통합
```typescript
// NftIssuanceService.createNftRequest에 TravelRule 체크 추가
async createNftRequest(userId: string, tokenId: bigint, amount: number, price: number): Promise<string | null> {
  // TODO: travelRuleService.checkTravelRule(price)
  // TODO: 100만원 이상이면 senderInfo + receiverInfo를 VASP 요청에 첨부
  // TODO: travelRuleService.attachTravelRuleInfo(vaspRequest, ...)
}
```

### ✅ 답안

```typescript
// checkTravelRule 완성
checkTravelRule(amount: number): void {
  if (amount >= TRAVEL_RULE_THRESHOLD) {
    throw new TravelRuleRequired(amount);
  }
}

// attachTravelRuleInfo 완성
attachTravelRuleInfo(
  vaspRequest: VaspMintRequest,
  senderInfo: TravelRuleInfo,
  receiverInfo: TravelRuleInfo,
): VaspMintRequest {
  return {
    ...vaspRequest,
    travelRule: {
      sender: senderInfo,   // 이름, 생년월일, 지갑 주소
      receiver: receiverInfo,
      reportedAt: new Date().toISOString(),
    },
  };
}

// NftIssuanceService 통합
async createNftRequest(userId: string, tokenId: bigint, amount: number, price: number): Promise<string | null> {
  // Travel Rule 체크
  let travelRuleRequired = false;
  try {
    this.travelRuleService.checkTravelRule(price);
  } catch (err) {
    if (err instanceof TravelRuleRequired) {
      travelRuleRequired = true;
    } else throw err;
  }

  const shouldIssue = await this.conditionService.shouldIssueNFT({ userId, tokenId, amount });
  if (!shouldIssue) return null;

  const walletAddress = await this.walletService.getWalletAddress(userId);
  
  let vaspRequest = buildMintRequest(userId, walletAddress, tokenId, amount);
  
  if (travelRuleRequired) {
    const senderInfo = await this.kycService.getSenderInfo(userId);
    const receiverInfo = { walletAddress };
    vaspRequest = this.travelRuleService.attachTravelRuleInfo(vaspRequest, senderInfo, receiverInfo);
  }

  return await this.vaspService.submitMintRequest(vaspRequest);
}
```

### ✅ 완료 기준
- [ ] 100만원 이상 → TravelRuleRequired
- [ ] 경계값 테스트 통과
- [ ] VASP 요청에 정보 첨부 동작

---

## S50: Phase 1 전체 시스템 통합과 장애 주입 기반 복원력 검증 (강의 10분 + 실습 45분)

### 강의 (10분)

**Phase 1 전체 흐름 최종 확인:**
```
앱 이벤트
  → EventConditionService (조건 판단)
  → NftIssuanceService (요청 생성)
  → VaspService (VASP 전달)
  → 블록체인 (온체인 발행)
  → DMZ WebhookReceiver (이벤트 수신)
  → Redis Streams Queue (내구성 보장)
  → EventConsumer (멱등 처리)
  → LedgerService (원장 업데이트)
  → AuditLogService (감사 로그)
```

### 🔴 실습 (45분) — 수강생 직접 작성 + 팀 실행

**Step 1**: 정상 E2E — 1건 완주
```typescript
// blockchain/test/e2e/Phase1E2E.test.ts
// TODO: 앱 이벤트 1건 → NFT 발행 → 원장 업데이트 → 감사 로그 전체 1회 완주

it('Phase 1 정상 E2E', async () => {
  // 1. 사용자 지갑 등록
  // 2. 보험 납입 이벤트 발생 (10만원)
  // 3. createNftRequest → requestId 획득
  // 4. VASP Mock: 발행 완료 → Webhook 전송
  // 5. Consumer: 이벤트 처리 → holdings +1
  // 6. audit_log에 MINT 기록 확인
  // 7. chain integrity 검증 통과
});
```

**Step 2**: 장애 주입 1 — VASP 중단 → 복구
```typescript
it('장애 1: VASP 중단 → 백오프 재시도 → 복구', async () => {
  // TODO: VASP Mock: 3회 500 에러 후 정상
  // TODO: vaspService.submitMintRequest() 호출
  // TODO: withRetry 동작 확인 → 4번째 시도 성공
  // TODO: 최종 상태 SUBMITTED 확인
});
```

**Step 3**: 장애 주입 2 — Reorg → 원장 롤백 → 재확인
```typescript
it('장애 2: Reorg → 원장 롤백 → CONFIRMED', async () => {
  // TODO: CONFIRMED 상태 설정
  // TODO: handleReorg() 호출 → REORGED 전이
  // TODO: VASP Mock: 재조회 시 CONFIRMED 응답
  // TODO: 최종 상태 CONFIRMED + 원장 보존 확인
});
```

**Step 4**: 장애 주입 3 — Consumer 강제 종료 → 재시작 후 중복 없이 재처리
```typescript
it('장애 3: Consumer 강제 종료 → 재시작 후 중복 없음', async () => {
  // TODO: Consumer 실행 중 메시지 읽기 (XACK 전)
  // TODO: Consumer 강제 종료
  // TODO: Consumer 재시작
  // TODO: XAUTOCLAIM으로 미처리 메시지 재수신
  // TODO: 멱등성 체크 → 원장 1회만 반영 확인
});
```

**Step 5**: 프로토타입 데모 리허설
```bash
# 데모 시나리오 (5분 안에 완주)
# 1. 로컬 환경 전체 기동 확인
#    - Hardhat 노드 (포트 8545)
#    - Redis (포트 6379)
#    - Internal API 서버 (포트 3000)
#    - Consumer 프로세스
# 2. 정상 E2E 1건 실행 → 로그 확인
# 3. "NFT 발행 → 원장 업데이트 → 감사 로그" 3개 포인트 시연
```

### ✅ 답안

```typescript
// Phase 1 정상 E2E 완성
it('Phase 1 정상 E2E', async () => {
  // 1. 지갑 등록
  await walletService.registerWalletAddress(userId, walletAddress, validSignature);

  // 2. 이벤트 발생 + 조건 판단 + NFT 요청
  const requestId = await nftIssuanceService.createNftRequest(userId, 2001n, 1, 100_000);
  expect(requestId).toBeDefined();

  // 3. VASP Mock → Webhook 전송 시뮬레이션
  const webhookPayload = { eventType: 'NFTIssued', txHash: '0xabc', logIndex: 0, tokenId: 2001, to: walletAddress };
  const sig = computeHmac(webhookPayload, testSecret);
  await request(app).post('/webhook').set('X-Signature', sig).send(webhookPayload).expect(202);

  // 4. Consumer 처리 대기
  await waitForConsumer(500);

  // 5. 원장 확인
  const holdings = await db('user_nft_holdings').where({ user_id: userId, token_id: '2001' }).first();
  expect(holdings.amount).toBe(1);

  // 6. 감사 로그 확인
  const auditEntry = await db('audit_log').where({ action: 'NFT_MINT_CONFIRMED' }).first();
  expect(auditEntry).toBeDefined();

  // 7. chain integrity
  const integrity = await auditLogService.verifyChainIntegrity();
  expect(integrity.valid).toBe(true);
});
```

### ✅ Phase 1 Prototype 완성 조건 (전부 통과해야 프로토타입)

- [ ] 앱 이벤트 → NFT 발행 → 원장 E2E 전체 동작
- [ ] VASP 장애 → 복구 후 정상 복귀
- [ ] Reorg → 원장 롤백 + 재확인
- [ ] Consumer 장애 → 중복 없이 재처리
- [ ] 감사 로그 체인 무결성 통과
- [ ] 1-of-3 서명 대형 TX 불가
- [ ] Travel Rule 100만원 동작
