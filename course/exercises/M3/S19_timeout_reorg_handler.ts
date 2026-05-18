/**
 * S19 실습 — TIMEOUT·REORG 복구 핸들러
 * 실행: npm run exercise:s19
 */

import type { MintRequest } from '@kyobo/vasp';
import {
  TxStateMachineService,
  VaspRecoveryService,
  InMemoryTxRepository,
  InMemoryLedger,
  MockVaspClient,
  MockNotifier,
  MockWalletResolver,
} from '@kyobo/vasp';

// ── 로컬 Mock 확장 ────────────────────────────────────────────────────────────

class ControllableVaspClient extends MockVaspClient {
  private statusOverrides = new Map<string, string>();
  private resubmitFail    = false;

  setNextStatus(txHash: string, status: string) { this.statusOverrides.set(txHash, status); }
  setResubmitAlwaysFail(v: boolean)             { this.resubmitFail = v; }

  async getStatus(txHash: string) {
    const s = this.statusOverrides.get(txHash) ?? 'pending';
    return { status: s as any };
  }

  async resubmit(_requestId: string): Promise<{ txHash: string }> {
    if (this.resubmitFail) throw new Error('VASP resubmit failed');
    const t = Date.now().toString(16);
    return { txHash: `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}` };
  }
}

// ── 공통 픽스처 ───────────────────────────────────────────────────────────────

const PENDING_REQUEST: MintRequest = {
  id:         'mint-550e8400-e29b-41d4-a716-446655440001',
  userId:     'user-7a3f2c91',
  tokenId:    3000n,
  amount:     1n,
  status:     'PENDING',
  txHash:     '0x01d00000000000000000000000000000000000000000000000000000000001d0',
  retryCount: 0,
  createdAt:  new Date(),
  updatedAt:  new Date(),
};

const MINED_REQUEST: MintRequest = {
  id:         'mint-6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  userId:     'user-b2d4f891',
  tokenId:    4096n,
  amount:     1n,
  status:     'MINED',
  txHash:     '0xaaaa1111bbbb2222cccc3333dddd4444aaaa1111bbbb2222cccc3333dddd4444',
  retryCount: 0,
  createdAt:  new Date(),
  updatedAt:  new Date(),
};

// ── [1] Gas Bump 메커니즘 ─────────────────────────────────────────────────────

async function section1() {
  console.log('[1] Gas Bump 메커니즘');

  const GAS_BUMP_PERCENT = 20;
  const original = 10;
  const bumped   = Math.ceil(original * (1 + GAS_BUMP_PERCENT / 100));

  console.log('  original   :', original, 'gwei');
  console.log('  bumped     :', bumped, 'gwei (+20%)');

  const tx1 = { nonce: 42, gasPrice: original };
  const tx2 = { nonce: 42, gasPrice: bumped };
  console.log('  tx1        :', tx1);
  console.log('  tx2 (bump) :', tx2, '← 동일 nonce, 채굴자는 높은 gas 선택');
}

// ── [2] handleTimeout — PENDING → PENDING + gas bump ─────────────────────────

async function section2() {
  console.log('\n[2] handleTimeout — PENDING → PENDING + gas bump');

  // 정상 케이스
  {
    const repo = new InMemoryTxRepository();
    const svc  = new TxStateMachineService(repo, new MockVaspClient(), new MockWalletResolver());

    await repo.save({ ...PENDING_REQUEST, id: 'mint-6ba7b811-9dad-11d1-80b4-00c04fd430c8' });
    await svc.handleTimeout('mint-6ba7b811-9dad-11d1-80b4-00c04fd430c8');

    const req = await repo.findById('mint-6ba7b811-9dad-11d1-80b4-00c04fd430c8');
    console.log('  req        :', req);
  }

  // 가드: SUBMITTED에서 handleTimeout → no-op
  {
    const repo = new InMemoryTxRepository();
    const svc  = new TxStateMachineService(repo, new MockVaspClient(), new MockWalletResolver());

    await repo.save({ ...PENDING_REQUEST, id: 'mint-6ba7b812-9dad-11d1-80b4-00c04fd430c8', status: 'SUBMITTED' });
    await svc.handleTimeout('mint-6ba7b812-9dad-11d1-80b4-00c04fd430c8');

    const req = await repo.findById('mint-6ba7b812-9dad-11d1-80b4-00c04fd430c8');
    console.log('  req (가드) :', req);
  }
}

// ── [3] REORG 발생 조건 ───────────────────────────────────────────────────────

async function section3() {
  console.log('\n[3] REORG 발생 조건 — MINED 구간에서만');

  const statuses: MintRequest['status'][] = ['REQUESTED', 'SUBMITTED', 'PENDING', 'MINED', 'CONFIRMED', 'FINALIZED', 'FAILED'];
  for (const s of statuses) {
    console.log(`  ${s.padEnd(12)} reorgEligible: ${s === 'MINED'}`);
  }
}

// ── [4] handleReorg — REORGED 전이 → 5블록 대기 → MINED or FAILED ────────────

async function section4() {
  console.log('\n[4] handleReorg — 5블록 대기 → MINED 복귀 or FAILED');

  // 시나리오 A: 재편 후 TX 재포함 → MINED 복귀
  {
    const repo = new InMemoryTxRepository();
    const vasp = new ControllableVaspClient();
    const svc  = new TxStateMachineService(repo, vasp, new MockWalletResolver());

    await repo.save({ ...MINED_REQUEST, id: 'mint-6ba7b813-9dad-11d1-80b4-00c04fd430c8' });
    vasp.setNextStatus('0xaaaa1111bbbb2222cccc3333dddd4444aaaa1111bbbb2222cccc3333dddd4444', 'mined');
    (svc as any)._waitBlocks = async () => {};

    await svc.handleReorg('mint-6ba7b813-9dad-11d1-80b4-00c04fd430c8');

    const req = await repo.findById('mint-6ba7b813-9dad-11d1-80b4-00c04fd430c8');
    console.log('  재포함 req :', req);
  }

  // 시나리오 B: 영구 소실 → FAILED
  {
    const repo = new InMemoryTxRepository();
    const vasp = new ControllableVaspClient();
    const svc  = new TxStateMachineService(repo, vasp, new MockWalletResolver());

    await repo.save({ ...MINED_REQUEST, id: 'mint-6ba7b814-9dad-11d1-80b4-00c04fd430c8', txHash: '0x1057000000000000000000000000000000000000000000000000000000001057' });
    vasp.setNextStatus('0x1057000000000000000000000000000000000000000000000000000000001057', 'not_found');
    (svc as any)._waitBlocks = async () => {};

    await svc.handleReorg('mint-6ba7b814-9dad-11d1-80b4-00c04fd430c8');

    const req = await repo.findById('mint-6ba7b814-9dad-11d1-80b4-00c04fd430c8');
    console.log('  소실 req   :', req);
  }

  // 가드: CONFIRMED에서 handleReorg → no-op
  {
    const repo = new InMemoryTxRepository();
    const svc  = new TxStateMachineService(repo, new ControllableVaspClient(), new MockWalletResolver());

    await repo.save({ ...MINED_REQUEST, id: 'mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8', status: 'CONFIRMED' });
    (svc as any)._waitBlocks = async () => {};
    await svc.handleReorg('mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8');

    const req = await repo.findById('mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8');
    console.log('  가드 req   :', req);
  }
}

// ── [5] VaspRecoveryService.handleReorg ──────────────────────────────────────

async function section5() {
  console.log('\n[5] VaspRecoveryService.handleReorg — retryWithBackoff 재제출');

  // 시나리오 A: resubmit 성공
  {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const vasp     = new ControllableVaspClient();
    const recovery = new VaspRecoveryService(ledger, vasp, notifier);

    await ledger.saveMintRequest({
      id: 'mint-6ba7b816-9dad-11d1-80b4-00c04fd430c8', userId: 'user-c3e5a012', tokenId: 5000n, amount: 1n,
      status: 'MINED', txHash: '0x000000000000000000000000000000000000000000000000000000004190419a',
      retryCount: 0, createdAt: new Date(), updatedAt: new Date(),
    });

    const result = await recovery.handleReorg('mint-6ba7b816-9dad-11d1-80b4-00c04fd430c8', '0x000000000000000000000000000000000000000000000000000000004190419a', 18500200);
    const req    = await ledger.getMintRequest('mint-6ba7b816-9dad-11d1-80b4-00c04fd430c8');

    console.log('  result (성공):', result);
    console.log('  req (성공)   :', req);
  }

  // 시나리오 B: resubmit 실패 → FAILED
  {
    const ledger   = new InMemoryLedger();
    const notifier = new MockNotifier();
    const vasp     = new ControllableVaspClient();
    vasp.setResubmitAlwaysFail(true);
    const recovery = new VaspRecoveryService(ledger, vasp, notifier);

    await ledger.saveMintRequest({
      id: 'mint-6ba7b817-9dad-11d1-80b4-00c04fd430c8', userId: 'user-d4f6b134', tokenId: 6144n, amount: 1n,
      status: 'MINED', txHash: '0xfa110000000000000000000000000000000000000000000000000000000fa110',
      retryCount: 0, createdAt: new Date(), updatedAt: new Date(),
    });

    const result = await recovery.handleReorg('mint-6ba7b817-9dad-11d1-80b4-00c04fd430c8', '0xfa110000000000000000000000000000000000000000000000000000000fa110', 18500201);
    const req    = await ledger.getMintRequest('mint-6ba7b817-9dad-11d1-80b4-00c04fd430c8');

    console.log('  result (실패):', result);
    console.log('  req (실패)   :', req);
    console.log('  events       :', notifier.sentEvents);
  }
}

// ── [6] Gas Bump 이중 채굴 방어 ──────────────────────────────────────────────

async function section6() {
  console.log('\n[6] Gas Bump 이중 채굴 방어 — nonce + requestId 멱등성');

  const tx1 = { nonce: 42, gasPrice: 10, requestId: 'mint-550e8400-e29b-41d4-a716-446655440001' };
  const tx2 = { nonce: 42, gasPrice: 12, requestId: 'mint-550e8400-e29b-41d4-a716-446655440001' };
  console.log('  tx1        :', tx1);
  console.log('  tx2 (bump) :', tx2);
  console.log('  동일 nonce 동시 채굴 가능?', tx1.nonce !== tx2.nonce);

  const processedIds = new Set<string>();
  const process = (id: string) => processedIds.has(id) ? 'SKIP' : (processedIds.add(id), 'PROCESSED');

  console.log('  1차 처리   :', process('mint-550e8400-e29b-41d4-a716-446655440001'));
  console.log('  2차 처리   :', process('mint-550e8400-e29b-41d4-a716-446655440001'), '← 멱등성');
  console.log('  3차 처리   :', process('mint-550e8400-e29b-41d4-a716-446655440001'), '← 멱등성');
}

// ── 진입점 ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S19: TIMEOUT·REORG 복구 핸들러 ===\n');

  await section1();
  await section2();
  await section3();
  await section4();
  await section5();
  await section6();

  console.log('\nS19 완료');
})();
