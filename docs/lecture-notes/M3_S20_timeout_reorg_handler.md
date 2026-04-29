# M3 S20 — TIMEOUT·REORG 복구 핸들러 구현

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S20 · 1시간  
> 대상: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`, `dmz/packages/vasp/src/recovery/VaspRecoveryService.ts`

---

## S20 — TIMEOUT·REORG 복구 핸들러 구현

### 1. handleTimeout 구현

```typescript
// TxStateMachineService.ts:219
async handleTimeout(requestId: string): Promise<void> {
  const req = await this._getOrThrow(requestId);
  if (req.status !== 'PENDING' || !req.txHash) return;  // 가드

  // TODO (S20 실습): gas bump 재전송
  //   const { txHash: newTxHash } = await this.vasp.resubmitWithGasBump(
  //     req.txHash, TxStateMachineService.GAS_BUMP_PERCENT,
  //   );
  //   await this.repo.updateStatus(requestId, 'PENDING', {
  //     txHash: newTxHash,
  //     retryCount: req.retryCount + 1,
  //   });
}
```

**주의사항:**
- 상태는 `PENDING → PENDING` — 아직 채굴 안 됐으므로 상태 변경 없음
- txHash는 새 값으로 교체 (gas bump로 새 TX 생성)
- `retryCount` 증가 — 무한 gas bump 방지 (예: retryCount > 3 → FAILED)

```typescript
// 답안
async handleTimeout(requestId: string): Promise<void> {
  const req = await this._getOrThrow(requestId);
  if (req.status !== 'PENDING' || !req.txHash) return;

  const { txHash: newTxHash } = await this.vasp.resubmitWithGasBump(
    req.txHash,
    TxStateMachineService.GAS_BUMP_PERCENT,
  );

  await this.repo.updateStatus(requestId, 'PENDING', {
    txHash:     newTxHash,
    retryCount: req.retryCount + 1,
  });
}
```

### 2. handleReorg 구현

```typescript
// TxStateMachineService.ts:255
async handleReorg(requestId: string): Promise<void> {
  const req = await this._getOrThrow(requestId);
  if (req.status !== 'CONFIRMED' || !req.txHash) return;  // 가드

  // 1. REORGED 전이
  await this.repo.updateStatus(requestId, 'REORGED');

  // TODO (S20 실습): 5블록 대기 + VASP 재조회
  //   await this._waitBlocks(TxStateMachineService.REORG_WAIT_BLOCKS);
  //   const result = await this.vasp.getStatus(req.txHash);
  //   if (result.status === 'confirmed') {
  //     await this.repo.updateStatus(requestId, 'CONFIRMED');
  //   } else {
  //     await this.repo.updateStatus(requestId, 'FAILED', {
  //       failReason: 'reorg: tx not found after wait',
  //     });
  //   }
}
```

```typescript
// 답안
async handleReorg(requestId: string): Promise<void> {
  const req = await this._getOrThrow(requestId);
  if (req.status !== 'CONFIRMED' || !req.txHash) return;

  await this.repo.updateStatus(requestId, 'REORGED');

  await this._waitBlocks(TxStateMachineService.REORG_WAIT_BLOCKS);

  const result = await this.vasp.getStatus(req.txHash);

  if (result.status === 'confirmed') {
    await this.repo.updateStatus(requestId, 'CONFIRMED');
  } else {
    await this.repo.updateStatus(requestId, 'FAILED', {
      failReason: 'reorg: tx not found after wait',
    });
  }
}

// _waitBlocks 구현 (테스트에서 Mock으로 교체 가능)
private async _waitBlocks(count: number): Promise<void> {
  const start  = await this.vasp.getStatus('').then(() => 0).catch(() => 0); // mock
  const target = start + count;
  while (true) {
    const current = await this.repo.findPendingOlderThan(0).then(() => target); // 단순화
    if (current >= target) break;
    await new Promise(r => setTimeout(r, 1000));
  }
}
```

### 3. VaspRecoveryService handleReorg 구현

```typescript
// VaspRecoveryService.ts:77 (TODO 구현 대상)
async handleReorg(
  requestId: string,
  originalTxHash: string,
  detectedAtBlock: number,
): Promise<RecoveryResult> {
  // TODO:
  // 1. ledger.getMintRequest(requestId)
  // 2. status 'SUBMITTED' 또는 'CONFIRMED' 아니면 throw
  // 3. REORGED 전이 + auditLog 기록
  // 4. retryWithBackoff → vaspClient.resubmit(requestId)
  // 5. 성공: SUBMITTED 전이 + newTxHash
  //    3회 실패: FAILED + 운영팀 알림
}
```

```typescript
// 답안
async handleReorg(
  requestId: string,
  originalTxHash: string,
  detectedAtBlock: number,
): Promise<RecoveryResult> {
  const req = await this.ledger.getMintRequest(requestId);
  if (!req) throw new Error(`MintRequest not found: ${requestId}`);
  if (req.status !== 'SUBMITTED' && req.status !== 'CONFIRMED') {
    throw new Error(`Invalid state for reorg: ${req.status}`);
  }

  await this.ledger.updateMintRequest(requestId, {
    status:   'REORGED' as MintStatus,
    errorMsg: `Reorg at block ${detectedAtBlock}`,
  });

  try {
    const { txHash: newTxHash } = await this.retryWithBackoff(
      () => this.vaspClient.resubmit(requestId),
      this.retryPolicy,
    );

    await this.ledger.updateMintRequest(requestId, {
      status: 'SUBMITTED' as MintStatus,
      txHash: newTxHash,
    });

    return {
      requestId,
      action:    'RESUBMITTED',
      newTxHash,
      message:   `Resubmitted after reorg at block ${detectedAtBlock}`,
    };
  } catch {
    await this.ledger.updateMintRequest(requestId, { status: 'FAILED' as MintStatus });
    await this.notifier.send({ type: 'REORG_RECOVERY_FAILED', requestId });
    return { requestId, action: 'FAILED', message: 'Reorg recovery exhausted retries' };
  }
}
```

### 4. 실습 — TIMEOUT + REORG 시뮬레이션 테스트

```typescript
// TIMEOUT 시뮬레이션
it('handleTimeout → gas bump → 새 txHash로 PENDING', async () => {
  const service = new TxStateMachineService(repo, vaspMock, walletResolver);

  // PENDING 상태 세팅
  await repo.save({
    id: 'req-timeout-1', userId: 'user-1',
    tokenId: 1001n, amount: 1n,
    status: 'PENDING', txHash: '0xOLD', retryCount: 0,
    createdAt: new Date(), updatedAt: new Date(),
  });

  await service.handleTimeout('req-timeout-1');

  const req = await repo.findById('req-timeout-1');
  expect(req?.status).toBe('PENDING');
  expect(req?.txHash).not.toBe('0xOLD');  // 새 txHash
  expect(req?.retryCount).toBe(1);
});

// REORG 시뮬레이션
it('handleReorg → REORGED → 재조회 → CONFIRMED 복귀', async () => {
  // CONFIRMED 상태 세팅
  await repo.save({
    id: 'req-reorg-1', userId: 'user-1',
    tokenId: 1002n, amount: 1n,
    status: 'CONFIRMED', txHash: '0xCONFIRMED', retryCount: 0,
    createdAt: new Date(), updatedAt: new Date(),
  });

  // Mock: 5블록 대기 후 confirmed 응답
  vaspMock.setNextStatus('0xCONFIRMED', 'confirmed', 12350);

  await service.handleReorg('req-reorg-1');

  const req = await repo.findById('req-reorg-1');
  expect(req?.status).toBe('CONFIRMED');  // 복귀 확인
});
```

**완료 기준:**
- [ ] `handleTimeout` — gas bump 재전송 + 새 txHash 저장
- [ ] `handleReorg` — REORGED 전이 → 5블록 대기 → CONFIRMED 복귀
- [ ] REORG 시뮬레이션 테스트 통과
