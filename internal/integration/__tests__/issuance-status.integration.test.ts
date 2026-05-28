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
 *   [9] Webhook NFT_ISSUED → NFTIssuedProcessor — creditNFT + updateMintRequestConfirmed
 *       → TxStatus·MintStatus·IssuanceStatus 세 레이어 동시 CONFIRMED 전이
 */

import { Pool }                    from 'pg';
import { randomUUID }              from 'crypto';
import { getPgUrl }                from '../helpers/state';
import {
  PgIssuanceRequestRepository,
}                                  from '../../apps/issuer-service/src/services/IssuanceRequestRepository';
import { IssuanceConfirmHandler }  from '../../apps/issuer-service/src/handlers/IssuanceConfirmHandler';
import { PgTxRepository }          from '../../apps/issuer-service/src/infra/PgTxRepository';
import { TxStateMachineService }   from '../../packages/vasp/src/tx/TxStateMachineService';
import { TxTransitionBridge }      from '../../apps/issuer-service/src/services/TxTransitionBridge';
import { LedgerService }           from '../../packages/core-banking/src/ledger/LedgerService';
import { PgDatabaseClient }        from '../../apps/issuer-service/src/infra/PgDatabaseClient';
import { StubCoreBankingAdapter }  from '@kyobo/core-banking';
import { PgNFTLedgerService }      from '../../apps/issuer-service/src/infra/PgNFTLedgerService';
import {
  NFTIssuedProcessor,
  IdempotencyGuard,
  InMemoryIdempotencyStore,
}                                  from '@kyobo/event-engine';

const TX_HASH = '0xaabbcc0000000000000000000000000000000000000000000000000000000001';

describe('IssuanceStatus 상태 전이 — PgIssuanceRequestRepository', () => {
  let pool:           Pool;
  let repo:           PgIssuanceRequestRepository;
  let txRepo:         PgTxRepository;
  let txStateMachine: TxStateMachineService;
  let handler:        IssuanceConfirmHandler;

  beforeAll(() => {
    pool = new Pool({ connectionString: getPgUrl() });
    repo = new PgIssuanceRequestRepository(pool);

    txRepo = new PgTxRepository(pool);
    const stubVasp = {
      async submitMint()           { return { txHash: '0x0' }; },
      async getStatus()            { return { status: 'pending' as const }; },
      async resubmitWithGasBump()  { return { txHash: '0x0' }; },
    };
    txStateMachine = new TxStateMachineService(txRepo, stubVasp);
    const ledgerService  = new LedgerService(new PgDatabaseClient(pool), new StubCoreBankingAdapter());
    const bridge         = new TxTransitionBridge(ledgerService, repo);
    bridge.attach(txStateMachine);
    handler = new IssuanceConfirmHandler('0xCONTRACT', txRepo, txStateMachine);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE issuance_requests, tx_mint_requests, mint_requests, user_nft_holdings');
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

  // ── [9] Webhook NFT_ISSUED 경로 ──────────────────────────────────────────────
  //
  // 검증 대상: NFTIssuedProcessor.process()
  //   → creditNFT (user_nft_holdings)
  //   → updateMintRequestConfirmed → TxStateMachineService.handleMined + handleConfirmed
  //   → TxTransitionBridge 'transition' 이벤트
  //     → mint_requests CONFIRMED
  //     → issuance_requests CONFIRMED
  //
  // ChainEventListener 없이 Webhook 경로만으로 세 레이어 동시 CONFIRMED 전이 확인.

  it('[9] Webhook NFT_ISSUED → NFTIssuedProcessor — creditNFT + 세 상태 레이어 동시 CONFIRMED', async () => {
    const WEBHOOK_TX_HASH  = '0x' + 'f9'.repeat(32);
    const WALLET_ADDR      = '0xWEBHOOK090909090909090909090909090909';
    const WEBHOOK_TOKEN_ID = '9001';
    const txRequestId      = randomUUID();
    const mintRequestId    = randomUUID();
    const now              = new Date();

    // ① user_wallet_mapping — creditNFT의 _resolveUserId 조회 대상
    await pool.query(
      `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
       VALUES ('user-webhook-009', $1, 'MOCK', true) ON CONFLICT (user_id) DO NOTHING`,
      [WALLET_ADDR],
    );

    // ② tx_mint_requests: SUBMITTED (TxStateMachineService 조회 대상)
    await txRepo.save({
      id: txRequestId, userId: 'user-webhook-009',
      tokenId: BigInt(WEBHOOK_TOKEN_ID), amount: BigInt(1),
      status: 'SUBMITTED', txHash: WEBHOOK_TX_HASH,
      retryCount: 0, createdAt: now, updatedAt: now,
    });

    // ③ mint_requests: SUBMITTED + txHash (TxTransitionBridge → ledgerService.findByTxHash 대상)
    await pool.query(
      `INSERT INTO mint_requests (id, user_id, policy_id, status, tx_hash, created_at, updated_at)
       VALUES ($1, 'user-webhook-009', 'policy-webhook', 'SUBMITTED', $2, NOW(), NOW())`,
      [mintRequestId, WEBHOOK_TX_HASH],
    );

    // ④ issuance_requests: SUBMITTED + txHash (TxTransitionBridge → issuanceRepo.findByTxHash 대상)
    const issuanceReq = await repo.create({
      userId: 'user-webhook-009', eventType: 'WALK_10000',
      tokenId: BigInt(WEBHOOK_TOKEN_ID), amount: BigInt(1),
      walletAddr: WALLET_ADDR, status: 'REQUESTED', txHash: null, failReason: null,
    });
    await repo.updateStatus(issuanceReq.id, 'SUBMITTED', { txHash: WEBHOOK_TX_HASH });

    // ⑤ NFTIssuedProcessor 구성 — PgNFTLedgerService에 txStateMachine + txRepo 주입
    const webhookLedger = new PgNFTLedgerService(
      pool, '0xCONTRACT', 31337, txStateMachine, txRepo,
    );
    const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const processor   = new NFTIssuedProcessor(idempotency, webhookLedger);

    // ⑥ NFT_ISSUED 스트림 메시지 직접 처리
    await processor.process({
      id: '1-0',
      fields: {
        eventType:   'NFT_ISSUED',
        requestId:   txRequestId,
        txHash:      WEBHOOK_TX_HASH,
        payload:     JSON.stringify({ tokenId: WEBHOOK_TOKEN_ID, to: WALLET_ADDR, blockNumber: 5000 }),
        publishedAt: new Date().toISOString(),
        _retryCount: '0',
      },
    });

    // TxTransitionBridge EventEmitter 비동기 처리 대기
    await new Promise(r => setTimeout(r, 300));

    // ⑦ TxStatus CONFIRMED 확인 (tx_mint_requests)
    const txReq = await txRepo.findById(txRequestId);
    expect(txReq!.status).toBe('CONFIRMED');

    // ⑧ MintStatus CONFIRMED 확인 (mint_requests)
    const { rows: mintRows } = await pool.query(
      'SELECT status FROM mint_requests WHERE id = $1', [mintRequestId],
    );
    expect(mintRows[0]!.status).toBe('CONFIRMED');

    // ⑨ IssuanceStatus CONFIRMED 확인 (issuance_requests)
    const issuanceResult = await repo.findById(issuanceReq.id);
    expect(issuanceResult!.status).toBe('CONFIRMED');

    // ⑩ user_nft_holdings creditNFT 확인
    const { rows: holdingRows } = await pool.query(
      `SELECT amount FROM user_nft_holdings WHERE user_id = 'user-webhook-009'`,
    );
    expect(Number(holdingRows[0]!.amount)).toBe(1);
  });
});
