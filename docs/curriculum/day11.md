# Day 11 — VASP 변동 처리 + 원장 동기화

**시간**: 3시간 (180분)  
**핵심 질문**: TX가 실패하거나 체인 Reorg가 발생했을 때 내부 원장을 어떻게 일관성 있게 복구하는가?

---

## 세션 구조

| 시간 | 내용 |
|---|---|
| 00:00~00:35 | 1부: TX 생명주기와 실패 분류 |
| 00:35~01:20 | 실습 1: handleVaspFailure — TX 실패 처리 |
| 01:20~02:05 | 실습 2: handleReorg — 체인 재편성 복구 |
| 02:05~02:50 | 실습 3: 이중 채널 동기화 — Webhook + Polling |
| 02:50~03:00 | 마무리: 장애 상황에서도 일관성을 지키는 설계 |

---

## 1부: TX 생명주기와 실패 분류 (00:00~00:35)

### 1-1. 정상 TX 흐름 복습 (10분)

**토킹포인트:**

> "Day 10에서 PENDING → SUBMITTED → CONFIRMED 상태머신을 만들었습니다. 오늘은 그 상태머신에 FAILED와 Reorg 복구 경로를 추가합니다."

**원장 상태머신 전체:**

```
PENDING
  │
  ▼ tx 제출 성공
SUBMITTED ─────── tx 실패 ──► FAILED (종단)
  │
  ▼ 충분한 블록 확정 (≥ 12 blocks)
CONFIRMED (종단)
  │
  ※ Reorg 발생 시
  ▼
REORGED ──► 재제출 ──► SUBMITTED (재시작)
```

### 1-2. TX 실패 분류 (25분)

**실패 유형별 대응 전략:**

| 유형 | 원인 | VASP 대응 | 원장 대응 |
|---|---|---|---|
| `REVERT` | 컨트랙트 조건 불충족 | TX 해시 반환 | FAILED + error_msg 기록 |
| `OUT_OF_GAS` | 가스 한도 부족 | TX 해시 반환 | FAILED + 가스 조정 후 재시도 가능 |
| `NONCE_TOO_LOW` | 논스 충돌 | 에러 반환 | FAILED + nonce 재동기화 필요 |
| `TIMEOUT` | 체인 혼잡, mempool 탈락 | 에러 반환 | SUBMITTED 유지 + 폴링 |
| `REORG` | 체인 재편성 | TX 사라짐 | REORGED + 재제출 |

> "REVERT와 TIMEOUT을 같은 FAILED로 처리하면 안 됩니다. REVERT는 진짜 실패, TIMEOUT은 아직 진행 중일 수 있습니다. 상태머신이 이 차이를 반영해야 합니다."

---

## 실습 1: handleVaspFailure (00:35~01:20)

### Step 1 — VaspRecoveryService 스켈레톤 확인 (10분)

```bash
cat dmz/packages/vasp/src/recovery/VaspRecoveryService.ts
```

**구현할 3개 시나리오:**
1. `handleTxRevert()` — 컨트랙트 REVERT 시 FAILED 전이
2. `handleTxTimeout()` — 폴링 timeout 시 SUBMITTED 유지 + 알림
3. `handleNonceConflict()` — nonce 재동기화 후 재제출

### Step 2 — REVERT 처리 구현 (20분)

```typescript
// dmz/packages/vasp/src/recovery/VaspRecoveryService.ts
async handleTxRevert(requestId: string, txHash: string, reason: string): Promise<void> {
  // TODO: 구현
  // 1. mint_requests WHERE request_id = requestId AND status = 'SUBMITTED' 조회
  // 2. status → FAILED, error_msg = reason, updated_at = NOW() 업데이트
  // 3. audit_log에 TX_FAILED 기록 (before: SUBMITTED, after: FAILED)
  // 4. 사용자 알림 이벤트 발행 (EventEmitter or MQ)
}
```

**실습 과제:**
1. `// TODO` 4단계 구현
2. 존재하지 않는 requestId 시 `MintRequestNotFoundError` throw
3. SUBMITTED 상태가 아닌 요청 처리 시 `InvalidStateTransitionError` throw

### Step 3 — 재시도 정책 구현 (15분)

```typescript
// Exponential backoff 재시도 설정
const RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  retryableErrors: ['OUT_OF_GAS', 'NONCE_TOO_LOW', 'NETWORK_ERROR'],
  nonRetryableErrors: ['REVERT', 'INSUFFICIENT_BALANCE'],
};
```

**실습 과제:**
- `retryWithBackoff(fn, policy)` 유틸리티 함수 구현 (`// TODO` 위치)
- OUT_OF_GAS 시 gasLimit * 1.2로 조정 후 재시도 로직 추가

---

## 실습 2: handleReorg (01:20~02:05)

### Step 1 — Reorg란 무엇인가 (15분)

**토킹포인트:**

> "블록체인에서 두 개의 마이너가 동시에 블록을 생성하면 일시적으로 두 개의 체인이 존재합니다. 네트워크가 긴 체인을 선택하면 짧은 체인의 TX는 사라집니다. 이게 Reorg입니다. 교보생명 NFT 발행 TX가 Reorg에 걸리면 어떻게 됩니까?"

**Reorg 감지 방법:**

```typescript
// 방법 1: 폴링 중 TX가 사라진 경우
const receipt = await provider.getTransactionReceipt(txHash);
if (receipt === null && blockNumber < currentBlock - FINALITY_DEPTH) {
  // TX가 충분히 오래되었는데 receipt 없음 → Reorg 의심
}

// 방법 2: 블록 해시 변경 감지
const block = await provider.getBlock(knownBlockNumber);
if (block.hash !== knownBlockHash) {
  // 동일 높이의 블록 해시가 바뀜 → Reorg 확정
}
```

### Step 2 — Reorg 복구 흐름 구현 (30분)

```bash
cat dmz/packages/vasp/src/recovery/VaspRecoveryService.ts
# handleReorg() 메서드 찾기
```

**구현할 흐름:**

```
Reorg 감지
  │
  ▼
CONFIRMED → REORGED 상태 전이
  │
  ▼
audit_log: REORG_DETECTED 기록
  │
  ▼
새 TX로 재제출 시도 (새 nonce, 새 gasPrice)
  │
  ├─ 성공 → status = SUBMITTED (새 tx_hash로)
  └─ 실패 3회 → status = FAILED + 운영팀 알림
```

**실습 과제:**
1. `handleReorg(requestId, originalTxHash, detectedAtBlock)` 구현
2. CONFIRMED 상태에서만 REORGED 전이 허용 (guard 확인)
3. 재제출 시 원래 requestId 유지 (幂等성)

### Step 3 — Finality Depth 설정 (10분)

```typescript
// 네트워크별 Finality Depth 설정
const FINALITY_DEPTH: Record<string, number> = {
  'ethereum-mainnet': 12,   // ~2.5분
  'polygon-mainnet': 128,   // ~3.5분
  'sepolia': 5,              // testnet: 느슨하게
  'xrpl-mainnet': 1,        // XRPL: 즉시 finality (3-5초)
};
```

> "XRPL은 BFT 합의로 즉시 finality가 보장됩니다. EVM 계열 체인과 달리 Reorg 걱정이 없습니다. Phase 3에서 RWA 토큰화에 XRPL을 선택한 이유 중 하나입니다."

---

## 실습 3: 이중 채널 동기화 (02:05~02:50)

### Step 1 — 왜 이중 채널인가 (10분)

**토킹포인트:**

> "Webhook은 빠릅니다. 이벤트 발생 즉시 알려줍니다. 그러나 Webhook는 놓칠 수 있습니다. 네트워크 오류, 서버 재시작, VASP 장애. 폴링은 느리지만 절대 놓치지 않습니다. 두 채널을 함께 운영하면 빠름과 안정성을 동시에 얻습니다."

**이중 채널 구조:**

```
VASP/체인 이벤트
  │
  ├──► Webhook (Push)  ─► WebhookServer ─► IdempotencyGuard ─►┐
  │                                                            │
  └──► Polling (Pull)  ─► PollingService ─────────────────────┤
                                                              │
                                                    LedgerService.update()
```

### Step 2 — PollingService 구현 (25분)

```bash
cat dmz/packages/vasp/src/polling/PollingService.ts
```

**핵심 구현:**

```typescript
// dmz/packages/vasp/src/polling/PollingService.ts
export class PollingService {
  private intervalId?: NodeJS.Timeout;

  start(intervalMs: number = 30_000): void {
    this.intervalId = setInterval(() => this.poll(), intervalMs);
  }

  private async poll(): Promise<void> {
    // TODO:
    // 1. mint_requests WHERE status = 'SUBMITTED' AND updated_at < NOW() - interval '5 minutes' 조회
    // 2. 각 요청에 대해 체인에서 receipt 조회
    // 3. receipt 있음 + confirmations >= FINALITY_DEPTH → CONFIRMED 전이
    // 4. receipt 없음 + 오래됨 → Reorg 의심, handleReorg() 호출
    // 5. 결과 audit_log 기록
  }
}
```

### Step 3 — IdempotencyGuard와 연동 (15분)

> "Webhook과 Polling이 동시에 같은 TX를 처리하면 중복 CONFIRMED 처리가 발생합니다. Day 6에서 만든 IdempotencyGuard가 여기서 다시 활약합니다."

**실습 과제:**
1. `PollingService.poll()` 에서 각 TX 처리 전 `IdempotencyGuard.isProcessed()` 확인
2. 이미 처리된 TX는 skip + 카운터 증가 (메트릭용)
3. 전체 흐름 테스트: Webhook 차단 후 Polling이 자동으로 채우는지 확인

---

## 마무리 (02:50~03:00)

**핵심 3줄:**

> 1. **TX 실패 유형을 구분하라.** REVERT는 종단 실패, TIMEOUT은 재시도 가능, Reorg는 재제출 필요. 모두 FAILED로 퉁치는 설계는 금융 시스템에서 용납되지 않는다.
> 2. **이중 채널이 안전망이다.** Webhook은 속도, Polling은 신뢰성. 두 채널이 IdempotencyGuard를 통해 만나면 중복 없이 완전한 이벤트 수신이 보장된다.
> 3. **상태머신이 복잡성을 관리한다.** PENDING→SUBMITTED→CONFIRMED/FAILED/REORGED — 각 전이에 감사 로그가 붙으면 장애 발생 시 정확한 시점과 원인을 추적할 수 있다.

---

## 다음 시간 예고

> "원장과 VASP 변동 처리를 갖췄습니다. 마지막 질문: 이 시스템의 키를 누가 관리하는가? 교보생명과 VASP가 키를 어떻게 나눠 갖는가? Day 12에서 MPC와 Gnosis Safe 멀티시그로 키 거버넌스를 설계합니다."
