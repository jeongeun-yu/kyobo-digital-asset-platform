# M3 S22 — pollStaleRequests 구현 + 3종 복구 통합 테스트

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S22 · 1시간  
> 대상: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`

---

## S22 — pollStaleRequests 구현 + 3종 복구 통합 테스트

---

### 0. 이론 — 배치 처리에서 오류 격리가 중요한 이유

#### 0-1. 단일 오류가 전체 배치를 중단시키는 문제

```
pollStaleRequests 배치 처리:
  100건의 stale TX 조회됨

  잘못된 설계 (오류 전파):
    [req-001] 처리 ✅
    [req-002] 처리 ✅
    ...
    [req-050] VASP API 타임아웃 → throw
    → pollStaleRequests 중단
    → [req-051] ~ [req-100] 미처리
    → 50건의 사용자가 최대 5분 추가 지연

  올바른 설계 (오류 격리):
    [req-050] VASP API 타임아웃 → catch → 로그
    [req-051] 처리 계속 ✅
    ...
    [req-100] 처리 완료 ✅
    → [req-050]은 다음 크론 주기(5분 후)에 재처리
```

이 패턴을 **Bulkhead(격벽) 패턴**이라 한다. 배의 격벽이 한 구역에 구멍이 나도 전체 침몰을 막듯, 개별 오류가 전체 배치를 침몰시키지 않도록 격리한다.

---

#### 0-2. 통합 테스트(Integration Test) vs 단위 테스트(Unit Test) — 왜 둘 다 필요한가

```
단위 테스트:
  handleRevert, handleTimeout, handleReorg 각각 독립 테스트
  → "이 함수가 올바르게 동작하는가"
  → 빠름, 격리됨, 의존성 Mock
  
  한계: 각 함수가 따로 동작해도 조합 시 버그 발생 가능

통합 테스트:
  pollStaleRequests → vasp.getStatus() → handleXxx() → DB 저장
  전체 흐름을 실제 흐름과 유사하게 검증
  → "시스템이 전체적으로 올바르게 동작하는가"
  
  ┌──────────────────────────────────────────────────────┐
  │  S22 통합 테스트 범위                                 │
  │                                                        │
  │  [Mock VASP] ← setNextStatus()                        │
  │       │                                               │
  │  pollStaleRequests()                                  │
  │       │                                               │
  │  vasp.getStatus() → 결과별 분기                       │
  │       │                                               │
  │  handleConfirmed() / handleFailed() / handleTimeout() │
  │       │                                               │
  │  [In-memory Repo] → findById() 로 최종 상태 검증      │
  └──────────────────────────────────────────────────────┘
```

---

#### 0-3. M3 전체 아키텍처 최종 조감도

S13~S22에서 구현한 모든 컴포넌트가 어떻게 연결되는지 한눈에 본다.

```
  [사용자 요청]
       │
       ▼
  IssuerService.submitMintRequest()          ← S13
       │
       ├── DB: mint_requests (REQUESTED)
       │
       ▼
  VaspClient.submit()                        ← S13
       │
       ├── DB: mint_requests (SUBMITTED → PENDING)
       │
       ▼
  EVMAdapter / XRPLAdapter (IBlockchainAdapter)  ← S14, S15
       │
       │  [VASP가 TX 처리]
       │
       ├──[채널 A: Webhook Push]─────────────────── S21
       │       │
       │  WebhookReceiver → Redis XADD → ConsumerGroupWorker
       │       │
       │  TxStateMachineService.handleConfirmed()
       │
       └──[채널 B: Polling Pull 5분 크론]─────────── S21, S22
               │
          pollStaleRequests()
               │
          ┌────┴──────────────────────────┐
          │                               │
          ▼                               ▼
    vasp.getStatus()              (PENDING 30분 미만)
          │                          → skip
          ├── confirmed → handleConfirmed()
          ├── failed    → handleFailed()      ← S18 (REVERT)
          ├── not_found → handleFailed()
          ├── pending   → skip (계속 대기)
          │                     │
          │               [30분 초과 pending]
          │                     │
          │               handleTimeout()     ← S20 (gas bump)
          │
          └── [MINED 전이 후, CONFIRMED 이전]
                    │
               REORG 감지 → handleReorg()    ← S20
                    │
          ┌─────────┴───────────┐
          │                     │
      MINED 복귀            FAILED 전이
  (confirmation 재시작)
  
  [모든 상태 전이]
       │
       ▼
  IdempotencyGuard (requestId 기반)           ← S16
       │
       ▼
  LedgerService 이벤트 발행
       │
       ▼
  ConsumerGroupWorker → NFTIssuedProcessor
       │
       ▼
  user_nft_holdings +1 (M4)

  ───────────────────────────────────────────────────
  오류 복구 레이어:
  VaspRecoveryService                         ← S18, S20
    - retryWithBackoff (지수 백오프 + Jitter)  ← S17
    - handleTxRevert / handleReorg / handleTimeout
  ───────────────────────────────────────────────────
```

---

### 1. pollStaleRequests 전체 구현

```typescript
// TxStateMachineService.ts:289
async pollStaleRequests(): Promise<{ processed: number }> {
  const stale = await this.repo.findPendingOlderThan(
    TxStateMachineService.STALE_MINUTES,  // 30분
  );
  let processed = 0;

  for (const req of stale) {
    if (!req.txHash) continue;  // txHash 없는 건은 건너뜀

    try {
      const result = await this.vasp.getStatus(req.txHash);

      // TODO (S22 실습): 결과별 상태 전이 로직 작성
      switch (result.status) {
        case 'confirmed':
          await this.handleConfirmed(req.id);
          break;
        case 'failed':
          await this.handleFailed(req.id, result.revertReason ?? 'failed');
          break;
        case 'not_found':
          await this.handleFailed(req.id, 'tx not found in mempool');
          break;
        // 'pending' → 아무것도 하지 않음 (계속 대기)
        // 'mined'   → handleMined() 호출 (선택적 구현)
      }
      processed++;
    } catch (err) {
      console.error(`[TxStateMachine] pollStale error for ${req.id}:`, err);
      // 개별 에러가 전체 배치 중단시키면 안 됨 → catch 후 다음 건 진행
    }
  }

  return { processed };
}
```

**개별 에러를 catch하는 이유:**

```
100건 배치 처리 중 50번째에서 VASP API 오류 발생
→ throw하면 나머지 50건 처리 안 됨
→ catch 후 로그 기록 → 다음 건 진행
→ 미처리 건은 다음 크론 주기에 재처리
```

### 2. 실습 — pollStaleRequests 구현 (TODO 완성)

```typescript
// TODO (S22 실습): pollStaleRequests 결과별 전이
async pollStaleRequests(): Promise<{ processed: number }> {
  const stale = await this.repo.findPendingOlderThan(TxStateMachineService.STALE_MINUTES);
  let processed = 0;

  for (const req of stale) {
    if (!req.txHash) continue;
    try {
      const result = await this.vasp.getStatus(req.txHash);

      // TODO: switch로 result.status 처리
      //   confirmed  → handleConfirmed
      //   failed     → handleFailed(revertReason)
      //   not_found  → handleFailed('tx not found in mempool')
      //   pending    → skip
      //   mined      → handleMined(blockNumber)

      processed++;
    } catch (err) {
      console.error(`pollStale error ${req.id}:`, err);
    }
  }
  return { processed };
}
```

### 3. 3종 통합 테스트 시나리오

#### REVERT 시나리오

```typescript
it('[통합] REVERT → FAILED 전이 + reason 저장', async () => {
  const service = new TxStateMachineService(repo, vaspMock, walletResolver);

  // PENDING 상태 + 30분 초과 세팅
  const staleDate = new Date(Date.now() - 35 * 60 * 1000);
  await repo.save({
    id: 'req-revert-001', userId: 'user-1',
    tokenId: 1001n, amount: 1n,
    status: 'PENDING', txHash: '0xREVERTED',
    retryCount: 0, createdAt: staleDate, updatedAt: staleDate,
  });

  // Mock: REVERT 응답 설정
  vaspMock.setNextStatus('0xREVERTED', 'failed', undefined, 'execution reverted: Contract is paused');

  const { processed } = await service.pollStaleRequests();

  expect(processed).toBe(1);
  const req = await repo.findById('req-revert-001');
  expect(req?.status).toBe('FAILED');
  expect(req?.failReason).toContain('paused');
});
```

#### TIMEOUT 시나리오

```typescript
it('[통합] TIMEOUT → gas bump → PENDING 유지', async () => {
  const service = new TxStateMachineService(repo, vaspMock, walletResolver);

  const staleDate = new Date(Date.now() - 35 * 60 * 1000);
  await repo.save({
    id: 'req-timeout-001', userId: 'user-1',
    tokenId: 1002n, amount: 1n,
    status: 'PENDING', txHash: '0xSTUCK',
    retryCount: 0, createdAt: staleDate, updatedAt: staleDate,
  });

  // pollStaleRequests: 'pending' → 아무 전이 없음 (gas bump는 별도 handleTimeout 호출)
  vaspMock.setNextStatus('0xSTUCK', 'pending');
  await service.pollStaleRequests();

  // handleTimeout 직접 호출 (TIMEOUT 감지 후)
  await service.handleTimeout('req-timeout-001');

  const req = await repo.findById('req-timeout-001');
  expect(req?.status).toBe('PENDING');      // 상태 유지
  expect(req?.txHash).not.toBe('0xSTUCK'); // 새 txHash
  expect(req?.retryCount).toBe(1);
});
```

#### REORG 시나리오

```typescript
it('[통합] REORG 시뮬레이션 → REORGED → MINED 복귀', async () => {
  const service = new TxStateMachineService(repo, vaspMock, walletResolver);

  // MINED 상태 세팅 (REORG는 FINALIZED 이전 MINED 구간에서만 발생)
  await repo.save({
    id: 'req-reorg-001', userId: 'user-1',
    tokenId: 1003n, amount: 1n,
    status: 'MINED', txHash: '0xMINED',
    retryCount: 0, createdAt: new Date(), updatedAt: new Date(),
  });

  // Mock: 5블록 후 mined 응답 (재편 후 다시 포함됨)
  vaspMock.setNextStatus('0xMINED', 'mined', 12350);

  await service.handleReorg('req-reorg-001');

  const req = await repo.findById('req-reorg-001');
  expect(req?.status).toBe('MINED');  // MINED 복귀 확인
});
```

### 4. 콜백 차단 테스트 — 폴링 채널 검증

```typescript
it('[E2E] 콜백 차단 → 폴링에서 자동 처리', async () => {
  const service = new TxStateMachineService(repo, vaspMock, walletResolver);

  // 콜백 없이 PENDING 상태 30분 방치
  const staleDate = new Date(Date.now() - 35 * 60 * 1000);
  await repo.save({
    id: 'req-no-callback', userId: 'user-1',
    tokenId: 1004n, amount: 1n,
    status: 'PENDING', txHash: '0xNO_CB',
    retryCount: 0, createdAt: staleDate, updatedAt: staleDate,
  });

  // VASP API 직접 조회: confirmed
  vaspMock.setNextStatus('0xNO_CB', 'confirmed', 12400);

  // pollStaleRequests 실행 (크론 대신 직접 실행)
  const { processed } = await service.pollStaleRequests();

  expect(processed).toBe(1);
  const req = await repo.findById('req-no-callback');
  expect(req?.status).toBe('CONFIRMED');  // 폴링으로 처리 완료
});
```

### 5. Idempotency 보장 테스트 — 콜백 + 폴링 동시 처리

```typescript
it('콜백 처리 완료 후 폴링이 중복 처리하지 않음', async () => {
  const service = new TxStateMachineService(repo, vaspMock, walletResolver);

  // 이미 CONFIRMED 상태 (콜백으로 처리됨)
  await repo.save({
    id: 'req-already-confirmed', userId: 'user-1',
    tokenId: 1005n, amount: 1n,
    status: 'CONFIRMED', txHash: '0xDONE',
    retryCount: 0,
    createdAt: new Date(Date.now() - 35 * 60 * 1000),
    updatedAt: new Date(),
  });

  // pollStaleRequests: PENDING이 아니므로 findPendingOlderThan에서 제외됨
  const { processed } = await service.pollStaleRequests();

  expect(processed).toBe(0);  // 이미 처리된 건 무시
});
```

### 6. M3 모듈 완료 기준 체크리스트

- [ ] **VALID_TRANSITIONS 맵**: 허용 안 된 전이 → `InvalidStatusTransitionError` 예외
- [ ] **submitMintRequest**: REQUESTED → SUBMITTED 전이, requestId Idempotency
- [ ] **EVMAdapter**: `mintNFT`, `subscribeEvents`, `queryEvents` 동작
- [ ] **XRPL Mock 교체**: 상위 레이어 코드 변경 없이 `chainType = 'XRPL'`로 전환
- [ ] **retryWithBackoff**: 지수 백오프 + Jitter, 5회 소진 후 FAILED
- [ ] **handleTxRevert**: FAILED 전이 + reason 저장 + 알림
- [ ] **handleTimeout**: gas 20% bump + 새 txHash + PENDING 유지
- [ ] **handleReorg**: REORGED → 5블록 대기 → VASP 재조회 → MINED or FAILED (FINALIZED 이전에만 REORG 가능)
- [ ] **pollStaleRequests**: 30분 초과 PENDING → VASP 직접 조회 → 결과별 전이
- [ ] **3종 통합 테스트**: REVERT / TIMEOUT / REORG 각각 통과
- [ ] **콜백 차단 테스트**: 폴링으로 자동 처리 확인
- [ ] **중복 처리 없음**: 콜백 처리 완료 후 폴링이 CONFIRMED 건 재처리 안 함

---

## M3 핵심 정리

```
M3 VASP + TX 상태머신의 3가지 원칙:

1. 상태머신으로 비동기 TX 추적
   "TX는 즉시 확정되지 않는다 — REQUESTED→SUBMITTED→PENDING→MINED→FINALIZED→CONFIRMED"
   → 각 단계를 DB에 기록 → 재시작 후에도 어디까지 처리됐는지 알 수 있음

2. 추상화 레이어로 멀티체인 대비
   "비즈니스 로직은 IBlockchainAdapter만 안다 — 체인 교체는 어댑터만 바꾼다"
   → EVMAdapter → XRPLAdapter 교체 시 IssuerService 코드 한 줄도 변경 없음

3. 이중 채널 + 3종 복구로 신뢰성 확보
   "콜백(빠름, 유실 가능) + 폴링(느림, 확실) = 반드시 처리됨"
   → REVERT: 즉시 FAILED + reason 저장
   → TIMEOUT: gas bump 재전송 (RBF)
   → REORG: 5블록 대기 → VASP 재조회 → 최종 상태 결정
```

**다음 모듈 (M4 S23~S26):**  
내부 원장 + 감사 로그 — M3에서 CONFIRMED 전이가 발생하면 LedgerService가 `user_nft_holdings`를 어떻게 갱신하는가. M2 ConsumerGroupWorker + IdempotencyGuard가 원장 레이어에서 어떻게 연결되는가.

---

> **📎 Phase 3 미리보기 연결:**  
> 이 세션의 `pollStaleRequests` 단일 루프는 Phase 1에서 충분하다.  
> Phase 3에서는 타임스케일이 다른 **Broadcaster(10초 루프) + ConfirmationTracker(1분 루프)**로 분리되고,  
> DB-외부 호출 원자성을 보장하는 **Outbox 패턴**이 추가된다.  
> → [Phase3_S2_broadcaster_outbox.md](./Phase3_S2_broadcaster_outbox.md)
