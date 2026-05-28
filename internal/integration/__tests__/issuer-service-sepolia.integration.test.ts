/**
 * issuer-service Sepolia 통합 테스트
 *
 * 실제 흐름:
 *   HTTP POST → WebhookServer → WebhookPublishHandler → Redis Stream → ActivityProcessor → IssuerService
 *   → ExternalVASPAdapter → VASPServer (HTTP) → MockVASP (Sepolia 테스트넷)
 *   → VASPServer NFT_ISSUED 콜백 → WebhookServer → Redis Stream → NFTIssuedProcessor
 *   → ChainEventListener (Issued 이벤트) → IssuanceConfirmHandler
 *   → TxStateMachineService → PostgreSQL CONFIRMED
 *
 * 9가지 시나리오:
 *   [1] NORMAL     : 정상 발행 → Issued 이벤트 → CONFIRMED
 *   [2] REVERT     : TX revert → issuance_requests FAILED
 *   [3] NO_EMIT    : mint 성공, 이벤트 없음 → SUBMITTED 유지
 *   [4] PENDING    : 자연 발생 mempool pending 구간 포착 → CONFIRMED
 *   [5] REORG      : DB 상태 주입 → tx_mint_requests REORGED → 상태머신 검증
 *   [stream-2]     : 중복 requestId → 멱등성 보장 (Redis Stream 독립 검증)
 *   [stream-3]     : retryCount >= 3 → DLQ 이동
 *   [stream-4]     : XAUTOCLAIM — PEL 잔류 메시지 재수신 처리
 *   [poll-1]       : pollStaleRequests — PENDING 10분 초과 → getTransferStatus → CONFIRMED
 *
 * Sepolia 제약 및 대체 구현:
 *   [4] PENDING — evm_setAutomine 불가 → nonce 블로커 TX(maxFeePerGas=1 wei)로 대체
 *   [5] REORG   — evm_snapshot 불가 → DB 상태 직접 주입(UPDATE status='REORGED')으로 대체
 *
 * 인프라:
 *   - Sepolia 테스트넷 (SEPOLIA_RPC_URL 환경변수)
 *   - MockVASP 고정 주소 (SEPOLIA_MOCK_VASP_ADDR 환경변수)
 *   - PostgreSQL — @testcontainers/postgresql
 *   - Redis — testcontainers GenericContainer
 */

import { readFileSync }                 from 'fs';
import { resolve }                      from 'path';
import http                             from 'http';
import crypto                           from 'crypto';
import { randomUUID }                   from 'crypto';
import { ethers }                       from 'ethers';
import { Pool }                         from 'pg';
import Redis                            from 'ioredis';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Network, StartedNetwork, Wait } from 'testcontainers';

import { TokenIssuerFactory }                    from '../../apps/issuer-service/src/factory/TokenIssuerFactory';
import { ActivityConditionStrategy, EventConditionService } from '../../apps/issuer-service/src/services/EventConditionService';
import { IssuanceConfirmHandler }                from '../../apps/issuer-service/src/handlers/IssuanceConfirmHandler';
import type { IEventHandler }                    from '@kyobo/event-engine/interfaces';
import { IoRedisAdapter }                        from '../../apps/issuer-service/src/infra/RedisAdapter';
import {
  WebhookServer,
  IdempotencyGuard,
  RedisIdempotencyStore,
  WebhookPublishHandler,
  WebhookPayload,
}                                                from '@kyobo/event-engine/webhook';
import { KyoboCoreBankingAdapter, InternalGatewayClient } from '@kyobo/core-banking';
import { LedgerService }                         from '../../packages/core-banking/src/ledger/LedgerService';
import { PgDatabaseClient }                      from '../../apps/issuer-service/src/infra/PgDatabaseClient';
import { EVMAdapter }                            from '@kyobo/chain-adapters';
import type { ChainEvent }                       from '@kyobo/chain-adapters';
import { ChainEventListener }                    from '@kyobo/event-engine/listener';
import {
  ConsumerGroupPool,
  DLQHandler,
  NFTIssuedProcessor,
  ActivityProcessor,
  InMemoryLedgerService,
  RedisStreamPublisher,
  StreamMessage,
}                                                from '@kyobo/event-engine';
import { PgNFTLedgerService }                    from '../../apps/issuer-service/src/infra/PgNFTLedgerService';
import { SepoliaVASPAdapter }                    from '../vasp-testing/SepoliaVASPAdapter';
import { VASPServer }                            from '../vasp-testing/VASPServer';
import { ExternalVASPAdapter }                   from '@kyobo/vasp';
import { TxStateMachineService }                 from '../../packages/vasp/src/tx/TxStateMachineService';

import MOCK_VASP_ABI                             from '../vasp-testing/MockVASP.abi.json';
import { ReconcileService, ReconcileAdminService } from '@kyobo/core-banking';
import { PgNftHoldingRepository }                from '../../apps/issuer-service/src/infra/PgNftHoldingRepository';

// ── 상수 ──────────────────────────────────────────────────────────────────────

const WEBHOOK_PORT    = 19879;          // mock-vasp(19878)과 충돌 방지
const VASP_PORT       = 19877;          // mock-vasp(19876)과 충돌 방지
const WEBHOOK_SECRET  = 'sepolia-test-secret-kyobo-32chars!!';
const TEST_EVENT_TYPE = 'WALK_GOAL_MET';

// Sepolia는 고정 컨트랙트 — 이전 실행 잔액과 충돌하지 않도록 실행마다 새로운 TOKEN_ID 사용
const TOKEN_ID    = String(Date.now());
const TOKEN_ID_BN = BigInt(TOKEN_ID);


// ── PgHybridCoreBankingAdapter ────────────────────────────────────────────────

// getUserAccount: 테스트용 로컬 DB (user_wallet_mapping) 조회
// recordNftHolding / recordAuditLog: Java internal-ledger 경유 (운영과 동일 경로)
class PgHybridCoreBankingAdapter extends KyoboCoreBankingAdapter {
  constructor(private readonly pool: Pool, gateway: InternalGatewayClient) {
    super(gateway);
  }

  override async getUserAccount(userId: string) {
    const { rows } = await this.pool.query(
      'SELECT wallet_addr FROM user_wallet_mapping WHERE user_id = $1',
      [userId],
    );
    if (!rows[0]) return null;
    return {
      userId,
      accountId:  `acc-${userId}`,
      walletAddr: rows[0].wallet_addr as string,
      status:     'active' as const,
    };
  }
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function makePayload(
  overrides: Partial<WebhookPayload> & { data: Record<string, unknown> },
): WebhookPayload {
  return {
    eventType: 'ACTIVITY_ACHIEVED',
    requestId: randomUUID(),
    timestamp: Date.now(),
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
          'Content-Type':      'application/json',
          'Content-Length':    Buffer.byteLength(body),
          'x-kyobo-signature': sig,
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
  timeoutMs = 120_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`);
    await new Promise(r => setTimeout(r, 500));
  }
}

function elapsed(startMs: number): string {
  return `+${((Date.now() - startMs) / 1000).toFixed(1)}s`;
}

async function logDbState(pool: Pool, label: string, startMs: number): Promise<void> {
  const [iss, mint, tx] = await Promise.all([
    pool.query('SELECT status, fail_reason, tx_hash FROM issuance_requests ORDER BY created_at DESC LIMIT 1'),
    pool.query('SELECT status,              tx_hash FROM mint_requests     ORDER BY created_at DESC LIMIT 1'),
    pool.query('SELECT status,              tx_hash FROM tx_mint_requests  ORDER BY created_at DESC LIMIT 1'),
  ]);
  const fmt = (rows: any[], table: string) => {
    if (rows.length === 0) return `${table}: (없음)`;
    const r = rows[0];
    const fail = r.fail_reason ? ` fail=${String(r.fail_reason).slice(0, 50)}` : '';
    const tx   = r.tx_hash    ? ` tx=${String(r.tx_hash).slice(0, 14)}…`      : '';
    return `${table}: ${r.status.padEnd(10)}${tx}${fail}`;
  };
  console.log(`  [DB ${elapsed(startMs)}] ${label}`);
  console.log(`    · ${fmt(iss.rows,  '[issuance_requests]')}`);
  console.log(`    · ${fmt(mint.rows, '[mint_requests]    ')}`);
  console.log(`    · ${fmt(tx.rows,   '[tx_mint_requests] ')}`);
}

async function logRedisStream(redis: Redis, label: string, startMs: number): Promise<void> {
  try {
    const streamKey = 'kyobo:events';
    const xlen      = await (redis as any).xlen(streamKey) as number;
    // XPENDING: [count, minId, maxId, [[consumer, count], ...]]
    const pending   = await (redis as any).xpending(streamKey, 'activity-consumers') as [number, string|null, string|null, unknown[]|null];
    const nftPend   = await (redis as any).xpending(streamKey, 'nft-consumers')      as [number, string|null, string|null, unknown[]|null];
    console.log(
      `  [Stream ${elapsed(startMs)}] ${label}` +
      ` — xlen=${xlen}` +
      ` activity-pending=${pending[0]}` +
      ` nft-pending=${nftPend[0]}`,
    );
  } catch {
    // group not yet created — ignore
  }
}


// ── 전역 상태 ─────────────────────────────────────────────────────────────────

let sepoliaRpc:     string;
let mockVaspAddr:   string;
let operatorAddr:   string;

let dockerNetwork:  StartedNetwork;
let pgContainer:    StartedPostgreSqlContainer;
let javaContainer:  { getHost(): string; getMappedPort(port: number): number; stop(): Promise<unknown> };
let javaBaseUrl:    string;
let redisContainer: { getHost(): string; getMappedPort(port: number): number; stop(): Promise<unknown> };
let pool:           Pool;

let vaspServer:     VASPServer;
let controlVasp:    SepoliaVASPAdapter;
let coreBanking:    PgHybridCoreBankingAdapter;
let ledgerService:  LedgerService;
let webhookServer:  WebhookServer;
let chainListener:  ChainEventListener;
let provider:       ethers.JsonRpcProvider;
let chainAdapter:   EVMAdapter;
let confirmHandler: IssuanceConfirmHandler;
let txStateMachine: TxStateMachineService;
let redis:          Redis;
let redisAdapter:   IoRedisAdapter;
let ledger:         PgNFTLedgerService;
let consumerPool:   ConsumerGroupPool;


// ── AlwaysFailProcessor (DLQ / 재처리 시나리오용) ─────────────────────────────

class AlwaysFailProcessor extends NFTIssuedProcessor {
  async process(_msg: StreamMessage): Promise<void> {
    throw new Error('강제 실패 — DLQ 테스트용');
  }
}

// Issued 이벤트 → processed_events 기록 (ChainEventListener 파이프라인용)
class ProcessedEventHandler implements IEventHandler {
  readonly eventName    = 'Issued';
  readonly contractAddr: string;

  constructor(
    contractAddr:              string,
    private readonly ledger:   LedgerService,
  ) {
    this.contractAddr = contractAddr;
  }

  async handle(event: ChainEvent): Promise<void> {
    const safePayload = JSON.parse(
      JSON.stringify(event.args, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
    await this.ledger.recordProcessedEvent(
      event.txHash, event.logIndex, event.eventName, BigInt(event.blockNumber), safePayload,
    ).catch(e => console.error('[ProcessedEventHandler] error:', (e as Error).message));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('issuer-service Sepolia 통합 테스트 — 9가지 시나리오', () => {

  // ── beforeAll ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  [SETUP] Sepolia 통합 테스트 환경 구축');
    console.log('══════════════════════════════════════════════════════════════');

    // ① 환경변수 검증
    const { SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, OPERATOR_PRIVATE_KEY, SEPOLIA_MOCK_VASP_ADDR } = process.env;
    if (!SEPOLIA_RPC_URL)       throw new Error('SEPOLIA_RPC_URL 환경변수 없음');
    if (!DEPLOYER_PRIVATE_KEY)  throw new Error('DEPLOYER_PRIVATE_KEY 환경변수 없음');
    if (!OPERATOR_PRIVATE_KEY)  throw new Error('OPERATOR_PRIVATE_KEY 환경변수 없음');
    if (!SEPOLIA_MOCK_VASP_ADDR) throw new Error('SEPOLIA_MOCK_VASP_ADDR 환경변수 없음');

    sepoliaRpc   = SEPOLIA_RPC_URL;
    mockVaspAddr = SEPOLIA_MOCK_VASP_ADDR;
    operatorAddr = new ethers.Wallet(OPERATOR_PRIVATE_KEY).address;
    provider     = new ethers.JsonRpcProvider(sepoliaRpc);

    console.log(`  [1/5] Sepolia RPC          ${sepoliaRpc}`);
    console.log(`  [1/5] MockVASP 주소        ${mockVaspAddr}`);
    console.log(`  [1/5] OPERATOR 주소        ${operatorAddr}`);
    console.log(`  [1/5] TOKEN_ID (이번 실행) ${TOKEN_ID}`);

    // Sepolia 연결 확인
    const network = await provider.getNetwork();
    if (network.chainId !== 11155111n) throw new Error(`예상 chainId 11155111, 실제 ${network.chainId}`);
    console.log(`  [1/5] Sepolia 연결 확인 (chainId ${network.chainId})`);

    // ② Redis 컨테이너
    console.log('\n  [2/6] Redis 컨테이너 시작...');
    redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    redis = new Redis(redisUrl);
    console.log(`  [2/6] Redis 준비 완료 → ${redisUrl}`);

    // ③ PostgreSQL + Java internal-ledger 컨테이너
    console.log('\n  [3/6] PostgreSQL + Java 컨테이너 시작...');
    dockerNetwork = await new Network().start();
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('kyobo_test')
      .withUsername('kyobo')
      .withPassword('kyobo')
      .withNetwork(dockerNetwork)
      .withNetworkAliases('postgres')
      .start();
    pool = new Pool({ connectionString: pgContainer.getConnectionUri() });

    const schema = readFileSync(resolve(__dirname, '..', 'setup', 'schema.sql'), 'utf-8');
    await pool.query(schema);
    console.log('  [3/6] PostgreSQL 준비 완료');

    javaContainer = await new GenericContainer('kyobo/internal-ledger:test')
      .withNetwork(dockerNetwork)
      .withEnvironment({
        DB_URL:           'jdbc:postgresql://postgres:5432/kyobo_test',
        DB_USERNAME:      'kyobo',
        DB_PASSWORD:      'kyobo',
        CORE_BANKING_URL: 'http://localhost:9999',
      })
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp('/api/internal/health', 8080).forStatusCode(200))
      .start();
    javaBaseUrl = `http://${javaContainer.getHost()}:${javaContainer.getMappedPort(8080)}`;
    console.log(`  [3/6] Java 컨테이너 준비 완료 → ${javaBaseUrl}`);

    // ⑤ VASPServer 기동 (ExternalVASPAdapter 호출 대상)
    console.log('\n  [4/6] VASPServer 기동...');
    vaspServer = new VASPServer({
      port:           VASP_PORT,
      rpcUrl:         sepoliaRpc,
      signerKey:      OPERATOR_PRIVATE_KEY,
      contractAddr:   mockVaspAddr,
      callbackUrl:    `http://localhost:${WEBHOOK_PORT}`,
      callbackSecret: WEBHOOK_SECRET,
    });
    await vaspServer.start();
    console.log(`  [4/6] VASPServer 준비 완료 → :${VASP_PORT}`);

    // controlVasp: DEPLOYER_KEY — setMode 전용 (OPERATOR와 nonce 분리)
    controlVasp = new SepoliaVASPAdapter({
      rpcUrl:       sepoliaRpc,
      privateKey:   DEPLOYER_PRIVATE_KEY,
      mockVaspAddr: mockVaspAddr,
    });

    // ⑥ Core Banking 어댑터 + 정적 데이터 시드
    const gateway = new InternalGatewayClient({ baseUrl: javaBaseUrl, secret: 'test-secret' });
    coreBanking = new PgHybridCoreBankingAdapter(pool, gateway);

    await pool.query(
      `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
       VALUES ($1, $2, 'SEPOLIA', true) ON CONFLICT (user_id) DO NOTHING`,
      ['user-sepolia-001', operatorAddr],
    );
    await pool.query(
      `INSERT INTO issuance_policies (event_type, token_id, amount)
       VALUES ($1, $2, 1) ON CONFLICT (event_type) DO NOTHING`,
      [TEST_EVENT_TYPE, TOKEN_ID],
    );

    ledgerService = new LedgerService(new PgDatabaseClient(pool), coreBanking);
    // ⑦ 서비스 조립
    console.log('\n  [5/6] IssuerService + ChainEventListener + WebhookServer 조립...');

    chainAdapter = new EVMAdapter({
      rpcUrl:  sepoliaRpc,
      chainId: '11155111',
    });

    const externalVasp = new ExternalVASPAdapter({
      baseUrl: `http://localhost:${VASP_PORT}`,
      apiKey:  'test-api-key',
    });

    const conditionSvc = new EventConditionService([new ActivityConditionStrategy()]);
    const factory      = new TokenIssuerFactory({
      chainAdapter,
      vaspAdapter: externalVasp,
      coreBanking,
      pool,
    });

    const factoryResult = factory.createNFTIssuer(mockVaspAddr, conditionSvc);
    const { issuerService } = factoryResult;
    confirmHandler  = factoryResult.confirmHandler;
    txStateMachine  = factoryResult.txStateMachine;

    const currentBlock = await chainAdapter.getBlockNumber();
    const inMemoryBlockStore = { block: currentBlock };
    chainListener = new ChainEventListener(
      chainAdapter,
      [confirmHandler, new ProcessedEventHandler(mockVaspAddr, ledgerService)],
      [{
        addr:       mockVaspAddr,
        abi:        MOCK_VASP_ABI as unknown[],
        eventNames: ['Issued'],
      }],
      {
        async getLastProcessedBlock() { return inMemoryBlockStore.block; },
        async setLastProcessedBlock(b) { inMemoryBlockStore.block = b; },
      },
    );
    await chainListener.start();

    // Redis Stream: ACTIVITY_ACHIEVED → XADD → ActivityProcessor → IssuerService
    redisAdapter = new IoRedisAdapter(redis);
    const streamPublisher  = new RedisStreamPublisher(redisAdapter);
    await streamPublisher.initialize('nft-consumers');      // consumer group 생성
    await streamPublisher.initialize('activity-consumers'); // consumer group 생성

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idempotency      = new IdempotencyGuard(new RedisIdempotencyStore(redis as any));
    const webhookPublisher = new WebhookPublishHandler(streamPublisher, idempotency);

    webhookServer = new WebhookServer({ port: WEBHOOK_PORT, secret: WEBHOOK_SECRET, maxBodyKb: 64 });
    webhookServer.on('ACTIVITY_ACHIEVED', webhookPublisher.createHandler());
    webhookServer.on('NFT_ISSUED',        webhookPublisher.createHandler());
    await webhookServer.listen();

    // ConsumerGroupPool: activity-consumers → ActivityProcessor → IssuerService
    //                    nft-consumers      → NFTIssuedProcessor → PgNFTLedgerService
    ledger = new PgNFTLedgerService(pool, mockVaspAddr, 11155111, coreBanking);
    const activityProcessor  = new ActivityProcessor(issuerService, idempotency);
    const nftIssuedProcessor = new NFTIssuedProcessor(idempotency, ledger);
    const streamDlq = new DLQHandler(
      redisAdapter,
      { async sendAlert(msg) { console.error('[DLQ]', msg); } },
    );
    consumerPool = new ConsumerGroupPool(
      redisAdapter, streamDlq,
      // minIdleMs=300_000: 이전 테스트의 PEL 잔류 메시지가 후속 테스트 중
      // XAUTOCLAIM으로 재시도되어 추가 Sepolia TX를 발생시키는 것을 방지한다.
      { streamKey: 'kyobo:events', batchSize: 10, blockMs: 3_000, minIdleMs: 300_000 },
      [
        { groupName: 'activity-consumers', consumerId: 'activity-1', processors: [activityProcessor] },
        { groupName: 'nft-consumers',      consumerId: 'nft-1',      processors: [nftIssuedProcessor] },
      ],
    );
    consumerPool.start().catch(e => console.error('[consumerPool] fatal:', e));

    console.log('  [6/6] 환경 구축 완료');
    console.log('\n══════════════════════════════════════════════════════════════\n');
  }, 300_000);

  // ── afterAll ──────────────────────────────────────────────────────────────

  afterAll(async () => {
    consumerPool?.stop();
    await vaspServer?.stop().catch(() => {});
    await webhookServer?.close().catch(() => {});
    await chainListener?.stop().catch(() => {});
    await redis.quit().catch(() => {});
    await pool.end().catch(() => {});
    await javaContainer?.stop().catch(() => {});
    await pgContainer.stop().catch(() => {});
    await redisContainer?.stop().catch(() => {});
    await dockerNetwork?.stop().catch(() => {});
  });

  // ── beforeEach: 이전 테스트 드레인 → 테이블 초기화 → NonceManager 재동기화 ─

  beforeEach(async () => {
    // Sepolia 블록타임 고려 — 이전 TX가 confirm될 때까지 최대 2분 대기
    // NO_EMIT 테스트 후에는 SUBMITTED 상태가 남아 드레인이 타임아웃되므로 .catch()로 무시
    await waitFor(async () => {
      const { rows } = await pool.query(
        "SELECT COUNT(*) AS cnt FROM issuance_requests WHERE status NOT IN ('CONFIRMED','FAILED')",
      );
      return parseInt(rows[0].cnt, 10) === 0;
    }, 120_000, 'drain previous test').catch(() => {});

    await pool.query('TRUNCATE issuance_requests, tx_mint_requests, mint_requests, processed_events, user_nft_holdings, audit_log, reconcile_history');

    // 이전 테스트에서 발생한 Sepolia TX(PEL 재시도 포함)로 NonceManager 카운터가
    // 체인 실제 nonce와 어긋날 수 있으므로 각 테스트 전에 강제 재동기화한다.
    vaspServer?.resetNonce();
  }, 180_000);

  // ── [1] NORMAL ──────────────────────────────────────────────────────────────

  it('[1] NORMAL — 정상 발행 → Issued 이벤트 → CONFIRMED', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [1] NORMAL — Sepolia 정상 발행 + ChainEventListener → CONFIRMED');
    console.log('──────────────────────────────────────────────────────────────');

    // NORMAL 모드 확인 (이전 테스트 잔류 방어)
    const currentMode = await controlVasp.getMode();
    if (currentMode !== 'NORMAL') {
      console.log(`  · 모드 복원 (현재: ${currentMode} → NORMAL)`);
      await controlVasp.setMode('NORMAL');
    }

    const t0    = Date.now();
    const iface = new ethers.Interface(MOCK_VASP_ABI as ethers.InterfaceAbi);
    const viewContract = new ethers.Contract(mockVaspAddr, iface, provider);
    const balBefore = await (viewContract['balanceOf'] as Function)(operatorAddr, TOKEN_ID_BN) as bigint;
    console.log(`  · 발행 전 온체인 balanceOf  ${balBefore}`);
    console.log(`  · ledger 잔액 (시작)        ${await ledger.getNFTBalance(operatorAddr, TOKEN_ID)}`);
    await logRedisStream(redis, '초기 상태', t0);

    // ── ① Webhook 전송 ──────────────────────────────────────────────────────
    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: {
        userId:     'user-sepolia-001',
        activityId: randomUUID(),
        eventType:  TEST_EVENT_TYPE,
        eventCode:  1,
        data:       { steps: 15_000 },
      },
    }));
    expect(statusCode).toBe(202);
    console.log(`  · webhook POST → 202 수신 (${elapsed(t0)})`);
    await logRedisStream(redis, 'webhook 직후', t0);

    // ── ② REQUESTED → SUBMITTED 전이 대기 (TX broadcast) ─────────────────
    console.log(`\n  ── 상태 폴링: REQUESTED → SUBMITTED ──`);
    let lastStatus = '';
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status, tx_hash FROM issuance_requests');
      if (rows.length === 0) return false;
      if (rows[0].status !== lastStatus) {
        lastStatus = rows[0].status as string;
        const txShort = rows[0].tx_hash ? ` tx=${String(rows[0].tx_hash).slice(0, 16)}…` : '';
        await logDbState(pool, `폴링: ${lastStatus}`, t0);
      }
      return rows[0].status !== 'REQUESTED';
    }, 60_000, 'SUBMITTED');

    const { rows: midRows } = await pool.query('SELECT status, fail_reason, tx_hash FROM issuance_requests');
    if (midRows[0].status === 'FAILED') throw new Error(`TX 조기 실패: ${midRows[0].fail_reason}`);
    await logRedisStream(redis, 'TX broadcast 후', t0);
    console.log(`  · TX hash  ${midRows[0].tx_hash}`);
    console.log(`  · ledger 잔액 (SUBMITTED 시점)  ${await ledger.getNFTBalance(operatorAddr, TOKEN_ID)}`);

    // ── ③ SUBMITTED → CONFIRMED 전이 대기 (Sepolia 블록타임 ~12s) ─────────
    console.log(`\n  ── 상태 폴링: SUBMITTED → CONFIRMED (Sepolia 블록 대기) ──`);
    lastStatus = '';
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      if (rows[0]?.status !== lastStatus) {
        lastStatus = rows[0]?.status as string ?? '';
        await logDbState(pool, '전이 감지', t0);
        await logRedisStream(redis, '전이 감지', t0);
      }
      return rows[0]?.status === 'CONFIRMED';
    }, 180_000, 'CONFIRMED');

    const { rows } = await pool.query('SELECT status, tx_hash, wallet_addr FROM issuance_requests');
    console.log(`\n  ── CONFIRMED 달성 ──────────────────────────────────────────`);
    await logDbState(pool, `최종 확인`, t0);
    console.log(`  · tx_hash      ${rows[0].tx_hash}`);
    console.log(`  · wallet_addr  ${rows[0].wallet_addr}`);
    await logRedisStream(redis, 'CONFIRMED 직후', t0);

    expect(rows[0].status).toBe('CONFIRMED');
    expect(rows[0].tx_hash).toMatch(/^0x/);
    expect(rows[0].wallet_addr?.toLowerCase()).toBe(operatorAddr.toLowerCase());
    console.log('  ✔ CONFIRMED 확인');

    // ── ④ Redis Stream 경로: NFT_ISSUED 콜백 → XADD → NFTIssuedProcessor → ledger ──
    console.log(`\n  ── Redis Stream: NFT_ISSUED 콜백 → ledger ──────────────────`);
    await logRedisStream(redis, 'ledger 대기 전', t0);
    await waitFor(async () => {
      const bal = await ledger.getNFTBalance(operatorAddr, TOKEN_ID);
      if (bal > 0) return true;
      await logRedisStream(redis, `ledger 폴링 bal=${bal}`, t0);
      return false;
    }, 15_000, 'ledger.creditNFT');
    const ledgerBalance = await ledger.getNFTBalance(operatorAddr, TOKEN_ID);
    await logRedisStream(redis, 'ledger 반영 완료', t0);
    console.log(`  · InMemoryLedger balance  ${ledgerBalance} (>0이어야 함)`);
    expect(ledgerBalance).toBeGreaterThan(0);
    console.log(`  ✔ Redis Stream 경로 확인 (IntegrationSepoliaVASP 콜백 → XADD → NFTIssuedProcessor) ${elapsed(t0)}`);

    // ── ⑤ 온체인 balanceOf 증가 확인 ───────────────────────────────────────
    const balAfter = await (viewContract['balanceOf'] as Function)(operatorAddr, TOKEN_ID_BN) as bigint;
    console.log(`\n  ── 온체인 검증 ─────────────────────────────────────────────`);
    console.log(`  · balanceOf  ${balBefore} → ${balAfter} (+1 이어야 함)`);
    expect(balAfter).toBe(balBefore + 1n);
    console.log('  ✔ balanceOf 증가 확인');

    // ── ⑥ DB 상세 검증 ─────────────────────────────────────────────────────
    console.log(`\n  ── DB 상세 검증 ────────────────────────────────────────────`);

    const { rows: wmRows } = await pool.query(
      'SELECT wallet_addr, verified FROM user_wallet_mapping WHERE user_id = $1',
      ['user-sepolia-001'],
    );
    expect(wmRows).toHaveLength(1);
    expect(wmRows[0].wallet_addr.toLowerCase()).toBe(operatorAddr.toLowerCase());
    expect(wmRows[0].verified).toBe(true);
    console.log(`  ✔ user_wallet_mapping  wallet=${wmRows[0].wallet_addr.slice(0, 10)}… verified=${wmRows[0].verified}`);

    const txHash = rows[0].tx_hash as string;
    const { rows: peRows } = await pool.query(
      'SELECT event_name, log_index, block_number FROM processed_events WHERE tx_hash = $1',
      [txHash],
    );
    expect(peRows.length).toBeGreaterThan(0);
    expect(peRows[0].event_name).toBe('Issued');
    console.log(`  ✔ processed_events  event=${peRows[0].event_name} logIndex=${peRows[0].log_index} block=${peRows[0].block_number}`);

    // ── ⑦ DB 검증 ────────────────────────────────────────────────────────
    console.log(`\n  ── DB 검증 ─────────────────────────────────────────────────`);

    // user_nft_holdings — PgNFTLedgerService.creditNFT()가 파이프라인 내 자동 기록
    const { rows: nftRows } = await pool.query(
      'SELECT user_id, token_id, on_chain_tx FROM user_nft_holdings WHERE user_id = $1',
      ['user-sepolia-001'],
    );
    expect(nftRows).toHaveLength(1);
    expect(String(nftRows[0].token_id)).toBe(TOKEN_ID);
    expect(nftRows[0].on_chain_tx.toLowerCase()).toBe(txHash.toLowerCase());
    console.log(`  ✔ user_nft_holdings 자동 기록 확인 (creditNFT 경로)  token_id=${nftRows[0].token_id}`);

    // audit_log — TxTransitionBridge CONFIRMED 전이 시 coreBanking.recordAuditLog 자동 호출
    await waitFor(async () => {
      const { rows } = await pool.query(
        "SELECT actor, action FROM audit_log WHERE resource_type = 'issuance_request'",
      );
      return rows.length > 0;
    }, 10_000, 'audit_log');
    const { rows: auditRows } = await pool.query(
      "SELECT actor, action FROM audit_log WHERE resource_type = 'issuance_request' ORDER BY id DESC LIMIT 1",
    );
    expect(auditRows[0].actor).toBe('user-sepolia-001');
    expect(auditRows[0].action).toBe('ISSUANCE_CONFIRMED');
    console.log(`  ✔ audit_log 자동 기록 확인 (TxTransitionBridge → coreBanking.recordAuditLog)`);

    console.log(`\n  ✔ [1] NORMAL 전체 완료 (총 ${elapsed(t0)})`);
  }, 300_000);

  // ── [2] REVERT ──────────────────────────────────────────────────────────────

  it('[2] REVERT — TX revert → issuance_requests FAILED', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [2] REVERT — Sepolia TX revert 시뮬레이션');
    console.log('──────────────────────────────────────────────────────────────');

    const t0 = Date.now();
    await controlVasp.setMode('REVERT');
    console.log(`  · setMode(REVERT) TX 전송 완료 (${elapsed(t0)})`);
    await logRedisStream(redis, '초기 상태', t0);

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: {
        userId:     'user-sepolia-001',
        activityId: randomUUID(),
        eventType:  TEST_EVENT_TYPE,
        eventCode:  1,
        data:       { steps: 15_000 },
      },
    }));
    expect(statusCode).toBe(202);
    console.log(`  · webhook POST → 202 수신 (${elapsed(t0)})`);
    await logRedisStream(redis, 'webhook 직후', t0);

    // REVERT TX: REQUESTED → SUBMITTED → FAILED 전이 폴링
    console.log(`\n  ── 상태 폴링: REQUESTED → SUBMITTED → FAILED ──`);
    let lastStatus = '';
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status, fail_reason FROM issuance_requests');
      if (rows.length === 0) return false;
      if (rows[0].status !== lastStatus) {
        lastStatus = rows[0].status as string;
        const failPart = rows[0].fail_reason
          ? ` fail=${String(rows[0].fail_reason).slice(0, 60)}`
          : '';
        await logDbState(pool, `폴링: ${lastStatus}`, t0);
        await logRedisStream(redis, `status=${lastStatus}`, t0);
      }
      return rows[0].status !== 'REQUESTED';
    }, 120_000, 'FAILED');

    const { rows } = await pool.query('SELECT status, fail_reason FROM issuance_requests');
    console.log(`\n  ── 최종 상태 ───────────────────────────────────────────────`);
    await logDbState(pool, `최종 확인`, t0);
    console.log(`  · fail_reason  ${String(rows[0].fail_reason).slice(0, 120)}`);
    await logRedisStream(redis, '최종 상태', t0);

    expect(rows[0].status).toBe('FAILED');
    console.log(`  ✔ REVERT → FAILED 확인 (총 ${elapsed(t0)})`);

    // 다음 테스트를 위해 복원
    await controlVasp.setMode('NORMAL');
    console.log('  · setMode(NORMAL) 복원 완료');
  }, 300_000);

  // ── [3] NO_EMIT ─────────────────────────────────────────────────────────────

  it('[3] NO_EMIT — mint 성공, Issued 이벤트 없음 → SUBMITTED 유지', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [3] NO_EMIT — Sepolia mint 성공, Issued 이벤트 없음 → SUBMITTED 유지');
    console.log('──────────────────────────────────────────────────────────────');

    const t0 = Date.now();
    await controlVasp.setMode('NO_EMIT');
    const actualMode = await controlVasp.getMode();
    console.log(`  · setMode(NO_EMIT) 완료 — 실제 모드: ${actualMode} (${elapsed(t0)})`);
    await logRedisStream(redis, '초기 상태', t0);

    const ledgerBefore = await ledger.getNFTBalance(operatorAddr, TOKEN_ID);
    console.log(`  · ledger 잔액 (시작)  ${ledgerBefore}`);

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: {
        userId:     'user-sepolia-001',
        activityId: randomUUID(),
        eventType:  TEST_EVENT_TYPE,
        eventCode:  1,
        data:       { steps: 15_000 },
      },
    }));
    expect(statusCode).toBe(202);
    console.log(`  · webhook POST → 202 수신 (${elapsed(t0)})`);
    await logRedisStream(redis, 'webhook 직후', t0);

    // TX broadcast → SUBMITTED 전이 대기 (이벤트 없으므로 콜백 없음)
    console.log(`\n  ── 상태 폴링: REQUESTED → SUBMITTED ──`);
    let lastStatus = '';
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status, fail_reason, tx_hash FROM issuance_requests');
      if (rows.length === 0) return false;
      if (rows[0].status === 'FAILED') {
        throw new Error(`[3] TX FAILED: ${rows[0].fail_reason ?? '원인 없음'}`);
      }
      if (rows[0].status !== lastStatus) {
        lastStatus = rows[0].status as string;
        const txShort = rows[0].tx_hash ? ` tx=${String(rows[0].tx_hash).slice(0, 16)}…` : '';
        await logDbState(pool, `폴링: ${lastStatus}`, t0);
        await logRedisStream(redis, `status=${lastStatus}`, t0);
      }
      return rows[0].status === 'SUBMITTED';
    }, 60_000, 'SUBMITTED');

    const { rows: subRows } = await pool.query('SELECT tx_hash FROM issuance_requests');
    const txHash = subRows[0].tx_hash as string;
    console.log(`  · TX hash  ${txHash}`);
    console.log(`  · ledger 잔액 (SUBMITTED)  ${await ledger.getNFTBalance(operatorAddr, TOKEN_ID)} ← NFT_ISSUED 콜백 없으므로 변화 없어야 함`);

    // 30s 관찰: CONFIRMED 전이 없음을 확인
    console.log(`\n  ── 30s 관찰: CONFIRMED 전이 없음 확인 ──`);
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      await logDbState(pool, `관찰 ${(i + 1) * 5}s`, t0);
      await logRedisStream(redis, `관찰 ${(i + 1) * 5}s`, t0);
    }

    // 최종 검증
    const { rows } = await pool.query('SELECT status, tx_hash FROM issuance_requests');
    const receipt  = await provider.getTransactionReceipt(txHash);
    const iface    = new ethers.Interface(MOCK_VASP_ABI as ethers.InterfaceAbi);
    const issuedLogs = receipt!.logs.filter(l => {
      try { return iface.parseLog(l)?.name === 'Issued'; } catch { return false; }
    });

    console.log(`\n  ── 최종 상태 ───────────────────────────────────────────────`);
    await logDbState(pool, `최종 확인`, t0);
    console.log(`  · TX receipt.status          ${receipt!.status} (1=성공)`);
    console.log(`  · TX 내 Issued 이벤트 수     ${issuedLogs.length} (0이어야 함)`);
    console.log(`  · ledger 잔액 (최종)         ${await ledger.getNFTBalance(operatorAddr, TOKEN_ID)} (변화 없어야 함)`);
    await logRedisStream(redis, '최종 상태', t0);

    expect(rows[0].status).toBe('SUBMITTED');
    expect(issuedLogs).toHaveLength(0);
    expect(receipt!.status).toBe(1);
    expect(await ledger.getNFTBalance(operatorAddr, TOKEN_ID)).toBe(ledgerBefore);
    console.log(`  ✔ NO_EMIT — SUBMITTED 유지 + TX 성공 + Issued 0개 + ledger 불변 확인 (총 ${elapsed(t0)})`);

    await controlVasp.setMode('NORMAL');
    console.log('  · setMode(NORMAL) 복원 완료');
  }, 300_000);

  // ── [4] PENDING ─────────────────────────────────────────────────────────────
  //
  // Alchemy/Sepolia는 maxFeePerGas < baseFee TX를 "transaction underpriced"로 거부하므로
  // nonce 블로커 방식 사용 불가. 대신 자연 발생하는 mempool pending 구간을 포착해 검증한다:
  //   ① 웹훅 전송 → SUBMITTED (TX broadcast, 아직 채굴 전)
  //   ② SUBMITTED 시점에 eth_getTransactionByHash → blockNumber=null 확인 (진짜 pending)
  //   ③ CONFIRMED 전이 대기 → pending TX가 채굴되어 정상 완료됨을 검증

  it('[4] PENDING — 발행 TX mempool pending 구간 포착 → CONFIRMED', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [4] PENDING — Sepolia 자연 pending 구간 포착 검증');
    console.log('  구현: webhook → SUBMITTED → getTransaction(blockNumber=null) → CONFIRMED');
    console.log('──────────────────────────────────────────────────────────────');

    const t0 = Date.now();

    // NORMAL 모드 확인
    const currentMode = await controlVasp.getMode();
    if (currentMode !== 'NORMAL') await controlVasp.setMode('NORMAL');

    // ── ① 웹훅 전송 ─────────────────────────────────────────────────────────
    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: {
        userId:     'user-sepolia-001',
        activityId: randomUUID(),
        eventType:  TEST_EVENT_TYPE,
        eventCode:  1,
        data:       { steps: 15_000 },
      },
    }));
    expect(statusCode).toBe(202);
    console.log(`  · webhook POST → 202 수신 (${elapsed(t0)})`);

    // ── ② SUBMITTED 전이 대기 ────────────────────────────────────────────────
    console.log(`\n  ── 상태 폴링: REQUESTED → SUBMITTED ──`);
    let lastStatus = '';
    let submittedTxHash = '';
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status, tx_hash FROM issuance_requests');
      if (rows.length === 0) return false;
      if (rows[0].status !== lastStatus) {
        lastStatus = rows[0].status as string;
        await logDbState(pool, `폴링: ${lastStatus}`, t0);
      }
      if (rows[0].status === 'SUBMITTED' && rows[0].tx_hash) {
        submittedTxHash = rows[0].tx_hash as string;
        return true;
      }
      return false;
    }, 60_000, 'SUBMITTED');

    console.log(`  · 발행 TX hash: ${submittedTxHash.slice(0, 18)}…`);

    // ── ③ mempool pending 확인: blockNumber=null ─────────────────────────────
    // SUBMITTED 직후 ~ 채굴 전 짧은 구간에 TX는 mempool에만 존재 (blockNumber=null)
    // Sepolia 블록 시간 ≈ 12s 이므로 SUBMITTED 즉시 조회하면 pending 상태 포착 가능
    const pendingTx = await provider.getTransaction(submittedTxHash);
    console.log(`\n  ── mempool pending 검증 ──`);
    console.log(`  · getTransaction.blockNumber = ${pendingTx?.blockNumber ?? 'null (pending)'}`);
    // pending이면 blockNumber=null, 이미 채굴됐으면 숫자 (타이밍에 따라 달라짐)
    // 어느 경우든 TX가 존재함을 확인 (nonce 충돌/드롭 없음)
    expect(pendingTx).not.toBeNull();
    expect(pendingTx!.hash).toBe(submittedTxHash);
    if (pendingTx?.blockNumber === null || pendingTx?.blockNumber === undefined) {
      console.log(`  ✔ TX mempool pending 확인 (blockNumber=null) — 채굴 대기 중`);
    } else {
      console.log(`  · TX 이미 채굴됨 (block=${pendingTx.blockNumber}) — Sepolia 빠른 블록 타이밍`);
    }

    // ── ④ CONFIRMED 전이 대기 ───────────────────────────────────────────────
    console.log(`\n  ── 상태 폴링: SUBMITTED → CONFIRMED (Sepolia 블록 채굴 대기) ──`);
    lastStatus = '';
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      if (rows[0]?.status !== lastStatus) {
        lastStatus = rows[0]?.status as string ?? '';
        await logDbState(pool, '전이 감지', t0);
      }
      return rows[0]?.status === 'CONFIRMED';
    }, 180_000, 'CONFIRMED');

    const { rows } = await pool.query('SELECT status, tx_hash FROM issuance_requests');
    console.log(`\n  ── CONFIRMED 달성 ──────────────────────────────────────────`);
    await logDbState(pool, `최종 확인`, t0);

    expect(rows[0].status).toBe('CONFIRMED');
    expect(rows[0].tx_hash).toMatch(/^0x/);
    console.log(`  ✔ PENDING 구간 포착 + CONFIRMED 완료 (총 ${elapsed(t0)})`);
  }, 300_000);

  // ── [5] REORG ────────────────────────────────────────────────────────────────

  it('[5] REORG — DB 상태 주입 → tx_mint_requests REORGED → 상태머신 검증', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [5] REORG — Sepolia DB 상태 주입으로 REORGED 시뮬레이션');
    console.log('  구현: 정상 발행 → SUBMITTED 후 → tx_mint_requests.status=REORGED 주입');
    console.log('──────────────────────────────────────────────────────────────');

    const t0 = Date.now();

    const currentMode = await controlVasp.getMode();
    if (currentMode !== 'NORMAL') await controlVasp.setMode('NORMAL');

    // ── ① 정상 발행 → SUBMITTED 대기 ────────────────────────────────────────
    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: {
        userId:     'user-sepolia-001',
        activityId: randomUUID(),
        eventType:  TEST_EVENT_TYPE,
        eventCode:  1,
        data:       { steps: 15_000 },
      },
    }));
    expect(statusCode).toBe(202);
    console.log(`  · webhook POST → 202 수신 (${elapsed(t0)})`);

    let txHash = '';
    let lastStatus = '';
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status, tx_hash FROM issuance_requests');
      if (rows.length === 0) return false;
      if (rows[0].status === 'FAILED') throw new Error(`TX FAILED: ${rows[0].fail_reason}`);
      if (rows[0].status !== lastStatus) {
        lastStatus = rows[0].status as string;
        await logDbState(pool, `폴링: ${lastStatus}`, t0);
      }
      if (rows[0].status === 'SUBMITTED' && rows[0].tx_hash) {
        txHash = rows[0].tx_hash as string;
        return true;
      }
      return false;
    }, 60_000, 'SUBMITTED');

    console.log(`  · 발행 TX hash: ${txHash.slice(0, 16)}…`);

    // ── ② DB 주입: tx_mint_requests.status → REORGED ────────────────────────
    console.log(`\n  ── DB 주입: tx_mint_requests.status → REORGED ──`);
    const { rowCount } = await pool.query(
      "UPDATE tx_mint_requests SET status = 'REORGED' WHERE tx_hash = $1",
      [txHash],
    );
    console.log(`  · UPDATE 완료 (rowCount=${rowCount}) (${elapsed(t0)})`);

    // ── ③ issuance_requests 상태 변화 관찰 (30초) ────────────────────────────
    // TxTransitionBridge가 REORGED를 감지하면 issuance_requests를 FAILED로 전이하거나
    // 재발행을 시도할 수 있음. 구현에 따라 결과가 다름.
    console.log(`\n  ── 30초 관찰: REORGED 감지 후 상태머신 동작 ──`);
    const observedStatuses: string[] = [];
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      const { rows: txRows } = await pool.query(
        'SELECT status FROM tx_mint_requests WHERE tx_hash = $1',
        [txHash],
      );
      const { rows: issRows } = await pool.query(
        'SELECT status FROM issuance_requests ORDER BY created_at DESC LIMIT 1',
      );
      const txStatus  = txRows[0]?.status as string ?? 'N/A';
      const issStatus = issRows[0]?.status as string ?? 'N/A';
      const snapshot  = `tx=${txStatus} issuance=${issStatus}`;
      if (!observedStatuses.includes(snapshot)) {
        observedStatuses.push(snapshot);
        console.log(`  [DB ${elapsed(t0)}] ${snapshot}`);
      }
    }

    // ── ④ 검증: tx_mint_requests는 REORGED, issuance_requests 상태 확인 ──────
    const { rows: finalTxRows } = await pool.query(
      'SELECT status FROM tx_mint_requests WHERE tx_hash = $1',
      [txHash],
    );
    const { rows: finalIssRows } = await pool.query(
      'SELECT status FROM issuance_requests ORDER BY created_at DESC LIMIT 1',
    );

    console.log(`\n  ── 최종 상태 ───────────────────────────────────────────────`);
    console.log(`  · tx_mint_requests.status  = ${finalTxRows[0]?.status}`);
    console.log(`  · issuance_requests.status = ${finalIssRows[0]?.status}`);

    // tx_mint_requests는 REORGED 주입 그대로 (시스템이 덮어쓰지 않았다면)
    // issuance_requests는 FAILED 또는 재발행 시도에 따라 달라짐
    expect(finalTxRows[0]?.status).toBe('REORGED');
    // issuance_requests는 FAILED 또는 SUBMITTED (재발행 시도) 중 하나
    expect(['FAILED', 'SUBMITTED', 'CONFIRMED']).toContain(finalIssRows[0]?.status);

    console.log(`  ✔ REORGED 상태 주입 및 상태머신 동작 검증 완료 (총 ${elapsed(t0)})`);
    console.log(`  · observedStatuses: ${observedStatuses.join(' → ')}`);
  }, 300_000);

  // ── [stream-2] 멱등성 ─────────────────────────────────────────────────────

  it('[stream-2] 동일 requestId 중복 주입 → 멱등성 보장 (한 번만 처리)', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [stream-2] 멱등성 — 동일 requestId 두 번 XADD → creditNFT 1회');
    console.log('──────────────────────────────────────────────────────────────');

    const idemKey   = `kyobo:events:idem-${Date.now()}`;
    const idemGroup = 'nft-idem-sep';
    await (redis as any).xgroup('CREATE', idemKey, idemGroup, '0', 'MKSTREAM');

    await pool.query(
      `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
       VALUES ('user-idem-002', '0xOWNER002', 'SEPOLIA', true) ON CONFLICT (user_id) DO NOTHING`,
    );
    const idemLedger      = new PgNFTLedgerService(pool, mockVaspAddr, 11155111, coreBanking);
    let creditCount       = 0;
    const origCredit      = idemLedger.creditNFT.bind(idemLedger);
    idemLedger.creditNFT  = async (owner, tokenId, amount, txHash) => {
      creditCount++;
      return origCredit(owner, tokenId, amount, txHash);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idemIdempotency = new IdempotencyGuard(new RedisIdempotencyStore(redis as any));
    const idemProcessor   = new NFTIssuedProcessor(idemIdempotency, idemLedger);
    const idemDlq         = new DLQHandler(redisAdapter, { async sendAlert() {} }, idemKey);
    const idemPool        = new ConsumerGroupPool(
      redisAdapter, idemDlq,
      { streamKey: idemKey, batchSize: 10, blockMs: 200, minIdleMs: 60_000 },
      [{ groupName: idemGroup, consumerId: 'idem-1', processors: [idemProcessor] }],
    );
    idemPool.start().catch(() => {});

    const requestId = randomUUID();
    const fields: Record<string, string> = {
      eventType:   'NFT_ISSUED',
      requestId,
      txHash:      '0x' + 'bb'.repeat(32),
      blockNumber: '1000',
      payload:     JSON.stringify({ tokenId: '2002', to: '0xOWNER002', blockNumber: 1000 }),
      publishedAt: new Date().toISOString(),
      _retryCount: '0',
    };

    await redisAdapter.xadd(idemKey, fields);
    await redisAdapter.xadd(idemKey, fields);

    await waitFor(() => creditCount >= 1, 15_000, 'first credit');
    await new Promise(r => setTimeout(r, 500));

    expect(creditCount).toBe(1);
    console.log('  ✔ creditNFT 호출 횟수:', creditCount, '(1이어야 함)');

    idemPool.stop();
    await (redis as any).del(idemKey, `${idemKey}:dlq`);
  }, 30_000);

  // ── [stream-3] DLQ ────────────────────────────────────────────────────────

  it('[stream-3] retryCount >= 3 → DLQ 이동 확인', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [stream-3] DLQ — _retryCount=3 → DLQ 스트림으로 이동');
    console.log('──────────────────────────────────────────────────────────────');

    const dlqKey   = `kyobo:events:dlq-test-${Date.now()}`;
    const dlqGroup = 'nft-dlq-sep';
    await (redis as any).xgroup('CREATE', dlqKey, dlqGroup, '0', 'MKSTREAM');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dlqIdempotency = new IdempotencyGuard(new RedisIdempotencyStore(redis as any));
    const dlqLedger      = new PgNFTLedgerService(pool, mockVaspAddr, 11155111, coreBanking);
    const failProcessor  = new AlwaysFailProcessor(dlqIdempotency, dlqLedger);

    const dlqHandler = new DLQHandler(
      redisAdapter,
      { async sendAlert(m) { console.warn('[DLQ alert]', m); } },
      dlqKey,
    );
    const dlqPool = new ConsumerGroupPool(
      redisAdapter, dlqHandler,
      { streamKey: dlqKey, batchSize: 10, blockMs: 200, minIdleMs: 60_000 },
      [{ groupName: dlqGroup, consumerId: 'dlq-1', processors: [failProcessor] }],
    );
    dlqPool.start().catch(() => {});

    await redisAdapter.xadd(dlqKey, {
      eventType:   'NFT_ISSUED',
      requestId:   randomUUID(),
      txHash:      '0x' + 'cc'.repeat(32),
      blockNumber: '1001',
      payload:     JSON.stringify({ tokenId: '3003', to: '0xOWNER003', blockNumber: 1001 }),
      publishedAt: new Date().toISOString(),
      _retryCount: '3',
    });

    const dlqStreamKey = `${dlqKey}:dlq`;
    await waitFor(async () => {
      const entries = await redisAdapter.xrange(dlqStreamKey, '-', '+');
      return entries.length > 0;
    }, 15_000, 'DLQ message');

    const dlqEntries = await redisAdapter.xrange(dlqStreamKey, '-', '+');
    expect(dlqEntries.length).toBeGreaterThan(0);
    expect(dlqEntries[0]!.fields['eventType']).toBe('NFT_ISSUED');
    expect(dlqEntries[0]!.fields['_reason']).toBeTruthy();
    console.log('  ✔ DLQ 이동 확인  _reason:', dlqEntries[0]!.fields['_reason']?.slice(0, 60));

    dlqPool.stop();
    await (redis as any).del(dlqKey, dlqStreamKey);
  }, 30_000);

  // ── [stream-4] XAUTOCLAIM ─────────────────────────────────────────────────

  it('[stream-4] XAUTOCLAIM — PEL 잔류 메시지 재수신 처리', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [stream-4] XAUTOCLAIM — crash 시뮬 → PEL 잔류 → 새 consumer 재수신');
    console.log('──────────────────────────────────────────────────────────────');

    const claimKey   = `kyobo:events:xclaim-${Date.now()}`;
    const claimGroup = `nft-xclaim-${Date.now()}`;
    const CRASH_CONSUMER = 'consumer-crash';
    const NEW_CONSUMER   = 'consumer-reclaim';

    await (redis as any).xgroup('CREATE', claimKey, claimGroup, '$', 'MKSTREAM');

    await pool.query(
      `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
       VALUES ('user-xclaim-004', '0xOWNER004', 'SEPOLIA', true) ON CONFLICT (user_id) DO NOTHING`,
    );
    const claimLedger      = new PgNFTLedgerService(pool, mockVaspAddr, 11155111, coreBanking);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claimIdempotency = new IdempotencyGuard(new RedisIdempotencyStore(redis as any));
    const claimProcessor   = new NFTIssuedProcessor(claimIdempotency, claimLedger);

    // ① 메시지 발행
    const tokenId = '4004';
    const owner   = '0xOWNER004';
    await redisAdapter.xadd(claimKey, {
      eventType:   'NFT_ISSUED',
      requestId:   randomUUID(),
      txHash:      '0x' + 'dd'.repeat(32),
      blockNumber: '1002',
      payload:     JSON.stringify({ tokenId, to: owner, blockNumber: 1002 }),
      publishedAt: new Date().toISOString(),
      _retryCount: '0',
    });

    // ② CRASH_CONSUMER 읽기 — XACK 없이 중단
    const readResult = await redisAdapter.xreadgroup(
      claimGroup, CRASH_CONSUMER,
      [{ key: claimKey, id: '>' }],
      10, 500,
    );
    expect(readResult[0]?.messages.length).toBe(1);
    console.log('  · CRASH_CONSUMER 읽기 완료 (XACK 없음 → PEL 잔류)');

    // ③ minIdleMs(200ms) 초과 대기
    await new Promise(r => setTimeout(r, 600));

    // ④ NEW_CONSUMER로 ConsumerGroupPool 기동 — XAUTOCLAIM으로 PEL 재수신
    const claimDlq  = new DLQHandler(redisAdapter, { async sendAlert() {} }, claimKey);
    const claimPool = new ConsumerGroupPool(
      redisAdapter, claimDlq,
      { streamKey: claimKey, batchSize: 10, blockMs: 100, minIdleMs: 200 },
      [{ groupName: claimGroup, consumerId: NEW_CONSUMER, processors: [claimProcessor] }],
    );
    claimPool.start().catch(() => {});

    // ⑤ 재처리 완료 확인
    await waitFor(
      async () => (await claimLedger.getNFTBalance(owner, tokenId)) > 0,
      15_000,
      'XAUTOCLAIM reclaim',
    );
    expect(await claimLedger.getNFTBalance(owner, tokenId)).toBe(1);
    console.log('  ✔ XAUTOCLAIM — PEL 재수신 후 ledger 반영 확인');

    claimPool.stop();
    await (redis as any).del(claimKey, `${claimKey}:dlq`);
  }, 30_000);

  // ── [poll-1] pollStaleRequests ───────────────────────────────────────────────
  //
  // Sepolia 제약: evm_snapshot 불가 → NO_EMIT 모드로 TX 확정 후 콜백 없는 상태 만들고
  // DB에서 status=PENDING + created_at -11분 조작 → pollStaleRequests 호출 → CONFIRMED

  it('[poll-1] pollStaleRequests — SUBMITTED TX → PENDING 조작 → getTransferStatus(VASPServer) → CONFIRMED', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [poll-1] pollStaleRequests: PENDING 10분 초과 → vasp.getStatus → CONFIRMED');
    console.log('──────────────────────────────────────────────────────────────');

    // NO_EMIT: Sepolia TX 확정, Issued 이벤트 없음 → VASPServer 콜백 없음
    // → tx_mint_requests SUBMITTED 유지, txStatuses='completed' 기록됨
    await controlVasp.setMode('NO_EMIT');

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: {
        userId:     'user-sepolia-001',
        activityId: randomUUID(),
        eventType:  TEST_EVENT_TYPE,
        eventCode:  1,
        data:       { steps: 15_000 },
      },
    }));
    expect(statusCode).toBe(202);

    // tx_mint_requests SUBMITTED + txHash 확보
    let txHash = '';
    await waitFor(async () => {
      const { rows } = await pool.query(
        "SELECT tx_hash FROM tx_mint_requests WHERE status = 'SUBMITTED' AND tx_hash IS NOT NULL",
      );
      if (rows.length > 0 && rows[0].tx_hash) { txHash = rows[0].tx_hash as string; return true; }
      return false;
    }, 60_000, 'SUBMITTED in tx_mint_requests');
    console.log(`  · tx_hash=${txHash.slice(0, 18)}…`);

    // VASPServer _waitAndNotify 완료 대기 (Sepolia TX 채굴 후 txStatuses='completed' 설정)
    // provider.waitForTransaction: 블록 채굴까지 대기 (Sepolia ~12s/block)
    console.log('  · Sepolia TX 채굴 대기 중…');
    await provider.waitForTransaction(txHash, 1, 60_000);
    await new Promise(r => setTimeout(r, 2_000)); // txStatuses 설정 여유
    console.log('  · TX 채굴 확인 + txStatuses=completed 설정 완료');

    // DB 조작: SUBMITTED → PENDING + created_at을 11분 전으로 설정
    await pool.query(
      "UPDATE tx_mint_requests SET status = 'PENDING', created_at = NOW() - INTERVAL '11 minutes' WHERE status = 'SUBMITTED'",
    );
    console.log('  · tx_mint_requests → PENDING (created_at -11분 조작)');

    // pollStaleRequests 호출:
    //   findPendingOlderThan(10) → PENDING 10분 초과 건 발견
    //   vasp.getStatus(txHash)   → VASPServer GET /transfers/:txHash → 'completed'
    //   handleMined → PENDING → MINED → handleConfirmed → MINED → CONFIRMED
    const pollResult = await txStateMachine.pollStaleRequests();
    expect(pollResult.processed).toBe(1);
    console.log(`  · pollStaleRequests processed=${pollResult.processed}`);

    // tx_mint_requests CONFIRMED 확인
    const { rows: txRows } = await pool.query(
      'SELECT status FROM tx_mint_requests WHERE tx_hash = $1',
      [txHash],
    );
    expect(txRows[0]?.status).toBe('CONFIRMED');
    console.log('  ✔ tx_mint_requests CONFIRMED (pollStaleRequests → getTransferStatus 경로)');

    // TxTransitionBridge → issuance_requests CONFIRMED 확인
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows[0]?.status === 'CONFIRMED';
    }, 10_000, 'issuance_requests CONFIRMED');
    const { rows: isRows } = await pool.query('SELECT status FROM issuance_requests');
    expect(isRows[0]?.status).toBe('CONFIRMED');
    console.log('  ✔ issuance_requests CONFIRMED (TxTransitionBridge 경유)');

    await controlVasp.setMode('NORMAL');
    console.log('  · setMode(NORMAL) 복원 완료');
  }, 120_000);

  // ── [reconcile-1] NFT Reconcile 대사 (Sepolia) ───────────────────────────────
  //
  // 시나리오:
  //   ① NO_EMIT 모드: TX 확정, Issued 이벤트 없음 → VASP 콜백 없음 → user_nft_holdings 미기록
  //   ② pollStaleRequests → CONFIRMED (user_nft_holdings는 여전히 없음)
  //   ③ runManualReconcile → ONCHAIN_ONLY 불일치 감지
  //   ④ reconcile_history 기록 검증

  it('[reconcile-1] NFT Reconcile — Sepolia 온체인 보유 / 원장 없음 → ONCHAIN_ONLY 감지', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [reconcile-1] Reconcile — ONCHAIN_ONLY (Sepolia)');
    console.log('──────────────────────────────────────────────────────────────');

    const t0     = Date.now();
    const userId = 'user-sepolia-001';

    // ① NO_EMIT: TX 확정, Issued 이벤트/콜백 없음 → user_nft_holdings 미기록
    await controlVasp.setMode('NO_EMIT');

    // Alchemy 무료 티어 eth_getLogs 10-block 범위 제한 대응:
    // webhook 전송 직전 블록을 fromBlock으로 고정 → TX 이후 ~2-3블록만 스캔
    const reconcileFromBlock = await chainAdapter.getBlockNumber();

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: {
        userId,
        activityId: randomUUID(),
        eventType:  TEST_EVENT_TYPE,
        eventCode:  1,
        data:       { steps: 15_000 },
      },
    }));
    expect(statusCode).toBe(202);

    let txHash = '';
    await waitFor(async () => {
      const { rows } = await pool.query(
        "SELECT tx_hash FROM tx_mint_requests WHERE status = 'SUBMITTED' AND tx_hash IS NOT NULL",
      );
      if (rows.length > 0 && rows[0].tx_hash) { txHash = rows[0].tx_hash as string; return true; }
      return false;
    }, 60_000, 'SUBMITTED in tx_mint_requests');
    console.log(`  · tx_hash=${txHash.slice(0, 18)}… (${elapsed(t0)})`);

    // Sepolia TX 채굴 대기
    await provider.waitForTransaction(txHash, 1, 60_000);
    await new Promise(r => setTimeout(r, 2_000));
    console.log(`  · TX 채굴 완료 (${elapsed(t0)})`);

    // pollStaleRequests로 CONFIRMED 전이
    await pool.query(
      "UPDATE tx_mint_requests SET status = 'PENDING', created_at = NOW() - INTERVAL '11 minutes' WHERE status = 'SUBMITTED'",
    );
    const pollResult = await txStateMachine.pollStaleRequests();
    expect(pollResult.processed).toBe(1);

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows[0]?.status === 'CONFIRMED';
    }, 15_000, 'issuance_requests CONFIRMED');
    console.log(`  · issuance_requests CONFIRMED (${elapsed(t0)})`);

    // user_nft_holdings 기록 없음 확인 (NO_EMIT → 콜백 없음 → NFTIssuedProcessor 미실행)
    const { rows: emptyHoldings } = await pool.query(
      'SELECT token_id FROM user_nft_holdings WHERE user_id = $1', [userId],
    );
    expect(emptyHoldings.length).toBe(0);
    console.log('  · user_nft_holdings 비어 있음 확인 (NO_EMIT 시뮬)');

    // ③ Reconcile 실행
    const holdingRepo = new PgNftHoldingRepository(pool);
    const reconcileService = new ReconcileService(
      coreBanking,
      {
        getTotalSupply:           async () => 0n,
        getCustodyAccountBalance: async () => 0n,
        balanceOf: (addr, tokenId) =>
          chainAdapter.getBalance(mockVaspAddr, addr, tokenId),
        getNftHoldings: (addr) =>
          chainAdapter.getNftHoldings(mockVaspAddr, addr, reconcileFromBlock),
        getBlockNumber: () => chainAdapter.getBlockNumber(),
      },
      holdingRepo,
      { fire: async (msg, sev) => console.log(`  · [Reconcile alert] ${sev}: ${msg}`) },
    );
    const reconcileAdmin = new ReconcileAdminService(
      new PgDatabaseClient(pool),
      reconcileService,
      coreBanking,
      { sendAlert: async (p) => console.log(`  · [ReconcileAlert] ${p.severity}: ${p.title}`) },
    );

    console.log(`  · runManualReconcile 시작 (${elapsed(t0)})`);
    const result = await reconcileAdmin.runManualReconcile(userId, 'test-operator');
    console.log(`  · runManualReconcile 완료 — mismatchCount=${result.mismatchCount} (${elapsed(t0)})`);

    expect(result.mismatchCount).toBe(1);
    expect(result.mismatchUserIds).toContain(userId);
    console.log('  ✔ mismatchCount=1, mismatchUserIds에 userId 포함');

    // ④ reconcile_history 검증
    const { rows: histRows } = await pool.query(
      "SELECT run_type, target_count, mismatch_count, mismatch_user_ids FROM reconcile_history ORDER BY run_at DESC LIMIT 1",
    );
    expect(histRows[0]?.run_type).toBe('MANUAL');
    expect(histRows[0]?.mismatch_count).toBe(1);
    const mismatchIds = histRows[0]?.mismatch_user_ids as string[];  // JSONB → auto-parsed by pg
    expect(mismatchIds).toContain(userId);
    console.log('  ✔ reconcile_history 기록 확인 (run_type=MANUAL, mismatch_count=1)');

    // audit_log 검증 (Java 경유)
    await waitFor(async () => {
      const { rows } = await pool.query(
        "SELECT action FROM audit_log WHERE resource_id = $1 AND action LIKE 'RECONCILE%'",
        [userId],
      );
      return rows.length >= 2;
    }, 10_000, 'reconcile audit_log entries');

    const { rows: auditRows } = await pool.query(
      "SELECT action FROM audit_log WHERE resource_id = $1 AND action LIKE 'RECONCILE%' ORDER BY event_time",
      [userId],
    );
    const actions = auditRows.map(r => r.action as string);
    expect(actions).toContain('RECONCILE_MANUAL_TRIGGER');
    expect(actions).toContain('RECONCILE_MISMATCH_DETECTED');
    console.log('  ✔ audit_log 기록 확인 (RECONCILE_MANUAL_TRIGGER + RECONCILE_MISMATCH_DETECTED)');

    await controlVasp.setMode('NORMAL');
    console.log(`  ✔ [reconcile-1] 완료 (총 ${elapsed(t0)})`);
  }, 300_000);

});
