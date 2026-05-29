/**
 * issuer-service MockVASP 통합 테스트
 *
 * 발행 경로 (Phase 1 — 동기 구간):
 *   HTTP POST → WebhookServer → WebhookPublishHandler → Redis Stream XADD
 *   → ConsumerGroupWorker XREADGROUP → ActivityProcessor → IssuerService
 *   → ExternalVASPAdapter → VASPServer (POST /transactions)
 *   → 서명·브로드캐스트 → Hardhat 블록체인 → TX 확정
 *   → issuance_requests SUBMITTED
 *
 * 발행 경로 (Phase 2A — VASP 콜백):
 *   VASPServer (TX 확정) → NFT_ISSUED 콜백 → WebhookServer
 *   → WebhookPublishHandler → Redis Stream XADD
 *   → NFTIssuedProcessor → PgNFTLedgerService.creditNFT → user_nft_holdings
 *
 * 발행 경로 (Phase 2B — 체인 이벤트 폴링):
 *   ChainEventListener (Issued 이벤트 폴링) → IssuanceConfirmHandler
 *   → TxStateMachineService → emit('transition', CONFIRMED)
 *   → TxTransitionBridge → issuance_requests CONFIRMED + audit_log
 *   → ProcessedEventHandler → processed_events (중복 처리 방지 마킹)
 *
 * 세 레이어 상태머신:
 *   tx_mint_requests  (TxStatus)      : REQUESTED → SUBMITTED → PENDING → MINED → CONFIRMED → FINALIZED
 *   mint_requests     (MintStatus)    : TxStatus와 동기화
 *   issuance_requests (IssuanceStatus): SUBMITTED → CONFIRMED → COMPLETED
 *   ※ TxTransitionBridge가 'transition' 이벤트를 받아 세 테이블을 cascade 업데이트
 *
 * 11가지 시나리오:
 *   [1] NORMAL      : 정상 발행 → NFT_ISSUED 콜백 → Redis Stream → ledger + CONFIRMED
 *                     + processed_events 기록 + audit_log(ISSUANCE_CONFIRMED) 검증
 *   [2] REVERT      : TX revert → VASPServer 500 → ExternalVASPAdapter throws → FAILED
 *   [3] NO_EMIT     : mint 성공, Issued 이벤트 없음 → 콜백 없음 → SUBMITTED 유지
 *   [4] PENDING     : evm_setAutomine(false) → TX mempool 체류 → mineBlock → 콜백 → CONFIRMED
 *   [5] REORG       : evm_snapshot → 발행 → evm_revert → 온체인 원복, DB CONFIRMED 유지
 *   [stream-2]      : 동일 requestId 두 번 XADD → IdempotencyGuard → creditNFT 1회
 *   [stream-3]      : _retryCount >= 3 → DLQ 이동 (AlwaysFailProcessor 사용)
 *   [stream-4]      : CRASH_CONSUMER XREADGROUP without XACK → PEL 잔류
 *                     → minIdleMs(200ms) 초과 → NEW_CONSUMER XAUTOCLAIM 재수신
 *   [poll-1]        : NO_EMIT → SUBMITTED → DB PENDING 조작(-11분)
 *                     → pollStaleRequests → GET /transfers/:txHash → VASPServer 'completed'
 *                     → handleMined → handleConfirmed → CONFIRMED
 *   [reconcile-1]   : 정상 발행 후 user_nft_holdings DELETE
 *                     → runManualReconcile → ONCHAIN_ONLY 불일치
 *                     → reconcile_history(MANUAL, mismatch_count=1)
 *                     + audit_log(RECONCILE_MANUAL_TRIGGER, RECONCILE_MISMATCH_DETECTED)
 *   [burst]         : 5명 동시 발행 → VASPServer NonceManager 직렬화
 *                     → nonce 충돌 없이 전체 CONFIRMED
 *
 * 인프라:
 *   - Hardhat 로컬 노드 (Docker) — MockVASP 컨트랙트 배포
 *   - VASPServer (HTTP, 포트 19876) — 서명·브로드캐스트·콜백·NonceManager
 *   - Java internal-ledger 컨테이너 — recordNftHolding / recordAuditLog (운영과 동일 경로)
 *   - PostgreSQL — @testcontainers/postgresql
 *   - Redis — testcontainers GenericContainer
 *
 * 주의:
 *   - beforeEach에서 vaspServer.resetNonce() 필수
 *     evm_revert 후 체인 nonce는 롤백되지만 NonceManager 내부 카운터는 유지되므로
 *     강제 재동기화하지 않으면 "nonce too high" 에러 발생
 *   - PgHybridCoreBankingAdapter: 테스트 전용 클래스
 *     getUserAccount()만 로컬 DB(user_wallet_mapping) 조회로 우회,
 *     recordNftHolding / recordAuditLog는 Java 컨테이너 경유 (운영과 동일)
 */

import { readFileSync }  from 'fs';
import { resolve }       from 'path';
import http              from 'http';
import crypto            from 'crypto';
import { randomUUID }    from 'crypto';
import { ethers }        from 'ethers';
import { Pool }          from 'pg';
import Redis             from 'ioredis';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Network, Wait }                from 'testcontainers';
import { StartedNetwork }                                  from 'testcontainers';

import { TokenIssuerFactory }                    from '../../apps/issuer-service/src/factory/TokenIssuerFactory';
import { ActivityConditionStrategy, EventConditionService } from '../../apps/issuer-service/src/services/EventConditionService';
import { IssuanceConfirmHandler }                from '../../apps/issuer-service/src/handlers/IssuanceConfirmHandler';
import { IEventHandler }                    from '@kyobo/event-engine/interfaces';
import { IoRedisAdapter }                        from '../../apps/issuer-service/src/infra/RedisAdapter';
import {
  WebhookServer,
  IdempotencyGuard,
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
  WebhookPublishHandler,
}                                                from '@kyobo/event-engine/webhook';
import { WebhookPayload }                   from '@kyobo/event-engine/webhook';
import { KyoboCoreBankingAdapter, InternalGatewayClient } from '@kyobo/core-banking';
import { LedgerService }                         from '../../packages/core-banking/src/ledger/LedgerService';
import { PgDatabaseClient }                      from '../../apps/issuer-service/src/infra/PgDatabaseClient';
import { EVMAdapter }                            from '@kyobo/chain-adapters';
import { ChainEvent }                       from '@kyobo/chain-adapters';
import { ChainEventListener }                    from '@kyobo/event-engine/listener';
import {
  ConsumerGroupPool,
  DLQHandler,
  NFTIssuedProcessor,
  ActivityProcessor,
  InMemoryLedgerService,
  RedisStreamPublisher,
}                                                from '@kyobo/event-engine';
import { PgNFTLedgerService }                    from '../../apps/issuer-service/src/infra/PgNFTLedgerService';
import { StreamMessage }  from '@kyobo/event-engine';
import { ExternalVASPAdapter }                   from '@kyobo/vasp';
import { AnvilVASPAdapter }                      from '../vasp-testing/AnvilVASPAdapter';
import { VASPServer }                            from '../vasp-testing/VASPServer';
import { TxStateMachineService }                 from '../../packages/vasp/src/tx/TxStateMachineService';
import MOCK_VASP_ABI                             from '../vasp-testing/MockVASP.abi.json';
import { ReconcileService, ReconcileAdminService } from '@kyobo/core-banking';
import { PgNftHoldingRepository }                from '../../apps/issuer-service/src/infra/PgNftHoldingRepository';

// ── 상수 ──────────────────────────────────────────────────────────────────────

const VASP_PORT     = 19876;  // VASPServer HTTP 포트
const WEBHOOK_PORT  = 19878;  // 내부 WebhookServer 포트
const WEBHOOK_SECRET = 'mock-vasp-test-secret-kyobo-32ch';
const TEST_EVENT_TYPE = 'WALK_GOAL_MET';
const TOKEN_ID        = '1001';
const TOKEN_ID_BN     = BigInt(TOKEN_ID);

// Hardhat 기본 계정
const DEPLOYER_KEY  = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OPERATOR_KEY  = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DEPLOYER_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OPERATOR_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const BLOCKCHAIN_DIR = resolve(__dirname, '..', '..', '..', 'blockchain');
const ARTIFACT_PATH  = resolve(
  BLOCKCHAIN_DIR, 'artifacts', 'src', 'mocks', 'MockVASP.sol', 'MockVASP.json',
);

// ── PgHybridCoreBankingAdapter ─────────────────────────────────────────────────

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
  return { eventType: 'ACTIVITY_ACHIEVED', requestId: randomUUID(), timestamp: Date.now(), ...overrides };
}

function postWebhook(payload: WebhookPayload, opts: { secret?: string } = {}): Promise<number> {
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

async function logAllStatuses(pool: import('pg').Pool, label: string): Promise<void> {
  const [iss, mint, tx] = await Promise.all([
    pool.query('SELECT status, tx_hash FROM issuance_requests ORDER BY created_at DESC LIMIT 1'),
    pool.query('SELECT status, tx_hash FROM mint_requests     ORDER BY created_at DESC LIMIT 1'),
    pool.query('SELECT status, tx_hash FROM tx_mint_requests  ORDER BY created_at DESC LIMIT 1'),
  ]);
  const fmt = (rows: any[], table: string) =>
    rows.length === 0 ? `${table}: (없음)` :
    `${table}: ${rows[0].status.padEnd(10)} tx=${(rows[0].tx_hash ?? 'null').slice(0, 12)}…`;
  console.log(`  [STATUS ${label}]`);
  console.log(`    · ${fmt(iss.rows,  '[issuance_requests]')}`);
  console.log(`    · ${fmt(mint.rows, '[mint_requests]    ')}`);
  console.log(`    · ${fmt(tx.rows,   '[tx_mint_requests] ')}`);
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`);
    await new Promise(r => setTimeout(r, 200));
  }
}


async function deployMockVASP(rpcUrl: string): Promise<string> {
  const artifact    = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8'));
  const provider    = new ethers.JsonRpcProvider(rpcUrl);
  const deployerBase = new ethers.Wallet(DEPLOYER_KEY, provider);
  const deployer    = new ethers.NonceManager(deployerBase);
  const factory     = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const contract    = await factory.deploy(OPERATOR_ADDR);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log(`  [deploy] MockVASP → ${addr}`);

  // deployer에게 OPERATOR_ROLE 부여 — controlVasp(DEPLOYER_KEY) setMode 전용
  const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes('OPERATOR_ROLE'));
  const mockVasp = new ethers.Contract(addr, artifact.abi, deployer);
  await (await (mockVasp['grantRole'] as Function)(OPERATOR_ROLE, DEPLOYER_ADDR)).wait();
  console.log(`  [deploy] OPERATOR_ROLE granted to deployer`);
  return addr;
}

// ── 전역 상태 ─────────────────────────────────────────────────────────────────

let hardhatRpc:      string;
let hardhatContainer: { getHost(): string; getMappedPort(port: number): number; stop(): Promise<unknown> };
let dockerNetwork:   StartedNetwork;
let pgContainer:     StartedPostgreSqlContainer;
let javaContainer:   { getHost(): string; getMappedPort(port: number): number; stop(): Promise<unknown> };
let javaBaseUrl:     string;
let redisContainer:  { getHost(): string; getMappedPort(port: number): number; stop(): Promise<unknown> };
let pool:            Pool;
let mockVaspAddr:    string;
let provider:        ethers.JsonRpcProvider;

let vaspServer:      VASPServer;
let controlVasp:     AnvilVASPAdapter;   // DEPLOYER_KEY — setMode/freezeMining 전용

let coreBanking:     PgHybridCoreBankingAdapter;
let ledgerService:   LedgerService;
let webhookServer:   WebhookServer;
let chainListener:   ChainEventListener;
let chainAdapter:    EVMAdapter;
let confirmHandler:  IssuanceConfirmHandler;

let redis:           Redis;
let ledger:          PgNFTLedgerService;   // Redis Stream → NFTIssuedProcessor 검증용
let consumerPool:    ConsumerGroupPool;

let redisAdapter:    IoRedisAdapter;
let txStateMachine:  TxStateMachineService;

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
    contractAddr:                  string,
    private readonly ledger:       LedgerService,
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

describe('issuer-service 통합 테스트 — VASPServer + Redis Stream + 11가지 시나리오', () => {

  // ── beforeAll ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  [SETUP] 통합 테스트 환경 구축');
    console.log('══════════════════════════════════════════════════════════════');

    // ① Hardhat 노드 컨테이너
    console.log('\n  [1/7] Hardhat 노드 컨테이너 기동...');
    hardhatContainer = await new GenericContainer('kyobo/hardhat-node:test')
      .withExposedPorts(8545)
      .withWaitStrategy(Wait.forLogMessage('Started HTTP and WebSocket JSON-RPC server'))
      .start();
    hardhatRpc = `http://${hardhatContainer.getHost()}:${hardhatContainer.getMappedPort(8545)}`;
    await new ethers.JsonRpcProvider(hardhatRpc).send('hardhat_reset', []);
    console.log(`  [1/7] Hardhat 준비 완료 → ${hardhatRpc}`);

    // ② MockVASP 배포
    console.log('\n  [2/7] MockVASP 컨트랙트 배포...');
    mockVaspAddr = await deployMockVASP(hardhatRpc);
    provider     = new ethers.JsonRpcProvider(hardhatRpc);

    // ③ PostgreSQL + Java internal-ledger 컨테이너
    console.log('\n  [3/7] PostgreSQL + Java 컨테이너 시작...');
    dockerNetwork = await new Network().start();
    pgContainer   = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('kyobo_test')
      .withUsername('kyobo')
      .withPassword('kyobo')
      .withNetwork(dockerNetwork)
      .withNetworkAliases('postgres')
      .withStartupTimeout(120_000)
      .start();
    pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
    const schema = readFileSync(resolve(__dirname, '..', 'setup', 'schema.sql'), 'utf-8');
    await pool.query(schema);

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
    console.log(`  [3/7] PostgreSQL + Java 준비 완료`);

    // ④ Redis 컨테이너
    console.log('\n  [4/7] Redis 컨테이너 시작...');
    redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    redis = new Redis(redisUrl);
    console.log(`  [4/7] Redis 준비 완료 → ${redisUrl}`);

    // ⑤ VASPServer 기동 (ExternalVASPAdapter 호출 대상)
    console.log('\n  [5/7] VASPServer 기동...');
    vaspServer = new VASPServer({
      port:            VASP_PORT,
      rpcUrl:          hardhatRpc,
      signerKey:       OPERATOR_KEY,
      contractAddr:    mockVaspAddr,
      callbackUrl:     `http://localhost:${WEBHOOK_PORT}`,
      callbackSecret:  WEBHOOK_SECRET,
      pollingInterval: 100,
    });
    await vaspServer.start();

    // controlVasp: DEPLOYER_KEY — setMode/freezeMining/snapshot 전용 (nonce 분리)
    controlVasp = new AnvilVASPAdapter({
      rpcUrl:        hardhatRpc,
      privateKey:    DEPLOYER_KEY,
      mockVaspAddr:  mockVaspAddr,
      confirmations: 1,
    });
    (controlVasp as any).provider.pollingInterval = 100;
    console.log(`  [5/7] VASPServer 준비 완료 → :${VASP_PORT}`);

    // ⑥ Core Banking + 정적 데이터 시드
    const gateway = new InternalGatewayClient({ baseUrl: javaBaseUrl, secret: 'test-secret' });
    coreBanking = new PgHybridCoreBankingAdapter(pool, gateway);
    for (let i = 1; i <= 5; i++) {
      await pool.query(
        `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
         VALUES ($1, $2, 'ANVIL', true) ON CONFLICT (user_id) DO NOTHING`,
        [`user-mock-${String(i).padStart(3, '0')}`, OPERATOR_ADDR],
      );
    }
    await pool.query(
      `INSERT INTO issuance_policies (event_type, token_id, amount)
       VALUES ($1, $2, 1) ON CONFLICT (event_type) DO NOTHING`,
      [TEST_EVENT_TYPE, TOKEN_ID],
    );
    ledgerService = new LedgerService(new PgDatabaseClient(pool), coreBanking);
    // ⑦ 서비스 조립
    console.log('\n  [6/7] 서비스 조립...');

    chainAdapter = new EVMAdapter({ rpcUrl: hardhatRpc, chainId: '31337' });
    (chainAdapter as any).provider.pollingInterval = 100;

    // ExternalVASPAdapter → VASPServer (실제 VASP HTTP 경로 검증)
    const externalVasp = new ExternalVASPAdapter({
      baseUrl: `http://localhost:${VASP_PORT}`,
      apiKey:  'test-api-key',
    });

    const conditionSvc  = new EventConditionService([new ActivityConditionStrategy()]);
    const factory       = new TokenIssuerFactory({
      chainAdapter,
      vaspAdapter: externalVasp,
      coreBanking,
      pool,
    });
    const factoryResult = factory.createNFTIssuer(mockVaspAddr, conditionSvc);
    const { issuerService } = factoryResult;
    confirmHandler = factoryResult.confirmHandler;
    txStateMachine = factoryResult.txStateMachine;

    // ChainEventListener — 폴백 경로 (issuance_requests CONFIRMED + processed_events 기록)
    const inMemoryBlockStore = { block: 0 };
    chainListener = new ChainEventListener(
      chainAdapter,
      [confirmHandler, new ProcessedEventHandler(mockVaspAddr, ledgerService)],
      [{ addr: mockVaspAddr, abi: MOCK_VASP_ABI as unknown[], eventNames: ['Issued'] }],
      {
        async getLastProcessedBlock() { return inMemoryBlockStore.block; },
        async setLastProcessedBlock(b) { inMemoryBlockStore.block = b; },
      },
    );
    await chainListener.start();

    // Redis Stream: NFT_ISSUED 콜백 → XADD → ConsumerGroupWorker → ledger
    redisAdapter = new IoRedisAdapter(redis);
    const streamPublisher = new RedisStreamPublisher(redisAdapter);
    await streamPublisher.initialize('nft-consumers');       // consumer group 생성
    await streamPublisher.initialize('activity-consumers');  // consumer group 생성

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idempotency     = new IdempotencyGuard(new RedisIdempotencyStore(redis as any));
    const webhookPublisher = new WebhookPublishHandler(streamPublisher, idempotency);

    // WebhookServer: 모든 인바운드 Webhook → WebhookPublishHandler → Redis Stream (단일 경로)
    webhookServer = new WebhookServer({ port: WEBHOOK_PORT, secret: WEBHOOK_SECRET, maxBodyKb: 64 });
    // 내부 인바운드 (교보 앱)
    webhookServer.on('ACTIVITY_ACHIEVED', webhookPublisher.createHandler());
    // VASP 콜백
    webhookServer.on('NFT_ISSUED', webhookPublisher.createHandler());
    await webhookServer.listen();

    // ConsumerGroupPool: 도메인별 Consumer Group 독립 소비
    ledger = new PgNFTLedgerService(pool, mockVaspAddr, 31337, coreBanking);
    const nftIssuedProcessor  = new NFTIssuedProcessor(idempotency, ledger);
    const activityProcessor   = new ActivityProcessor(issuerService, idempotency);
    const streamDlq     = new DLQHandler(
      redisAdapter,
      { async sendAlert(msg) { console.error('[DLQ]', msg); } },
    );
    consumerPool = new ConsumerGroupPool(
      redisAdapter,
      streamDlq,
      { streamKey: 'kyobo:events', batchSize: 10, blockMs: 500, minIdleMs: 1_000 },
      [
        { groupName: 'nft-consumers',      consumerId: 'nft-1',      processors: [nftIssuedProcessor] },
        { groupName: 'activity-consumers', consumerId: 'activity-1', processors: [activityProcessor] },
      ],
    );
    consumerPool.start().catch(e => console.error('[consumerPool] fatal:', e));

    console.log('  [7/7] 환경 구축 완료');
    console.log('\n══════════════════════════════════════════════════════════════\n');
  }, 300_000);

  // ── afterAll ──────────────────────────────────────────────────────────────

  afterAll(async () => {
    consumerPool?.stop();
    await webhookServer.close().catch(() => {});
    await chainListener.stop().catch(() => {});
    await vaspServer.stop().catch(() => {});
    await redis.quit().catch(() => {});
    await pool.end().catch(() => {});
    await javaContainer?.stop().catch(() => {});
    await pgContainer.stop().catch(() => {});
    await redisContainer?.stop().catch(() => {});
    await dockerNetwork?.stop().catch(() => {});
    await hardhatContainer?.stop().catch(() => {});
  });

  // ── beforeEach: 이전 테스트 드레인 → 테이블 초기화 ─────────────────────────

  beforeEach(async () => {
    // NO_EMIT 시나리오는 SUBMITTED가 영구 잔류하므로 짧게 포기
    await waitFor(async () => {
      const { rows } = await pool.query(
        "SELECT COUNT(*) AS cnt FROM issuance_requests WHERE status NOT IN ('CONFIRMED','FAILED')",
      );
      return parseInt(rows[0].cnt, 10) === 0;
    }, 3_000, 'drain previous test').catch(() => {});

    await pool.query('TRUNCATE issuance_requests, tx_mint_requests, mint_requests, processed_events, user_nft_holdings, audit_log, reconcile_history');

    // evm_revert 이후 NonceManager 내부 카운터가 체인과 어긋날 수 있으므로 재동기화
    vaspServer.resetNonce();
  }, 20_000);

  // ── [1] NORMAL ──────────────────────────────────────────────────────────────

  it('[1] NORMAL — 정상 발행 → VASPServer NFT_ISSUED 콜백 → Redis Stream → ledger + CONFIRMED', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [1] NORMAL — 전체 흐름: IssuerService → VASPServer → 콜백 → Redis Stream');
    console.log('──────────────────────────────────────────────────────────────');

    const iface = new ethers.Interface(MOCK_VASP_ABI as ethers.InterfaceAbi);
    const viewContract = new ethers.Contract(mockVaspAddr, iface, provider);
    const balBefore = await (viewContract['balanceOf'] as Function)(OPERATOR_ADDR, TOKEN_ID_BN) as bigint;
    console.log(`  · 발행 전 balanceOf  ${balBefore}`);

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId: 'user-mock-001', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
    }));
    expect(statusCode).toBe(202);
    console.log('  · webhook 202 수신');

    // SUBMITTED 대기 — VASPServer 202 응답 후 IssuerService가 DB에 기록
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0 && rows[0].status !== 'REQUESTED';
    }, 20_000, 'SUBMITTED');
    const { rows: midRows } = await pool.query('SELECT status, fail_reason, tx_hash FROM issuance_requests');
    if (midRows[0].status === 'FAILED') throw new Error(`TX failed early: ${midRows[0].fail_reason}`);
    await logAllStatuses(pool, 'SUBMITTED 시점');

    // CONFIRMED 대기 — ChainEventListener 폴백 경로
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows[0]?.status === 'CONFIRMED';
    }, 40_000, 'CONFIRMED');

    const { rows } = await pool.query('SELECT status, tx_hash, wallet_addr FROM issuance_requests');
    await logAllStatuses(pool, 'CONFIRMED 시점');
    expect(rows[0].status).toBe('CONFIRMED');
    expect(rows[0].tx_hash).toMatch(/^0x/);
    expect(rows[0].wallet_addr?.toLowerCase()).toBe(OPERATOR_ADDR.toLowerCase());
    console.log('  ✔ CONFIRMED 확인 (ChainEventListener 경로)');

    // Redis Stream 경로 검증: NFT_ISSUED 콜백 → XADD → NFTIssuedProcessor → ledger
    await waitFor(async () => {
      return (await ledger.getNFTBalance(OPERATOR_ADDR, TOKEN_ID)) > 0;
    }, 15_000, 'ledger.creditNFT');
    const balance = await ledger.getNFTBalance(OPERATOR_ADDR, TOKEN_ID);
    console.log(`  · InMemoryLedger balance  ${balance} (>0이어야 함)`);
    expect(balance).toBeGreaterThan(0);
    console.log('  ✔ Redis Stream 경로 확인 (VASPServer 콜백 → XADD → NFTIssuedProcessor)');

    // balanceOf 온체인 증가 확인
    const balAfter = await (viewContract['balanceOf'] as Function)(OPERATOR_ADDR, TOKEN_ID_BN) as bigint;
    expect(balAfter).toBe(balBefore + 1n);
    console.log(`  ✔ 온체인 balanceOf ${balBefore} → ${balAfter}`);

    // user_wallet_mapping 검증
    const { rows: wmRows } = await pool.query(
      'SELECT wallet_addr, verified FROM user_wallet_mapping WHERE user_id = $1',
      ['user-mock-001'],
    );
    expect(wmRows[0].wallet_addr.toLowerCase()).toBe(OPERATOR_ADDR.toLowerCase());
    expect(wmRows[0].verified).toBe(true);
    console.log('  ✔ user_wallet_mapping DB 조회 확인');

    // processed_events 검증
    const txHash = rows[0].tx_hash as string;
    const { rows: peRows } = await pool.query(
      'SELECT event_name, log_index FROM processed_events WHERE tx_hash = $1',
      [txHash],
    );
    expect(peRows.length).toBeGreaterThan(0);
    expect(peRows[0].event_name).toBe('Issued');
    console.log(`  ✔ processed_events 확인 (Issued, logIndex=${peRows[0].log_index})`);

    // user_nft_holdings — PgNFTLedgerService.creditNFT()가 파이프라인 내 자동 기록
    const { rows: nftRows } = await pool.query(
      'SELECT user_id, token_id, on_chain_tx FROM user_nft_holdings WHERE user_id = $1',
      ['user-mock-001'],
    );
    expect(nftRows).toHaveLength(1);
    expect(String(nftRows[0].token_id)).toBe(TOKEN_ID);
    console.log('  ✔ user_nft_holdings 자동 기록 확인 (creditNFT 경로)');

    // audit_log — TxTransitionBridge CONFIRMED 전이 시 coreBanking.recordAuditLog 자동 호출
    await waitFor(async () => {
      const { rows } = await pool.query(
        `SELECT actor, action FROM audit_log
         WHERE resource_type = 'issuance_request' AND actor = 'user-mock-001' AND action = 'ISSUANCE_CONFIRMED'`,
      );
      return rows.length > 0;
    }, 5_000, 'audit_log');
    const { rows: auditRows } = await pool.query(
      `SELECT actor, action FROM audit_log
       WHERE resource_type = 'issuance_request' AND actor = 'user-mock-001' AND action = 'ISSUANCE_CONFIRMED'
       ORDER BY event_time DESC LIMIT 1`,
    );
    expect(auditRows[0].actor).toBe('user-mock-001');
    expect(auditRows[0].action).toBe('ISSUANCE_CONFIRMED');
    console.log('  ✔ audit_log 자동 기록 확인 (TxTransitionBridge → coreBanking.recordAuditLog)');
  });

  // ── [2] REVERT ──────────────────────────────────────────────────────────────

  it('[2] REVERT — TX revert → VASPServer 500 → ExternalVASPAdapter throws → FAILED', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [2] REVERT — VASPServer 즉시 500 반환 → IssuerService FAILED');
    console.log('──────────────────────────────────────────────────────────────');

    await controlVasp.setMode('REVERT');
    console.log('  · setMode(REVERT) 완료');

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId: 'user-mock-001', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
    }));
    expect(statusCode).toBe(202);

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0 && rows[0].status !== 'REQUESTED';
    }, 15_000, 'FAILED');

    const { rows } = await pool.query('SELECT status, fail_reason FROM issuance_requests');
    await logAllStatuses(pool, 'FAILED 시점');
    expect(rows[0].status).toBe('FAILED');
    console.log('  ✔ REVERT → VASPServer 500 → FAILED 확인');

    await controlVasp.setMode('NORMAL');
    console.log('  · setMode(NORMAL) 복원 완료');
  });

  // ── [3] NO_EMIT ─────────────────────────────────────────────────────────────

  it('[3] NO_EMIT — mint 성공, Issued 이벤트 없음 → VASPServer 콜백 없음 → SUBMITTED 유지', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [3] NO_EMIT — TX 성공, 이벤트 없음 → 콜백 없음 → SUBMITTED 유지');
    console.log('──────────────────────────────────────────────────────────────');

    await controlVasp.setMode('NO_EMIT');
    console.log(`  · setMode(NO_EMIT) 완료`);

    const balanceBefore = await ledger.getNFTBalance(OPERATOR_ADDR, TOKEN_ID);

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId: 'user-mock-001', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
    }));
    expect(statusCode).toBe(202);

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status, fail_reason FROM issuance_requests');
      if (rows.length > 0 && rows[0].status === 'FAILED') throw new Error(`TX FAILED: ${rows[0].fail_reason}`);
      return rows.length > 0 && rows[0].status === 'SUBMITTED';
    }, 20_000, 'SUBMITTED');

    // VASPServer가 콜백을 보내지 않으므로 ledger 잔액 변화 없음을 확인 (3s 관찰)
    await new Promise(r => setTimeout(r, 3_000));

    const { rows }   = await pool.query('SELECT status, tx_hash FROM issuance_requests');
    const txHash     = rows[0].tx_hash as string;
    const receipt    = await provider.getTransactionReceipt(txHash);
    const issuedLogs = receipt!.logs.filter(l => {
      try { return new ethers.Interface(MOCK_VASP_ABI as ethers.InterfaceAbi).parseLog(l)?.name === 'Issued'; }
      catch { return false; }
    });

    await logAllStatuses(pool, 'NO_EMIT 확인 시점');
    console.log(`  · TX 내 Issued 이벤트 수     ${issuedLogs.length} (0이어야 함)`);
    console.log(`  · TX receipt.status          ${receipt!.status} (1=성공)`);
    console.log(`  · ledger balance             ${await ledger.getNFTBalance(OPERATOR_ADDR, TOKEN_ID)} (변화 없어야 함)`);

    expect(rows[0].status).toBe('SUBMITTED');
    expect(issuedLogs).toHaveLength(0);
    expect(receipt!.status).toBe(1);
    expect(await ledger.getNFTBalance(OPERATOR_ADDR, TOKEN_ID)).toBe(balanceBefore);
    console.log('  ✔ NO_EMIT — SUBMITTED 유지 + mint 성공 + ledger 변화 없음 확인');

    await controlVasp.setMode('NORMAL');
    console.log('  · setMode(NORMAL) 복원 완료');
  });

  // ── [4] PENDING ─────────────────────────────────────────────────────────────

  it('[4] PENDING — 블록 중단 → TX mempool 체류 → mineBlock → VASPServer 콜백 → CONFIRMED', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [4] PENDING — evm_setAutomine(false) → mempool → mineBlock → 콜백 → CONFIRMED');
    console.log('──────────────────────────────────────────────────────────────');

    await controlVasp.setMode('NORMAL');
    await controlVasp.freezeMining();
    console.log('  · 블록 생성 중단');

    const blockBefore = await provider.getBlockNumber();
    const balanceBefore = await ledger.getNFTBalance(OPERATOR_ADDR, TOKEN_ID);

    const webhookPromise = postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId: 'user-mock-001', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
    }));

    // TX가 mempool에 들어갈 시간 확보
    await new Promise(r => setTimeout(r, 2_000));

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0 && rows[0].status === 'SUBMITTED';
    }, 10_000, 'SUBMITTED (pre-mine)');
    console.log('  · SUBMITTED 확인 (블록 채굴 전)');

    const blockDuring = await provider.getBlockNumber();
    expect(blockDuring).toBe(blockBefore);

    // 블록 채굴 → VASPServer tx.wait(1) 해소 → NFT_ISSUED 콜백
    await provider.send('hardhat_mine', ['0x1']);
    await provider.send('evm_setAutomine', [true]);
    console.log('  · hardhat_mine(1) + automine 재개');

    const statusCode = await webhookPromise;
    expect(statusCode).toBe(202);

    // CONFIRMED 대기
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows[0]?.status === 'CONFIRMED';
    }, 15_000, 'CONFIRMED');

    const { rows } = await pool.query('SELECT status, tx_hash FROM issuance_requests');
    expect(rows[0].status).toBe('CONFIRMED');
    console.log('  ✔ PENDING → 채굴 → CONFIRMED 확인');

    // Redis Stream 경로 검증
    await waitFor(async () => {
      return (await ledger.getNFTBalance(OPERATOR_ADDR, TOKEN_ID)) > balanceBefore;
    }, 10_000, 'ledger.creditNFT (PENDING)');
    console.log(`  ✔ ledger balance 증가 확인 (VASPServer 콜백 → Redis Stream)`);

    // processed_events 검증
    const { rows: peRows } = await pool.query(
      'SELECT event_name FROM processed_events WHERE tx_hash = $1',
      [rows[0].tx_hash],
    );
    expect(peRows.length).toBeGreaterThan(0);
    console.log(`  ✔ processed_events 기록 확인 (${peRows.length}건)`);
  });

  // ── [5] REORG ───────────────────────────────────────────────────────────────

  it('[5] REORG — snapshot → 발행 → revertToSnapshot → 온체인 원복·DB CONFIRMED 유지', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [5] REORG — evm_snapshot → 발행 → evm_revert → 상태 원복');
    console.log('──────────────────────────────────────────────────────────────');

    await controlVasp.setMode('NORMAL');

    const iface       = new ethers.Interface(MOCK_VASP_ABI as ethers.InterfaceAbi);
    const viewContract = new ethers.Contract(mockVaspAddr, iface, provider);
    const balBefore   = await (viewContract['balanceOf'] as Function)(OPERATOR_ADDR, TOKEN_ID_BN) as bigint;
    console.log(`  · 스냅샷 전 balanceOf  ${balBefore}`);

    const snapshotId = await controlVasp.snapshot();
    console.log(`  · 스냅샷 ID           ${snapshotId}`);

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId: 'user-mock-001', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
    }));
    expect(statusCode).toBe(202);

    // CONFIRMED 대기
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0 && rows[0].status === 'CONFIRMED';
    }, 40_000, 'CONFIRMED before reorg');

    const balAfterIssue = await (viewContract['balanceOf'] as Function)(OPERATOR_ADDR, TOKEN_ID_BN) as bigint;
    expect(balAfterIssue).toBe(balBefore + 1n);
    console.log(`  · 발행 후 balanceOf   ${balAfterIssue}`);

    const { rows: confirmed } = await pool.query('SELECT status, tx_hash FROM issuance_requests');
    expect(confirmed[0].status).toBe('CONFIRMED');

    const { rows: peRows } = await pool.query(
      'SELECT event_name FROM processed_events WHERE tx_hash = $1',
      [confirmed[0].tx_hash],
    );
    expect(peRows.length).toBeGreaterThan(0);
    console.log(`  ✔ processed_events 기록 확인 (${peRows.length}건)`);

    // REORG 시뮬레이션
    await controlVasp.revertToSnapshot(snapshotId);
    console.log('  · evm_revert → 체인 롤백');

    const balAfterReorg = await (viewContract['balanceOf'] as Function)(OPERATOR_ADDR, TOKEN_ID_BN) as bigint;
    expect(balAfterReorg).toBe(balBefore);
    console.log(`  · REORG 후 balanceOf  ${balAfterReorg} (원복 확인)`);

    // DB는 CONFIRMED 유지 (REORG 감지는 ChainEventListener Phase 2 기능)
    const { rows: afterReorg } = await pool.query('SELECT status FROM issuance_requests');
    expect(afterReorg[0].status).toBe('CONFIRMED');
    console.log('  ✔ REORG 후 온체인 원복 확인');
    console.log('  ✔ DB CONFIRMED 유지 — REORG 감지(Phase 2)가 필요한 이유 시연');
  });

  // ── [stream-2] 멱등성 ─────────────────────────────────────────────────────

  it('[stream-2] 동일 requestId 중복 주입 → 멱등성 보장 (한 번만 처리)', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [stream-2] 멱등성 — 동일 requestId 두 번 XADD → creditNFT 1회');
    console.log('──────────────────────────────────────────────────────────────');

    const idemKey   = `kyobo:events:idem-${Date.now()}`;
    const idemGroup = 'nft-idem';
    await (redis as any).xgroup('CREATE', idemKey, idemGroup, '0', 'MKSTREAM');

    await pool.query(
      `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
       VALUES ('user-idem-002', '0xOWNER002', 'MOCK', true) ON CONFLICT (user_id) DO NOTHING`,
    );
    const idemLedger      = new PgNFTLedgerService(pool, mockVaspAddr, 31337, coreBanking);
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

    // 동일 requestId 두 번 발행
    await redisAdapter.xadd(idemKey, fields);
    await redisAdapter.xadd(idemKey, fields);

    await waitFor(() => creditCount >= 1, 15_000, 'first credit');
    await new Promise(r => setTimeout(r, 500));

    expect(creditCount).toBe(1);
    console.log('  ✔ creditNFT 호출 횟수:', creditCount, '(1이어야 함)');

    idemPool.stop();
    await (redis as any).del(idemKey, `${idemKey}:dlq`);
  });

  // ── [stream-3] DLQ ────────────────────────────────────────────────────────

  it('[stream-3] retryCount >= 3 → DLQ 이동 확인', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [stream-3] DLQ — _retryCount=3 → DLQ 스트림으로 이동');
    console.log('──────────────────────────────────────────────────────────────');

    const dlqKey   = `kyobo:events:dlq-test-${Date.now()}`;
    const dlqGroup = 'nft-dlq';
    await (redis as any).xgroup('CREATE', dlqKey, dlqGroup, '0', 'MKSTREAM');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dlqIdempotency = new IdempotencyGuard(new RedisIdempotencyStore(redis as any));
    const dlqLedger      = new PgNFTLedgerService(pool, mockVaspAddr, 31337, coreBanking);
    const failProcessor  = new AlwaysFailProcessor(dlqIdempotency, dlqLedger);

    // sourceStreamKey를 dlqKey로 지정 → DLQ 키: dlqKey + ':dlq'
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
      _retryCount: '3',   // >= MAX_RETRIES(3) → 즉시 DLQ 라우팅
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
  });

  // ── [stream-4] XAUTOCLAIM ─────────────────────────────────────────────────

  it('[stream-4] XAUTOCLAIM — PEL 잔류 메시지 재수신 처리', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [stream-4] XAUTOCLAIM — crash 시뮬 → PEL 잔류 → 새 consumer 재수신');
    console.log('──────────────────────────────────────────────────────────────');

    const claimKey    = `kyobo:events:xclaim-${Date.now()}`;
    const claimGroup  = `nft-xclaim-${Date.now()}`;
    const CRASH_CONSUMER = 'consumer-crash';
    const NEW_CONSUMER   = 'consumer-reclaim';

    // '$' 기준 생성 — 이후 추가된 메시지만 수신
    await (redis as any).xgroup('CREATE', claimKey, claimGroup, '$', 'MKSTREAM');

    await pool.query(
      `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
       VALUES ('user-xclaim-004', '0xOWNER004', 'MOCK', true) ON CONFLICT (user_id) DO NOTHING`,
    );
    const claimLedger      = new PgNFTLedgerService(pool, mockVaspAddr, 31337, coreBanking);
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

    // ② CRASH_CONSUMER가 XREADGROUP으로 읽음 — XACK 없이 중단
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
  });

  // ── [poll-1] pollStaleRequests ───────────────────────────────────────────

  it('[poll-1] pollStaleRequests — SUBMITTED TX → PENDING 조작 → getTransferStatus(VASPServer) → CONFIRMED', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [poll-1] pollStaleRequests: PENDING 10분 초과 → vasp.getStatus → CONFIRMED');
    console.log('──────────────────────────────────────────────────────────────');

    // NO_EMIT: TX 온체인 확정, Issued 이벤트 없음 → VASPServer 콜백 없음
    // → issuance_requests SUBMITTED, tx_mint_requests SUBMITTED 유지
    // → VASPServer.txStatuses.set(txHash, 'completed') 는 수행됨
    await controlVasp.setMode('NO_EMIT');

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId: 'user-mock-001', activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
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
    }, 20_000, 'SUBMITTED in tx_mint_requests');
    console.log(`  · tx_hash=${txHash.slice(0, 18)}…`);

    // VASPServer _waitAndNotify 완료 대기 (receipt 처리 → txStatuses='completed')
    await new Promise(r => setTimeout(r, 2_000));

    // DB 조작: SUBMITTED → PENDING + created_at을 11분 전으로 설정
    // (실제로는 mempool 체류 시나리오를 재현)
    await pool.query(
      "UPDATE tx_mint_requests SET status = 'PENDING', created_at = NOW() - INTERVAL '11 minutes' WHERE status = 'SUBMITTED'",
    );
    console.log('  · tx_mint_requests → PENDING (created_at -11분 조작)');

    // pollStaleRequests 호출:
    //   findPendingOlderThan(10) → PENDING 10분 초과 건 발견
    //   vasp.getStatus(txHash)   → VaspTxClientAdapter → ExternalVASPAdapter
    //                            → GET /transfers/:txHash → VASPServer 'completed'
    //                            → VaspTxClientAdapter: 'completed' → 'confirmed'
    //   handleMined(id, 0)       → PENDING → MINED
    //   handleConfirmed(id)      → MINED → CONFIRMED
    const pollResult = await txStateMachine.pollStaleRequests();
    expect(pollResult.processed).toBe(1);
    console.log(`  · pollStaleRequests processed=${pollResult.processed}`);

    // tx_mint_requests CONFIRMED 확인
    const { rows: txRows } = await pool.query(
      'SELECT status FROM tx_mint_requests WHERE tx_hash = $1',
      [txHash],
    );
    expect(txRows[0]?.status).toBe('CONFIRMED');
    console.log(`  ✔ tx_mint_requests CONFIRMED (pollStaleRequests → getTransferStatus 경로)`);

    // TxTransitionBridge → issuance_requests CONFIRMED 확인 (가장 최근 행 기준)
    await waitFor(async () => {
      const { rows } = await pool.query(
        "SELECT status FROM issuance_requests ORDER BY created_at DESC LIMIT 1",
      );
      return rows[0]?.status === 'CONFIRMED';
    }, 15_000, 'issuance_requests CONFIRMED');
    const { rows: isRows } = await pool.query(
      'SELECT status FROM issuance_requests ORDER BY created_at DESC LIMIT 1',
    );
    expect(isRows[0]?.status).toBe('CONFIRMED');
    console.log('  ✔ issuance_requests CONFIRMED (TxTransitionBridge 경유)');

    await controlVasp.setMode('NORMAL');
    console.log('  · setMode(NORMAL) 복원 완료');
  });

  // ── [reconcile-1] NFT Reconcile 대사 ──────────────────────────────────────────
  //
  // 시나리오:
  //   ① NORMAL 발행 → CONFIRMED + user_nft_holdings 기록
  //   ② user_nft_holdings 행 삭제 (이벤트 미처리 시뮬)
  //   ③ runManualReconcile → ONCHAIN_ONLY 불일치 감지
  //   ④ reconcile_history 1건 기록 검증

  it('[reconcile-1] NFT Reconcile — user_nft_holdings 삭제 후 ONCHAIN_ONLY 불일치 감지', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [reconcile-1] Reconcile — 온체인 O / 원장 X → ONCHAIN_ONLY');
    console.log('──────────────────────────────────────────────────────────────');

    const userId = 'user-mock-001';

    // ① NORMAL 발행 → CONFIRMED
    await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: { userId, activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
    }));
    console.log('  · webhook 전송');

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows[0]?.status === 'CONFIRMED';
    }, 40_000, 'CONFIRMED');
    console.log('  · CONFIRMED 확인');

    // user_nft_holdings 기록 대기 (NFTIssuedProcessor → PgNFTLedgerService.creditNFT)
    await waitFor(async () => {
      const { rows } = await pool.query(
        'SELECT token_id FROM user_nft_holdings WHERE user_id = $1', [userId],
      );
      return rows.length > 0;
    }, 15_000, 'user_nft_holdings populated');

    const { rows: holdingRows } = await pool.query(
      'SELECT token_id FROM user_nft_holdings WHERE user_id = $1', [userId],
    );
    console.log(`  · user_nft_holdings 기록 확인 (tokenId=${holdingRows[0]?.token_id})`);

    // ② user_nft_holdings 삭제 — 이벤트 미처리 시뮬
    await pool.query('DELETE FROM user_nft_holdings WHERE user_id = $1', [userId]);
    console.log('  · user_nft_holdings 삭제 완료 (ONCHAIN_ONLY 상태 조작)');

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
          chainAdapter.getNftHoldings(mockVaspAddr, addr, 0),
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

    const result = await reconcileAdmin.runManualReconcile(userId, 'test-operator');
    console.log(`  · runManualReconcile 완료 — mismatchCount=${result.mismatchCount}`);
    console.log(`    discrepancies:`, result.mismatchUserIds);

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

    // audit_log 기록 검증 (Java 경유 — RECONCILE_MANUAL_TRIGGER + RECONCILE_MISMATCH_DETECTED)
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
  }, 90_000);

  // ── [burst] 동시 발행 ─────────────────────────────────────────────────────────

  it('[burst] 5개 다른 userId 동시 발행 → NonceManager nonce 충돌 없이 전체 CONFIRMED', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [burst] 5명 동시 발행 — user-mock-001 ~ user-mock-005');
    console.log('──────────────────────────────────────────────────────────────');

    const COUNT = 5;
    const users = Array.from({ length: COUNT }, (_, i) => `user-mock-${String(i + 1).padStart(3, '0')}`);

    // 5개 웹훅 동시 전송
    const statuses = await Promise.all(
      users.map(userId => postWebhook(makePayload({
        eventType: 'ACTIVITY_ACHIEVED',
        data: { userId, activityId: randomUUID(), eventType: TEST_EVENT_TYPE, eventCode: 1, data: { steps: 15_000 } },
      }))),
    );
    statuses.forEach((s, i) => console.log(`  · ${users[i]} → HTTP ${s}`));
    expect(statuses.every(s => s === 202)).toBe(true);

    // 전체 CONFIRMED 대기
    await waitFor(async () => {
      const { rows } = await pool.query(
        `SELECT status FROM issuance_requests
         WHERE user_id = ANY($1)
         ORDER BY created_at DESC`,
        [users],
      );
      const confirmed = rows.filter(r => r.status === 'CONFIRMED').length;
      const failed    = rows.filter(r => r.status === 'FAILED').length;
      if (failed > 0) throw new Error(`${failed}개 FAILED 발생 — NonceManager 문제 의심`);
      console.log(`  · CONFIRMED ${confirmed}/${COUNT}`);
      return confirmed >= COUNT;
    }, 30_000, `${COUNT}개 전체 CONFIRMED`);

    const { rows } = await pool.query(
      `SELECT user_id, status FROM issuance_requests
       WHERE user_id = ANY($1)
       ORDER BY user_id`,
      [users],
    );
    rows.forEach(r => console.log(`  · [issuance_requests] ${r.user_id}: ${r.status}`));
    await logAllStatuses(pool, 'burst 최종');
    expect(rows.every(r => r.status === 'CONFIRMED')).toBe(true);
    console.log(`  ✔ ${COUNT}개 동시 발행 전체 CONFIRMED — NonceManager nonce 직렬화 동작 확인`);
  });

});
