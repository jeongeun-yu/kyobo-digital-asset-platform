/**
 * S22 채점 — pollStaleRequests 구현 + 3종 복구 통합 테스트
 *
 * S22_pollstale_lab.ts 는 export가 없으므로 TxStateMachineService를
 * @kyobo/vasp 에서 import하여 채점한다.
 *
 * 채점 기준:
 *   · handleTimeout(requestId) 후 PENDING 유지 + retryCount 증가
 *   · handleFinalized + handleConfirmed 순서 호출 → CONFIRMED 전이
 *   · pollStaleRequests: VASP 'failed' → FAILED 전이
 *   · pollStaleRequests: VASP 'not_found' → FAILED 전이
 *   · Bulkhead: 한 건 에러가 전체 배치를 멈추지 않음
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
    return { txHash: `0xmock-${params.requestId.slice(0, 8)}` };
  }
  async getStatus(txHash: string): Promise<VaspStatusResult> {
    return this.statusMap.get(txHash) ?? { status: 'pending' };
  }
  async resubmitWithGasBump(txHash: string, pct: number) {
    const newHash = `${txHash}-bumped`;
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
      await repo.save(makeRequest('req-timeout-1', '0xhash-timeout-1', 'PENDING'));
      await svc.handleTimeout('req-timeout-1');
      const r = await repo.findById('req-timeout-1');
      expect(r?.status).toBe('PENDING');
    });

    it('handleTimeout 후 retryCount 가 증가한다', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeRequest('req-timeout-2', '0xhash-timeout-2', 'PENDING'));
      await svc.handleTimeout('req-timeout-2');
      const r = await repo.findById('req-timeout-2');
      expect((r?.retryCount ?? 0)).toBeGreaterThanOrEqual(1);
    });

    it('gas bump 이 1회 호출된다', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeRequest('req-timeout-3', '0xhash-timeout-3', 'PENDING'));
      await svc.handleTimeout('req-timeout-3');
      expect(vasp.getGasBumpLog()).toHaveLength(1);
    });
  });

  describe('[2] handleFinalized + handleConfirmed 순서 → CONFIRMED', () => {
    it('MINED → handleFinalized → FINALIZED', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new MockVaspTxClient(), wallet);
      await repo.save(makeRequest('req-mined-1', '0xhash-mined-1', 'MINED'));
      await svc.handleFinalized('req-mined-1');
      const r = await repo.findById('req-mined-1');
      expect(r?.status).toBe('FINALIZED');
    });

    it('FINALIZED → handleConfirmed → CONFIRMED', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new MockVaspTxClient(), wallet);
      await repo.save(makeRequest('req-finalized-1', '0xhash-finalized-1', 'FINALIZED'));
      await svc.handleConfirmed('req-finalized-1');
      const r = await repo.findById('req-finalized-1');
      expect(r?.status).toBe('CONFIRMED');
    });

    it('handleFinalized + handleConfirmed 순서 → CONFIRMED (전체 경로)', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new MockVaspTxClient(), wallet);
      await repo.save(makeRequest('req-mined-full', '0xhash-mined-full', 'MINED'));
      await svc.handleFinalized('req-mined-full');
      await svc.handleConfirmed('req-mined-full');
      const r = await repo.findById('req-mined-full');
      expect(r?.status).toBe('CONFIRMED');
    });

    it('PENDING 에서 handleConfirmed 호출 → 상태 변화 없음 (방어 로직)', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new MockVaspTxClient(), wallet);
      await repo.save(makeRequest('req-pending-skip', '0xhash-skip', 'PENDING'));
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
      await repo.save(makeStalePendingRequest('req-s22-failed', '0xhash-s22-failed'));
      vasp.setNextStatus('0xhash-s22-failed', { status: 'failed', revertReason: 'ERC1155: mint to zero address' });
      await svc.pollStaleRequests();
      const r = await repo.findById('req-s22-failed');
      expect(r?.status).toBe('FAILED');
    });

    it('VASP "failed" → failReason 이 저장된다', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeStalePendingRequest('req-s22-failed-2', '0xhash-s22-failed-2'));
      vasp.setNextStatus('0xhash-s22-failed-2', { status: 'failed', revertReason: 'some reason' });
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
      await repo.save(makeStalePendingRequest('req-s22-nf', '0xhash-s22-nf'));
      vasp.setNextStatus('0xhash-s22-nf', { status: 'not_found' });
      await svc.pollStaleRequests();
      const r = await repo.findById('req-s22-nf');
      expect(r?.status).toBe('FAILED');
    });

    it('VASP "not_found" → failReason 에 not found 포함', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);
      await repo.save(makeStalePendingRequest('req-s22-nf-2', '0xhash-s22-nf-2'));
      vasp.setNextStatus('0xhash-s22-nf-2', { status: 'not_found' });
      await svc.pollStaleRequests();
      const r = await repo.findById('req-s22-nf-2');
      expect(r?.failReason?.toLowerCase()).toContain('not found');
    });
  });

  describe('[5] Bulkhead — 한 건 에러가 전체 배치를 멈추지 않음', () => {
    it('pollStaleRequests 전체가 throw되지 않는다', async () => {
      const repo  = new InMemoryTxRepository();
      const vasp  = new MockVaspTxClient();
      const svc   = new TxStateMachineService(repo, vasp, wallet);

      await repo.save(makeStalePendingRequest('iso-error',  '0xhash-iso-error'));
      await repo.save(makeStalePendingRequest('iso-fail-1', '0xhash-iso-fail-1'));
      await repo.save(makeStalePendingRequest('iso-fail-2', '0xhash-iso-fail-2'));

      vasp.setNextStatus('0xhash-iso-fail-1', { status: 'failed', revertReason: 'revert A' });
      vasp.setNextStatus('0xhash-iso-fail-2', { status: 'failed', revertReason: 'revert B' });

      const origGetStatus = vasp.getStatus.bind(vasp);
      vasp.getStatus = async (txHash: string) => {
        if (txHash === '0xhash-iso-error') throw new Error('VASP API 타임아웃 시뮬레이션');
        return origGetStatus(txHash);
      };

      await expect(svc.pollStaleRequests()).resolves.toBeDefined(); // throw 없이 완료되면 성공
    });

    it('에러 건 옆 iso-fail-1 은 FAILED 로 전이된다', async () => {
      const repo  = new InMemoryTxRepository();
      const vasp  = new MockVaspTxClient();
      const svc   = new TxStateMachineService(repo, vasp, wallet);

      await repo.save(makeStalePendingRequest('iso-b-error',  '0xhash-b-error'));
      await repo.save(makeStalePendingRequest('iso-b-fail-1', '0xhash-b-fail-1'));
      await repo.save(makeStalePendingRequest('iso-b-fail-2', '0xhash-b-fail-2'));

      vasp.setNextStatus('0xhash-b-fail-1', { status: 'failed', revertReason: 'revert A' });
      vasp.setNextStatus('0xhash-b-fail-2', { status: 'failed', revertReason: 'revert B' });

      const origGetStatus = vasp.getStatus.bind(vasp);
      vasp.getStatus = async (txHash: string) => {
        if (txHash === '0xhash-b-error') throw new Error('timeout');
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
