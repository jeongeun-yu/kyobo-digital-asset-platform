/**
 * S20 채점 — TIMEOUT·REORG 복구 핸들러 구현
 *
 * S20_timeout_reorg_handler.ts 는 export가 없으므로 @kyobo/vasp의 공개 API를 통해
 * TxStateMachineService + VaspRecoveryService 동작을 채점한다.
 *
 * 채점 기준:
 *   · handleTimeout: PENDING → PENDING (retryCount 증가, txHash 교체)
 *   · handleTimeout: 비-PENDING 상태 → no-op (가드 패턴)
 *   · REORG 발생 조건 — MINED 상태에서만 허용
 *   · VaspRecoveryService.handleReorg: MINED → REORGED → RESUBMITTED (성공)
 *   · VaspRecoveryService.handleReorg: 재제출 실패 → FAILED + 알림 발송
 *   · Gas Bump 후 txHash 교체 검증
 */

import type { TxRepository, VaspTxClient, WalletResolver, MintRequest, TxStatus } from '@kyobo/vasp';
import {
  TxStateMachineService,
  VaspRecoveryService,
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

// ── Mock VaspTxClient ─────────────────────────────────────────────────────────

type VaspStatusResult = Awaited<ReturnType<VaspTxClient['getStatus']>>;

class MockVaspTxClient implements VaspTxClient {
  private statusMap = new Map<string, VaspStatusResult>();
  private gasBumpLog: string[] = [];
  private maxRetryReached = false;

  setNextStatus(txHash: string, result: VaspStatusResult): void {
    this.statusMap.set(txHash, result);
  }
  setMaxRetryReached(val: boolean): void {
    this.maxRetryReached = val;
  }

  async submitMint(p: { to: string; tokenId: bigint; amount: bigint; requestId: string }) {
    const raw = Buffer.from(p.requestId).toString('hex');
    return { txHash: `0x${raw.repeat(Math.ceil(64 / raw.length)).slice(0, 64)}` };
  }
  async getStatus(txHash: string): Promise<VaspStatusResult> {
    return this.statusMap.get(txHash) ?? { status: 'pending' };
  }
  async resubmitWithGasBump(txHash: string, pct: number) {
    if (this.maxRetryReached) throw new Error('MaxRetryExceeded');
    const t = Date.now().toString(16);
    const newHash = `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}`;
    this.gasBumpLog.push(newHash);
    return { txHash: newHash };
  }
  getGasBumpLog(): string[] { return this.gasBumpLog; }
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

function makeVaspClientForRecovery(opts: {
  resubmitTxHash?: string;
  alwaysFail?: boolean;
} = {}) {
  const t = Date.now().toString(16);
  const defaultHash = `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}`;
  return {
    async resyncNonce() {},
    async resubmit() {
      if (opts.alwaysFail) throw new Error('VASP unreachable');
      return { txHash: opts.resubmitTxHash ?? defaultHash };
    },
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

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function makeMintReq(id: string, status: TxStatus, txHash = '0x04190000000000000000000000000000000000000000000000000000041900ab'): MintRequest {
  return {
    id,
    userId:     'user-1',
    tokenId:    1001n,
    amount:     1n,
    status,
    txHash,
    retryCount: 0,
    createdAt:  new Date(),
    updatedAt:  new Date(),
  };
}

const wallet = new MockWalletResolver();

// ── 채점 테스트 ───────────────────────────────────────────────────────────────

describe('S20 채점 — TIMEOUT·REORG 복구 핸들러 구현', () => {

  describe('[1] Gas Bump 메커니즘 이해', () => {
    it('TODO: Gas Bump 30% 계산 — 10 gwei → 13 gwei 이상', () => {
      const GAS_BUMP_PERCENT = 30;
      const original = 10;
      const bumped = Math.ceil(original * (1 + GAS_BUMP_PERCENT / 100));
      expect(bumped).toBeGreaterThanOrEqual(13);
    });

    it('TODO: Bump 후 gas price는 원래보다 높다', () => {
      const GAS_BUMP_PERCENT = 30;
      const original = 10;
      const bumped = Math.ceil(original * (1 + GAS_BUMP_PERCENT / 100));
      expect(bumped).toBeGreaterThan(original);
    });

    it('TODO: REVERT는 재시도 불가 — TIMEOUT/REORG는 재시도 가능', () => {
      const isRetryable = (type: 'REVERT' | 'TIMEOUT' | 'REORG') => type !== 'REVERT';
      expect(isRetryable('REVERT')).toBe(false);
      expect(isRetryable('TIMEOUT')).toBe(true);
      expect(isRetryable('REORG')).toBe(true);
    });

    it('TODO: 동일 nonce — 두 TX가 동시에 채굴될 수 없음', () => {
      const canBothBeMined = (tx1: { nonce: number }, tx2: { nonce: number }) =>
        tx1.nonce !== tx2.nonce;
      const tx1 = { nonce: 42, gasPrice: 10 };
      const tx2 = { nonce: 42, gasPrice: 13 };
      expect(canBothBeMined(tx1, tx2)).toBe(false);
    });
  });

  describe('[2] handleTimeout — PENDING → PENDING + gas bump', () => {
    it('TODO: handleTimeout 후 status: PENDING 유지 (아직 미채굴)', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);

      await repo.save(makeMintReq('req-to-1', 'PENDING', '0x01d000000000000000000000000000000000000000000000000000000001d000'));
      await svc.handleTimeout('req-to-1');

      const req = await repo.findById('req-to-1');
      expect(req?.status).toBe('PENDING');
    });

    it('TODO: handleTimeout 후 txHash가 새 값으로 교체됨', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);

      await repo.save(makeMintReq('req-to-2', 'PENDING', '0x01d0ba5e0000000000000000000000000000000000000000000000000001d000'));
      await svc.handleTimeout('req-to-2');

      const req = await repo.findById('req-to-2');
      expect(req?.txHash).not.toBe('0x01d0ba5e0000000000000000000000000000000000000000000000000001d000');
    });

    it('TODO: handleTimeout 후 retryCount 1 증가', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);

      await repo.save(makeMintReq('req-to-3', 'PENDING', '0x9e0d1000000000000000000000000000000000000000000000000000009e0d10'));
      await svc.handleTimeout('req-to-3');

      const req = await repo.findById('req-to-3');
      expect(req?.retryCount).toBe(1);
    });

    it('TODO: handleTimeout — gas bump이 1회 호출됨', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);

      await repo.save(makeMintReq('req-to-4', 'PENDING', '0x9a50b000000000000000000000000000000000000000000000000000009a50b0'));
      await svc.handleTimeout('req-to-4');

      expect(vasp.getGasBumpLog()).toHaveLength(1);
    });

    it('TODO: maxRetries 초과 시 FAILED 전이 또는 예외', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      vasp.setMaxRetryReached(true);
      const svc  = new TxStateMachineService(repo, vasp, wallet);

      await repo.save({ ...makeMintReq('req-to-5', 'PENDING', '0x57a1e000000000000000000000000000000000000000000000000000057a1e00'), retryCount: 3 });

      let failedAfterMaxRetry = false;
      try {
        await svc.handleTimeout('req-to-5');
        const req = await repo.findById('req-to-5');
        failedAfterMaxRetry = req?.status === 'FAILED';
      } catch {
        failedAfterMaxRetry = true;
      }

      expect(failedAfterMaxRetry).toBe(true);
    });

    it('TODO: SUBMITTED 상태에서 handleTimeout → 상태 변경 없음 (가드)', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);

      await repo.save(makeMintReq('req-to-6', 'SUBMITTED', '0x50b00000000000000000000000000000000000000000000000000000050b0000'));
      await svc.handleTimeout('req-to-6');

      const req = await repo.findById('req-to-6');
      expect(req?.status).toBe('SUBMITTED');
    });

    it('TODO: CONFIRMED 상태에서 handleTimeout → 상태 변경 없음 (가드)', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);

      await repo.save(makeMintReq('req-to-7', 'CONFIRMED', '0xc04f10eed0000000000000000000000000000000000000000000000000c04f10'));
      await svc.handleTimeout('req-to-7');

      const req = await repo.findById('req-to-7');
      expect(req?.status).toBe('CONFIRMED');
    });
  });

  describe('[3] REORG 발생 조건 — MINED 상태에서만', () => {
    it('TODO: MINED → REORG 발생 가능', () => {
      const reorgEligible = (status: MintRequest['status']) => status === 'MINED';
      expect(reorgEligible('MINED')).toBe(true);
    });

    it('TODO: PENDING → REORG 발생 불가', () => {
      const reorgEligible = (status: MintRequest['status']) => status === 'MINED';
      expect(reorgEligible('PENDING')).toBe(false);
    });

    it('TODO: SUBMITTED → REORG 발생 불가', () => {
      const reorgEligible = (status: MintRequest['status']) => status === 'MINED';
      expect(reorgEligible('SUBMITTED')).toBe(false);
    });

    it('TODO: CONFIRMED → REORG 발생 불가 (finalized 이후)', () => {
      const reorgEligible = (status: MintRequest['status']) => status === 'MINED';
      expect(reorgEligible('CONFIRMED')).toBe(false);
    });

    it('TODO: FAILED → REORG 발생 불가', () => {
      const reorgEligible = (status: MintRequest['status']) => status === 'MINED';
      expect(reorgEligible('FAILED')).toBe(false);
    });

    it('TODO: CONFIRMED 상태에서 handleReorg → no-op (TxStateMachineService 가드)', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);

      await repo.save(makeMintReq('req-rg-guard', 'CONFIRMED', '0xc04f10eed0000000000000000000000000000000000000000000000000c04f10'));
      await svc.handleReorg('req-rg-guard'); // CONFIRMED → no-op

      const req = await repo.findById('req-rg-guard');
      expect(req?.status).toBe('CONFIRMED');
    }, 10_000);
  });

  describe('[4] VaspRecoveryService.handleReorg — retryWithBackoff + 재제출', () => {
    it('TODO: MINED 상태에서 재제출 성공 → action: RESUBMITTED', async () => {
      const ledger   = makeLedger({ id: 'req-vrg-ok', status: 'MINED', txHash: '0x04190000000000000000000000000000000000000000000000000000041900ab' });
      const vasp     = makeVaspClientForRecovery({ resubmitTxHash: '0x0e7000000000000000000000000000000000000000000000000000000e700000' });
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, vasp, notifier);

      const result = await svc.handleReorg('req-vrg-ok', '0x04190000000000000000000000000000000000000000000000000000041900ab', 12345);
      expect(result.action).toBe('RESUBMITTED');
    });

    it('TODO: 재제출 성공 → newTxHash 반환', async () => {
      const ledger   = makeLedger({ id: 'req-vrg-hash', status: 'MINED', txHash: '0x04190000000000000000000000000000000000000000000000000000041900ab' });
      const vasp     = makeVaspClientForRecovery({ resubmitTxHash: '0x0e7000000000000000000000000000000000000000000000000000000e700000' });
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, vasp, notifier);

      const result = await svc.handleReorg('req-vrg-hash', '0x04190000000000000000000000000000000000000000000000000000041900ab', 12345);
      expect(result.newTxHash).toBe('0x0e7000000000000000000000000000000000000000000000000000000e700000');
    });

    it('TODO: 재제출 성공 → ledger status: SUBMITTED', async () => {
      const ledger   = makeLedger({ id: 'req-vrg-sub', status: 'MINED', txHash: '0x04190000000000000000000000000000000000000000000000000000041900ab' });
      const vasp     = makeVaspClientForRecovery({ resubmitTxHash: '0x0e7000000000000000000000000000000000000000000000000000000e700000' });
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, vasp, notifier);

      await svc.handleReorg('req-vrg-sub', '0x04190000000000000000000000000000000000000000000000000000041900ab', 12345);
      expect(ledger.store.status).toBe('SUBMITTED');
    });

    it('TODO: 재제출 성공 → ledger txHash가 새 값으로 교체됨', async () => {
      const ledger   = makeLedger({ id: 'req-vrg-newhash', status: 'MINED', txHash: '0x04190000000000000000000000000000000000000000000000000000041900ab' });
      const vasp     = makeVaspClientForRecovery({ resubmitTxHash: '0x0e7000000000000000000000000000000000000000000000000000000e700000' });
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, vasp, notifier);

      await svc.handleReorg('req-vrg-newhash', '0x04190000000000000000000000000000000000000000000000000000041900ab', 12345);
      expect(ledger.store.txHash).toBe('0x0e7000000000000000000000000000000000000000000000000000000e700000');
    });

    it('TODO: 재제출 전패 → action: FAILED', async () => {
      const ledger   = makeLedger({ id: 'req-vrg-fail', status: 'MINED', txHash: '0xfa110000000000000000000000000000000000000000000000000000fa110001' });
      const vasp     = makeVaspClientForRecovery({ alwaysFail: true });
      const notifier = makeNotifier();
      const policy   = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1, retryableErrors: [], nonRetryableErrors: [] } as any;
      const svc      = new VaspRecoveryService(ledger as any, vasp, notifier, policy);

      const result = await svc.handleReorg('req-vrg-fail', '0xfa110000000000000000000000000000000000000000000000000000fa110001', 12346);
      expect(result.action).toBe('FAILED');
    });

    it('TODO: 재제출 전패 → ledger status: FAILED', async () => {
      const ledger   = makeLedger({ id: 'req-vrg-status-f', status: 'MINED', txHash: '0xfa110000000000000000000000000000000000000000000000000000fa110002' });
      const vasp     = makeVaspClientForRecovery({ alwaysFail: true });
      const notifier = makeNotifier();
      const policy   = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1, retryableErrors: [], nonRetryableErrors: [] } as any;
      const svc      = new VaspRecoveryService(ledger as any, vasp, notifier, policy);

      await svc.handleReorg('req-vrg-status-f', '0xfa110000000000000000000000000000000000000000000000000000fa110002', 12346);
      expect(ledger.store.status).toBe('FAILED');
    });

    it('TODO: 재제출 전패 → REORG_RESUBMIT_FAILED 알림 발송', async () => {
      const ledger   = makeLedger({ id: 'req-vrg-notify', status: 'MINED', txHash: '0xfa110000000000000000000000000000000000000000000000000000fa110003' });
      const vasp     = makeVaspClientForRecovery({ alwaysFail: true });
      const notifier = makeNotifier();
      const policy   = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1, retryableErrors: [], nonRetryableErrors: [] } as any;
      const svc      = new VaspRecoveryService(ledger as any, vasp, notifier, policy);

      await svc.handleReorg('req-vrg-notify', '0xfa110000000000000000000000000000000000000000000000000000fa110003', 12347);
      const reorgFailedEvent = notifier.sentEvents.find(e => e.type === 'REORG_RESUBMIT_FAILED');
      expect(reorgFailedEvent).toBeDefined();
    });

    it('TODO: MINED 가 아닌 상태(FAILED)에서 handleReorg → Error throw', async () => {
      const ledger   = makeLedger({ id: 'req-vrg-inv', status: 'FAILED', txHash: '0xfa11ed00000000000000000000000000000000000000000000000000fa11ed00' });
      const vasp     = makeVaspClientForRecovery();
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, vasp, notifier);

      await expect(
        svc.handleReorg('req-vrg-inv', '0xfa11ed00000000000000000000000000000000000000000000000000fa11ed00', 12347),
      ).rejects.toThrow();
    });

    it('TODO: SUBMITTED 상태에서 handleReorg → Error throw (MINED에서만 허용)', async () => {
      const ledger   = makeLedger({ id: 'req-vrg-sub-inv', status: 'SUBMITTED', txHash: '0x50b00000000000000000000000000000000000000000000000000000050b0000' });
      const vasp     = makeVaspClientForRecovery();
      const notifier = makeNotifier();
      const svc      = new VaspRecoveryService(ledger as any, vasp, notifier);

      await expect(
        svc.handleReorg('req-vrg-sub-inv', '0x50b00000000000000000000000000000000000000000000000000000050b0000', 12348),
      ).rejects.toThrow(/REORG only valid from MINED/i);
    });
  });

  describe('[5] Gas Bump 이중 채굴 방어', () => {
    it('TODO: 동일 nonce → 두 TX가 동시에 채굴될 수 없음', () => {
      const canBothBeMined = (tx1: { nonce: number }, tx2: { nonce: number }) =>
        tx1.nonce !== tx2.nonce;
      const tx1 = { nonce: 42, gasPrice: 10, requestId: 'req-001' };
      const tx2 = { nonce: 42, gasPrice: 13, requestId: 'req-001' };
      expect(canBothBeMined(tx1, tx2)).toBe(false);
    });

    it('TODO: requestId 첫 처리 → PROCESSED', () => {
      const processedIds = new Set<string>();
      const processEvent = (requestId: string): 'PROCESSED' | 'SKIP' => {
        if (processedIds.has(requestId)) return 'SKIP';
        processedIds.add(requestId);
        return 'PROCESSED';
      };
      expect(processEvent('req-001')).toBe('PROCESSED');
    });

    it('TODO: requestId 중복 처리 → SKIP (멱등성)', () => {
      const processedIds = new Set<string>();
      const processEvent = (requestId: string): 'PROCESSED' | 'SKIP' => {
        if (processedIds.has(requestId)) return 'SKIP';
        processedIds.add(requestId);
        return 'PROCESSED';
      };
      processEvent('req-dup');
      expect(processEvent('req-dup')).toBe('SKIP');
    });

    it('TODO: Gas Bump 후 handleTimeout → txHash 새 값 발급', async () => {
      const repo = new InMemoryTxRepository();
      const vasp = new MockVaspTxClient();
      const svc  = new TxStateMachineService(repo, vasp, wallet);

      await repo.save(makeMintReq('req-bump-new', 'PENDING', '0x041900000000000000000000000000000000000000000000000000009e0d1090'));
      await svc.handleTimeout('req-bump-new');

      const req = await repo.findById('req-bump-new');
      expect(req?.txHash).toBeDefined();
      expect(req?.txHash).not.toBe('0x041900000000000000000000000000000000000000000000000000009e0d1090');
    });
  });
});
