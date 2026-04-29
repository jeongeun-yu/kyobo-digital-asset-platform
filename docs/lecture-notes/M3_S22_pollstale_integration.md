# M3 S22 — pollStaleRequests 구현 + 3종 복구 통합 테스트

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S22 · 1시간  
> 대상: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`

---

## S22 — pollStaleRequests 구현 + 3종 복구 통합 테스트

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
it('[통합] REORG 시뮬레이션 → REORGED → CONFIRMED 복귀', async () => {
  const service = new TxStateMachineService(repo, vaspMock, walletResolver);

  // CONFIRMED 상태 세팅
  await repo.save({
    id: 'req-reorg-001', userId: 'user-1',
    tokenId: 1003n, amount: 1n,
    status: 'CONFIRMED', txHash: '0xCONFIRMED',
    retryCount: 0, createdAt: new Date(), updatedAt: new Date(),
  });

  // Mock: 5블록 후 confirmed 응답
  vaspMock.setNextStatus('0xCONFIRMED', 'confirmed', 12350);

  await service.handleReorg('req-reorg-001');

  const req = await repo.findById('req-reorg-001');
  expect(req?.status).toBe('CONFIRMED');
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
- [ ] **handleReorg**: REORGED → 5블록 대기 → VASP 재조회 → CONFIRMED or FAILED
- [ ] **pollStaleRequests**: 30분 초과 PENDING → VASP 직접 조회 → 결과별 전이
- [ ] **3종 통합 테스트**: REVERT / TIMEOUT / REORG 각각 통과
- [ ] **콜백 차단 테스트**: 폴링으로 자동 처리 확인
- [ ] **중복 처리 없음**: 콜백 처리 완료 후 폴링이 CONFIRMED 건 재처리 안 함

---

## M3 핵심 정리

```
M3 VASP + TX 상태머신의 3가지 원칙:

1. 상태머신으로 비동기 TX 추적
   "TX는 즉시 확정되지 않는다 — REQUESTED→SUBMITTED→PENDING→MINED→CONFIRMED"
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
