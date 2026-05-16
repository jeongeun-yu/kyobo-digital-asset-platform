/**
 * S13 실습 — TX 상태머신 직접 구현
 *
 * 강의 노트: M3_S13_tx_statemachine.md
 * 실행 방법 (루트에서): npm run exercise:s13
 *
 * 목표:
 *   [1] VALID_TRANSITIONS 맵 — 8개 상태 전이 규칙 정의
 *   [2] _transition() — VALID_TRANSITIONS 가드 + DB 저장 + Observer emit
 *   [3] handleMined / handleConfirmed / handleFinalized — 가드 패턴
 *   [4] handleTimeout — gas bump (상태 전이 아님 → repo 직접)
 *   [5] handleReorg — REORGED 전이 + 재조회 후 복구 or 포기
 *   [6] Observer — CONFIRMED 전이 시 원장 업데이트 구독자 작성
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import type { TxRepository, VaspTxClient, WalletResolver, MintRequest } from '@kyobo/vasp';
import { MintRequestNotFoundError } from '@kyobo/vasp';

// ── 타입 ────────────────────────────────────────────────────────────────────

export type TxStatus =
  | 'REQUESTED' | 'SUBMITTED' | 'PENDING' | 'MINED'
  | 'CONFIRMED' | 'FINALIZED' | 'FAILED'  | 'REORGED';

export interface TxTransitionEvent {
  requestId: string;
  from:      TxStatus;
  to:        TxStatus;
  req:       MintRequest;
}

export class InvalidStatusTransitionError extends Error {
  constructor(from: TxStatus, to: TxStatus) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 실습 1: VALID_TRANSITIONS 맵을 완성하라
//
// 상태 전이도:
//   REQUESTED → SUBMITTED → PENDING → MINED → CONFIRMED → FINALIZED
//                    ↓          ↓        ↓         ↓
//                  FAILED     FAILED   FAILED    (없음 — CONFIRMED 이후 REORG 불가)
//                                      ↓
//                                   REORGED → MINED | FAILED
//
// 힌트:
//   - REORG는 MINED 구간에서만 가능 (CONFIRMED 이후 PoS가 보장)
//   - CONFIRMED에서 갈 수 있는 곳은 FINALIZED뿐
//   - 종단 상태(FINALIZED, FAILED)는 빈 배열
// ────────────────────────────────────────────────────────────────────────────

export const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  REQUESTED: [], // TODO
  SUBMITTED: [], // TODO
  PENDING:   [], // TODO
  MINED:     [], // TODO — REORG는 이 구간에서만
  CONFIRMED: [], // TODO — FINALIZED만 허용, REORG 불가
  FINALIZED: [], // 종단
  FAILED:    [], // 종단
  REORGED:   [], // TODO
};

// ────────────────────────────────────────────────────────────────────────────
// 실습 2~5: StudentTxStateMachineService를 완성하라
//
// TxStateMachineService의 핵심 메서드를 직접 구현한다.
// 각 TODO 블록의 주석을 읽고 구현하라.
// ────────────────────────────────────────────────────────────────────────────

export class StudentTxStateMachineService extends EventEmitter {
  private static readonly GAS_BUMP_PERCENT  = 20;
  private static readonly REORG_WAIT_BLOCKS = 5;

  constructor(
    private readonly repo:   TxRepository,
    private readonly vasp:   VaspTxClient,
    private readonly wallet: WalletResolver,
  ) { super(); }

  // ── 실습 2: _transition() ──────────────────────────────────────────────
  //
  // 모든 상태 전이의 단일 진입점.
  // 아래 세 가지를 순서대로 수행한다:
  //   ① VALID_TRANSITIONS[from]에 to가 없으면 InvalidStatusTransitionError throw
  //   ② repo.updateStatus()로 DB 저장
  //   ③ 'transition' 이벤트 emit — req는 status·extra·updatedAt 반영된 스냅샷
  //
  // 힌트: updated = { ...req, status: to, ...extra, updatedAt: new Date() }
  // ──────────────────────────────────────────────────────────────────────

  private async _transition(
    req:    MintRequest,
    to:     TxStatus,
    extra?: Partial<MintRequest>,
  ): Promise<void> {
    // TODO: 구현
    throw new Error('_transition: NOT IMPLEMENTED');
  }

  // ── 내부 유틸 (완성된 코드 — 수정 불필요) ──────────────────────────────

  private async _getOrThrow(id: string): Promise<MintRequest> {
    const req = await this.repo.findById(id);
    if (!req) throw new MintRequestNotFoundError(id);
    return req;
  }

  // ── 실습 3: 핸들러 가드 패턴 ─────────────────────────────────────────
  //
  // 각 핸들러는 "예상 상태가 아니면 조용히 return"하는 가드를 가진다.
  // 이유: At-least-once 재배달 시 중복 호출이 와도 DLQ로 가지 않아야 한다.
  //
  // handleMined:     PENDING 또는 SUBMITTED 상태일 때만 MINED로 전이
  // handleConfirmed: MINED 상태일 때만 CONFIRMED로 전이
  // handleFinalized: CONFIRMED 상태일 때만 FINALIZED로 전이
  // handleFailed:    어떤 상태에서든 FAILED로 전이 (가드 없음)
  // ──────────────────────────────────────────────────────────────────────

  async handleMined(requestId: string, blockNumber: number): Promise<void> {
    // TODO: _getOrThrow → 가드 → _transition(req, 'MINED', { blockNumber })
    throw new Error('handleMined: NOT IMPLEMENTED');
  }

  async handleConfirmed(requestId: string): Promise<void> {
    // TODO: _getOrThrow → 가드 → _transition(req, 'CONFIRMED')
    throw new Error('handleConfirmed: NOT IMPLEMENTED');
  }

  async handleFinalized(requestId: string): Promise<void> {
    // TODO: _getOrThrow → 가드 → _transition(req, 'FINALIZED')
    throw new Error('handleFinalized: NOT IMPLEMENTED');
  }

  async handleFailed(requestId: string, reason: string): Promise<void> {
    // TODO: _getOrThrow → _transition(req, 'FAILED', { failReason: reason })
    throw new Error('handleFailed: NOT IMPLEMENTED');
  }

  // ── 실습 4: handleTimeout — gas bump ──────────────────────────────────
  //
  // PENDING TX가 mempool에 오래 머물면 gas를 올려 재전송한다.
  // 상태는 PENDING 그대로 유지 — txHash와 retryCount만 바뀐다.
  //
  // 주의: PENDING → PENDING은 VALID_TRANSITIONS에 없다.
  //       _transition()을 쓰면 InvalidStatusTransitionError가 난다.
  //       → repo.updateStatus()를 직접 호출할 것
  //
  // 흐름:
  //   1. _getOrThrow
  //   2. 가드: PENDING 아니거나 txHash 없으면 return
  //   3. vasp.resubmitWithGasBump(txHash, GAS_BUMP_PERCENT) → newTxHash
  //   4. repo.updateStatus(id, 'PENDING', { txHash: newTxHash, retryCount: +1 })
  // ──────────────────────────────────────────────────────────────────────

  async handleTimeout(requestId: string): Promise<void> {
    // TODO: 구현
    throw new Error('handleTimeout: NOT IMPLEMENTED');
  }

  // ── 실습 5: handleReorg — REORG 복구 ─────────────────────────────────
  //
  // MINED TX가 체인 재편으로 소실됐을 때의 처리.
  //
  // 흐름:
  //   1. _getOrThrow
  //   2. 가드: MINED 아니거나 txHash 없으면 return
  //   3. _transition(req, 'REORGED')
  //   4. _waitBlocks(REORG_WAIT_BLOCKS) — 5블록 대기
  //   5. vasp.getStatus(txHash) 재조회
  //      → 'mined':     _transition(reorgedReq, 'MINED')       — 재채굴 성공
  //      → 그 외:       _transition(reorgedReq, 'FAILED', { failReason: 'reorg: tx not found after wait' })
  //
  // 힌트: reorgedReq = { ...req, status: 'REORGED' as TxStatus }
  // ──────────────────────────────────────────────────────────────────────

  async handleReorg(requestId: string): Promise<void> {
    // TODO: 구현
    throw new Error('handleReorg: NOT IMPLEMENTED');
  }

  private async _waitBlocks(blocks: number): Promise<void> {
    await new Promise(r => setTimeout(r, blocks * 12_000));
  }

  // ── submitMintRequest (완성된 코드 — 흐름 파악용) ─────────────────────

  async submitMintRequest(params: {
    userId:  string;
    tokenId: bigint;
    amount:  bigint;
  }): Promise<string> {
    const id  = randomUUID();
    const now = new Date();
    const req: MintRequest = {
      id, userId: params.userId, tokenId: params.tokenId, amount: params.amount,
      status: 'REQUESTED', retryCount: 0, createdAt: now, updatedAt: now,
    };
    await this.repo.save(req);
    try {
      const walletAddr = await this.wallet.getWalletAddr(params.userId);
      const { txHash } = await this.vasp.submitMint({
        to: walletAddr, tokenId: params.tokenId, amount: params.amount, requestId: id,
      });
      await this._transition(req, 'SUBMITTED', { txHash });
    } catch (err) {
      await this._transition(req, 'FAILED', { failReason: `submit failed: ${String(err)}` });
      throw err;
    }
    return id;
  }
}

// ── 테스트용 In-memory 구현체 (완성된 코드) ────────────────────────────────

class InMemoryTxRepository implements TxRepository {
  private store = new Map<string, MintRequest>();
  async save(req: MintRequest): Promise<void> { this.store.set(req.id, { ...req }); }
  async findById(id: string): Promise<MintRequest | null> { return this.store.get(id) ?? null; }
  async updateStatus(id: string, status: TxStatus, extra?: Partial<MintRequest>): Promise<void> {
    const r = this.store.get(id);
    if (r) this.store.set(id, { ...r, ...extra, status, updatedAt: new Date() });
  }
  async findPendingOlderThan(_m: number): Promise<MintRequest[]> { return []; }
}

class MockVaspTxClient implements VaspTxClient {
  async submitMint(p: { to: string; tokenId: bigint; amount: bigint; requestId: string }) {
    return { txHash: `0xmock-${p.requestId.slice(0, 8)}` };
  }
  async getStatus(_txHash: string) { return { status: 'mined' as const, blockNumber: 100 }; }
  async resubmitWithGasBump(_txHash: string, _pct: number) { return { txHash: '0xbump-new' }; }
}

class MockVaspTxClientDropped implements VaspTxClient {
  async submitMint(p: { to: string; tokenId: bigint; amount: bigint; requestId: string }) {
    return { txHash: `0xmock-${p.requestId.slice(0, 8)}` };
  }
  async getStatus(_txHash: string) { return { status: 'not_found' as const }; }
  async resubmitWithGasBump(_txHash: string, _pct: number) { return { txHash: '0xbump-new' }; }
}

class MockWalletResolver implements WalletResolver {
  async getWalletAddr(userId: string) { return `0x${userId.padEnd(40, '0')}`; }
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────

function check(
  label: string,
  pass: boolean,
  opts?: { hint?: string; actual?: unknown; expected?: unknown },
) {
  if (pass) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    if (opts?.expected !== undefined || opts?.actual !== undefined) {
      console.log(`       expected : ${opts?.expected}`);
      console.log(`       actual   : ${opts?.actual}`);
    }
    if (opts?.hint) console.log(`       힌트     : ${opts.hint}`);
    process.exitCode = 1;
  }
}

async function expectRejects(
  label: string,
  fn: () => Promise<void>,
  ErrorClass: new (...a: any[]) => Error,
  hint?: string,
) {
  try {
    await fn();
    console.log(`  ❌ ${label} → 예외 발생해야 함`);
    if (hint) console.log(`       힌트     : ${hint}`);
    process.exitCode = 1;
  } catch (err) {
    const pass = err instanceof ErrorClass;
    if (pass) {
      console.log(`  ✅ ${label} → ${ErrorClass.name}`);
    } else {
      console.log(`  ❌ ${label} → ${ErrorClass.name}`);
      console.log(`       expected : ${ErrorClass.name}`);
      console.log(`       actual   : ${err instanceof Error ? err.constructor.name : String(err)}`);
      if (hint) console.log(`       힌트     : ${hint}`);
      process.exitCode = 1;
    }
  }
}

// ── 검증 진입점 ────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S13: TX 상태머신 직접 구현 ===\n');

  // ── [1] VALID_TRANSITIONS ────────────────────────────────────────────
  console.log('[검증 1] VALID_TRANSITIONS — 8개 상태');
  check('REQUESTED → SUBMITTED, FAILED',
    JSON.stringify(VALID_TRANSITIONS['REQUESTED']?.sort()) === JSON.stringify(['FAILED','SUBMITTED']),
    { actual: VALID_TRANSITIONS['REQUESTED']?.sort(), expected: ['FAILED','SUBMITTED'],
      hint: 'REQUESTED에서: 정상 흐름(SUBMITTED) + 실패(FAILED)' });
  check('SUBMITTED → PENDING, FAILED',
    JSON.stringify(VALID_TRANSITIONS['SUBMITTED']?.sort()) === JSON.stringify(['FAILED','PENDING']),
    { actual: VALID_TRANSITIONS['SUBMITTED']?.sort(), expected: ['FAILED','PENDING'],
      hint: 'SUBMITTED에서: VASP 접수 확인(PENDING) + 실패(FAILED)' });
  check('PENDING   → MINED, FAILED',
    JSON.stringify(VALID_TRANSITIONS['PENDING']?.sort()) === JSON.stringify(['FAILED','MINED']),
    { actual: VALID_TRANSITIONS['PENDING']?.sort(), expected: ['FAILED','MINED'],
      hint: 'PENDING에서: 채굴됨(MINED) + 실패(FAILED)' });
  check('MINED     → CONFIRMED, REORGED, FAILED',
    JSON.stringify(VALID_TRANSITIONS['MINED']?.sort()) === JSON.stringify(['CONFIRMED','FAILED','REORGED']),
    { actual: VALID_TRANSITIONS['MINED']?.sort(), expected: ['CONFIRMED','FAILED','REORGED'],
      hint: 'MINED에서: 확정(CONFIRMED) + 체인재편(REORGED) + 실패(FAILED) — REORG는 이 구간에서만 가능' });
  check('CONFIRMED → FINALIZED만',
    JSON.stringify(VALID_TRANSITIONS['CONFIRMED']) === JSON.stringify(['FINALIZED']),
    { actual: VALID_TRANSITIONS['CONFIRMED'], expected: ['FINALIZED'],
      hint: 'CONFIRMED 이후엔 FINALIZED뿐 — PoS에서 CONFIRMED 블록은 REORG 불가' });
  check('FINALIZED 종단 []',
    VALID_TRANSITIONS['FINALIZED']?.length === 0,
    { actual: VALID_TRANSITIONS['FINALIZED'], expected: [],
      hint: '종단 상태 — 더 이상 전이 없음' });
  check('FAILED 종단 []',
    VALID_TRANSITIONS['FAILED']?.length === 0,
    { actual: VALID_TRANSITIONS['FAILED'], expected: [],
      hint: '종단 상태 — 실패한 TX는 재시도하지 않음 (새 requestId로 재요청)' });
  check('REORGED   → MINED, FAILED',
    JSON.stringify(VALID_TRANSITIONS['REORGED']?.sort()) === JSON.stringify(['FAILED','MINED']),
    { actual: VALID_TRANSITIONS['REORGED']?.sort(), expected: ['FAILED','MINED'],
      hint: 'REORGED에서: 재채굴 성공(MINED) + 영구 소실(FAILED)' });

  // ── [2] _transition() 가드 ────────────────────────────────────────────
  console.log('\n[검증 2] _transition() — VALID_TRANSITIONS 가드');
  {
    const repo = new InMemoryTxRepository();
    const svc  = new StudentTxStateMachineService(repo, new MockVaspTxClient(), new MockWalletResolver());
    const now  = new Date();

    const req: MintRequest = { id: 'r1', userId: 'u1', tokenId: 1n, amount: 1n,
      status: 'PENDING', txHash: '0xabc', blockNumber: undefined,
      retryCount: 0, createdAt: now, updatedAt: now };
    await repo.save(req);
    await svc.handleMined('r1', 100);
    const afterMined = await repo.findById('r1');
    check('PENDING → MINED 전이 성공', afterMined?.status === 'MINED',
      { actual: afterMined?.status, expected: 'MINED',
        hint: '_transition(): ① VALID_TRANSITIONS 가드 ② repo.updateStatus(req.id, to, extra) ③ emit' });
    check('blockNumber 저장됨', afterMined?.blockNumber === 100,
      { actual: afterMined?.blockNumber, expected: 100,
        hint: 'extra = { blockNumber } → _transition(req, "MINED", { blockNumber })로 전달됐나?' });

    // handleFailed에는 가드 없음 → _transition(FAILED → FAILED) → InvalidStatusTransitionError
    const failedReq: MintRequest = { id: 'r1b', userId: 'u1', tokenId: 1n, amount: 1n,
      status: 'FAILED', retryCount: 0, createdAt: now, updatedAt: now };
    await repo.save(failedReq);
    await expectRejects(
      'FAILED → FAILED 금지 — _transition 가드 작동',
      () => svc.handleFailed('r1b', 'duplicate'),
      InvalidStatusTransitionError,
      '_transition() 내부: if (!VALID_TRANSITIONS[from].includes(to)) throw new InvalidStatusTransitionError(from, to)',
    );
  }

  // ── [3] 핸들러 가드 패턴 ─────────────────────────────────────────────
  console.log('\n[검증 3] 핸들러 가드 — 이미 진행된 상태면 조용히 무시');
  {
    const repo = new InMemoryTxRepository();
    const svc  = new StudentTxStateMachineService(repo, new MockVaspTxClient(), new MockWalletResolver());
    const now  = new Date();

    const req: MintRequest = { id: 'r2', userId: 'u1', tokenId: 1n, amount: 1n,
      status: 'CONFIRMED', retryCount: 0, createdAt: now, updatedAt: now };
    await repo.save(req);
    let threw = false;
    try { await svc.handleMined('r2', 999); } catch { threw = true; }
    check('CONFIRMED 상태에서 handleMined → throw 없음', !threw,
      { hint: 'handleMined: if (req.status !== "PENDING" && req.status !== "SUBMITTED") return  ← throw 아닌 return' });
    check('상태 CONFIRMED 유지', (await repo.findById('r2'))?.status === 'CONFIRMED',
      { actual: (await repo.findById('r2'))?.status, expected: 'CONFIRMED',
        hint: '가드에서 return했으면 _transition()이 호출되지 않음 → DB 상태 그대로' });

    const req2: MintRequest = { id: 'r3', userId: 'u1', tokenId: 1n, amount: 1n,
      status: 'FINALIZED', retryCount: 0, createdAt: now, updatedAt: now };
    await repo.save(req2);
    let threw2 = false;
    try { await svc.handleConfirmed('r3'); } catch { threw2 = true; }
    check('FINALIZED 상태에서 handleConfirmed → throw 없음', !threw2,
      { hint: 'handleConfirmed: if (req.status !== "MINED") return' });

    await expectRejects(
      '없는 requestId → MintRequestNotFoundError',
      () => svc.handleMined('not-exist', 1),
      MintRequestNotFoundError,
      '_getOrThrow(): const req = await this.repo.findById(id); if (!req) throw new MintRequestNotFoundError(id)',
    );
  }

  // ── [4] handleTimeout — gas bump ──────────────────────────────────────
  console.log('\n[검증 4] handleTimeout — gas bump, 상태 유지');
  {
    const repo = new InMemoryTxRepository();
    const svc  = new StudentTxStateMachineService(repo, new MockVaspTxClient(), new MockWalletResolver());
    const now  = new Date();
    const req: MintRequest = { id: 'r4', userId: 'u1', tokenId: 1n, amount: 1n,
      status: 'PENDING', txHash: '0xold', retryCount: 0, createdAt: now, updatedAt: now };
    await repo.save(req);

    await svc.handleTimeout('r4');
    const after = await repo.findById('r4');
    check('상태는 여전히 PENDING', after?.status === 'PENDING',
      { actual: after?.status, expected: 'PENDING',
        hint: 'handleTimeout은 _transition() 사용 금지 — PENDING→PENDING은 VALID_TRANSITIONS에 없음. repo.updateStatus(id, "PENDING", extra) 직접 호출' });
    check('txHash가 새 값으로 교체됨', after?.txHash === '0xbump-new',
      { actual: after?.txHash, expected: '0xbump-new',
        hint: 'const { txHash: newTxHash } = await this.vasp.resubmitWithGasBump(req.txHash, GAS_BUMP_PERCENT)' });
    check('retryCount +1', after?.retryCount === 1,
      { actual: after?.retryCount, expected: 1,
        hint: 'extra = { txHash: newTxHash, retryCount: req.retryCount + 1 }' });
  }

  // ── [5] handleReorg — 재채굴 성공 케이스 ─────────────────────────────
  console.log('\n[검증 5] handleReorg — 재채굴 성공 (getStatus → mined)');
  {
    const repo = new InMemoryTxRepository();
    const svc  = new StudentTxStateMachineService(repo, new MockVaspTxClient(), new MockWalletResolver());
    const now  = new Date();
    const req: MintRequest = { id: 'r5', userId: 'u1', tokenId: 1n, amount: 1n,
      status: 'MINED', txHash: '0xreorg', retryCount: 0, createdAt: now, updatedAt: now };
    await repo.save(req);
    (svc as any)._waitBlocks = async () => {};

    await svc.handleReorg('r5');
    const after = await repo.findById('r5');
    check('REORG 후 재채굴 성공 → MINED 복귀', after?.status === 'MINED',
      { actual: after?.status, expected: 'MINED',
        hint: 'getStatus → "mined"이면 _transition(reorgedReq, "MINED"). reorgedReq = { ...req, status: "REORGED" } — req(MINED)가 아님!' });
  }

  // ── [5b] handleReorg — not_found → FAILED ────────────────────────────
  console.log('\n[검증 5b] handleReorg — not_found → FAILED');
  {
    const repo = new InMemoryTxRepository();
    const svc  = new StudentTxStateMachineService(repo, new MockVaspTxClientDropped(), new MockWalletResolver());
    const now  = new Date();
    const req: MintRequest = { id: 'r6', userId: 'u1', tokenId: 1n, amount: 1n,
      status: 'MINED', txHash: '0xdrop', retryCount: 0, createdAt: now, updatedAt: now };
    await repo.save(req);
    (svc as any)._waitBlocks = async () => {};

    await svc.handleReorg('r6');
    const after = await repo.findById('r6');
    check('REORG + not_found → FAILED', after?.status === 'FAILED',
      { actual: after?.status, expected: 'FAILED',
        hint: 'getStatus → "mined"가 아닌 모든 경우: _transition(reorgedReq, "FAILED", { failReason: "reorg: tx not found after wait" })' });
    check('failReason 저장됨', !!after?.failReason,
      { actual: after?.failReason, expected: '(non-empty string)',
        hint: 'extra = { failReason: "reorg: tx not found after wait" } 로 _transition에 전달됐나?' });
  }

  // ── [6] Observer — CONFIRMED 구독자 ──────────────────────────────────
  console.log('\n[검증 6] Observer — CONFIRMED 전이 시 원장 업데이트');
  {
    const repo = new InMemoryTxRepository();
    const svc  = new StudentTxStateMachineService(repo, new MockVaspTxClient(), new MockWalletResolver());

    // ────────────────────────────────────────────────────────────────────
    // 실습 6: 아래 TODO를 완성하라
    //
    // svc.on('transition', ...) 을 사용해 구독자를 등록한다.
    // CONFIRMED 전이 시에만 confirmedEvents 배열에 evt를 push한다.
    // ────────────────────────────────────────────────────────────────────
    const confirmedEvents: TxTransitionEvent[] = [];

    // TODO: svc.on('transition', (evt: TxTransitionEvent) => { ... })
    //       evt.to === 'CONFIRMED' 일 때만 confirmedEvents.push(evt)

    const now = new Date();
    const req: MintRequest = { id: 'r7', userId: 'u1', tokenId: 1n, amount: 1n,
      status: 'MINED', retryCount: 0, createdAt: now, updatedAt: now };
    await repo.save(req);
    await svc.handleConfirmed('r7');

    check('CONFIRMED 이벤트 1회 수신', confirmedEvents.length === 1,
      { actual: confirmedEvents.length, expected: 1,
        hint: 'svc.on("transition", (evt: TxTransitionEvent) => { if (evt.to === "CONFIRMED") confirmedEvents.push(evt) })' });
    check('evt.from === MINED', confirmedEvents[0]?.from === 'MINED',
      { actual: confirmedEvents[0]?.from, expected: 'MINED',
        hint: '_transition()이 emit하는 TxTransitionEvent = { requestId, from, to, req }' });
    check('evt.to === CONFIRMED', confirmedEvents[0]?.to === 'CONFIRMED',
      { actual: confirmedEvents[0]?.to, expected: 'CONFIRMED' });
    check('evt.req.status === CONFIRMED', confirmedEvents[0]?.req.status === 'CONFIRMED',
      { actual: confirmedEvents[0]?.req.status, expected: 'CONFIRMED',
        hint: 'req는 updated 스냅샷 — { ...req, status: to, ...extra, updatedAt: new Date() }' });

    const req2: MintRequest = { id: 'r8', userId: 'u1', tokenId: 1n, amount: 1n,
      status: 'PENDING', retryCount: 0, createdAt: now, updatedAt: now };
    await repo.save(req2);
    await svc.handleFailed('r8', 'revert: out of gas');
    check('FAILED 전이는 confirmedEvents에 포함 안 됨', confirmedEvents.length === 1,
      { actual: confirmedEvents.length, expected: 1,
        hint: 'evt.to === "CONFIRMED" 조건 없이 모든 전이를 push하지 않았나?' });
  }

  console.log('\n=== S13 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
})();
