# M4 S24 — 원장 일관성 보장 · 상태 전이 가드와 멱등 이벤트 처리

> 모듈 4 · 세션 24 · 1시간  
> 스켈레톤: `dmz/packages/core-banking/src/ledger/LedgerService.ts`

---

## 강의 파트 (20분)

### 1. 분산 시스템에서 메시지 순서는 보장되지 않는다

S23에서 오프체인 원장의 필요성을 배웠다. 원장이 있으면 충분할까?

다음 시나리오를 생각해보자.

```
정상 순서:
  NFT 발행 요청 → PENDING → SUBMITTED → MINED → FINALIZED → CONFIRMED

실제 발생 가능한 순서:
  CONFIRMED 이벤트가 먼저 도착 → 그 다음 SUBMITTED 이벤트 도착
```

Redis Streams에서 Consumer Group Worker가 메시지를 병렬로 처리하다 보면, 순서가 뒤바뀌어 도착하는 일이 생긴다. 가드가 없으면:

```
현재 상태: CONFIRMED
→ "SUBMITTED로 전이하라"는 이벤트 도착
→ 원장이 SUBMITTED로 되돌아감
→ 사용자는 발행이 완료됐는데 원장에는 "처리 중"으로 표시됨
```

이것이 **역전이(backward transition)** 문제다.

금융 시스템에서 한 번 CONFIRMED된 거래가 다시 SUBMITTED로 돌아가는 것은 심각한 데이터 불일치다. 감사 감사(audit) 추적도 망가진다.

---

### 2. VALID_TRANSITIONS 맵 — 허용된 전이만 통과시킨다

해결 방법은 단순하다. **"어떤 상태에서 어떤 상태로의 전이가 허용되는가"를 코드에 명시한다.**

```typescript
// LedgerService.ts 스켈레톤에 이미 정의됨
private static readonly VALID_TRANSITIONS: Record<MintStatus, MintStatus[]> = {
  PENDING:   ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['MINED',     'FAILED'],
  MINED:     ['FINALIZED', 'REORGED', 'FAILED'],
  FINALIZED: ['CONFIRMED'],             // PoS 2/3+ 동의 → 원장 업데이트 트리거
  CONFIRMED: [],                        // 종단 상태 — 원장 업데이트 완료
  FAILED:    [],                        // 종단 상태 — 이후 전이 없음
  REORGED:   ['MINED', 'FAILED'],       // Reorg 후 MINED 복귀(재채굴) 또는 포기
};
```

상태 다이어그램으로 보면:

```
   [PENDING] ──────────────────────────────────────────▶ [FAILED]
       │                                                      ▲
       ▼                                                      │
  [SUBMITTED] ─────────────────────────────────────────────── │
       │                                                      │
       ▼                                                      │
    [MINED] ──────────────── [REORGED] ──────────────────────▶┘
       │              ▲          │
       ▼              └──────────┘
  [FINALIZED]
       │
       ▼
  [CONFIRMED]  ← 종단 (원장 업데이트 완료)
```

각 상태의 의미:
- `PENDING`: 발행 요청이 생성됐지만 VASP에 아직 전달 전
- `SUBMITTED`: VASP에 TX를 제출했고 블록에 포함되길 기다리는 중
- `MINED`: 블록에 포함됨, REORG 가능 구간 (PoS finality 확보 전)
- `FINALIZED`: PoS 2/3+ validator 동의 → 절대 불변 (약 12분). 원장 업데이트 트리거
- `CONFIRMED`: 원장 업데이트 완료 — 종단 상태
- `FAILED`: TX가 실패로 종결됨. 재발행하려면 새 요청 필요 — 종단 상태
- `REORGED`: MINED 구간에서 체인 재편성으로 TX가 소실 → MINED 재전이 대기

`FAILED`와 `CONFIRMED` 모두 종단 상태다. 한 번 CONFIRMED되면 원장에서 확정된 것으로 불변이며, FAILED된 requestId로는 재발행하지 않는다.

---

### 3. 가드 구현 — 허용 안 된 전이는 예외로 차단

```typescript
// LedgerService.updateMintRequest() 내부
const allowed = LedgerService.VALID_TRANSITIONS[current.status];
if (!allowed.includes(patch.status)) {
  throw new InvalidStateTransitionError(current.status, patch.status);
}
```

이 두 줄이 전부다. 맵에 없는 전이는 즉시 예외를 던지고, DB 업데이트는 실행되지 않는다.

예시:
- `CONFIRMED → SUBMITTED`: `CONFIRMED`의 허용 목록은 `[]`(종단) → 예외
- `FAILED → CONFIRMED`: `FAILED`의 허용 목록은 `[]` → 예외
- `MINED → CONFIRMED`: `MINED`의 허용 목록에 `CONFIRMED` 없음 → 예외 (반드시 FINALIZED 거쳐야)
- `MINED → FINALIZED`: `MINED`의 허용 목록에 `FINALIZED` 있음 → 통과

---

### 4. M3 TxStateMachineService와의 관계

M3에서도 상태머신을 배웠다. 이것과 뭐가 다를까?

| 구분 | TxStateMachineService (M3) | LedgerService (M4) |
|---|---|---|
| 추적 대상 | VASP/블록체인의 TX 상태 | 내부 발행 요청 상태 |
| 위치 | DMZ → VASP 방향 | 오프체인 원장 DB |
| 트리거 | VASP 콜백, 블록 이벤트 | ConsumerGroupWorker 이벤트 핸들러 |
| 역할 | 외부 상태 동기화 | 내부 원장 일관성 |

두 상태머신이 직렬로 작동한다:

```
VASP TX 상태 (TxStateMachineService) → FINALIZED
    → 블록체인 NFTIssued 이벤트 발행
    → ConsumerGroupWorker 수신
    → LedgerService.updateMintRequest(FINALIZED)  → 원장 업데이트 후 CONFIRMED
```

M3 상태머신이 먼저 외부 상태를 동기화하고, 그 결과가 M4 원장 상태 전이를 트리거한다.

---

### 5. 멱등 이벤트 처리 — 왜 "ON CONFLICT DO NOTHING"인가

M2에서 Redis Streams는 at-least-once delivery라고 배웠다. 같은 이벤트가 두 번 도착할 수 있다.

```
시나리오:
  Consumer가 NFTIssued 이벤트를 처리하고 DB에 저장했다.
  XACK를 보내기 직전에 Worker가 죽었다.
  Redis는 XACK를 못 받았으니 메시지를 다시 보낸다.
  Worker가 재시작되어 같은 이벤트를 다시 처리한다.
```

가드 없이 처리하면:
```
user_nft_holdings에 같은 userId, 같은 tokenId가 두 번 INSERT됨
→ 사용자가 NFT 2개를 보유하는 것으로 원장에 기록됨
```

해결책: `processed_events` 테이블의 복합 UNIQUE 제약

```sql
UNIQUE (tx_hash, log_index)
```

왜 `tx_hash`만으로 안 될까? 하나의 트랜잭션 안에 여러 이벤트가 있을 수 있다. 예를 들어 mintBatch로 500명에게 동시 발행하면 NFTIssued 이벤트가 500개 발생하고 모두 같은 `tx_hash`를 가진다. `log_index`가 각 이벤트를 구분한다.

---

### 6. ON CONFLICT DO NOTHING 패턴

```typescript
async recordProcessedEvent(
  txHash: string,
  logIndex: number,
  ...
): Promise<ProcessedEventResult> {
  const result = await this.db.query(
    `INSERT INTO processed_events (tx_hash, log_index, ...)
     VALUES ($1, $2, ...)
     ON CONFLICT (tx_hash, log_index) DO NOTHING  -- 이미 있으면 조용히 무시
     RETURNING id`,
    [txHash, logIndex, ...],
  );

  if (result.rows.length === 0) {
    return { skipped: true };   // 이미 처리된 이벤트
  }
  return { skipped: false, id: result.rows[0].id as number };
}
```

반환값이 핵심이다:
- `{ skipped: true }`: 이미 처리된 이벤트 → Consumer는 XACK만 하고 종료
- `{ skipped: false }`: 처음 보는 이벤트 → 비즈니스 로직 실행

ConsumerGroupWorker에서의 호출 패턴:

```typescript
// ConsumerGroupWorker 내부
const evResult = await ledger.recordProcessedEvent(
  event.txHash, event.logIndex, 'NFTIssued', event.blockNumber, event.payload
);

if (evResult.skipped) {
  // 이미 처리됨 → XACK만
  return;
}

// 처음 처리 → 비즈니스 로직 실행
await ledger.updateMintRequest(requestId, { status: 'CONFIRMED', txHash, tokenId });
```

**`recordProcessedEvent` 체크는 모든 이벤트 핸들러의 첫 번째 줄이어야 한다.** 이 순서가 바뀌면 멱등성이 깨진다.

---

## 실습 파트 (35분)

### `updateMintRequest` TODO 채우기

```typescript
async updateMintRequest(
  requestId: string,
  patch: { status: MintStatus; txHash?: string; tokenId?: bigint; errorMsg?: string },
): Promise<MintRequest> {
  const current = await this.getMintRequest(requestId);
  if (!current) throw new MintRequestNotFoundError(requestId);

  // 상태 전이 guard (이미 구현됨)
  const allowed = LedgerService.VALID_TRANSITIONS[current.status];
  if (!allowed.includes(patch.status)) {
    throw new InvalidStateTransitionError(current.status, patch.status);
  }

  // TODO 1: DB UPDATE
  await this.db.query(
    `UPDATE mint_requests
     SET status=$1, tx_hash=$2, token_id=$3, error_msg=$4, updated_at=NOW()
     WHERE request_id=$5`,
    [patch.status, patch.txHash ?? null, patch.tokenId?.toString() ?? null, patch.errorMsg ?? null, requestId],
  );

  // TODO 2: Audit log
  const afterState = { ...current, ...patch };
  await this.auditLog.log({
    actor: 'system',
    action: `STATUS_${patch.status}`,
    resourceType: 'MintRequest',
    resourceId: requestId,
    beforeState: current,
    afterState,
  });

  // TODO 3: CONFIRMED 시 Java 원장 알림
  // if (patch.status === 'CONFIRMED') {
  //   await this.coreBankingAdapter.recordNftHolding(current.userId, patch.tokenId!, patch.txHash!);
  // }

  return afterState as MintRequest;
}
```

### `recordProcessedEvent` TODO 채우기

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

### 테스트 케이스 작성

```typescript
// 1. 멱등성 테스트 — 동일 이벤트 2회 → 1회만 반영
it('동일 txHash+logIndex 2회 호출 → 1회만 반영', async () => {
  const result1 = await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', 100n, {});
  const result2 = await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', 100n, {});

  expect(result1.skipped).toBe(false);  // 첫 번째: 신규 이벤트
  expect(result2.skipped).toBe(true);   // 두 번째: 중복 → 스킵
});

// 2. 역전이 차단 테스트
it('CONFIRMED → SUBMITTED 전이 시도 → InvalidStateTransitionError', async () => {
  // mint_requests에 CONFIRMED 상태 레코드 삽입
  // ...
  await expect(
    ledger.updateMintRequest(requestId, { status: 'SUBMITTED' }),
  ).rejects.toThrow(InvalidStateTransitionError);
});

// 3. 종단 상태 테스트
it('FAILED → CONFIRMED 전이 시도 → InvalidStateTransitionError', async () => {
  await expect(
    ledger.updateMintRequest(failedRequestId, { status: 'CONFIRMED' }),
  ).rejects.toThrow(InvalidStateTransitionError);
});

// 4. 정상 전이 테스트
it('PENDING → SUBMITTED 전이 → 성공', async () => {
  const updated = await ledger.updateMintRequest(pendingRequestId, {
    status: 'SUBMITTED',
    txHash: '0xdef456',
  });
  expect(updated.status).toBe('SUBMITTED');
  expect(updated.txHash).toBe('0xdef456');
});
```

---

## 완료 기준

- [ ] 동일 txHash+logIndex 2회 → 1회만 반영
- [ ] 허용 안 된 전이 → InvalidStateTransitionError
- [ ] PENDING → SUBMITTED 정상 전이 확인
- [ ] updateMintRequest 후 audit log 기록 확인
