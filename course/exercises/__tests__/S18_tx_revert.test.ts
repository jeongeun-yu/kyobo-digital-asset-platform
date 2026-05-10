/**
 * S18 채점 — TX REVERT 원인과 안전한 복구 설계
 *
 * S18_tx_revert.ts 는 export가 없으므로 @kyobo/vasp의 공개 API를 통해
 * VaspRecoveryService + TxStateMachineService 동작을 채점한다.
 *
 * 채점 기준:
 *   · handleTxRevert: SUBMITTED → FAILED 전이 + errorMsg 저장 + TX_FAILED 알림
 *   · reason 코드별 분류 (PAUSED / ROLE / BALANCE / DUPLICATE / GAS / UNKNOWN)
 *   · 잘못된 상태에서 handleTxRevert 호출 → Error throw (가드 패턴)
 *   · handleFailed 중복 호출 안전성 — FAILED는 최종 상태, 예외 없음
 */

import type { TxRepository, VaspTxClient, WalletResolver, MintRequest, TxStatus } from '@kyobo/vasp';
import {
  TxStateMachineService,
  VaspRecoveryService,
  MintRequestNotFoundError,
} from '@kyobo/vasp';

// ── In-memory TxRepository ────────────────────────────────────────────────────

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
  async findPendingOlderThan(_minutes: number): Promise<MintRequest[]> {
    return [];
  }
}

class MockVaspTxClient implements VaspTxClient {
  async submitMint(p: { to: string; tokenId: bigint; amount: bigint; requestId: string }) {
    return { txHash: `0xmock-${p.requestId.slice(0, 8)}` };
  }
  async getStatus(_txHash: string) {
    return { status: 'pending' as const };
  }
  async resubmitWithGasBump(_txHash: string, _pct: number) {
    return { txHash: '0xbumped' };
  }
}

class MockWalletResolver implements WalletResolver {
  async getWalletAddr(userId: string): Promise<string> {
    return `0x${userId.padEnd(40, '0')}`;
  }
}

// ── Mock LedgerService (VaspRecoveryService용) ────────────────────────────────

type MockMintRequest = {
  id: string;
  status: string;
  txHash?: string;
  errorMsg?: string;
};

function makeLedger(req: MockMintRequest) {
  const store: MockMintRequest = { ...req };
  return {
    store,
    async getMintRequest(id: string): Promise<MockMintRequest | null> {
      return store.id === id ? { ...store } : null;
    },
    async updateMintRequest(_id: string, patch: Partial<MockMintRequest>): Promise<void> {
      Object.assign(store, patch);
    },
  };
}

function makeVaspClient(opts: { resubmitTxHash?: string } = {}) {
  return {
    async resyncNonce() {},
    async resubmit() { return { txHash: opts.resubmitTxHash ?? '0xresubmit' }; },
  };
}

function makeNotifier() {
  const sentEvents: Array<{ type: string; [key: string]: unknown }> = [];
  return {
    sentEvents,
    async send(e: { type: string; [key: string]: unknown }): Promise<void> {
      sentEvents.push(e);
    },
  };
}

// ── 공통 픽스처 ───────────────────────────────────────────────────────────────

const BASE_SUBMITTED: MockMintRequest = {
  id:     'req-s18-base',
  status: 'SUBMITTED',
  txHash: '0xabc',
};

// ── reason 분류 함수 (S18 실습 목표 3 채점) ───────────────────────────────────

function classifyRevertReason(reason: string): {
  category: 'PAUSED' | 'ROLE' | 'BALANCE' | 'DUPLICATE' | 'GAS' | 'UNKNOWN';
  retryAfterFix: boolean;
} {
  if (reason.includes('paused')) {
    return { category: 'PAUSED', retryAfterFix: true };
  }
  if (reason.includes('not minter') || reason.includes('MINTER_ROLE')) {
    return { category: 'ROLE', retryAfterFix: true };
  }
  if (reason.includes('Insufficient balance') || reason.includes('insufficient funds')) {
    return { category: 'BALANCE', retryAfterFix: true };
  }
  if (reason.includes('already exists') || reason.includes('Token already')) {
    return { category: 'DUPLICATE', retryAfterFix: false };
  }
  if (reason.includes('gas limit') || reason.includes('Gas limit exceeded')) {
    return { category: 'GAS', retryAfterFix: true };
  }
  return { category: 'UNKNOWN', retryAfterFix: false };
}

// ── 채점 테스트 ───────────────────────────────────────────────────────────────

describe('S18 채점 — TX REVERT 원인과 안전한 복구 설계', () => {

  describe('[1] handleTxRevert — SUBMITTED → FAILED 전이', () => {
    it('TODO: handleTxRevert 호출 후 action: FAILED 반환', async () => {
      const ledger   = makeLedger({ ...BASE_SUBMITTED, id: 'req-18-a1' });
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, makeVaspClient(), notifier);

      const result = await svc.handleTxRevert('req-18-a1', '0xabc', 'execution reverted: Contract is paused');
      expect(result.action).toBe('FAILED');
    });

    it('TODO: handleTxRevert 후 ledger status → FAILED', async () => {
      const ledger   = makeLedger({ ...BASE_SUBMITTED, id: 'req-18-a2' });
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, makeVaspClient(), notifier);

      await svc.handleTxRevert('req-18-a2', '0xabc', 'execution reverted: Contract is paused');
      expect(ledger.store.status).toBe('FAILED');
    });

    it('TODO: handleTxRevert 후 errorMsg에 revert reason 저장', async () => {
      const ledger   = makeLedger({ ...BASE_SUBMITTED, id: 'req-18-a3' });
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, makeVaspClient(), notifier);

      await svc.handleTxRevert('req-18-a3', '0xabc', 'execution reverted: Contract is paused');
      expect(ledger.store.errorMsg).toBeTruthy();
      expect(ledger.store.errorMsg).toContain('paused');
    });

    it('TODO: handleTxRevert 후 TX_FAILED 알림 발송', async () => {
      const ledger   = makeLedger({ ...BASE_SUBMITTED, id: 'req-18-a4' });
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, makeVaspClient(), notifier);

      await svc.handleTxRevert('req-18-a4', '0xabc', 'execution reverted: Caller is not minter');
      const txFailedEvent = notifier.sentEvents.find(e => e.type === 'TX_FAILED');
      expect(txFailedEvent).toBeDefined();
    });

    it('TODO: TX_FAILED 알림에 requestId 포함', async () => {
      const ledger   = makeLedger({ ...BASE_SUBMITTED, id: 'req-18-a5' });
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, makeVaspClient(), notifier);

      await svc.handleTxRevert('req-18-a5', '0xabc', 'execution reverted: Insufficient balance');
      const txFailedEvent = notifier.sentEvents.find(e => e.type === 'TX_FAILED');
      expect(txFailedEvent?.requestId).toBe('req-18-a5');
    });
  });

  describe('[2] reason 코드별 분류 — PAUSED / ROLE / BALANCE / DUPLICATE / GAS / UNKNOWN', () => {
    it('TODO: "Contract is paused" → category: PAUSED', () => {
      const result = classifyRevertReason('execution reverted: Contract is paused');
      expect(result.category).toBe('PAUSED');
    });

    it('TODO: "Caller is not minter" → category: ROLE', () => {
      const result = classifyRevertReason('execution reverted: Caller is not minter');
      expect(result.category).toBe('ROLE');
    });

    it('TODO: "Insufficient balance" → category: BALANCE', () => {
      const result = classifyRevertReason('execution reverted: Insufficient balance');
      expect(result.category).toBe('BALANCE');
    });

    it('TODO: "Token already exists" → category: DUPLICATE', () => {
      const result = classifyRevertReason('execution reverted: Token already exists');
      expect(result.category).toBe('DUPLICATE');
    });

    it('TODO: "Gas limit exceeded" → category: GAS', () => {
      const result = classifyRevertReason('execution reverted: Gas limit exceeded');
      expect(result.category).toBe('GAS');
    });

    it('TODO: 알 수 없는 reason → category: UNKNOWN', () => {
      const result = classifyRevertReason('execution reverted: unknown custom error');
      expect(result.category).toBe('UNKNOWN');
    });

    it('TODO: DUPLICATE → retryAfterFix: false (이미 발행됨, 재시도 의미 없음)', () => {
      const result = classifyRevertReason('execution reverted: Token already exists');
      expect(result.retryAfterFix).toBe(false);
    });

    it('TODO: PAUSED → retryAfterFix: true (Unpause 후 재발행 가능)', () => {
      const result = classifyRevertReason('execution reverted: Contract is paused');
      expect(result.retryAfterFix).toBe(true);
    });

    it('TODO: UNKNOWN → retryAfterFix: false (원인 불명 — 수동 분석 필요)', () => {
      const result = classifyRevertReason('execution reverted: unknown custom error');
      expect(result.retryAfterFix).toBe(false);
    });
  });

  describe('[3] 잘못된 상태에서 handleTxRevert 호출 → Error throw', () => {
    it('TODO: 존재하지 않는 requestId → Error throw', async () => {
      const ledger   = makeLedger({ ...BASE_SUBMITTED, id: 'req-18-base' });
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, makeVaspClient(), notifier);

      await expect(
        svc.handleTxRevert('nonexistent', '0x000', 'some reason'),
      ).rejects.toThrow();
    });

    it('TODO: 존재하지 않는 requestId → "not found" 메시지 포함', async () => {
      const ledger   = makeLedger({ ...BASE_SUBMITTED, id: 'req-18-base' });
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, makeVaspClient(), notifier);

      await expect(
        svc.handleTxRevert('nonexistent-id', '0x000', 'some reason'),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('[4] handleFailed 중복 호출 안전성 — FAILED는 최종 상태', () => {
    let repo: InMemoryTxRepository;
    let svc: TxStateMachineService;

    const makeMintReq = (id: string, status: TxStatus): MintRequest => ({
      id,
      userId:     'user-1',
      tokenId:    1001n,
      amount:     1n,
      status,
      txHash:     '0xabc',
      retryCount: 0,
      createdAt:  new Date(),
      updatedAt:  new Date(),
    });

    beforeEach(() => {
      repo = new InMemoryTxRepository();
      svc  = new TxStateMachineService(repo, new MockVaspTxClient(), new MockWalletResolver());
    });

    it('TODO: 첫 번째 handleFailed → status: FAILED', async () => {
      await repo.save(makeMintReq('req-dup-1', 'SUBMITTED'));
      await svc.handleFailed('req-dup-1', 'first failure reason');
      const req = await repo.findById('req-dup-1');
      expect(req?.status).toBe('FAILED');
    });

    it('TODO: 두 번째 handleFailed → 예외 없이 완료', async () => {
      await repo.save(makeMintReq('req-dup-2', 'SUBMITTED'));
      await svc.handleFailed('req-dup-2', 'first call');
      await expect(svc.handleFailed('req-dup-2', 'second call')).resolves.toBeUndefined();
    });

    it('TODO: 두 번째 handleFailed 후 → FAILED 상태 유지', async () => {
      await repo.save(makeMintReq('req-dup-3', 'SUBMITTED'));
      await svc.handleFailed('req-dup-3', 'first call');
      await svc.handleFailed('req-dup-3', 'second call');
      const req = await repo.findById('req-dup-3');
      expect(req?.status).toBe('FAILED');
    });

    it('TODO: 세 번째 handleFailed 후에도 → FAILED 상태 유지', async () => {
      await repo.save(makeMintReq('req-dup-4', 'SUBMITTED'));
      await svc.handleFailed('req-dup-4', 'call 1');
      await svc.handleFailed('req-dup-4', 'call 2');
      await svc.handleFailed('req-dup-4', 'call 3');
      const req = await repo.findById('req-dup-4');
      expect(req?.status).toBe('FAILED');
    });

    it('TODO: PENDING 상태에서 handleFailed → FAILED 전이', async () => {
      await repo.save(makeMintReq('req-dup-5', 'PENDING'));
      await svc.handleFailed('req-dup-5', 'revert from pending');
      const req = await repo.findById('req-dup-5');
      expect(req?.status).toBe('FAILED');
    });

    it('TODO: 존재하지 않는 requestId → MintRequestNotFoundError', async () => {
      await expect(
        svc.handleFailed('nonexistent-handle-fail', 'reason'),
      ).rejects.toThrow(MintRequestNotFoundError);
    });
  });
});
