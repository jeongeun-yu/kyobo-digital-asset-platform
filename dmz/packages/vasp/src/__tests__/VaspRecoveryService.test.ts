/**
 * VaspRecoveryService 단위 테스트
 *
 * REVERT/TIMEOUT/NonceConflict/REORG 복구 전략 검증
 */

import { VaspRecoveryService, type RetryPolicy } from '../recovery/VaspRecoveryService';

// ── Mock LedgerService ────────────────────────────────────────────────────────

type MockMintRequest = {
  id: string;
  status: string;
  txHash?: string;
  errorMsg?: string;
};

function makeLedger(req: MockMintRequest) {
  const store = { ...req };
  return {
    store,
    async getMintRequest(id: string) {
      return store.id === id ? { ...store } : null;
    },
    async updateMintRequest(_id: string, patch: Partial<MockMintRequest>) {
      Object.assign(store, patch);
    },
  };
}

function makeVaspClient(opts: { resubmitTxHash?: string } = {}) {
  return {
    nonceSynced: false,
    async resyncNonce() { this.nonceSynced = true; },
    async resubmit()   { return { txHash: opts.resubmitTxHash ?? '0xresubmit' }; },
  };
}

function makeNotifier() {
  const events: unknown[] = [];
  return { events, async send(e: unknown) { events.push(e); } };
}

const BASE_REQ: MockMintRequest = {
  id:     'req-001',
  status: 'SUBMITTED',
  txHash: '0xoriginal',
};

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('VaspRecoveryService.handleTxRevert()', () => {
  it('action: FAILED 반환', async () => {
    const ledger   = makeLedger(BASE_REQ);
    const notifier = makeNotifier();
    const svc      = new VaspRecoveryService(ledger as any, makeVaspClient(), notifier);

    const result = await svc.handleTxRevert('req-001', '0xoriginal', 'execution reverted');
    expect(result.action).toBe('FAILED');
    expect(result.requestId).toBe('req-001');
  });

  it('ledger status → FAILED로 업데이트', async () => {
    const ledger = makeLedger(BASE_REQ);
    const svc    = new VaspRecoveryService(ledger as any, makeVaspClient(), makeNotifier());

    await svc.handleTxRevert('req-001', '0xoriginal', 'REVERT');
    expect(ledger.store.status).toBe('FAILED');
  });

  it('TX_FAILED 알림 발송', async () => {
    const ledger   = makeLedger(BASE_REQ);
    const notifier = makeNotifier();
    const svc      = new VaspRecoveryService(ledger as any, makeVaspClient(), notifier);

    await svc.handleTxRevert('req-001', '0xoriginal', 'REVERT');
    expect(notifier.events).toHaveLength(1);
    const ev = notifier.events[0] as any;
    expect(ev.type).toBe('TX_FAILED');
  });

  it('존재하지 않는 requestId → Error throw', async () => {
    const ledger = makeLedger(BASE_REQ);
    const svc    = new VaspRecoveryService(ledger as any, makeVaspClient(), makeNotifier());

    await expect(svc.handleTxRevert('nonexistent', '0xtx', 'reason')).rejects.toThrow('not found');
  });
});

describe('VaspRecoveryService.handleTxTimeout()', () => {
  it('action: POLLING 반환', async () => {
    const ledger = makeLedger(BASE_REQ);
    const svc    = new VaspRecoveryService(ledger as any, makeVaspClient(), makeNotifier());

    const result = await svc.handleTxTimeout('req-001', '0xoriginal');
    expect(result.action).toBe('POLLING');
  });

  it('TX_TIMEOUT_ALERT 알림 발송', async () => {
    const ledger   = makeLedger(BASE_REQ);
    const notifier = makeNotifier();
    const svc      = new VaspRecoveryService(ledger as any, makeVaspClient(), notifier);

    await svc.handleTxTimeout('req-001', '0xoriginal');
    const ev = notifier.events[0] as any;
    expect(ev.type).toBe('TX_TIMEOUT_ALERT');
  });
});

describe('VaspRecoveryService.handleNonceConflict()', () => {
  it('action: RESUBMITTED + newTxHash 반환', async () => {
    const ledger    = makeLedger(BASE_REQ);
    const vaspClient = makeVaspClient({ resubmitTxHash: '0xnew-nonce' });
    const svc        = new VaspRecoveryService(ledger as any, vaspClient, makeNotifier());

    const result = await svc.handleNonceConflict('req-001');
    expect(result.action).toBe('RESUBMITTED');
    expect(result.newTxHash).toBe('0xnew-nonce');
  });

  it('resyncNonce가 호출됨', async () => {
    const ledger     = makeLedger(BASE_REQ);
    const vaspClient = makeVaspClient();
    const svc        = new VaspRecoveryService(ledger as any, vaspClient, makeNotifier());

    await svc.handleNonceConflict('req-001');
    expect(vaspClient.nonceSynced).toBe(true);
  });

  it('ledger status → SUBMITTED + 새 txHash 업데이트', async () => {
    const ledger     = makeLedger(BASE_REQ);
    const vaspClient = makeVaspClient({ resubmitTxHash: '0xnew-nonce' });
    const svc        = new VaspRecoveryService(ledger as any, vaspClient, makeNotifier());

    await svc.handleNonceConflict('req-001');
    expect(ledger.store.status).toBe('SUBMITTED');
    expect(ledger.store.txHash).toBe('0xnew-nonce');
  });
});

describe('VaspRecoveryService.handleReorg()', () => {
  it('MINED 상태 → REORGED 전이 후 재제출 성공 시 RESUBMITTED', async () => {
    const req    = { ...BASE_REQ, status: 'MINED', txHash: '0xmined' };
    const ledger = makeLedger(req);
    const svc    = new VaspRecoveryService(ledger as any, makeVaspClient({ resubmitTxHash: '0xafter-reorg' }), makeNotifier());

    const result = await svc.handleReorg('req-001', '0xmined', 18_500_100);
    expect(result.action).toBe('RESUBMITTED');
    expect(result.newTxHash).toBe('0xafter-reorg');
  });

  it('MINED 상태가 아닌 경우 → Error throw', async () => {
    const ledger = makeLedger(BASE_REQ);  // status = 'SUBMITTED'
    const svc    = new VaspRecoveryService(ledger as any, makeVaspClient(), makeNotifier());

    await expect(svc.handleReorg('req-001', '0xtx', 100))
      .rejects.toThrow('REORG only valid from MINED');
  });

  it('재제출 실패 → action: FAILED + REORG_RESUBMIT_FAILED 알림', async () => {
    const req      = { ...BASE_REQ, status: 'MINED', txHash: '0xmined' };
    const ledger   = makeLedger(req);
    const vaspClient = {
      async resyncNonce() {},
      async resubmit()   { throw new Error('VASP unreachable'); },
    };
    const notifier = makeNotifier();
    const policy: RetryPolicy = {
      maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1,
      retryableErrors: [], nonRetryableErrors: [],
    };
    const svc = new VaspRecoveryService(ledger as any, vaspClient, notifier, policy);

    const result = await svc.handleReorg('req-001', '0xmined', 100);
    expect(result.action).toBe('FAILED');
    const ev = notifier.events.find((e: any) => e.type === 'REORG_RESUBMIT_FAILED');
    expect(ev).toBeDefined();
  });
});

describe('VaspRecoveryService.retryWithBackoff()', () => {
  it('첫 번째 시도 성공 → 결과 반환', async () => {
    const svc = new VaspRecoveryService({} as any, {} as any, {} as any);
    const result = await svc.retryWithBackoff(async () => 'value');
    expect(result).toBe('value');
  });

  it('maxAttempts 초과 → 에러 throw', async () => {
    const policy: RetryPolicy = {
      maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1,
      retryableErrors: [], nonRetryableErrors: [],
    };
    const svc = new VaspRecoveryService({} as any, {} as any, {} as any, policy);

    let attempts = 0;
    await expect(svc.retryWithBackoff(async () => {
      attempts++;
      throw new Error('always fail');
    }, policy)).rejects.toThrow('always fail');

    expect(attempts).toBe(2);
  });
});
