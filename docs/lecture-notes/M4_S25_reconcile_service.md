# M4 S25 — 온체인 상태와 내부 원장의 정합성 유지 · ReconcileService

> 모듈 4 · 세션 25 · 1시간  
> 스켈레톤: `dmz/packages/core-banking/src/reconcile/ReconcileService.ts`

---

## 강의 파트 (20분)

### 1. 원장과 온체인이 어긋나는 상황은 반드시 발생한다

S24에서 멱등 처리를 구현했지만, 아직 해결 안 된 문제가 있다.

**시나리오 1: Consumer 장애로 이벤트 미처리**

```
NFTIssued 이벤트 발생
  → ConsumerGroupWorker 수신
  → DB 처리 시작
  → DB 서버 순간 장애
  → Worker crash
  → 이벤트는 Redis PEL에 남아있지만 처리 안 됨
  → 재시작 후 DLQ로 이동
  → DLQ 처리가 늦어짐

결과:
  온체인: balanceOf(user) = 1  ← NFT 발행 완료됨
  원장:   user_nft_holdings에 없음  ← 이벤트 미처리
```

이 상태에서 사용자가 앱을 열면 "내 NFT가 없다"는 화면이 뜬다. 온체인에는 분명히 있는데.

**시나리오 2: Reorg 후 원장 미업데이트**

```
블록 #1000에서 NFTIssued 이벤트 처리 → 원장에 기록
블록 체인 Reorg → 블록 #1000이 폐기됨
원장: NFT 보유 기록 있음
온체인: NFT 없음  ← Reorg로 TX 소실
```

**시나리오 3: 운영자 실수**

```
DB 직접 접속 → user_nft_holdings 레코드 잘못 삭제
원장: NFT 없음
온체인: balanceOf = 1  ← 여전히 보유 중
```

이런 불일치가 쌓이면 원장을 신뢰할 수 없게 된다.

---

### 2. 단일 진실 원칙 — 온체인이 항상 맞다

```
온체인 balanceOf() = 항상 진실 (source of truth)
원장 user_nft_holdings = 온체인에서 파생된 캐시
```

이 원칙에서 중요한 결론이 나온다:

**불일치 발생 시 원장을 온체인 기준으로 보정한다. 반대 방향(원장 → 온체인 수정)은 절대 금지.**

왜 "절대" 금지인가?

원장 데이터를 기반으로 온체인을 수정하는 코드가 있다면, 누군가 원장을 조작해서 임의의 NFT 발행을 유발하는 경로가 생긴다. 원장은 일반 DB다. DB에 직접 접근 가능한 운영자라면 이 경로로 온체인 TX를 유발할 수 있다.

이것은 **보안 취약점**이다.

---

### 3. ReconcileService가 할 수 있는 것과 할 수 없는 것

```typescript
// ✅ ReconcileService가 해야 하는 것
async reconcile(): Promise<ReconcileResult>
  → 온체인 상태와 원장 비교
  → 불일치 감지
  → 알림 발송
  → 감사 로그 기록

// ❌ ReconcileService에 절대 있으면 안 되는 것
// async fixOnchain(userId: string, amount: bigint) {...}
// async forceMint(tokenId: bigint) {...}
// → 원장 기반으로 온체인 TX 발생 = 보안 구멍
```

불일치 보정이 필요하다면:
1. ReconcileService가 불일치를 감지하고 알림
2. 담당자가 원인 분석 (진짜 불일치인가? 처리 지연인가?)
3. 판단 후 IssuerService 정상 프로세스를 통해 새 TX 발행

자동 보정이 없는 이유: 원장의 불일치가 버그인지 정상 지연인지 코드가 판단할 수 없다.

---

### 4. KRW 스테이블코인 Reconcile — Phase 1 실제 구조

스켈레톤을 보면 ReconcileService는 `user_nft_holdings`가 아닌 **KRW 스테이블코인 발행량 vs 원화 수탁 계좌 잔액**을 검증한다.

```
온체인 KRW totalSupply  ←→  교보생명 원화 수탁 계좌 잔액
```

왜 이것이 더 중요할까?

스테이블코인은 1 KRW Token = 1원이어야 한다. 온체인에서 1000만 토큰이 발행됐는데 수탁 계좌에 900만원밖에 없다면 과잉발행(over-issuance)이다. 이것은 금융 사기다.

```typescript
export class ReconcileService {
  constructor(
    private readonly coreBanking: ICoreBankingAdapter,
    private readonly onchain: {
      getTotalSupply(): Promise<bigint>;
      getCustodyAccountBalance(): Promise<bigint>;
    },
    private readonly alerter: {
      fire(message: string, severity: 'warn' | 'critical'): Promise<void>;
    },
  ) {}
}
```

---

### 5. `reconcile()` 구현 분석

```typescript
async reconcile(): Promise<ReconcileResult> {
  // 온체인 발행량과 수탁 계좌 잔액을 동시에 조회
  const [onchainSupply, bankBalance] = await Promise.all([
    this.onchain.getTotalSupply(),
    this.onchain.getCustodyAccountBalance(),
  ]);

  const disparity = onchainSupply - bankBalance;  // 양수: 과잉발행, 음수: 과소발행
  const tolerance = 1n;  // ±1원 허용 (처리 지연 고려)
  const isHealthy = disparity >= -tolerance && disparity <= tolerance;

  if (!isHealthy) {
    // 100만원 이상 불일치는 즉각 긴급 알림
    const severity = Math.abs(Number(disparity)) >= 1_000_000 ? 'critical' : 'warn';
    await this.alerter.fire(
      `[Reconcile] 불일치: onchain=${onchainSupply}, bank=${bankBalance}, diff=${disparity}`,
      severity,
    );
  }

  return { onchainSupply, bankBalance, disparity, isHealthy, timestamp: Date.now() };
}
```

허용 오차(tolerance = 1n)가 있는 이유: mint TX가 블록에 포함된 후 Core Banking에 기록되기까지 수 초~수십 초의 지연이 있다. 이 구간에 Reconcile이 실행되면 1원짜리 불일치가 잡힌다. 오차 없이 엄격하게 검사하면 정상 운영 중에도 경보가 울린다.

**심각도 분류:**

| 불일치 크기 | 심각도 | 의미 |
|---|---|---|
| ±1원 이내 | 정상 | 처리 지연 허용 범위 |
| ±1원 초과, ±100만원 미만 | warn | 조사 필요, 긴급 아님 |
| ±100만원 이상 | critical | 즉각 수동 검토 필요 |

과잉발행(disparity 양수)이 더 위험하다: 원화 담보 없이 KRW 토큰이 시장에 풀리는 것이기 때문이다.

---

### 6. 실행 주기 — 실시간 + 정기

```
실시간: 각 mint/burn 이벤트 → ReconcileService.onMint() / onBurn()
         → Core Banking에 즉시 기록
         → 증분 불일치 감지 (Phase 2)

정기:   매일 00:00 KST → ReconcileService.reconcile() 전체 대조
         → 누적 불일치 감지

수동:   Admin API → POST /admin/reconcile (S50에서 구현)
         → 즉시 Reconcile 트리거
```

---

## 실습 파트 (35분)

### `reconcile()` 동작 이해 테스트

```typescript
// 테스트 케이스 1: 정상 상태
it('onchainSupply = bankBalance → isHealthy = true', async () => {
  const service = createService({
    totalSupply: 1_000_000n,
    bankBalance: 1_000_000n,
  });
  const result = await service.reconcile();
  expect(result.isHealthy).toBe(true);
  expect(result.disparity).toBe(0n);
});

// 테스트 케이스 2: 허용 오차 내
it('±1원 오차 → isHealthy = true', async () => {
  const service = createService({
    totalSupply: 1_000_001n,
    bankBalance: 1_000_000n,
  });
  const result = await service.reconcile();
  expect(result.isHealthy).toBe(true);  // 1원 차이는 허용
});

// 테스트 케이스 3: warn 알림
it('100만원 미만 불일치 → warn 알림', async () => {
  const alertSpy = jest.fn();
  const service = createService(
    { totalSupply: 1_000_000n, bankBalance: 999_000n },  // 1000원 차이
    alertSpy,
  );
  const result = await service.reconcile();
  expect(result.isHealthy).toBe(false);
  expect(alertSpy).toHaveBeenCalledWith(expect.any(String), 'warn');
});

// 테스트 케이스 4: critical 알림
it('100만원 이상 불일치 → critical 알림', async () => {
  const alertSpy = jest.fn();
  const service = createService(
    { totalSupply: 5_000_000n, bankBalance: 3_000_000n },  // 200만원 차이
    alertSpy,
  );
  await service.reconcile();
  expect(alertSpy).toHaveBeenCalledWith(expect.any(String), 'critical');
});
```

### 강제 불일치 삽입 테스트

```typescript
it('user_nft_holdings 직접 수정 → reconcile 감지', async () => {
  // 1. 정상 발행 후 원장에 기록
  await ledger.createMintRequest('user1', 'policy-001');
  // ... 이벤트 처리 → holdings 저장

  // 2. DB 직접 수정 (운영자 실수 시뮬레이션)
  await db.query("UPDATE user_nft_holdings SET token_id = 999 WHERE user_id = 'user1'");

  // 3. Reconcile 실행 → 불일치 감지
  const result = await service.reconcile();
  expect(result.isHealthy).toBe(false);
  // alerter.fire 호출 확인
});
```

### 역방향 수정 코드 없음 확인

ReconcileService 소스에서 온체인 TX를 발행하는 코드가 없는지 확인:

```bash
# 스켈레톤에서 온체인 TX 관련 메서드 없음 확인
grep -n "mintBatch\|mint(\|sendTransaction" ReconcileService.ts
# → 결과 없음이 정상
```

---

## 완료 기준

- [ ] 강제 불일치 → Reconcile 감지 + 알림
- [ ] 역방향 수정 코드 없음 확인
- [ ] tolerance 기준 severity 분류 설명 가능
- [ ] warn / critical 분기 테스트 통과
