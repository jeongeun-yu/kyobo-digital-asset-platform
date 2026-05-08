/**
 * S22 실습 — pollStaleRequests 구현 + 3종 복구 통합 테스트
 *
 * 강의 노트: M3_S22_pollstale_integration.md
 *
 * 실행 방법 (루트에서): npm run exercise:s22
 *
 * 실제 동작 기준:
 *   pollStaleRequests() — PENDING 30분+ 건 배치 조회 후 결과별 분기
 *     · VASP 'failed'    → handleFailed() (FAILED 전이)
 *     · VASP 'not_found' → handleFailed() (FAILED 전이)
 *     · VASP 'confirmed' → handleFinalized() — 단, req.status가 MINED여야 전이됨
 *     · VASP 'pending'   → 대기 (업데이트 없음)
 *
 *   handleTimeout() — mempool stuck 감지 시 별도 크론에서 호출
 *     · PENDING + txHash 있으면 gas bump 재전송 + retryCount++
 *
 * 목표:
 *   [1] FAILED 시나리오: VASP 'failed' → FAILED 전이 (pollStaleRequests 경로)
 *   [2] NOT_FOUND 시나리오: VASP 'not_found' → FAILED 전이 (pollStaleRequests 경로)
 *   [3] CONFIRMED 시나리오: MINED → FINALIZED → CONFIRMED (handleFinalized + handleConfirmed 직접 경로)
 *   [4] TIMEOUT 시나리오: PENDING → gas bump + retryCount++ (handleTimeout 직접 경로)
 *   [5] 오류 격리(Bulkhead): 한 건 에러가 전체 배치를 멈추지 않음
 */

import type {
  TxRepository,
  VaspTxClient,
  WalletResolver,
  MintRequest,
  TxStatus,
} from '@kyobo/vasp';
import { TxStateMachineService } from '@kyobo/vasp';

// ────────────────────────────────────────────────────────────────────────
// In-memory TxRepository
// ────────────────────────────────────────────────────────────────────────

class InMemoryTxRepository implements TxRepository {
  private store = new Map<string, MintRequest>();

  async save(req: MintRequest): Promise<void> {
    this.store.set(req.id, { ...req });
  }

  async findById(id: string): Promise<MintRequest | null> {
    return this.store.get(id) ?? null;
  }

  async updateStatus(
    id: string,
    status: TxStatus,
    extra?: Partial<MintRequest>,
  ): Promise<void> {
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

// ────────────────────────────────────────────────────────────────────────
// Mock VaspTxClient
// ────────────────────────────────────────────────────────────────────────

type VaspStatusResult = Awaited<ReturnType<VaspTxClient['getStatus']>>;

class MockVaspTxClient implements VaspTxClient {
  private statusMap = new Map<string, VaspStatusResult>();
  private gasBumpLog: string[] = [];

  setNextStatus(txHash: string, result: VaspStatusResult): void {
    this.statusMap.set(txHash, result);
  }

  async submitMint(params: {
    to: string; tokenId: bigint; amount: bigint; requestId: string;
  }): Promise<{ txHash: string }> {
    return { txHash: `0xmock-${params.requestId.slice(0, 8)}` };
  }

  async getStatus(txHash: string): Promise<VaspStatusResult> {
    return this.statusMap.get(txHash) ?? { status: 'pending' };
  }

  async resubmitWithGasBump(txHash: string, gasBumpPercent: number): Promise<{ txHash: string }> {
    const newHash = `${txHash}-bumped`;
    this.gasBumpLog.push(`${txHash} → ${newHash} (+${gasBumpPercent}%)`);
    return { txHash: newHash };
  }

  getGasBumpLog(): string[] { return this.gasBumpLog; }
}

// ────────────────────────────────────────────────────────────────────────
// Mock WalletResolver
// ────────────────────────────────────────────────────────────────────────

class MockWalletResolver implements WalletResolver {
  async getWalletAddr(userId: string): Promise<string> {
    return `0x${userId.padEnd(40, '0')}`;
  }
}

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

function makeStalePendingRequest(id: string, txHash: string): MintRequest {
  const staleDate = new Date(Date.now() - 35 * 60_000); // 35분 전 (stale 기준 30분 초과)
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

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S22: pollStaleRequests 통합 테스트 ===\n');

  // ── 공유 인프라 ──────────────────────────────────────────────────────
  const repo   = new InMemoryTxRepository();
  const vasp   = new MockVaspTxClient();
  const wallet = new MockWalletResolver();
  const svc    = new TxStateMachineService(repo, vasp, wallet);

  // ══════════════════════════════════════════════════════════════════════
  // [검증 1] FAILED — VASP 'failed' → pollStaleRequests → FAILED 전이
  // ══════════════════════════════════════════════════════════════════════
  console.log('[검증 1] FAILED 시나리오: VASP failed → PENDING → FAILED');

  const reqFailed = makeStalePendingRequest('req-failed', '0xhash-failed');
  await repo.save(reqFailed);
  vasp.setNextStatus('0xhash-failed', { status: 'failed', revertReason: 'ERC1155: mint to zero address' });

  await svc.pollStaleRequests();

  const r1 = await repo.findById('req-failed');
  check(`상태: ${r1?.status} (기대: FAILED)`, r1?.status === 'FAILED');
  check(`failReason 저장: "${r1?.failReason}"`, !!r1?.failReason);

  // ══════════════════════════════════════════════════════════════════════
  // [검증 2] NOT_FOUND — VASP 'not_found' → FAILED 전이
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[검증 2] NOT_FOUND 시나리오: VASP not_found → FAILED');

  const repo2 = new InMemoryTxRepository();
  const vasp2 = new MockVaspTxClient();
  const svc2  = new TxStateMachineService(repo2, vasp2, wallet);

  const reqNotFound = makeStalePendingRequest('req-notfound', '0xhash-notfound');
  await repo2.save(reqNotFound);
  vasp2.setNextStatus('0xhash-notfound', { status: 'not_found' });

  await svc2.pollStaleRequests();

  const r2 = await repo2.findById('req-notfound');
  check(`상태: ${r2?.status} (기대: FAILED)`, r2?.status === 'FAILED');
  check(`failReason에 'not found' 포함`, r2?.failReason?.includes('not found') ?? false);

  // ══════════════════════════════════════════════════════════════════════
  // [검증 3] CONFIRMED — MINED → FINALIZED → CONFIRMED (2단계 전이)
  //
  // 핵심 포인트:
  //   pollStaleRequests는 PENDING 건만 조회한다.
  //   handleFinalized()는 req.status === 'MINED' 인 경우에만 FINALIZED로 전이한다.
  //   handleConfirmed()는 req.status === 'FINALIZED' 인 경우에만 CONFIRMED로 전이한다.
  //   → MINED → FINALIZED → CONFIRMED 순서를 반드시 지켜야 한다.
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[검증 3] CONFIRMED 시나리오: MINED → handleFinalized → FINALIZED → handleConfirmed → CONFIRMED');
  console.log('  (pollStaleRequests는 PENDING 조회 전용 — FINALIZED/CONFIRMED는 별도 경로)');

  const repo3 = new InMemoryTxRepository();
  const svc3  = new TxStateMachineService(repo3, new MockVaspTxClient(), wallet);

  const reqMined = makeRequest('req-mined', '0xhash-mined', 'MINED');
  await repo3.save(reqMined);

  await svc3.handleFinalized('req-mined');  // MINED → FINALIZED
  await svc3.handleConfirmed('req-mined');  // FINALIZED → CONFIRMED

  const r3 = await repo3.findById('req-mined');
  check(`상태: ${r3?.status} (기대: CONFIRMED)`, r3?.status === 'CONFIRMED');

  // PENDING에서 handleConfirmed 호출 시 무시됨을 확인 (방어 로직)
  const repo3b = new InMemoryTxRepository();
  const svc3b  = new TxStateMachineService(repo3b, new MockVaspTxClient(), wallet);
  const reqPending = makeRequest('req-pending-skip', '0xhash-skip', 'PENDING');
  await repo3b.save(reqPending);
  await svc3b.handleConfirmed('req-pending-skip'); // PENDING은 FINALIZED 아님 → 조용히 무시
  const r3b = await repo3b.findById('req-pending-skip');
  check(`PENDING에서 handleConfirmed 호출 → 상태 유지: ${r3b?.status}`, r3b?.status === 'PENDING');

  // ══════════════════════════════════════════════════════════════════════
  // [검증 4] TIMEOUT — PENDING에서 handleTimeout 직접 호출 → gas bump
  //
  // 핵심 포인트:
  //   pollStaleRequests의 'pending' 분기는 "계속 대기 (업데이트 없음)".
  //   gas bump(handleTimeout)는 mempool 모니터링 크론이 별도로 호출한다.
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[검증 4] TIMEOUT 시나리오: PENDING → handleTimeout → gas bump + retryCount++');
  console.log('  (handleTimeout은 pollStaleRequests와 독립적인 크론에서 호출)');

  const repo4 = new InMemoryTxRepository();
  const vasp4 = new MockVaspTxClient();
  const svc4  = new TxStateMachineService(repo4, vasp4, wallet);

  const reqTimeout = makeRequest('req-timeout', '0xhash-timeout', 'PENDING');
  await repo4.save(reqTimeout);

  await svc4.handleTimeout('req-timeout');

  const r4 = await repo4.findById('req-timeout');
  check(`상태 유지: ${r4?.status} (기대: PENDING)`, r4?.status === 'PENDING');
  check(`retryCount 증가: ${r4?.retryCount}`, (r4?.retryCount ?? 0) >= 1);

  const gasBumpLog = vasp4.getGasBumpLog();
  check(`gas bump 호출: ${gasBumpLog.length}건`, gasBumpLog.length === 1);
  if (gasBumpLog.length > 0) console.log(`  → ${gasBumpLog[0]}`);

  // ══════════════════════════════════════════════════════════════════════
  // [검증 5] 오류 격리(Bulkhead) — 한 건 에러가 전체 배치를 멈추지 않음
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[검증 5] 오류 격리(Bulkhead): 한 건 에러 시 나머지 배치 계속 처리');

  const repo5   = new InMemoryTxRepository();
  const vasp5   = new MockVaspTxClient();
  const svc5    = new TxStateMachineService(repo5, vasp5, wallet);

  const iso1 = makeStalePendingRequest('iso-error',  '0xhash-error');
  const iso2 = makeStalePendingRequest('iso-fail-1', '0xhash-fail-1');
  const iso3 = makeStalePendingRequest('iso-fail-2', '0xhash-fail-2');
  await repo5.save(iso1);
  await repo5.save(iso2);
  await repo5.save(iso3);

  vasp5.setNextStatus('0xhash-fail-1', { status: 'failed', revertReason: 'revert A' });
  vasp5.setNextStatus('0xhash-fail-2', { status: 'failed', revertReason: 'revert B' });

  // iso-error 건만 getStatus에서 throw
  const origGetStatus = vasp5.getStatus.bind(vasp5);
  vasp5.getStatus = async (txHash: string) => {
    if (txHash === '0xhash-error') throw new Error('VASP API 타임아웃 시뮬레이션');
    return origGetStatus(txHash);
  };

  let didThrow = false;
  try {
    await svc5.pollStaleRequests();
  } catch {
    didThrow = true;
  }

  check('pollStaleRequests 전체가 throw되지 않음 (Bulkhead)', !didThrow);

  const isoFail1 = await repo5.findById('iso-fail-1');
  const isoFail2 = await repo5.findById('iso-fail-2');
  check(`에러 건 옆 iso-fail-1: ${isoFail1?.status} (기대: FAILED)`, isoFail1?.status === 'FAILED');
  check(`에러 건 옆 iso-fail-2: ${isoFail2?.status} (기대: FAILED)`, isoFail2?.status === 'FAILED');

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S22 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. pollStaleRequests: PENDING 30분+ 배치 조회 → failed/not_found → FAILED 전이');
  console.log('  2. handleFinalized: MINED → FINALIZED / handleConfirmed: FINALIZED → CONFIRMED (반드시 순서 준수)');
  console.log('  3. handleTimeout: pollStaleRequests와 독립 — mempool 크론이 별도 호출');
  console.log('  4. Bulkhead: try-catch per item → 한 건 실패가 전체 배치 중단 방지');
})();
