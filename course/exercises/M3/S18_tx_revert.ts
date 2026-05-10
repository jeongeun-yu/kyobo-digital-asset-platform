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
// 공통 픽스처 — 완성 코드 제공 (수정 불필요)
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
// 헬퍼 — 완성 코드 제공 (수정 불필요)
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 1: REVERT vs TIMEOUT vs REORG — 3종 장애 특성 이해
//
// 세 가지 장애 유형의 차이를 이해한다:
//
//   REVERT:  블록에 포함된 후 컨트랙트 조건 미충족
//            → 즉시 FAILED, 재시도해도 동일 결과 (원인을 고쳐야 함)
//
//   TIMEOUT: mempool 대기 중 gas price가 너무 낮아 채굴자가 선택하지 않음
//            → gas bump 후 재제출 가능 (조건은 정상, 외부 요인만 문제)
//
//   REORG:   블록 채굴 후 체인 재편(chain reorganization)으로 TX 소실
//            → 재제출 가능 (MINED 구간에서만 발생)
//
// TODO [1-1]: isRetryable 함수를 완성하라
//   - REVERT  → false (재시도 불가 — 컨트랙트 원인 해결 필요)
//   - TIMEOUT → true  (gas bump 후 재시도 가능)
//   - REORG   → true  (재제출 가능)
// ────────────────────────────────────────────────────────────────────────

export function isRetryable(errorType: 'REVERT' | 'TIMEOUT' | 'REORG'): boolean {
  // TODO: 구현하세요
  // 힌트: REVERT만 재시도 불가, 나머지는 재시도 가능
  throw new Error('TODO: 구현하세요');
}

// ────────────────────────────────────────────────────────────────────────
// 실습 2 & 4: handleTxRevert 사용 — VaspRecoveryService 위임
//
// VaspRecoveryService.handleTxRevert(requestId, txHash, reason) 흐름:
//   1. ledger.getMintRequest(requestId) → 없으면 MintRequestNotFoundError
//   2. status !== 'SUBMITTED' → InvalidStateTransitionError
//   3. ledger.updateMintRequest → status: 'FAILED', txHash, errorMsg: reason
//   4. notifier.send({ type: 'TX_FAILED', requestId, txHash, reason })
//   5. return { action: 'FAILED' }
//
// 아래 섹션 함수들은 VaspRecoveryService를 올바르게 사용하는 방법을 직접
// 실행해보며 확인한다. 구현은 @kyobo/vasp 패키지 내부에 있음.
// ────────────────────────────────────────────────────────────────────────

async function section2() {
  console.log('\n[2] handleTxRevert — SUBMITTED → FAILED 전이');

  // TODO [2-1]: "Contract is paused" revert 시나리오를 완성하라
  //
  // 힌트:
  //   const ledger   = new InMemoryLedger();
  //   const notifier = new MockNotifier();
  //   const vasp     = new MockVaspClient();
  //   const recovery = new VaspRecoveryService(ledger, vasp, notifier);
  //
  //   await ledger.saveMintRequest({ ...BASE_REQUEST, id: 'req-paused', txHash: '0xabc' });
  //   const result = await recovery.handleTxRevert('req-paused', '0xabc', 'execution reverted: Contract is paused');
  //   const req = await ledger.getMintRequest('req-paused');
  //
  //   확인할 것:
  //   - req?.status === 'FAILED'
  //   - req?.errorMsg에 'paused' 포함
  //   - result.action === 'FAILED'
  //   - notifier.sentEvents에 type: 'TX_FAILED', requestId: 'req-paused' 이벤트 존재
  {
    // TODO: 위 힌트를 참고하여 구현하세요
    throw new Error('TODO: section2 시나리오 A 구현하세요');
  }

  // TODO [2-2]: "Caller is not minter" revert 시나리오
  //   - errorMsg에 'not minter' 포함 여부 확인
  {
    // TODO: 구현하세요
    throw new Error('TODO: section2 시나리오 B 구현하세요');
  }

  // TODO [2-3]: "Insufficient balance" revert 시나리오
  //   - notifier TX_FAILED 발송 확인
  {
    // TODO: 구현하세요
    throw new Error('TODO: section2 시나리오 C 구현하세요');
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 3: REVERT reason 파싱 — classifyRevertReason 구현
//
// EVM에서 revert 발생 시 reason 문자열로 원인을 파악한다.
// 운영팀이 어떤 조치를 취할지 분류하는 함수가 필요하다.
//
// TODO [3-1]: classifyRevertReason 함수를 완성하라
//
// 분류 기준:
//   reason에 'paused'        포함 → PAUSED   (retryAfterFix: true)
//   reason에 'not minter'    포함 → ROLE     (retryAfterFix: true)
//   reason에 'MINTER_ROLE'   포함 → ROLE     (retryAfterFix: true)
//   reason에 'Insufficient balance' 포함 → BALANCE  (retryAfterFix: true)
//   reason에 'insufficient funds'   포함 → BALANCE  (retryAfterFix: true)
//   reason에 'already exists' 포함 → DUPLICATE (retryAfterFix: false)
//   reason에 'Token already'  포함 → DUPLICATE (retryAfterFix: false)
//   reason에 'gas limit'      포함 → GAS      (retryAfterFix: true)
//   reason에 'Gas limit exceeded' 포함 → GAS  (retryAfterFix: true)
//   그 외                          → UNKNOWN  (retryAfterFix: false)
// ────────────────────────────────────────────────────────────────────────

export function classifyRevertReason(reason: string): {
  category: 'PAUSED' | 'ROLE' | 'BALANCE' | 'DUPLICATE' | 'GAS' | 'UNKNOWN';
  retryAfterFix: boolean;
  description: string;
} {
  // TODO: 구현하세요
  // 힌트: reason.includes('...') 로 각 케이스를 분기한다
  throw new Error('TODO: 구현하세요');
}

// ────────────────────────────────────────────────────────────────────────
// 실습 4: 잘못된 상태에서 handleTxRevert 호출 → 예외 발생 확인
//
// TODO [4-1]: 아래 invalidStateCases 각각에 대해 예외가 발생하는지 확인하라
//
// handleTxRevert는 status === 'SUBMITTED'인 경우에만 동작한다.
// CONFIRMED, FAILED, PENDING 상태에서 호출 시 InvalidStateTransitionError가 발생한다.
// ────────────────────────────────────────────────────────────────────────

async function section4() {
  console.log('\n[4] 잘못된 상태에서 handleTxRevert → InvalidStateTransitionError');

  const invalidStateCases: Array<{ status: MintRequest['status']; id: string }> = [
    { status: 'CONFIRMED', id: 'req-confirmed' },
    { status: 'FAILED',    id: 'req-failed'    },
    { status: 'PENDING',   id: 'req-pending'   },
  ];

  for (const { status, id } of invalidStateCases) {
    // TODO: 각 케이스에 대해 InMemoryLedger + VaspRecoveryService를 생성하고
    //       잘못된 상태의 MintRequest를 저장한 후 handleTxRevert를 호출하라
    //
    // 힌트:
    //   const ledger   = new InMemoryLedger();
    //   const notifier = new MockNotifier();
    //   const vasp     = new MockVaspClient();
    //   const recovery = new VaspRecoveryService(ledger, vasp, notifier);
    //   await ledger.saveMintRequest({ ...BASE_REQUEST, id, status, txHash: '0x999' });
    //
    //   try { await recovery.handleTxRevert(id, '0x999', 'Contract is paused'); }
    //   catch (e) { /* e instanceof InvalidStateTransitionError 확인 */ }
    throw new Error(`TODO: ${status} 상태 케이스 구현하세요`);
  }

  // TODO [4-2]: 존재하지 않는 requestId → MintRequestNotFoundError 확인
  {
    // TODO: 구현하세요
    throw new Error('TODO: 존재하지 않는 requestId 케이스 구현하세요');
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 5: handleFailed 중복 호출 안전성 — FAILED는 최종 상태
//
// TxStateMachineService.handleFailed()는 guard 없이 무조건 FAILED로 업데이트한다.
// FAILED는 언제나 최종 상태 — 중복 호출해도 안전해야 한다.
//
// TODO [5-1]: 아래 시나리오를 완성하라
//
// 흐름:
//   1. repo에 SUBMITTED 상태 MintRequest 저장
//   2. 첫 번째 handleFailed 호출 → status: FAILED 확인
//   3. 두 번째 handleFailed 호출 → 예외 없이 완료 + FAILED 유지
//   4. 세 번째 handleFailed 호출도 안전
// ────────────────────────────────────────────────────────────────────────

async function section5() {
  console.log('\n[5] handleFailed 중복 호출 — FAILED는 최종 상태, 중복 안전');

  // TODO: InMemoryTxRepository + MockVaspClient + TxStateMachineService 생성
  //       BASE_REQUEST를 저장하고 handleFailed를 3회 호출하며 상태를 확인하라
  //
  // 힌트:
  //   const repo = new InMemoryTxRepository();
  //   const vasp = new MockVaspClient();
  //   const svc  = new TxStateMachineService(repo, vasp);
  //
  //   await repo.save({ ...BASE_REQUEST, id: 'req-dup-fail', status: 'SUBMITTED' });
  //   await svc.handleFailed('req-dup-fail', 'first failure reason');
  //   // → status === 'FAILED' 확인
  //   await svc.handleFailed('req-dup-fail', 'second call');
  //   // → 예외 없음 + status === 'FAILED' 확인
  throw new Error('TODO: 구현하세요');
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점 — 구현 후 주석 해제하여 실행
// ────────────────────────────────────────────────────────────────────────

/*
(async () => {
  console.log('=== S18: TX REVERT 원인과 안전한 복구 설계 ===\n');

  // [1] isRetryable 검증
  console.log('[검증 1] isRetryable');
  check('REVERT는 재시도 불가', !isRetryable('REVERT'));
  check('TIMEOUT은 재시도 가능', isRetryable('TIMEOUT'));
  check('REORG는 재시도 가능',   isRetryable('REORG'));

  await section2();

  // [3] classifyRevertReason 검증
  console.log('\n[검증 3] classifyRevertReason');
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
    check(`"${reason.slice(22, 45)}..." → ${expected}`, result.category === expected);
  }

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
*/
