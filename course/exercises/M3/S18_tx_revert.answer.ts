/**
 * S18 정답 — TX REVERT 원인과 안전한 복구 설계
 *
 * 목표:
 *   [1] handleTxRevert — SUBMITTED → FAILED 전이 + errorMsg 저장
 *   [2] 잘못된 상태에서 handleTxRevert → InvalidStateTransitionError
 *   [3] handleFailed 중복 호출 안전성 — FAILED는 최종 상태
 */

import type { MintRequest, RecoveryResult } from '@kyobo/vasp';
import {
  VaspRecoveryService,
  InMemoryLedger,
  MockVaspClient,
  MockNotifier,
  MockWalletResolver,
  MintRequestNotFoundError,
  InvalidStateTransitionError,
  TxStateMachineService,
  InMemoryTxRepository,
} from '@kyobo/vasp';

// ── 공통 픽스처 ───────────────────────────────────────────────────────────────

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

// ── assert ────────────────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✅ ${msg}`);
}

// ── [1] handleTxRevert — SUBMITTED → FAILED 전이 ─────────────────────────────

(async () => {
  console.log('[1] handleTxRevert — SUBMITTED → FAILED 전이\n');

  // 시나리오 A: "Contract is paused"
  {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const recovery = new VaspRecoveryService(ledger, new MockVaspClient(), notifier);

    await ledger.saveMintRequest({ ...BASE_REQUEST, id: 'req-paused', txHash: '0xabc' });

    const result: RecoveryResult = await recovery.handleTxRevert(
      'req-paused', '0xabc', 'execution reverted: Contract is paused',
    );

    const req = await ledger.getMintRequest('req-paused');
    assert(req?.status === 'FAILED',                                           'paused revert → status: FAILED');
    assert(req?.errorMsg?.includes('paused') ?? false,                         'paused revert → errorMsg에 "paused" 포함');
    assert(result.action === 'FAILED',                                         'paused revert → action: FAILED 반환');
    assert(
      notifier.sentEvents.some(e => e.type === 'TX_FAILED' && e.requestId === 'req-paused'),
      'paused revert → notifier TX_FAILED 발송',
    );
  }

  // 시나리오 B: "Caller is not minter"
  {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const recovery = new VaspRecoveryService(ledger, new MockVaspClient(), notifier);

    await ledger.saveMintRequest({ ...BASE_REQUEST, id: 'req-minter', txHash: '0xdef' });
    await recovery.handleTxRevert('req-minter', '0xdef', 'execution reverted: Caller is not minter');

    const req = await ledger.getMintRequest('req-minter');
    assert(req?.status === 'FAILED',                            'not minter → status: FAILED');
    assert(req?.errorMsg?.includes('not minter') ?? false,      'not minter → errorMsg에 "not minter" 포함');
  }

  // 시나리오 C: "Insufficient balance"
  {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const recovery = new VaspRecoveryService(ledger, new MockVaspClient(), notifier);

    await ledger.saveMintRequest({ ...BASE_REQUEST, id: 'req-balance', txHash: '0xghi' });
    await recovery.handleTxRevert('req-balance', '0xghi', 'execution reverted: Insufficient balance');

    const req = await ledger.getMintRequest('req-balance');
    assert(req?.status === 'FAILED',                                             'insufficient balance → status: FAILED');
    assert(
      notifier.sentEvents.some(e => e.type === 'TX_FAILED' && e.requestId === 'req-balance'),
      'insufficient balance → notifier TX_FAILED 발송',
    );
  }

  // ── [2] 잘못된 상태에서 handleTxRevert → InvalidStateTransitionError ──────────

  console.log('\n[2] 잘못된 상태에서 handleTxRevert → InvalidStateTransitionError\n');

  const invalidStateCases: Array<{ status: MintRequest['status']; id: string }> = [
    { status: 'CONFIRMED', id: 'req-confirmed' },
    { status: 'FAILED',    id: 'req-failed'    },
    { status: 'PENDING',   id: 'req-pending'   },
  ];

  for (const { status, id } of invalidStateCases) {
    const ledger   = new InMemoryLedger();
    const recovery = new VaspRecoveryService(ledger, new MockVaspClient(), new MockNotifier());

    await ledger.saveMintRequest({ ...BASE_REQUEST, id, status, txHash: '0x999' });

    let threw = false;
    let isCorrectError = false;
    try {
      await recovery.handleTxRevert(id, '0x999', 'Contract is paused');
    } catch (e: unknown) {
      threw = true;
      isCorrectError = e instanceof InvalidStateTransitionError;
    }

    assert(threw,          `status ${status}에서 handleTxRevert → 예외 발생`);
    assert(isCorrectError, `status ${status}에서 handleTxRevert → InvalidStateTransitionError`);
  }

  // 존재하지 않는 requestId → MintRequestNotFoundError
  {
    const recovery = new VaspRecoveryService(new InMemoryLedger(), new MockVaspClient(), new MockNotifier());

    let threw = false;
    let isCorrectError = false;
    try {
      await recovery.handleTxRevert('nonexistent', '0x000', 'some reason');
    } catch (e: unknown) {
      threw = true;
      isCorrectError = e instanceof MintRequestNotFoundError;
    }

    assert(threw,          '존재하지 않는 requestId → 예외 발생');
    assert(isCorrectError, '존재하지 않는 requestId → MintRequestNotFoundError');
  }

  // ── [3] handleFailed 중복 호출 — FAILED는 최종 상태 ──────────────────────────

  console.log('\n[3] handleFailed 중복 호출 — FAILED는 최종 상태\n');

  {
    const repo = new InMemoryTxRepository();
    const svc  = new TxStateMachineService(repo, new MockVaspClient(), new MockWalletResolver());

    await repo.save({ ...BASE_REQUEST, id: 'req-dup-fail', status: 'SUBMITTED' });

    await svc.handleFailed('req-dup-fail', 'first failure reason');
    const after1 = await repo.findById('req-dup-fail');
    assert(after1?.status === 'FAILED', '첫 번째 handleFailed → status: FAILED');

    let threw = false;
    try {
      await svc.handleFailed('req-dup-fail', 'second call');
    } catch {
      threw = true;
    }
    const after2 = await repo.findById('req-dup-fail');
    assert(!threw,                       '두 번째 handleFailed → 에러 없이 완료');
    assert(after2?.status === 'FAILED',  '두 번째 handleFailed → FAILED 상태 유지');

    await svc.handleFailed('req-dup-fail', 'third call');
    const after3 = await repo.findById('req-dup-fail');
    assert(after3?.status === 'FAILED',  '세 번째 handleFailed → FAILED 상태 유지');
  }

  console.log('\n=== S18 완료 ===');
})();
