# M3 S13 — 비동기 트랜잭션 상태 관리와 전이 규칙 설계

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S13 · 1시간  
> 대상: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`

---

## M2 → M3 연결

M2(S5~S12)에서 배운 것을 M3에서 어떻게 확장하는가:

| M2에서 배운 것 | M3에서 연결되는 곳 |
|---|---|
| `ConsumerGroupWorker` — At-least-once + 멱등 처리 | S22: `pollStaleRequests` 결과를 ConsumerGroupWorker가 처리 |
| `IdempotencyGuard` — requestId 기반 중복 차단 | S16: `submitMintRequest`에서 UUID requestId 생성 + VASP 재전송 방어 |
| `DLQHandler` — 3회 실패 격리 | S17: NonRetryableError → 즉시 DLQ / RetryableError → Backoff |
| XAUTOCLAIM으로 PEL 재수신 | S21~S22: 콜백 누락 시 폴링 채널이 XAUTOCLAIM 연계로 복구 |
| Finalized 블록 체크 후 원장 업데이트 | S13: MINED → CONFIRMED 전이 = Finalized 기준 |

```
M2: "이벤트가 도착했을 때 어떻게 안전하게 처리하는가"
M3: "TX를 보냈을 때 블록체인이 어떤 경로로 실패하는가, 각각 어떻게 복구하는가"
```

---

## S13 — TX 상태머신 설계와 전이 규칙 구현

---

### 0. 블록체인 TX는 왜 HTTP와 다른가

일반적인 서버 API 호출은 **동기(synchronous)** 다.

```
클라이언트 ──POST /order──→ 서버
                              │ (처리)
클라이언트 ←──200 OK──────── │
"완료됨"
```

요청을 보내면 응답이 올 때까지 기다리고, 응답을 받으면 그게 최종 상태다.

블록체인 TX는 다르다. **완료까지 여러 단계를 거치고, 각 단계에서 실패할 수 있다.**

```
DMZ ──TX 전송──→ 블록체인 네트워크
                      │
                 mempool 대기 (수초 ~ 수분)
                      │
                 채굴자가 선택
                      │
                  블록 포함 (MINED)
                      │
               Finality 확보 (~12분)
                      │
                  최종 확정 (CONFIRMED)
```

그리고 중간 어느 단계에서든 실패할 수 있다:

```
mempool 대기 중  → Gas 부족으로 드롭 (TIMEOUT)
블록 포함 후     → 컨트랙트 조건 실패 (REVERT)
확정 이후        → 블록 재편으로 TX 소실 (REORG)
```

#### 택배 추적 비유

블록체인 TX 처리는 **온라인 주문 → 택배 배송**과 같다.

```
주문 접수      = REQUESTED   (주문은 됐는데 아직 발송 전)
배송사 접수    = SUBMITTED   (택배사에 넘겼는데 운송장 미발행)
배송 중        = PENDING     (운송장 있음, 아직 도착 전)
배달 완료      = MINED       (받긴 했는데 반품 가능 기간)
수령 확정      = CONFIRMED   (반품 기간 지남 → 최종 완료)
배달 실패      = FAILED      (주소 오류, 수취인 거부)
배달 취소 후   = REORGED     (배달됐다더니 다시 배달 중)
재배달
```

핵심: **주문 버튼을 눌렀다고 상품이 즉시 도착하지 않는다.** 단계별로 추적해야 하고, 각 단계에서의 실패를 다르게 처리해야 한다.

---

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

블록체인 TX는 HTTP 응답과 달리 **즉시 확정되지 않는다**. 응답을 받았다고 끝이 아니고, 채굴 → Finalize → REORG 가능성까지 처리해야 한다.

**크래시 발생 시 — 상태머신이 없으면:**

```
시간 →
 t=0  서버: VASP에 mint 요청 전송
 t=1  VASP: TX 전송됨, txHash 반환
 t=2  서버: 💥 크래시
 ...
 t=10 서버: 재시작
       "발행됐나? 안 됐나? txHash가 없어서 알 수 없음"
       → 재요청? NFT 2개 발행 🚨
       → 안 함?  NFT 미발행 🚨
```

**크래시 발생 시 — 상태머신이 있으면:**

```
시간 →
 t=0  서버: DB에 REQUESTED 기록 → VASP 요청 전송
 t=1  VASP: TX 전송됨 → DB에 SUBMITTED + txHash 기록
 t=2  서버: 💥 크래시
 ...
 t=10 서버: 재시작
       DB 조회: "SUBMITTED 상태, txHash=0xabc"
       → VASP에 txHash로 상태 조회 → 이미 처리됨 확인
       → CONFIRMED 전이
       → 중복 없음 ✅
```

**상태머신이 제공하는 것:**

```
어느 시점에 어떤 단계에 있는지 DB에 기록
→ 재시작 후에도 "어디까지 처리됐나" 명확히 파악
→ 각 단계별 복구 전략 적용 가능
→ 중간 상태 중복 실행 방어 (가드 패턴)
```

#### 상태머신(State Machine)이란

상태머신은 세 가지로 구성된다:

```
┌─────────────────────────────────────────────┐
│              상태머신 3요소                   │
│                                             │
│  상태 (State)    : 지금 어디에 있는가         │
│  전이 (Transition): 어디로 갈 수 있는가       │
│  가드 (Guard)    : 언제 전이가 허용되는가      │
└─────────────────────────────────────────────┘
```

신호등을 예로 들면:
- **상태**: 빨강 / 노랑 / 초록
- **전이**: 빨강 → 초록, 초록 → 노랑, 노랑 → 빨강
- **가드**: 빨강에서 바로 노랑으로 갈 수 없음

TX 상태머신도 동일하다. "REQUESTED에서 바로 CONFIRMED로 갈 수 없다"는 것이 가드다.

---

### 2. TX 상태 정의

#### 상태를 설계하는 방법 — "이 상태는 무엇을 보장하는가"

상태를 나열할 때 단순히 "단계"가 아니라 **"이 상태에 있을 때 무엇이 참인가"** 를 기준으로 정의한다.

> **Custody 커리큘럼 Session3 (Withdrawal Lifecycle)과의 대응:**  
> 이 상태머신은 Custody 트랙의 TxAttempt 상태기계(A0~A6)와 동일한 철학을 공유한다.  
> 특히 MINED(=A4 INCLUDED) / FINALIZED(=A6 FINALIZED) 구분은 두 커리큘럼 모두에서 원장 업데이트 안전 기준으로 사용된다.

```
REQUESTED  보장: "요청이 DB에 기록됐다. VASP에는 아직 전송 전."
SUBMITTED  보장: "VASP에 전송했다. txHash를 받았다."
PENDING    보장: "TX가 블록체인 네트워크에 들어갔다. 아직 블록에 없다."
MINED      보장: "블록에 포함됐다. (≒ Custody A4 INCLUDED) REORG 가능성 존재."
FINALIZED  보장: "PoS Finality 확보. TX 번복 불가. 원장 업데이트 허용." ← Custody A6 FINALIZED
CONFIRMED  보장: "원장 업데이트까지 완료. 모든 내부 처리 종료." ← 종단
FAILED     보장: "더 이상 처리 시도 없음. 원인이 기록됐다." ← 종단
REORGED    보장: "MINED 이후 블록 재편으로 TX 소실. 재처리 대기."
```

**Custody TxAttempt 상태와 대응표:**

| 이 강의 (DMZ TX) | Custody TxAttempt | 의미 |
|---|---|---|
| MINED | A4 INCLUDED | 블록에 포함됨, Finality 미확보 |
| — | A5 CONFIRMED | n confirmations (교육 단순화로 생략) |
| FINALIZED | A6 FINALIZED | PoS Finality 확보, 번복 불가 |
| CONFIRMED | (W9 LEDGER_POSTED) | 내부 원장 업데이트 완료, 최종 종단 |

> **왜 REORGED는 CONFIRMED가 아니라 MINED에서 분기하는가:**  
> FINALIZED 이후에는 PoS 합의 규칙상 REORG가 불가능하다.  
> REORG는 반드시 MINED(≒ INCLUDED) ~ FINALIZED 구간에서만 발생한다.  
> 따라서 CONFIRMED(원장 완료)에서 REORGED로 가는 경로는 논리적으로 존재하지 않는다.

이 정의가 있으면:
- "지금 PENDING이면 txHash가 있다" → txHash 없이 PENDING인 건 DB 불일치 버그
- "FINALIZED면 원장 업데이트해도 된다" → FINALIZED 미만에서 원장 건드리면 안 됨
- "CONFIRMED는 종단" → CONFIRMED 이후 추가 전이 없음, 재처리 시도 불가

```typescript
// TxStateMachineService.ts:34
export type TxStatus =
  | 'REQUESTED'   // 요청 생성, VASP 전송 전
  | 'SUBMITTED'   // VASP에 전송됨, TX hash 미획득
  | 'PENDING'     // TX 전송됨, 블록 미채굴
  | 'MINED'       // 블록에 포함됨 (INCLUDED), Finality 미확보
  | 'FINALIZED'   // PoS Finality 확보 — 원장 업데이트 트리거
  | 'CONFIRMED'   // 원장 업데이트 완료 — 종단
  | 'FAILED'      // REVERT 또는 최종 실패 — 종단
  | 'REORGED';    // MINED 후 REORG로 TX 소실, 재처리 대기
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
                           MINED               FAILED ◀── 종단
                    ┌────────┴────────┐
              REORG 감지           TIMEOUT
                ↓                    ↓
            REORGED          gas bump → PENDING 유지
                │
         재채굴 대기
                ↓
             MINED (재진입)
                │
           Finality 확보
                ↓
           FINALIZED
                │
         원장 업데이트
                ↓
           CONFIRMED ◀── 종단
```

**MINED / FINALIZED / CONFIRMED 구분 (운영 핵심):**

| 상태 | Custody 대응 | 의미 | 원장 업데이트 |
|---|---|---|---|
| MINED | A4 INCLUDED | 블록에 포함됨 — REORG 가능 | ❌ 금지 |
| FINALIZED | A6 FINALIZED | PoS 2/3+ validator 동의 (~12분) — 절대 불변 | ✅ 허용 |
| CONFIRMED | (W9 LEDGER_POSTED) | 원장 처리 완료 — 종단 | ✅ 완료됨 |

> **원장 업데이트는 FINALIZED 이후만.** MINED 즉시 원장을 올리면 REORG 시 잔액 오염이 생긴다.

---

### 3. VALID_TRANSITIONS 맵 (교육용 명시화)

#### 왜 전이를 제한하는가

전이 제한 없이 어디서든 어디로든 갈 수 있다면:

```
시나리오: REORG 처리 코드에 버그가 있어서
          CONFIRMED 상태를 REQUESTED로 되돌리려 함
          → "발행됐는데 발행 안 된 상태"로 DB 오염
          → 원장에는 보유 기록, 체인에는 NFT, DB에는 REQUESTED

→ 재처리 로직이 다시 mint 시도 → NFT 2개 발행 🚨
```

전이 규칙을 코드로 강제하면:

```
CONFIRMED → REQUESTED 시도
→ VALID_TRANSITIONS 체크: CONFIRMED에서 REQUESTED는 없음
→ InvalidStatusTransitionError
→ DB 업데이트 차단
→ 버그가 실제 데이터 오염으로 이어지지 않음
```

**전이 제한 = 잘못된 코드가 데이터를 망치는 것을 막는 안전망**

```
           ┌─────────┐
           │REQUESTED│
           └────┬────┘
                │ submitMintRequest()
                ▼
           ┌─────────┐
           │SUBMITTED│
           └────┬────┘
                │ VASP TX 전송
                ▼
           ┌─────────┐
           │ PENDING │◄──────────────────────────────┐
           └────┬────┘     gas bump (TIMEOUT 시)      │
                │                                      │
       ┌────────┴───────────┐                          │
       │ 블록 채굴           │ REVERT                   │
       ▼                    ▼                          │
  ┌─────────┐          ┌────────┐                      │
  │  MINED  │          │ FAILED │◄─────────────────────┤
  └────┬────┘          └────────┘   (종단 — 더 이상     │
       │ ↑             (종단)        전이 없음)          │
  ┌────┴─┴───┐                                         │
  │ REORG 감지│─────────────────────────────────────┐  │
  ▼           │                                     ▼  │
┌──────────┐  │                               ┌─────────┐
│ REORGED  │──┘ 재채굴 대기 → MINED 재진입     │  FAILED │
└──────────┘                                  └─────────┘
       │ (REORGED에서 FAILED 가능)
  Finality 확보
       ▼
  ┌──────────┐
  │FINALIZED │   ← PoS finality 확보 (Custody A6 FINALIZED)
  └────┬─────┘
       │ 원장 업데이트
       ▼
  ┌──────────┐
  │CONFIRMED │   ← 원장 처리 완료 (종단, Custody W9 LEDGER_POSTED 해당)
  └──────────┘
```

실제 구현은 각 핸들러의 가드 패턴으로 분산되어 있지만, 전이 규칙을 명시적으로 표현하면:

```typescript
export const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  REQUESTED:  ['SUBMITTED', 'FAILED'],
  SUBMITTED:  ['PENDING', 'FAILED'],
  PENDING:    ['MINED', 'FAILED'],
  MINED:      ['FINALIZED', 'REORGED', 'FAILED'], // REORG는 MINED~FINALIZED 구간에서만
  FINALIZED:  ['CONFIRMED'],                        // Finality 후 원장 업데이트
  CONFIRMED:  [],                                   // 종단 — 원장 처리 완료
  FAILED:     [],                                   // 종단 — 더 이상 전이 없음
  REORGED:    ['MINED', 'FAILED'],                  // 재채굴 대기 or 포기
};

export function transitionStatus(current: TxStatus, next: TxStatus): void {
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
→ DB 업데이트 차단
→ 잘못된 상태 오염 방지
```

---

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
| `id` (UUID) | Idempotency key — 같은 ID로 VASP에 두 번 보내도 1건만 발행 |
| `txHash` | PENDING 이후 획득. TIMEOUT 시 gas bump 대상 식별 |
| `blockNumber` | MINED 시 기록. REORG 감지 시 현재 블록과 비교 기준점 |
| `retryCount` | gas bump 횟수 추적 — 무한 재시도 방지 (상한선 운영 정책으로 정함) |
| `gasPriceGwei` | gas bump 이력 — 단계별 인상 금액 추적 |
| `failReason` | FAILED 전이 시 원인 저장 — 운영·감사·CS 대응 |

---

### 5. 의존 인터페이스 — TxRepository / VaspTxClient / WalletResolver

TxStateMachineService는 3개의 외부 의존을 생성자로 주입받는다. M3 전체에서 이 패턴이 반복된다.

**TxRepository — 상태 영속화**

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

- `updateStatus`의 `extra`는 txHash, blockNumber, failReason 등 상태 전이와 함께 업데이트되는 필드
- `findPendingOlderThan`은 S22 `pollStaleRequests`에서 배치 복구에 사용

**VaspTxClient — 블록체인 연동 추상화**

```typescript
// TxStateMachineService.ts:71
export interface VaspTxClient {
  submitMint(params: {
    to:        string;
    tokenId:   bigint;
    amount:    bigint;
    requestId: string;   // ← Idempotency key를 VASP에도 전달
  }): Promise<{ txHash: string }>;

  getStatus(txHash: string): Promise<{
    status:        'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found';
    blockNumber?:  number;
    revertReason?: string;
  }>;

  resubmitWithGasBump(txHash: string, gasBumpPercent: number): Promise<{ txHash: string }>;
}
```

- `submitMint`에 `requestId`를 넘기는 이유: VASP 측에서도 중복 발행을 차단할 수 있도록
- `getStatus`의 `'not_found'`: 가스가 너무 낮아 mempool에서 droped 된 TX — TIMEOUT 처리 대상
- `resubmitWithGasBump`: 새 txHash 반환 — 기존 txHash는 무효화되지 않을 수 있으므로 Idempotency로 방어

**WalletResolver — 유저 지갑 주소 조회**

```typescript
// TxStateMachineService.ts:88
export interface WalletResolver {
  getWalletAddr(userId: string): Promise<string>;
}
```

M5(S27~S29)에서 이 인터페이스의 실제 구현을 다룬다. 지금은 "userId → 지갑 주소" 조회용 추상화로 이해.

---

### 6. submitMintRequest — REQUESTED → SUBMITTED 흐름

#### "DB 먼저 쓰고, 외부 호출 나중에" — 설계 원칙

분산 시스템에서 서버는 언제든 죽을 수 있다. **외부 호출(VASP)과 내부 기록(DB) 중 어느 것을 먼저 하느냐**에 따라 크래시 복구 가능 여부가 결정된다.

```
❌ 나쁜 순서: VASP 먼저 → DB 나중

  DMZ          VASP          DB
   │── mint ──→│              │
   │           │── TX 전송   │
   │←── OK ───│              │
   💥 크래시                  │
   ...                        │
   재시작: DB에 기록 없음 → 고아 TX 발생
           재시도 → NFT 2개 🚨
           포기 →  NFT 없음 🚨


✅ 올바른 순서: DB 먼저 → VASP 나중

  DMZ          DB            VASP
   │── save ──→│              │
   │  REQUESTED│              │
   │←── OK ───│              │
   │────────────── mint ─────→│
   💥 크래시                  │
   ...                        │
   재시작: DB에 REQUESTED 기록 있음
           → VASP에 상태 조회 → 이미 처리됐으면 SUBMITTED로 복귀
           → 중복 없음 ✅
```

이 순서가 At-least-once 환경에서 **"처리됐는지 확실히 알 수 없을 때"를 안전하게 만든다.**

```typescript
// TxStateMachineService.ts:128
async submitMintRequest(params: {
  userId:  string;
  tokenId: bigint;
  amount:  bigint;
}): Promise<string> {
  const id  = randomUUID();          // ① Idempotency key 생성
  const now = new Date();

  const req: MintRequest = {
    id,
    userId: params.userId,
    tokenId: params.tokenId,
    amount:  params.amount,
    status:     'REQUESTED',        // ② 초기 상태
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  await this.repo.save(req);         // ③ DB INSERT — 여기서 크래시나도 복구 가능

  try {
    const walletAddr = await this.wallet.getWalletAddr(params.userId);
    const { txHash } = await this.vasp.submitMint({
      to: walletAddr,
      tokenId: params.tokenId,
      amount:  params.amount,
      requestId: id,                 // ④ VASP에도 동일 ID 전달
    });
    await this.repo.updateStatus(id, 'SUBMITTED', { txHash }); // ⑤ SUBMITTED 전이
  } catch (err) {
    await this.repo.updateStatus(id, 'FAILED', {
      failReason: `submit failed: ${String(err)}`,             // ⑥ 실패 시 즉시 FAILED
    });
    throw err;
  }

  return id;
}
```

**③번이 핵심 — "DB 먼저 쓰고, 외부 호출 나중에":**

```
시나리오: DB save 후 서버 크래시
→ DB에 REQUESTED 상태로 기록됨
→ 재시작 시 pollStaleRequests가 REQUESTED 건 감지
→ VASP에 재조회 → 이미 전송됐으면 SUBMITTED 복귀
→ 전송 전이면 재전송

DB save 없이 VASP 먼저 호출했으면:
→ VASP에는 TX 있는데 우리 DB엔 없음 → 고아 TX 발생
```

---

### 7. 핸들러 패턴 — 가드 + 단일 책임

#### At-least-once 환경에서 핸들러가 두 번 호출되면?

VASP Webhook이나 Redis Consumer는 **At-least-once** 방식이다. 같은 이벤트가 네트워크 오류나 재시작으로 두 번 이상 올 수 있다.

```
정상 케이스:
  handleMined('req-001', 100) 호출
  → PENDING → MINED 전이 완료

중복 호출 케이스:
  handleMined('req-001', 100) 두 번째 호출
  → 현재 상태: MINED (이미 전이됨)
  → MINED에서 MINED는 VALID_TRANSITIONS에 없음
  → 어떻게 처리해야 하는가?
```

**두 가지 선택지:**

```
① throw InvalidStatusTransitionError
   → 에러 로그 → 불필요한 알람 → 운영자 대응 낭비
   → At-least-once 환경에서는 "정상적인 중복"을 에러로 취급

② return (조용히 무시)
   → 이미 완료된 상태 → 할 일 없음 → 멱등(Idempotent) 처리
   → 중복 호출이 와도 데이터 변화 없음 ✅
```

분산 시스템에서 "이미 처리됨"은 에러가 아니라 **정상 케이스**다. 가드에서 `return`을 쓰는 이유가 이것이다.

```
핸들러 가드 패턴:

  호출
   │
   ▼
현재 상태 확인
   │
   ├── 허용된 이전 상태? → 계속 처리
   │
   └── 이미 처리된 상태? → return (조용히 무시)
                (throw 아님 — 중복은 에러가 아님)
```

각 핸들러는 "**허용된 이전 상태 확인 → 단일 전이 실행**" 패턴을 따른다.

```typescript
// handleMined — PENDING/SUBMITTED → MINED
async handleMined(requestId: string, blockNumber: number): Promise<void> {
  const req = await this._getOrThrow(requestId);
  if (req.status !== 'PENDING' && req.status !== 'SUBMITTED') return; // ← 가드
  await this.repo.updateStatus(requestId, 'MINED', { blockNumber });
}

// handleConfirmed — MINED → CONFIRMED (원장 업데이트 트리거)
async handleConfirmed(requestId: string): Promise<void> {
  const req = await this._getOrThrow(requestId);
  if (req.status !== 'MINED') return;                                  // ← 가드
  await this.repo.updateStatus(requestId, 'CONFIRMED');
}

// handleFailed — 어떤 상태에서든 FAILED 가능 (REVERT 수신 시)
async handleFailed(requestId: string, reason: string): Promise<void> {
  await this.repo.updateStatus(requestId, 'FAILED', { failReason: reason });
}
```

**`return` vs `throw`:**

M2 S9에서 정의한 At-least-once 가드 원칙 그대로다 — 이미 처리된 상태에서 중복 호출이 오면 에러(throw)가 아닌 조용한 무시(return)가 맞다.

```
이미 CONFIRMED된 TX에 handleMined가 다시 오면 (At-least-once 재배달)
→ throw → 에러 로그 → DLQ 이동 → 불필요한 운영 알람
→ return → 조용히 무시 → PEL 정상 XACK → 멱등 처리 ✅
```

---

### 8. 실습 — VALID_TRANSITIONS 맵 + transitionStatus 구현

S13의 핵심 개념인 전이 규칙을 직접 구현해 본다.

```typescript
// 실습 파일: dmz/packages/vasp/src/tx/TxStateMachineService.ts 상단 추가

// TODO 1: VALID_TRANSITIONS 정의 (전이도 기반)
export const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  // 각 상태에서 허용되는 다음 상태 목록 작성
};

// TODO 2: transitionStatus 구현
// 허용되지 않은 전이 시 InvalidStatusTransitionError 던질 것
export function transitionStatus(current: TxStatus, next: TxStatus): void {
  // ...
}
```

**채점 기준:**

```typescript
// ✅ 통과해야 하는 케이스
transitionStatus('PENDING',   'MINED');     // 정상
transitionStatus('MINED',     'FINALIZED'); // 정상 — MINED → FINALIZED (CONFIRMED 직행 불가)
transitionStatus('FINALIZED', 'CONFIRMED'); // 정상 — 원장 업데이트 완료
transitionStatus('MINED',     'REORGED');   // 정상 — REORG는 MINED에서 발생
transitionStatus('REORGED',   'MINED');     // 정상 — 재채굴 대기

// ❌ 예외가 발생해야 하는 케이스
transitionStatus('FAILED',    'CONFIRMED'); // InvalidStatusTransitionError — 종단에서 전이 불가
transitionStatus('CONFIRMED', 'REORGED');  // InvalidStatusTransitionError — Finality 후 REORG 불가
transitionStatus('MINED',     'CONFIRMED'); // InvalidStatusTransitionError — FINALIZED 거치지 않고 직행 불가
transitionStatus('REQUESTED', 'MINED');    // InvalidStatusTransitionError
```

**답안:**

```typescript
export const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  REQUESTED:  ['SUBMITTED', 'FAILED'],
  SUBMITTED:  ['PENDING', 'FAILED'],
  PENDING:    ['MINED', 'FAILED'],
  MINED:      ['FINALIZED', 'REORGED', 'FAILED'],
  FINALIZED:  ['CONFIRMED'],
  CONFIRMED:  [],                          // 종단 — 원장 처리 완료
  FAILED:     [],                          // 종단
  REORGED:    ['MINED', 'FAILED'],
};

export function transitionStatus(current: TxStatus, next: TxStatus): void {
  const allowed = VALID_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new InvalidStatusTransitionError(current, next);
  }
}
```

**완료 기준:**
- [ ] `VALID_TRANSITIONS` 맵 — 8개 상태 전이 정의 (FINALIZED 추가)
- [ ] `transitionStatus('MINED', 'FINALIZED')` → 예외 없음
- [ ] `transitionStatus('MINED', 'CONFIRMED')` → `InvalidStatusTransitionError` (FINALIZED 거치지 않으면 불가)
- [ ] `transitionStatus('CONFIRMED', 'REORGED')` → `InvalidStatusTransitionError` (Finality 후 REORG 불가)
- [ ] `transitionStatus('FAILED', 'CONFIRMED')` → `InvalidStatusTransitionError`

---

## S13 핵심 요약

| 개념 | 핵심 |
|---|---|
| 왜 상태머신 | TX는 즉시 확정되지 않음 — 각 단계를 DB에 기록해야 재시작 후 복구 가능 |
| DB 먼저 쓰기 | `repo.save(REQUESTED)` 후 VASP 호출 — 크래시 후 고아 TX 방지 |
| 가드 패턴 | 각 핸들러: `if (status !== 허용된_이전) return` — At-least-once 환경에서 중복 방어 |
| FINALIZED 기준 | MINED(=INCLUDED)가 아니라 FINALIZED 이후만 원장 업데이트 허용 — REORG 오염 방지 |
| REORG 구간 | REORG는 MINED → FINALIZED 사이에서만 발생 — FINALIZED 이후 REORG 불가 |
| 종단 상태 | CONFIRMED(원장 완료)·FAILED 모두 `VALID_TRANSITIONS = []` — 잘못된 재처리 차단 |
| Custody 연결 | MINED=A4 INCLUDED / FINALIZED=A6 FINALIZED / CONFIRMED=W9 LEDGER_POSTED |

**S14 예고:** `TxStateMachineService`는 내부적으로 체인을 직접 알지 못한다. Ethereum이든 Polygon이든 다른 EVM이든 `VaspTxClient` 인터페이스로만 소통한다. S14에서는 이 인터페이스의 실제 구현 — 멀티체인 어댑터 패턴을 설계한다.

---

> **📎 Phase 3 미리보기 연결:**  
> 이 세션의 `MintRequest` 단일 레이어 모델은 Phase 1에서 충분하다.  
> Phase 3 직접 Custody 전환 시 **Withdrawal + TxAttempt 두 레이어 분리**가 필요해진다.  
> gas bump 이력 추적, DROPPED/REPLACED 예외 처리, Nonce 갭 복구 등이 추가된다.  
> → [Phase3_S1_two_layer_tx_model.md](./Phase3_S1_two_layer_tx_model.md)
