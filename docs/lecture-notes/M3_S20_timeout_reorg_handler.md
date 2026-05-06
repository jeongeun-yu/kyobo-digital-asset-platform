# M3 S20 — TIMEOUT·REORG 복구 핸들러 구현

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S20 · 1시간  
> 대상: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`, `dmz/packages/vasp/src/recovery/VaspRecoveryService.ts`

---

## S20 — TIMEOUT·REORG 복구 핸들러 구현

---

### 0. 이론 — TIMEOUT과 REORG는 왜 재시도 가능한가

#### 0-1. mempool과 Gas Price의 관계

```
블록체인 TX 제출 흐름:

  IssuerService
      │
      │  submitMintTx()
      ▼
  VASP (EVMAdapter)
      │
      │  sendTransaction()
      ▼
  mempool (미채굴 TX 대기소)
      │
      │  검증자(validator)가 gas price 기준으로 TX 선택
      ▼
  블록 포함 (채굴 완료)
      │
      ▼
  receipt.status = 'success'
  
  ──────────────────────────────────────────
  TIMEOUT 발생 지점:
  
  mempool
    │
    │  (30분 이상 대기)
    │  → gas price가 너무 낮아 검증자가 선택 안 함
    ▼
  TX가 mempool에 "stuck" 상태
    │
    │  → EIP-1559 네트워크에서는 기준 수수료(baseFee)가 올라가면
    │    낮은 gas price TX는 계속 후순위로 밀림
    ▼
  pollStaleRequests 감지 → handleTimeout() 호출
```

**왜 재시도(gas bump)가 가능한가:**

```
REVERT:  상태 전이가 시도됐지만 조건 미충족 → 조건을 고쳐야 함
TIMEOUT: 상태 전이를 시도조차 못 함 (mempool에 묶임)
         → 동일 nonce로 gas price만 올려 재제출하면 통과 가능
         
         ┌─────────────────────────────────────────┐
         │  Gas Bump 메커니즘                       │
         │                                          │
         │  기존 TX: nonce=42, gasPrice=10 gwei     │
         │  새 TX:   nonce=42, gasPrice=13 gwei (+30%)│
         │                                          │
         │  nonce가 같으면 → 검증자는 높은 gas TX   │
         │  를 선택, 낮은 gas TX는 자동 드롭         │
         └─────────────────────────────────────────┘
```

---

#### 0-2. REORG(체인 재편)란 무엇인가

```
정상 상태 (단일 체인):
  Block 12345 → Block 12346 → Block 12347 → ...

포크 발생 (두 검증자가 동시에 다른 블록 생성):
  Block 12345 → Block 12346 (A) → Block 12347 (A) ← 채택
                             ↘
                              Block 12346 (B) ← 드롭 (더 짧은 체인)
  
  B 체인에 포함됐던 TX: 채택된 체인에 없음 → mempool로 복귀
```

**REORG 깊이와 확률:**

```
재편 깊이    발생 확률      우리 처리
─────────────────────────────────────────────
1 블록       간헐적         일반적 재편 (흔함)
2~3 블록     드묾           비정상적 재편
6+ 블록      극히 드묾      51% 공격 수준
─────────────────────────────────────────────

CONFIRMED 기준 = 블록 finality (체인별 다름):
  Ethereum: 12 블록 (~2.4분)
  Polygon:  256 블록 (~8분)
  더 깊이 재편되면 already-confirmed TX도 무효화 가능
```

---

#### 0-3. REORG 후 우리 시스템의 처리 흐름

```
t=0:    handleReorg 감지
          │
          ▼
        REORGED 전이 (중간 상태 — 임시 기록)
          │
          ▼
        5블록 대기 (재편이 진정되길 기다림)
          │
          ▼
        vasp.getStatus(txHash) 재조회
          │
          ├── 'mined' → 재편 후 다시 포함됨 → MINED 복귀 ✅
          │
          └── 'not_found' → 영구 소실 → FAILED + 재발행 요청 ❌

  ┌─────────────────────────────────────────────────┐
  │  왜 5블록 대기인가?                              │
  │                                                  │
  │  1블록 대기: 재편이 진행 중일 수 있음            │
  │  5블록 대기: 재편이 대부분 안정화되는 시간       │
  │  12블록: Ethereum finality 기준 (과하게 보수적) │
  │                                                  │
  │  실무: VASP의 confirmation 기준과 맞춤           │
  └─────────────────────────────────────────────────┘
```

---

#### 0-4. Gas Bump 후 이중 채굴 위험과 방어

```
위험 시나리오:
  t=0:  TX1 제출 (nonce=42, gasPrice=10)
  t=30: TIMEOUT 감지 → TX2 제출 (nonce=42, gasPrice=13)
  t=35: TX2 채굴 → CONFIRMED 처리
  t=40: TX1도 채굴? → No! 같은 nonce는 동시 채굴 불가

  같은 nonce → 검증자는 하나만 선택 → 나머지 자동 드롭
  → EVM nonce 메커니즘이 자연스럽게 이중 채굴 방지
  
방어 레이어 2: requestId 멱등성
  가정: 네트워크 지연으로 TX1이 다시 나타나 채굴됐을 때
  → NFTIssuedProcessor가 IdempotencyGuard 체크
  → requestId 이미 처리됨 → 중복 발행 차단
  → REVERT(토큰 이미 존재)되거나 Guard에서 skip
```

---

> **M3 S17에서 배운 retryWithBackoff 패턴을 gas bump 재전송에 적용한다.**  
> S17은 네트워크 실패 시 동일 요청을 지수 백오프로 재시도했다. S20은 같은 재시도 개념이지만 블록체인 mempool 특성을 반영한 변형이다 — 동일 nonce로 gas price만 올려 재제출하면 검증자가 기존 TX 대신 새 TX를 선택한다.
>
> | | M3 S17 (retryWithBackoff) | M3 S20 (gas bump) |
> |---|---|---|
> | 재시도 대상 | Core Banking Webhook 전송 | 블록체인 TX 전송 |
> | 재시도 방식 | 동일 요청 반복 | 동일 nonce + gas price 인상 |
> | 중복 방지 | requestId 멱등성 | nonce 메커니즘 (같은 nonce = 하나만 채굴) |

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
  if (req.status !== 'MINED' || !req.txHash) return;  // MINED(INCLUDED) 구간에서만 REORG 가능 — finalized 이전

  // 1. REORGED 전이
  await this.repo.updateStatus(requestId, 'REORGED');

  // TODO (S20 실습): 5블록 대기 + VASP 재조회
  //   await this._waitBlocks(TxStateMachineService.REORG_WAIT_BLOCKS);
  //   const result = await this.vasp.getStatus(req.txHash);
  //   if (result.status === 'mined') {
  //     await this.repo.updateStatus(requestId, 'MINED');   // INCLUDED로 복귀 — 재확인 대기 필요
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
  if (req.status !== 'MINED' || !req.txHash) return;  // MINED(INCLUDED) 구간에서만 REORG 가능

  await this.repo.updateStatus(requestId, 'REORGED');

  await this._waitBlocks(TxStateMachineService.REORG_WAIT_BLOCKS);

  const result = await this.vasp.getStatus(req.txHash);

  if (result.status === 'mined') {
    await this.repo.updateStatus(requestId, 'MINED');   // INCLUDED 복귀 — confirmation 카운트 재시작
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
it('handleReorg → REORGED → 재조회 → MINED 복귀 (confirmation 재시작)', async () => {
  // MINED 상태 세팅 (REORG는 CONFIRMED 이전 MINED(INCLUDED) 구간에서만 발생)
  await repo.save({
    id: 'req-reorg-1', userId: 'user-1',
    tokenId: 1002n, amount: 1n,
    status: 'MINED', txHash: '0xMINED', retryCount: 0,
    createdAt: new Date(), updatedAt: new Date(),
  });

  // Mock: 5블록 대기 후 mined 응답 (재편 후 다시 포함됨 → MINED 복귀, confirmation 카운트 재시작)
  vaspMock.setNextStatus('0xMINED', 'mined', 12350);

  await service.handleReorg('req-reorg-1');

  const req = await repo.findById('req-reorg-1');
  expect(req?.status).toBe('MINED');  // INCLUDED 복귀 — 이후 poller가 confirmation 재카운트
});
```

**완료 기준:**
- [ ] `handleTimeout` TODO 완성 — gas bump 재전송 + 새 txHash + retryCount 증가
- [ ] `handleTimeout`에서 상태가 PENDING → PENDING으로 유지되는 이유 설명 (아직 미채굴)
- [ ] `handleReorg` TODO 완성 — REORGED 전이 → 5블록 대기 → VASP 재조회 → MINED(INCLUDED 복귀, confirmation 재시작) or FAILED (MINED 구간에서만 REORG 가능, CONFIRMED 이후 불가)
- [ ] gas bump 후 기존 TX가 나중에 채굴될 경우 중복 방어 원리 설명 (requestId Idempotency)
- [ ] `VaspRecoveryService.handleReorg`와 `TxStateMachineService.handleReorg` 역할 구분 설명
- [ ] REORG 시뮬레이션 + TIMEOUT 시뮬레이션 테스트 각각 통과
