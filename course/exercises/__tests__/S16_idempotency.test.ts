/**
 * S16 채점 — Idempotency: requestId 기반 중복 TX 방어
 *
 * S16_idempotency.ts 는 export가 없으므로 VaspMockClient를 인라인으로 재현하고
 * TxStateMachineService를 @kyobo/vasp 에서 import하여 채점한다.
 *
 * 채점 기준:
 *   · 같은 requestId로 두 번 submitMint() 호출 → 동일한 txHash
 *   · 다른 requestId → 다른 txHash
 *   · submitMintRequest 성공 → SUBMITTED 상태 + txHash 저장
 *   · VASP 실패 → DB에 FAILED 기록 (재처리 가능)
 *   · CONFIRMED 상태에서 handleMined → throw 없음 (가드 패턴)
 */

import type { TxRepository, VaspTxClient, WalletResolver, MintRequest, TxStatus } from '@kyobo/vasp';
import { TxStateMachineService } from '@kyobo/vasp';

// ── In-memory TxRepository ────────────────────────────────────────────────────
class InMemoryTxRepository implements TxRepository {
  private store = new Map<string, MintRequest>();

  async save(req: MintRequest): Promise<void>       { this.store.set(req.id, { ...req }); }
  async findById(id: string): Promise<MintRequest | null> { return this.store.get(id) ?? null; }
  async updateStatus(id: string, status: TxStatus, extra?: Partial<MintRequest>): Promise<void> {
    const r = this.store.get(id);
    if (r) this.store.set(id, { ...r, ...extra, status, updatedAt: new Date() });
  }
  async findPendingOlderThan(_minutes: number): Promise<MintRequest[]> { return []; }
  all(): MintRequest[] { return [...this.store.values()]; }
}

// ── S16 학생 구현 재현: VaspMockClient ────────────────────────────────────────
class VaspMockClient implements VaspTxClient {
  private submitted = new Map<string, string>();
  private counter   = 0;
  private txStatus  = new Map<string, { status: 'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found' }>();

  async submitMint(params: { to: string; tokenId: bigint; amount: bigint; requestId: string }) {
    if (this.submitted.has(params.requestId)) {
      return { txHash: this.submitted.get(params.requestId)! };
    }
    const txHash = `0xMOCK_${(++this.counter).toString().padStart(4, '0')}_${Date.now().toString(16)}`;
    this.submitted.set(params.requestId, txHash);
    this.txStatus.set(txHash, { status: 'pending' });
    return { txHash };
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

// ── 채점 테스트 ───────────────────────────────────────────────────────────────
describe('S16 채점 — Idempotency (requestId 기반)', () => {
  const wallet = new MockWalletResolver();

  describe('[1] VaspMockClient — requestId 기반 멱등성', () => {
    let vasp: VaspMockClient;
    beforeEach(() => { vasp = new VaspMockClient(); });

    it('같은 requestId로 두 번 호출 → 동일한 txHash 반환', async () => {
      const r1 = await vasp.submitMint({ to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid' });
      const r2 = await vasp.submitMint({ to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid' });
      expect(r1.txHash).toBe(r2.txHash);
    });

    it('같은 requestId로 세 번 호출 → 모두 동일한 txHash', async () => {
      const r1 = await vasp.submitMint({ to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid-2' });
      const r2 = await vasp.submitMint({ to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid-2' });
      const r3 = await vasp.submitMint({ to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid-2' });
      expect(r1.txHash).toBe(r2.txHash);
      expect(r1.txHash).toBe(r3.txHash);
    });

    it('다른 requestId → 다른 txHash', async () => {
      const r1 = await vasp.submitMint({ to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'uuid-A' });
      const r2 = await vasp.submitMint({ to: '0xBob',   tokenId: 1002n, amount: 1n, requestId: 'uuid-B' });
      expect(r1.txHash).not.toBe(r2.txHash);
    });

    it('txHash 는 비어있지 않은 문자열이다', async () => {
      const r = await vasp.submitMint({ to: '0xAlice', tokenId: 1n, amount: 1n, requestId: 'uuid-check' });
      expect(typeof r.txHash).toBe('string');
      expect(r.txHash.length).toBeGreaterThan(0);
    });
  });

  describe('[2] submitMintRequest — 정상 흐름', () => {
    it('SUBMITTED 상태가 저장된다', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new VaspMockClient(), wallet);
      const requestId = await svc.submitMintRequest({ userId: 'user-1', tokenId: 1001n, amount: 1n });
      const req = await repo.findById(requestId);
      expect(req?.status).toBe('SUBMITTED');
    });

    it('txHash 가 저장된다', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new VaspMockClient(), wallet);
      const requestId = await svc.submitMintRequest({ userId: 'user-2', tokenId: 1002n, amount: 1n });
      const req = await repo.findById(requestId);
      expect(req?.txHash).toBeTruthy();
    });

    it('userId 와 tokenId 가 올바르게 저장된다', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new VaspMockClient(), wallet);
      const requestId = await svc.submitMintRequest({ userId: 'user-3', tokenId: 9999n, amount: 1n });
      const req = await repo.findById(requestId);
      expect(req?.userId).toBe('user-3');
      expect(req?.tokenId).toBe(9999n);
    });
  });

  describe('[3] VASP 전송 실패 → DB에 FAILED 기록', () => {
    it('submitMintRequest 는 throw를 발생시킨다', async () => {
      const repo     = new InMemoryTxRepository();
      const failVasp: VaspTxClient = {
        submitMint:          async () => { throw new Error('VASP network timeout'); },
        getStatus:           async () => ({ status: 'not_found' as const }),
        resubmitWithGasBump: async () => ({ txHash: '0x0' }),
      };
      const svc = new TxStateMachineService(repo, failVasp, wallet);
      await expect(svc.submitMintRequest({ userId: 'user-fail', tokenId: 999n, amount: 1n })).rejects.toThrow();
    });

    it('DB에 FAILED 기록이 남는다 (재처리 가능)', async () => {
      const repo     = new InMemoryTxRepository();
      const failVasp: VaspTxClient = {
        submitMint:          async () => { throw new Error('VASP timeout'); },
        getStatus:           async () => ({ status: 'not_found' as const }),
        resubmitWithGasBump: async () => ({ txHash: '0x0' }),
      };
      const svc = new TxStateMachineService(repo, failVasp, wallet);
      try { await svc.submitMintRequest({ userId: 'user-fail2', tokenId: 999n, amount: 1n }); } catch {}
      const all = repo.all();
      const failed = all.find(r => r.status === 'FAILED');
      expect(failed).toBeDefined();
    });
  });

  describe('[4] handleMined 가드 — CONFIRMED 상태에서 조용히 무시', () => {
    it('CONFIRMED 상태에서 handleMined → throw 없음', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new VaspMockClient(), wallet);
      const now  = new Date();
      await repo.save({
        id: 'req-confirmed-s16', userId: 'u1', tokenId: 1n, amount: 1n,
        status: 'CONFIRMED', retryCount: 0, createdAt: now, updatedAt: now, txHash: '0xconfirmed',
      });
      await expect(svc.handleMined('req-confirmed-s16', 9999)).resolves.toBeUndefined();
    });

    it('CONFIRMED 상태 handleMined 후 상태 변화 없음', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new VaspMockClient(), wallet);
      const now  = new Date();
      await repo.save({
        id: 'req-confirmed-check', userId: 'u1', tokenId: 1n, amount: 1n,
        status: 'CONFIRMED', retryCount: 0, createdAt: now, updatedAt: now, txHash: '0xconfirmed',
      });
      await svc.handleMined('req-confirmed-check', 9999);
      const after = await repo.findById('req-confirmed-check');
      expect(after?.status).toBe('CONFIRMED');
    });
  });
});
