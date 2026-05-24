/**
 * issuer-service Sepolia 통합 테스트
 *
 * 실제 흐름:
 *   HTTP POST → WebhookServer → WebhookPublishHandler → Redis Stream → ActivityProcessor → IssuerService
 *   → IntegrationSepoliaVASPAdapter → MockVASP (Sepolia 테스트넷)
 *   → ChainEventListener (Issued 이벤트) → IssuanceConfirmHandler
 *   → TxStateMachineService → PostgreSQL CONFIRMED
 *
 * 6가지 시나리오:
 *   [1] NORMAL     : 정상 발행 → Issued 이벤트 → CONFIRMED
 *   [2] REVERT     : TX revert → issuance_requests FAILED
 *   [3] NO_EMIT    : mint 성공, 이벤트 없음 → SUBMITTED 유지
 *   [stream-2]     : 중복 requestId → 멱등성 보장 (Redis Stream 독립 검증)
 *   [stream-3]     : retryCount >= 3 → DLQ 이동
 *   [stream-4]     : XAUTOCLAIM — PEL 잔류 메시지 재수신 처리
 *
 * 미지원 (Anvil 전용 RPC):
 *   [4] PENDING — evm_setAutomine 불가
 *   [5] REORG   — evm_snapshot 불가
 *
 * 인프라:
 *   - Sepolia 테스트넷 (SEPOLIA_RPC_URL 환경변수)
 *   - MockVASP 고정 주소 (SEPOLIA_MOCK_VASP_ADDR 환경변수)
 *   - PostgreSQL — @testcontainers/postgresql
 *   - Redis — testcontainers GenericContainer
 *   - Java internal-ledger — testcontainers GenericContainer
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
import { IoRedisAdapter }                        from '../../apps/issuer-service/src/infra/RedisAdapter';
import {
  WebhookServer,
  IdempotencyGuard,
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
  WebhookPublishHandler,
  WebhookPayload,
}                                                from '@kyobo/event-engine/webhook';
import { StubCoreBankingAdapter }                from '@kyobo/core-banking';
import { LedgerService }                         from '../../packages/core-banking/src/ledger/LedgerService';
import { PgDatabaseClient }                      from '../../packages/core-banking/src/ledger/PgDatabaseClient';
import { EVMAdapter }                            from '@kyobo/chain-adapters';
import { ChainEventListener }                    from '@kyobo/event-engine/listener';
import {
  ConsumerGroupPool,
  DLQHandler,
  NFTIssuedProcessor,
  ActivityProcessor,
  InMemoryLedgerService,
  RedisStreamPublisher,
  RedisStreamClient,
  StreamMessage,
}                                                from '@kyobo/event-engine';
import { PgNFTLedgerService }                    from '../../apps/issuer-service/src/infra/PgNFTLedgerService';
import { SepoliaVASPAdapter }                    from '../../packages/vasp/src/testing/SepoliaVASPAdapter';
import { ChainVASPAdapterConfig }                from '../../packages/vasp/src/testing/ChainVASPAdapterBase';
import {
  VASPTransactionReceipt,
  SubmitTransactionParams,
}                                                from '../../packages/vasp/src/interfaces/IVASPAdapter';

import MOCK_VASP_ABI                             from '../../packages/vasp/src/testing/MockVASP.abi.json';

// ── 상수 ──────────────────────────────────────────────────────────────────────

const WEBHOOK_PORT    = 19879;          // mock-vasp(19878)과 충돌 방지
const WEBHOOK_SECRET  = 'sepolia-test-secret-kyobo-32chars!!';
const TEST_EVENT_TYPE = 'WALK_GOAL_MET';

// Sepolia는 고정 컨트랙트 — 이전 실행 잔액과 충돌하지 않도록 실행마다 새로운 TOKEN_ID 사용
const TOKEN_ID    = String(Date.now());
const TOKEN_ID_BN = BigInt(TOKEN_ID);

// ── IntegrationSepoliaVASPAdapter ─────────────────────────────────────────────
// TX 확정 후 VASPServer와 동일하게 NFT_ISSUED 콜백을 WebhookServer로 전송

class IntegrationSepoliaVASPAdapter extends SepoliaVASPAdapter {
  private callbackUrl:    string;
  private callbackSecret: string;

  constructor(config: ChainVASPAdapterConfig & { callbackUrl: string; callbackSecret: string }) {
    super(config);
    this.callbackUrl    = config.callbackUrl;
    this.callbackSecret = config.callbackSecret;
  }

  override async submitTransaction(
    params: SubmitTransactionParams,
  ): Promise<VASPTransactionReceipt> {
    const [to, tokenId, amount, rawReason] = params.args;
    const reasonHex = String(rawReason).startsWith('0x')
      ? String(rawReason).slice(2)
      : String(rawReason);
    const reason32 = ('0x' + reasonHex.padEnd(64, '0').slice(0, 64)) as `0x${string}`;

    const fn = this.mockVasp['issueActivityNFT'] as (
      to: unknown, tokenId: unknown, amount: unknown, reason: unknown,
    ) => Promise<ethers.ContractTransactionResponse>;
    const tx = await fn(to, tokenId, amount, reason32);

    // 즉시 반환 후 비동기로 receipt 대기 → NFT_ISSUED 콜백 전송 (VASPServer와 동일)
    this._waitAndNotify(tx, params.idempotencyKey ?? tx.hash, String(tokenId), String(to))
      .catch(e => console.error('[SepoliaVASP] 콜백 오류:', (e as Error).message));

    return { txHash: tx.hash, status: 'submitted', timestamp: Date.now() };
  }

  private async _waitAndNotify(
    tx:        ethers.ContractTransactionResponse,
    requestId: string,
    tokenId:   string,
    to:        string,
  ): Promise<void> {
    const receipt = await tx.wait(1).catch(() => null);
    if (!receipt || receipt.status === 0) return;

    const iface     = new ethers.Interface(MOCK_VASP_ABI as ethers.InterfaceAbi);
    const issuedLog = receipt.logs.find(l => {
      try { return iface.parseLog(l)?.name === 'Issued'; } catch { return false; }
    });
    if (!issuedLog) return; // NO_EMIT 모드

    const args = iface.parseLog(issuedLog)!.args;
    const body = JSON.stringify({
      eventType: 'NFT_ISSUED',
      requestId,
      timestamp: Date.now(),
      data: {
        txHash:      tx.hash,
        blockNumber: receipt.blockNumber,
        tokenId:     args[1].toString(),
        to:          args[0],
        reason:      args[2],
      },
    });
    const sig = crypto.createHmac('sha256', this.callbackSecret).update(body).digest('hex');

    const url = new URL(this.callbackUrl);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port:     Number(url.port || 80),
          path:     url.pathname || '/',
          method:   'POST',
          headers:  {
            'Content-Type':      'application/json',
            'Content-Length':    Buffer.byteLength(body),
            'x-kyobo-signature': sig,
          },
        },
        res => { res.resume(); res.on('end', resolve); },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    console.log(`[SepoliaVASP] NFT_ISSUED 콜백 전송 완료 (requestId=${requestId.slice(0, 8)}…)`);
  }
}

// ── PgHybridCoreBankingAdapter ────────────────────────────────────────────────

class PgHybridCoreBankingAdapter extends StubCoreBankingAdapter {
  constructor(private readonly pool: Pool) { super(); }

  override async getUserAccount(userId: string) {
    const { rows } = await this.pool.query(
      'SELECT wallet_addr FROM user_wallet_mapping WHERE user_id = $1',
      [userId],
    );
    if (!rows[0]) return null;
    return {
      userId,
      accountId: `acc-${userId}`,
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
  const { rows } = await pool.query(
    'SELECT status, fail_reason, tx_hash FROM issuance_requests ORDER BY created_at DESC LIMIT 1',
  );
  if (rows.length === 0) {
    console.log(`  [DB ${elapsed(startMs)}] ${label} — issuance_requests: (없음)`);
    return;
  }
  const r = rows[0];
  const failPart = r.fail_reason ? ` fail=${String(r.fail_reason).slice(0, 60)}` : '';
  const txPart   = r.tx_hash    ? ` tx=${String(r.tx_hash).slice(0, 14)}…` : '';
  console.log(`  [DB ${elapsed(startMs)}] ${label} — status=${r.status}${txPart}${failPart}`);
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

function postJavaApi(
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const target = new URL(javaBaseUrl + path);
    const req = http.request(
      {
        hostname: target.hostname,
        port:     Number(target.port),
        path:     target.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      res => {
        let buf = '';
        res.on('data', (chunk: string) => { buf += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: buf }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
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

let vasp:           IntegrationSepoliaVASPAdapter;
let controlVasp:    SepoliaVASPAdapter;
let coreBanking:    PgHybridCoreBankingAdapter;
let ledgerService:  LedgerService;
let webhookServer:  WebhookServer;
let chainListener:  ChainEventListener;
let provider:       ethers.JsonRpcProvider;
let chainAdapter:   EVMAdapter;
let confirmHandler: IssuanceConfirmHandler;
let fallbackPollInterval: ReturnType<typeof setInterval>;

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

// ─────────────────────────────────────────────────────────────────────────────

describe('issuer-service Sepolia 통합 테스트 — 3가지 시나리오', () => {

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

    // ③ PostgreSQL Testcontainer
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

    // ④ Java internal-ledger 컨테이너
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

    // ⑤ VASP 어댑터 초기화
    console.log('\n  [4/6] SepoliaVASPAdapter 초기화...');
    vasp = new IntegrationSepoliaVASPAdapter({
      rpcUrl:         sepoliaRpc,
      privateKey:     OPERATOR_PRIVATE_KEY,
      mockVaspAddr:   mockVaspAddr,
      callbackUrl:    `http://localhost:${WEBHOOK_PORT}`,
      callbackSecret: WEBHOOK_SECRET,
    });

    // controlVasp: DEPLOYER_KEY — setMode 전용 (OPERATOR와 nonce 분리)
    controlVasp = new SepoliaVASPAdapter({
      rpcUrl:       sepoliaRpc,
      privateKey:   DEPLOYER_PRIVATE_KEY,
      mockVaspAddr: mockVaspAddr,
    });

    // ⑥ Core Banking 어댑터 + 정적 데이터 시드
    coreBanking = new PgHybridCoreBankingAdapter(pool);

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

    const conditionSvc = new EventConditionService([new ActivityConditionStrategy()]);
    const factory      = new TokenIssuerFactory({
      chainAdapter,
      vaspAdapter: vasp,
      coreBanking,
      pool,
    });

    const factoryResult = factory.createNFTIssuer(mockVaspAddr, conditionSvc);
    const { issuerService } = factoryResult;
    confirmHandler = factoryResult.confirmHandler;

    const currentBlock = await chainAdapter.getBlockNumber();
    const inMemoryBlockStore = { block: currentBlock };
    chainListener = new ChainEventListener(
      chainAdapter,
      [confirmHandler],
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

    // 폴백 폴링 — Sepolia에서는 queryEvents(eth_getLogs)로 Issued 이벤트 직접 스캔
    {
      let fallbackFromBlock = await chainAdapter.getBlockNumber();
      let fallbackBusy = false;
      fallbackPollInterval = setInterval(async () => {
        if (fallbackBusy) return;
        fallbackBusy = true;
        try {
          const toBlock = await chainAdapter.getBlockNumber();
          if (toBlock <= fallbackFromBlock) return;
          const events = await chainAdapter.queryEvents(
            mockVaspAddr, MOCK_VASP_ABI as unknown[], 'Issued',
            fallbackFromBlock + 1, toBlock,
          );
          for (const ev of events) {
            await confirmHandler.handle(ev).catch(e =>
              console.error('[fallback] confirmHandler error:', (e as Error).message),
            );
            const safePayload = JSON.parse(
              JSON.stringify(ev.args, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
            );
            await ledgerService.recordProcessedEvent(
              ev.txHash, ev.logIndex, ev.eventName, BigInt(ev.blockNumber), safePayload,
            ).catch(e => console.error('[fallback] recordProcessedEvent error:', (e as Error).message));
          }
          fallbackFromBlock = toBlock;
        } catch {
          // ignore transient RPC errors
        } finally {
          fallbackBusy = false;
        }
      }, 3_000);  // Sepolia 블록타임 ~12s — 3s 폴링으로 충분
    }

    // Redis Stream: ACTIVITY_ACHIEVED → XADD → ActivityProcessor → IssuerService
    const streamClient: RedisStreamClient = {
      async xadd(key, fields) {
        const flat = Object.entries(fields).flat();
        return (redis as any).xadd(key, '*', ...flat) as Promise<string>;
      },
      async xgroupCreate(key, group, id, mkstream) {
        await (redis as any).xgroup('CREATE', key, group, id, ...(mkstream ? ['MKSTREAM'] : []));
      },
      async ping() { return redis.ping(); },
    };
    const streamPublisher  = new RedisStreamPublisher(streamClient);
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
    ledger = new PgNFTLedgerService(pool, mockVaspAddr, 11155111);
    const activityProcessor  = new ActivityProcessor(issuerService, idempotency);
    const nftIssuedProcessor = new NFTIssuedProcessor(idempotency, ledger);
    redisAdapter  = new IoRedisAdapter(redis);
    const streamDlq = new DLQHandler(
      redisAdapter,
      { async sendAlert(msg) { console.error('[DLQ]', msg); } },
    );
    consumerPool = new ConsumerGroupPool(
      redisAdapter, streamDlq,
      { streamKey: 'kyobo:events', batchSize: 10, blockMs: 3_000, minIdleMs: 60_000 },
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
    clearInterval(fallbackPollInterval);
    consumerPool?.stop();
    await webhookServer?.close().catch(() => {});
    await chainListener.stop().catch(() => {});
    await redis.quit().catch(() => {});
    await pool.end().catch(() => {});
    await javaContainer?.stop().catch(() => {});
    await pgContainer.stop().catch(() => {});
    await redisContainer?.stop().catch(() => {});
    await dockerNetwork?.stop().catch(() => {});
  });

  // ── beforeEach: 이전 테스트 드레인 → 테이블 초기화 ──────────────────────────

  beforeEach(async () => {
    // Sepolia 블록타임 고려 — 이전 TX가 confirm될 때까지 최대 2분 대기
    await waitFor(async () => {
      const { rows } = await pool.query(
        "SELECT COUNT(*) AS cnt FROM issuance_requests WHERE status NOT IN ('CONFIRMED','FAILED')",
      );
      return parseInt(rows[0].cnt, 10) === 0;
    }, 120_000, 'drain previous test').catch(() => {});

    await pool.query('TRUNCATE issuance_requests, tx_mint_requests, mint_requests, processed_events, user_nft_holdings, audit_log');
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
        console.log(`  [DB ${elapsed(t0)}] status=${lastStatus}${txShort}`);
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
    console.log(`  [DB ${elapsed(t0)}] status=${rows[0].status}`);
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

    // ── ⑦ Java internal-ledger: NFT 보유 기록 ─────────────────────────────
    console.log(`\n  ── Java internal-ledger 검증 ───────────────────────────────`);
    const nftRes = await postJavaApi(
      `/api/internal/users/user-sepolia-001/nft-holdings`,
      { tokenId: Number(TOKEN_ID), contractAddr: mockVaspAddr, chainId: 11155111, amount: 1, acquiredAt: new Date().toISOString(), onChainTx: txHash },
    );
    console.log(`  · POST /nft-holdings → HTTP ${nftRes.status}`);
    expect(nftRes.status).toBe(200);
    const { rows: nftRows } = await pool.query(
      'SELECT user_id, token_id, on_chain_tx FROM user_nft_holdings WHERE user_id = $1',
      ['user-sepolia-001'],
    );
    expect(nftRows).toHaveLength(1);
    expect(String(nftRows[0].token_id)).toBe(TOKEN_ID);
    expect(nftRows[0].on_chain_tx.toLowerCase()).toBe(txHash.toLowerCase());
    console.log(`  ✔ user_nft_holdings  token_id=${nftRows[0].token_id} tx=${String(nftRows[0].on_chain_tx).slice(0, 14)}…`);

    const auditRes = await postJavaApi(
      `/api/internal/audit-log`,
      { actor: 'user-sepolia-001', action: 'NFT_ISSUED', resourceType: 'issuance_request', resourceId: txHash, beforeState: null, afterState: JSON.stringify({ status: 'CONFIRMED', txHash }) },
    );
    console.log(`  · POST /audit-log → HTTP ${auditRes.status}`);
    expect(auditRes.status).toBe(200);
    const { rows: auditRows } = await pool.query(
      "SELECT actor, action FROM audit_log WHERE resource_type = 'issuance_request'",
    );
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0].actor).toBe('user-sepolia-001');
    expect(auditRows[0].action).toBe('NFT_ISSUED');
    console.log(`  ✔ audit_log  actor=${auditRows[0].actor} action=${auditRows[0].action}`);

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
        console.log(`  [DB ${elapsed(t0)}] status=${lastStatus}${failPart}`);
        await logRedisStream(redis, `status=${lastStatus}`, t0);
      }
      return rows[0].status !== 'REQUESTED';
    }, 120_000, 'FAILED');

    const { rows } = await pool.query('SELECT status, fail_reason FROM issuance_requests');
    console.log(`\n  ── 최종 상태 ───────────────────────────────────────────────`);
    console.log(`  [DB ${elapsed(t0)}] status=${rows[0].status}`);
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
        console.log(`  [DB ${elapsed(t0)}] status=${lastStatus}${txShort}`);
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
    console.log(`  [DB ${elapsed(t0)}] status=${rows[0].status}`);
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
    const idemLedger      = new PgNFTLedgerService(pool, mockVaspAddr, 11155111);
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
    const dlqLedger      = new PgNFTLedgerService(pool, mockVaspAddr, 11155111);
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
    const claimLedger      = new PgNFTLedgerService(pool, mockVaspAddr, 11155111);
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

});
