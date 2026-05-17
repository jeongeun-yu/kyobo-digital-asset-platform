/**
 * S18 실습 — TX REVERT 원인과 안전한 복구 설계
 * 실행: npm run exercise:s18
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
  id:         'mint-550e8400-e29b-41d4-a716-446655440001',
  userId:     'user-7a3f2c91',
  tokenId:    2048n,
  amount:     1n,
  status:     'SUBMITTED',
  txHash:     '0xabcabc0000000000abcabc0000000000abcabc0000000000abcabc0000000000',
  retryCount: 0,
  createdAt:  new Date(),
  updatedAt:  new Date(),
};

// ── 실습 ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S18: TX REVERT 원인과 안전한 복구 설계 ===\n');

  // ── [1] handleTxRevert — SUBMITTED → FAILED 전이 ─────────────────────
  console.log('[1] handleTxRevert — SUBMITTED → FAILED 전이');

  // 시나리오 A: "Contract is paused"
  {
    console.log('\n  시나리오 A: execution reverted: Contract is paused');
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const recovery = new VaspRecoveryService(ledger, new MockVaspClient(), notifier);

    await ledger.saveMintRequest({ ...BASE_REQUEST, id: 'mint-550e8400-e29b-41d4-a716-446655440002', txHash: '0xabcabc0000000000abcabc0000000000abcabc0000000000abcabc0000000000' });

    const result: RecoveryResult = await recovery.handleTxRevert(
      'mint-550e8400-e29b-41d4-a716-446655440002',
      '0xabcabc0000000000abcabc0000000000abcabc0000000000abcabc0000000000',
      'execution reverted: Contract is paused',
    );

    const req = await ledger.getMintRequest('mint-550e8400-e29b-41d4-a716-446655440002');
    console.log('  result     :', result);
    console.log('  req        :', req);
    console.log('  events     :', notifier.sentEvents);
  }

  // 시나리오 B: "Caller is not minter"
  {
    console.log('\n  시나리오 B: execution reverted: Caller is not minter');
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const recovery = new VaspRecoveryService(ledger, new MockVaspClient(), notifier);

    await ledger.saveMintRequest({ ...BASE_REQUEST, id: 'mint-6ba7b810-9dad-11d1-80b4-00c04fd430c8', txHash: '0xdefdef0000000000defdef0000000000defdef0000000000defdef0000000000' });
    const result = await recovery.handleTxRevert(
      'mint-6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      '0xdefdef0000000000defdef0000000000defdef0000000000defdef0000000000',
      'execution reverted: Caller is not minter',
    );

    const req = await ledger.getMintRequest('mint-6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    console.log('  result     :', result);
    console.log('  req        :', req);
  }

  // 시나리오 C: "Insufficient balance"
  {
    console.log('\n  시나리오 C: execution reverted: Insufficient balance');
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const recovery = new VaspRecoveryService(ledger, new MockVaspClient(), notifier);

    await ledger.saveMintRequest({ ...BASE_REQUEST, id: 'mint-6ba7b811-9dad-11d1-80b4-00c04fd430c8', txHash: '0xba1a0ce00000000000000000000000000000000000000000000000000ba1a0ce' });
    const result = await recovery.handleTxRevert(
      'mint-6ba7b811-9dad-11d1-80b4-00c04fd430c8',
      '0xba1a0ce00000000000000000000000000000000000000000000000000ba1a0ce',
      'execution reverted: Insufficient balance',
    );

    const req = await ledger.getMintRequest('mint-6ba7b811-9dad-11d1-80b4-00c04fd430c8');
    console.log('  result     :', result);
    console.log('  req        :', req);
    console.log('  events     :', notifier.sentEvents);
  }

  // ── [2] 잘못된 상태에서 handleTxRevert → InvalidStateTransitionError ──
  console.log('\n[2] 잘못된 상태에서 handleTxRevert → InvalidStateTransitionError');

  const invalidStateCases: Array<{ status: MintRequest['status']; id: string }> = [
    { status: 'CONFIRMED', id: 'mint-6ba7b812-9dad-11d1-80b4-00c04fd430c8' },
    { status: 'FAILED',    id: 'mint-6ba7b813-9dad-11d1-80b4-00c04fd430c8' },
    { status: 'PENDING',   id: 'mint-6ba7b814-9dad-11d1-80b4-00c04fd430c8' },
  ];

  for (const { status, id } of invalidStateCases) {
    const ledger   = new InMemoryLedger();
    const recovery = new VaspRecoveryService(ledger, new MockVaspClient(), new MockNotifier());

    await ledger.saveMintRequest({ ...BASE_REQUEST, id, status, txHash: '0x9999000000000000000000000000000000000000000000000000000000009999' });

    try {
      await recovery.handleTxRevert(id, '0x9999000000000000000000000000000000000000000000000000000000009999', 'Contract is paused');
    } catch (e: unknown) {
      console.log(`  status ${status} → 에러:`, (e as Error).constructor.name, (e as Error).message);
    }
  }

  // 존재하지 않는 requestId
  {
    const recovery = new VaspRecoveryService(new InMemoryLedger(), new MockVaspClient(), new MockNotifier());
    try {
      await recovery.handleTxRevert('mint-ffffffff-ffff-ffff-ffff-ffffffffffff', '0x000', 'some reason');
    } catch (e: unknown) {
      console.log('  없는 requestId → 에러:', (e as Error).constructor.name);
    }
  }

  // ── [3] handleFailed 중복 호출 — FAILED는 최종 상태 ──────────────────
  console.log('\n[3] handleFailed 중복 호출 — FAILED는 최종 상태');
  {
    const repo = new InMemoryTxRepository();
    const svc  = new TxStateMachineService(repo, new MockVaspClient(), new MockWalletResolver());

    await repo.save({ ...BASE_REQUEST, id: 'mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8', status: 'SUBMITTED' });

    await svc.handleFailed('mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8', 'first failure reason');
    const after1 = await repo.findById('mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8');
    console.log('  after1     :', after1);

    await svc.handleFailed('mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8', 'second call');
    const after2 = await repo.findById('mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8');
    console.log('  after2     :', after2);

    await svc.handleFailed('mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8', 'third call');
    const after3 = await repo.findById('mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8');
    console.log('  after3     :', after3);
  }

  console.log('\nS18 완료');
})();
