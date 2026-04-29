# M3 S18 — 트랜잭션 REVERT 원인과 안전한 복구 설계

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S18 · 1시간  
> 대상: `dmz/packages/vasp/src/recovery/VaspRecoveryService.ts`

---

## S18 — TX REVERT 원인과 복구 설계

### 1. TX REVERT란 무엇인가

```
컨트랙트 코드:
  function mint(address to, uint256 id, uint256 amount) external {
      require(!paused, "Contract is paused");     // 조건 1
      require(hasRole(MINTER_ROLE, msg.sender),   // 조건 2
              "Caller is not minter");
      _mint(to, id, amount, "");
  }

TX 실행 시 조건 미충족:
  → EVM이 실행 롤백 (상태 변경 없음)
  → 가스는 소비됨 (실행 비용)
  → receipt.status = 0 (실패)
  → revertReason 포함
```

**REVERT와 FAILED 상태의 차이:**

```
REVERT  = 컨트랙트 조건 미충족 — 비즈니스 로직 오류 (재시도해도 동일)
TIMEOUT = 가스비 부족으로 mempool 대기 — gas bump 후 재시도 가능
REORG   = 블록 재편 — TX 소실, 재제출 필요
```

REVERT는 재시도해도 같은 이유로 실패한다. **즉시 FAILED 전이가 올바른 처리**.

### 2. REVERT 원인 분류

| REVERT reason | 원인 | 대응 |
|---|---|---|
| `Contract is paused` | 컨트랙트 일시 정지 | 운영팀 Unpause 후 재발행 |
| `Caller is not minter` | MINTER_ROLE 없음 | 역할 부여 후 재발행 |
| `Insufficient balance` | 잔액 부족 | 충전 후 재발행 |
| `Token already exists` | 중복 tokenId | requestId 확인, 중복 발행 차단 |
| `Gas limit exceeded` | 가스 한도 초과 | gasLimit 조정 후 재발행 |

### 3. handleTxRevert 구현

```typescript
// VaspRecoveryService.ts:48 (TODO 구현 대상)
async handleTxRevert(
  requestId: string,
  txHash: string,
  reason: string,
): Promise<RecoveryResult> {
  // TODO (실습):
  // 1. ledger.getMintRequest(requestId)
  // 2. status !== 'SUBMITTED' → InvalidStateTransitionError
  // 3. ledger.updateMintRequest(requestId, { status: 'FAILED', txHash, errorMsg: reason })
  // 4. notifier.send({ type: 'TX_FAILED', requestId, txHash, reason })
  // return { requestId, action: 'FAILED', message: `TX reverted: ${reason}` }
  throw new Error('Not implemented');
}
```

```typescript
// 답안
async handleTxRevert(
  requestId: string,
  txHash: string,
  reason: string,
): Promise<RecoveryResult> {
  const req = await this.ledger.getMintRequest(requestId);
  if (!req) throw new MintRequestNotFoundError(requestId);

  if (req.status !== 'SUBMITTED') {
    throw new InvalidStateTransitionError(req.status, 'FAILED');
  }

  await this.ledger.updateMintRequest(requestId, {
    status:   'FAILED',
    txHash,
    errorMsg: reason,
  });

  await this.notifier.send({
    type:      'TX_FAILED',
    requestId,
    txHash,
    reason,
  });

  return {
    requestId,
    action:  'FAILED',
    message: `TX reverted: ${reason}`,
  };
}
```

### 4. TxStateMachineService에서의 FAILED 전이

```typescript
// TxStateMachineService.ts:203
async handleFailed(requestId: string, reason: string): Promise<void> {
  await this.repo.updateStatus(requestId, 'FAILED', { failReason: reason });
}
```

단순하지만 중요한 점: `transitionStatus` 가드를 통과한 것만 이 지점에 도달한다.

### 5. REVERT reason 파싱

```typescript
// EVMAdapter에서 getReceipt로 REVERT 감지 예시
async function detectRevert(adapter: EVMAdapter, txHash: string): Promise<string | null> {
  const receipt = await adapter.getReceipt(txHash);
  if (!receipt) return null;                    // 아직 채굴 안 됨
  if (receipt.status === 'success') return null; // 성공

  // ethers.js v6: revert reason은 별도 call 시뮬레이션으로 추출
  try {
    const tx = await adapter['provider'].getTransaction(txHash);
    if (!tx) return 'unknown reason';
    await adapter['provider'].call(tx as Parameters<typeof adapter['provider']['call']>[0]);
    return 'unknown reason';
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('revert')) {
      return err.message;
    }
    return String(err);
  }
}
```

### 6. 실습 — handleTxRevert + REVERT 시뮬레이션

```typescript
// 실습: REVERT 시나리오별 분기 처리
it('Paused revert → FAILED + reason 저장', async () => {
  const recovery = new VaspRecoveryService(ledger, vaspClient, notifier);

  await recovery.handleTxRevert(
    'req-001',
    '0xabc',
    'execution reverted: Contract is paused',
  );

  const req = await ledger.getMintRequest('req-001');
  expect(req?.status).toBe('FAILED');
  expect(req?.errorMsg).toContain('paused');
});

it('MINTER_ROLE 없음 revert → FAILED', async () => {
  await recovery.handleTxRevert(
    'req-002',
    '0xdef',
    'execution reverted: Caller is not minter',
  );

  const req = await ledger.getMintRequest('req-002');
  expect(req?.status).toBe('FAILED');
  expect(req?.errorMsg).toContain('not minter');
});
```

**완료 기준:**
- [ ] REVERT → FAILED 전이 확인
- [ ] `failReason` DB 저장 확인
- [ ] 3가지 REVERT reason (paused / not minter / insufficient balance) 분기 처리 + 테스트 통과
