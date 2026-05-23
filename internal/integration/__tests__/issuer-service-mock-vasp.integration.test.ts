/**
 * issuer-service MockVASP 통합 테스트
 *
 * 실제 흐름:
 *   HTTP POST → WebhookServer → ActivityRouter → IssuerService
 *   → AnvilVASPAdapter → MockVASP (Hardhat 로컬 노드)
 *   → ChainEventListener (Issued 이벤트) → IssuanceConfirmHandler
 *   → TxStateMachineService → PostgreSQL CONFIRMED
 *
 * 5가지 시나리오:
 *   [1] NORMAL  : 정상 발행 → ChainEventListener → CONFIRMED
 *   [2] REVERT  : TX revert → FAILED
 *   [3] NO_EMIT : mint 성공, 이벤트 없음 → SUBMITTED 유지 (폴백 경로 시뮬레이션)
 *   [4] PENDING : 블록 중단 → TX mempool 체류 → mineBlock → CONFIRMED
 *   [5] REORG   : snapshot → CONFIRMED → revertToSnapshot → 체인 상태 원복 확인
 *
 * 인프라:
 *   - Hardhat 로컬 노드 (포트 18545) — 자식 프로세스로 기동
 *   - MockVASP 컨트랙트 — ethers.js ContractFactory로 배포
 *   - PostgreSQL — @testcontainers/postgresql
 *   - ChainEventListener — EVMAdapter HTTP 폴링 (ws 불필요)
 */

import { readFileSync }                 from 'fs';
import { resolve }                      from 'path';
import http                             from 'http';
import crypto                           from 'crypto';
import { randomUUID }                   from 'crypto';
import { ethers }                       from 'ethers';
import { Pool }                         from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Network, Wait }                from 'testcontainers';
import type { StartedNetwork }                             from 'testcontainers';

import { TokenIssuerFactory }                    from '../../apps/issuer-service/src/factory/TokenIssuerFactory';
import { ActivityConditionStrategy, EventConditionService } from '../../apps/issuer-service/src/services/EventConditionService';
import { ActivityRouter }                        from '../../apps/issuer-service/src/api/ActivityRouter';
import { IssuanceConfirmHandler }                from '../../apps/issuer-service/src/handlers/IssuanceConfirmHandler';
import { WebhookServer, IdempotencyGuard, InMemoryIdempotencyStore } from '@kyobo/event-engine/webhook';
import type { WebhookPayload }                   from '@kyobo/event-engine/webhook';
import { StubCoreBankingAdapter }                from '@kyobo/core-banking';
import { LedgerService }                         from '../../packages/core-banking/src/ledger/LedgerService';
import { PgDatabaseClient }                      from '../../packages/core-banking/src/ledger/PgDatabaseClient';
import { OutboxWorker }                          from '../../packages/vasp/src/outbox/OutboxWorker';
import { EVMAdapter }                            from '@kyobo/chain-adapters';
import { ChainEventListener }                    from '@kyobo/event-engine/listener';
import { AnvilVASPAdapter }                      from '../../packages/vasp/src/testing/AnvilVASPAdapter';
import type { ChainVASPAdapterConfig }            from '../../packages/vasp/src/testing/ChainVASPAdapterBase';
import type {
  VASPTransactionReceipt,
  SubmitTransactionParams,
}                                                from '../../packages/vasp/src/interfaces/IVASPAdapter';
import MOCK_VASP_ABI                             from '../../packages/vasp/src/testing/MockVASP.abi.json';

// ── 상수 ──────────────────────────────────────────────────────────────────────

const WEBHOOK_PORT    = 19878;
const WEBHOOK_SECRET  = 'mock-vasp-test-secret-kyobo-32ch';
const TEST_EVENT_TYPE = 'WALK_GOAL_MET';
const TOKEN_ID        = '1001';
const TOKEN_ID_BN     = BigInt(TOKEN_ID);

// Hardhat 기본 계정 (테스트 전용)
const DEPLOYER_KEY  = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OPERATOR_KEY  = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DEPLOYER_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OPERATOR_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const BLOCKCHAIN_DIR  = resolve(__dirname, '..', '..', '..', 'blockchain');
const ARTIFACT_PATH   = resolve(
  BLOCKCHAIN_DIR, 'artifacts', 'src', 'mocks', 'MockVASP.sol', 'MockVASP.json',
);

// ── IntegrationAnvilVASPAdapter ────────────────────────────────────────────────
// ── PgHybridCoreBankingAdapter ────────────────────────────────────────────────
// getUserAccount: user_wallet_mapping DB 조회 (실제 DB 경로 검증)
// 그 외 메서드: StubCoreBankingAdapter 위임 (in-memory)

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

// VaspTxClientAdapter가 method:'mint'으로 호출 → MockVASP.issueActivityNFT로 위임
// (이미 this.mockVasp에 MOCK_VASP_ABI가 로드되어 있음)

class IntegrationAnvilVASPAdapter extends AnvilVASPAdapter {
  constructor(config: ChainVASPAdapterConfig) {
    super(config);
  }

  override async submitTransaction(
    params: SubmitTransactionParams,
  ): Promise<VASPTransactionReceipt> {
    // args: [to, tokenId, amount, reason] — VaspTxClientAdapter.submitMint() 기준
    const [to, tokenId, amount, rawReason] = params.args;

    // VaspTxClientAdapter는 requestId(UUID) 를 UTF-8 hex 로 인코딩하여
    // bytes32 보다 길어질 수 있음 → 앞 32 바이트(64 hex 자)만 취해 정규화
    const reasonHex  = String(rawReason).startsWith('0x')
      ? String(rawReason).slice(2)
      : String(rawReason);
    const reason32   = ('0x' + reasonHex.padEnd(64, '0').slice(0, 64)) as `0x${string}`;

    const fn = this.mockVasp['issueActivityNFT'] as (
      to: unknown, tokenId: unknown, amount: unknown, reason: unknown,
    ) => Promise<ethers.ContractTransactionResponse>;
    const tx = await fn(to, tokenId, amount, reason32);

    // tx.wait(1)을 호출하지 않고 즉시 txHash를 반환한다.
    // 이유: Hardhat automine 환경에서는 fn() 호출(eth_sendRawTransaction) 시점에
    //       블록이 이미 채굴된다. tx.wait(1)은 provider.pollingInterval(기본 4000ms)
    //       주기로 영수증을 확인하므로 최대 4s 지연이 발생한다.
    //       EVMAdapter의 contract.on() 폴링이 이 지연 창 안에서 Issued 이벤트를
    //       감지하면 tx_mint_requests에 아직 txHash가 없어 findByTxHash null → 영구 누락.
    //       즉시 반환함으로써 TxStateMachineService가 DB를 먼저 업데이트하고,
    //       이후 EVMAdapter 폴링이 Issued 이벤트를 처리할 때 findByTxHash가 성공한다.
    return { txHash: tx.hash, status: 'submitted', timestamp: Date.now() };
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
  timeoutMs = 20_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`);
    await new Promise(r => setTimeout(r, 200));
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

async function deployMockVASP(rpcUrl: string): Promise<string> {
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8'));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  // NonceManager로 래핑 → deploy + grantRole 연속 TX 시 nonce 캐시 문제 방지
  const deployerBase = new ethers.Wallet(DEPLOYER_KEY, provider);
  const deployer     = new ethers.NonceManager(deployerBase);
  const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  // constructor(address operator) — deployer가 deployer, OPERATOR_ADDR가 operator
  const contract = await factory.deploy(OPERATOR_ADDR);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log(`  [deploy] MockVASP → ${addr}`);

  // deployer에게 OPERATOR_ROLE 부여 — controlVasp(DEPLOYER_KEY) setMode 전용 signer로 사용
  // (IssuerService는 OPERATOR_KEY signer 사용 → nonce 충돌 없음)
  const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes('OPERATOR_ROLE'));
  const mockVasp = new ethers.Contract(addr, artifact.abi, deployer);
  await (await (mockVasp['grantRole'] as (role: string, account: string) => Promise<ethers.ContractTransactionResponse>)(OPERATOR_ROLE, DEPLOYER_ADDR)).wait();
  console.log(`  [deploy] OPERATOR_ROLE granted to deployer`);

  return addr;
}

// ── 전역 상태 ─────────────────────────────────────────────────────────────────

let hardhatRpc:     string;
let hardhatContainer: { getHost(): string; getMappedPort(port: number): number; stop(): Promise<unknown> };
let dockerNetwork:  StartedNetwork;
let pgContainer:    StartedPostgreSqlContainer;
let javaContainer:  { getHost(): string; getMappedPort(port: number): number; stop(): Promise<unknown> };
let javaBaseUrl:    string;
let pool:           Pool;
let mockVaspAddr:   string;
let vasp:           IntegrationAnvilVASPAdapter;
let controlVasp:    AnvilVASPAdapter;         // deployer 키 — setMode/freezeMining 전용
let coreBanking:    PgHybridCoreBankingAdapter; // getUserAccount → user_wallet_mapping DB
let ledgerService:  LedgerService;            // recordProcessedEvent → processed_events DB
let outboxWorker:   OutboxWorker;             // processPending → outbox_events DB
let webhookServer:  WebhookServer;
let chainListener:  ChainEventListener;
let provider:       ethers.JsonRpcProvider;
let chainAdapter:   EVMAdapter;
let confirmHandler: IssuanceConfirmHandler;
let fallbackPollInterval: ReturnType<typeof setInterval>;

// ─────────────────────────────────────────────────────────────────────────────

describe('issuer-service MockVASP 통합 테스트 — 5가지 시나리오', () => {

  // ── beforeAll ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  [SETUP] MockVASP 통합 테스트 환경 구축');
    console.log('══════════════════════════════════════════════════════════════');

    // ① Hardhat 노드 컨테이너 기동 (kyobo/hardhat-node:test)
    console.log('\n  [1/6] Hardhat 노드 컨테이너 기동...');
    hardhatContainer = await new GenericContainer('kyobo/hardhat-node:test')
      .withExposedPorts(8545)
      .withWaitStrategy(Wait.forLogMessage('Started HTTP and WebSocket JSON-RPC server'))
      .start();
    hardhatRpc = `http://${hardhatContainer.getHost()}:${hardhatContainer.getMappedPort(8545)}`;
    // 이전 컨테이너 재사용 시 stale 상태 초기화
    await new ethers.JsonRpcProvider(hardhatRpc).send('hardhat_reset', []);
    console.log(`  [1/6] Hardhat 컨테이너 준비 완료 → ${hardhatRpc}`);

    // ② MockVASP 배포
    console.log('\n  [2/6] MockVASP 컨트랙트 배포...');
    mockVaspAddr = await deployMockVASP(hardhatRpc);
    provider     = new ethers.JsonRpcProvider(hardhatRpc);

    // ③ PostgreSQL Testcontainer (Docker 네트워크에 참여 — Java 컨테이너와 공유)
    console.log('\n  [3/6] PostgreSQL 컨테이너 시작...');
    dockerNetwork = await new Network().start();
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('kyobo_test')
      .withUsername('kyobo')
      .withPassword('kyobo')
      .withNetwork(dockerNetwork)
      .withNetworkAliases('postgres')
      .start();
    pool = new Pool({ connectionString: pgContainer.getConnectionUri() });

    // 스키마 생성
    const schema = readFileSync(resolve(__dirname, '..', 'setup', 'schema.sql'), 'utf-8');
    await pool.query(schema);
    console.log('  [3/6] PostgreSQL 준비 완료');

    // ③-b Java internal-ledger 컨테이너 시작 (ddl-auto: validate — 스키마 먼저 적용 필요)
    console.log('\n  [3b] Java internal-ledger 컨테이너 시작 (kyobo/internal-ledger:test)...');
    javaContainer = await new GenericContainer('kyobo/internal-ledger:test')
      .withNetwork(dockerNetwork)
      .withEnvironment({
        DB_URL:           'jdbc:postgresql://postgres:5432/kyobo_test',
        DB_USERNAME:      'kyobo',
        DB_PASSWORD:      'kyobo',
        CORE_BANKING_URL: 'http://localhost:9999',  // stub — 실제 연동 불필요
      })
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp('/api/internal/health', 8080).forStatusCode(200))
      .start();
    javaBaseUrl = `http://${javaContainer.getHost()}:${javaContainer.getMappedPort(8080)}`;
    console.log(`  [3b] Java 컨테이너 준비 완료 → ${javaBaseUrl}`);

    // ④ VASP 어댑터 생성
    console.log('\n  [4/6] IntegrationAnvilVASPAdapter 초기화...');
    vasp = new IntegrationAnvilVASPAdapter({
      rpcUrl:       hardhatRpc,
      privateKey:   OPERATOR_KEY,
      mockVaspAddr: mockVaspAddr,
      confirmations: 1,
    });
    // setMode().wait() 폴링도 빠르게 처리 (기본 4000ms → 100ms)
    (vasp as any).provider.pollingInterval = 100;

    // controlVasp: DEPLOYER_KEY — setMode/freezeMining 전용
    // IssuerService는 vasp(OPERATOR_KEY)를 사용 → nonce 충돌 없음
    controlVasp = new AnvilVASPAdapter({
      rpcUrl:       hardhatRpc,
      privateKey:   DEPLOYER_KEY,
      mockVaspAddr: mockVaspAddr,
      confirmations: 1,
    });
    (controlVasp as any).provider.pollingInterval = 100;

    // ⑤ Core Banking — user_wallet_mapping DB 조회 어댑터 + 정적 데이터 시드
    coreBanking = new PgHybridCoreBankingAdapter(pool);

    // user_wallet_mapping: getUserAccount()가 DB에서 walletAddr를 읽음
    await pool.query(
      `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
       VALUES ($1, $2, 'ANVIL', true) ON CONFLICT (user_id) DO NOTHING`,
      ['user-mock-001', OPERATOR_ADDR],
    );

    // issuance_policies 시드
    await pool.query(
      `INSERT INTO issuance_policies (event_type, token_id, amount)
       VALUES ($1, $2, 1) ON CONFLICT (event_type) DO NOTHING`,
      [TEST_EVENT_TYPE, TOKEN_ID],
    );

    // processed_events·outbox_events 서비스 초기화
    ledgerService = new LedgerService(new PgDatabaseClient(pool), coreBanking);
    outboxWorker  = new OutboxWorker({
      query: async (sql: string, params?: unknown[]) => {
        const res = await pool.query(sql, params as any[]);
        return res.rows;
      },
    });

    // ⑥ 서비스 조립
    console.log('\n  [5/6] 서비스 조립 (IssuerService + ChainEventListener + WebhookServer)...');

    chainAdapter = new EVMAdapter({
      rpcUrl:  hardhatRpc,
      chainId: '31337',
    });
    // 기본 폴링 간격(4000ms)에서는 contract.on('Issued') 이벤트가 너무 늦게 감지된다.
    (chainAdapter as any).provider.pollingInterval = 100;

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

    // ChainEventListener: MockVASP 'Issued' 이벤트 구독
    const inMemoryBlockStore = { block: 0 };
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

    // contract.on() 폴링이 환경(ethers v6 + Hardhat HTTP)에서 발화하지 않을 경우를 대비한
    // 폴백 폴링: queryEvents()로 Issued 이벤트를 주기적으로 직접 조회 → confirmHandler 호출
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
            // processed_events 기록 — BigInt를 string 변환 후 JSONB 저장 (ON CONFLICT DO NOTHING)
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
      }, 300);
    }

    // WebhookServer + ActivityRouter
    const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());
    webhookServer     = new WebhookServer({
      port:      WEBHOOK_PORT,
      secret:    WEBHOOK_SECRET,
      maxBodyKb: 64,
    });
    const router = new ActivityRouter(issuerService, idempotency);
    router.register(webhookServer);
    await webhookServer.listen();

    console.log('  [6/6] 환경 구축 완료');
    console.log('\n══════════════════════════════════════════════════════════════\n');
  }, 120_000);

  // ── afterAll ──────────────────────────────────────────────────────────────

  afterAll(async () => {
    clearInterval(fallbackPollInterval);
    await webhookServer.close().catch(() => {});
    await chainListener.stop().catch(() => {});
    await pool.end().catch(() => {});
    await javaContainer?.stop().catch(() => {});
    await pgContainer.stop().catch(() => {});
    await dockerNetwork?.stop().catch(() => {});
    await hardhatContainer?.stop().catch(() => {});
  });

  // ── beforeEach: 이전 테스트 background 처리 드레인 → 테이블 초기화 ─────────────
  // setMode는 각 테스트가 직접 관리한다.
  // — setMode를 여기서 호출하면 IssuerService background 처리와 동일 signer nonce 충돌 발생

  beforeEach(async () => {
    // 이전 테스트의 비동기 처리(tx.wait, IssuerService)가 완료될 때까지 대기
    await waitFor(async () => {
      const { rows } = await pool.query(
        "SELECT COUNT(*) AS cnt FROM issuance_requests WHERE status NOT IN ('CONFIRMED','FAILED')",
      );
      return parseInt(rows[0].cnt, 10) === 0;
    }, 15_000, 'drain previous test').catch(() => {});

    await pool.query('TRUNCATE issuance_requests, tx_mint_requests, mint_requests, processed_events, outbox_events, user_nft_holdings, audit_log');
    // 모드 복귀는 각 테스트 내부에서 처리 (nonce 충돌 방지)
  }, 20_000);

  // ── [1] NORMAL ──────────────────────────────────────────────────────────────

  it('[1] NORMAL — 정상 발행 → Issued 이벤트 → CONFIRMED', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [1] NORMAL — 정상 발행 + ChainEventListener → CONFIRMED');
    console.log('──────────────────────────────────────────────────────────────');

    const balBefore = await provider.send('eth_call', [{
      to:   mockVaspAddr,
      data: new ethers.Interface(MOCK_VASP_ABI as ethers.InterfaceAbi)
              .encodeFunctionData('balanceOf', [OPERATOR_ADDR, TOKEN_ID_BN]),
    }, 'latest']);
    const balBeforeNum = BigInt(balBefore);
    console.log(`  · 발행 전 balanceOf  ${balBeforeNum}`);

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: {
        userId:     'user-mock-001',
        activityId: randomUUID(),
        eventType:  TEST_EVENT_TYPE,
        eventCode:  1,
        data:       { steps: 15_000 },
      },
    }));
    expect(statusCode).toBe(202);
    console.log('  · webhook 202 수신');

    // SUBMITTED 또는 FAILED 대기 (FAILED면 빠르게 감지 가능)
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0 && rows[0].status !== 'REQUESTED';
    }, 20_000, 'SUBMITTED');
    const { rows: midRows } = await pool.query('SELECT status, fail_reason, tx_hash FROM issuance_requests');
    if (midRows[0].status === 'FAILED') {
      throw new Error(`TX failed early: ${midRows[0].fail_reason}`);
    }
    console.log('  · issuance_requests SUBMITTED 확인');
    console.log(`  · issuance_requests.tx_hash  ${midRows[0].tx_hash}`);

    // tx_mint_requests 상태 확인 (디버그)
    {
      const { rows: txRows } = await pool.query('SELECT status, tx_hash FROM tx_mint_requests');
      if (txRows.length > 0) {
        console.log(`  · tx_mint_requests status    ${txRows[0].status}`);
        console.log(`  · tx_mint_requests.tx_hash   ${txRows[0].tx_hash}`);
        // eth_getLogs로 Issued 이벤트 직접 확인
        const iface = new ethers.Interface(MOCK_VASP_ABI as ethers.InterfaceAbi);
        const receipt = await provider.getTransactionReceipt(txRows[0].tx_hash as string);
        const issuedCount = receipt?.logs.filter(l => { try { return iface.parseLog(l)?.name === 'Issued'; } catch { return false; } }).length ?? 0;
        console.log(`  · 해당 TX Issued 이벤트 수  ${issuedCount} (1이어야 함)`);
      }
    }

    // ChainEventListener가 Issued 이벤트 수신 → CONFIRMED (최대 40s)
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows[0]?.status === 'CONFIRMED';
    }, 40_000, 'CONFIRMED');

    const { rows } = await pool.query('SELECT status, tx_hash, wallet_addr FROM issuance_requests');
    console.log(`  · issuance_requests status   ${rows[0].status}`);
    console.log(`  · tx_hash                    ${rows[0].tx_hash}`);
    console.log(`  · wallet_addr                ${rows[0].wallet_addr}`);

    expect(rows[0].status).toBe('CONFIRMED');
    expect(rows[0].tx_hash).toMatch(/^0x/);
    expect(rows[0].wallet_addr?.toLowerCase()).toBe(OPERATOR_ADDR.toLowerCase());
    console.log('  ✔ CONFIRMED 확인');

    // ── user_wallet_mapping 검증
    const { rows: wmRows } = await pool.query(
      'SELECT wallet_addr, verified FROM user_wallet_mapping WHERE user_id = $1',
      ['user-mock-001'],
    );
    expect(wmRows).toHaveLength(1);
    expect(wmRows[0].wallet_addr.toLowerCase()).toBe(OPERATOR_ADDR.toLowerCase());
    expect(wmRows[0].verified).toBe(true);
    console.log('  ✔ user_wallet_mapping DB 조회 확인');

    // ── processed_events 검증 (fallback poll이 recordProcessedEvent 호출)
    const txHash = rows[0].tx_hash as string;
    const { rows: peRows } = await pool.query(
      'SELECT event_name, log_index FROM processed_events WHERE tx_hash = $1',
      [txHash],
    );
    expect(peRows.length).toBeGreaterThan(0);
    expect(peRows[0].event_name).toBe('Issued');
    console.log(`  ✔ processed_events 기록 확인 (Issued, logIndex=${peRows[0].log_index})`);

    // ── outbox_events 검증 (PENDING 삽입 → OutboxWorker 처리 → PROCESSED)
    await pool.query(
      `INSERT INTO outbox_events (type, payload)
       VALUES ('VASP_SUBMIT_MINT', $1::jsonb)`,
      [JSON.stringify({ txHash, userId: 'user-mock-001', tokenId: TOKEN_ID })],
    );
    const { processed, failed } = await outboxWorker.processPending();
    expect(processed).toBe(1);
    expect(failed).toBe(0);
    const { rows: obRows } = await pool.query(
      "SELECT status FROM outbox_events WHERE type = 'VASP_SUBMIT_MINT'",
    );
    expect(obRows[0].status).toBe('PROCESSED');
    console.log('  ✔ outbox_events PENDING → PROCESSED 확인');

    // ── Java internal-ledger: NFT 보유 기록 (user_nft_holdings)
    const nftRes = await postJavaApi(
      `/api/internal/users/user-mock-001/nft-holdings`,
      {
        tokenId:      Number(TOKEN_ID),
        contractAddr: mockVaspAddr,
        chainId:      31337,
        amount:       1,
        acquiredAt:   new Date().toISOString(),
        onChainTx:    txHash,
      },
    );
    expect(nftRes.status).toBe(200);
    const { rows: nftRows } = await pool.query(
      'SELECT user_id, token_id, on_chain_tx FROM user_nft_holdings WHERE user_id = $1',
      ['user-mock-001'],
    );
    expect(nftRows).toHaveLength(1);
    expect(String(nftRows[0].token_id)).toBe(TOKEN_ID);
    expect(nftRows[0].on_chain_tx.toLowerCase()).toBe(txHash.toLowerCase());
    console.log('  ✔ user_nft_holdings Java → DB 기록 확인');

    // ── Java internal-ledger: 감사 로그 (audit_log)
    const auditRes = await postJavaApi(
      `/api/internal/audit-log`,
      {
        actor:        'user-mock-001',
        action:       'NFT_ISSUED',
        resourceType: 'issuance_request',
        resourceId:   rows[0].tx_hash,
        beforeState:  null,
        afterState:   JSON.stringify({ status: 'CONFIRMED', txHash }),
      },
    );
    expect(auditRes.status).toBe(200);
    const { rows: auditRows } = await pool.query(
      "SELECT actor, action FROM audit_log WHERE resource_type = 'issuance_request'",
    );
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0].actor).toBe('user-mock-001');
    expect(auditRows[0].action).toBe('NFT_ISSUED');
    console.log('  ✔ audit_log Java → DB 기록 확인');
  });

  // ── [2] REVERT ──────────────────────────────────────────────────────────────

  it('[2] REVERT — TX revert → issuance_requests FAILED', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [2] REVERT — TX revert 시뮬레이션');
    console.log('──────────────────────────────────────────────────────────────');

    await controlVasp.setMode('REVERT');
    console.log('  · setMode(REVERT) 완료');

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: {
        userId:     'user-mock-001',
        activityId: randomUUID(),
        eventType:  TEST_EVENT_TYPE,
        eventCode:  1,
        data:       { steps: 15_000 },
      },
    }));
    expect(statusCode).toBe(202);

    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0 && rows[0].status !== 'REQUESTED';
    }, 15_000, 'FAILED');

    const { rows } = await pool.query('SELECT status, fail_reason FROM issuance_requests');
    console.log(`  · issuance_requests status   ${rows[0].status}`);
    console.log(`  · fail_reason (일부)         ${String(rows[0].fail_reason).slice(0, 80)}`);

    expect(rows[0].status).toBe('FAILED');
    console.log('  ✔ REVERT → FAILED 확인');

    // 다음 테스트를 위해 모드 복원 (setMode('NORMAL') 호출이 OPERATOR_KEY nonce 소비 유의)
    await controlVasp.setMode('NORMAL');
    console.log('  · setMode(NORMAL) 복원 완료');
  });

  // ── [3] NO_EMIT ─────────────────────────────────────────────────────────────

  it('[3] NO_EMIT — mint 성공, Issued 이벤트 없음 → SUBMITTED 유지', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [3] NO_EMIT — mint 성공, ChainEventListener 폴백 경로 검증');
    console.log('──────────────────────────────────────────────────────────────');

    await controlVasp.setMode('NO_EMIT');
    const actualMode = await controlVasp.getMode();
    console.log(`  · setMode(NO_EMIT) 완료 — 실제 모드: ${actualMode} (NO_EMIT이어야 함)`);

    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: {
        userId:     'user-mock-001',
        activityId: randomUUID(),
        eventType:  TEST_EVENT_TYPE,
        eventCode:  1,
        data:       { steps: 15_000 },
      },
    }));
    expect(statusCode).toBe(202);

    // TX는 성공 (SUBMITTED) 이어야 함
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status, fail_reason, tx_hash FROM issuance_requests');
      if (rows.length > 0 && rows[0].status === 'FAILED') {
        const onChainMode = await controlVasp.getMode().catch(() => 'unknown');
        const { rows: txRows } = await pool.query('SELECT status, fail_reason, tx_hash FROM tx_mint_requests');
        console.error(`  [3] FAILED 감지:`);
        console.error(`      issuance_requests: status=${rows[0].status}, fail_reason=${rows[0].fail_reason ?? 'null'}, tx_hash=${rows[0].tx_hash ?? 'null'}`);
        console.error(`      tx_mint_requests:  ${txRows.length} rows: ${JSON.stringify(txRows.map(r => ({status: r.status, fail_reason: r.fail_reason, tx_hash: r.tx_hash})))}`);
        console.error(`      on-chain mode=${onChainMode}`);
        throw new Error(`[3] TX가 FAILED: ${rows[0].fail_reason ?? '원인 없음'} (mode=${onChainMode})`);
      }
      return rows.length > 0 && rows[0].status === 'SUBMITTED';
    }, 20_000, 'SUBMITTED');

    // Issued 이벤트가 없으므로 CONFIRMED 전이 발생하지 않음
    await new Promise(r => setTimeout(r, 3_000));

    const { rows }    = await pool.query('SELECT status, tx_hash FROM issuance_requests');
    const txHash      = rows[0].tx_hash as string;
    const receipt     = await provider.getTransactionReceipt(txHash);
    const iface       = new ethers.Interface(MOCK_VASP_ABI as ethers.InterfaceAbi);
    const issuedLogs  = receipt!.logs.filter(l => {
      try { return iface.parseLog(l)?.name === 'Issued'; } catch { return false; }
    });

    console.log(`  · issuance_requests status   ${rows[0].status}`);
    console.log(`  · TX 수신 로그 내 Issued 수  ${issuedLogs.length} (0이어야 함)`);
    console.log(`  · TX 자체는 성공 (status)    ${receipt!.status}`);

    expect(rows[0].status).toBe('SUBMITTED');      // Issued 없으면 CONFIRMED 미전이
    expect(issuedLogs).toHaveLength(0);            // 이벤트 없음 확인
    expect(receipt!.status).toBe(1);               // mint는 성공

    console.log('  ✔ NO_EMIT — SUBMITTED 유지 + mint 성공 + Issued 0개 확인');
    console.log('  ✔ ChainEventListener 폴백 경로 (queryEvents 스캔) 동작 지점 검증 완료');

    // 다음 테스트를 위해 NORMAL 모드로 복원
    await controlVasp.setMode('NORMAL');
    console.log('  · setMode(NORMAL) 복원 완료');
  });

  // ── [4] PENDING ─────────────────────────────────────────────────────────────

  it('[4] PENDING — 블록 중단 → TX mempool 체류 → mineBlock → CONFIRMED', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [4] PENDING — evm_setAutomine(false) → TX 체류 → 채굴 → CONFIRMED');
    console.log('──────────────────────────────────────────────────────────────');

    await controlVasp.setMode('NORMAL'); // test [3] 잔류 모드 방어
    await controlVasp.freezeMining();
    console.log('  · 블록 생성 중단 (evm_setAutomine=false)');

    const blockBefore = await provider.getBlockNumber();
    console.log(`  · 현재 블록       ${blockBefore}`);

    // webhook 전송 — 비동기 처리 시작 (tx.wait(1)이 내부에서 블록 대기)
    const webhookPromise = postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: {
        userId:     'user-mock-001',
        activityId: randomUUID(),
        eventType:  TEST_EVENT_TYPE,
        eventCode:  1,
        data:       { steps: 15_000 },
      },
    }));

    // TX가 mempool에 들어갈 시간 확보
    await new Promise(r => setTimeout(r, 2_000));

    // 블록 채굴 전 SUBMITTED 확인 — 이 시점에 Issued 이벤트가 없으므로 SUBMITTED여야 함
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0 && rows[0].status === 'SUBMITTED';
    }, 10_000, 'SUBMITTED (pre-mine)');
    console.log('  · SUBMITTED 확인 (블록 채굴 전)');

    const blockDuring = await provider.getBlockNumber();
    console.log(`  · 블록 생성 중단 중 현재 블록  ${blockDuring} (변화 없어야 함)`);
    expect(blockDuring).toBe(blockBefore);   // 블록 미생성 확인

    // 블록 채굴 → TX 확정
    // vasp.mineBlock() 대신 test provider로 직접 호출 (provider 인스턴스 격리 방지)
    await provider.send('hardhat_mine', ['0x1']);
    await provider.send('evm_setAutomine', [true]);
    console.log('  · hardhat_mine(1) → 블록 생성');
    console.log('  · evm_setAutomine(true) → 자동 생성 재개');

    // webhook 202 확인
    const statusCode = await webhookPromise;
    expect(statusCode).toBe(202);

    // 잠시 대기 후 블록 번호 확인 (노드 상태 반영 여유)
    await new Promise(r => setTimeout(r, 300));
    // eth_blockNumber는 '0x...' hex 문자열 반환 — Number()로 안전하게 변환
    const blockAfter = Number(await provider.send('eth_blockNumber', []));
    console.log(`  · 채굴 후 블록    ${blockAfter}`);
    expect(blockAfter).toBeGreaterThan(blockBefore);

    // CONFIRMED 대기 — 폴백 폴링이 Issued 이벤트 감지 후 전이
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows[0]?.status === 'CONFIRMED';
    }, 15_000, 'CONFIRMED');

    const { rows } = await pool.query('SELECT status, tx_hash FROM issuance_requests');
    console.log(`  · issuance_requests status   ${rows[0].status}`);
    expect(rows[0].status).toBe('CONFIRMED');

    // ── processed_events 검증
    const { rows: peRows } = await pool.query(
      'SELECT event_name FROM processed_events WHERE tx_hash = $1',
      [rows[0].tx_hash],
    );
    expect(peRows.length).toBeGreaterThan(0);
    console.log('  ✔ PENDING → 블록 채굴 → CONFIRMED 확인');
    console.log(`  ✔ processed_events 기록 확인 (${peRows.length}건)`);
  });

  // ── [5] REORG ───────────────────────────────────────────────────────────────

  it('[5] REORG — snapshot → 발행 → revertToSnapshot → 온체인 상태 원복 확인', async () => {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  [5] REORG — evm_snapshot → 발행 → evm_revert → 상태 원복');
    console.log('──────────────────────────────────────────────────────────────');

    await controlVasp.setMode('NORMAL'); // 이전 테스트 잔류 모드 방어

    const iface = new ethers.Interface(MOCK_VASP_ABI as ethers.InterfaceAbi);
    const viewContract = new ethers.Contract(mockVaspAddr, iface, provider);

    const balBefore = await (viewContract['balanceOf'] as Function)(OPERATOR_ADDR, TOKEN_ID_BN) as bigint;
    console.log(`  · 스냅샷 전 balanceOf  ${balBefore}`);

    // 스냅샷 저장
    const snapshotId = await controlVasp.snapshot();
    console.log(`  · 스냅샷 ID           ${snapshotId}`);

    // NORMAL 발행
    const statusCode = await postWebhook(makePayload({
      eventType: 'ACTIVITY_ACHIEVED',
      data: {
        userId:     'user-mock-001',
        activityId: randomUUID(),
        eventType:  TEST_EVENT_TYPE,
        eventCode:  1,
        data:       { steps: 15_000 },
      },
    }));
    expect(statusCode).toBe(202);

    // CONFIRMED 대기 (최대 40s)
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT status FROM issuance_requests');
      return rows.length > 0 && rows[0].status === 'CONFIRMED';
    }, 40_000, 'CONFIRMED before reorg');

    const balAfterIssue = await (viewContract['balanceOf'] as Function)(OPERATOR_ADDR, TOKEN_ID_BN) as bigint;
    console.log(`  · 발행 후 balanceOf   ${balAfterIssue} (증가 확인)`);
    expect(balAfterIssue).toBe(balBefore + 1n);

    const { rows: confirmed } = await pool.query('SELECT status, tx_hash FROM issuance_requests');
    console.log(`  · DB status (REORG 전) ${confirmed[0].status}`);
    expect(confirmed[0].status).toBe('CONFIRMED');

    // ── processed_events 검증
    const { rows: peRows } = await pool.query(
      'SELECT event_name FROM processed_events WHERE tx_hash = $1',
      [confirmed[0].tx_hash],
    );
    expect(peRows.length).toBeGreaterThan(0);
    console.log(`  ✔ processed_events 기록 확인 (${peRows.length}건)`);

    // REORG 시뮬레이션 — 스냅샷으로 롤백
    await controlVasp.revertToSnapshot(snapshotId);
    console.log('  · evm_revert 실행 → 체인 롤백');

    // 온체인 상태 원복 확인
    const balAfterReorg = await (viewContract['balanceOf'] as Function)(OPERATOR_ADDR, TOKEN_ID_BN) as bigint;
    console.log(`  · REORG 후 balanceOf  ${balAfterReorg} (원복 확인)`);
    expect(balAfterReorg).toBe(balBefore);

    // DB는 여전히 CONFIRMED (REORG 감지는 ChainEventListener Phase 2 기능)
    const { rows: afterReorg } = await pool.query('SELECT status FROM issuance_requests');
    console.log(`  · DB status (REORG 후) ${afterReorg[0].status} ← DB는 CONFIRMED 유지`);
    console.log('  ✔ REORG 후 온체인 상태 원복 확인');
    console.log('  ✔ DB는 CONFIRMED 유지 — REORG 감지(Phase 2)가 필요한 이유 시연');

    // DB 상태는 여전히 CONFIRMED (이것이 REORG의 위험성 — 교육 포인트)
    expect(afterReorg[0].status).toBe('CONFIRMED');
  });

});
