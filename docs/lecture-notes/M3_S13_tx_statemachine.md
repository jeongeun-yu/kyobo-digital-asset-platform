# M3 S13 — 비동기 트랜잭션 상태 관리와 전이 규칙 설계

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S13 · 1시간  
> 대상: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`

---

## M2 → M3 연결

M2(S9~S12)에서 배운 것을 M3에서 어떻게 확장하는가:

| M2에서 배운 것 | M3에서 연결되는 곳 |
|---|---|
| `ConsumerGroupWorker` — At-least-once + 멱등 처리 | S22: `pollStaleRequests` 결과를 ConsumerGroupWorker가 처리 |
| `IdempotencyGuard` — requestId 기반 중복 차단 | S16: `submitMintRequest`에서 requestId 생성 + VASP 재전송 방어 |
| `DLQHandler` — 3회 실패 격리 | S17: NonRetryableError → 즉시 DLQ / RetryableError → Backoff |
| XAUTOCLAIM으로 PEL 재수신 | S21~S22: 콜백 누락 시 폴링 채널이 XAUTOCLAIM 연계로 복구 |
| Finalized 블록 체크 후 원장 업데이트 | S13: MINED → CONFIRMED 전이 = Finalized 기준 |

```
M2: "이벤트가 도착했을 때 어떻게 안전하게 처리하는가"
M3: "TX를 보냈을 때 블록체인이 어떤 경로로 실패하는가, 각각 어떻게 복구하는가"
```

---

## S13 — TX 상태머신 설계와 전이 규칙 구현

### 1. 왜 상태머신이 필요한가

**단순 HTTP 호출만 하면 생기는 문제:**

```
POST /vasp/mint → 성공 응답 수신
서버 크래시
...10분 후 재시작
"발행이 됐나? 안 됐나?" 알 수 없음
→ 중복 재요청? → NFT 2개 발행 🚨
→ 재요청 안 함? → NFT 미발행 🚨
```

블록체인 TX는 HTTP 응답과 달리 **즉시 확정되지 않는다**. 네트워크 지연, REVERT, REORG 각각 독립적인 처리가 필요하다.

**상태머신이 제공하는 것:**

```
어느 시점에 어떤 단계에 있는지 DB에 기록
→ 재시작 후에도 "어디까지 처리됐나" 명확히 파악
→ 각 단계별 복구 전략 적용
```

### 2. TX 상태 정의

```typescript
// TxStateMachineService.ts:35
export type TxStatus =
  | 'REQUESTED'   // 요청 생성, VASP 전송 전
  | 'SUBMITTED'   // VASP에 전송됨, TX hash 미획득
  | 'PENDING'     // TX 전송됨, 블록 미채굴
  | 'MINED'       // 블록에 포함됨, Finalized 미확인
  | 'CONFIRMED'   // Finalized — 원장 업데이트 트리거
  | 'FAILED'      // REVERT 또는 최종 실패
  | 'REORGED';    // REORG로 TX 소실, 재처리 대기
```

**상태 전이도:**

```
REQUESTED ──submitMintRequest()──→ SUBMITTED
                                        │
                              VASP TX 전송 성공
                                        ↓
                                   PENDING
                              ┌─────────┴─────────┐
                         블록 채굴              REVERT
                              ↓                    ↓
                           MINED               FAILED
                    ┌────────┴────────┐
              Finalized 확인        TIMEOUT
                    ↓                    ↓
               CONFIRMED          gas bump → PENDING
                    │
              REORG 감지
                    ↓
               REORGED ──5블록 대기 + VASP 재조회──→ CONFIRMED or FAILED
```

### 3. VALID_TRANSITIONS 맵 구현

```typescript
// TxStateMachineService.ts 기반 — VALID_TRANSITIONS 실습 구현
// (파일에 명시적 맵은 없지만 각 핸들러가 가드 로직으로 구현)

export const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  REQUESTED:  ['SUBMITTED', 'FAILED'],
  SUBMITTED:  ['PENDING', 'FAILED'],
  PENDING:    ['MINED', 'FAILED'],
  MINED:      ['CONFIRMED', 'FAILED'],
  CONFIRMED:  ['REORGED'],
  FAILED:     [],               // 종단 상태 — 더 이상 전이 없음
  REORGED:    ['CONFIRMED', 'FAILED'],
};

export function transitionStatus(
  current: TxStatus,
  next: TxStatus,
): void {
  const allowed = VALID_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new InvalidStatusTransitionError(current, next);
  }
}
```

**왜 종단 상태가 중요한가:**

```
FAILED → CONFIRMED 전이 시도
→ transitionStatus() 예외 발생
→ DB 업데이트 안 됨
→ 잘못된 상태 오염 방지
```

**각 핸들러의 가드 패턴 (TxStateMachineService.ts:181):**

```typescript
// handleMined — 상태 가드 예시
async handleMined(requestId: string, blockNumber: number): Promise<void> {
  const req = await this._getOrThrow(requestId);
  if (req.status !== 'PENDING' && req.status !== 'SUBMITTED') return; // ← 가드
  await this.repo.updateStatus(requestId, 'MINED', { blockNumber });
}
```

모든 핸들러가 `if (req.status !== '허용된_이전상태') return;` 패턴으로 방어한다.

### 4. MintRequest 데이터 모델

```typescript
// TxStateMachineService.ts:43
export interface MintRequest {
  id:           string;   // UUID — Idempotency key
  userId:       string;
  tokenId:      bigint;
  amount:       bigint;
  status:       TxStatus;
  txHash?:      string;
  blockNumber?: number;
  retryCount:   number;
  gasPriceGwei?: number;
  failReason?:  string;
  createdAt:    Date;
  updatedAt:    Date;
}
```

**각 필드가 왜 존재하는가:**

| 필드 | 역할 |
|---|---|
| `id` (UUID) | Idempotency key — VASP에 같은 ID 두 번 보내도 1건만 발행 |
| `txHash` | PENDING 이후 획득, TIMEOUT 시 gas bump 대상 식별 |
| `blockNumber` | MINED 시 기록, REORG 감지 시 기준점 |
| `retryCount` | gas bump 횟수 추적, 무한 재시도 방지 |
| `gasPriceGwei` | gas bump 이력 — 단계별 인상 금액 추적 |
| `failReason` | FAILED 전이 시 원인 저장 — 운영·감사 대응 |

### 5. TxRepository 인터페이스

```typescript
// TxStateMachineService.ts:60
export interface TxRepository {
  save(req: MintRequest): Promise<void>;
  findById(id: string): Promise<MintRequest | null>;
  updateStatus(
    id: string,
    status: TxStatus,
    extra?: Partial<MintRequest>,
  ): Promise<void>;
  findPendingOlderThan(minutes: number): Promise<MintRequest[]>;
}
```

`findPendingOlderThan`은 S22 `pollStaleRequests`에서 사용한다.

### 6. 실습 — VALID_TRANSITIONS 맵 + transitionStatus 구현

```typescript
// TODO: VALID_TRANSITIONS 맵과 transitionStatus 함수 구현
// 파일: dmz/packages/vasp/src/tx/TxStateMachineService.ts

// TODO 1: VALID_TRANSITIONS 정의 (위 전이도 기반)
export const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  // ... 각 상태별 허용 전이 목록
};

// TODO 2: transitionStatus 구현 — 허용 안 된 전이 시 InvalidStatusTransitionError
export function transitionStatus(current: TxStatus, next: TxStatus): void {
  // ...
}
```

```typescript
// 답안
export const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  REQUESTED:  ['SUBMITTED', 'FAILED'],
  SUBMITTED:  ['PENDING', 'FAILED'],
  PENDING:    ['MINED', 'FAILED'],
  MINED:      ['CONFIRMED', 'FAILED'],
  CONFIRMED:  ['REORGED'],
  FAILED:     [],
  REORGED:    ['CONFIRMED', 'FAILED'],
};

export function transitionStatus(current: TxStatus, next: TxStatus): void {
  const allowed = VALID_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new InvalidStatusTransitionError(current, next);
  }
}
```

**완료 기준:**
- [ ] `VALID_TRANSITIONS` 맵 구현 — 7개 상태 전이 정의
- [ ] `transitionStatus(FAILED, CONFIRMED)` → `InvalidStatusTransitionError` 예외 발생
- [ ] `transitionStatus(PENDING, MINED)` → 정상 통과 (예외 없음)
