/**
 * S16 정답 — Idempotency 보장: requestId 기반 중복 TX 방어
 *
 * 목표:
 *   [1] 정상 흐름: submitMintRequest → REQUESTED → SUBMITTED 전이
 *   [2] VaspMockClient 멱등성: 동일 requestId → 동일 txHash 반환
 *   [3] VASP 전송 실패 → DB에 FAILED 기록 (재처리 가능)
 *   [4] handleMined 가드: CONFIRMED 상태에서 호출 → 조용히 무시 (throw 아님)
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
    const txHash = `0xMOCK_${(++this.counter).toString().padStart(4, '0')}_${Date.now().toString(16)}`;
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
    return { txHash: `0xBUMP_${Date.now().toString(16)}` };
  }
}

class MockWalletResolver implements WalletResolver {
  async getWalletAddr(userId: string): Promise<string> {
    return `0x${userId.padEnd(40, '0')}`;
  }
}

// ── 실습 ──────────────────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✅ ${msg}`);
}

(async () => {
  const wallet = new MockWalletResolver();

  // [1] 정상 흐름: REQUESTED → SUBMITTED
  console.log('[1] 정상 흐름');
  {
    const repo = new InMemoryTxRepository();
    const svc  = new TxStateMachineService(repo, new VaspMockClient(), wallet);

    const requestId = await svc.submitMintRequest({ userId: 'user-1', tokenId: 1001n, amount: 1n });
    const req = await repo.findById(requestId);

    assert(req?.status === 'SUBMITTED', `상태 SUBMITTED`);
    assert(!!req?.txHash, 'txHash 저장됨');
  }

  // [2] 멱등성: 동일 requestId → 동일 txHash
  console.log('[2] 멱등성');
  {
    const vasp = new VaspMockClient();
    const r1 = await vasp.submitMint({ to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid' });
    const r2 = await vasp.submitMint({ to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid' });
    const r3 = await vasp.submitMint({ to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid' });
    const rDiff = await vasp.submitMint({ to: '0xBob', tokenId: 1002n, amount: 1n, requestId: 'different-uuid' });

    assert(r1.txHash === r2.txHash, '2차 호출 txHash 동일');
    assert(r1.txHash === r3.txHash, '3차 호출 txHash 동일');
    assert(r1.txHash !== rDiff.txHash, '다른 requestId → 다른 txHash');
  }

  // [3] VASP 전송 실패 → DB FAILED 기록
  console.log('[3] VASP 실패');
  {
    const repo = new InMemoryTxRepository();
    const failVasp: VaspTxClient = {
      submitMint:          async () => { throw new Error('VASP network timeout'); },
      getStatus:           async () => ({ status: 'not_found' as const }),
      resubmitWithGasBump: async () => ({ txHash: '0x0' }),
    };
    const svc = new TxStateMachineService(repo, failVasp, wallet);

    let threw = false;
    try { await svc.submitMintRequest({ userId: 'user-fail', tokenId: 999n, amount: 1n }); }
    catch { threw = true; }

    const failedReq = repo.all().find(r => r.status === 'FAILED');
    assert(threw, 'throw 발생');
    assert(!!failedReq, 'DB에 FAILED 기록 존재');
    assert(!!failedReq?.failReason, 'failReason 저장됨');
  }

  // [4] handleMined 가드: CONFIRMED → 조용히 무시
  console.log('[4] handleMined 가드');
  {
    const repo = new InMemoryTxRepository();
    const svc  = new TxStateMachineService(repo, new VaspMockClient(), wallet);
    const now  = new Date();
    await repo.save({
      id: 'req-confirmed', userId: 'u1', tokenId: 1n, amount: 1n,
      status: 'CONFIRMED', retryCount: 0, createdAt: now, updatedAt: now,
      txHash: '0xconfirmed',
    });

    let threw = false;
    try { await svc.handleMined('req-confirmed', 9999); } catch { threw = true; }

    const after = await repo.findById('req-confirmed');
    assert(!threw, 'throw 없음');
    assert(after?.status === 'CONFIRMED', '상태 변화 없음');
  }

  console.log('\nS16 완료');
})();
