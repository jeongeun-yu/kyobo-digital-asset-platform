# M5 S32 — 이벤트에서 NFT 요청까지 · 단건 발행 흐름 설계

> 모듈 5 · 세션 32 · 1시간  
> 스켈레톤: `internal/apps/issuer-service/src/services/IssuerService.ts`

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.

> **Phase 1 단건 발행 흐름 핵심**  
> `IssuerService`의 발행 요청은 `vaspAdapter.submitTransaction()`을 호출해 **월렛원 REST API**로 전달된다.  
> 월렛원이 TX를 서명·브로드캐스트하고 온체인 확정 후 Webhook으로 콜백을 보낸다.  
> Phase 3에서는 `chainAdapter.sendTransaction()`을 직접 호출하는 경로로 전환된다.  
> // Phase 1: vaspAdapter.submitTransaction() 으로 대체  
> // Phase 3 이후 활성화: 자체 Custody 인가 취득 후 chainAdapter.sendTransaction() 직접 호출

---

## 강의 파트 (15분)

### 1. M2~M4까지 만든 부품이 여기서 연결된다

지금까지 각 레이어를 따로 배웠다. 이번 세션에서 처음으로 전체 흐름을 한 번에 관통한다.

```
[활동 이벤트 수신] (ConsumerGroupWorker — M2 S10)
      │
      ▼
[멱등성 체크] recordProcessedEvent()  (M4 S24)
  → skipped: true  → XACK, 종료
  → skipped: false → 계속
      │
      ▼
[조건 판단] EventConditionService.evaluate()  (M5 S30)
  → eligible: false → XACK, 종료
  → eligible: true  → 계속
      │
      ▼
[지갑 주소 조회] WalletMappingService.getWalletAddr()  (M5 S28)
  → WalletNotFoundError → DLQ 이동
      │
      ▼
[발행 요청 생성] LedgerService.createMintRequest()  (M4 S23)
  → requestId 발급
      │
      ▼
[VASP 전달] TxStateMachineService.submitMintRequest()  (M3 S13)
  → PENDING → SUBMITTED
      │
      ▼
[KYC + AML] IssuerService.issueActivityNFT()  ← 이번에 구현
  → AML 블랙리스트 체크
  → 컨트랙트 호출
  → Core Banking 알림
```

각 단계가 실패하면 다음 단계로 가지 않는다. 파이프라인 설계다.

---

### 2. IssuerService의 역할 — 비즈니스 레이어 최상단

`IssuerService`는 비즈니스 로직의 최상단 오케스트레이터다. 직접 DB를 건드리지 않는다.

```typescript
export class IssuerService {
  constructor(private readonly deps: {
    chainAdapter:  IBlockchainAdapter;    // 컨트랙트 호출 (체인 무관)
    vaspAdapter:   IVASPAdapter;          // AML 스크리닝
    coreBanking:   ICoreBankingAdapter;   // Core Banking 알림
    idempotency:   IdempotencyGuard;      // 멱등성 키 관리
    nftIssuerAddr: string;                // 컨트랙트 주소
  }) {}
}
```

모든 의존성이 인터페이스다. EVM → XRPL로 체인이 교체돼도 `IssuerService` 코드는 변경 없다.

---

### 3. `activityId` — 단건 발행의 멱등성 키

```typescript
async issueActivityNFT(params: {
  userId:     string;
  activityId: string;   // 이 활동의 고유 ID → 멱등성 키
  oracleData: { ... };
}): Promise<{ txHash: string }>
```

`activityId`를 컨트랙트에 전달하면, 컨트랙트에서 같은 `activityId`로 두 번 발행을 막는다(M6에서 구현). 서비스 레이어와 컨트랙트 양쪽에서 이중으로 멱등성을 보장한다.

---

### 4. 단건 발행 파이프라인 — 아스키 순서도

```
활동 이벤트 수신 (ConsumerGroupWorker)
          │
          ▼
┌─────────────────────────────────────┐
│  멱등성 체크                          │
│  recordProcessedEvent(eventId)       │
└──────────────┬──────────────────────┘
               │
        ┌──────┴──────┐
        │ skipped=true │  → XACK (이미 처리됨, 종료)
        └──────┬───────┘
         skipped=false
               │
               ▼
┌─────────────────────────────────────┐
│  조건 판단                            │
│  EventConditionService.evaluate()    │
└──────────────┬──────────────────────┘
               │
        ┌──────┴──────┐
        │eligible=false│ → XACK (조건 미충족, 종료)
        └──────┬───────┘
         eligible=true
               │
               ▼
┌─────────────────────────────────────┐
│  지갑 주소 조회                        │
│  WalletMappingService.getWalletAddr()│
└──────────────┬──────────────────────┘
               │
        ┌──────┴────────────────┐
        │ WalletNotFoundError   │ → DLQ 이동 (지갑 미등록)
        └──────┬────────────────┘
          주소 반환
               │
               ▼
┌─────────────────────────────────────┐
│  AML 스크리닝                         │
│  vaspAdapter.screenAddress()         │
└──────────────┬──────────────────────┘
               │
        ┌──────┴──────────┐
        │ flagged=true    │ → Error (AML 차단)
        └──────┬──────────┘
         flagged=false
               │
               ▼
┌─────────────────────────────────────┐
│  컨트랙트 호출                         │
│  chainAdapter.sendTransaction()      │
│  NFTIssuer.issueActivityNFT(...)     │
└──────────────┬──────────────────────┘
               │
        ┌──────┴──────────┐
        │ status='failed' │ → Error (TX 실패)
        └──────┬──────────┘
         status='success'
               │
               ▼
┌─────────────────────────────────────┐
│  Core Banking 알림 (fire-and-forget)  │
│  coreBanking.notifyReward().catch()  │
└──────────────┬──────────────────────┘
               │
               ▼
        { txHash: '0x...' }  반환
```

각 단계가 실패하면 다음 단계로 진행하지 않는다. 단, Core Banking 알림 실패는 예외다 — 발행은 이미 완료됐으므로 알림 실패가 발행을 되돌리면 안 된다.

---

### 5. 멱등성 이중 보장 — 서비스 레이어와 컨트랙트 모두에서

단건 발행에서 멱등성은 두 군데에서 동시에 보장한다.

```
┌─────────────────────────────────────────────────────────┐
│  레이어 1: 서비스 (IssuerService)                         │
│                                                         │
│  activityId → idempotencyGuard.check(activityId)        │
│    → 이미 처리됨 → 즉시 리턴 (DB 조회 끝)                │
│    → 미처리    → 계속 진행 후 처리 완료 기록              │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼ (레이어 1 통과 시)
┌─────────────────────────────────────────────────────────┐
│  레이어 2: 스마트 컨트랙트 (KyoboNFT.sol — M6 구현)       │
│                                                         │
│  mapping(bytes32 => bool) public processedActivities;   │
│                                                         │
│  function issueActivityNFT(address to, bytes32 actId)   │
│    external onlyIssuer {                                │
│      require(!processedActivities[actId], "duplicate"); │
│      processedActivities[actId] = true;                 │
│      _mint(to, tokenId, 1, "");                         │
│  }                                                      │
└─────────────────────────────────────────────────────────┘
```

레이어 1은 DB에서 빠르게 차단 (VASP API 호출 비용 절약). 레이어 2는 컨트랙트에서 최종 보장 (서비스 레이어 버그가 있어도 이중 발행 불가). 두 레이어 중 하나만 있어도 동작하지만, 둘 다 있어야 진짜 안전하다.

---

### 6. CoreBanking 알림 — `.catch()` 패턴

```typescript
// 발행은 이미 완료됨 → 알림 실패가 발행을 롤백하면 안 됨
this.deps.coreBanking.notifyReward(...).catch(err =>
  console.error('[IssuerService] CoreBanking notify failed:', err)
);
// → fire-and-forget: 결과를 기다리지 않음
```

이 패턴이 왜 필요한가?

NFT 발행은 블록체인에서 이미 완료됐다. Core Banking 알림이 실패했다고 NFT를 burn할 수는 없다. 알림 실패는 별도로 재처리하거나 DLQ로 보내야 한다.

발행 완료 후 후처리 실패가 발행 자체를 롤백하면 안 된다는 원칙이다. M2 DLQ 패턴(S11)과 같은 철학이다.

---

## 실습 파트 (40분)

### `issueActivityNFT()` 전체 구현

```typescript
async issueActivityNFT(params: {
  userId:     string;
  activityId: string;
  oracleData: { dataType: string; value: number; timestamp: number; signature: string };
}): Promise<{ txHash: string }> {
  const { userId, activityId, oracleData } = params;

  // 1. Core Banking에서 계정 + 지갑 주소 조회
  const account = await this.deps.coreBanking.getUserAccount(userId);
  if (!account) throw new Error(`user not found: ${userId}`);
  if (account.status !== 'active') throw new Error(`account not active: ${userId}`);

  // 2. AML 스크리닝 — 블랙리스트 지갑 주소 차단
  const aml = await this.deps.vaspAdapter.screenAddress(account.walletAddr);
  if (aml.flagged) throw new Error(`AML flagged: ${aml.reason}`);

  // 3. 컨트랙트 호출 — NFTIssuer.issueActivityNFT
  const receipt = await this.deps.chainAdapter.sendTransaction({
    contractAddr: this.deps.nftIssuerAddr,
    abi:          NFT_ISSUER_ABI,
    method:       'issueActivityNFT',
    args: [
      account.walletAddr,
      `0x${Buffer.from(activityId).toString('hex').padEnd(64, '0')}`,  // bytes32
      oracleData,
    ],
  });

  if (receipt.status === 'failed') {
    throw new Error(`tx failed: ${receipt.txHash}`);
  }

  // 4. Core Banking 알림 — fire-and-forget (발행 성공 후 비동기 처리)
  this.deps.coreBanking.notifyReward({
    userId,
    rewardType: 'ACTIVITY_NFT',
    tokenId:    activityId,
    txHash:     receipt.txHash,
    issuedAt:   receipt.timestamp,
  }).catch(err => console.error('[IssuerService] CoreBanking notify failed:', err));

  return { txHash: receipt.txHash };
}
```

### `createNftRequest()` 구현 — 조건 판단 후 발행 요청 생성

```typescript
async createNftRequest(userId: string, tokenId: bigint, amount: bigint): Promise<string> {
  // 1. 지갑 주소 조회
  const walletAddr = await this.walletMappingService.getWalletAddr(userId);
  // → WalletNotFoundError 발생 시 상위로 전파

  // 2. 발행 요청 생성 (원장에 PENDING 기록)
  const mintRequest = await this.ledgerService.createMintRequest(userId, 'policy-001');

  // 3. VASP 추상화 레이어에 전달
  // Phase 1: 내부적으로 vaspAdapter.submitTransaction() → 월렛원 REST API 호출
  // Phase 3 이후 활성화: chainAdapter.sendTransaction() 직접 호출 (자체 Custody 인가 취득 후)
  await this.txStateMachineService.submitMintRequest({
    requestId: mintRequest.id,
    walletAddr,
    tokenId,
    amount,
  });

  return mintRequest.id;
}
```

### E2E 테스트 — 이벤트 → VASP 전달 1건

```typescript
it('이벤트 → 조건 평가 → 지갑 조회 → 발행 E2E', async () => {
  // Mock 설정
  const mockChain: IBlockchainAdapter = {
    async sendTransaction() {
      return { status: 'success', txHash: '0xabc123', timestamp: Date.now() };
    },
  };
  const mockCoreBanking: ICoreBankingAdapter = {
    async getUserAccount(userId) {
      return { userId, walletAddr: '0xWallet001', status: 'active' };
    },
    async notifyReward() {},
  };
  const mockVasp = {
    async screenAddress() { return { flagged: false }; },
  };

  const issuerService = new IssuerService({
    chainAdapter:  mockChain,
    vaspAdapter:   mockVasp as any,
    coreBanking:   mockCoreBanking as any,
    idempotency:   mockIdempotency,
    nftIssuerAddr: '0xNFTContract',
  });

  const result = await issuerService.issueActivityNFT({
    userId:     'K-20240001',
    activityId: 'act-walk-20240315-001',
    oracleData: { dataType: 'WALK', value: 15000, timestamp: Date.now(), signature: '0xSig' },
  });

  expect(result.txHash).toBe('0xabc123');
});

it('조건 미충족 이벤트 → NFT 요청 생성 안 됨', async () => {
  // steps=5000 (목표 10000 미달)
  const event = { eventType: 'WALK_GOAL_MET', data: { steps: 5000 }, ... };
  const conditionResult = await conditionService.evaluate(event);

  expect(conditionResult.eligible).toBe(false);
  // createNftRequest 호출 안 됨 확인
  expect(mockCreateNftRequest).not.toHaveBeenCalled();
});
```

---

## 완료 기준

- [ ] 조건 미충족 → createNftRequest 호출 안 됨 (Mock 검증)
- [ ] 이벤트 → VASP 전달 E2E 1건 동작 (txHash 반환 확인)
- [ ] AML flagged=true → Error throw, 컨트랙트 호출 안 됨 확인
- [ ] CoreBanking 알림 실패 → 발행 TX 롤백 없음 확인 (catch 패턴)
- [ ] 동일 activityId 두 번 호출 → 두 번째는 멱등성 체크에서 차단
- [ ] account.status !== 'active' → 발행 차단 확인
- [ ] WalletNotFoundError → DLQ 경로로 이동하는 것 이해 (상위 Worker에서 처리)
