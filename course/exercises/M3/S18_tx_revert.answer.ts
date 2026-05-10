/**
 * S18 실습 — TX REVERT 원인과 안전한 복구 설계
 *
 * 강의 노트: M3_S18_tx_revert.md
 *
 * 실행 방법 (루트에서): npm run exercise:s18
 *
 * 목표:
 *   [1] REVERT vs TIMEOUT vs REORG — 3종 장애 특성 시뮬레이션
 *   [2] handleTxRevert — SUBMITTED → FAILED 전이 + errorMsg 저장
 *   [3] REVERT reason별 분류 — paused / not minter / insufficient balance
 *   [4] 잘못된 상태에서 handleTxRevert 호출 → InvalidStateTransitionError
 *   [5] handleFailed 중복 호출 안전성 — FAILED는 최종 상태
 */

import type { MintRequest, RecoveryResult } from '@kyobo/vasp';
import {
  VaspRecoveryService,
  InMemoryLedger,
  MockVaspClient,
  MockNotifier,
  MintRequestNotFoundError,
  InvalidStateTransitionError,
  TxStateMachineService,
  InMemoryTxRepository,
} from '@kyobo/vasp';

// ────────────────────────────────────────────────────────────────────────
// 공통 픽스처
// ────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: MintRequest = {
  id:         'req-001',
  userId:     'user-1',
  tokenId:    1001n,
  amount:     1n,
  status:     'SUBMITTED',
  txHash:     '0xabc',
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

async function tryCheck(label: string, fn: () => Promise<boolean>) {
  try {
    const pass = await fn();
    check(label, pass);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ❌ ${label} — 예외 발생: ${msg}`);
    process.exitCode = 1;
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 1: REVERT vs TIMEOUT vs REORG — 3종 장애 특성 이해
//
// 세 가지는 모두 "TX가 정상 완료되지 않은" 상황이지만
// 원인과 복구 방법이 완전히 다르다.
//
// REVERT:  블록에 포함된 후 컨트랙트 조건 미충족 → 즉시 FAILED, 재시도 불가
// TIMEOUT: mempool 대기 중 gas price 낮음 → gas bump 후 재시도 가능
// REORG:   블록 채굴 후 체인 재편으로 TX 소실 → 재제출 가능
// ────────────────────────────────────────────────────────────────────────

async function section1() {
  console.log('[1] REVERT vs TIMEOUT vs REORG — 3종 장애 특성');

  // REVERT: receipt.status = 0, revertReason 포함, 재시도해도 동일 결과
  const revertReceipt = { status: 'reverted' as const, revertReason: 'Contract is paused' };
  check(
    'REVERT: receipt.status = reverted',
    revertReceipt.status === 'reverted',
  );
  check(
    'REVERT: revertReason 포함',
    typeof revertReceipt.revertReason === 'string' && revertReceipt.revertReason.length > 0,
  );

  // TIMEOUT: receipt 없음 (null), txHash는 존재
  const timeoutState = { receipt: null, txHash: '0xpending123', status: 'PENDING' };
  check(
    'TIMEOUT: receipt = null (아직 채굴 안 됨)',
    timeoutState.receipt === null,
  );
  check(
    'TIMEOUT: txHash 존재 (mempool에 있음)',
    timeoutState.txHash.length > 0,
  );

  // REORG: MINED(INCLUDED) 구간에서만 발생 — finalized 이전
  const reorgState = { status: 'MINED', blockNumber: 12345 };
  check(
    'REORG: MINED 구간에서 발생 가능 (CONFIRMED 이전)',
    reorgState.status === 'MINED',
  );

  // 핵심: REVERT는 재시도 ❌, TIMEOUT/REORG는 재시도 ✅
  const isRetryable = (errorType: 'REVERT' | 'TIMEOUT' | 'REORG') => {
    return errorType !== 'REVERT';
  };
  check('REVERT는 재시도 불가', !isRetryable('REVERT'));
  check('TIMEOUT은 재시도 가능', isRetryable('TIMEOUT'));
  check('REORG는 재시도 가능',   isRetryable('REORG'));
}

// ────────────────────────────────────────────────────────────────────────
// 실습 2: handleTxRevert — SUBMITTED → FAILED 전이 + errorMsg 저장
//
// handleTxRevert 흐름:
//   1. ledger.getMintRequest(requestId)
//   2. status !== 'SUBMITTED' → InvalidStateTransitionError
//   3. ledger.updateMintRequest → status: 'FAILED', txHash, errorMsg: reason
//   4. notifier.send({ type: 'TX_FAILED', requestId, txHash, reason })
// ────────────────────────────────────────────────────────────────────────

async function section2() {
  console.log('\n[2] handleTxRevert — SUBMITTED → FAILED 전이');

  // 시나리오 A: "Contract is paused" revert
  {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const vasp     = new MockVaspClient();
    const recovery = new VaspRecoveryService(ledger, vasp, notifier);

    await ledger.saveMintRequest({ ...BASE_REQUEST, id: 'req-paused', txHash: '0xabc' });

    const result: RecoveryResult = await recovery.handleTxRevert(
      'req-paused',
      '0xabc',
      'execution reverted: Contract is paused',
    );

    const req = await ledger.getMintRequest('req-paused');

    check('paused revert → status: FAILED',         req?.status === 'FAILED');
    check('paused revert → errorMsg에 "paused" 포함', req?.errorMsg?.includes('paused') ?? false);
    check('paused revert → action: FAILED 반환',    result.action === 'FAILED');
    check(
      'paused revert → notifier TX_FAILED 발송',
      notifier.sentEvents.some(e => e.type === 'TX_FAILED' && e.requestId === 'req-paused'),
    );
  }

  // 시나리오 B: "Caller is not minter" revert
  {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const vasp     = new MockVaspClient();
    const recovery = new VaspRecoveryService(ledger, vasp, notifier);

    await ledger.saveMintRequest({ ...BASE_REQUEST, id: 'req-minter', txHash: '0xdef' });

    await recovery.handleTxRevert(
      'req-minter',
      '0xdef',
      'execution reverted: Caller is not minter',
    );

    const req = await ledger.getMintRequest('req-minter');

    check('not minter revert → status: FAILED',              req?.status === 'FAILED');
    check('not minter revert → errorMsg에 "not minter" 포함', req?.errorMsg?.includes('not minter') ?? false);
  }

  // 시나리오 C: "Insufficient balance" revert
  {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const vasp     = new MockVaspClient();
    const recovery = new VaspRecoveryService(ledger, vasp, notifier);

    await ledger.saveMintRequest({ ...BASE_REQUEST, id: 'req-balance', txHash: '0xghi' });

    await recovery.handleTxRevert(
      'req-balance',
      '0xghi',
      'execution reverted: Insufficient balance',
    );

    const req = await ledger.getMintRequest('req-balance');

    check('insufficient balance revert → status: FAILED',   req?.status === 'FAILED');
    check('insufficient balance → notifier TX_FAILED 발송', notifier.sentEvents.some(
      e => e.type === 'TX_FAILED' && e.requestId === 'req-balance',
    ));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 3: REVERT reason 파싱 — detectRevert 시뮬레이션
//
// EVM에서 revert reason 추출 흐름:
//   1. getReceipt(txHash) → receipt.status === 'reverted'
//   2. provider.call(tx) 시뮬레이션 → Error.message에서 파싱
// ────────────────────────────────────────────────────────────────────────

async function section3() {
  console.log('\n[3] REVERT reason 파싱 — detectRevert 시뮬레이션');

  // reason 분류 함수 — 운영 대응 분기에 사용
  function classifyRevertReason(reason: string): {
    category: 'PAUSED' | 'ROLE' | 'BALANCE' | 'DUPLICATE' | 'GAS' | 'UNKNOWN';
    retryAfterFix: boolean;
    description: string;
  } {
    if (reason.includes('paused')) {
      return { category: 'PAUSED', retryAfterFix: true, description: '컨트랙트 일시정지 — Unpause 후 재발행' };
    }
    if (reason.includes('not minter') || reason.includes('MINTER_ROLE')) {
      return { category: 'ROLE', retryAfterFix: true, description: 'MINTER_ROLE 누락 — 역할 부여 후 재발행' };
    }
    if (reason.includes('Insufficient balance') || reason.includes('insufficient funds')) {
      return { category: 'BALANCE', retryAfterFix: true, description: '잔액 부족 — 충전 후 재발행' };
    }
    if (reason.includes('already exists') || reason.includes('Token already')) {
      return { category: 'DUPLICATE', retryAfterFix: false, description: '중복 tokenId — requestId 로그 확인 후 CONFIRMED 처리' };
    }
    if (reason.includes('gas limit') || reason.includes('Gas limit exceeded')) {
      return { category: 'GAS', retryAfterFix: true, description: 'gasLimit 초과 — gasLimit 조정 후 재발행' };
    }
    return { category: 'UNKNOWN', retryAfterFix: false, description: '알 수 없는 원인 — 운영팀 수동 분석 필요' };
  }

  const cases = [
    { reason: 'execution reverted: Contract is paused',        expected: 'PAUSED' },
    { reason: 'execution reverted: Caller is not minter',      expected: 'ROLE' },
    { reason: 'execution reverted: Insufficient balance',      expected: 'BALANCE' },
    { reason: 'execution reverted: Token already exists',      expected: 'DUPLICATE' },
    { reason: 'execution reverted: Gas limit exceeded',        expected: 'GAS' },
    { reason: 'execution reverted: unknown custom error',      expected: 'UNKNOWN' },
  ];

  for (const { reason, expected } of cases) {
    const result = classifyRevertReason(reason);
    check(
      `reason "${reason.slice(0, 45)}..." → ${expected}`,
      result.category === expected,
    );
  }

  // DUPLICATE는 재시도 불가 (이미 발행됨)
  const dupResult = classifyRevertReason('execution reverted: Token already exists');
  check('DUPLICATE → retryAfterFix: false (이미 발행됨, 재시도 의미 없음)', !dupResult.retryAfterFix);

  // 모든 REVERT는 공통적으로 자동 재시도 불가 — 운영팀 수동 승인 후 재발행
  check('PAUSED revert → retryAfterFix: true (수동 승인 후 재발행 가능)',
    classifyRevertReason('execution reverted: Contract is paused').retryAfterFix,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 실습 4: 잘못된 상태에서 handleTxRevert 호출 → InvalidStateTransitionError
//
// handleTxRevert는 status === 'SUBMITTED'인 경우에만 동작한다.
// CONFIRMED, FAILED, PENDING 상태에서 호출하면 예외가 발생해야 한다.
// ────────────────────────────────────────────────────────────────────────

async function section4() {
  console.log('\n[4] 잘못된 상태에서 handleTxRevert → InvalidStateTransitionError');

  const invalidStateCases: Array<{ status: MintRequest['status']; id: string }> = [
    { status: 'CONFIRMED', id: 'req-confirmed' },
    { status: 'FAILED',    id: 'req-failed'    },
    { status: 'PENDING',   id: 'req-pending'   },
  ];

  for (const { status, id } of invalidStateCases) {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const vasp     = new MockVaspClient();
    const recovery = new VaspRecoveryService(ledger, vasp, notifier);

    await ledger.saveMintRequest({ ...BASE_REQUEST, id, status, txHash: '0x999' });

    let threw = false;
    let isCorrectError = false;
    try {
      await recovery.handleTxRevert(id, '0x999', 'Contract is paused');
    } catch (e: unknown) {
      threw = true;
      isCorrectError = e instanceof InvalidStateTransitionError;
    }

    check(
      `status ${status}에서 handleTxRevert → 예외 발생`,
      threw,
    );
    check(
      `status ${status}에서 handleTxRevert → InvalidStateTransitionError`,
      isCorrectError,
    );
  }

  // 존재하지 않는 requestId → MintRequestNotFoundError
  {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const vasp     = new MockVaspClient();
    const recovery = new VaspRecoveryService(ledger, vasp, notifier);

    let threw = false;
    let isCorrectError = false;
    try {
      await recovery.handleTxRevert('nonexistent', '0x000', 'some reason');
    } catch (e: unknown) {
      threw = true;
      isCorrectError = e instanceof MintRequestNotFoundError;
    }

    check('존재하지 않는 requestId → 예외 발생',                threw);
    check('존재하지 않는 requestId → MintRequestNotFoundError', isCorrectError);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 5: handleFailed 중복 호출 안전성 — FAILED는 최종 상태
//
// TxStateMachineService.handleFailed()는 guard 없이 무조건 FAILED로 업데이트한다.
// FAILED는 언제나 최종 상태 — 중복 호출해도 안전하다.
// ────────────────────────────────────────────────────────────────────────

async function section5() {
  console.log('\n[5] handleFailed 중복 호출 — FAILED는 최종 상태, 중복 안전');

  const repo    = new InMemoryTxRepository();
  const vasp    = new MockVaspClient();
  const svc     = new TxStateMachineService(repo, vasp);

  await repo.save({ ...BASE_REQUEST, id: 'req-dup-fail', status: 'SUBMITTED' });

  // 첫 번째 FAILED 전이
  await svc.handleFailed('req-dup-fail', 'first failure reason');
  const after1 = await repo.findById('req-dup-fail');
  check('첫 번째 handleFailed → status: FAILED', after1?.status === 'FAILED');

  // 두 번째 호출 — 에러 없이 FAILED 유지
  let threw = false;
  try {
    await svc.handleFailed('req-dup-fail', 'second call');
  } catch {
    threw = true;
  }
  const after2 = await repo.findById('req-dup-fail');

  check('두 번째 handleFailed → 에러 없이 완료',  !threw);
  check('두 번째 handleFailed → FAILED 상태 유지', after2?.status === 'FAILED');

  // 세 번째 호출도 안전
  await svc.handleFailed('req-dup-fail', 'third call');
  const after3 = await repo.findById('req-dup-fail');
  check('세 번째 handleFailed → FAILED 상태 유지', after3?.status === 'FAILED');
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S18: TX REVERT 원인과 안전한 복구 설계 ===\n');

  await section1();
  await section2();
  await section3();
  await section4();
  await section5();

  console.log('\n=== S18 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  REVERT:          블록에 포함 후 컨트랙트 조건 미충족 → 즉시 FAILED, 재시도 불가');
  console.log('  TIMEOUT:         mempool 대기 중 gas 낮음 → gas bump 후 재시도 가능 (S20)');
  console.log('  REORG:           블록 재편으로 TX 소실 → 재제출 가능 (S20)');
  console.log('  handleTxRevert:  SUBMITTED → FAILED 전이 + errorMsg + notifier TX_FAILED');
  console.log('  handleFailed:    guard 없음 — FAILED는 최종 상태, 중복 호출 안전');
  console.log('  재발행:          REVERT 후 자동 재시도 금지 — 운영팀 원인 확인 후 수동 승인');

  process.exit(process.exitCode ?? 0);
})();
