/**
 * S22 채점 — pollStaleRequests 통합 테스트
 *
 * S22_pollstale_lab.ts 는 export가 없으므로 TxStateMachineService를
 * @kyobo/vasp 에서 import하여 채점한다.
 *
 * 채점 기준:
 *   · pollStaleRequests: VASP 'failed' → FAILED 전이 + failReason 저장
 *   · pollStaleRequests: VASP 'not_found' → FAILED 전이
 *   · pollStaleRequests: VASP 'confirmed' → CONFIRMED 전이 (콜백 차단 E2E)
 *   · Idempotency: CONFIRMED 건은 pollStaleRequests가 재처리하지 않음
 *   · Bulkhead: 한 건 에러가 전체 배치를 멈추지 않음
 *   · handleTimeout: PENDING 유지 + retryCount 증가 + gas bump
 */

import type { TxRepository, VaspTxClient, WalletResolver, MintRequest, TxStatus } from '@kyobo/vasp';
import { TxStateMachineService } from '@kyobo/vasp';

// ── In-memory TxRepository ────────────────────────────────────────────────────
class InMemoryTxRepository implements TxRepository {
  private store = new Map<string, MintRequest>();

  async save(req: MintRequest): Promise<void>       { this.store.set(req.id, { ...req }); }
  async findById(id: string): Promise<MintRequest | null> { return this.store.get(id) ?? null; }
  async updateStatus(id: string, status: TxStatus, extra?: Partial<MintRequest>): Promise<void> {
    const existing = this.store.get(id);
    if (!existing) return;
    this.store.set(id, { ...existing, ...extra, status, updatedAt: new Date() });
  }
  async findPendingOlderThan(minutes: number): Promise<MintRequest[]> {
    const cutoff = new Date(Date.now() - minutes * 60_000);
    return [...this.store.values()].filter(r => r.status === 'PENDING' && r.createdAt < cutoff);
  }
}

// ── Mock VaspTxClient ─────────────────────────────────────────────────────────
type VaspStatusResult = Awaited<ReturnType<VaspTxClient['getStatus']>>;

class MockVaspTxClient implements VaspTxClient {
  private statusMap = new Map<string, VaspStatusResult>();
  private gasBumpLog: string[] = [];

  setNextStatus(txHash: string, result: VaspStatusResult): void {
    this.statusMap.set(txHash, result);
  }

  async submitMint(params: { to: string; tokenId: bigint; amount: bigint; requestId: string }) {
    const raw = Buffer.from(params.requestId).toString('hex');
    return { txHash: `0x${raw.repeat(Math.ceil(64 / raw.length)).slice(0, 64)}` };
  }
  async getStatus(txHash: string): Promise<VaspStatusResult> {
    return this.statusMap.get(txHash) ?? { status: 'pending' };
  }
  async resubmitWithGasBump(txHash: string, pct: number) {
    const t = Date.now().toString(16);
    const newHash = `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}`;
    this.gasBumpLog.push(`${txHash} → ${newHash} (+${pct}%)`);
    return { txHash: newHash };
  }
  getGasBumpLog(): string[] { return this.gasBumpLog; }
}

class MockWalletResolver implements WalletResolver {
  async getWalletAddr(userId: string): Promise<string> {
    return `0x${userId.padEnd(40, '0')}`;
  }
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
function makeStalePendingRequest(id: string, txHash: string): MintRequest {
  const staleDate = new Date(Date.now() - 35 * 60_000);
  return {
    id, userId: `user-${id}`, tokenId: 1n, amount: 1n,
    status: 'PENDING', txHash, retryCount: 0,
    createdAt: staleDate, updatedAt: staleDate,
  };
}

function makeRequest(id: string, txHash: string, status: TxStatus): MintRequest {
  const now = new Date(Date.now() - 35 * 60_000);
  return {
    id, userId: `user-${id}`, tokenId: 1n, amount: 1n,
    status, txHash, retryCount: 0,
    createdAt: now, updatedAt: now,
  };
}

const wallet = new MockWalletResolver();

// ── 채점 테스트 ───────────────────────────────────────────────────────────────
describe('S22 채점 — pollStaleRequests 통합 테스트', () => {

  describe('[1] handleTimeout — PENDING + gas bump', () => {
    it('handleTimeout 후 상태가 PENDING으로 유지된다', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeRequest('req-timeout-1', '0xfa11ed55555555555555555555555555555555555555555555555555555551fa', 'PENDING'));
      await svc.handleTimeout('req-timeout-1');
      const r = await repo.findById('req-timeout-1');
      expect(r?.status).toBe('PENDING');
    });

    it('handleTimeout 후 retryCount 가 증가한다', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeRequest('req-timeout-2', '0xfa11ed55555555555555555555555555555555555555555555555555555552fa', 'PENDING'));
      await svc.handleTimeout('req-timeout-2');
      const r = await repo.findById('req-timeout-2');
      expect((r?.retryCount ?? 0)).toBeGreaterThanOrEqual(1);
    });

    it('gas bump 이 1회 호출된다', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeRequest('req-timeout-3', '0xfa11ed55555555555555555555555555555555555555555555555555555553fa', 'PENDING'));
      await svc.handleTimeout('req-timeout-3');
      expect(vasp.getGasBumpLog()).toHaveLength(1);
    });
  });

  describe('[2] handleConfirmed + handleFinalized 순서 → FINALIZED', () => {
    it('MINED → handleConfirmed → CONFIRMED', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new MockVaspTxClient(), wallet);
      await repo.save(makeRequest('req-mined-1', '0xfa11ed33333333333333333333333333333333333333333333333333333331fa', 'MINED'));
      await svc.handleConfirmed('req-mined-1');
      const r = await repo.findById('req-mined-1');
      expect(r?.status).toBe('CONFIRMED');
    });

    it('CONFIRMED → handleFinalized → FINALIZED', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new MockVaspTxClient(), wallet);
      await repo.save(makeRequest('req-confirmed-1', '0xfa11ed33333333333333333333333333333333333333333333333333333332fa', 'CONFIRMED'));
      await svc.handleFinalized('req-confirmed-1');
      const r = await repo.findById('req-confirmed-1');
      expect(r?.status).toBe('FINALIZED');
    });

    it('handleConfirmed + handleFinalized 순서 → FINALIZED (전체 경로)', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new MockVaspTxClient(), wallet);
      await repo.save(makeRequest('req-mined-full', '0xfa11ed33333333333333333333333333333333333333333333333333333333fa', 'MINED'));
      await svc.handleConfirmed('req-mined-full');
      await svc.handleFinalized('req-mined-full');
      const r = await repo.findById('req-mined-full');
      expect(r?.status).toBe('FINALIZED');
    });

    it('PENDING 에서 handleConfirmed 호출 → 상태 변화 없음 (방어 로직)', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new MockVaspTxClient(), wallet);
      await repo.save(makeRequest('req-pending-skip', '0xfa11ed44444444444444444444444444444444444444444444444444444444fa', 'PENDING'));
      await svc.handleConfirmed('req-pending-skip');
      const r = await repo.findById('req-pending-skip');
      expect(r?.status).toBe('PENDING');
    });
  });

  describe('[3] pollStaleRequests — VASP failed → FAILED 전이', () => {
    it('VASP "failed" → PENDING 상태가 FAILED 로 전이한다', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeStalePendingRequest('req-s22-failed', '0xfa11ed11111111111111111111111111111111111111111111111111111111fa'));
      vasp.setNextStatus('0xfa11ed11111111111111111111111111111111111111111111111111111111fa', { status: 'failed', revertReason: 'ERC1155: mint to zero address' });
      await svc.pollStaleRequests();
      const r = await repo.findById('req-s22-failed');
      expect(r?.status).toBe('FAILED');
    });

    it('VASP "failed" → failReason 이 저장된다', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeStalePendingRequest('req-s22-failed-2', '0xfa11ed22222222222222222222222222222222222222222222222222222222fa'));
      vasp.setNextStatus('0xfa11ed22222222222222222222222222222222222222222222222222222222fa', { status: 'failed', revertReason: 'some reason' });
      await svc.pollStaleRequests();
      const r = await repo.findById('req-s22-failed-2');
      expect(r?.failReason).toBeTruthy();
    });
  });

  describe('[4] pollStaleRequests — VASP not_found → FAILED 전이', () => {
    it('VASP "not_found" → FAILED 전이', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeStalePendingRequest('req-s22-nf', '0xfa11ed99999999999999999999999999999999999999999999999999999999fa'));
      vasp.setNextStatus('0xfa11ed99999999999999999999999999999999999999999999999999999999fa', { status: 'not_found' });
      await svc.pollStaleRequests();
      const r = await repo.findById('req-s22-nf');
      expect(r?.status).toBe('FAILED');
    });

    it('VASP "not_found" → failReason 에 not found 포함', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeStalePendingRequest('req-s22-nf-2', '0xfa11ed99999999999999999999999999999999999999999999999999999998fa'));
      vasp.setNextStatus('0xfa11ed99999999999999999999999999999999999999999999999999999998fa', { status: 'not_found' });
      await svc.pollStaleRequests();
      const r = await repo.findById('req-s22-nf-2');
      expect(r?.failReason?.toLowerCase()).toContain('not found');
    });
  });

  describe('[3] pollStaleRequests — VASP confirmed → CONFIRMED 전이 (콜백 차단 E2E)', () => {
    it('Webhook 없이 pollStaleRequests가 CONFIRMED 전이시킨다', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeStalePendingRequest('req-s22-cb-e2e', '0xfa11edaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
      vasp.setNextStatus('0xfa11edaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { status: 'confirmed', blockNumber: 12400 });
      const { processed } = await svc.pollStaleRequests();
      expect(processed).toBe(1);
      const r = await repo.findById('req-s22-cb-e2e');
      expect(r?.status).toBe('CONFIRMED');
    });

    it('pollStaleRequests: pending → skip (processed에 포함되지 않음)', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeStalePendingRequest('req-s22-pending-skip', '0xfa11edbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
      vasp.setNextStatus('0xfa11edbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { status: 'pending' });
      const { processed } = await svc.pollStaleRequests();
      expect(processed).toBe(0);
    });
  });

  describe('[4] Idempotency — CONFIRMED 건은 폴링이 재처리하지 않음', () => {
    it('CONFIRMED 상태 건은 findPendingOlderThan에서 제외된다', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      const staleDate = new Date(Date.now() - 35 * 60_000);
      await repo.save({
        id: 'req-idempotent', userId: 'user-idempotent',
        tokenId: 1n, amount: 1n,
        status: 'CONFIRMED', txHash: '0xfa11edcccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        retryCount: 0, createdAt: staleDate, updatedAt: new Date(),
      });
      const { processed } = await svc.pollStaleRequests();
      expect(processed).toBe(0);
      const r = await repo.findById('req-idempotent');
      expect(r?.status).toBe('CONFIRMED');
    });

    it('FAILED 상태 건도 재처리되지 않는다', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      const staleDate = new Date(Date.now() - 35 * 60_000);
      await repo.save({
        id: 'req-idem-failed', userId: 'user-idem-failed',
        tokenId: 1n, amount: 1n,
        status: 'FAILED', txHash: '0xfa11eddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        retryCount: 0, createdAt: staleDate, updatedAt: new Date(),
      });
      const { processed } = await svc.pollStaleRequests();
      expect(processed).toBe(0);
    });
  });

  describe('[6] Bulkhead — 한 건 에러가 전체 배치를 멈추지 않음', () => {
    it('pollStaleRequests 전체가 throw되지 않는다', async () => {
      const repo  = new InMemoryTxRepository();
      const vasp  = new MockVaspTxClient();
      const svc   = new TxStateMachineService(repo, vasp, wallet);

      await repo.save(makeStalePendingRequest('iso-error',  '0xfa11ed66666666666666666666666666666666666666666666666666666666fa'));
      await repo.save(makeStalePendingRequest('iso-fail-1', '0xfa11ed77777777777777777777777777777777777777777777777777777777fa'));
      await repo.save(makeStalePendingRequest('iso-fail-2', '0xfa11ed88888888888888888888888888888888888888888888888888888888fa'));

      vasp.setNextStatus('0xfa11ed77777777777777777777777777777777777777777777777777777777fa', { status: 'failed', revertReason: 'revert A' });
      vasp.setNextStatus('0xfa11ed88888888888888888888888888888888888888888888888888888888fa', { status: 'failed', revertReason: 'revert B' });

      const origGetStatus = vasp.getStatus.bind(vasp);
      vasp.getStatus = async (txHash: string) => {
        if (txHash === '0xfa11ed66666666666666666666666666666666666666666666666666666666fa') throw new Error('VASP API 타임아웃 시뮬레이션');
        return origGetStatus(txHash);
      };

      await expect(svc.pollStaleRequests()).resolves.toBeDefined(); // throw 없이 완료되면 성공
    });

    it('에러 건 옆 iso-fail-1 은 FAILED 로 전이된다', async () => {
      const repo  = new InMemoryTxRepository();
      const vasp  = new MockVaspTxClient();
      const svc   = new TxStateMachineService(repo, vasp, wallet);

      await repo.save(makeStalePendingRequest('iso-b-error',  '0xfa11ed66666666666666666666666666666666666666666666666666666661fa'));
      await repo.save(makeStalePendingRequest('iso-b-fail-1', '0xfa11ed77777777777777777777777777777777777777777777777777777771fa'));
      await repo.save(makeStalePendingRequest('iso-b-fail-2', '0xfa11ed88888888888888888888888888888888888888888888888888888881fa'));

      vasp.setNextStatus('0xfa11ed77777777777777777777777777777777777777777777777777777771fa', { status: 'failed', revertReason: 'revert A' });
      vasp.setNextStatus('0xfa11ed88888888888888888888888888888888888888888888888888888881fa', { status: 'failed', revertReason: 'revert B' });

      const origGetStatus = vasp.getStatus.bind(vasp);
      vasp.getStatus = async (txHash: string) => {
        if (txHash === '0xfa11ed66666666666666666666666666666666666666666666666666666661fa') throw new Error('timeout');
        return origGetStatus(txHash);
      };

      await svc.pollStaleRequests();

      const r1 = await repo.findById('iso-b-fail-1');
      const r2 = await repo.findById('iso-b-fail-2');
      expect(r1?.status).toBe('FAILED');
      expect(r2?.status).toBe('FAILED');
    });
  });
});
