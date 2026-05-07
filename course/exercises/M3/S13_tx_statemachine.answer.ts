/**
 * S13 실습 — TX 상태머신: VALID_TRANSITIONS + transitionStatus 구현
 *
 * 강의 노트: M3_S13_tx_statemachine.md
 *
 * 실행 방법 (dmz/packages/event-engine 폴더에서):
 *   npx ts-node src/exercises/S13_tx_statemachine.ts
 *
 * 목표:
 *   [1] VALID_TRANSITIONS 맵 — 7개 상태 전이 규칙 정의
 *   [2] transitionStatus() — 허용되지 않은 전이 시 InvalidStatusTransitionError
 *   [3] 정상 전이 케이스 3가지 — 예외 없음
 *   [4] 금지 전이 케이스 3가지 — 예외 발생
 *   [5] 실제 TxStateMachineService 핸들러 가드 패턴 확인
 */

import type { TxStatus } from '@kyobo/vasp';
import { TxStateMachineService, MintRequestNotFoundError } from '@kyobo/vasp';
import type { TxRepository, VaspTxClient, WalletResolver, MintRequest } from '@kyobo/vasp';

// ══════════════════════════════════════════════════════════════════════════
// 실습 1 + 2: VALID_TRANSITIONS 맵 + transitionStatus 구현
//
// TX 상태 전이도:
//   REQUESTED → SUBMITTED → PENDING → MINED → FINALIZED → CONFIRMED
//                     ↓         ↓        ↓        ↓
//                   FAILED    FAILED   FAILED   REORGED → MINED / FAILED
//                                      ↓
//                                    FAILED
//
const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  REQUESTED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['PENDING',   'FAILED'],
  PENDING:   ['MINED',     'FAILED'],
  MINED:     ['FINALIZED', 'REORGED', 'FAILED'],
  FINALIZED: ['CONFIRMED'],
  CONFIRMED: [],                          // 종단 — 원장 업데이트 완료
  FAILED:    [],                          // 종단
  REORGED:   ['MINED',     'FAILED'],
};

class InvalidStatusTransitionError extends Error {
  constructor(from: TxStatus, to: TxStatus) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

function transitionStatus(current: TxStatus, next: TxStatus): void {
  const allowed = VALID_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new InvalidStatusTransitionError(current, next);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 실습 5용 In-memory TxRepository
// ══════════════════════════════════════════════════════════════════════════

class InMemoryTxRepository implements TxRepository {
  private store = new Map<string, MintRequest>();

  async save(req: MintRequest): Promise<void> { this.store.set(req.id, { ...req }); }

  async findById(id: string): Promise<MintRequest | null> {
    return this.store.get(id) ?? null;
  }

  async updateStatus(id: string, status: TxStatus, extra?: Partial<MintRequest>): Promise<void> {
    const r = this.store.get(id);
    if (r) this.store.set(id, { ...r, ...extra, status, updatedAt: new Date() });
  }

  async findPendingOlderThan(_minutes: number): Promise<MintRequest[]> { return []; }
}

class MockVaspTxClient implements VaspTxClient {
  async submitMint(p: { to: string; tokenId: bigint; amount: bigint; requestId: string }) {
    return { txHash: `0xmock-${p.requestId.slice(0, 8)}` };
  }
  async getStatus(_txHash: string) { return { status: 'pending' as const }; }
  async resubmitWithGasBump(_txHash: string, _pct: number) { return { txHash: '0xbump' }; }
}

class MockWalletResolver implements WalletResolver {
  async getWalletAddr(userId: string) { return `0x${userId.padEnd(40, '0')}`; }
}

// ══════════════════════════════════════════════════════════════════════════
// 헬퍼
// ══════════════════════════════════════════════════════════════════════════

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

function expectThrows(label: string, fn: () => void) {
  try {
    fn();
    check(`${label} → 예외 발생해야 함`, false);
  } catch (err) {
    const isCorrectError = err instanceof InvalidStatusTransitionError;
    check(`${label} → InvalidStatusTransitionError`, isCorrectError);
  }
}

function expectNoThrow(label: string, fn: () => void) {
  try {
    fn();
    check(`${label} → 예외 없음`, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(`${label} → 예외 없어야 함 (실제: ${msg})`, false);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 실습 진입점
// ══════════════════════════════════════════════════════════════════════════

(async () => {
  console.log('=== S13: TX 상태머신 — VALID_TRANSITIONS + transitionStatus ===\n');

  // ── [1] VALID_TRANSITIONS 맵 구조 확인 ───────────────────────────────
  console.log('[검증 1] VALID_TRANSITIONS — 8개 상태 정의');
  const states: TxStatus[] = ['REQUESTED', 'SUBMITTED', 'PENDING', 'MINED', 'FINALIZED', 'CONFIRMED', 'FAILED', 'REORGED'];
  for (const state of states) {
    check(`${state}: ${JSON.stringify(VALID_TRANSITIONS[state])}`, state in VALID_TRANSITIONS);
  }
  check('FAILED는 종단 상태 — 전이 없음',    VALID_TRANSITIONS['FAILED']!.length === 0);
  check('CONFIRMED는 종단 상태 — 전이 없음', VALID_TRANSITIONS['CONFIRMED']!.length === 0);

  // ── [2] 정상 전이 케이스 ─────────────────────────────────────────────
  console.log('\n[검증 2] 정상 전이 — 예외 없음');
  expectNoThrow('REQUESTED → SUBMITTED',  () => transitionStatus('REQUESTED', 'SUBMITTED'));
  expectNoThrow('PENDING   → MINED',      () => transitionStatus('PENDING',   'MINED'));
  expectNoThrow('MINED     → FINALIZED',  () => transitionStatus('MINED',     'FINALIZED'));
  expectNoThrow('FINALIZED → CONFIRMED',  () => transitionStatus('FINALIZED', 'CONFIRMED'));
  expectNoThrow('MINED     → REORGED',    () => transitionStatus('MINED',     'REORGED'));
  expectNoThrow('REORGED   → FAILED',     () => transitionStatus('REORGED',   'FAILED'));
  expectNoThrow('SUBMITTED → FAILED',     () => transitionStatus('SUBMITTED', 'FAILED'));

  // ── [3] 금지 전이 케이스 ─────────────────────────────────────────────
  console.log('\n[검증 3] 금지 전이 — InvalidStatusTransitionError');
  expectThrows('FAILED     → CONFIRMED',  () => transitionStatus('FAILED',    'CONFIRMED'));
  expectThrows('CONFIRMED  → PENDING',    () => transitionStatus('CONFIRMED', 'PENDING'));
  expectThrows('CONFIRMED  → REORGED',    () => transitionStatus('CONFIRMED', 'REORGED'));  // CONFIRMED는 종단
  expectThrows('FINALIZED  → REORGED',    () => transitionStatus('FINALIZED', 'REORGED'));  // FINALIZED 이후 REORG 불가
  expectThrows('MINED      → CONFIRMED',  () => transitionStatus('MINED',     'CONFIRMED')); // 반드시 FINALIZED 거쳐야 함
  expectThrows('REQUESTED  → MINED',      () => transitionStatus('REQUESTED', 'MINED'));
  expectThrows('MINED      → SUBMITTED',  () => transitionStatus('MINED',     'SUBMITTED'));
  expectThrows('FAILED     → REQUESTED',  () => transitionStatus('FAILED',    'REQUESTED'));

  // ── [4] MINED에서 MINED → 금지 (동일 상태 전이도 차단) ────────────────
  console.log('\n[검증 4] 동일 상태 전이 — 금지');
  expectThrows('MINED     → MINED',      () => transitionStatus('MINED',     'MINED'));
  expectThrows('PENDING   → PENDING',    () => transitionStatus('PENDING',   'PENDING'));

  // ── [5] 실제 TxStateMachineService 핸들러 가드 패턴 확인 ────────────
  //
  // handleMined: req.status !== 'PENDING' && !== 'SUBMITTED' 이면 return (throw 아님)
  // → At-least-once 재배달 시 DLQ 이동 없이 조용히 무시
  console.log('\n[검증 5] handleMined 가드 — 이미 CONFIRMED 상태면 조용히 무시');

  const repo   = new InMemoryTxRepository();
  const svc    = new TxStateMachineService(repo, new MockVaspTxClient(), new MockWalletResolver());
  const now    = new Date();
  const mockReq: MintRequest = {
    id: 'req-guard', userId: 'u1', tokenId: 1n, amount: 1n,
    status: 'CONFIRMED', retryCount: 0, createdAt: now, updatedAt: now,
  };
  await repo.save(mockReq);

  let threw = false;
  try {
    await svc.handleMined('req-guard', 9999);
  } catch {
    threw = true;
  }
  check('CONFIRMED 상태에서 handleMined → throw 없음', !threw);

  const afterGuard = await repo.findById('req-guard');
  check('상태 변화 없음: CONFIRMED 유지', afterGuard?.status === 'CONFIRMED');

  // [6] 존재하지 않는 requestId → MintRequestNotFoundError
  console.log('\n[검증 6] 존재하지 않는 requestId → MintRequestNotFoundError');
  try {
    await svc.handleMined('not-exist', 1);
    check('존재하지 않는 requestId → 에러', false);
  } catch (err) {
    check(`MintRequestNotFoundError 발생: ${err instanceof MintRequestNotFoundError}`, err instanceof MintRequestNotFoundError);
  }

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S13 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. VALID_TRANSITIONS: 허용 전이를 명시적으로 열거 — 암묵적 전이 금지');
  console.log('  2. FAILED/CONFIRMED는 종단 상태 — 빈 배열로 모든 복구 시도 차단');
  console.log('  3. MINED → FINALIZED → CONFIRMED (FINALIZED 건너뛰기 불가)');
  console.log('  4. REORG는 MINED 구간에서만 — FINALIZED 이후 REORG 절대 불가 (PoS 보장)');
  console.log('  5. 핸들러 가드: throw 대신 return — At-least-once 재배달 시 DLQ 이동 방지');
  console.log('  6. _getOrThrow: 존재하지 않는 requestId → 즉시 에러 (개발 오류 조기 발견)');
})();
