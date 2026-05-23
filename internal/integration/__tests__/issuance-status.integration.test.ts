/**
 * IssuanceStatus 통합 테스트
 *
 * PgIssuanceRequestRepository → 실제 PostgreSQL
 * IssuanceConfirmHandler       → SUBMITTED → CONFIRMED 연결 고리
 * IssuerService.handleVaspTxFailed → SUBMITTED → FAILED 연결 고리
 *
 * 검증 시나리오:
 *   [1] REQUESTED 생성 및 DB 반영
 *   [2] REQUESTED → SUBMITTED (txHash 기록)
 *   [3] SUBMITTED → CONFIRMED (IssuanceConfirmHandler)
 *   [4] SUBMITTED → FAILED    (handleVaspTxFailed)
 *   [5] 종단 상태 보호 — CONFIRMED 이후 전이 시도 → throw
 *   [6] 종단 상태 보호 — FAILED 이후 전이 시도 → throw
 *   [7] 멱등성 — findPending으로 중복 요청 감지
 *   [8] findByTxHash 조회
 */

import { Pool }                    from 'pg';
import { randomUUID }              from 'crypto';
import { getPgUrl }                from '../helpers/state';
import {
  PgIssuanceRequestRepository,
}                                  from '../../apps/issuer-service/src/services/IssuanceRequestRepository';
import { IssuanceConfirmHandler }  from '../../apps/issuer-service/src/handlers/IssuanceConfirmHandler';
import { PgTxRepository }          from '../../packages/vasp/src/tx/PgTxRepository';
import { TxStateMachineService }   from '../../packages/vasp/src/tx/TxStateMachineService';
import { TxTransitionBridge }      from '../../apps/issuer-service/src/services/TxTransitionBridge';
import { LedgerService }           from '../../packages/core-banking/src/ledger/LedgerService';
import { PgDatabaseClient }        from '../../packages/core-banking/src/ledger/PgDatabaseClient';
import { StubCoreBankingAdapter }  from '@kyobo/core-banking';

const TX_HASH = '0xaabbcc0000000000000000000000000000000000000000000000000000000001';

describe('IssuanceStatus 상태 전이 — PgIssuanceRequestRepository', () => {
  let pool:    Pool;
  let repo:    PgIssuanceRequestRepository;
  let txRepo:  PgTxRepository;
  let handler: IssuanceConfirmHandler;

  beforeAll(() => {
    pool = new Pool({ connectionString: getPgUrl() });
    repo = new PgIssuanceRequestRepository(pool);

    txRepo = new PgTxRepository(pool);
    const stubVasp = {
      async submitMint()           { return { txHash: '0x0' }; },
      async getStatus()            { return { status: 'pending' as const }; },
      async resubmitWithGasBump()  { return { txHash: '0x0' }; },
    };
    const txStateMachine = new TxStateMachineService(txRepo, stubVasp);
    const ledgerService  = new LedgerService(new PgDatabaseClient(pool), new StubCoreBankingAdapter());
    const bridge         = new TxTransitionBridge(ledgerService, repo);
    bridge.attach(txStateMachine);
    handler = new IssuanceConfirmHandler('0xCONTRACT', txRepo, txStateMachine);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE issuance_requests, tx_mint_requests, mint_requests');
  });

  // ── [1] 생성 ──────────────────────────────────────────────────────────────

  it('[1] create() → REQUESTED 상태로 DB에 저장된다', async () => {
    const req = await repo.create({
      userId:     'user-001',
      eventType:  'WALK_10000',
      tokenId:    BigInt(1001),
      amount:     BigInt(1),
      walletAddr: null,
      status:     'REQUESTED',
      txHash:     null,
      failReason: null,
    });

    expect(req.id).toBeTruthy();
    expect(req.status).toBe('REQUESTED');
    expect(req.tokenId).toBe(BigInt(1001));

    // DB 직접 확인
    const { rows } = await pool.query('SELECT status FROM issuance_requests WHERE id = $1', [req.id]);
    expect(rows[0]!.status).toBe('REQUESTED');
  });

  // ── [2] REQUESTED → SUBMITTED ─────────────────────────────────────────────

  it('[2] updateStatus() REQUESTED → SUBMITTED + txHash 기록', async () => {
    const req = await repo.create({
      userId: 'user-002', eventType: 'WALK_10000',
      tokenId: BigInt(1001), amount: BigInt(1),
      walletAddr: null, status: 'REQUESTED', txHash: null, failReason: null,
    });

    await repo.updateStatus(req.id, 'SUBMITTED', { txHash: TX_HASH });

    const updated = await repo.findById(req.id);
    expect(updated!.status).toBe('SUBMITTED');
    expect(updated!.txHash).toBe(TX_HASH);
  });

  // ── [3] SUBMITTED → CONFIRMED (IssuanceConfirmHandler) ───────────────────

  it('[3] IssuanceConfirmHandler — onchain Issued 이벤트 → CONFIRMED 전이', async () => {
    // issuance_requests: SUBMITTED 상태로 준비
    const req = await repo.create({
      userId: 'user-003', eventType: 'WALK_10000',
      tokenId: BigInt(1001), amount: BigInt(1),
      walletAddr: '0xWALLET', status: 'REQUESTED', txHash: null, failReason: null,
    });
    await repo.updateStatus(req.id, 'SUBMITTED', { txHash: TX_HASH });

    // tx_mint_requests: IssuanceConfirmHandler가 txHash로 조회하므로 SUBMITTED 행 필요
    const txId = randomUUID();
    const now  = new Date();
    await txRepo.save({
      id: txId, userId: 'user-003', tokenId: BigInt(1001), amount: BigInt(1),
      status: 'SUBMITTED', txHash: TX_HASH, retryCount: 0, createdAt: now, updatedAt: now,
    });

    await handler.handle({ txHash: TX_HASH, blockNumber: 9999 } as any);

    // TxTransitionBridge는 EventEmitter를 통해 비동기로 issuance_requests 업데이트
    await new Promise(r => setTimeout(r, 300));

    const confirmed = await repo.findById(req.id);
    expect(confirmed!.status).toBe('CONFIRMED');
    expect(confirmed!.txHash).toBe(TX_HASH);
  });

  it('[3-b] IssuanceConfirmHandler — tx_mint_requests 없으면 건너뜀 (멱등성)', async () => {
    // 해당 txHash를 가진 tx_mint_requests 레코드가 없으면 에러 없이 종료
    await expect(
      handler.handle({ txHash: '0xNONEXISTENT' } as any),
    ).resolves.toBeUndefined();
  });

  // ── [4] SUBMITTED → FAILED (VASP_TX_FAILED) ──────────────────────────────

  it('[4] findByTxHash + updateStatus → SUBMITTED → FAILED (VASP 실패 흐름)', async () => {
    const req = await repo.create({
      userId: 'user-004', eventType: 'WALK_10000',
      tokenId: BigInt(1001), amount: BigInt(1),
      walletAddr: '0xWALLET', status: 'REQUESTED', txHash: null, failReason: null,
    });
    await repo.updateStatus(req.id, 'SUBMITTED', { txHash: TX_HASH });

    // ActivityRouter._handleVaspTxFailed 내부 로직 직접 실행
    const found = await repo.findByTxHash(TX_HASH);
    expect(found).not.toBeNull();
    expect(found!.status).toBe('SUBMITTED');

    await repo.updateStatus(found!.id, 'FAILED', { failReason: 'REVERT: ERC1155: insufficient balance' });

    const failed = await repo.findById(req.id);
    expect(failed!.status).toBe('FAILED');
    expect(failed!.failReason).toContain('ERC1155');
  });

  // ── [5] 종단 상태 보호 — CONFIRMED ───────────────────────────────────────

  it('[5] CONFIRMED 이후 updateStatus 시도 → 예외 발생', async () => {
    const req = await repo.create({
      userId: 'user-005', eventType: 'WALK_10000',
      tokenId: BigInt(1001), amount: BigInt(1),
      walletAddr: null, status: 'REQUESTED', txHash: null, failReason: null,
    });
    await repo.updateStatus(req.id, 'SUBMITTED', { txHash: TX_HASH });
    await repo.updateStatus(req.id, 'CONFIRMED');

    await expect(
      repo.updateStatus(req.id, 'FAILED', { failReason: '늦은 실패 시도' }),
    ).rejects.toThrow('상태 전이 불가');
  });

  // ── [6] 종단 상태 보호 — FAILED ──────────────────────────────────────────

  it('[6] FAILED 이후 updateStatus 시도 → 예외 발생', async () => {
    const req = await repo.create({
      userId: 'user-006', eventType: 'WALK_10000',
      tokenId: BigInt(1001), amount: BigInt(1),
      walletAddr: null, status: 'REQUESTED', txHash: null, failReason: null,
    });
    await repo.updateStatus(req.id, 'FAILED', { failReason: 'AML flagged' });

    await expect(
      repo.updateStatus(req.id, 'SUBMITTED', { txHash: TX_HASH }),
    ).rejects.toThrow('상태 전이 불가');
  });

  // ── [7] 멱등성 — findPending ──────────────────────────────────────────────

  it('[7] findPending() — 진행 중인 요청 감지 (중복 발행 방지)', async () => {
    const created = await repo.create({
      userId: 'user-007', eventType: 'WALK_10000',
      tokenId: BigInt(1001), amount: BigInt(1),
      walletAddr: null, status: 'REQUESTED', txHash: null, failReason: null,
    });

    const pending = await repo.findPending('user-007', 'WALK_10000', BigInt(1001));
    expect(pending).not.toBeNull();
    expect(pending!.id).toBe(created.id);

    // CONFIRMED 이후에는 pending에서 제외
    await repo.updateStatus(created.id, 'SUBMITTED', { txHash: TX_HASH });
    await repo.updateStatus(created.id, 'CONFIRMED');

    const afterConfirmed = await repo.findPending('user-007', 'WALK_10000', BigInt(1001));
    expect(afterConfirmed).toBeNull();
  });

  // ── [8] findByTxHash ──────────────────────────────────────────────────────

  it('[8] findByTxHash() — txHash로 단건 조회', async () => {
    await repo.create({
      userId: 'user-008', eventType: 'WALK_10000',
      tokenId: BigInt(1001), amount: BigInt(1),
      walletAddr: null, status: 'REQUESTED', txHash: null, failReason: null,
    });
    const req = await repo.findByTxHash(TX_HASH);
    expect(req).toBeNull();

    const created = await repo.create({
      userId: 'user-008b', eventType: 'WALK_10000',
      tokenId: BigInt(1002), amount: BigInt(1),
      walletAddr: null, status: 'REQUESTED', txHash: null, failReason: null,
    });
    await repo.updateStatus(created.id, 'SUBMITTED', { txHash: TX_HASH });

    const found = await repo.findByTxHash(TX_HASH);
    expect(found).not.toBeNull();
    expect(found!.userId).toBe('user-008b');
  });
});
