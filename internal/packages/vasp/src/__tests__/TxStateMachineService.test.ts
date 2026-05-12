/**
 * TxStateMachineService 단위 테스트
 *
 * REQUESTED→SUBMITTED→MINED→FINALIZED→CONFIRMED 정상 흐름,
 * FAILED/REORG 비정상 흐름, Observer 이벤트, pollStaleRequests 검증
 */

import {
  TxStateMachineService,
  MintRequestNotFoundError,
  type MintRequest,
  type TxRepository,
  type VaspTxClient,
  type WalletResolver,
  type TxStatus,
  type TxTransitionEvent,
} from '../tx/TxStateMachineService';

// ── In-Memory Repository ────────────────────────────────────────────────────

function makeRepo(): TxRepository & { store: Map<string, MintRequest> } {
  const store = new Map<string, MintRequest>();

  return {
    store,
    async save(req)  { store.set(req.id, { ...req }); },
    async findById(id) { return store.get(id) ?? null; },
    async updateStatus(id, status, extra = {}) {
      const req = store.get(id);
      if (req) store.set(id, { ...req, status, ...extra, updatedAt: new Date() });
    },
    async findPendingOlderThan(minutes) {
      const cutoff = new Date(Date.now() - minutes * 60_000);
      return [...store.values()].filter(r =>
        (r.status === 'PENDING' || r.status === 'MINED') && r.createdAt < cutoff
      );
    },
  };
}

function makeVasp(opts: {
  txHash?: string;
  statusResponse?: { status: 'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found'; blockNumber?: number; revertReason?: string };
} = {}): VaspTxClient {
  return {
    async submitMint() {
      return { txHash: opts.txHash ?? '0xvasp-tx' };
    },
    async getStatus() {
      return opts.statusResponse ?? { status: 'pending' };
    },
    async resubmitWithGasBump() {
      return { txHash: '0xbumped-tx' };
    },
  };
}

function makeWallet(): WalletResolver {
  return {
    async getWalletAddr(userId) { return `0xwallet-${userId}`; },
  };
}

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('TxStateMachineService.submitMintRequest()', () => {
  it('requestId(UUID) 반환', async () => {
    const svc = new TxStateMachineService(makeRepo(), makeVasp(), makeWallet());
    const id = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('SUBMITTED 상태로 저장 + txHash 세팅', async () => {
    const repo = makeRepo();
    const svc  = new TxStateMachineService(repo, makeVasp({ txHash: '0xfirst' }), makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });
    const req  = await repo.findById(id);
    expect(req?.status).toBe('SUBMITTED');
    expect(req?.txHash).toBe('0xfirst');
  });

  it('VASP 전송 실패 → FAILED 전이 후 에러 throw', async () => {
    const vasp = { ...makeVasp(), async submitMint() { throw new Error('VASP down'); } };
    const svc  = new TxStateMachineService(makeRepo(), vasp, makeWallet());
    await expect(svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n })).rejects.toThrow('VASP down');
  });

  it('transition 이벤트 REQUESTED→SUBMITTED 방출', async () => {
    const transitions: TxTransitionEvent[] = [];
    const svc = new TxStateMachineService(makeRepo(), makeVasp(), makeWallet());
    svc.on('transition', (e: TxTransitionEvent) => transitions.push(e));

    await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });

    const submitted = transitions.find(t => t.to === 'SUBMITTED');
    expect(submitted).toBeDefined();
    expect(submitted?.from).toBe('REQUESTED');
  });
});

describe('TxStateMachineService.handleMined()', () => {
  it('SUBMITTED → MINED 전이', async () => {
    const repo = makeRepo();
    const svc  = new TxStateMachineService(repo, makeVasp(), makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });

    await svc.handleMined(id, 18_500_001);
    const req = await repo.findById(id);
    expect(req?.status).toBe('MINED');
    expect(req?.blockNumber).toBe(18_500_001);
  });

  it('존재하지 않는 requestId → MintRequestNotFoundError', async () => {
    const svc = new TxStateMachineService(makeRepo(), makeVasp(), makeWallet());
    await expect(svc.handleMined('nonexistent', 100)).rejects.toThrow(MintRequestNotFoundError);
  });

  it('이미 CONFIRMED인 상태 → 전이 스킵(무시)', async () => {
    const repo = makeRepo();
    const svc  = new TxStateMachineService(repo, makeVasp(), makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });
    await svc.handleMined(id, 100);
    await svc.handleFinalized(id);
    await svc.handleConfirmed(id);

    // CONFIRMED에서 다시 MINED 무시
    await svc.handleMined(id, 200);
    expect((await repo.findById(id))?.status).toBe('CONFIRMED');
  });
});

describe('TxStateMachineService.handleFinalized() / handleConfirmed()', () => {
  it('MINED → FINALIZED → CONFIRMED 순차 전이', async () => {
    const repo = makeRepo();
    const svc  = new TxStateMachineService(repo, makeVasp(), makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });

    await svc.handleMined(id, 100);
    await svc.handleFinalized(id);
    await svc.handleConfirmed(id);

    expect((await repo.findById(id))?.status).toBe('CONFIRMED');
  });

  it('MINED가 아닌 상태에서 handleFinalized → 전이 스킵', async () => {
    const repo = makeRepo();
    const svc  = new TxStateMachineService(repo, makeVasp(), makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });

    // SUBMITTED에서 FINALIZED 호출 → 무시
    await svc.handleFinalized(id);
    expect((await repo.findById(id))?.status).toBe('SUBMITTED');
  });
});

describe('TxStateMachineService.handleFailed()', () => {
  it('any 상태 → FAILED + failReason 저장', async () => {
    const repo = makeRepo();
    const svc  = new TxStateMachineService(repo, makeVasp(), makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });
    await svc.handleFailed(id, 'execution reverted: SFT_LIMIT_EXCEEDED');

    const req = await repo.findById(id);
    expect(req?.status).toBe('FAILED');
    expect(req?.failReason).toContain('execution reverted');
  });
});

describe('TxStateMachineService.handleTimeout()', () => {
  it('PENDING 상태 → gas bump 후 PENDING 유지 + retryCount++', async () => {
    const repo = makeRepo();
    const svc  = new TxStateMachineService(repo, makeVasp({ txHash: '0xoriginal' }), makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });

    // SUBMITTED → 수동으로 PENDING 상태로 변경
    await repo.updateStatus(id, 'PENDING', { txHash: '0xoriginal' });

    await svc.handleTimeout(id);
    const req = await repo.findById(id);
    expect(req?.status).toBe('PENDING');
    expect(req?.txHash).toBe('0xbumped-tx');
    expect(req?.retryCount).toBeGreaterThan(0);
  });

  it('PENDING이 아닌 상태에서 handleTimeout → 전이 스킵', async () => {
    const repo = makeRepo();
    const svc  = new TxStateMachineService(repo, makeVasp(), makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });

    // SUBMITTED에서 timeout 호출 → 무시
    await svc.handleTimeout(id);
    expect((await repo.findById(id))?.status).toBe('SUBMITTED');
  });
});

describe('TxStateMachineService.pollStaleRequests()', () => {
  it('MINED + 31분 초과 + VASP confirmed → CONFIRMED 전이', async () => {
    const repo = makeRepo();
    const vasp = makeVasp({ statusResponse: { status: 'confirmed' } });
    const svc  = new TxStateMachineService(repo, vasp, makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });

    // 31분 전 MINED 상태로 조작 (handleConfirmed는 MINED에서만 전이)
    const req = repo.store.get(id)!;
    req.createdAt = new Date(Date.now() - 31 * 60_000);
    req.status    = 'MINED';
    req.txHash    = '0xstale';
    repo.store.set(id, req);

    const { processed } = await svc.pollStaleRequests();
    expect(processed).toBe(1);
    expect((await repo.findById(id))?.status).toBe('CONFIRMED');
  });

  it('PENDING + 31분 초과 + VASP not_found → FAILED 전이', async () => {
    const repo = makeRepo();
    const vasp = makeVasp({ statusResponse: { status: 'not_found' } });
    const svc  = new TxStateMachineService(repo, vasp, makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });

    const req = repo.store.get(id)!;
    req.createdAt = new Date(Date.now() - 31 * 60_000);
    req.status    = 'PENDING';
    req.txHash    = '0xstale';
    repo.store.set(id, req);

    await svc.pollStaleRequests();
    expect((await repo.findById(id))?.status).toBe('FAILED');
  });

  it('stale 없으면 processed = 0', async () => {
    const svc = new TxStateMachineService(makeRepo(), makeVasp(), makeWallet());
    const { processed } = await svc.pollStaleRequests();
    expect(processed).toBe(0);
  });
});

describe('TxStateMachineService — Observer 이벤트', () => {
  it('CONFIRMED 전이 시 transition 이벤트 방출', async () => {
    const events: TxTransitionEvent[] = [];
    const svc = new TxStateMachineService(makeRepo(), makeVasp(), makeWallet());
    svc.on('transition', (e: TxTransitionEvent) => events.push(e));

    const id = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });
    await svc.handleMined(id, 100);
    await svc.handleFinalized(id);
    await svc.handleConfirmed(id);

    const confirmed = events.find(e => e.to === 'CONFIRMED');
    expect(confirmed).toBeDefined();
    expect(confirmed?.requestId).toBe(id);
  });
});

describe('TxStateMachineService.pollStaleRequests() — 추가 브랜치', () => {
  it('VASP failed → FAILED 전이 + revertReason 저장', async () => {
    const repo = makeRepo();
    const vasp = makeVasp({ statusResponse: { status: 'failed', revertReason: 'out of gas' } });
    const svc  = new TxStateMachineService(repo, vasp, makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });

    const req = repo.store.get(id)!;
    req.createdAt = new Date(Date.now() - 31 * 60_000);
    req.status    = 'PENDING';
    req.txHash    = '0xstale';
    repo.store.set(id, req);

    const { processed } = await svc.pollStaleRequests();
    expect(processed).toBe(1);
    expect((await repo.findById(id))?.status).toBe('FAILED');
    expect((await repo.findById(id))?.failReason).toContain('out of gas');
  });

  it('getStatus() throw → catch 처리 후 processed 카운트 안 함', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const repo = makeRepo();
    const vasp: VaspTxClient = {
      async submitMint() { return { txHash: '0xtx' }; },
      async getStatus()  { throw new Error('VASP timeout'); },
      async resubmitWithGasBump() { return { txHash: '0xbumped' }; },
    };
    const svc = new TxStateMachineService(repo, vasp, makeWallet());
    const id  = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });

    const req = repo.store.get(id)!;
    req.createdAt = new Date(Date.now() - 31 * 60_000);
    req.status    = 'PENDING';
    req.txHash    = '0xtx';
    repo.store.set(id, req);

    const { processed } = await svc.pollStaleRequests();
    expect(processed).toBe(0);
    consoleSpy.mockRestore();
  });

  it('txHash 없는 stale 건 → 스킵 (processed 카운트 안 함)', async () => {
    const repo = makeRepo();
    const svc  = new TxStateMachineService(repo, makeVasp(), makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });

    const req = repo.store.get(id)!;
    req.createdAt = new Date(Date.now() - 31 * 60_000);
    req.status    = 'PENDING';
    req.txHash    = undefined;
    repo.store.set(id, req);

    const { processed } = await svc.pollStaleRequests();
    expect(processed).toBe(0);
  });
});

describe('TxStateMachineService.handleReorg()', () => {
  async function setupMined(repo: ReturnType<typeof makeRepo>, svc: TxStateMachineService) {
    const id = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });
    await svc.handleMined(id, 100);
    return id;
  }

  it('MINED → REORGED → MINED 복귀 (vasp mined)', async () => {
    const repo = makeRepo();
    const vasp = makeVasp({ statusResponse: { status: 'mined' } });
    const svc  = new TxStateMachineService(repo, vasp, makeWallet());
    jest.spyOn(svc as any, '_waitBlocks').mockResolvedValue(undefined);

    const id = await setupMined(repo, svc);
    await svc.handleReorg(id);

    expect((await repo.findById(id))?.status).toBe('MINED');
  });

  it('MINED → REORGED → FAILED (vasp not_found)', async () => {
    const repo = makeRepo();
    const vasp = makeVasp({ statusResponse: { status: 'not_found' } });
    const svc  = new TxStateMachineService(repo, vasp, makeWallet());
    jest.spyOn(svc as any, '_waitBlocks').mockResolvedValue(undefined);

    const id = await setupMined(repo, svc);
    await svc.handleReorg(id);

    const req = await repo.findById(id);
    expect(req?.status).toBe('FAILED');
    expect(req?.failReason).toContain('reorg');
  });

  it('MINED가 아닌 상태 → 즉시 리턴 (전이 없음)', async () => {
    const repo = makeRepo();
    const svc  = new TxStateMachineService(repo, makeVasp(), makeWallet());
    const id   = await svc.submitMintRequest({ userId: 'u-001', tokenId: 1n, amount: 1n });

    await svc.handleReorg(id); // SUBMITTED 상태 → 스킵
    expect((await repo.findById(id))?.status).toBe('SUBMITTED');
  });
});
