/**
 * S22 실습 — pollStaleRequests 통합 테스트
 *
 * 모든 시나리오의 진입점은 pollStaleRequests() 다.
 * 핸들러(handleFailed, handleConfirmed 등)를 직접 호출하는 건
 * 단위 테스트이며 이 실습의 범위가 아니다.
 *
 * 실행 방법 (루트에서):
 *   npm run exercise:s22      → 전체 실행
 *   npm run exercise:s22:1    → [1] REVERT
 *   npm run exercise:s22:2    → [2] NOT_FOUND
 *   npm run exercise:s22:3    → [3] 콜백 차단 E2E
 *   npm run exercise:s22:4    → [4] TIMEOUT
 *   npm run exercise:s22:5    → [5] Idempotency
 *   npm run exercise:s22:6    → [6] Bulkhead
 */

import type {
  TxRepository,
  VaspTxClient,
  WalletResolver,
  MintRequest,
  TxStatus,
} from '@kyobo/vasp';
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
    const existing = this.store.get(id);
    if (!existing) return;
    this.store.set(id, { ...existing, ...extra, status, updatedAt: new Date() });
  }

  async findPendingOlderThan(minutes: number): Promise<MintRequest[]> {
    const cutoff = new Date(Date.now() - minutes * 60_000);
    return [...this.store.values()].filter(
      r => r.status === 'PENDING' && r.createdAt < cutoff,
    );
  }
}

// ── MockVaspTxClient ──────────────────────────────────────────────────────────

type VaspStatusResult = Awaited<ReturnType<VaspTxClient['getStatus']>>;

class MockVaspTxClient implements VaspTxClient {
  private statusMap  = new Map<string, VaspStatusResult>();
  private gasBumpLog: string[] = [];

  setNextStatus(txHash: string, result: VaspStatusResult): void {
    this.statusMap.set(txHash, result);
  }

  async submitMint(params: { to: string; tokenId: bigint; amount: bigint; requestId: string }): Promise<{ txHash: string }> {
    const raw = Buffer.from(params.requestId).toString('hex');
    return { txHash: `0x${raw.repeat(Math.ceil(64 / raw.length)).slice(0, 64)}` };
  }

  async getStatus(txHash: string): Promise<VaspStatusResult> {
    return this.statusMap.get(txHash) ?? { status: 'pending' };
  }

  async resubmitWithGasBump(txHash: string, gasBumpPercent: number): Promise<{ txHash: string }> {
    const t       = Date.now().toString(16);
    const newHash = `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}`;
    this.gasBumpLog.push(`${txHash} → ${newHash} (+${gasBumpPercent}%)`);
    return { txHash: newHash };
  }

  getGasBumpLog(): string[] { return this.gasBumpLog; }
}

// ── MockWalletResolver ────────────────────────────────────────────────────────

class MockWalletResolver implements WalletResolver {
  async getWalletAddr(userId: string): Promise<string> {
    return `0x${userId.padEnd(40, '0')}`;
  }
}

// ── 테스트 데이터 팩토리 ──────────────────────────────────────────────────────

function makeStalePending(id: string, txHash: string): MintRequest {
  const staleDate = new Date(Date.now() - 35 * 60_000);
  return {
    id, userId: `user-${id}`, tokenId: 1n, amount: 1n,
    status: 'PENDING', txHash, retryCount: 0,
    createdAt: staleDate, updatedAt: staleDate,
  };
}

// ── 섹션 함수 ─────────────────────────────────────────────────────────────────

async function section1(): Promise<void> {
  console.log('[1] REVERT — pollStaleRequests() → VASP failed → FAILED 전이');
  const repo   = new InMemoryTxRepository();
  const vasp   = new MockVaspTxClient();
  const wallet = new MockWalletResolver();
  const svc    = new TxStateMachineService(repo, vasp, wallet);

  const req = makeStalePending('req-revert', '0xfa11ed1111111111111111111111111111111111111111111111111111111111');
  await repo.save(req);
  vasp.setNextStatus(req.txHash!, { status: 'failed', revertReason: 'ERC1155: mint to zero address' });

  const { processed } = await svc.pollStaleRequests();

  const result = await repo.findById('req-revert');
  console.log('  processed :', processed);
  console.log('  status    :', result?.status);
  console.log('  failReason:', result?.failReason);
}

async function section2(): Promise<void> {
  console.log('[2] NOT_FOUND — pollStaleRequests() → VASP not_found → FAILED 전이');
  const repo   = new InMemoryTxRepository();
  const vasp   = new MockVaspTxClient();
  const wallet = new MockWalletResolver();
  const svc    = new TxStateMachineService(repo, vasp, wallet);

  const req = makeStalePending('req-notfound', '0xfa11ed2222222222222222222222222222222222222222222222222222222222');
  await repo.save(req);
  vasp.setNextStatus(req.txHash!, { status: 'not_found' });

  const { processed } = await svc.pollStaleRequests();

  const result = await repo.findById('req-notfound');
  console.log('  processed :', processed);
  console.log('  status    :', result?.status);
  console.log('  failReason:', result?.failReason);
}

async function section3(): Promise<void> {
  console.log('[3] 콜백 차단 E2E — Webhook 없이 pollStaleRequests()로 CONFIRMED 도달');
  console.log('    (이게 pollStaleRequests가 존재하는 이유)');
  const repo   = new InMemoryTxRepository();
  const vasp   = new MockVaspTxClient();
  const wallet = new MockWalletResolver();
  const svc    = new TxStateMachineService(repo, vasp, wallet);

  // Webhook이 오지 않은 상황 — 35분 전 PENDING 그대로
  const req = makeStalePending('req-no-callback', '0xfa11ed3333333333333333333333333333333333333333333333333333333333');
  await repo.save(req);

  // VASP API는 confirmed 응답 대기 중
  vasp.setNextStatus(req.txHash!, { status: 'confirmed', blockNumber: 12400 });

  // 크론이 pollStaleRequests 실행
  const { processed } = await svc.pollStaleRequests();

  const result = await repo.findById('req-no-callback');
  console.log('  processed :', processed);
  console.log('  status    :', result?.status, '← Webhook 없이 CONFIRMED 도달');
}

async function section4(): Promise<void> {
  console.log('[4] TIMEOUT — polling에서 pending은 skip, handleTimeout으로 gas bump');
  const repo   = new InMemoryTxRepository();
  const vasp   = new MockVaspTxClient();
  const wallet = new MockWalletResolver();
  const svc    = new TxStateMachineService(repo, vasp, wallet);

  const req = makeStalePending('req-timeout', '0xfa11ed5555555555555555555555555555555555555555555555555555555555');
  await repo.save(req);

  // VASP: 아직 pending — pollStaleRequests는 skip
  vasp.setNextStatus(req.txHash!, { status: 'pending' });
  const { processed: skipped } = await svc.pollStaleRequests();
  const afterPoll = await repo.findById('req-timeout');
  console.log('  [polling] processed:', skipped, '(pending → skip)');
  console.log('  [polling] status   :', afterPoll?.status, '← 그대로 PENDING');

  // TIMEOUT 감지 → handleTimeout 호출 (별도 크론 또는 updatedAt 비교)
  await svc.handleTimeout('req-timeout');
  const afterTimeout = await repo.findById('req-timeout');
  console.log('  [timeout] status    :', afterTimeout?.status, '← 여전히 PENDING (재전송 중)');
  console.log('  [timeout] retryCount:', afterTimeout?.retryCount);
  console.log('  [timeout] gasBumpLog:', vasp.getGasBumpLog());
}

async function section5(): Promise<void> {
  console.log('[5] Idempotency — CONFIRMED 건은 pollStaleRequests가 재처리하지 않음');
  const repo   = new InMemoryTxRepository();
  const vasp   = new MockVaspTxClient();
  const wallet = new MockWalletResolver();
  const svc    = new TxStateMachineService(repo, vasp, wallet);

  // 이미 콜백으로 CONFIRMED 처리된 건
  const staleDate = new Date(Date.now() - 35 * 60_000);
  await repo.save({
    id: 'req-done', userId: 'user-done', tokenId: 1n, amount: 1n,
    status: 'CONFIRMED', txHash: '0xfa11ed6666666666666666666666666666666666666666666666666666666666',
    retryCount: 0,
    createdAt: staleDate,
    updatedAt: new Date(),  // 최근 업데이트 (이미 처리됨)
  });

  // pollStaleRequests: findPendingOlderThan → CONFIRMED 제외 → 조회 0건
  const { processed } = await svc.pollStaleRequests();
  const result = await repo.findById('req-done');
  console.log('  processed:', processed, '← 0이어야 함 (이미 처리된 건 무시)');
  console.log('  status   :', result?.status, '← CONFIRMED 그대로 유지');
}

async function section6(): Promise<void> {
  console.log('[6] Bulkhead — 한 건 에러가 전체 배치를 멈추지 않음');
  const repo   = new InMemoryTxRepository();
  const vasp   = new MockVaspTxClient();
  const wallet = new MockWalletResolver();
  const svc    = new TxStateMachineService(repo, vasp, wallet);

  const errReq  = makeStalePending('iso-error',  '0xfa11ed7777777777777777777777777777777777777777777777777777777777');
  const failReq1 = makeStalePending('iso-fail-1', '0xfa11ed8888888888888888888888888888888888888888888888888888888888');
  const failReq2 = makeStalePending('iso-fail-2', '0xfa11ed9999999999999999999999999999999999999999999999999999999999');
  await repo.save(errReq);
  await repo.save(failReq1);
  await repo.save(failReq2);

  vasp.setNextStatus(failReq1.txHash!, { status: 'failed', revertReason: 'revert A' });
  vasp.setNextStatus(failReq2.txHash!, { status: 'failed', revertReason: 'revert B' });

  const origGetStatus = vasp.getStatus.bind(vasp);
  vasp.getStatus = async (txHash: string) => {
    if (txHash === errReq.txHash) throw new Error('VASP API 타임아웃 시뮬레이션');
    return origGetStatus(txHash);
  };

  let didThrow = false;
  try {
    await svc.pollStaleRequests();
  } catch {
    didThrow = true;
  }

  const r1 = await repo.findById('iso-fail-1');
  const r2 = await repo.findById('iso-fail-2');
  console.log('  pollStaleRequests throw:', didThrow, '← false이어야 함');
  console.log('  iso-fail-1 status      :', r1?.status, '← FAILED');
  console.log('  iso-fail-2 status      :', r2?.status, '← FAILED');
  console.log('  iso-error → 다음 크론 주기에 재처리');
}

// ── 진입점 ────────────────────────────────────────────────────────────────────

const SECTIONS: Record<string, () => Promise<void>> = {
  '1': section1,
  '2': section2,
  '3': section3,
  '4': section4,
  '5': section5,
  '6': section6,
};

(async () => {
  const arg = process.argv[2];

  if (arg && SECTIONS[arg]) {
    console.log(`=== S22: 섹션 [${arg}] ===\n`);
    await SECTIONS[arg]!();
  } else {
    console.log('=== S22: pollStaleRequests 통합 테스트 ===\n');
    for (const fn of Object.values(SECTIONS)) {
      try {
        await fn();
      } catch (err) {
        console.log(' ', (err as Error).message);
      }
      console.log();
    }
  }
})();
