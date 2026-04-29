# M8 S50 — Phase 1 전체 시스템 통합과 장애 주입 기반 복원력 검증

> 모듈 8 · 세션 50 · 1시간  
> 스켈레톤: Phase 1 전체 (M4~M8 구현 완료 상태)

---

## 강의 파트 (10분)

### Phase 1 전체 흐름 최종 확인

50세션 동안 구현한 시스템의 전체 흐름:

```
[앱 이벤트] → 조건 판단 → 발행 요청

M5 EventConditionService:
  ActivityConditionStrategy: 보행 10,000보 달성?
  CouponConditionStrategy: 쿠폰 조건 충족?

M5 IssuerService → BulkIssueService:
  지갑 주소 조회 (WalletMappingService)
  서명 검증 (EIP-191)
  VASP API 요청 (HTTP)

M6 KyoboNFT.sol (온체인):
  mint(to, tokenId, amount) → NFT 잔액 증가
  Transfer 이벤트 emit

M2~M3 DMZ 파이프라인:
  Webhook → Redis Streams → Consumer
  PENDING → SUBMITTED → CONFIRMED

M4 LedgerService:
  기록 (mint_request 원장)
  ReconcileService: 온체인 ↔ 원장 대조
  AuditLogService: SHA-256 체인 기록

M8 KeyGovernanceService (고위험 TX):
  proposeTx → addSignature × 2 → executeTx
  Travel Rule 검증 (100만원 이상)
```

각 모듈이 연결되는 지점에서 장애가 발생했을 때 시스템이 어떻게 반응하는지 검증한다.

---

## 실습 파트 (45분)

### E2E 정상 흐름 — 전체 1회 완주

```typescript
// test/e2e/phase1-e2e.test.ts
describe('Phase 1 E2E — 앱 이벤트 → NFT 발행 → 원장', () => {
  it('정상 E2E: 보행 달성 이벤트 → NFT 발행 → 원장 업데이트 → 감사 로그', async () => {
    // [1] 앱 이벤트 수신
    const event = {
      userId: 'user-001',
      eventType: 'WALKING_CHALLENGE',
      steps: 10_001,
      occurredAt: new Date(),
    };

    // [2] 조건 판단 (M5)
    const conditionMet = await eventConditionService.evaluate(event);
    expect(conditionMet).toBe(true);

    // [3] 지갑 주소 조회 (M5)
    const wallet = await walletMappingService.getVerifiedWallet('user-001');
    expect(wallet.address).toMatch(/^0x/);

    // [4] 발행 요청 생성 (M4)
    const mintRequest = await ledgerService.createMintRequest({
      userId: 'user-001',
      tokenId: encodeTokenId(1n, 1n),
      amount: 1n,
      activityId: event.occurredAt.getTime().toString(),
    });
    expect(mintRequest.status).toBe('PENDING');

    // [5] VASP API 호출 → NFT 민팅 (M5)
    const vasp = await issuerService.issueSingle({
      to: wallet.address,
      tokenId: mintRequest.tokenId,
      amount: mintRequest.amount,
      requestId: mintRequest.id,
    });

    // [6] 원장 상태 업데이트 (M4)
    await ledgerService.updateMintRequest(mintRequest.id, 'SUBMITTED', {
      vaspTxId: vasp.txId,
    });

    // [7] DMZ Consumer: 온체인 이벤트 수신 → CONFIRMED 전이 (M2/M3)
    await simulateOnchainConfirmation(mintRequest.id, '0xTxHash123');
    const confirmed = await ledgerService.updateMintRequest(
      mintRequest.id, 'CONFIRMED', { onChainTxHash: '0xTxHash123' },
    );
    expect(confirmed.status).toBe('CONFIRMED');

    // [8] 온체인 잔액 확인 (M6)
    const balance = await nftContract.balanceOf(wallet.address, mintRequest.tokenId);
    expect(balance).toBe(1n);

    // [9] Reconcile — 원장 vs 온체인 일치 확인 (M4)
    const reconcile = await reconcileService.reconcile();
    expect(reconcile.mismatches).toHaveLength(0);

    // [10] 감사 로그 체인 무결성 확인 (M4)
    const valid = await auditLogService.verifyChainIntegrity();
    expect(valid).toBe(true);
  });
});
```

### 장애 주입 1: VASP 중단 → 백오프 재시도 → 복구

```typescript
describe('장애 주입 1 — VASP 서버 다운', () => {
  it('VASP 3회 실패 → 지수 백오프 재시도 → 복구 후 정상 발행', async () => {
    let callCount = 0;

    // VASP API Mock: 3회 실패 후 성공
    mockVaspApi.mint.mockImplementation(async () => {
      callCount++;
      if (callCount <= 3) {
        throw new Error('VASP_UNAVAILABLE: Connection refused');
      }
      return { txId: 'vasp-tx-456', status: 'SUBMITTED' };
    });

    const mintRequest = await ledgerService.createMintRequest({
      userId: 'user-002',
      tokenId: encodeTokenId(1n, 1n),
      amount: 1n,
      activityId: 'activity-002',
    });

    // 재시도 포함 발행 실행
    // RetryService: 1초, 2초, 4초 백오프 후 4번째 성공
    const result = await issuerService.issueSingleWithRetry({
      to: '0xWallet002',
      tokenId: mintRequest.tokenId,
      amount: mintRequest.amount,
      requestId: mintRequest.id,
      maxRetries: 5,
    });

    expect(result.success).toBe(true);
    expect(callCount).toBe(4);  // 3회 실패 + 1회 성공

    // 원장 상태 확인
    const finalRequest = await ledgerService.getMintRequest(mintRequest.id);
    expect(finalRequest.status).toBe('SUBMITTED');
  });

  it('VASP 5회 전부 실패 → FAILED 상태로 전이', async () => {
    mockVaspApi.mint.mockRejectedValue(new Error('VASP_UNAVAILABLE'));

    const mintRequest = await ledgerService.createMintRequest({
      userId: 'user-003',
      tokenId: encodeTokenId(1n, 2n),
      amount: 1n,
      activityId: 'activity-003',
    });

    await issuerService.issueSingleWithRetry({
      to: '0xWallet003',
      tokenId: mintRequest.tokenId,
      amount: mintRequest.amount,
      requestId: mintRequest.id,
      maxRetries: 5,
    });

    const finalRequest = await ledgerService.getMintRequest(mintRequest.id);
    expect(finalRequest.status).toBe('FAILED');
    // DLQ로 이동 확인
    const dlqItem = await dlqService.get(mintRequest.id);
    expect(dlqItem).not.toBeNull();
  });
});
```

### 장애 주입 2: 블록체인 Reorg 시뮬레이션

```typescript
describe('장애 주입 2 — 블록 Reorg', () => {
  it('Reorg 발생 → 원장 롤백 → 재확인 후 CONFIRMED', async () => {
    // NFT 발행 완료 (CONFIRMED 상태)
    const mintRequest = await setupConfirmedMintRequest('user-004');
    expect(mintRequest.status).toBe('CONFIRMED');

    const onChainBalance = await nftContract.balanceOf('0xWallet004', mintRequest.tokenId);
    expect(onChainBalance).toBe(1n);

    // [Reorg 시뮬레이션]
    // DMZ Consumer가 REORGED 이벤트 수신
    await simulateReorgEvent(mintRequest.id);

    // 원장 롤백 — CONFIRMED → REORGED
    const reorgedRequest = await ledgerService.getMintRequest(mintRequest.id);
    expect(reorgedRequest.status).toBe('REORGED');

    // Reconcile — 불일치 감지 (원장은 REORGED, 온체인은 아직 잔액 있을 수 있음)
    // 실제 Reorg 후 온체인에서도 TX 사라짐
    await simulateReorgOnChain(mintRequest.tokenId, '0xWallet004');

    // 재확인 처리
    // 새 블록에서 TX 재채굴 → 다시 CONFIRMED
    await simulateReconfirmation(mintRequest.id, '0xNewTxHash789');

    const reconfirmed = await ledgerService.getMintRequest(mintRequest.id);
    expect(reconfirmed.status).toBe('CONFIRMED');
    expect(reconfirmed.onChainTxHash).toBe('0xNewTxHash789');
  });
});
```

### 장애 주입 3: Consumer 강제 종료 → 재시작 → 중복 없음

```typescript
describe('장애 주입 3 — Consumer 강제 종료', () => {
  it('Consumer 종료 후 재시작 → 미ACK 메시지 재처리, 중복 없음', async () => {
    // Consumer 시작
    const consumer1 = await startConsumer('consumer-A');

    // Redis Stream에 메시지 2개 투입
    await publishToStream('nft-events', { eventId: 'evt-100' });
    await publishToStream('nft-events', { eventId: 'evt-101' });

    // Consumer가 첫 메시지 수신 + 처리 중 강제 종료 (ACK 전)
    await consumer1.processOneAndCrash('evt-100');

    // Consumer 재시작
    const consumer2 = await startConsumer('consumer-A');  // 동일 consumer ID

    // Redis Streams XAUTOCLAIM: 미ACK 메시지 자동 재할당
    await consumer2.start();

    // evt-100 재처리
    await waitForProcessing('evt-100', consumer2);

    // 중복 방지: ON CONFLICT DO NOTHING 확인
    const mintRequestCount = await countMintRequestsForEvent('evt-100');
    expect(mintRequestCount).toBe(1);  // 2번 처리됐지만 원장은 1건

    // evt-101도 정상 처리
    await waitForProcessing('evt-101', consumer2);
    expect(await countMintRequestsForEvent('evt-101')).toBe(1);
  });
});
```

### 감사 로그 체인 무결성 검증

```typescript
describe('감사 로그 — SHA-256 체인 무결성', () => {
  it('E2E 전체 과정 후 감사 로그 체인 무결성 통과', async () => {
    // E2E 정상 흐름 실행 (여러 이벤트 처리)
    await runFullE2EScenario();

    // 체인 검증
    const valid = await auditLogService.verifyChainIntegrity();
    expect(valid).toBe(true);
  });

  it('감사 로그 중간 레코드 삭제 → 체인 무결성 실패', async () => {
    await runFullE2EScenario();

    // 중간 레코드 강제 삭제
    const logs = await auditLogService.getAll();
    await db.query('DELETE FROM audit_logs WHERE id = $1', [logs[2].id]);

    // 무결성 검증 실패
    const valid = await auditLogService.verifyChainIntegrity();
    expect(valid).toBe(false);
  });
});
```

### Gnosis Safe 2-of-3 서명 — 대형 TX 방어

```typescript
describe('키 거버넌스 — 2-of-3 서명 (M8 통합)', () => {
  it('1-of-3 서명으로 대형 TX 실행 → 불가', async () => {
    const tx = await govService.proposeTx('admin', {
      to: nftAddress,
      value: 1_000_000n,
      data: upgradeCalldata,
      operation: 0,
      travelRuleData: validTravelRule,
    });

    // 서명자 A만 서명
    await govService.addSignature(tx.id, signerA, sig_a);

    // 실행 시도 → threshold 미달
    await expect(govService.executeTx(tx.id, 'executor')).rejects.toThrow();
  });

  it('2-of-3 서명 후 대형 TX 실행 → 성공', async () => {
    const tx = await govService.proposeTx('admin', {
      to: nftAddress,
      value: 1_000_000n,
      data: upgradeCalldata,
      operation: 0,
      travelRuleData: validTravelRule,
    });

    await govService.addSignature(tx.id, signerA, sig_a);
    await govService.addSignature(tx.id, signerB, sig_b);

    const result = await govService.executeTx(tx.id, 'executor');
    expect(result.onChainTxHash).toMatch(/^0x/);
  });
});
```

---

## M8 + Phase 1 완료 기준

- [ ] 앱 이벤트 → 조건 판단 → NFT 발행 → 원장 업데이트 E2E 전체 동작
- [ ] VASP 장애 → 백오프 재시도 → 복구 후 정상 복귀
- [ ] Reorg 시뮬레이션 → 원장 롤백(REORGED) → 재확인 후 CONFIRMED
- [ ] Consumer 강제 종료 → 재시작 후 중복 없이 재처리
- [ ] 감사 로그 SHA-256 체인 무결성 E2E 후 통과
- [ ] 중간 로그 삭제 → 무결성 실패 확인
- [ ] 1-of-3 서명으로 대형 TX → 실행 불가
- [ ] 2-of-3 서명 후 대형 TX → 정상 실행
- [ ] Travel Rule 100만원 경계값 통과

---

## Phase 1 Prototype 데모 체크리스트

```
[ ] 보행 달성 이벤트 1건 투입
[ ] NFT 발행 → 지갑 잔액 확인 (etherscan or hardhat console)
[ ] 발행 원장 현황 조회 (Admin API /issuance/stats)
[ ] Reconcile 실행 → 불일치 0건
[ ] 감사 로그 조회 → SHA-256 체인 확인
[ ] VASP 중단 시뮬레이션 → 재시도 동작 확인
[ ] 업그레이드 TX 2-of-3 서명 흐름 시연
```
