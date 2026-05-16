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
  async submitMint(p: any)                           { return { txHash: `0xmock-${p.requestId.slice(0,8)}` }; }
  async getStatus(_h: string)                        { return { status: this.reorgedStatus as any }; }
  async resubmitWithGasBump(_t: string, _p: number) { return { txHash: '0xbump-new' }; }
}

class MockWallet implements WalletResolver {
  async getWalletAddr(userId: string) { return `0x${userId.padEnd(40,'0')}`; }
}

function makeTx(id: string, status: TxStatus, txHash?: string): MintRequest {
  const now = new Date();
  return { id, userId: 'u1', tokenId: 1n, amount: 1n,
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
    await repo.save(makeTx('r1', 'PENDING', '0xabc'));

    await svc.handleMined('r1', 100);

    const after = await repo.findById('r1');
    console.log('  status     :', after?.status);      // MINED
    console.log('  blockNumber:', after?.blockNumber); // 100
  }

  // ── [2] _transition() — 이벤트 emit ──────────────────────────────────
  console.log('\n[2] _transition() — 이벤트 emit');
  {
    const repo   = new InMemoryRepo();
    const svc    = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    const events: TxTransitionEvent[] = [];
    svc.on('transition', (evt: TxTransitionEvent) => events.push(evt));
    await repo.save(makeTx('r2', 'PENDING', '0xdef'));

    await svc.handleMined('r2', 200);

    console.log('  이벤트 수  :', events.length);    // 1
    console.log('  from       :', events[0]?.from);  // PENDING
    console.log('  to         :', events[0]?.to);    // MINED
  }

  // ── [3] _transition() — VALID_TRANSITIONS 가드 ───────────────────────
  console.log('\n[3] _transition() — VALID_TRANSITIONS 가드');
  {
    const repo = new InMemoryRepo();
    const svc  = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    // handleFailed는 가드 없음 → FAILED 상태에서 호출 → _transition(FAILED→FAILED) 가드 발동
    await repo.save(makeTx('r3', 'FAILED'));

    try {
      await svc.handleFailed('r3', 'again');
    } catch (err) {
      console.log('  에러:', (err as Error).constructor.name); // InvalidStatusTransitionError
      console.log('  메시지:', (err as Error).message);
    }
  }

  // ── [4] 핸들러 가드 — 예상 상태 아니면 조용히 return ────────────────
  console.log('\n[4] 핸들러 가드 — 예상 상태 아니면 조용히 return');
  {
    const repo = new InMemoryRepo();
    const svc  = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    await repo.save(makeTx('r4', 'CONFIRMED'));

    await svc.handleMined('r4', 999); // 예외 없음 — 조용히 return

    const after = await repo.findById('r4');
    console.log('  status:', after?.status); // CONFIRMED (그대로)
  }

  // ── [5] handleFailed — 가드 없음 ─────────────────────────────────────
  console.log('\n[5] handleFailed — 가드 없음');
  {
    const repo = new InMemoryRepo();
    const svc  = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    await repo.save(makeTx('r5', 'PENDING'));

    await svc.handleFailed('r5', 'revert: out of gas');

    const after = await repo.findById('r5');
    console.log('  status    :', after?.status);     // FAILED
    console.log('  failReason:', after?.failReason); // revert: out of gas
  }

  // ── [6] handleTimeout — gas bump, PENDING 유지 ───────────────────────
  console.log('\n[6] handleTimeout — gas bump, PENDING 유지');
  {
    const repo = new InMemoryRepo();
    const svc  = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    await repo.save(makeTx('r6', 'PENDING', '0xold'));

    await svc.handleTimeout('r6');

    const after = await repo.findById('r6');
    console.log('  status     :', after?.status);     // PENDING (그대로)
    console.log('  txHash     :', after?.txHash);     // 0xbump-new
    console.log('  retryCount :', after?.retryCount); // 1
  }

  // ── [7] handleReorg — 재채굴 성공 ────────────────────────────────────
  console.log('\n[7] handleReorg — 재채굴 성공 (getStatus → mined)');
  {
    const repo   = new InMemoryRepo();
    const svc    = new TxStateMachineService(repo, new MockVasp(), new MockWallet());
    const events: TxTransitionEvent[] = [];
    svc.on('transition', (evt: TxTransitionEvent) => events.push(evt));
    await repo.save(makeTx('r7', 'MINED', '0xreorg'));
    (svc as any)._waitBlocks = async () => {};

    await svc.handleReorg('r7');

    const after = await repo.findById('r7');
    console.log('  최종 status:', after?.status);                              // MINED
    console.log('  전이 흐름  :', events.map(e => `${e.from}→${e.to}`).join(', ')); // MINED→REORGED, REORGED→MINED
  }

  // ── [8] handleReorg — 영구 소실 ──────────────────────────────────────
  console.log('\n[8] handleReorg — 영구 소실 (getStatus → not_found)');
  {
    const repo = new InMemoryRepo();
    const vasp = new MockVasp();
    vasp.reorgedStatus = 'not_found';
    const svc  = new TxStateMachineService(repo, vasp, new MockWallet());
    await repo.save(makeTx('r8', 'MINED', '0xdrop'));
    (svc as any)._waitBlocks = async () => {};

    await svc.handleReorg('r8');

    const after = await repo.findById('r8');
    console.log('  status    :', after?.status);     // FAILED
    console.log('  failReason:', after?.failReason); // reorg: tx not found after wait
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

    await repo.save(makeTx('r9a', 'MINED'));
    await repo.save(makeTx('r9b', 'PENDING'));
    await repo.save(makeTx('r9c', 'MINED'));

    await svc.handleConfirmed('r9a');
    await svc.handleFailed('r9b', 'revert');
    await svc.handleConfirmed('r9c');

    console.log('  ledgerUpdates:', ledgerUpdates.length, ledgerUpdates.map(e => e.to)); // 2 ['CONFIRMED','CONFIRMED']
    console.log('  alertLog     :', alertLog.length,      alertLog.map(e => e.to));      // 1 ['FAILED']
  }

  // ── [10] 없는 requestId ───────────────────────────────────────────────
  console.log('\n[10] 없는 requestId → MintRequestNotFoundError');
  {
    const repo = new InMemoryRepo();
    const svc  = new TxStateMachineService(repo, new MockVasp(), new MockWallet());

    try { await svc.handleMined('no-such', 1); }
    catch (err) { console.log('  handleMined  :', (err as Error).constructor.name); }

    try { await svc.handleTimeout('no-such'); }
    catch (err) { console.log('  handleTimeout:', (err as Error).constructor.name); }

    try { await svc.handleReorg('no-such'); }
    catch (err) { console.log('  handleReorg  :', (err as Error).constructor.name); }
  }
})();
