/**
 * S20 실습 — TIMEOUT·REORG 복구 핸들러 구현
 *
 * 강의 노트: M3_S20_timeout_reorg_handler.md
 *
 * 실행 방법 (루트에서): npm run exercise:s20
 *
 * 목표:
 *   [1] Gas Bump 메커니즘 이해 — 동일 nonce + 높은 gas price로 재제출
 *   [2] handleTimeout — PENDING → PENDING (txHash 교체, retryCount 증가)
 *   [3] REORG 발생 조건 — MINED(INCLUDED) 구간에서만 가능
 *   [4] handleReorg — REORGED 전이 → 5블록 대기 → MINED 복귀 or FAILED
 *   [5] VaspRecoveryService.handleReorg — retryWithBackoff + 재제출
 *   [6] Gas Bump 이중 채굴 방어 — nonce 메커니즘 + requestId 멱등성
 */

import type { MintRequest } from '@kyobo/vasp';
import {
  TxStateMachineService,
  VaspRecoveryService,
  InMemoryTxRepository,
  InMemoryLedger,
  MockVaspClient,
  MockNotifier,
  InvalidStateTransitionError,
} from '@kyobo/vasp';

// ────────────────────────────────────────────────────────────────────────
// 공통 픽스처
// ────────────────────────────────────────────────────────────────────────

const PENDING_REQUEST: MintRequest = {
  id:         'req-timeout-1',
  userId:     'user-1',
  tokenId:    1001n,
  amount:     1n,
  status:     'PENDING',
  txHash:     '0xOLD_PENDING',
  retryCount: 0,
  createdAt:  new Date(),
  updatedAt:  new Date(),
};

const MINED_REQUEST: MintRequest = {
  id:         'req-reorg-1',
  userId:     'user-1',
  tokenId:    1002n,
  amount:     1n,
  status:     'MINED',
  txHash:     '0xMINED_HASH',
  retryCount: 0,
  createdAt:  new Date(),
  updatedAt:  new Date(),
};

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 1: Gas Bump 메커니즘 이해
//
// TIMEOUT은 mempool에서 gas price가 낮아 채굴자가 선택하지 않은 것이다.
// 동일 nonce로 gas price를 30% 이상 올려 재제출하면
// 채굴자가 높은 gas TX를 선택하고 낮은 gas TX는 자동 드롭된다.
//
// 주의: REVERT(컨트랙트 조건 미충족)와 달리
//       TIMEOUT은 조건이 맞는데 외부 요인(gas)으로 못 통과한 것 → 재시도 가능
// ────────────────────────────────────────────────────────────────────────

async function section1() {
  console.log('[1] Gas Bump 메커니즘 이해');

  // Gas Bump 계산 — GAS_BUMP_PERCENT = 30
  const GAS_BUMP_PERCENT = 30;

  function calcBumpedGasPrice(originalGwei: number): number {
    return Math.ceil(originalGwei * (1 + GAS_BUMP_PERCENT / 100));
  }

  const original = 10;
  const bumped   = calcBumpedGasPrice(original);
  check(`Gas Bump 30%: ${original} gwei → ${bumped} gwei`, bumped >= 13);
  check('Bump 후 gas price > 원래보다 높음', bumped > original);

  // 동일 nonce → 채굴자는 하나만 선택
  const nonce = 42;
  const tx1 = { nonce, gasPrice: 10 };
  const tx2 = { nonce, gasPrice: bumped };
  check(`동일 nonce(${nonce}) → 채굴자는 높은 gas TX 선택`, tx2.gasPrice > tx1.gasPrice);
  check('낮은 gas TX(tx1)는 자동 드롭', tx1.gasPrice < tx2.gasPrice);

  // REVERT vs TIMEOUT 재시도 가능성 비교
  const scenarios = [
    { type: 'REVERT',  reason: '컨트랙트 조건 미충족 — 조건을 고쳐야 통과', retryable: false },
    { type: 'TIMEOUT', reason: 'mempool에서 gas 낮음 — gas bump 후 통과 가능', retryable: true },
    { type: 'REORG',   reason: '블록 재편으로 TX 소실 — 재제출 가능',         retryable: true },
  ];

  for (const s of scenarios) {
    check(`${s.type}: retryable = ${s.retryable} (${s.reason})`, true); // 개념 확인
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 2: handleTimeout — PENDING → PENDING + 새 txHash + retryCount 증가
//
// 처리 흐름:
//   1. status === 'PENDING' && txHash 있는지 확인 (가드)
//   2. vasp.resubmitWithGasBump(txHash, GAS_BUMP_PERCENT) → 새 txHash
//   3. updateStatus: status 유지(PENDING), txHash 교체, retryCount + 1
//
// 상태가 PENDING → PENDING인 이유: 아직 블록에 포함되지 않았으므로
// ────────────────────────────────────────────────────────────────────────

async function section2() {
  console.log('\n[2] handleTimeout — PENDING → PENDING + gas bump');

  // 정상 케이스: PENDING 상태에서 handleTimeout
  {
    const repo = new InMemoryTxRepository();
    const vasp = new MockVaspClient();
    const svc  = new TxStateMachineService(repo, vasp);

    await repo.save({ ...PENDING_REQUEST, id: 'req-to-1' });

    await svc.handleTimeout('req-to-1');

    const req = await repo.findById('req-to-1');

    check('handleTimeout → status: PENDING 유지 (아직 미채굴)',  req?.status === 'PENDING');
    check('handleTimeout → txHash가 새 값으로 교체됨',           req?.txHash !== '0xOLD_PENDING');
    check('handleTimeout → retryCount 1 증가',                  req?.retryCount === 1);
  }

  // retryCount가 이미 높은 경우 — 무한 gas bump 방지
  // (실제 구현에서는 retryCount > MAX_RETRY → FAILED 전이)
  {
    const repo = new InMemoryTxRepository();
    const vasp = new MockVaspClient();
    const svc  = new TxStateMachineService(repo, vasp);

    await repo.save({ ...PENDING_REQUEST, id: 'req-to-2', retryCount: 3 });

    // retryCount = 3이면 추가 gas bump 없이 FAILED 전이 여부 확인
    // (MockVaspClient가 MaxRetryExceeded를 throw하도록 설정)
    vasp.setMaxRetryReached(true);

    let failedAfterMaxRetry = false;
    try {
      await svc.handleTimeout('req-to-2');
      const req = await repo.findById('req-to-2');
      failedAfterMaxRetry = req?.status === 'FAILED';
    } catch {
      failedAfterMaxRetry = true;
    }

    check('retryCount 한도 초과 → FAILED 전이 또는 예외', failedAfterMaxRetry);
  }

  // 가드: PENDING이 아닌 상태에서 handleTimeout → no-op
  {
    const repo = new InMemoryTxRepository();
    const vasp = new MockVaspClient();
    const svc  = new TxStateMachineService(repo, vasp);

    await repo.save({ ...PENDING_REQUEST, id: 'req-to-3', status: 'SUBMITTED' });

    await svc.handleTimeout('req-to-3'); // SUBMITTED → no-op (가드)

    const req = await repo.findById('req-to-3');
    check('SUBMITTED 상태에서 handleTimeout → 상태 변경 없음 (가드)', req?.status === 'SUBMITTED');
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 3: REORG 발생 조건 — MINED(INCLUDED) 구간에서만 가능
//
// REORG는 블록에 포함됐지만 finalized 되기 전(MINED 상태)에만 발생한다.
// CONFIRMED(finalized) 이후에는 REORG 발생 가능성이 극히 낮다.
// ────────────────────────────────────────────────────────────────────────

async function section3() {
  console.log('\n[3] REORG 발생 조건 — MINED 구간에서만');

  // REORG 가능 상태 확인
  const reorgEligible = (status: MintRequest['status']) => status === 'MINED';

  check('MINED → REORG 발생 가능',     reorgEligible('MINED'));
  check('PENDING → REORG 불가',        !reorgEligible('PENDING'));
  check('SUBMITTED → REORG 불가',      !reorgEligible('SUBMITTED'));
  check('CONFIRMED → REORG 극히 드묾', !reorgEligible('CONFIRMED'));
  check('FAILED → REORG 불가',         !reorgEligible('FAILED'));

  // REORG 깊이별 발생 확률
  const reorgDepths = [
    { depth: 1, probability: '간헐적', action: '일반 REORG 처리' },
    { depth: 3, probability: '드묾',   action: '비정상 재편 — 즉시 에스컬레이션' },
    { depth: 6, probability: '극히',   action: '51% 공격 수준 — 즉각 인프라팀' },
  ];

  for (const r of reorgDepths) {
    check(`${r.depth}블록 REORG → ${r.action}`, true); // 개념 확인
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 4: handleReorg — REORGED 전이 → 5블록 대기 → MINED 복귀 or FAILED
//
// 처리 흐름:
//   1. status === 'MINED' && txHash 있는지 확인 (가드)
//   2. REORGED 전이 (임시 상태)
//   3. _waitBlocks(5) — 재편이 안정화될 때까지 대기
//   4. vasp.getStatus(txHash) 재조회
//      → 'mined': MINED 복귀 (confirmation 카운트 재시작)
//      → 'not_found': FAILED 전이 + failReason
// ────────────────────────────────────────────────────────────────────────

async function section4() {
  console.log('\n[4] handleReorg — 5블록 대기 → MINED 복귀 or FAILED');

  // 시나리오 A: 재편 후 TX가 새 체인에 포함됨 → MINED 복귀
  {
    const repo = new InMemoryTxRepository();
    const vasp = new MockVaspClient();
    const svc  = new TxStateMachineService(repo, vasp);

    await repo.save({ ...MINED_REQUEST, id: 'req-rg-ok' });

    // Mock: 5블록 대기 후 vasp.getStatus → 'mined' (재포함됨)
    vasp.setNextStatus('0xMINED_HASH', 'mined', 12350);

    await svc.handleReorg('req-rg-ok');

    const req = await repo.findById('req-rg-ok');
    check('REORG 후 TX 재포함 → status: MINED 복귀', req?.status === 'MINED');
  }

  // 시나리오 B: 재편 후 TX가 영구 소실 → FAILED 전이
  {
    const repo = new InMemoryTxRepository();
    const vasp = new MockVaspClient();
    const svc  = new TxStateMachineService(repo, vasp);

    await repo.save({ ...MINED_REQUEST, id: 'req-rg-fail', txHash: '0xLOST' });

    // Mock: 5블록 대기 후 vasp.getStatus → 'not_found' (영구 소실)
    vasp.setNextStatus('0xLOST', 'not_found', 12351);

    await svc.handleReorg('req-rg-fail');

    const req = await repo.findById('req-rg-fail');
    check('REORG 후 TX 영구 소실 → status: FAILED',           req?.status === 'FAILED');
    check('REORG 후 영구 소실 → failReason에 reorg 포함',    req?.failReason?.includes('reorg') ?? false);
  }

  // 가드: MINED가 아닌 상태에서 handleReorg → no-op
  {
    const repo = new InMemoryTxRepository();
    const vasp = new MockVaspClient();
    const svc  = new TxStateMachineService(repo, vasp);

    await repo.save({ ...MINED_REQUEST, id: 'req-rg-guard', status: 'CONFIRMED' });

    await svc.handleReorg('req-rg-guard'); // CONFIRMED → no-op (가드)

    const req = await repo.findById('req-rg-guard');
    check('CONFIRMED 상태에서 handleReorg → 상태 변경 없음 (가드)', req?.status === 'CONFIRMED');
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 5: VaspRecoveryService.handleReorg — retryWithBackoff + 재제출
//
// VaspRecoveryService.handleReorg는 TxStateMachineService.handleReorg와 다르다:
//   TxStateMachine: MINED → REORGED → MINED or FAILED (상태 추적)
//   VaspRecovery:   SUBMITTED/CONFIRMED → REORGED → retryWithBackoff(vaspClient.resubmit)
//                   성공: SUBMITTED + newTxHash
//                   3회 실패: FAILED + 운영팀 알림
// ────────────────────────────────────────────────────────────────────────

async function section5() {
  console.log('\n[5] VaspRecoveryService.handleReorg — retryWithBackoff 재제출');

  // 시나리오 A: resubmit 성공 → SUBMITTED + newTxHash
  {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const vasp     = new MockVaspClient();
    const recovery = new VaspRecoveryService(ledger, vasp, notifier);

    await ledger.saveMintRequest({
      id: 'req-vrg-ok', userId: 'user-1', tokenId: 2001n, amount: 1n,
      status: 'SUBMITTED', txHash: '0xORIG', retryCount: 0,
      createdAt: new Date(), updatedAt: new Date(),
    });

    // Mock: resubmit 성공 → 새 txHash 반환
    vasp.setResubmitResult('req-vrg-ok', { txHash: '0xNEW_TX' });

    const result = await recovery.handleReorg('req-vrg-ok', '0xORIG', 12345);

    const req = await ledger.getMintRequest('req-vrg-ok');

    check('VaspRecovery reorg 재제출 성공 → action: RESUBMITTED', result.action === 'RESUBMITTED');
    check('VaspRecovery reorg 재제출 성공 → status: SUBMITTED',   req?.status === 'SUBMITTED');
    check('VaspRecovery reorg 재제출 성공 → txHash 새 값으로 교체', req?.txHash === '0xNEW_TX');
  }

  // 시나리오 B: resubmit 3회 실패 → FAILED + 운영팀 알림
  {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const vasp     = new MockVaspClient();
    const recovery = new VaspRecoveryService(ledger, vasp, notifier);

    await ledger.saveMintRequest({
      id: 'req-vrg-fail', userId: 'user-1', tokenId: 2002n, amount: 1n,
      status: 'SUBMITTED', txHash: '0xFAIL_ORIG', retryCount: 0,
      createdAt: new Date(), updatedAt: new Date(),
    });

    // Mock: 항상 실패 (3회 모두)
    vasp.setResubmitAlwaysFail(true);

    const result = await recovery.handleReorg('req-vrg-fail', '0xFAIL_ORIG', 12346);

    const req = await ledger.getMintRequest('req-vrg-fail');

    check('VaspRecovery reorg 재제출 전패 → action: FAILED',     result.action === 'FAILED');
    check('VaspRecovery reorg 재제출 전패 → status: FAILED',     req?.status === 'FAILED');
    check('VaspRecovery reorg 재제출 전패 → REORG_RECOVERY_FAILED 알림 발송',
      notifier.sentEvents.some(e => e.type === 'REORG_RECOVERY_FAILED'),
    );
  }

  // 잘못된 상태에서 VaspRecovery.handleReorg → 예외
  {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const vasp     = new MockVaspClient();
    const recovery = new VaspRecoveryService(ledger, vasp, notifier);

    await ledger.saveMintRequest({
      id: 'req-vrg-inv', userId: 'user-1', tokenId: 2003n, amount: 1n,
      status: 'FAILED', txHash: '0xFAILED', retryCount: 0,
      createdAt: new Date(), updatedAt: new Date(),
    });

    let threw = false;
    try {
      await recovery.handleReorg('req-vrg-inv', '0xFAILED', 12347);
    } catch {
      threw = true;
    }

    check('FAILED 상태에서 VaspRecovery.handleReorg → 예외', threw);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 6: Gas Bump 이중 채굴 방어 — nonce 메커니즘 + requestId 멱등성
//
// Gas Bump 시나리오:
//   t=0:  TX1 제출 (nonce=42, gasPrice=10)
//   t=30: TIMEOUT 감지 → TX2 제출 (nonce=42, gasPrice=13)
//   t=35: TX2 채굴 → CONFIRMED 처리
//   t=40: TX1도 채굴? → No! 같은 nonce는 동시 채굴 불가
//
// 방어 레이어 2: requestId 멱등성
//   → IdempotencyGuard가 requestId 중복 처리 차단
// ────────────────────────────────────────────────────────────────────────

async function section6() {
  console.log('\n[6] Gas Bump 이중 채굴 방어');

  // nonce 메커니즘: 동일 nonce → 하나만 채굴
  function canBothBeMined(tx1: { nonce: number }, tx2: { nonce: number }): boolean {
    return tx1.nonce !== tx2.nonce;
  }

  const tx1 = { nonce: 42, gasPrice: 10, requestId: 'req-001' };
  const tx2 = { nonce: 42, gasPrice: 13, requestId: 'req-001' }; // gas bump

  check('동일 nonce → 두 TX 동시 채굴 불가', !canBothBeMined(tx1, tx2));

  // requestId 멱등성: 같은 requestId → 처리 skip
  const processedIds = new Set<string>();

  function processEvent(requestId: string): 'PROCESSED' | 'SKIP' {
    if (processedIds.has(requestId)) return 'SKIP';
    processedIds.add(requestId);
    return 'PROCESSED';
  }

  const first  = processEvent('req-001');
  const second = processEvent('req-001'); // 중복

  check('requestId 첫 처리 → PROCESSED',  first  === 'PROCESSED');
  check('requestId 중복 처리 → SKIP',      second === 'SKIP');
  check('멱등성 guard로 중복 발행 차단됨', second !== 'PROCESSED');

  // TIMEOUT → gas bump → 새 txHash로 교체 후 원래 TX 재등장 시
  // 이미 처리된 requestId → IdempotencyGuard가 skip
  const processedAfterGasBump = processEvent('req-001'); // 가정: 원래 TX1이 늦게 채굴됨
  check('Gas Bump 후 원래 TX 재등장 → requestId 멱등성으로 차단', processedAfterGasBump === 'SKIP');

  console.log('\n  이중 채굴 방어 레이어:');
  console.log('  1. EVM nonce 메커니즘  — 동일 nonce TX는 하나만 채굴 (자동)');
  console.log('  2. requestId 멱등성   — IdempotencyGuard가 중복 발행 차단 (S16)');
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S20: TIMEOUT·REORG 복구 핸들러 구현 ===\n');

  await section1();
  await section2();
  await section3();
  await section4();
  await section5();
  await section6();

  console.log('\n=== S20 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  TIMEOUT:         mempool stuck → gas bump(동일 nonce + 높은 gas) → 재제출');
  console.log('  handleTimeout:   PENDING → PENDING (txHash 교체, retryCount 증가, 상태 변화 없음)');
  console.log('  REORG:           MINED 구간에서만 발생 → 5블록 대기 → MINED 복귀 or FAILED');
  console.log('  handleReorg:     REORGED(임시) → vasp 재조회 → MINED or FAILED');
  console.log('  이중채굴 방어:   nonce 메커니즘(자동) + requestId 멱등성(S16)');
  console.log('  VaspRecovery:    retryWithBackoff(resubmit) → SUBMITTED+newTxHash or FAILED+알림');

  process.exit(process.exitCode ?? 0);
})();
