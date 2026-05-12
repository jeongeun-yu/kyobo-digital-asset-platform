# M8 S50 — Phase 1 전체 시스템 통합과 장애 주입 기반 복원력 검증

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.

> 모듈 8 · 세션 50 · 1시간  
> 스켈레톤: Phase 1 전체 (M4~M8 구현 완료 상태)

---

## 강의 파트 (25분)

### 1. 장애 주입 테스트란 무엇인가 — "고장을 미리 만드는 이유"

단위 테스트(unit test)는 함수 하나의 정확성을 검증한다. 통합 테스트(integration test)는 모듈 간 연결을 검증한다. 장애 주입 테스트(fault injection test)는 **실제 장애가 발생했을 때 시스템이 의도한 방식으로 실패하는가**를 검증한다.

```
단위 테스트:      "올바른 입력에 올바른 출력이 나오는가?"
통합 테스트:      "모듈들이 함께 올바르게 동작하는가?"
장애 주입 테스트: "잘못된 상황에서도 시스템이 안전하게 처리하는가?"
```

**왜 장애를 일부러 만드는가?**

Murphy's Law: "잘못될 수 있는 것은 잘못된다." 금융 시스템에서 장애는 필연적이다. VASP 서버는 다운된다. 블록체인 Reorg는 발생한다. Consumer 프로세스는 크래시된다.

문제는 장애 자체가 아니라 **장애 시 시스템이 예측 불가능하게 행동하는 것**이다. 장애 주입 테스트는 "우리가 설계한 복구 메커니즘이 실제로 작동하는가"를 운영 전에 검증한다.

---

### 2. Phase 1에서 발생 가능한 장애 유형 3가지

```
┌──────────────────────────────────────────────────────────────────┐
│                    Phase 1 장애 발생 지점 지도                     │
│                                                                  │
│  [앱 이벤트]                                                      │
│      │                                                           │
│      ▼                                                           │
│  EventConditionService ── 조건 판단 ──────────────────────────────┤
│      │                                                           │
│      ▼                                                           │
│  IssuerService ────────── ❶ VASP 서버 다운 ──────────────────────┤
│      │                    (HTTP 연결 실패, 타임아웃)              │
│      ▼                                                           │
│  VASP API ─────────────── NFT mint TX 생성                        │
│      │                                                           │
│      ▼                                                           │
│  블록체인 ─────────────── ❷ Reorg 발생 ──────────────────────────┤
│      │                    (블록 재편성, TX 사라짐)               │
│      ▼                                                           │
│  Redis Streams ─────────── ❸ Consumer 크래시 ─────────────────── │
│      │                    (ACK 전 종료, 미처리 메시지)           │
│      ▼                                                           │
│  LedgerService ─────────── 원장 기록                              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**❶ VASP 서버 다운 — 복구 메커니즘: 지수 백오프 재시도**

```
장애: VASP API HTTP 연결 거부 (503 Service Unavailable)
영향: NFT 발행 중단 → mint_requests가 PENDING으로 묶임

복구:
  RetryHandler: 1초, 2초, 4초, 8초 지수 백오프
  5회 초과 → FAILED + DLQ 이동
  DLQ: M2 S51에서 운영팀이 수동 재처리

테스트 목표: 3회 실패 후 복구 시 정상 처리 확인
```

**❷ 블록 Reorg — 복구 메커니즘: REORGED 상태 + 재추적**

```
장애: 이미 CONFIRMED된 TX가 블록 재편성으로 체인에서 사라짐
영향: 원장에는 CONFIRMED, 실제 온체인은 잔액 없음

복구:
  이벤트 Consumer가 REORG 이벤트 감지 → MINED → REORGED 상태 전이
  ReconcileService가 불일치 감지 → 운영팀 알림
  새 블록에 TX 재채굴 → 다시 CONFIRMED

테스트 목표: Reorg 후 원장이 올바르게 롤백되고 재확인되는지 확인
```

**❸ Consumer 크래시 — 복구 메커니즘: Redis XAUTOCLAIM**

```
장애: Consumer가 메시지 처리 중 (ACK 전) 프로세스 종료
영향: 메시지가 PEL(Pending Entry List)에 남음 → 재처리 필요

복구:
  Redis XAUTOCLAIM: min-idle-time 초과 메시지 자동 재할당
  Consumer 재시작 → PEL의 미ACK 메시지 처리
  ON CONFLICT DO NOTHING: 중복 처리해도 원장은 1건만 기록

테스트 목표: 크래시 후 재시작 시 중복 없이 메시지가 처리되는지 확인
```

---

### 3. 장애 주입 vs 정상 흐름 — "회로 차단기(Circuit Breaker) 패턴"

RetryHandler에 Circuit Breaker를 도입하면 반복 장애 시 "연속 호출 폭탄"을 방지한다.

```
Circuit Breaker 3가지 상태:

CLOSED (정상):
  모든 호출 허용 → 실패 카운트 증가
  실패 임계값(예: 5회) 초과 → OPEN으로 전환

OPEN (차단):
  모든 호출 즉시 실패 (VASP API 호출 안 함)
  일정 시간(예: 30초) 후 → HALF_OPEN으로 전환

HALF_OPEN (반개방):
  소수 호출만 허용 (탐침)
  성공 → CLOSED 복귀
  실패 → OPEN 재전환
```

```
왜 Circuit Breaker가 필요한가?

VASP 서버가 과부하 상태일 때:
  - 재시도 없이 계속 호출 → VASP 서버 복구 불가 (요청 폭탄)
  - Circuit Breaker OPEN → 일정 시간 호출 중단 → VASP 서버 회복 기회
  - HALF_OPEN → 조심스럽게 재개

금융 시스템에서 "장애를 전파하지 않는" 설계 원칙의 핵심.
```

---

### 4. E2E 테스트와 장애 주입 테스트의 차이

```
E2E (정상 흐름) 테스트:
  모든 컴포넌트가 정상 동작 가정
  "전체 흐름이 기대한 결과를 내는가?" 검증

장애 주입 테스트:
  특정 컴포넌트를 강제로 고장내고
  "나머지 시스템이 올바르게 반응하는가?" 검증
  복구 후 "정상으로 돌아오는가?" 검증
```

이번 세션은 두 가지를 모두 실행한다: 먼저 E2E 전체 흐름이 동작하는지 확인한 후, 각 장애 유형별로 시스템의 복원력을 검증한다.

---

### 5. Phase 1 전체 흐름 최종 확인

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

M2~M3 이벤트 파이프라인:
  Webhook → Redis Streams → Consumer
  PENDING → SUBMITTED → MINED → FINALIZED → CONFIRMED

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

## 실습 파트 (35분)

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

    // [7] 이벤트 Consumer: 온체인 이벤트 수신 → FINALIZED 전이 → 원장 업데이트 → CONFIRMED (M2/M3)
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
    // 이벤트 Consumer가 REORGED 이벤트 수신
    await simulateReorgEvent(mintRequest.id);

    // 원장 롤백 — MINED → REORGED (FINALIZED 이전에만 REORG 가능)
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
- [ ] Reorg 시뮬레이션 → 원장 롤백(MINED→REORGED) → 재채굴 후 MINED → FINALIZED → CONFIRMED
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
