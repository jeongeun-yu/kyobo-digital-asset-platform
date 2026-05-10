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
// 공통 픽스처 — 완성 코드 제공 (수정 불필요)
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
// 헬퍼 — 완성 코드 제공 (수정 불필요)
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
// TODO [1-1]: calcBumpedGasPrice 함수를 완성하라
//   - GAS_BUMP_PERCENT = 30 기준으로 올린 gas price를 반환
//   - Math.ceil로 반올림 (정수 반환)
//   - 예: 10 gwei → 13 gwei
// ────────────────────────────────────────────────────────────────────────

export function calcBumpedGasPrice(originalGwei: number): number {
  const GAS_BUMP_PERCENT = 30;
  // TODO: 구현하세요
  // 힌트: Math.ceil(originalGwei * (1 + GAS_BUMP_PERCENT / 100))
  throw new Error('TODO: 구현하세요');
}

// TODO [1-2]: canBothBeMined 함수를 완성하라
//   - 두 TX의 nonce가 같으면 동시 채굴 불가 → false
//   - nonce가 다르면 각자 채굴 가능 → true
export function canBothBeMined(tx1: { nonce: number }, tx2: { nonce: number }): boolean {
  // TODO: 구현하세요
  // 힌트: tx1.nonce !== tx2.nonce
  throw new Error('TODO: 구현하세요');
}

// TODO [1-3]: isRetryable 함수를 완성하라
//   - REVERT  → false (컨트랙트 원인 해결 필요)
//   - TIMEOUT → true  (gas bump 후 재시도 가능)
//   - REORG   → true  (재제출 가능)
export function isRetryable(type: 'REVERT' | 'TIMEOUT' | 'REORG'): boolean {
  // TODO: 구현하세요
  throw new Error('TODO: 구현하세요');
}

// ────────────────────────────────────────────────────────────────────────
// 실습 2: handleTimeout — PENDING → PENDING + 새 txHash + retryCount 증가
//
// handleTimeout 처리 흐름:
//   1. repo.findById(requestId)
//   2. status !== 'PENDING' → 아무것도 하지 않고 return (가드)
//   3. vasp.resubmitWithGasBump(txHash, GAS_BUMP_PERCENT) → 새 txHash
//   4. repo.updateStatus: status 유지(PENDING), txHash 교체, retryCount + 1
//
// 상태가 PENDING → PENDING인 이유: 아직 블록에 포함되지 않았으므로
// ────────────────────────────────────────────────────────────────────────

async function section2() {
  console.log('\n[2] handleTimeout — PENDING → PENDING + gas bump');

  // TODO [2-1]: PENDING 상태에서 handleTimeout 호출 후 상태를 확인하라
  //
  // 힌트:
  //   const repo = new InMemoryTxRepository();
  //   const vasp = new MockVaspClient();
  //   const svc  = new TxStateMachineService(repo, vasp);
  //
  //   await repo.save({ ...PENDING_REQUEST, id: 'req-to-1' });
  //   await svc.handleTimeout('req-to-1');
  //   const req = await repo.findById('req-to-1');
  //
  //   확인할 것:
  //   - req?.status === 'PENDING'        (상태 유지)
  //   - req?.txHash !== '0xOLD_PENDING'  (txHash 교체)
  //   - req?.retryCount === 1            (retryCount 증가)
  {
    // TODO: 구현하세요
    throw new Error('TODO: section2 정상 케이스 구현하세요');
  }

  // TODO [2-2]: retryCount가 한도를 초과한 경우 FAILED 전이 or 예외 확인
  //
  // 힌트:
  //   vasp.setMaxRetryReached(true) → resubmitWithGasBump가 MaxRetryExceeded 예외 throw
  //   이 경우 TxStateMachineService가 FAILED로 전이하거나 예외를 그대로 전파한다
  {
    // TODO: 구현하세요
    throw new Error('TODO: section2 maxRetry 케이스 구현하세요');
  }

  // TODO [2-3]: PENDING이 아닌 상태(SUBMITTED)에서 handleTimeout → no-op 확인
  //
  // 힌트:
  //   await repo.save({ ...PENDING_REQUEST, id: 'req-to-3', status: 'SUBMITTED' });
  //   await svc.handleTimeout('req-to-3'); // 가드 — 아무것도 하지 않아야 함
  //   const req = await repo.findById('req-to-3');
  //   check('SUBMITTED 상태에서 handleTimeout → 상태 변경 없음', req?.status === 'SUBMITTED');
  {
    // TODO: 구현하세요
    throw new Error('TODO: section2 가드 케이스 구현하세요');
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 3: REORG 발생 조건 — MINED(INCLUDED) 구간에서만 가능
//
// REORG는 블록에 포함됐지만 finalized 되기 전(MINED 상태)에만 발생한다.
// CONFIRMED(finalized) 이후에는 REORG 발생 가능성이 극히 낮다.
//
// TODO [3-1]: reorgEligible 함수를 완성하라
//   - status === 'MINED' 일 때만 true
//   - 그 외 모든 상태는 false
// ────────────────────────────────────────────────────────────────────────

export function reorgEligible(status: MintRequest['status']): boolean {
  // TODO: 구현하세요
  // 힌트: status === 'MINED'
  throw new Error('TODO: 구현하세요');
}

// ────────────────────────────────────────────────────────────────────────
// 실습 4: handleReorg (TxStateMachineService) — 5블록 대기 후 복구
//
// handleReorg 처리 흐름:
//   1. status !== 'MINED' → no-op (가드)
//   2. REORGED 전이 (임시 상태)
//   3. _waitBlocks(5) — 체인 재편이 안정화될 때까지 대기
//   4. vasp.getStatus(txHash) 재조회
//      → 'mined':     MINED 복귀 (confirmation 카운트 재시작)
//      → 'not_found': FAILED 전이 + failReason에 'reorg' 포함
// ────────────────────────────────────────────────────────────────────────

async function section4() {
  console.log('\n[4] handleReorg — 5블록 대기 → MINED 복귀 or FAILED');

  // TODO [4-1]: 재편 후 TX가 새 체인에 포함됨 → MINED 복귀 확인
  //
  // 힌트:
  //   const repo = new InMemoryTxRepository();
  //   const vasp = new MockVaspClient();
  //   const svc  = new TxStateMachineService(repo, vasp);
  //   await repo.save({ ...MINED_REQUEST, id: 'req-rg-ok' });
  //   vasp.setNextStatus('0xMINED_HASH', 'mined', 12350); // 재포함됨
  //   await svc.handleReorg('req-rg-ok');
  //   const req = await repo.findById('req-rg-ok');
  //   check('REORG 후 TX 재포함 → status: MINED 복귀', req?.status === 'MINED');
  {
    // TODO: 구현하세요
    throw new Error('TODO: section4 MINED 복귀 케이스 구현하세요');
  }

  // TODO [4-2]: 재편 후 TX가 영구 소실 → FAILED 전이 확인
  //
  // 힌트:
  //   vasp.setNextStatus('0xLOST', 'not_found', 12351); // 영구 소실
  //   await svc.handleReorg('req-rg-fail');
  //   check('REORG 후 TX 영구 소실 → status: FAILED', req?.status === 'FAILED');
  //   check('failReason에 reorg 포함', req?.failReason?.includes('reorg') ?? false);
  {
    // TODO: 구현하세요
    throw new Error('TODO: section4 FAILED 전이 케이스 구현하세요');
  }

  // TODO [4-3]: MINED가 아닌 상태(CONFIRMED)에서 handleReorg → no-op 확인
  {
    // TODO: 구현하세요
    throw new Error('TODO: section4 가드 케이스 구현하세요');
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 5: VaspRecoveryService.handleReorg — retryWithBackoff + 재제출
//
// VaspRecoveryService.handleReorg는 TxStateMachineService.handleReorg와 다르다:
//   TxStateMachine: MINED → REORGED → MINED or FAILED (상태 추적)
//   VaspRecovery:   MINED 상태 → retryWithBackoff(vaspClient.resubmit)
//                   성공:    SUBMITTED + newTxHash   → action: 'RESUBMITTED'
//                   전패:    FAILED + 운영팀 알림   → action: 'FAILED'
//
// 잘못된 상태(FAILED, SUBMITTED 등)에서 호출 시 예외 발생:
//   'REORG only valid from MINED'
// ────────────────────────────────────────────────────────────────────────

async function section5() {
  console.log('\n[5] VaspRecoveryService.handleReorg — retryWithBackoff 재제출');

  // TODO [5-1]: resubmit 성공 → action: RESUBMITTED, status: SUBMITTED, txHash 교체 확인
  //
  // 힌트:
  //   const ledger   = new InMemoryLedger();
  //   const notifier = new MockNotifier();
  //   const vasp     = new MockVaspClient();
  //   const recovery = new VaspRecoveryService(ledger, vasp, notifier);
  //   await ledger.saveMintRequest({
  //     id: 'req-vrg-ok', userId: 'user-1', tokenId: 2001n, amount: 1n,
  //     status: 'SUBMITTED', txHash: '0xORIG', retryCount: 0,
  //     createdAt: new Date(), updatedAt: new Date(),
  //   });
  //   vasp.setResubmitResult('req-vrg-ok', { txHash: '0xNEW_TX' });
  //   const result = await recovery.handleReorg('req-vrg-ok', '0xORIG', 12345);
  //   const req = await ledger.getMintRequest('req-vrg-ok');
  //   확인: result.action === 'RESUBMITTED', req?.status === 'SUBMITTED', req?.txHash === '0xNEW_TX'
  {
    // TODO: 구현하세요
    throw new Error('TODO: section5 재제출 성공 케이스 구현하세요');
  }

  // TODO [5-2]: resubmit 전패 → action: FAILED, status: FAILED, REORG_RECOVERY_FAILED 알림 확인
  //
  // 힌트:
  //   vasp.setResubmitAlwaysFail(true)
  //   확인: result.action === 'FAILED', req?.status === 'FAILED'
  //         notifier.sentEvents에 type: 'REORG_RECOVERY_FAILED' 이벤트 존재
  {
    // TODO: 구현하세요
    throw new Error('TODO: section5 재제출 실패 케이스 구현하세요');
  }

  // TODO [5-3]: FAILED 상태에서 VaspRecovery.handleReorg → 예외 발생 확인
  {
    // TODO: 구현하세요
    throw new Error('TODO: section5 잘못된 상태 케이스 구현하세요');
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 6: Gas Bump 이중 채굴 방어 — requestId 멱등성
//
// Gas Bump 시나리오:
//   t=0:  TX1 제출 (nonce=42, gasPrice=10)
//   t=30: TIMEOUT 감지 → TX2 제출 (nonce=42, gasPrice=13)
//   t=35: TX2 채굴 → CONFIRMED 처리
//   t=40: TX1도 채굴? → No! 같은 nonce는 동시 채굴 불가 (EVM 보장)
//
// TODO [6-1]: processEvent 함수를 완성하라 (requestId 멱등성)
//   - processedIds에 이미 있는 requestId → 'SKIP' 반환
//   - 없는 requestId → processedIds에 추가 후 'PROCESSED' 반환
// ────────────────────────────────────────────────────────────────────────

export function makeIdempotencyGuard() {
  const processedIds = new Set<string>();

  return function processEvent(requestId: string): 'PROCESSED' | 'SKIP' {
    // TODO: 구현하세요
    // 힌트:
    //   if (processedIds.has(requestId)) return 'SKIP';
    //   processedIds.add(requestId);
    //   return 'PROCESSED';
    throw new Error('TODO: 구현하세요');
  };
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점 — 구현 후 주석 해제하여 실행
// ────────────────────────────────────────────────────────────────────────

/*
(async () => {
  console.log('=== S20: TIMEOUT·REORG 복구 핸들러 구현 ===\n');

  // [1] Gas Bump 검증
  console.log('[검증 1] Gas Bump 메커니즘');
  const bumped = calcBumpedGasPrice(10);
  check(`Gas Bump 30%: 10 gwei → ${bumped} gwei`, bumped >= 13);
  check('Bump 후 gas price > 원래보다 높음', bumped > 10);
  const tx1 = { nonce: 42, gasPrice: 10 };
  const tx2 = { nonce: 42, gasPrice: bumped };
  check('동일 nonce → 두 TX 동시 채굴 불가', !canBothBeMined(tx1, tx2));
  check('REVERT는 재시도 불가',  !isRetryable('REVERT'));
  check('TIMEOUT은 재시도 가능', isRetryable('TIMEOUT'));
  check('REORG는 재시도 가능',   isRetryable('REORG'));

  await section2();

  // [3] REORG 발생 조건 검증
  console.log('\n[검증 3] REORG 발생 조건');
  check('MINED → REORG 발생 가능',     reorgEligible('MINED'));
  check('PENDING → REORG 불가',        !reorgEligible('PENDING'));
  check('CONFIRMED → REORG 극히 드묾', !reorgEligible('CONFIRMED'));

  await section4();
  await section5();

  // [6] 멱등성 검증
  console.log('\n[검증 6] Gas Bump 이중 채굴 방어');
  const processEvent = makeIdempotencyGuard();
  check('requestId 첫 처리 → PROCESSED', processEvent('req-001') === 'PROCESSED');
  check('requestId 중복 처리 → SKIP',    processEvent('req-001') === 'SKIP');

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
*/
