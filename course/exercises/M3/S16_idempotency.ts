/**
 * S16 실습 — Idempotency 보장: requestId 기반 중복 TX 방어
 * 실행: npm run exercise:s16
 */

import type { TxRepository, VaspTxClient, WalletResolver, MintRequest, TxStatus } from '@kyobo/vasp';
import { TxStateMachineService } from '@kyobo/vasp';

// ── InMemoryTxRepository ──────────────────────────────────────────────────────

class InMemoryTxRepository implements TxRepository {
  private store = new Map<string, MintRequest>();

  async save(req: MintRequest): Promise<void> {
    this.store.set(req.id, { ...req });
  }

  async findById(id: string): Promise<MintRequest | null> {
    return this.store.get(id) ?? null;
  }

  async updateStatus(id: string, status: TxStatus, extra?: Partial<MintRequest>): Promise<void> {
    const r = this.store.get(id);
    if (r) this.store.set(id, { ...r, ...extra, status, updatedAt: new Date() });
  }

  async findPendingOlderThan(_minutes: number): Promise<MintRequest[]> { return []; }

  all(): MintRequest[] { return [...this.store.values()]; }
}

// ── VaspMockClient — requestId 기반 멱등성 ────────────────────────────────────

class VaspMockClient implements VaspTxClient {
  private submitted = new Map<string, string>();  // requestId → txHash
  private counter   = 0;
  private txStatus  = new Map<string, {
    status: 'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found';
    blockNumber?: number;
    revertReason?: string;
  }>();

  async submitMint(params: {
    to: string; tokenId: bigint; amount: bigint; requestId: string;
  }): Promise<{ txHash: string }> {
    if (this.submitted.has(params.requestId)) {
      return { txHash: this.submitted.get(params.requestId)! };
    }
    const base = `${(++this.counter).toString(16)}${Date.now().toString(16)}`;
    const txHash = `0x${base.repeat(Math.ceil(64 / base.length)).slice(0, 64)}`;
    this.submitted.set(params.requestId, txHash);
    this.txStatus.set(txHash, { status: 'pending' });
    return { txHash };
  }

  setTxStatus(txHash: string, status: { status: 'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found'; revertReason?: string }) {
    this.txStatus.set(txHash, status);
  }

  async getStatus(txHash: string) {
    return this.txStatus.get(txHash) ?? { status: 'not_found' as const };
  }

  async resubmitWithGasBump(_txHash: string, _pct: number) {
    const t = Date.now().toString(16);
    return { txHash: `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}` };
  }
}

class MockWalletResolver implements WalletResolver {
  async getWalletAddr(userId: string): Promise<string> {
    return `0x${userId.padEnd(40, '0')}`;
  }
}

// ── 실습 ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S16: Idempotency — requestId 기반 중복 TX 방어 ===\n');

  const wallet = new MockWalletResolver();

  // ── [1] 정상 흐름: submitMintRequest → SUBMITTED ──────────────────────
  console.log('[1] 정상 흐름: submitMintRequest → SUBMITTED');
  {
    const repo = new InMemoryTxRepository();
    const svc  = new TxStateMachineService(repo, new VaspMockClient(), wallet);

    const requestId = await svc.submitMintRequest({ userId: 'user-7a3f2c91', tokenId: 2048n, amount: 1n });
    const req = await repo.findById(requestId);

    console.log('  requestId  :', requestId);
    console.log('  req        :', req);
  }

  // ── [2] 멱등성: 동일 requestId → 동일 txHash ─────────────────────────
  console.log('\n[2] 멱등성: 동일 requestId → 동일 txHash');
  {
    const vasp = new VaspMockClient();
    const addr = '0xa11ce00000000000000000000000000000000001';

    const r1    = await vasp.submitMint({ to: addr, tokenId: 2048n, amount: 1n, requestId: 'mint-550e8400-e29b-41d4-a716-446655440001' });
    const r2    = await vasp.submitMint({ to: addr, tokenId: 2048n, amount: 1n, requestId: 'mint-550e8400-e29b-41d4-a716-446655440001' });
    const r3    = await vasp.submitMint({ to: addr, tokenId: 2048n, amount: 1n, requestId: 'mint-550e8400-e29b-41d4-a716-446655440001' });
    const rDiff = await vasp.submitMint({ to: addr, tokenId: 3000n, amount: 1n, requestId: 'mint-6ba7b810-9dad-11d1-80b4-00c04fd430c8' });

    console.log('  r1.txHash  :', r1.txHash);
    console.log('  r2.txHash  :', r2.txHash,);
    console.log('  r3.txHash  :', r3.txHash);
    console.log('  rDiff      :', rDiff.txHash);
  }

  // ── [3] VASP 전송 실패 → DB FAILED 기록 ──────────────────────────────
  console.log('\n[3] VASP 실패 → DB INSERT(REQUESTED) 후 FAILED 기록');
  {
    const repo = new InMemoryTxRepository();
    const failVasp: VaspTxClient = {
      submitMint:          async () => { throw new Error('VASP network timeout'); },
      getStatus:           async () => ({ status: 'not_found' as const }),
      resubmitWithGasBump: async () => ({ txHash: '0x0' }),
    };
    const svc = new TxStateMachineService(repo, failVasp, wallet);

    try { await svc.submitMintRequest({ userId: 'user-f3a9c821', tokenId: 9999n, amount: 1n }); }
    catch (err) { console.log('  에러       :', (err as Error).message); }

    const failedReq = repo.all().find(r => r.status === 'FAILED');
    console.log('  failedReq  :', failedReq);
  }

  console.log('\nS16 완료');
})();
