/**
 * issuer-service 단계별 워크스루 테스트
 *
 * 소스 파일을 수정하지 않고, 테스트 파일에서 프로토타입을 패치해
 * 각 클래스·메서드의 진입/종료를 실시간으로 콘솔에 출력합니다.
 *
 * 실행:
 *   npm run test:integration -- --verbose --testPathPattern=walkthrough
 */

import http                      from 'http';
import crypto                    from 'crypto';
import { Pool }                  from 'pg';
import { randomUUID }            from 'crypto';
import { getPgUrl }              from '../helpers/state';

// ── 실제 서비스 클래스 (프로토타입 패치 대상) ──────────────────────────────────
import { IssuerService }               from '../../apps/issuer-service/src/services/IssuerService';
import { IssuancePolicyService }       from '../../apps/issuer-service/src/services/IssuancePolicyService';
import { EventConditionService, ActivityConditionStrategy } from '../../apps/issuer-service/src/services/EventConditionService';
import { PgIssuanceRequestRepository } from '../../apps/issuer-service/src/services/IssuanceRequestRepository';
import { TokenIssuerFactory }          from '../../apps/issuer-service/src/factory/TokenIssuerFactory';
import { ActivityRouter }              from '../../apps/issuer-service/src/api/ActivityRouter';
import { IssuanceConfirmHandler }      from '../../apps/issuer-service/src/handlers/IssuanceConfirmHandler';
import { TxStateMachineService }       from '../../packages/vasp/src/tx/TxStateMachineService';
import { PgTxRepository }              from '../../packages/vasp/src/tx/PgTxRepository';
import { LedgerService }               from '../../packages/core-banking/src/ledger/LedgerService';

import { WebhookServer, IdempotencyGuard, InMemoryIdempotencyStore } from '@kyobo/event-engine/webhook';
import { StubCoreBankingAdapter } from '@kyobo/core-banking';
import type { IVASPAdapter, VASPTransactionReceipt, SubmitTransactionParams } from '../../packages/vasp/src/interfaces/IVASPAdapter';
import type { IBlockchainAdapter } from '@kyobo/chain-adapters';

// ── 로그 유틸 ─────────────────────────────────────────────────────────────────
// process.stdout.write 사용 — Jest의 console 인터셉터를 우회해 소스 위치 주석 제거

let _depth = 0;
const pad  = () => '  '.repeat(_depth);
const w    = (s: string) => process.stdout.write(s + '\n');

function logEnter(cls: string, method: string, detail = '') {
  w(`${pad()}▶ [${cls}] ${method}()${detail ? '  ' + detail : ''}`);
  _depth++;
}
function logExit(cls: string, method: string, detail = '') {
  _depth--;
  w(`${pad()}◀ [${cls}] ${method}()${detail ? '  → ' + detail : ''}`);
}
function logInfo(msg: string) {
  w(`${pad()}  ${msg}`);
}
function section(title: string) {
  w(`\n${'━'.repeat(64)}`);
  w(`  ${title}`);
  w('━'.repeat(64));
  _depth = 0;
}

// ── DB 상태 출력 ──────────────────────────────────────────────────────────────

async function printDb(pool: Pool, label: string) {
  w(`\n  📋 [DB] ${label}`);

  // ── issuance_requests ────────────────────────────────────────────────────
  const { rows } = await pool.query(
    'SELECT id, user_id, event_type, token_id, status, tx_hash, wallet_addr, fail_reason FROM issuance_requests ORDER BY created_at',
  );
  w(`       ┌─ issuance_requests (${rows.length}건)`);
  if (rows.length === 0) {
    w('       │  (레코드 없음)');
  }
  for (const r of rows) {
    w(`       │  id          : ${r.id}`);
    w(`       │  user_id     : ${r.user_id}`);
    w(`       │  event_type  : ${r.event_type}  token_id: ${r.token_id}`);
    w(`       │  status      : ${r.status}(IssuanceStatus)`);
    w(`       │  tx_hash     : ${r.tx_hash     ?? '(null)'}`);
    w(`       │  wallet_addr : ${r.wallet_addr ?? '(null)'}`);
    w(`       │  fail_reason : ${r.fail_reason ?? '(null)'}`);
  }

  // ── tx_mint_requests ─────────────────────────────────────────────────────
  const { rows: mints } = await pool.query(
    'SELECT id, user_id, token_id, amount, status, tx_hash, block_number, retry_count, fail_reason FROM tx_mint_requests ORDER BY created_at',
  );
  w(`       ├─ tx_mint_requests (${mints.length}건)`);
  if (mints.length === 0) {
    w('       │  (레코드 없음)');
  }
  for (const r of mints) {
    w(`       │  id           : ${r.id}`);
    w(`       │  user_id      : ${r.user_id}  token_id: ${r.token_id}  amount: ${r.amount}`);
    w(`       │  status       : ${r.status}(TxStatus)`);
    w(`       │  tx_hash      : ${r.tx_hash      ?? '(null)'}`);
    w(`       │  block_number : ${r.block_number ?? '(null)'}`);
    w(`       │  retry_count  : ${r.retry_count}`);
    w(`       │  fail_reason  : ${r.fail_reason  ?? '(null)'}`);
  }

  // ── mint_requests ─────────────────────────────────────────────────────────
  const { rows: ledger } = await pool.query(
    'SELECT id, user_id, policy_id, status, tx_hash, token_id, error_msg FROM mint_requests ORDER BY created_at',
  );
  w(`       └─ mint_requests (${ledger.length}건)`);
  if (ledger.length === 0) {
    w('          (레코드 없음)');
  }
  for (const r of ledger) {
    w(`          id        : ${r.id}`);
    w(`          user_id   : ${r.user_id}  policy_id: ${r.policy_id}`);
    w(`          status    : ${r.status}(MintStatus)`);
    w(`          tx_hash   : ${r.tx_hash   ?? '(null)'}`);
    w(`          token_id  : ${r.token_id  ?? '(null)'}`);
    w(`          error_msg : ${r.error_msg ?? '(null)'}`);
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 100));
  }
}

// ── 계측용 VASP 스텁 ─────────────────────────────────────────────────────────

class InstrumentedVaspAdapter implements IVASPAdapter {
  txHash     = '0x' + 'ab'.repeat(32);
  shouldFail = false;

  async submitTransaction(p: SubmitTransactionParams): Promise<VASPTransactionReceipt> {
    logEnter('StubVaspAdapter', 'submitTransaction', `method=${p.method}, tokenId=${p.args[1]}`);
    if (this.shouldFail) {
      logInfo('❌ shouldFail=true → 예외 발생');
      logExit('StubVaspAdapter', 'submitTransaction', 'throw Error');
      throw new Error('VASP TX failed: network timeout');
    }
    logInfo(`txHash = ${this.txHash}`);
    logExit('StubVaspAdapter', 'submitTransaction', `status=submitted(VASP응답)`);
    return { txHash: this.txHash, status: 'submitted', timestamp: Date.now() };
  }

  async screenAddress(addr: string): Promise<{ flagged: boolean }> {
    logEnter('StubVaspAdapter', 'screenAddress', addr);
    logExit('StubVaspAdapter', 'screenAddress', 'flagged=false');
    return { flagged: false };
  }

  async createWallet(_: string): Promise<any>     { throw new Error('not used'); }
  async getWallet(_: string): Promise<null>        { return null; }
  async transfer(_: any): Promise<any>             { throw new Error('not used'); }
  async getTransferStatus(_: string): Promise<any> { throw new Error('not used'); }
}

// ── 계측용 CoreBanking 스텁 ──────────────────────────────────────────────────

class InstrumentedCoreBankingAdapter extends StubCoreBankingAdapter {
  override async getUserAccount(userId: string) {
    logEnter('StubCoreBankingAdapter', 'getUserAccount', `userId=${userId}`);
    const result = await super.getUserAccount(userId);
    logExit('StubCoreBankingAdapter', 'getUserAccount',
      result ? `status=${result.status}(KYC상태), wallet=${result.walletAddr}` : 'null');
    return result;
  }

  override async notifyReward(n: any) {
    logEnter('StubCoreBankingAdapter', 'notifyReward', `userId=${n.userId}, tokenId=${n.tokenId}`);
    logExit('StubCoreBankingAdapter', 'notifyReward', 'fire-and-forget');
  }
}

// ── 설정 ─────────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET    = 'e2e-test-secret-kyobo';
const WEBHOOK_PORT      = 19879;
const NFT_ISSUER_ADDR   = '0xNFTISSUER0000000000000000000000000000001';
const NFT_CONTRACT_ADDR = '0xNFTCONTRACT000000000000000000000000001';
const TEST_WALLET_ADDR  = '0xDEADBEEF000000000000000000000000DEADBEEF';
const TEST_USER_ID      = 'user-walkthrough-001';
const TEST_EVENT_TYPE   = 'WALK_GOAL_MET';

// ── 프로토타입 패치 원본 보관 ────────────────────────────────────────────────

const originals: Array<[any, string, Function]> = [];

function patch<T extends object>(proto: T, method: keyof T & string, cls: string) {
  const orig = proto[method] as Function;
  originals.push([proto, method, orig]);

  (proto as any)[method] = async function (...args: any[]) {
    // 메서드별 진입 로그 포맷
    const detail = buildDetail(cls, method, args);
    logEnter(cls, method, detail);
    try {
      const result = await orig.apply(this, args);
      logExit(cls, method, buildResult(cls, method, result));
      return result;
    } catch (err) {
      _depth = Math.max(0, _depth - 1);
      w(`${pad()}✗ [${cls}] ${method}() 예외: ${(err as Error).message}`);
      throw err;
    }
  };
}

function buildDetail(cls: string, method: string, args: any[]): string {
  if (cls === 'IssuerService' && method === 'issueActivityNFT')
    return `userId=${args[0]?.userId}, activityId=${args[0]?.activityId?.slice(0, 8)}...`;
  if (cls === 'IssuancePolicyService' && method === 'getPolicy')
    return `eventType=${args[0]}`;
  if (cls === 'EventConditionService' && method === 'evaluate')
    return `eventType=${args[0]?.eventType}, steps=${args[0]?.data?.steps}`;
  if (cls === 'ActivityConditionStrategy' && method === 'evaluate')
    return `steps=${args[0]?.data?.steps}`;
  if (cls === 'PgIssuanceRequestRepository' && method === 'create')
    return `status=${args[0]?.status}(IssuanceStatus), eventType=${args[0]?.eventType}`;
  if (cls === 'PgIssuanceRequestRepository' && method === 'updateStatus')
    return `id=${String(args[0]).slice(0, 8)}..., status=${args[1]}(IssuanceStatus)`;
  if (cls === 'PgIssuanceRequestRepository' && method === 'setWalletAddr')
    return `wallet=${args[1]}`;
  if (cls === 'PgIssuanceRequestRepository' && method === 'findPending')
    return `userId=${args[0]}, eventType=${args[1]}`;
  if (cls === 'PgIssuanceRequestRepository' && method === 'findByTxHash')
    return `txHash=${String(args[0]).slice(0, 10)}...`;
  if (cls === 'TxStateMachineService' && method === 'submitMintRequest')
    return `userId=${args[0]?.userId}, tokenId=${args[0]?.tokenId}, wallet=${String(args[0]?.walletAddr).slice(0, 10)}...`;
  if (cls === 'PgTxRepository' && method === 'save')
    return `id=${String(args[0]?.id).slice(0, 8)}..., status=${args[0]?.status}(TxStatus)`;
  if (cls === 'PgTxRepository' && method === 'updateStatus')
    return `id=${String(args[0]).slice(0, 8)}..., status=${args[1]}(TxStatus)`;
  if (cls === 'IssuanceConfirmHandler' && method === 'handle')
    return `txHash=${String(args[0]?.txHash).slice(0, 10)}..., block=${args[0]?.blockNumber}`;
  if (cls === 'LedgerService' && method === 'createMintRequest')
    return `userId=${args[0]}, policyId=${String(args[1]).slice(0, 8)}...`;
  if (cls === 'LedgerService' && method === 'updateMintRequest')
    return `id=${String(args[0]).slice(0, 8)}..., status=${args[1]?.status}(MintStatus)`;
  return '';
}

function buildResult(cls: string, method: string, r: any): string {
  if (!r) return 'null';
  if (cls === 'IssuerService' && method === 'issueActivityNFT')
    return `eligible=${r.eligible}, txHash=${String(r.txHash ?? '').slice(0, 10)}...`;
  if (cls === 'IssuancePolicyService' && method === 'getPolicy')
    return `tokenId=${r.tokenId}, amount=${r.amount}`;
  if (cls === 'EventConditionService' && method === 'evaluate')
    return `eligible=${r.eligible}`;
  if (cls === 'ActivityConditionStrategy' && method === 'evaluate')
    return `eligible=${r.eligible}`;
  if (cls === 'PgIssuanceRequestRepository' && method === 'create')
    return `id=${String(r.id).slice(0, 8)}...`;
  if (cls === 'PgIssuanceRequestRepository' && method === 'findPending')
    return r ? `id=${r.id.slice(0, 8)}... (중복)` : 'null (중복 없음)';
  if (cls === 'PgIssuanceRequestRepository' && method === 'findByTxHash')
    return r ? `status=${r.status}(IssuanceStatus)` : 'null';
  if (cls === 'TxStateMachineService' && method === 'submitMintRequest')
    return `requestId=${String(r?.requestId).slice(0, 8)}..., txHash=${String(r?.txHash).slice(0, 10)}...`;
  if (cls === 'PgTxRepository' && method === 'save')
    return 'saved';
  if (cls === 'LedgerService' && method === 'createMintRequest')
    return `id=${String(r?.id).slice(0, 8)}..., status=${r?.status}(MintStatus)`;
  if (cls === 'LedgerService' && method === 'updateMintRequest')
    return `status=${r?.status}(MintStatus)`;
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────

describe('issuer-service 메서드 콜 트레이스 워크스루', () => {
  let pool:           Pool;
  let webhookServer:  WebhookServer;
  let vasp:           InstrumentedVaspAdapter;
  let coreBanking:    InstrumentedCoreBankingAdapter;
  let confirmHandler: IssuanceConfirmHandler;

  beforeAll(async () => {
    // ── 프로토타입 패치 (인스턴스 생성 전에 적용해야 함) ──────────────────────
    patch(IssuerService.prototype,               'issueActivityNFT',    'IssuerService');
    patch(IssuancePolicyService.prototype,        'getPolicy',           'IssuancePolicyService');
    patch(EventConditionService.prototype,        'evaluate',            'EventConditionService');
    patch(ActivityConditionStrategy.prototype,    'evaluate',            'ActivityConditionStrategy');
    patch(PgIssuanceRequestRepository.prototype,  'create',              'PgIssuanceRequestRepository');
    patch(PgIssuanceRequestRepository.prototype,  'findPending',         'PgIssuanceRequestRepository');
    patch(PgIssuanceRequestRepository.prototype,  'setWalletAddr',       'PgIssuanceRequestRepository');
    patch(PgIssuanceRequestRepository.prototype,  'updateStatus',        'PgIssuanceRequestRepository');
    patch(PgIssuanceRequestRepository.prototype,  'findByTxHash',        'PgIssuanceRequestRepository');
    patch(TxStateMachineService.prototype,        'submitMintRequest',   'TxStateMachineService');
    patch(PgTxRepository.prototype,               'save',                'PgTxRepository');
    patch(PgTxRepository.prototype,               'updateStatus',        'PgTxRepository');
    patch(IssuanceConfirmHandler.prototype,       'handle',              'IssuanceConfirmHandler');
    patch(LedgerService.prototype,                'createMintRequest',   'LedgerService');
    patch(LedgerService.prototype,                'updateMintRequest',   'LedgerService');

    pool = new Pool({ connectionString: getPgUrl() });
    await pool.query(`
      INSERT INTO issuance_policies (event_type, token_id, amount)
      VALUES ($1, 1001, 1) ON CONFLICT (event_type) DO NOTHING
    `, [TEST_EVENT_TYPE]);

    vasp        = new InstrumentedVaspAdapter();
    coreBanking = new InstrumentedCoreBankingAdapter();
    coreBanking.seedUser({ userId: TEST_USER_ID, accountId: 'acc-001',
                           walletAddr: TEST_WALLET_ADDR, status: 'active' });

    const factory      = new TokenIssuerFactory({
      chainAdapter:  {} as unknown as IBlockchainAdapter,
      vaspAdapter:   vasp,
      coreBanking,
      pool,
    });
    const { issuerService, confirmHandler: handler } = factory.createNFTIssuer(
      NFT_ISSUER_ADDR,
      new EventConditionService([new ActivityConditionStrategy()]),
    );
    confirmHandler = handler;

    const idempotency  = new IdempotencyGuard(new InMemoryIdempotencyStore());
    webhookServer      = new WebhookServer({ port: WEBHOOK_PORT, secret: WEBHOOK_SECRET, maxBodyKb: 64 });
    new ActivityRouter(issuerService, idempotency).register(webhookServer);
    await webhookServer.listen();
  });

  afterAll(async () => {
    // 패치 복원
    for (const [proto, method, orig] of originals) {
      (proto as any)[method] = orig;
    }
    await webhookServer.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE issuance_requests, tx_mint_requests, mint_requests');
    vasp.shouldFail = false;
    vasp.txHash     = '0x' + 'ab'.repeat(32);
    _depth          = 0;
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  [1] 정상 발행 전체 흐름
  // ══════════════════════════════════════════════════════════════════════════

  it('[1] 정상 발행: HTTP → REQUESTED → SUBMITTED → CONFIRMED (콜 트레이스)', async () => {
    section('시나리오 [1] 정상 발행 전체 흐름');

    await printDb(pool, '시작 전');

    // ── Webhook 전송 ────────────────────────────────────────────────────────
    w('\n  🌐 HTTP POST → WebhookServer (HMAC 서명 검증)\n');

    const activityId = randomUUID();
    const payload = {
      eventType: 'ACTIVITY_ACHIEVED', requestId: randomUUID(), timestamp: Date.now(),
      data: { userId: TEST_USER_ID, activityId, eventType: TEST_EVENT_TYPE,
              eventCode: 1, data: { steps: 15_000 } },
    };
    const body = JSON.stringify(payload);
    const sig  = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port: WEBHOOK_PORT, method: 'POST',
          headers: { 'Content-Type': 'application/json',
                     'Content-Length': Buffer.byteLength(body),
                     'x-kyobo-signature': sig } },
        res => resolve(res.statusCode!),
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    w(`\n  ✓ WebhookServer 응답: ${statusCode} (즉시 202, 비동기 처리 계속)`);

    // ── SUBMITTED 대기 ──────────────────────────────────────────────────────
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows[0]?.status === 'SUBMITTED';
    });

    await printDb(pool, 'SUBMITTED 완료 후');

    // ── IssuanceConfirmHandler (온체인 이벤트 시뮬레이션) ──────────────────
    w('\n  ⛓  온체인 NFTIssuer.Issued 이벤트 시뮬레이션\n');

    const { rows } = await pool.query('SELECT tx_hash FROM issuance_requests');
    await confirmHandler.handle({
      txHash:      rows[0].tx_hash,
      contractAddr: NFT_CONTRACT_ADDR,
      eventName:   'Issued',
      blockNumber:  9999,
      logIndex:     0,
      args:         { to: TEST_WALLET_ADDR, tokenId: '1001', amount: '1' },
      raw:          {},
    });

    // TxTransitionBridge가 이벤트를 비동기로 처리하므로 CONFIRMED 대기
    await waitFor(async () => {
      const { rows: r } = await pool.query('SELECT status FROM issuance_requests');
      return r[0]?.status === 'CONFIRMED';
    });

    await printDb(pool, '최종 (CONFIRMED)');

    const { rows: final } = await pool.query('SELECT status FROM issuance_requests');
    expect(final[0].status).toBe('CONFIRMED');
  }, 30_000);

  // ══════════════════════════════════════════════════════════════════════════
  //  [2] 조건 미달
  // ══════════════════════════════════════════════════════════════════════════

  it('[2] 조건 미달: steps=5000 → evaluate()에서 eligible=false → DB 저장 없음', async () => {
    section('시나리오 [2] 조건 미달 (걸음수 부족)');

    const payload = {
      eventType: 'ACTIVITY_ACHIEVED', requestId: randomUUID(), timestamp: Date.now(),
      data: { userId: TEST_USER_ID, activityId: randomUUID(),
              eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 5_000 } },
    };
    const body = JSON.stringify(payload);
    const sig  = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

    w('\n  🌐 HTTP POST → WebhookServer\n');
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port: WEBHOOK_PORT, method: 'POST',
          headers: { 'Content-Type': 'application/json',
                     'Content-Length': Buffer.byteLength(body),
                     'x-kyobo-signature': sig } },
        () => resolve(),
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    await new Promise(r => setTimeout(r, 600));
    await printDb(pool, '처리 완료 후');

    const { rows } = await pool.query('SELECT * FROM issuance_requests');
    expect(rows).toHaveLength(0);
  }, 10_000);

  // ══════════════════════════════════════════════════════════════════════════
  //  [3] KYC 실패
  // ══════════════════════════════════════════════════════════════════════════

  it('[3] KYC 실패: account suspended → REQUESTED 후 FAILED', async () => {
    section('시나리오 [3] KYC 실패 (계정 정지)');

    coreBanking.seedUser({ userId: 'user-suspended', accountId: 'acc-sus',
                           walletAddr: TEST_WALLET_ADDR, status: 'suspended' });

    const payload = {
      eventType: 'ACTIVITY_ACHIEVED', requestId: randomUUID(), timestamp: Date.now(),
      data: { userId: 'user-suspended', activityId: randomUUID(),
              eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
    };
    const body = JSON.stringify(payload);
    const sig  = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

    w('\n  🌐 HTTP POST → WebhookServer\n');
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port: WEBHOOK_PORT, method: 'POST',
          headers: { 'Content-Type': 'application/json',
                     'Content-Length': Buffer.byteLength(body),
                     'x-kyobo-signature': sig } },
        () => resolve(),
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows[0]?.status === 'FAILED';
    });

    await printDb(pool, '최종 (FAILED)');

    const { rows } = await pool.query('SELECT status, fail_reason FROM issuance_requests');
    expect(rows[0].status).toBe('FAILED');
    expect(rows[0].fail_reason).toContain('account not active');
  }, 15_000);

  // ══════════════════════════════════════════════════════════════════════════
  //  [4] VASP 실패
  // ══════════════════════════════════════════════════════════════════════════

  it('[4] VASP 실패: submitTransaction() 예외 → FAILED', async () => {
    section('시나리오 [4] VASP TX 실패');

    vasp.shouldFail = true;

    const payload = {
      eventType: 'ACTIVITY_ACHIEVED', requestId: randomUUID(), timestamp: Date.now(),
      data: { userId: TEST_USER_ID, activityId: randomUUID(),
              eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
    };
    const body = JSON.stringify(payload);
    const sig  = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

    w('\n  🌐 HTTP POST → WebhookServer\n');
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port: WEBHOOK_PORT, method: 'POST',
          headers: { 'Content-Type': 'application/json',
                     'Content-Length': Buffer.byteLength(body),
                     'x-kyobo-signature': sig } },
        () => resolve(),
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows[0]?.status === 'FAILED';
    });

    await printDb(pool, '최종 (FAILED)');

    const { rows } = await pool.query('SELECT status, fail_reason FROM issuance_requests');
    expect(rows[0].status).toBe('FAILED');
    expect(rows[0].fail_reason).toContain('VASP TX failed');
  }, 15_000);
});
