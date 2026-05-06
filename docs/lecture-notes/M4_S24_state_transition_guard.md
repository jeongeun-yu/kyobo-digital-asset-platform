# M4 S24 — 원장 일관성 보장 · 상태 전이 가드와 멱등 이벤트 처리

> 모듈 4 · 세션 24 · 1시간  
> 스켈레톤: `dmz/packages/core-banking/src/ledger/LedgerService.ts`

---

## 강의 파트 (25분)

### 1. 분산 시스템에서 메시지 순서는 보장되지 않는다

S23에서 오프체인 원장의 필요성을 배웠다. 원장이 있으면 충분할까?

다음 시나리오를 생각해보자. Consumer Group Worker가 2개 인스턴스로 뜨고, 같은 `mint_request`에 대한 이벤트가 비슷한 시간에 들어온다고 가정한다.

```
이벤트 스트림 (Redis Streams):
  message-1: STATUS_SUBMITTED  (txHash=0xABC)
  message-2: STATUS_MINED      (blockNumber=12345)
  message-3: STATUS_FINALIZED

정상 처리 순서:
  Worker-A: message-1 처리 → REQUESTED→SUBMITTED 전이
  Worker-B: message-2 처리 → SUBMITTED→MINED 전이
  Worker-A: message-3 처리 → MINED→FINALIZED 전이

실제 발생 가능한 순서 (Worker-B가 일시 지연):
  Worker-A: message-1 처리 → REQUESTED→SUBMITTED
  Worker-A: message-3 처리 → SUBMITTED→FINALIZED  ← message-2 건너뜀
  Worker-B: message-2 처리 → "FINALIZED→MINED 전이하라" ← ??
```

또는 네트워크 재전달로 더 단순한 상황도 발생한다:

```
  message-2가 ACK 전에 Worker 재시작 → Redis가 message-2 재전달
  → 이미 FINALIZED인데 MINED로 되돌아가라는 이벤트 도착
```

가드가 없으면:

```
현재 상태: FINALIZED
→ "MINED로 전이하라"는 이벤트 도착
→ 원장이 FINALIZED → MINED로 되돌아감
→ 이미 finality 확보된 TX가 "아직 블록에만 있음"으로 원장에 표시됨
→ ReconcileService가 잘못된 불일치를 감지하고 알람 발생
→ 담당자 혼란, 감사 추적 파괴
```

이것이 **역전이(backward transition)** 문제다. 금융 시스템에서 한 번 진행된 거래가 이전 상태로 되돌아가는 것은 심각한 데이터 불일치다.

---

### 2. VALID_TRANSITIONS 맵 — 허용된 전이만 통과시킨다

해결 방법은 단순하다. **"어떤 상태에서 어떤 상태로의 전이가 허용되는가"를 코드에 명시한다.**

```typescript
// LedgerService.ts
private static readonly VALID_TRANSITIONS: Record<MintStatus, MintStatus[]> = {
  REQUESTED: ['SUBMITTED', 'FAILED'],          // 발행 요청 생성 → VASP 제출 or 즉시 실패
  SUBMITTED: ['MINED',     'FAILED'],          // TX 제출 완료 → 블록 포함 or 실패
  MINED:     ['FINALIZED', 'REORGED', 'FAILED'], // 블록 포함 → finality or 재편 or 실패
  FINALIZED: ['CONFIRMED'],                    // finality 확보 → 원장 업데이트 완료
  CONFIRMED: [],                               // 종단 상태 — 더 이상 전이 없음
  FAILED:    [],                               // 종단 상태 — 재발행하려면 새 요청 필요
  REORGED:   ['MINED', 'FAILED'],              // 재편 → MINED 복귀(confirmation 재시작) or 포기
};
```

상태 전이 다이어그램:

```
[REQUESTED] ─────────────────────────────────────────────→ [FAILED]
     │                                                          ▲
     ▼                                                          │
[SUBMITTED] ────────────────────────────────────────────────── │
     │                                                          │
     ▼                                                          │
  [MINED] ──────→ [REORGED] ──→ [MINED] (복귀, confirmation 재시작)
     │                                                          │
     │              └───────────────────────────────────────── │
     ▼
[FINALIZED]
     │
     ▼
[CONFIRMED]  ← 종단 (원장 업데이트 완료, 이후 전이 없음)
```

각 상태의 의미:

| 상태 | 의미 | 누가 설정하나 | 이 상태일 때 txHash |
|---|---|---|---|
| `REQUESTED` | IssuerService가 발행 요청 생성 | IssuerService | NULL |
| `SUBMITTED` | VASP에 TX 제출 완료, 블록 대기 중 | TxStateMachineService | 있음 |
| `MINED` | 블록에 포함됨, REORG 가능 구간 | TxStateMachineService | 있음 |
| `FINALIZED` | PoS 2/3+ validator 동의 → 절대 불변 | TxStateMachineService | 있음 |
| `CONFIRMED` | 원장 업데이트 완료 — 종단 상태 | LedgerService | 있음 |
| `FAILED` | TX 실패로 종결, 재발행하려면 새 요청 | TxStateMachineService | 있을 수도 없을 수도 |
| `REORGED` | 체인 재편으로 TX 소실 (임시) | TxStateMachineService | 있음 (무효화된 hash) |

`CONFIRMED`와 `FAILED`는 **종단 상태**다. 허용 전이 목록이 `[]`이라서 어떤 전이 시도도 예외로 차단된다.

---

### 3. 가드 구현 — 허용 안 된 전이는 예외로 차단

```typescript
// InvalidStateTransitionError 정의
export class InvalidStateTransitionError extends Error {
  constructor(from: MintStatus, to: MintStatus) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

// MintRequestNotFoundError 정의
export class MintRequestNotFoundError extends Error {
  constructor(requestId: string) {
    super(`MintRequest not found: ${requestId}`);
    this.name = 'MintRequestNotFoundError';
  }
}
```

`updateMintRequest` 내부 가드 적용:

```typescript
async updateMintRequest(
  requestId: string,
  patch: { status: MintStatus; txHash?: string; tokenId?: bigint; errorMsg?: string },
): Promise<MintRequest> {
  // 1. 레코드 존재 확인
  const current = await this.getMintRequest(requestId);
  if (!current) throw new MintRequestNotFoundError(requestId);

  // 2. 상태 전이 가드 — 맵에 없는 전이는 즉시 예외
  const allowed = LedgerService.VALID_TRANSITIONS[current.status];
  if (!allowed.includes(patch.status)) {
    throw new InvalidStateTransitionError(current.status, patch.status);
  }

  // 3. 필드 유효성 가드 — 특정 상태에 필수 필드 확인
  if (patch.status === 'SUBMITTED' && !patch.txHash) {
    throw new Error('txHash is required for SUBMITTED status');
  }
  if (patch.status === 'MINED' && patch.txHash === undefined) {
    throw new Error('txHash is required for MINED status');
  }
  if (patch.status === 'CONFIRMED' && !patch.tokenId) {
    throw new Error('tokenId is required for CONFIRMED status');
  }

  // 4. DB 업데이트
  await this.db.query(
    `UPDATE mint_requests
     SET status=$1, tx_hash=COALESCE($2, tx_hash),
         token_id=COALESCE($3, token_id),
         error_msg=$4, updated_at=NOW()
     WHERE request_id=$5`,
    [patch.status, patch.txHash ?? null, patch.tokenId?.toString() ?? null,
     patch.errorMsg ?? null, requestId],
  );

  // 5. Audit log — 상태 변경 기록
  const afterState = { ...current, ...patch };
  await this.auditLog.log({
    actor:        'system',
    action:       `STATUS_${patch.status}`,
    resourceType: 'MintRequest',
    resourceId:   requestId,
    beforeState:  current,
    afterState,
  });

  return afterState as MintRequest;
}
```

가드 동작 예시:

```
현재: CONFIRMED
요청: { status: 'SUBMITTED' }

allowed = VALID_TRANSITIONS['CONFIRMED'] = []
'SUBMITTED'이 [] 안에 없음
→ throw InvalidStateTransitionError('CONFIRMED', 'SUBMITTED')
→ DB UPDATE 실행 안 됨
```

```
현재: MINED
요청: { status: 'FINALIZED' }

allowed = VALID_TRANSITIONS['MINED'] = ['FINALIZED', 'REORGED', 'FAILED']
'FINALIZED'이 목록 안에 있음 → 통과
→ DB UPDATE 실행
```

---

### 4. 왜 필드 유효성 가드도 필요한가

상태 전이 가드만으로는 충분하지 않다.

```typescript
// 이건 상태 전이 가드를 통과한다
await ledger.updateMintRequest(requestId, {
  status: 'SUBMITTED',
  txHash: undefined,   // txHash 없이 SUBMITTED?
});

// 결과:
// mint_requests.tx_hash = NULL
// SUBMITTED 상태인데 txHash가 없음
// → TxStateMachineService가 어떤 TX를 폴링해야 하는지 모름
// → pollStaleRequests가 tx_hash IS NULL 레코드를 무시
// → SUBMITTED 상태에 영원히 머무르는 좀비 레코드
```

상태 전이 가드는 "어떤 상태에서 어떤 상태로 가는지"를 체크하고, 필드 유효성 가드는 "그 상태로 전이할 때 필요한 데이터가 있는지"를 체크한다. 두 가드가 함께 있어야 완전한 일관성 보장이다.

---

### 5. 두 상태머신의 관계 — TxStateMachineService vs LedgerService

M3에서 TxStateMachineService를 배웠다. M4의 LedgerService와 뭐가 다른가?

| 구분 | TxStateMachineService (M3) | LedgerService (M4) |
|---|---|---|
| 추적 대상 | VASP/블록체인의 TX 상태 | 내부 발행 요청의 원장 상태 |
| 위치 | DMZ (VASP 통신 레이어) | Core-Banking (원장 레이어) |
| 트리거 | VASP 콜백, 블록 이벤트, 폴링 | TxStateMachineService 호출 |
| 역할 | 외부 상태 동기화 | 내부 원장 일관성 보장 |
| 실패 시 | 재시도(gas bump, REORG 복구) | InvalidStateTransitionError 예외 |

두 상태머신이 **직렬**로 작동한다:

```
① 사용자 걷기 달성
        │
        ▼
② IssuerService
        │  ledger.updateMintRequest(REQUESTED)
        │  ledger.updateMintRequest(SUBMITTED, txHash)
        ▼
③ VASP (TxStateMachineService)
        │  TX 제출 → 블록 대기
        ▼
④ 블록에 포함됨 (콜백 또는 폴링)
        │  txStateMachine → MINED
        │  ledger.updateMintRequest(MINED)
        ▼
⑤ Finality 확보
        │  txStateMachine → FINALIZED
        │  ledger.updateMintRequest(FINALIZED)
        ▼
⑥ ConsumerGroupWorker (NFTIssued 이벤트 수신)
        │  ledger.recordProcessedEvent() → skipped?
        │  NO → ledger.updateMintRequest(CONFIRMED, tokenId)
        │        ledger.addHolding(userId, tokenId)
        ▼
⑦ 완료 — 사용자 앱에 NFT 표시
```

M3 상태머신이 먼저 외부(체인) 상태를 동기화하고, 그 결과가 M4 원장 상태 전이를 트리거한다. M3 없이 M4가 혼자 동작하지 않는다.

---

### 6. 멱등 이벤트 처리 — 중복 이벤트가 오면

M2에서 Redis Streams는 at-least-once delivery라고 배웠다. 같은 이벤트가 두 번 도착하는 시나리오:

```
t=0: Worker-A가 NFTIssued 이벤트 처리 시작
t=1: mint_requests UPDATE (CONFIRMED)
t=2: user_nft_holdings INSERT
t=3: Worker-A가 XACK 전에 프로세스 종료 ← 장애
t=4: Redis: XACK 없음 → PEL에 메시지 남음
t=5: Worker-B가 PEL 재처리 → 같은 이벤트 다시 처리
t=6: mint_requests UPDATE (CONFIRMED) ← 이미 CONFIRMED인데?
     → VALID_TRANSITIONS['CONFIRMED'] = [] → InvalidStateTransitionError
     → Worker-B가 에러 → DLQ로?
```

상태 전이 가드가 막아주지만, 이미 처리된 이벤트임을 **먼저** 판별하는 게 더 깔끔하다. 그게 `processed_events` 테이블의 역할이다.

```typescript
// ConsumerGroupWorker 내부 — 이벤트 처리 순서가 중요하다
async handleNFTIssued(event: NFTIssuedEvent): Promise<void> {

  // 1단계: 중복 이벤트 체크 — 반드시 가장 먼저
  const evResult = await ledger.recordProcessedEvent(
    event.txHash, event.logIndex, 'NFTIssued', event.blockNumber, event.payload
  );
  if (evResult.skipped) {
    // 이미 처리된 이벤트 → 조용히 XACK하고 종료
    return;
  }

  // 2단계: 신규 이벤트만 비즈니스 로직 실행
  await ledger.updateMintRequest(requestId, {
    status:  'CONFIRMED',
    tokenId: event.tokenId,
    txHash:  event.txHash,
  });
  await ledger.addHolding(userId, event.tokenId, policyId);
}
```

**`recordProcessedEvent`가 첫 번째 줄이어야 하는 이유:**

```
잘못된 순서:
  1. updateMintRequest(CONFIRMED) 실행
  2. addHolding 실행
  3. recordProcessedEvent ← 여기서 중복 체크?

문제: 1번과 2번이 완료됐는데 Worker가 죽으면,
재처리 시 recordProcessedEvent가 첫 번째이더라도
이미 CONFIRMED인 상태에서 updateMintRequest를 또 시도
→ InvalidStateTransitionError 발생

올바른 순서:
  1. recordProcessedEvent ← "이 이벤트를 처리 중" 선점
  2. updateMintRequest(CONFIRMED)
  3. addHolding

1번이 성공하면 재처리 시 skipped=true로 바로 return
```

---

## 실습 파트 (30분)

### `updateMintRequest` 완성하기

스켈레톤의 TODO를 채워 완성한 코드:

```typescript
async updateMintRequest(
  requestId: string,
  patch: { status: MintStatus; txHash?: string; tokenId?: bigint; errorMsg?: string },
): Promise<MintRequest> {
  const current = await this.getMintRequest(requestId);
  if (!current) throw new MintRequestNotFoundError(requestId);

  // 상태 전이 가드
  const allowed = LedgerService.VALID_TRANSITIONS[current.status];
  if (!allowed.includes(patch.status)) {
    throw new InvalidStateTransitionError(current.status, patch.status);
  }

  // 필드 유효성 가드
  if (patch.status === 'SUBMITTED' && !patch.txHash) {
    throw new Error('txHash is required for SUBMITTED');
  }
  if (patch.status === 'CONFIRMED' && !patch.tokenId) {
    throw new Error('tokenId is required for CONFIRMED');
  }

  // DB UPDATE — COALESCE로 기존 값 보존
  await this.db.query(
    `UPDATE mint_requests
     SET status    = $1,
         tx_hash   = COALESCE($2, tx_hash),
         token_id  = COALESCE($3, token_id),
         error_msg = $4,
         updated_at = NOW()
     WHERE request_id = $5`,
    [
      patch.status,
      patch.txHash   ?? null,
      patch.tokenId?.toString() ?? null,
      patch.errorMsg ?? null,
      requestId,
    ],
  );

  const afterState = { ...current, ...patch };

  // Audit log
  await this.auditLog.log({
    actor:        'system',
    action:       `STATUS_${patch.status}`,
    resourceType: 'MintRequest',
    resourceId:   requestId,
    beforeState:  current,
    afterState,
  });

  return afterState as MintRequest;
}
```

---

### `recordProcessedEvent` 완성하기

```typescript
async recordProcessedEvent(
  txHash: string,
  logIndex: number,
  eventName: string,
  blockNumber: bigint,
  payload: unknown,
): Promise<ProcessedEventResult> {
  const result = await this.db.query(
    `INSERT INTO processed_events
       (tx_hash, log_index, event_name, block_number, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tx_hash, log_index) DO NOTHING
     RETURNING id`,
    [txHash, logIndex, eventName, blockNumber.toString(), JSON.stringify(payload)],
  );

  if (result.rows.length === 0) {
    return { skipped: true };
  }
  return { skipped: false, id: result.rows[0].id as number };
}
```

---

### 테스트 케이스

```typescript
describe('LedgerService 상태 전이 가드', () => {

  // 1. 정상 전이
  it('REQUESTED → SUBMITTED 전이 → 성공', async () => {
    const req = await ledger.createMintRequest('user-1', 'WALK-10000');

    const updated = await ledger.updateMintRequest(req.requestId, {
      status: 'SUBMITTED',
      txHash: '0xabc123',
    });

    expect(updated.status).toBe('SUBMITTED');
    expect(updated.txHash).toBe('0xabc123');
  });

  // 2. 역전이 차단
  it('CONFIRMED → SUBMITTED 전이 시도 → InvalidStateTransitionError', async () => {
    // CONFIRMED 상태 레코드 직접 INSERT
    await db.query(
      `INSERT INTO mint_requests (request_id, user_id, policy_id, status, tx_hash, token_id)
       VALUES ($1, 'user-1', 'WALK-10000', 'CONFIRMED', '0xabc', 1001)`,
      ['req-confirmed-001'],
    );

    await expect(
      ledger.updateMintRequest('req-confirmed-001', { status: 'SUBMITTED' }),
    ).rejects.toThrow(InvalidStateTransitionError);
  });

  // 3. 종단 상태 → 모든 전이 차단
  it('FAILED → CONFIRMED 전이 시도 → InvalidStateTransitionError', async () => {
    await db.query(
      `INSERT INTO mint_requests (request_id, user_id, policy_id, status)
       VALUES ($1, 'user-1', 'WALK-10000', 'FAILED')`,
      ['req-failed-001'],
    );

    await expect(
      ledger.updateMintRequest('req-failed-001', { status: 'CONFIRMED' }),
    ).rejects.toThrow(InvalidStateTransitionError);
  });

  // 4. MINED → CONFIRMED 차단 (FINALIZED 반드시 거쳐야)
  it('MINED → CONFIRMED 전이 시도 → InvalidStateTransitionError', async () => {
    await db.query(
      `INSERT INTO mint_requests (request_id, user_id, policy_id, status, tx_hash)
       VALUES ($1, 'user-1', 'WALK-10000', 'MINED', '0xdef')`,
      ['req-mined-001'],
    );

    await expect(
      ledger.updateMintRequest('req-mined-001', { status: 'CONFIRMED', tokenId: 1001n }),
    ).rejects.toThrow(InvalidStateTransitionError);
  });

  // 5. 필드 유효성 가드
  it('SUBMITTED 전이 시 txHash 없으면 에러', async () => {
    const req = await ledger.createMintRequest('user-1', 'WALK-10000');

    await expect(
      ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED' }),  // txHash 누락
    ).rejects.toThrow('txHash is required');
  });

  // 6. 멱등성 테스트
  it('동일 txHash+logIndex 2회 처리 → 1회만 반영', async () => {
    const r1 = await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', 100n, {});
    const r2 = await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', 100n, {});

    expect(r1.skipped).toBe(false);  // 첫 번째: 신규
    expect(r2.skipped).toBe(true);   // 두 번째: 중복 → 스킵
  });

  // 7. 같은 txHash, 다른 logIndex → 둘 다 신규
  it('같은 txHash, 다른 logIndex → 별개 이벤트로 처리', async () => {
    const r1 = await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', 100n, {});
    const r2 = await ledger.recordProcessedEvent('0xabc', 1, 'NFTIssued', 100n, {});

    expect(r1.skipped).toBe(false);
    expect(r2.skipped).toBe(false);  // logIndex 다르므로 별개 이벤트
  });

  // 8. REORGED → MINED 복귀 (정상 전이)
  it('REORGED → MINED 복귀 전이 → 성공', async () => {
    await db.query(
      `INSERT INTO mint_requests (request_id, user_id, policy_id, status, tx_hash)
       VALUES ($1, 'user-1', 'WALK-10000', 'REORGED', '0xghi')`,
      ['req-reorged-001'],
    );

    const updated = await ledger.updateMintRequest('req-reorged-001', {
      status: 'MINED',
    });
    expect(updated.status).toBe('MINED');
  });
});
```

---

## 완료 기준

- [ ] `REQUESTED → SUBMITTED → MINED → FINALIZED → CONFIRMED` 정방향 전이 모두 통과
- [ ] `CONFIRMED → SUBMITTED`, `FAILED → CONFIRMED` 등 역전이 → `InvalidStateTransitionError`
- [ ] `MINED → CONFIRMED` 차단 (FINALIZED 필수 경유 확인)
- [ ] `SUBMITTED` 전이 시 `txHash` 누락 → 에러
- [ ] `CONFIRMED` 전이 시 `tokenId` 누락 → 에러
- [ ] 동일 `(txHash, logIndex)` 2회 → `skipped: true`
- [ ] 같은 `txHash`, 다른 `logIndex` → 각각 `skipped: false`
- [ ] `recordProcessedEvent`가 이벤트 핸들러의 첫 번째 줄이어야 하는 이유 설명 가능
