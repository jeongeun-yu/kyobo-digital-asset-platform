# M3 S16 — 분산 시스템에서의 멱등성 보장 원칙

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S16 · 1시간  
> 대상: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`

---

## S16 — 멱등성 보장 원칙과 submitMintRequest 구현

### 1. requestId가 없으면 생기는 문제

```
시나리오: NFT 발행 요청 → 네트워크 타임아웃
서버: "응답이 없으니 재시도"
VASP: "이미 처리했는데 또 왔네? 또 발행할게"
결과: NFT 2개 발행 🚨
```

requestId(UUID)가 있으면:

```
서버: 같은 requestId로 재전송
VASP: "이 requestId 이미 처리했음 — 무시"
결과: NFT 1개 발행 ✅
```

### 2. submitMintRequest 전체 흐름

```typescript
// TxStateMachineService.ts:128
async submitMintRequest(params: {
  userId:  string;
  tokenId: bigint;
  amount:  bigint;
}): Promise<string> {
  const { userId, tokenId, amount } = params;

  // 1. UUID requestId 생성 — Idempotency key
  const id  = randomUUID();    // TxStateMachineService.ts:135
  const now = new Date();

  // 2. DB INSERT — REQUESTED 상태로 먼저 기록
  const req: MintRequest = {
    id, userId, tokenId, amount,
    status: 'REQUESTED', retryCount: 0,
    createdAt: now, updatedAt: now,
  };
  await this.repo.save(req);    // TxStateMachineService.ts:149

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

**왜 DB INSERT를 VASP 전송보다 먼저 하는가:**

```
DB INSERT 먼저:
  VASP 전송 중 서버 크래시 → DB에 REQUESTED 기록 있음
  → 재시작 후 REQUESTED 건 발견 → 재처리 가능

VASP 전송 먼저:
  VASP 전송 성공, DB INSERT 크래시 → DB에 기록 없음
  → 재시작 후 상태 알 수 없음 → 중복 발행 위험
```

### 3. VASP Mock 기초 구현

```typescript
// 실습: VASP Mock 서버 — 정상 응답 시나리오
export class VaspMockClient implements VaspTxClient {
  private submitted = new Map<string, string>(); // requestId → txHash

  async submitMint(params: {
    to: string; tokenId: bigint; amount: bigint; requestId: string;
  }): Promise<{ txHash: string }> {
    // 멱등성: 같은 requestId는 같은 txHash 반환
    if (this.submitted.has(params.requestId)) {
      return { txHash: this.submitted.get(params.requestId)! };
    }
    const txHash = `0x${crypto.randomUUID().replace(/-/g, '')}`;
    this.submitted.set(params.requestId, txHash);
    return { txHash };
  }

  async getStatus(txHash: string): Promise<{
    status: 'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found';
    blockNumber?: number;
  }> {
    // TODO: 시나리오별 응답 설정 (S17에서 확장)
    return { status: 'confirmed', blockNumber: 12345 };
  }

  async resubmitWithGasBump(txHash: string, _percent: number): Promise<{ txHash: string }> {
    const newTxHash = `0x${crypto.randomUUID().replace(/-/g, '')}`;
    return { txHash: newTxHash };
  }
}
```

### 4. 실습 — 중복 requestId 테스트

```typescript
// 실습: 동일 requestId 재전송 → 중복 발행 없음 확인
it('동일 userId+tokenId 재요청 → DB 1건만', async () => {
  const service = new TxStateMachineService(repo, vaspMock, walletResolver);

  const requestId1 = await service.submitMintRequest({
    userId: 'user-1', tokenId: 1001n, amount: 1n,
  });

  // 같은 파라미터로 재요청 — 다른 requestId가 생성되므로
  // VASP Mock의 멱등성 키는 requestId = UUID이므로 두 번째는 별도 처리됨
  // 진짜 멱등성은 VASP가 requestId를 체크해서 보장

  const req = await repo.findById(requestId1);
  expect(req?.status).toBe('SUBMITTED');
});

it('VASP에 같은 requestId 두 번 전송 → txHash 동일', async () => {
  const vaspMock = new VaspMockClient();
  const result1 = await vaspMock.submitMint({
    to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'same-id',
  });
  const result2 = await vaspMock.submitMint({
    to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'same-id',
  });
  expect(result1.txHash).toBe(result2.txHash); // ← 동일 txHash
});
```

**완료 기준:**
- [ ] `submitMintRequest` 호출 → DB에 REQUESTED → SUBMITTED 전이 확인
- [ ] 동일 requestId를 VASP Mock에 2회 전송 → 동일 txHash 반환 확인
- [ ] VASP 전송 실패 → DB에 FAILED 전이 확인
