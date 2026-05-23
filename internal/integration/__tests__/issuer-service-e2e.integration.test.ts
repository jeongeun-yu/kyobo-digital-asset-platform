/**
 * issuer-service E2E 통합 테스트
 *
 * 실제 흐름:
 *   HTTP POST (HMAC 서명) → WebhookServer → ActivityRouter
 *   → IssuerService → PostgreSQL (issuance_policies + issuance_requests)
 *   → IssuanceConfirmHandler (온체인 이벤트 시뮬레이션) → CONFIRMED
 *
 * 실제 동작:
 *   - WebhookServer: 실제 HTTP 서버 (HMAC-SHA256 서명 검증 포함)
 *   - IssuerService: 실제 비즈니스 로직 (정책 조회 → 조건 판단 → VASP 위탁)
 *   - PostgreSQL: 실제 DB (issuance_policies + issuance_requests)
 *
 * 외부 경계 목(mock):
 *   - IVASPAdapter     → StubVaspAdapter  (TX 브로드캐스트 시뮬레이션)
 *   - ICoreBankingAdapter → StubCoreBankingAdapter (KYC 상태 시뮬레이션)
 *   - ChainEventListener  → IssuanceConfirmHandler.handle() 직접 호출 (블록체인 불필요)
 */

import http                      from 'http';
import crypto                    from 'crypto';
import { Pool }                  from 'pg';
import { randomUUID }            from 'crypto';
import { getPgUrl }              from '../helpers/state';

import { TokenIssuerFactory }          from '../../apps/issuer-service/src/factory/TokenIssuerFactory';
import { ActivityConditionStrategy, EventConditionService } from '../../apps/issuer-service/src/services/EventConditionService';
import { ActivityRouter }              from '../../apps/issuer-service/src/api/ActivityRouter';
import { IssuanceConfirmHandler }      from '../../apps/issuer-service/src/handlers/IssuanceConfirmHandler';
import { PgIssuanceRequestRepository } from '../../apps/issuer-service/src/services/IssuanceRequestRepository';

import { WebhookServer, IdempotencyGuard, InMemoryIdempotencyStore } from '@kyobo/event-engine/webhook';
import type { WebhookPayload } from '@kyobo/event-engine/webhook';
import { StubCoreBankingAdapter } from '@kyobo/core-banking';
import type { IVASPAdapter, VASPTransactionReceipt, SubmitTransactionParams } from '../../packages/vasp/src/interfaces/IVASPAdapter';
import type { IBlockchainAdapter } from '@kyobo/chain-adapters';

// ── 설정 상수 ─────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET    = 'e2e-test-secret-kyobo';
const WEBHOOK_PORT      = 19877;
const NFT_ISSUER_ADDR   = '0xNFTISSUER0000000000000000000000000000001';
const NFT_CONTRACT_ADDR = '0xNFTCONTRACT000000000000000000000000001';
const TEST_WALLET_ADDR  = '0xDEADBEEF000000000000000000000000DEADBEEF';
const TEST_EVENT_TYPE   = 'WALK_GOAL_MET';
const TEST_TOKEN_ID     = '1001';

// ── 외부 경계 스텁 ────────────────────────────────────────────────────────────

class StubVaspAdapter implements IVASPAdapter {
  txHash    = '0x' + 'ef'.repeat(32);
  shouldFail = false;

  async submitTransaction(_: SubmitTransactionParams): Promise<VASPTransactionReceipt> {
    if (this.shouldFail) throw new Error('VASP TX failed: network timeout');
    return { txHash: this.txHash, status: 'submitted', timestamp: Date.now() };
  }

  async screenAddress(_: string): Promise<{ flagged: boolean; reason?: string }> {
    return { flagged: false };
  }

  async createWallet(_: string): Promise<any>       { throw new Error('not used'); }
  async getWallet(_: string): Promise<null>          { return null; }
  async transfer(_: any): Promise<any>               { throw new Error('not used'); }
  async getTransferStatus(_: string): Promise<any>   { throw new Error('not used'); }
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function makePayload(overrides: Partial<WebhookPayload> & { data: Record<string, unknown> }): WebhookPayload {
  return {
    eventType:  'ACTIVITY_ACHIEVED',
    requestId:  randomUUID(),
    timestamp:  Date.now(),
    ...overrides,
  };
}

function postWebhook(
  payload: WebhookPayload,
  opts: { secret?: string } = {},
): Promise<number> {
  const body   = JSON.stringify(payload);
  const secret = opts.secret ?? WEBHOOK_SECRET;
  const sig    = crypto.createHmac('sha256', secret).update(body).digest('hex');

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port:     WEBHOOK_PORT,
        method:   'POST',
        headers:  {
          'Content-Type':       'application/json',
          'Content-Length':     Buffer.byteLength(body),
          'x-kyobo-signature':  sig,
        },
      },
      res => resolve(res.statusCode!),
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('issuer-service E2E — WebhookServer → IssuerService → PostgreSQL', () => {
  let pool:                Pool;
  let webhookServer:       WebhookServer;
  let vasp:                StubVaspAdapter;
  let coreBanking:         StubCoreBankingAdapter;
  let issuanceRepo:        PgIssuanceRequestRepository;
  let confirmHandler:      IssuanceConfirmHandler;

  beforeAll(async () => {
    pool = new Pool({ connectionString: getPgUrl() });

    // issuance_policies 시드 데이터
    await pool.query(`
      INSERT INTO issuance_policies (event_type, token_id, amount)
      VALUES ($1, $2, 1)
      ON CONFLICT (event_type) DO NOTHING
    `, [TEST_EVENT_TYPE, TEST_TOKEN_ID]);

    // 외부 경계 스텁
    vasp        = new StubVaspAdapter();
    coreBanking = new StubCoreBankingAdapter();
    coreBanking.seedUser({
      userId:     'user-e2e-001',
      accountId:  'acc-e2e-001',
      walletAddr: TEST_WALLET_ADDR,
      status:     'active',
    });

    // 실제 서비스 조립
    const chainAdapter = {} as unknown as IBlockchainAdapter;

    const factory      = new TokenIssuerFactory({ chainAdapter, vaspAdapter: vasp, coreBanking, pool });
    const conditionSvc = new EventConditionService([new ActivityConditionStrategy()]);
    const { issuerService, confirmHandler: handler } =
      factory.createNFTIssuer(NFT_ISSUER_ADDR, conditionSvc);

    issuanceRepo   = new PgIssuanceRequestRepository(pool);
    confirmHandler = handler;

    // 실제 WebhookServer + ActivityRouter
    const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());
    webhookServer     = new WebhookServer({ port: WEBHOOK_PORT, secret: WEBHOOK_SECRET, maxBodyKb: 64 });
    const router      = new ActivityRouter(issuerService, idempotency);
    router.register(webhookServer);

    await webhookServer.listen();
  });

  afterAll(async () => {
    await webhookServer.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE issuance_requests, tx_mint_requests, mint_requests');
    vasp.shouldFail = false;
    vasp.txHash     = '0x' + 'ef'.repeat(32);
  });

  // ── [1] 정상 E2E 경로 ────────────────────────────────────────────────────

  it('[1] ACTIVITY_ACHIEVED HTTP → SUBMITTED → IssuanceConfirmHandler → CONFIRMED', async () => {
    const txHash = '0x' + 'a1'.repeat(32);
    vasp.txHash  = txHash;

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId: 'user-e2e-001', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
    }));

    expect(statusCode).toBe(202);

    // WebhookServer는 202 즉시 반환 — 비동기 처리 완료 대기
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0 && rows[0].status === 'SUBMITTED';
    });

    const { rows } = await pool.query('SELECT * FROM issuance_requests');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('SUBMITTED');
    expect(rows[0].tx_hash).toBe(txHash);
    expect(rows[0].wallet_addr).toBe(TEST_WALLET_ADDR);

    // 온체인 Issued 이벤트 시뮬레이션 → CONFIRMED
    // TxTransitionBridge가 이벤트를 비동기로 처리하므로 waitFor로 대기
    await confirmHandler.handle({
      txHash,
      contractAddr: NFT_CONTRACT_ADDR,
      eventName:    'Issued',
      blockNumber:  9999,
      logIndex:     0,
      args:         {},
      raw:          {},
    });

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows[0]?.status === 'CONFIRMED';
    });

    const { rows: confirmed } = await pool.query('SELECT status FROM issuance_requests');
    expect(confirmed[0].status).toBe('CONFIRMED');
  });

  // ── [2] 멱등성 ──────────────────────────────────────────────────────────

  it('[2] 동일 requestId 두 번 POST → issuance_requests 레코드 1개만 생성', async () => {
    const payload = makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId: 'user-e2e-001', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 20_000 } },
    });

    await postWebhook(payload);
    await postWebhook(payload); // 동일 requestId

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0 && rows[0].status === 'SUBMITTED';
    });

    const { rows } = await pool.query('SELECT * FROM issuance_requests');
    expect(rows).toHaveLength(1);
  });

  // ── [3] 조건 미달 ────────────────────────────────────────────────────────

  it('[3] steps < 10,000 → eligible=false → issuance_requests 레코드 없음', async () => {
    await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId: 'user-e2e-001', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 5_000 } },
    }));

    await new Promise(r => setTimeout(r, 500));

    const { rows } = await pool.query('SELECT * FROM issuance_requests');
    expect(rows).toHaveLength(0);
  });

  // ── [4] KYC 실패 ─────────────────────────────────────────────────────────

  it('[4] 계정 정지(suspended) → KYC 실패 → issuance_requests FAILED', async () => {
    coreBanking.seedUser({
      userId: 'user-suspended', accountId: 'acc-suspended',
      walletAddr: TEST_WALLET_ADDR, status: 'suspended',
    });

    await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId: 'user-suspended', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
    }));

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0 && rows[0].status !== 'REQUESTED';
    });

    const { rows } = await pool.query('SELECT status, fail_reason FROM issuance_requests');
    expect(rows[0].status).toBe('FAILED');
    expect(rows[0].fail_reason).toContain('account not active');
  });

  // ── [5] VASP TX 실패 ──────────────────────────────────────────────────────

  it('[5] VASP submitTransaction 실패 → issuance_requests FAILED', async () => {
    vasp.shouldFail = true;

    await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId: 'user-e2e-001', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
    }));

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0;
    });

    const { rows } = await pool.query('SELECT status, fail_reason FROM issuance_requests');
    expect(rows[0].status).toBe('FAILED');
    expect(rows[0].fail_reason).toContain('VASP TX failed');
  });

  // ── [6] VASP_TX_FAILED webhook ───────────────────────────────────────────

  it('[6] VASP_TX_FAILED webhook → SUBMITTED → FAILED 전이', async () => {
    const txHash = '0x' + 'f6'.repeat(32);
    vasp.txHash  = txHash;

    // 먼저 SUBMITTED 상태로 만들기
    await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId: 'user-e2e-001', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
    }));

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0 && rows[0].status === 'SUBMITTED';
    });

    // VASP_TX_FAILED webhook 수신
    await postWebhook({
      eventType:  'VASP_TX_FAILED',
      requestId:  randomUUID(),
      timestamp:  Date.now(),
      data: { txHash, reason: 'onchain REVERT: ERC1155: insufficient balance' },
    });

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows[0]?.status === 'FAILED';
    });

    const { rows } = await pool.query('SELECT status, fail_reason FROM issuance_requests');
    expect(rows[0].status).toBe('FAILED');
    expect(rows[0].fail_reason).toContain('REVERT');
  });

  // ── [7] HMAC 서명 검증 ───────────────────────────────────────────────────

  it('[7] 잘못된 HMAC 서명 → 401 Unauthorized', async () => {
    const statusCode = await postWebhook(
      makePayload({
        eventType: 'ACTIVITY_ACHIEVED',
        data: { userId: 'user-e2e-001', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
      }),
      { secret: 'wrong-secret' },
    );

    expect(statusCode).toBe(401);

    const { rows } = await pool.query('SELECT * FROM issuance_requests');
    expect(rows).toHaveLength(0);
  });
});
