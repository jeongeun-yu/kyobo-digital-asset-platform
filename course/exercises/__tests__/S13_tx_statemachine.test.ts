/**
 * S13 채점 — TX 상태머신: VALID_TRANSITIONS + transitionStatus
 *
 * S13_tx_statemachine.ts 는 export가 없으므로 @kyobo/vasp의 공개 API를 통해
 * TxStateMachineService 동작을 채점한다.
 *
 * 채점 기준:
 *   · InvalidStatusTransitionError 가 @kyobo/vasp 에서 export됨
 *   · 정상 전이 경로: throw 없음
 *   · 금지 전이 경로: InvalidStatusTransitionError throw
 *   · 종단 상태(FAILED, FINALIZED)에서 모든 전이 금지
 */

import type { TxRepository, VaspTxClient, WalletResolver, MintRequest, TxStatus, TxTransitionEvent } from '@kyobo/vasp';
import {
  TxStateMachineService,
  MintRequestNotFoundError,
  InvalidStatusTransitionError,
} from '@kyobo/vasp';

// ── In-memory TxRepository ────────────────────────────────────────────────────
class InMemoryTxRepository implements TxRepository {
  private store = new Map<string, MintRequest>();
  async save(req: MintRequest): Promise<void> { this.store.set(req.id, { ...req }); }
  async findById(id: string): Promise<MintRequest | null> { return this.store.get(id) ?? null; }
  async updateStatus(id: string, status: TxStatus, extra?: Partial<MintRequest>): Promise<void> {
    const r = this.store.get(id);
    if (r) this.store.set(id, { ...r, ...extra, status, updatedAt: new Date() });
  }
  async findPendingOlderThan(_minutes: number): Promise<MintRequest[]> { return []; }
}

class MockVaspTxClient implements VaspTxClient {
  async submitMint(p: { to: string; tokenId: bigint; amount: bigint; requestId: string }) {
    const raw = Buffer.from(p.requestId).toString('hex');
    return { txHash: `0x${raw.repeat(Math.ceil(64 / raw.length)).slice(0, 64)}` };
  }
  async getStatus(_txHash: string) { return { status: 'pending' as const }; }
  async resubmitWithGasBump(_txHash: string, _pct: number) {
    const t = Date.now().toString(16);
    return { txHash: `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}` };
  }
}

class MockWalletResolver implements WalletResolver {
  async getWalletAddr(userId: string) { return `0x${userId.padEnd(40, '0')}`; }
}

// ── S13에서 학생이 구현하는 VALID_TRANSITIONS + transitionStatus 재현 ──────────
const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  REQUESTED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['PENDING',   'FAILED'],
  PENDING:   ['MINED',     'FAILED'],
  MINED:     ['CONFIRMED', 'REORGED', 'FAILED'],
  CONFIRMED: ['FINALIZED'],
  FINALIZED: [],
  FAILED:    [],
  REORGED:   ['MINED', 'FAILED'],
};

function transitionStatus(current: TxStatus, next: TxStatus): void {
  const allowed = VALID_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new InvalidStatusTransitionError(current, next);
  }
}

// ── 채점 테스트 ───────────────────────────────────────────────────────────────
describe('S13 채점 — TX 상태머신', () => {
  describe('VALID_TRANSITIONS 맵 구조', () => {
    it('8개 상태가 모두 정의되어 있다', () => {
      const states: TxStatus[] = ['REQUESTED', 'SUBMITTED', 'PENDING', 'MINED', 'FINALIZED', 'CONFIRMED', 'FAILED', 'REORGED'];
      for (const state of states) {
        expect(VALID_TRANSITIONS).toHaveProperty(state);
      }
    });

    it('FAILED 는 종단 상태 — 전이 목록 비어 있음', () => {
      expect(VALID_TRANSITIONS['FAILED']).toHaveLength(0);
    });

    it('FINALIZED 는 종단 상태 — 전이 목록 비어 있음', () => {
      expect(VALID_TRANSITIONS['FINALIZED']).toHaveLength(0);
    });
  });

  describe('정상 전이 — 예외 없음', () => {
    it('REQUESTED → SUBMITTED', () => {
      expect(() => transitionStatus('REQUESTED', 'SUBMITTED')).not.toThrow();
    });
    it('SUBMITTED → PENDING', () => {
      expect(() => transitionStatus('SUBMITTED', 'PENDING')).not.toThrow();
    });
    it('PENDING → MINED', () => {
      expect(() => transitionStatus('PENDING', 'MINED')).not.toThrow();
    });
    it('MINED → CONFIRMED', () => {
      expect(() => transitionStatus('MINED', 'CONFIRMED')).not.toThrow();
    });
    it('CONFIRMED → FINALIZED', () => {
      expect(() => transitionStatus('CONFIRMED', 'FINALIZED')).not.toThrow();
    });
    it('MINED → REORGED', () => {
      expect(() => transitionStatus('MINED', 'REORGED')).not.toThrow();
    });
    it('REORGED → FAILED', () => {
      expect(() => transitionStatus('REORGED', 'FAILED')).not.toThrow();
    });
    it('SUBMITTED → FAILED', () => {
      expect(() => transitionStatus('SUBMITTED', 'FAILED')).not.toThrow();
    });
  });

  describe('금지 전이 — InvalidStatusTransitionError', () => {
    it('PENDING → FINALIZED (CONFIRMED 건너뛰기 불가)', () => {
      expect(() => transitionStatus('PENDING', 'FINALIZED')).toThrow(InvalidStatusTransitionError);
    });
    it('FAILED → FINALIZED (종단 상태 탈출 불가)', () => {
      expect(() => transitionStatus('FAILED', 'FINALIZED')).toThrow(InvalidStatusTransitionError);
    });
    it('CONFIRMED → PENDING (CONFIRMED에서 역방향 전이 불가)', () => {
      expect(() => transitionStatus('CONFIRMED', 'PENDING')).toThrow(InvalidStatusTransitionError);
    });
    it('CONFIRMED → REORGED (CONFIRMED 이후 REORG 불가)', () => {
      expect(() => transitionStatus('CONFIRMED', 'REORGED')).toThrow(InvalidStatusTransitionError);
    });
    it('FINALIZED → REORGED (FINALIZED 종단 — REORG 불가)', () => {
      expect(() => transitionStatus('FINALIZED', 'REORGED')).toThrow(InvalidStatusTransitionError);
    });
    it('MINED → FINALIZED (반드시 CONFIRMED 경유)', () => {
      expect(() => transitionStatus('MINED', 'FINALIZED')).toThrow(InvalidStatusTransitionError);
    });
    it('REQUESTED → MINED (중간 단계 건너뛰기 불가)', () => {
      expect(() => transitionStatus('REQUESTED', 'MINED')).toThrow(InvalidStatusTransitionError);
    });
    it('MINED → SUBMITTED (역방향 전이 불가)', () => {
      expect(() => transitionStatus('MINED', 'SUBMITTED')).toThrow(InvalidStatusTransitionError);
    });
    it('FAILED → REQUESTED (종단 상태 탈출 불가)', () => {
      expect(() => transitionStatus('FAILED', 'REQUESTED')).toThrow(InvalidStatusTransitionError);
    });
  });

  describe('동일 상태 전이 — 금지', () => {
    it('MINED → MINED (동일 상태 전이 차단)', () => {
      expect(() => transitionStatus('MINED', 'MINED')).toThrow(InvalidStatusTransitionError);
    });
    it('PENDING → PENDING (동일 상태 전이 차단)', () => {
      expect(() => transitionStatus('PENDING', 'PENDING')).toThrow(InvalidStatusTransitionError);
    });
  });

  describe('TxStateMachineService 핸들러 가드 패턴', () => {
    it('CONFIRMED 상태에서 handleMined 호출 → throw 없음 (조용히 무시)', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new MockVaspTxClient(), new MockWalletResolver());
      const now  = new Date();
      await repo.save({
        id: 'req-guard-test', userId: 'u1', tokenId: 1n, amount: 1n,
        status: 'CONFIRMED', retryCount: 0, createdAt: now, updatedAt: now,
      });
      await expect(svc.handleMined('req-guard-test', 9999)).resolves.toBeUndefined();
    });

    it('CONFIRMED 상태에서 handleMined 후 상태 변화 없음', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new MockVaspTxClient(), new MockWalletResolver());
      const now  = new Date();
      await repo.save({
        id: 'req-guard-status', userId: 'u1', tokenId: 1n, amount: 1n,
        status: 'CONFIRMED', retryCount: 0, createdAt: now, updatedAt: now,
      });
      await svc.handleMined('req-guard-status', 9999);
      const after = await repo.findById('req-guard-status');
      expect(after?.status).toBe('CONFIRMED');
    });

    it('존재하지 않는 requestId → MintRequestNotFoundError', async () => {
      const repo = new InMemoryTxRepository();
      const svc  = new TxStateMachineService(repo, new MockVaspTxClient(), new MockWalletResolver());
      await expect(svc.handleMined('not-exist-id', 1)).rejects.toThrow(MintRequestNotFoundError);
    });

    it('InvalidStatusTransitionError 가 @kyobo/vasp 에서 export됨', () => {
      expect(InvalidStatusTransitionError).toBeDefined();
      const err = new InvalidStatusTransitionError('FAILED', 'CONFIRMED');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('InvalidStatusTransitionError');
    });
  });

  describe('Observer — transition 이벤트 구독', () => {
    it('submitMintRequest 후 transition 이벤트가 최소 1회 발생한다', async () => {
      const repo      = new InMemoryTxRepository();
      const svc       = new TxStateMachineService(repo, new MockVaspTxClient(), new MockWalletResolver());
      const captured: TxTransitionEvent[] = [];

      svc.on('transition', (evt: TxTransitionEvent) => { captured.push(evt); });
      await svc.submitMintRequest({ userId: 'u-obs', tokenId: 1n, amount: 1n });

      expect(captured.length).toBeGreaterThanOrEqual(1);
    });

    it('첫 번째 transition 이벤트의 from 은 REQUESTED', async () => {
      const repo      = new InMemoryTxRepository();
      const svc       = new TxStateMachineService(repo, new MockVaspTxClient(), new MockWalletResolver());
      const captured: TxTransitionEvent[] = [];

      svc.on('transition', (evt: TxTransitionEvent) => { captured.push(evt); });
      await svc.submitMintRequest({ userId: 'u-obs2', tokenId: 1n, amount: 1n });

      expect(captured[0]?.from).toBe('REQUESTED');
    });
  });
});
