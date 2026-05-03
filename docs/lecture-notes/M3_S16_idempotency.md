# M3 S16 — Idempotency 보장 — requestId 기반 중복 TX 방어

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S16 · 강의 55분  
> 대상: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`

---

## S15 → S16 연결

S15에서 EVMAdapter가 `sendTransaction()`으로 TX를 전송하는 방법을 배웠다. 그런데 문제가 있다 — **네트워크는 언제든 실패한다.** TX를 전송했는데 응답이 없으면 재전송해야 한다. 재전송할 때 중복 발행이 일어나지 않으려면 어떻게 해야 하는가? 그것이 **Idempotency(멱등성)**이다.

---

## 0. Idempotency(멱등성)란 무엇인가

수학에서 멱등성: **같은 연산을 여러 번 해도 결과가 같다.**

```
곱셈: 1 × 1 × 1 × 1 = 1  (멱등)
덧셈: 1 + 1 + 1 + 1 = 4  (멱등 아님)
```

소프트웨어에서 멱등성: **같은 요청을 여러 번 보내도 결과가 한 번 보낸 것과 같다.**

```
비멱등 API:
  POST /issue-nft  → NFT 발행 (1개)
  POST /issue-nft  → NFT 발행 (또 1개) → 총 2개 🚨

멱등 API:
  POST /issue-nft { requestId: "abc-123" }  → NFT 발행 (1개)
  POST /issue-nft { requestId: "abc-123" }  → "이미 처리함" → 총 1개 ✅
```

#### 비유: 카드 결제 중복 승인 방지

```
고객이 결제 버튼을 두 번 눌렀다 (네트워크 지연으로 첫 번째 응답 못 받음)
→ 두 번 결제되면? → 민원 폭발

결제사가 사용하는 방법:
  결제 요청에 고유 "거래번호" 부여
  같은 거래번호가 다시 오면 → "이미 처리된 요청" → 금액 한 번만 차감

requestId = 거래번호
```

#### 메시지 전달 보장 3가지

```
At-most-once  (최대 1회):  메시지가 유실될 수 있음. 중복 없음.
                           → 빠르지만 데이터 손실 위험

At-least-once (최소 1회):  메시지는 반드시 전달. 단, 중복 가능.
                           → 손실 없지만 중복 처리 위험

Exactly-once  (정확히 1회): 손실도 중복도 없음.
                           → 구현 매우 어렵고 성능 비용 큼
```

**실무에서는 At-least-once + Idempotency 조합이 표준:**

```
At-least-once: "메시지는 반드시 처리한다"
Idempotency:   "중복이 와도 결과는 같다"
→ 둘을 합치면 사실상 Exactly-once 효과
```

---

## 1. At-least-once 환경에서 중복 발행 리스크

```
시나리오: NFT 발행 요청 → VASP 전송 → 네트워크 타임아웃
         서버: "응답이 없으니 재시도"
         VASP: "이미 처리했는데 또 왔네? 또 발행할게"
         결과: NFT 2개 발행 🚨
```

분산 시스템에서 At-least-once 보장은 필수다. 메시지가 반드시 전달되지만, **두 번 이상 올 수 있다.** Idempotency 없이는 중복 처리가 발생한다.

**requestId(UUID)로 방어:**

```
서버: 같은 requestId로 재전송
VASP: "이 requestId 이미 처리했음 — 무시하고 기존 txHash 반환"
결과: NFT 1개 발행 ✅
```

---

## 2. requestId 흐름 — 전 레이어 관통

```
TxStateMachineService.submitMintRequest()
  ├─ randomUUID() → requestId 생성
  ├─ DB INSERT (REQUESTED 상태)
  └─ vasp.submitMint({ ..., requestId })
                            │
                            ▼
                   VaspTxClient (interface)
                            │
                            ▼
                   VASP 서버 — requestId로 중복 체크
                            │
                            ▼
                   EVMAdapter.mintNFT({ ..., requestId })
                            │
                            ▼
                   컨트랙트 calldata (선택적)
```

requestId가 S13(TxStateMachineService) → S14(MintParams) → S15(EVMAdapter) → VASP 서버까지 관통한다. 각 레이어가 같은 키를 공유하기 때문에 어디서 재시도가 발생해도 중복을 차단할 수 있다.

---

## 3. submitMintRequest — DB 먼저, VASP 나중

```typescript
// TxStateMachineService.ts:128
async submitMintRequest(params: {
  userId:  string;
  tokenId: bigint;
  amount:  bigint;
}): Promise<string> {
  const { userId, tokenId, amount } = params;

  // 1. UUID requestId 생성 — Idempotency key
  const id  = randomUUID();
  const now = new Date();

  // 2. DB INSERT — REQUESTED 상태로 먼저 기록
  const req: MintRequest = {
    id, userId, tokenId, amount,
    status: 'REQUESTED', retryCount: 0,
    createdAt: now, updatedAt: now,
  };
  await this.repo.save(req);    // ← 반드시 먼저

  // 3. VASP 전송
  try {
    const walletAddr = await this.wallet.getWalletAddr(userId);
    const { txHash } = await this.vasp.submitMint({
      to: walletAddr, tokenId, amount, requestId: id,
    });
    // 4. SUBMITTED 전이 + txHash 저장
    await this.repo.updateStatus(id, 'SUBMITTED', { txHash });
  } catch (err) {
    // 5. 실패 시 FAILED 전이
    await this.repo.updateStatus(id, 'FAILED', {
      failReason: `submit failed: ${String(err)}`,
    });
    throw err;
  }

  return id;
}
```

### DB 먼저 저장하는 이유

| 순서 | 서버 크래시 발생 시 결과 |
|---|---|
| **DB 먼저** → VASP 전송 | DB에 REQUESTED 기록 있음 → 재시작 후 미처리 건 발견 → 재처리 가능 |
| **VASP 먼저** → DB 저장 | VASP 전송 성공, DB INSERT 전 크래시 → 기록 없음 → 상태 알 수 없음 → 중복 발행 위험 |

**"DB에 기록된 것만 처리 완료로 인정"** — 이 원칙이 Idempotency의 기반이다.

---

## 4. VaspTxClient 인터페이스 — 3가지 메서드

```typescript
// TxStateMachineService.ts:71
export interface VaspTxClient {
  // TX 발행 요청 — requestId로 멱등성 보장
  submitMint(params: {
    to:        string;
    tokenId:   bigint;
    amount:    bigint;
    requestId: string;   // ← Idempotency key
  }): Promise<{ txHash: string }>;

  // TX 상태 조회 — pollStale, 재확인용
  getStatus(txHash: string): Promise<{
    status:        'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found';
    blockNumber?:  number;
    revertReason?: string;
  }>;

  // TIMEOUT 시 gas bump 재전송 — S17에서 상세
  resubmitWithGasBump(
    txHash:         string,
    gasBumpPercent: number,
  ): Promise<{ txHash: string }>;
}
```

**`not_found` 상태가 있는 이유:**
mempool에서 TX가 drop되는 경우 (gas 너무 낮거나 nonce 충돌). 이 경우 재전송이 필요하다 — FAILED와 구분해서 처리한다.

---

## 5. TX 콜백 핸들러 — VASP Webhook 처리

```typescript
// TxStateMachineService.ts:179
async handleMined(requestId: string, blockNumber: number): Promise<void> {
  const req = await this._getOrThrow(requestId);
  if (req.status !== 'PENDING' && req.status !== 'SUBMITTED') return;  // ← guard
  await this.repo.updateStatus(requestId, 'MINED', { blockNumber });
}

async handleConfirmed(requestId: string): Promise<void> {
  const req = await this._getOrThrow(requestId);
  if (req.status !== 'MINED') return;  // ← guard
  await this.repo.updateStatus(requestId, 'CONFIRMED');
}

async handleFailed(requestId: string, reason: string): Promise<void> {
  await this.repo.updateStatus(requestId, 'FAILED', { failReason: reason });
}
```

**Guard 패턴 — `return` vs `throw` (S13 복습):**

```
handleMined에서 status가 CONFIRMED인 경우:
  → throw: At-least-once 재배달로 같은 핸들러가 두 번 호출될 수 있음
            → throw하면 Worker가 DLQ로 이동 → 운영자 알람 → 불필요한 대응
  → return: 이미 완료된 상태 — 조용히 무시 (멱등성)
```

`handleFailed`는 guard 없이 바로 업데이트한다 — FAILED는 언제나 최종 상태이므로 중복 호출해도 안전하다.

### 핸들러 호출 흐름

```
VASP Webhook → ChainEventListener
                      │
                      ▼
              handleMined(requestId, blockNumber)
                      │
              (Finalized 확인 후)
                      ▼
              handleConfirmed(requestId)
                      │
                      ▼
              LedgerService.recordHolding(+1)   ← M7 연계
```

---

## 6. _getOrThrow 패턴

```typescript
// TxStateMachineService.ts:333
private async _getOrThrow(id: string): Promise<MintRequest> {
  const req = await this.repo.findById(id);
  if (!req) throw new MintRequestNotFoundError(id);
  return req;
}
```

조회 결과가 null이면 즉시 에러를 던진다. 핸들러 모든 곳에서 null 체크를 반복하지 않아도 된다. 에러는 상위에서 catch — 에러 처리 로직을 한 곳으로 집중시킨다.

---

## 7. 에러 클래스 계층

```typescript
// TxStateMachineService.ts:343
export class MintRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`MintRequest not found: ${id}`);
    this.name = 'MintRequestNotFoundError';
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(from: TxStatus, to: TxStatus) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}
```

`name` 필드를 명시하는 이유: `instanceof` 대신 `error.name`으로 에러 종류를 판별할 수 있다. 서로 다른 모듈 경계를 넘어도 문자열 비교로 안전하게 구분된다.

---

## 8. VaspMockClient 전체 구현 실습

```typescript
export class VaspMockClient implements VaspTxClient {
  // requestId → txHash 매핑 (Idempotency 구현)
  private submitted = new Map<string, string>();
  // txHash → status 매핑 (시나리오 시뮬레이션)
  private txStatus  = new Map<string, {
    status: 'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found';
    blockNumber?: number;
    revertReason?: string;
  }>();

  async submitMint(params: {
    to: string; tokenId: bigint; amount: bigint; requestId: string;
  }): Promise<{ txHash: string }> {
    // Idempotency: 같은 requestId → 같은 txHash 반환
    if (this.submitted.has(params.requestId)) {
      return { txHash: this.submitted.get(params.requestId)! };
    }

    const txHash = `0xMOCK_${Date.now().toString(16)}`;
    this.submitted.set(params.requestId, txHash);
    // 기본: pending 상태로 시작
    this.txStatus.set(txHash, { status: 'pending' });
    return { txHash };
  }

  // 테스트 시나리오 설정 — 특정 TX의 상태를 강제 지정
  setTxStatus(txHash: string, status: typeof this.txStatus extends Map<string, infer V> ? V : never) {
    this.txStatus.set(txHash, status);
  }

  async getStatus(txHash: string): Promise<{
    status: 'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found';
    blockNumber?: number;
    revertReason?: string;
  }> {
    return this.txStatus.get(txHash) ?? { status: 'not_found' };
  }

  async resubmitWithGasBump(
    _txHash: string,
    _percent: number,
  ): Promise<{ txHash: string }> {
    const newTxHash = `0xBUMP_${Date.now().toString(16)}`;
    this.txStatus.set(newTxHash, { status: 'pending' });
    return { txHash: newTxHash };
  }
}
```

---

## 9. 실습 — 중복 방어 시나리오 테스트

### 시나리오 1: 정상 흐름

```typescript
it('submitMintRequest → REQUESTED → SUBMITTED 전이', async () => {
  const repo   = new InMemoryTxRepository();
  const vasp   = new VaspMockClient();
  const wallet = { getWalletAddr: async () => '0xAlice...' };
  const svc    = new TxStateMachineService(repo, vasp, wallet);

  const requestId = await svc.submitMintRequest({
    userId: 'user-1', tokenId: 1001n, amount: 1n,
  });

  const req = await repo.findById(requestId);
  expect(req?.status).toBe('SUBMITTED');
  expect(req?.txHash).toBeDefined();
});
```

### 시나리오 2: VASP에 같은 requestId 두 번 → txHash 동일

```typescript
it('동일 requestId 재전송 → 동일 txHash 반환 (멱등성)', async () => {
  const vasp = new VaspMockClient();

  const result1 = await vasp.submitMint({
    to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid',
  });
  const result2 = await vasp.submitMint({
    to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid',
  });

  expect(result1.txHash).toBe(result2.txHash);  // ← 동일 txHash — 중복 발행 없음
});
```

### 시나리오 3: VASP 전송 실패 → DB FAILED 전이

```typescript
it('VASP 전송 실패 → FAILED 전이', async () => {
  const failVasp: VaspTxClient = {
    submitMint:          async () => { throw new Error('network timeout'); },
    getStatus:           async () => ({ status: 'not_found' }),
    resubmitWithGasBump: async () => ({ txHash: '0x0' }),
  };

  const svc = new TxStateMachineService(repo, failVasp, wallet);

  await expect(svc.submitMintRequest({
    userId: 'user-1', tokenId: 1001n, amount: 1n,
  })).rejects.toThrow('network timeout');

  // DB에 FAILED 기록 남아 있음 → 재처리 가능
  const reqs = await repo.findPendingOlderThan(0);  // 전체 조회
  const failed = reqs.find(r => r.status === 'FAILED');
  expect(failed?.failReason).toContain('network timeout');
});
```

### 시나리오 4: handleMined — 이미 CONFIRMED 상태 → return (throw 아님)

```typescript
it('handleMined: CONFIRMED 상태에서 호출 → 조용히 무시 (Idempotency)', async () => {
  await repo.save({ ...mockReq, id: 'req-1', status: 'CONFIRMED' });

  // throw 없이 return — At-least-once 재배달 시 DLQ 이동 방지
  await expect(svc.handleMined('req-1', 9999)).resolves.toBeUndefined();

  const req = await repo.findById('req-1');
  expect(req?.status).toBe('CONFIRMED');  // 변경 없음
});
```

---

## S16 핵심 요약

| 개념 | 핵심 |
|---|---|
| requestId UUID | submitMintRequest에서 생성 → VASP까지 관통하는 Idempotency key |
| DB 먼저 저장 | 크래시 후 REQUESTED 건 재처리 가능 → VASP 먼저면 기록 없음 |
| VASP Idempotency | 같은 requestId → 같은 txHash 반환 → 중복 발행 없음 |
| Guard return | 핸들러에서 이미 완료된 상태 → return (throw 아님) — DLQ 방지 |
| _getOrThrow | null 체크 집중화 — 핸들러마다 반복 제거 |
| VaspMockClient | setTxStatus로 시나리오 제어 → 테스트 시 상태 전이 시뮬레이션 |

**S17 예고:** TX 전송 후 일정 시간 동안 블록에 포함되지 않는 경우(TIMEOUT)와 컨트랙트가 REVERT되는 경우(FAILED)를 처리한다. gas bump 재전송 전략과 NonRetryableError 패턴을 분석한다.

---

**완료 기준:**
- [ ] requestId가 TxStateMachineService → VaspTxClient → EVMAdapter까지 관통하는 이유 설명
- [ ] DB INSERT를 VASP 전송보다 먼저 하는 이유 — 크래시 시나리오 기반 설명
- [ ] `handleMined`에서 CONFIRMED 상태에 guard `return`을 쓰는 이유 (throw와 비교)
- [ ] `VaspMockClient.submitMint` 멱등성 구현 — Map 활용 설명
- [ ] `not_found` 상태가 `failed`와 구분되는 이유
- [ ] `_getOrThrow` 패턴이 핸들러 코드를 단순하게 만드는 원리
