/**
 * S13 실습 답안 — TX 상태머신
 * 실행: npm run exercise:s13:answer
 */

import { TxStateMachineService, MintRequestNotFoundError, InvalidStatusTransitionError } from '@kyobo/vasp';
import type { TxStatus, MintRequest, TxRepository, VaspTxClient, WalletResolver, TxTransitionEvent } from '@kyobo/vasp';

// ── Mock 구현체 ────────────────────────────────────────────────────────────

class InMemoryRepo implements TxRepository {
  store = new Map<string, MintRequest>();
  async save(req: MintRequest)   { this.store.set(req.id, { ...req }); }
  async findById(id: string)     { return this.store.get(id) ?? null; }
  async updateStatus(id: string, status: TxStatus, extra?: Partial<MintRequest>) {
    const r = this.store.get(id);
    if (r) this.store.set(id, { ...r, ...extra, status, updatedAt: new Date() });
  }
  async findPendingOlderThan(_m: number) { return []; }
}

class MockVasp implements VaspTxClient {
  reorgedStatus: 'mined' | 'not_found' = 'mined';
  async submitMint(p: any)                           { const raw = Buffer.from(p.requestId).toString('hex'); return { txHash: `0x${raw.repeat(Math.ceil(64/raw.length)).slice(0,64)}` }; }
  async getStatus(_h: string)                        { return { status: this.reorgedStatus as any }; }
  async resubmitWithGasBump(_t: string, _p: number) { const t = Date.now().toString(16); return { txHash: `0x${t.repeat(Math.ceil(64/t.length)).slice(0,64)}` }; }
}

class MockWallet implements WalletResolver {
  async getWalletAddr(userId: string) { return `0x${userId.padEnd(40,'0')}`; }
}

function makeTx(id: string, status: TxStatus, txHash?: string, userId = 'user-7a3f2c91', tokenId = 1001n): MintRequest {
  const now = new Date();
  return { id, userId, tokenId, amount: 1n,
    status, txHash, retryCount: 0, createdAt: now, updatedAt: now };
}

// ── 답안 ──────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S13: TX 상태머신 (답안) ===\n');

  // ── [1] _transition() — DB 저장 ──────────────────────────────────────
  console.log('[1] _transition() — DB 저장');
  {
    const repo = new InMemoryRepo();
    const svc  = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    await repo.save(makeTx('mint-550e8400-e29b-41d4-a716-446655440001', 'PENDING', '0xabcabc0000000000abcabc0000000000abcabc0000000000abcabc0000000000'));

    await svc.handleMined('mint-550e8400-e29b-41d4-a716-446655440001', 100);

    const after = await repo.findById('mint-550e8400-e29b-41d4-a716-446655440001');
    console.log('  result     :', after);      // result
    // console.log('  status     :', after?.status);      // MINED
    // console.log('  blockNumber:', after?.blockNumber); // 100
  }

  // ── [2] _transition() — 이벤트 emit ──────────────────────────────────
  console.log('\n[2] _transition() — 이벤트 emit');
  {
    const repo   = new InMemoryRepo();
    const svc    = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    const events: TxTransitionEvent[] = [];
    svc.on('transition', (evt: TxTransitionEvent) => events.push(evt));
    await repo.save(makeTx('mint-6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'MINED', '0xdefdef0000000000defdef0000000000defdef0000000000defdef0000000000', 'user-b2d4f891', 2048n));

    await svc.handleConfirmed('mint-6ba7b810-9dad-11d1-80b4-00c04fd430c8');

    console.log('   events  :', events);
    // console.log('  이벤트 수  :', events.length);    // 1
    // console.log('  from       :', events[0]?.from);  // PENDING
    // console.log('  to         :', events[0]?.to);    // MINED
  }

  // ── [3] _transition() — VALID_TRANSITIONS 가드 ───────────────────────
  console.log('\n[3] _transition() — VALID_TRANSITIONS 가드');
  {
    const repo = new InMemoryRepo();
    const svc  = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    // FINALIZED 상태에서 handleFailed 호출 → _transition(FINALIZED→FAILED) 가드 발동
    // handleFailed는 FAILED만 early-return, FINALIZED는 통과 → _transition까지 도달
    await repo.save(makeTx('mint-6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'FINALIZED', undefined, 'user-c3e5a012', 3000n));

    try {
      await svc.handleFailed('mint-6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'late error');
    } catch (err) {
      console.log('  에러:', (err as Error));
      // console.log('  에러:', (err as Error).constructor.name); // InvalidStatusTransitionError
      // console.log('  메시지:', (err as Error).message);
    }
  }

  // ── [4] 핸들러 가드 — 예상 상태 아니면 조용히 return ────────────────
  console.log('\n[4] 핸들러 가드 — 예상 상태 아니면 조용히 return');
  {
    const repo = new InMemoryRepo();
    const svc  = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    await repo.save(makeTx('mint-6ba7b812-9dad-11d1-80b4-00c04fd430c8', 'CONFIRMED', undefined, 'user-d4f6b134', 4096n));

    await svc.handleMined('mint-6ba7b812-9dad-11d1-80b4-00c04fd430c8', 999); // 예외 없음 — 조용히 return

    const after = await repo.findById('mint-6ba7b812-9dad-11d1-80b4-00c04fd430c8');
    console.log('  status:', after);
    // console.log('  status:', after?.status); // CONFIRMED (그대로)
  }

  // ── [5] handleFailed — 가드 없음 ─────────────────────────────────────
  console.log('\n[5] handleFailed — 가드 없음');
  {
    const repo = new InMemoryRepo();
    const svc  = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    await repo.save(makeTx('mint-6ba7b813-9dad-11d1-80b4-00c04fd430c8', 'PENDING', undefined, 'user-e5a7c256', 5000n));

    await svc.handleFailed('mint-6ba7b813-9dad-11d1-80b4-00c04fd430c8', 'revert: out of gas');

    const after = await repo.findById('mint-6ba7b813-9dad-11d1-80b4-00c04fd430c8');
    console.log('  status    :', after?.status);     // FAILED
    console.log('  failReason:', after?.failReason); // revert: out of gas
  }

  // ── [6] handleTimeout — gas bump, PENDING 유지 ───────────────────────
  console.log('\n[6] handleTimeout — gas bump, PENDING 유지');
  {
    const repo = new InMemoryRepo();
    const svc  = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    await repo.save(makeTx('mint-6ba7b814-9dad-11d1-80b4-00c04fd430c8', 'PENDING', '0x01d01d000000000001d01d000000000001d01d000000000001d01d0000000000', 'user-f6b8d378', 6144n));

    await svc.handleTimeout('mint-6ba7b814-9dad-11d1-80b4-00c04fd430c8');

    const after = await repo.findById('mint-6ba7b814-9dad-11d1-80b4-00c04fd430c8');
    console.log('  status     :', after);
    // console.log('  status     :', after?.status);     // PENDING (그대로)
    // console.log('  txHash     :', after?.txHash);     // (new 64-char hash from resubmitWithGasBump)
    // console.log('  retryCount :', after?.retryCount); // 1
  }

  // ── [7] handleReorg — 재채굴 성공 ────────────────────────────────────
  console.log('\n[7] handleReorg — 재채굴 성공 (getStatus → mined)');
  {
    const repo   = new InMemoryRepo();
    const svc    = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    const events: TxTransitionEvent[] = [];
    svc.on('transition', (evt: TxTransitionEvent) => events.push(evt));
    await repo.save(makeTx('mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8', 'MINED', '0xee090000000000000000000000000000000000000000000000000000000000ee', 'user-a1c9e4b2', 7001n));
    (svc as any)._waitBlocks = async () => {};

    await svc.handleReorg('mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8');

    const after = await repo.findById('mint-6ba7b815-9dad-11d1-80b4-00c04fd430c8');
    // console.log('  최종 status:', after?.status);                              // MINED
    console.log('  최종 status:', after);
    // console.log('  전이 흐름  :', events.map(e => `${e.from}→${e.to}`).join(', ')); // MINED→REORGED, REORGED→MINED
    console.log('  전이 흐름  :', events);
  }

  // ── [8] handleReorg — 영구 소실 ──────────────────────────────────────
  console.log('\n[8] handleReorg — 영구 소실 (getStatus → not_found)');
  {
    const repo = new InMemoryRepo();
    const vasp = new MockVasp();
    vasp.reorgedStatus = 'not_found';
    const svc  = new TxStateMachineService(repo, vasp, new MockWallet());
    await repo.save(makeTx('mint-6ba7b816-9dad-11d1-80b4-00c04fd430c8', 'MINED', '0xd40d000000000000000000000000000000000000000000000000000000000d40', 'user-b2d0f7c3', 8192n));
    (svc as any)._waitBlocks = async () => {};

    await svc.handleReorg('mint-6ba7b816-9dad-11d1-80b4-00c04fd430c8');

    const after = await repo.findById('mint-6ba7b816-9dad-11d1-80b4-00c04fd430c8');
    console.log('  status    :', after);
    // console.log('  status    :', after?.status);     // FAILED
    // console.log('  failReason:', after?.failReason); // reorg: tx not found after wait
  }

  // ── [9] Observer — CONFIRMED·FAILED 구독자 ───────────────────────────
  console.log('\n[9] Observer — CONFIRMED·FAILED 구독자');
  {
    const repo           = new InMemoryRepo();
    const svc            = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    const ledgerUpdates: TxTransitionEvent[] = [];
    const alertLog:      TxTransitionEvent[] = [];

    svc.on('transition', (evt: TxTransitionEvent) => {
      if (evt.to === 'CONFIRMED') ledgerUpdates.push(evt);
    });
    svc.on('transition', (evt: TxTransitionEvent) => {
      if (evt.to === 'FAILED') alertLog.push(evt);
    });

    await repo.save(makeTx('mint-6ba7b817-9dad-11d1-80b4-00c04fd430c8', 'MINED',   undefined, 'user-c3e1a5d4', 9001n));
    await repo.save(makeTx('mint-6ba7b818-9dad-11d1-80b4-00c04fd430c8', 'PENDING', undefined, 'user-d4f2b6e5', 9002n));
    await repo.save(makeTx('mint-6ba7b819-9dad-11d1-80b4-00c04fd430c8', 'MINED',   undefined, 'user-e5a3c7f6', 9003n));

    await svc.handleConfirmed('mint-6ba7b817-9dad-11d1-80b4-00c04fd430c8');
    await svc.handleFailed('mint-6ba7b818-9dad-11d1-80b4-00c04fd430c8', 'revert');
    await svc.handleConfirmed('mint-6ba7b819-9dad-11d1-80b4-00c04fd430c8');

    console.log('  ledgerUpdates:', ledgerUpdates.length, ledgerUpdates.map(e => e.to)); // 2 ['CONFIRMED','CONFIRMED']
    console.log('  alertLog     :', alertLog.length,      alertLog.map(e => e.to));      // 1 ['FAILED']
  }

  // ── [10] 없는 requestId ───────────────────────────────────────────────
  console.log('\n[10] 없는 requestId → MintRequestNotFoundError');
  {
    const repo = new InMemoryRepo();
    const svc  = new TxStateMachineService(repo, new MockVasp(), new MockWallet());

    try { await svc.handleMined('mint-ffffffff-ffff-ffff-ffff-ffffffffffff', 1); }
    catch (err) { console.log('  handleMined  :', (err as Error).constructor.name); }

    try { await svc.handleTimeout('mint-ffffffff-ffff-ffff-ffff-ffffffffffff'); }
    catch (err) { console.log('  handleTimeout:', (err as Error).constructor.name); }

    try { await svc.handleReorg('mint-ffffffff-ffff-ffff-ffff-ffffffffffff'); }
    catch (err) { console.log('  handleReorg  :', (err as Error).constructor.name); }
  }
})();
