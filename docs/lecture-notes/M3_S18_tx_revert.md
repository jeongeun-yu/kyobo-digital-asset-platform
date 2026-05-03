# M3 S18 — 트랜잭션 REVERT 원인과 안전한 복구 설계

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S18 · 1시간  
> 대상: `dmz/packages/vasp/src/recovery/VaspRecoveryService.ts`

---

## S18 — TX REVERT 원인과 복구 설계

---

### 0. 이론 — EVM은 TX 실패를 어떻게 처리하는가

#### 0-1. EVM 실행 모델: "전부 아니면 전무(All-or-Nothing)"

블록체인 트랜잭션은 데이터베이스 트랜잭션과 같은 원자성(Atomicity)을 가진다.

```
일반 함수 호출 (Off-chain):
  step1() → step2() → step3()
  step2 실패 시: step1 결과는 남아 있음 (부분 반영)

EVM 트랜잭션 (On-chain):
  step1() → step2() → step3()
  step2 실패 시: step1 결과까지 전부 롤백 (0 아니면 1)
  
  ┌─────────────────────────────────────────────────┐
  │  EVM TX 실행 흐름                                │
  │                                                  │
  │  TX 수신                                         │
  │    │                                             │
  │    ▼                                             │
  │  임시 상태(state)에서 실행 시작                  │
  │    │                                             │
  │    ├── step1: balance 차감  ✅                   │
  │    ├── step2: require() 검사                     │
  │    │     └── 조건 불충족 → REVERT 발생           │
  │    │                                             │
  │    ▼                                             │
  │  임시 상태 전부 폐기 (롤백)                      │
  │  → 체인 상태 = TX 실행 전과 동일                 │
  │  → receipt.status = 0 (실패)                     │
  └─────────────────────────────────────────────────┘
```

**핵심 불변 조건**: REVERT가 발생해도 체인의 글로벌 상태(잔고, NFT 소유권 등)는 변하지 않는다.

---

#### 0-2. 비유 — 자동판매기와 불량 동전

```
자동판매기에 동전을 넣고 버튼을 눌렀는데 동전 불량:
  → 음료가 나오지 않음 (상태 변경 없음)
  → 단, 동전 투입에 든 에너지(=가스)는 환불되지 않음
  
블록체인 REVERT:
  → 상태 변경 없음 (NFT 발행 안 됨)
  → 가스는 소비됨 (EVM이 실행 시도한 비용)
  → revertReason = "왜 불량인지" 이유
```

왜 가스는 환불되지 않는가?

```
EVM 검증자(노드)는:
  1. TX를 수신
  2. 실행 시도 (CPU, 메모리 소비)
  3. 결과가 REVERT여도 실행 비용은 발생함
  
  ▶ 가스 = 검증자에 대한 실행 비용 보상
  ▶ REVERT여도 실행은 했으므로 가스 소비
  ▶ 단, 남은 가스(gasLimit - gasUsed)는 환불됨
```

---

#### 0-3. REVERT vs TIMEOUT vs REORG — 3종 장애 비교

세 가지는 모두 "TX가 정상 완료되지 않은" 상황이지만 원인과 복구 방법이 완전히 다르다.

```
┌──────────────┬──────────────────────────┬───────────────────────────┬───────────────────────────┐
│              │       REVERT             │        TIMEOUT            │         REORG             │
├──────────────┼──────────────────────────┼───────────────────────────┼───────────────────────────┤
│ 발생 시점    │ 블록에 포함된 후         │ mempool에서 대기 중        │ 블록에 포함된 후          │
│              │ (채굴 완료)              │ (채굴 전)                  │ (채굴 완료 후 재편)        │
├──────────────┼──────────────────────────┼───────────────────────────┼───────────────────────────┤
│ 원인         │ 컨트랙트 조건 미충족     │ gas price 낮음             │ 체인 포크 / 재편           │
│              │ (require 실패)           │ → 네트워크 혼잡 시 밀림    │ → 블록 무효화             │
├──────────────┼──────────────────────────┼───────────────────────────┼───────────────────────────┤
│ receipt      │ status = 0 (실패)        │ receipt 없음               │ receipt 있었다가 사라짐    │
│              │ revertReason 포함        │ txHash는 존재              │ (재편 후 해당 블록 무효)   │
├──────────────┼──────────────────────────┼───────────────────────────┼───────────────────────────┤
│ 상태 변경    │ 없음 (롤백)              │ 없음 (미실행)              │ 없음 (무효화)              │
├──────────────┼──────────────────────────┼───────────────────────────┼───────────────────────────┤
│ 재시도       │ ❌ 불가                  │ ✅ gas bump 후 가능         │ ✅ 재제출 가능             │
│              │ (같은 이유로 반복 실패)  │ (동일 nonce, 높은 gas)     │ (새 TX로 재발행)           │
├──────────────┼──────────────────────────┼───────────────────────────┼───────────────────────────┤
│ 우리 처리    │ → FAILED 즉시 전이       │ → gas bump → PENDING 유지  │ → FAILED 전이 + 재발행     │
│              │ + 운영팀 알림            │ (S20에서 구현)             │ (S20에서 구현)             │
└──────────────┴──────────────────────────┴───────────────────────────┴───────────────────────────┘
```

**수업 핵심 질문**: "REVERT는 왜 재시도하면 안 되는가?"

```
TIMEOUT: 조건은 맞음 → gas만 올리면 통과 (외부 요인)
REVERT:  조건이 틀림 → 코드/권한/상태를 고쳐야 통과 (내부 요인)

재시도하면: 같은 조건 → 같은 REVERT → 가스 낭비 + 무한 루프
정답:       원인 수정(권한 부여, unpause 등) → 새 TX 제출
```

---

#### 0-4. REVERT 감지 흐름

```
EVMAdapter.getReceipt(txHash)
    │
    ▼
receipt.status?
    │
    ├── 'success'   → handleConfirmed()
    │
    ├── 'reverted'  → revert reason 추출
    │                    │
    │                    ▼
    │               provider.call() 시뮬레이션
    │                    │
    │                    ├── Error.message에서 파싱
    │                    └── → handleTxRevert(requestId, txHash, reason)
    │
    └── null        → 아직 미채굴 (계속 대기)
```

---

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

단순하지만 중요한 점: `handleFailed`는 guard 없이 무조건 FAILED로 업데이트한다 — FAILED는 언제나 최종 상태이므로 중복 호출해도 안전하다 (S16 guard 패턴 복습).

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
- [ ] REVERT → FAILED 전이 확인 + `failReason` DB 저장 확인
- [ ] `handleTxRevert` TODO 완성 — ledger 업데이트 + notifier 발송
- [ ] REVERT reason 3가지 (paused / not minter / insufficient balance) 시나리오 테스트 통과
- [ ] REVERT가 NonRetryableError인 이유 설명 — "재시도해도 동일 결과"
- [ ] `handleFailed`가 guard 없는 이유 설명 — FAILED는 최종 상태, 중복 호출 안전
- [ ] `VaspRecoveryService.handleTxRevert`와 `TxStateMachineService.handleFailed` 역할 구분 설명
