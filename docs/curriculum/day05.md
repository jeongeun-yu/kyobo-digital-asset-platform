# Day 05 — M3: VASP 추상화 + TX 상태머신 후반부 (S17~S20)

**세션**: S17~S20 | **모듈**: M3 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: Retry(지수 백오프) + REVERT 처리 + TIMEOUT·REORG 이론 + 복구 핸들러

---

## S17: 외부 API 장애 대응 — 재시도 전략과 회로 차단 패턴 (강의 20분 + 실습 35분)

### 강의

**Exponential Backoff:**
- 1s → 2s → 4s → 8s, max 5회
- 즉각 재시도가 VASP 장애를 악화시키는 이유: 장애 VASP에 동시 요청 집중 → 복구 지연

**Jitter 추가:**
- Thundering Herd 방지
- 여러 인스턴스가 동시에 재시도하지 않게: `delay = base * (1 + random * 0.2)`

**429 Rate Limit:**
- Token Bucket으로 요청 속도 제어
- VASP SLA 기준 max RPS 준수

### 🔴 실습 (35분) — 수강생 직접 작성

**Step 1**: Exponential Backoff 구현
```typescript
// internal/packages/vasp/src/retry/RetryStrategy.ts
// TODO: 재시도 횟수별 대기 시간 계산

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts: number; initialDelayMs: number; maxDelayMs: number },
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt === options.maxAttempts - 1) break;

      // TODO: 대기 시간 계산 (지수 증가 + jitter)
      const delay = Math.min(
        options.initialDelayMs * Math.pow(2, attempt),
        options.maxDelayMs,
      );
      // TODO: jitter 추가 (delay의 ±20%)
      await sleep(delay);
    }
  }

  throw lastError;
}
```

**Step 2**: VaspMockServer 완성 — 시나리오별 응답 설정
```typescript
// TODO: MockServer에 시나리오 설정 기능 추가
// - 정상: 200 응답
// - 429: Rate Limit
// - 500: 서버 에러
// - 타임아웃: 응답 지연

interface MockScenario {
  statusCode: number;
  delayMs?: number;
  repeatCount?: number; // 이 횟수만큼 이 응답 후 정상 복귀
}

let currentScenario: MockScenario = { statusCode: 200 };
let remainingRepeat = 0;

app.post('/vasp/mint', (req, res) => {
  // TODO: 시나리오에 따라 응답
});

app.post('/test/set-scenario', (req, res) => {
  currentScenario = req.body;
  remainingRepeat = req.body.repeatCount ?? 0;
  res.json({ ok: true });
});
```

**Step 3**: 429 응답 테스트
```typescript
// TODO: Mock에서 3회 429 후 정상 응답 설정 → 총 4회 시도 후 성공 확인

it('429 3회 → 4번째 시도에서 성공', async () => {
  // Mock 설정: 3회 429 후 정상
  await setMockScenario({ statusCode: 429, repeatCount: 3 });
  
  const requestId = await vaspService.submitMintRequest('user-1', 1001n, 1);
  
  // TODO: 4회 시도했음을 확인
  // TODO: 최종 상태가 SUBMITTED임을 확인
});
```

### ✅ 답안

```typescript
// withRetry 완성
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts: number; initialDelayMs: number; maxDelayMs: number },
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt === options.maxAttempts - 1) break;

      const baseDelay = Math.min(
        options.initialDelayMs * Math.pow(2, attempt),
        options.maxDelayMs,
      );
      const jitter = baseDelay * (0.8 + Math.random() * 0.4); // ±20%
      await new Promise((r) => setTimeout(r, jitter));
    }
  }

  throw lastError;
}

// MockServer 시나리오 응답
app.post('/vasp/mint', async (req, res) => {
  if (remainingRepeat > 0) {
    remainingRepeat--;
    if (currentScenario.delayMs) {
      await new Promise((r) => setTimeout(r, currentScenario.delayMs));
    }
    return res.status(currentScenario.statusCode).json({ error: 'mock error' });
  }
  // 정상 응답
  res.json({ requestId: req.body.requestId, txHash: `0x${Date.now().toString(16)}` });
});
```

### ✅ 완료 기준
- [ ] 5회 재시도 후 FAILED 전이
- [ ] 429 → Backoff 후 재시도

---

## S18: 트랜잭션 REVERT 원인과 안전한 복구 설계 (강의 20분 + 실습 35분)

### 강의

**TX REVERT 발생 원인:**
- 컨트랙트 조건 미충족: 잔액 부족 / Pause / Role 없음
- 가스 소비 후 상태 롤백 → 가스비는 지불됨

**REVERT 후 처리 정책:**
- `FAILED` 전이, reason 저장
- 재발행 여부는 비즈니스 결정 (자동 재시도 금지 — 같은 조건에서 또 REVERT)

**REVERT reason 파싱:**
- ethers.js: `error.reason` 또는 `error.data`에서 추출

### 🔴 실습 (35분) — 수강생 직접 작성

**Step 1**: handleTxRevert 구현
```typescript
// TODO: REVERT 수신 시 FAILED 전이 + reason 저장

async handleTxRevert(requestId: string, reason: string): Promise<void> {
  // TODO: PENDING → FAILED 전이
  // TODO: reason을 mint_requests.failure_reason에 저장
  // TODO: 알림 발송
}
```

**Step 2**: REVERT 원인별 분기 처리
```typescript
// TODO: reason 문자열에서 원인 분류
// - 'insufficient balance' → 잔액 부족
// - 'Pausable: paused' → 컨트랙트 중단
// - 'AccessControl' → 권한 없음

function classifyRevertReason(reason: string): 'BALANCE' | 'PAUSED' | 'ACCESS' | 'UNKNOWN' {
  // TODO: 각 케이스 분기
}
```

**Step 3**: Mock에서 REVERT 응답 시뮬레이션
```typescript
it('REVERT → FAILED 전이 확인', async () => {
  // Mock: REVERT 응답 설정
  await setMockScenario({ statusCode: 422, body: { revert: true, reason: 'Pausable: paused' } });
  
  await vaspService.submitMintRequest('user-1', 1001n, 1);
  
  // TODO: mint_requests 상태가 FAILED인지 확인
  // TODO: failure_reason이 저장됐는지 확인
});
```

### ✅ 답안

```typescript
// handleTxRevert 완성
async handleTxRevert(requestId: string, reason: string): Promise<void> {
  await this.db.transaction(async (trx) => {
    const current = await trx('mint_requests').where({ id: requestId }).first();
    await transitionStatus(requestId, current.status, 'FAILED', trx);
    await trx('mint_requests').where({ id: requestId }).update({
      failure_reason: reason,
      updated_at: new Date(),
    });
  });
  console.error(`[VASP] TX REVERT: ${requestId} - ${reason}`);
  // alertService.send(...)
}

// classifyRevertReason 완성
function classifyRevertReason(reason: string): 'BALANCE' | 'PAUSED' | 'ACCESS' | 'UNKNOWN' {
  if (reason.includes('insufficient balance')) return 'BALANCE';
  if (reason.includes('Pausable: paused')) return 'PAUSED';
  if (reason.includes('AccessControl')) return 'ACCESS';
  return 'UNKNOWN';
}
```

### ✅ 완료 기준
- [ ] REVERT → FAILED 전이 확인
- [ ] reason 저장 + 분기 처리 테스트 통과

---

## S19: 블록체인 TX TIMEOUT과 체인 재편성(REORG) — 복구 전략 원리 (강의 55분)

### 강의 (이론 세션 — 실습 없음)

**TX TIMEOUT 원인:**
- 가스비 부족으로 mempool 대기
- 채굴자는 가스 높은 TX 우선 선택
- stuck TX는 이후 Nonce TX 전체 블록킹

**Nonce 관리 원칙:**
- 각 주소 TX는 Nonce 순서대로 처리
- Nonce 갭 발생 시 전체 큐 정지

**Gas Bump 전략:**
- 동일 Nonce로 가스 1.2배 범프 재전송
- Replace-by-Fee로 기존 TX 자동 대체

**REORG 발생 원리:**
- PoS 네트워크에서도 단기 fork 발생
- 두 블록 동시 제안 → 체인 하나 폐기 → 폐기된 쪽 TX 소실

**MINED / FINALIZED / CONFIRMED 구분:**
- MINED: 블록에 포함됨, 아직 reorg 가능
- FINALIZED: 2/3+ validator 동의 → 절대 불변 (약 12분)
- CONFIRMED: 원장 업데이트 완료 — 종단 상태

**REORGED 전이 설계:**
- MINED TX가 reorg로 사라짐 → REORGED 전이 (FINALIZED 이전에만 발생)
- 5블록 대기 후 VASP 재조회 → MINED 복귀 or FAILED

**3종 복구 전략 요약:**
| 장애 유형 | 즉각 대응 | 최종 상태 |
|---|---|---|
| REVERT | 즉시 FAILED + reason 저장 | FAILED |
| TIMEOUT | gas bump 재전송 | PENDING 유지 → MINED |
| REORG | 5블록 대기 후 재확인 | MINED or FAILED |

### ✅ 완료 기준 (강의 이해 확인)
- [ ] TIMEOUT/REORG 발생 원인 설명 가능
- [ ] CONFIRMED vs FINALIZED 차이 설명 가능
- [ ] 3종 복구 전략 각각 서술 가능

---

## S20: TX TIMEOUT·REORG 복구 핸들러 구현 (개요 10분 + 실습 50분)

### 개요 (10분)

TIMEOUT → gas bump 흐름 재확인 / REORG → REORGED 전이 → Finalized 재조회 흐름 재확인

### 🔴 실습 (50분) — 수강생 직접 작성

**Step 1**: handleTxTimeout 구현
```typescript
// TODO: TIMEOUT 발생 시 gas bump 재전송

async handleTxTimeout(requestId: string): Promise<void> {
  // TODO: 현재 TX 정보 조회 (Nonce, gasPrice)
  // TODO: gasPrice * 1.2로 Replace-by-Fee 재전송
  // TODO: 동일 requestId 유지 (멱등성 보장)
  // TODO: SUBMITTED 전이 (이미 SUBMITTED이면 전이 없이 업데이트만)
}
```

**Step 2**: handleReorg 구현
```typescript
// TODO: REORG 발생 시 처리

async handleReorg(requestId: string): Promise<void> {
  // TODO: MINED → REORGED 전이 (FINALIZED 이전에만 REORG 가능)
  // TODO: 5블록 대기
  // TODO: VASP API에서 현재 상태 재조회
  // TODO: 재조회 결과에 따라 MINED or FAILED 전이
}
```

**Step 3**: REORG 시뮬레이션 테스트
```typescript
it('REORG 시뮬레이션 → 재처리 후 MINED 복귀', async () => {
  // 1. MINED 상태 설정 (REORG는 FINALIZED 이전에만)
  // 2. handleReorg 호출 → REORGED 전이
  // 3. Mock: 5블록 후 VASP 재조회 → mined 응답 (재채굴)
  // 4. 최종 상태 MINED 확인 → 이후 FINALIZED → CONFIRMED 흐름 계속
});
```

**Step 4**: TIMEOUT 시뮬레이션
```typescript
it('TIMEOUT → gas bump 후 성공', async () => {
  // Mock: 3블록 미채굴 → gas bump 후 성공 응답
  // handleTxTimeout 호출 → CONFIRMED 전이 확인
});
```

### ✅ 답안

```typescript
// handleTxTimeout 완성
async handleTxTimeout(requestId: string): Promise<void> {
  const request = await this.db('mint_requests').where({ id: requestId }).first();
  
  // gas bump: 기존 가스의 1.2배
  const newGasPrice = BigInt(Math.floor(Number(request.gas_price) * 1.2));
  
  // 동일 requestId로 재전송 (Replace-by-Fee)
  const txHash = await this.adapter.mintWithGasBump(
    request.wallet_address,
    BigInt(request.token_id),
    request.amount,
    { nonce: request.nonce, gasPrice: newGasPrice },
  );

  await this.db('mint_requests').where({ id: requestId }).update({
    tx_hash: txHash,
    gas_price: newGasPrice.toString(),
    updated_at: new Date(),
  });
}

// handleReorg 완성
async handleReorg(requestId: string): Promise<void> {
  await transitionStatus(requestId, 'MINED', 'REORGED', this.db);  // FINALIZED 이전에만 REORG 가능
  
  // 5블록 대기 (재편이 진정되길 기다림)
  await new Promise((r) => setTimeout(r, 60_000));
  
  const status = await this.adapter.verifyTx(requestId);
  if (status.mined) {
    await transitionStatus(requestId, 'REORGED', 'MINED', this.db);  // 재채굴 → MINED 복귀
  } else {
    await this.handleTxRevert(requestId, 'REORG_LOST');
  }
}
```

### ✅ 완료 기준
- [ ] TIMEOUT → gas bump 재전송 동작
- [ ] REORG 시뮬레이션 → 재처리 후 MINED 복귀 → FINALIZED → CONFIRMED
