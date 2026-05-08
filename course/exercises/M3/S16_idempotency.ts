/**
 * S16 실습 — Idempotency 보장: requestId 기반 중복 TX 방어
 *
 * 강의 노트: M3_S16_idempotency.md
 *
 * 실행 방법 (루트에서): npm run exercise:s16
 *
 * 목표:
 *   [1] 정상 흐름: submitMintRequest → REQUESTED → SUBMITTED 전이
 *   [2] VaspMockClient 멱등성: 동일 requestId → 동일 txHash 반환
 *   [3] VASP 전송 실패 → DB에 FAILED 기록 (재처리 가능)
 *   [4] handleMined 가드: CONFIRMED 상태에서 호출 → 조용히 무시 (throw 아님)
 *   [5] DB INSERT 먼저 원칙: REQUESTED 저장 후 VASP 호출
 */

import type { TxRepository, VaspTxClient, WalletResolver, MintRequest, TxStatus } from '@kyobo/vasp';
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

  async updateStatus(id: string, status: TxStatus, extra?: Partial<MintRequest>): Promise<void> {
    const r = this.store.get(id);
    if (r) this.store.set(id, { ...r, ...extra, status, updatedAt: new Date() });
  }

  async findPendingOlderThan(_minutes: number): Promise<MintRequest[]> { return []; }

  all(): MintRequest[] { return [...this.store.values()]; }
}

// ────────────────────────────────────────────────────────────────────────
// VaspMockClient — 실습 핵심: requestId 기반 멱등성 구현
//
// 실습 1: VaspMockClient.submitMint()를 완성하라
//   · 같은 requestId → 같은 txHash 반환 (Map으로 관리)
//   · 새 requestId → 신규 txHash 생성 + pending 상태 등록
//
// 힌트:
//   private submitted = new Map<string, string>();  // requestId → txHash
//   private txStatus  = new Map<string, { status: ... }>();
//
//   submitMint() 안에서:
//     if (this.submitted.has(params.requestId)) return { txHash: this.submitted.get(...)! };
//     const txHash = `0xMOCK_${Date.now().toString(16)}`;
//     this.submitted.set(params.requestId, txHash);
//     this.txStatus.set(txHash, { status: 'pending' });
//     return { txHash };
// ────────────────────────────────────────────────────────────────────────

class VaspMockClient implements VaspTxClient {
  private submitted = new Map<string, string>();  // requestId → txHash
  private counter   = 0;
  private txStatus  = new Map<string, {
    status: 'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found';
    blockNumber?: number;
    revertReason?: string;
  }>();

  async submitMint(params: {
    to: string; tokenId: bigint; amount: bigint; requestId: string;
  }): Promise<{ txHash: string }> {
    if (this.submitted.has(params.requestId)) {
      return { txHash: this.submitted.get(params.requestId)! };
    }
    const txHash = `0xMOCK_${(++this.counter).toString().padStart(4, '0')}_${Date.now().toString(16)}`;
    this.submitted.set(params.requestId, txHash);
    this.txStatus.set(txHash, { status: 'pending' });
    return { txHash };
  }

  setTxStatus(txHash: string, status: { status: 'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found'; revertReason?: string }) {
    this.txStatus.set(txHash, status);
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

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S16: Idempotency — requestId 기반 중복 TX 방어 ===\n');

  // ── [1] 정상 흐름: REQUESTED → SUBMITTED ─────────────────────────────
  console.log('[검증 1] 정상 흐름: submitMintRequest → REQUESTED → SUBMITTED');

  const repo1   = new InMemoryTxRepository();
  const vasp1   = new VaspMockClient();
  const wallet  = new MockWalletResolver();
  const svc1    = new TxStateMachineService(repo1, vasp1, wallet);

  // ── 실습 2: submitMintRequest를 호출하라 ─────────────────────────────
  const requestId = await svc1.submitMintRequest({ userId: 'user-1', tokenId: 1001n, amount: 1n });

  const req1 = await repo1.findById(requestId);
  check(`상태: ${req1?.status} (기대: SUBMITTED)`, req1?.status === 'SUBMITTED');
  check(`txHash 저장: ${req1?.txHash?.slice(0, 18)}...`, !!req1?.txHash);
  check(`userId 일치: ${req1?.userId}`, req1?.userId === 'user-1');
  check(`tokenId 일치: ${req1?.tokenId}`, req1?.tokenId === 1001n);

  // ── [2] VaspMockClient 멱등성: 동일 requestId → 동일 txHash ─────────
  console.log('\n[검증 2] 멱등성: 동일 requestId → 동일 txHash 반환');
  console.log('  (네트워크 재시도 시 VASP가 중복 발행하지 않음)');

  const vasp2 = new VaspMockClient();
  const r1    = await vasp2.submitMint({ to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid' });
  const r2    = await vasp2.submitMint({ to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid' });
  const r3    = await vasp2.submitMint({ to: '0xAlice', tokenId: 1001n, amount: 1n, requestId: 'fixed-uuid' });

  check(`1차 txHash: ${r1.txHash.slice(0, 18)}...`, !!r1.txHash);
  check(`2차 txHash === 1차 (멱등성): ${r1.txHash === r2.txHash}`, r1.txHash === r2.txHash);
  check(`3차 txHash === 1차 (멱등성): ${r1.txHash === r3.txHash}`, r1.txHash === r3.txHash);

  const rDiff = await vasp2.submitMint({ to: '0xBob', tokenId: 1002n, amount: 1n, requestId: 'different-uuid' });
  check(`다른 requestId → 다른 txHash: ${r1.txHash !== rDiff.txHash}`, r1.txHash !== rDiff.txHash);

  // ── [3] VASP 전송 실패 → DB FAILED 기록 ──────────────────────────────
  console.log('\n[검증 3] VASP 전송 실패 → DB에 FAILED 기록 (재처리 가능)');
  console.log('  핵심: DB INSERT(REQUESTED)를 VASP 호출 전에 한다');
  console.log('  → 크래시 후에도 FAILED 기록이 남아 재처리 가능');

  const repo3 = new InMemoryTxRepository();
  const failVasp: VaspTxClient = {
    submitMint:          async () => { throw new Error('VASP network timeout'); },
    getStatus:           async () => ({ status: 'not_found' as const }),
    resubmitWithGasBump: async () => ({ txHash: '0x0' }),
  };
  const svc3 = new TxStateMachineService(repo3, failVasp, wallet);

  let didThrow = false;
  let failedId = '';
  try {
    failedId = await svc3.submitMintRequest({ userId: 'user-fail', tokenId: 999n, amount: 1n });
  } catch {
    didThrow = true;
  }
  check('submitMintRequest → throw 발생 (VASP 실패)', didThrow);

  const allReqs = repo3.all();
  const failedReq = allReqs.find(r => r.status === 'FAILED');
  check('DB에 FAILED 기록 존재', !!failedReq);
  check(`failReason 저장: "${failedReq?.failReason?.slice(0, 40)}"`, !!failedReq?.failReason);
  if (failedId) {
    const byId = await repo3.findById(failedId);
    check('requestId로 실패 기록 조회 가능', byId?.status === 'FAILED');
  }

  // ── [4] handleMined 가드 — CONFIRMED 상태에서 호출 → 조용히 무시 ──────
  console.log('\n[검증 4] handleMined 가드: CONFIRMED 상태 → return (throw 아님)');
  console.log('  왜 throw 아닌 return인가:');
  console.log('  → At-least-once 재배달 환경에서 이미 처리된 메시지가 다시 올 수 있음');
  console.log('  → throw하면 DLQ로 이동 → 운영 부담. return하면 조용히 무시.');

  const repo4 = new InMemoryTxRepository();
  const svc4  = new TxStateMachineService(repo4, new VaspMockClient(), wallet);
  const now   = new Date();
  const confirmedReq: MintRequest = {
    id: 'req-confirmed', userId: 'u1', tokenId: 1n, amount: 1n,
    status: 'CONFIRMED', retryCount: 0, createdAt: now, updatedAt: now,
    txHash: '0xconfirmed',
  };
  await repo4.save(confirmedReq);

  let threw4 = false;
  try {
    await svc4.handleMined('req-confirmed', 9999);
  } catch {
    threw4 = true;
  }
  check('CONFIRMED에서 handleMined → throw 없음', !threw4);

  const afterGuard = await repo4.findById('req-confirmed');
  check('상태 변화 없음: CONFIRMED 유지', afterGuard?.status === 'CONFIRMED');
  check('blockNumber 변화 없음', afterGuard?.blockNumber === undefined);

  // ── [5] DB INSERT 먼저 원칙 — requestId 흐름 확인 ────────────────────
  console.log('\n[검증 5] DB INSERT 먼저 원칙 — requestId 전 레이어 관통');
  console.log('  submitMintRequest 흐름:');
  console.log('    1. randomUUID() → requestId 생성');
  console.log('    2. repo.save(REQUESTED)    ← DB INSERT 먼저');
  console.log('    3. vasp.submitMint({ requestId })  ← VASP 호출 나중');
  console.log('    4. repo.updateStatus(SUBMITTED, txHash)');
  check('DB INSERT 먼저 원칙: 실패 시 FAILED 기록 남음 (검증 3에서 확인)', !!failedReq);

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S16 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. requestId: UUID — TxStateMachineService → VaspTxClient까지 관통');
  console.log('  2. VaspMockClient 멱등성: submitted Map — 같은 requestId → 같은 txHash');
  console.log('  3. DB INSERT 먼저: 크래시 후에도 FAILED 기록 → 재처리 가능');
  console.log('  4. 핸들러 가드: throw 아닌 return → At-least-once 재배달 안전');
  console.log('  5. not_found vs failed: TX가 mempool에서 사라진 것 vs REVERT된 것');
})();
