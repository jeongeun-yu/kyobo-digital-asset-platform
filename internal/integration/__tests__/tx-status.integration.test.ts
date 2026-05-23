/**
 * TxStatus 통합 테스트
 *
 * PgTxRepository + TxStateMachineService → 실제 PostgreSQL
 *
 * 검증 시나리오:
 *   [1] submitMintRequest() → SUBMITTED DB 저장
 *   [2] 정상 경로: SUBMITTED → MINED → CONFIRMED → FINALIZED
 *   [3] REORG 복구 경로: MINED → REORGED → MINED
 *   [4] 실패 경로: SUBMITTED → FAILED
 *   [5] 종단 상태 보호 — FINALIZED 이후 전이 무시
 *   [6] 종단 상태 보호 — FAILED 이후 전이 무시
 *   [7] pollStaleRequests() — PENDING 30분 초과 건 처리
 *   [8] transition 이벤트 발행 확인
 */

import { Pool }                    from 'pg';
import { randomUUID }              from 'crypto';
import { getPgUrl }                from '../helpers/state';
import { PgTxRepository }          from '@kyobo/vasp';
import {
  TxStateMachineService,
  InvalidStatusTransitionError,
  type VaspTxClient,
  type WalletResolver,
  type TxTransitionEvent,
}                                  from '@kyobo/vasp';

// ── 제어 가능한 VASP 클라이언트 (테스트 전용) ─────────────────────────────────

class ControlledVaspClient implements VaspTxClient {
  private _nextTxHash = '0x' + 'aa'.repeat(32);
  private _statusMap  = new Map<string, { status: string; blockNumber?: number; revertReason?: string }>();

  setNextTxHash(h: string) { this._nextTxHash = h; }
  setStatusResponse(txHash: string, status: string, extra: { blockNumber?: number; revertReason?: string } = {}) {
    this._statusMap.set(txHash, { status, ...extra });
  }
  reset() { this._statusMap.clear(); this._nextTxHash = '0x' + 'aa'.repeat(32); }

  async submitMint(_: { to: string; tokenId: bigint; amount: bigint; requestId: string }): Promise<{ txHash: string }> {
    return { txHash: this._nextTxHash };
  }

  async getStatus(txHash: string) {
    const r = this._statusMap.get(txHash);
    return r
      ? { status: r.status as any, blockNumber: r.blockNumber, revertReason: r.revertReason }
      : { status: 'pending' as const };
  }

  async resubmitWithGasBump(txHash: string, _pct: number): Promise<{ txHash: string }> {
    return { txHash };
  }
}

class FixedWalletResolver implements WalletResolver {
  async getWalletAddr(_userId: string): Promise<string> {
    return '0xWALLETADDR0000000000000000000000000000001';
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('TxStatus 상태 전이 — PgTxRepository + TxStateMachineService', () => {
  let pool:   Pool;
  let repo:   PgTxRepository;
  let vasp:   ControlledVaspClient;
  let svc:    TxStateMachineService;

  beforeAll(() => {
    pool = new Pool({ connectionString: getPgUrl() });
    repo = new PgTxRepository(pool);
    vasp = new ControlledVaspClient();
    svc  = new TxStateMachineService(repo, vasp, new FixedWalletResolver());
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE tx_mint_requests');
    vasp.reset();
  });

  // ── [1] submitMintRequest ─────────────────────────────────────────────────

  it('[1] submitMintRequest() → SUBMITTED 상태로 DB 저장, txHash 기록', async () => {
    const txHash = '0x' + 'a1'.repeat(32);
    vasp.setNextTxHash(txHash);

    const { requestId: id } = await svc.submitMintRequest({
      userId: 'user-tx-001', tokenId: BigInt(1001), amount: BigInt(1),
    });

    expect(typeof id).toBe('string');

    const saved = await repo.findById(id);
    expect(saved!.status).toBe('SUBMITTED');
    expect(saved!.txHash).toBe(txHash);

    // DB 직접 확인
    const { rows } = await pool.query(
      'SELECT status, tx_hash FROM tx_mint_requests WHERE id = $1', [id],
    );
    expect(rows[0]!.status).toBe('SUBMITTED');
    expect(rows[0]!.tx_hash).toBe(txHash);
  });

  // ── [2] 정상 경로 전체 ────────────────────────────────────────────────────

  it('[2] 정상 경로: SUBMITTED → MINED → CONFIRMED → FINALIZED', async () => {
    const txHash = '0x' + 'b2'.repeat(32);
    vasp.setNextTxHash(txHash);

    const { requestId: id } = await svc.submitMintRequest({
      userId: 'user-tx-002', tokenId: BigInt(1001), amount: BigInt(1),
    });

    const transitions: string[] = [];
    svc.on('transition', (e: TxTransitionEvent) => transitions.push(`${e.from}→${e.to}`));

    await svc.handleMined(id, 100);
    await svc.handleConfirmed(id);
    await svc.handleFinalized(id);

    const final = await repo.findById(id);
    expect(final!.status).toBe('FINALIZED');
    expect(final!.blockNumber).toBe(100);

    expect(transitions).toEqual([
      'SUBMITTED→MINED',
      'MINED→CONFIRMED',
      'CONFIRMED→FINALIZED',
    ]);
  });

  // ── [3] REORG 복구 경로 ───────────────────────────────────────────────────
  // handleReorg() 내부에 _waitBlocks(5 × 12,000ms) 대기가 있어
  // 통합 테스트에서는 DB 레이어 직접 전이로 검증한다.

  it('[3] REORG 복구: MINED → REORGED → MINED → CONFIRMED → FINALIZED (DB 직접 전이)', async () => {
    const txHash = '0x' + 'c3'.repeat(32);
    vasp.setNextTxHash(txHash);

    const { requestId: id } = await svc.submitMintRequest({
      userId: 'user-tx-003', tokenId: BigInt(1001), amount: BigInt(1),
    });

    await svc.handleMined(id, 50);

    // REORG 시뮬레이션 — handleReorg()는 60s 블록 대기를 포함하므로
    // PgTxRepository.updateStatus로 직접 전이 (guard: NOT IN FINALIZED/FAILED → 통과)
    await repo.updateStatus(id, 'REORGED');

    const reorged = await repo.findById(id);
    expect(reorged!.status).toBe('REORGED');

    // 재채굴 복구 — REORGED → MINED
    await repo.updateStatus(id, 'MINED', { blockNumber: 55 });

    // MINED → CONFIRMED → FINALIZED (서비스 레이어 정상 경로)
    await svc.handleConfirmed(id);
    await svc.handleFinalized(id);

    const final = await repo.findById(id);
    expect(final!.status).toBe('FINALIZED');
    expect(final!.blockNumber).toBe(55);
  });

  // ── [4] 실패 경로 ─────────────────────────────────────────────────────────

  it('[4] SUBMITTED → FAILED (VASP TX 실패)', async () => {
    const txHash = '0x' + 'd4'.repeat(32);
    vasp.setNextTxHash(txHash);

    const { requestId: id } = await svc.submitMintRequest({
      userId: 'user-tx-004', tokenId: BigInt(1001), amount: BigInt(1),
    });

    await svc.handleFailed(id, 'onchain REVERT: insufficient balance');

    const failed = await repo.findById(id);
    expect(failed!.status).toBe('FAILED');
    expect(failed!.failReason).toContain('REVERT');
  });

  // ── [5] 종단 상태 보호 — FINALIZED ───────────────────────────────────────

  it('[5] FINALIZED 이후 handleFailed 시도 → InvalidStatusTransitionError + DB 변경 없음', async () => {
    const txHash = '0x' + 'e5'.repeat(32);
    vasp.setNextTxHash(txHash);

    const { requestId: id } = await svc.submitMintRequest({
      userId: 'user-tx-005', tokenId: BigInt(1001), amount: BigInt(1),
    });
    await svc.handleMined(id, 200);
    await svc.handleConfirmed(id);
    await svc.handleFinalized(id);

    // 서비스 레이어 guard: FINALIZED는 valid_transitions = [] → throw
    await expect(
      svc.handleFailed(id, '늦은 실패 시도'),
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);

    // DB 레이어 guard도 이중으로 작동: status NOT IN ('FINALIZED', 'FAILED')
    const final = await repo.findById(id);
    expect(final!.status).toBe('FINALIZED');
  });

  // ── [6] 종단 상태 보호 — FAILED ──────────────────────────────────────────

  it('[6] FAILED 이후 handleMined 시도 → DB 변경 없음', async () => {
    const txHash = '0x' + 'f6'.repeat(32);
    vasp.setNextTxHash(txHash);

    const { requestId: id } = await svc.submitMintRequest({
      userId: 'user-tx-006', tokenId: BigInt(1001), amount: BigInt(1),
    });
    await svc.handleFailed(id, '초기 실패');

    // FAILED → handleMined 호출 (내부 guard: status !== PENDING && !== SUBMITTED → return)
    await svc.handleMined(id, 999);

    const final = await repo.findById(id);
    expect(final!.status).toBe('FAILED');
  });

  // ── [7] pollStaleRequests ─────────────────────────────────────────────────

  it('[7] pollStaleRequests() — 30분 초과 PENDING 건 VASP 상태 재조회 후 처리', async () => {
    const txHash = '0x' + '77'.repeat(32);

    // 40분 전 PENDING 상태 레코드를 직접 INSERT
    const staleId = randomUUID();
    await pool.query(
      `INSERT INTO tx_mint_requests
       (id, user_id, token_id, amount, status, tx_hash, retry_count, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'PENDING',$5,0,
               NOW() - INTERVAL '40 minutes',
               NOW() - INTERVAL '40 minutes')`,
      [staleId, 'user-tx-007', '1001', '1', txHash],
    );

    // VASP가 'not_found' 응답 → handleFailed('tx not found in mempool') → FAILED
    // (PENDING → CONFIRMED은 handleConfirmed 내부 guard로 no-op; PENDING → FAILED는 유효)
    vasp.setStatusResponse(txHash, 'not_found');

    const { processed } = await svc.pollStaleRequests();
    expect(processed).toBeGreaterThanOrEqual(1);

    const result = await repo.findById(staleId);
    expect(result!.status).toBe('FAILED');
  });

  // ── [8] transition 이벤트 ────────────────────────────────────────────────

  it('[8] transition 이벤트가 발행되어 외부 시스템을 트리거할 수 있다', async () => {
    const txHash = '0x' + '88'.repeat(32);
    vasp.setNextTxHash(txHash);

    const captured: TxTransitionEvent[] = [];
    svc.on('transition', (e: TxTransitionEvent) => captured.push(e));

    const { requestId: id } = await svc.submitMintRequest({
      userId: 'user-tx-008', tokenId: BigInt(2001), amount: BigInt(5),
    });
    await svc.handleMined(id, 300);
    await svc.handleConfirmed(id);
    await svc.handleFinalized(id);

    expect(captured.length).toBeGreaterThanOrEqual(3);

    const finalEvent = captured.find(e => e.to === 'FINALIZED');
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.req.tokenId).toBe(BigInt(2001));
    expect(finalEvent!.req.amount).toBe(BigInt(5));
  });
});
