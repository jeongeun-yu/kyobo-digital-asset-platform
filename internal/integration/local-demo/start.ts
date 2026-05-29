/**
 * local-demo/start.ts — issuer-service 로컬 풀 파이프라인 데모
 *
 * 실행: npm run demo:start   (internal/integration/)
 *
 * 기동 순서:
 *   1. Docker 네트워크 생성 (kyobo-demo-net)
 *   2. Docker — Hardhat(8545) + PostgreSQL(15432) + Redis(16379)
 *   3. DB 스키마 적용 + 시드 데이터 삽입
 *   4. MockVASP 컨트랙트 배포 (Hardhat)
 *   5. Java internal-ledger 컨테이너 기동 (19875) — 실제 DB 쓰기
 *   6. VASPServer 기동 (19876)
 *   7. Redis Stream + Consumer Group 초기화
 *   8. issuer-service 기동 (WebhookServer :19877)
 *   9. READY 배너 출력
 *
 * 종료: Ctrl+C → 컨테이너·네트워크 자동 정리
 */

import { execSync, spawn } from 'child_process';
import { readFileSync }    from 'fs';
import { resolve }         from 'path';
import http                from 'http';
import { Pool }            from 'pg';
import Redis               from 'ioredis';
import { ethers }          from 'ethers';
import { VASPServer }      from '../vasp-testing/VASPServer';

// ── 상수 ──────────────────────────────────────────────────────────────────────

const HARDHAT_PORT   = 8545;
const PG_PORT        = 15432;
const REDIS_PORT     = 16379;
const JAVA_PORT      = 19875;
const VASP_PORT      = 19876;
const WEBHOOK_PORT   = 19877;
const ADMIN_PORT     = 19870;

const DEPLOYER_KEY  = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OPERATOR_KEY  = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DEPLOYER_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OPERATOR_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// Hardhat 계정 1~5 — demo-user-001~005 에 1:1 매핑
const DEMO_WALLETS = [
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // demo-user-001
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', // demo-user-002
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906', // demo-user-003
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', // demo-user-004
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc', // demo-user-005
];

const WEBHOOK_SECRET   = 'local-demo-webhook-secret-32ch!!';
const CORE_BANKING_SEC = 'local-demo-internal-secret';
const VASP_API_KEY     = 'local-demo-vasp-key';
const TEST_EVENT_TYPE  = 'WALK_GOAL_MET';
const TOKEN_ID         = '1001';

const RPC_URL   = `http://localhost:${HARDHAT_PORT}`;
const PG_URL    = `postgresql://postgres:demo@localhost:${PG_PORT}/postgres`;
const REDIS_URL = `redis://localhost:${REDIS_PORT}`;

const BLOCKCHAIN_DIR = resolve(__dirname, '..', '..', '..', 'blockchain');
const ARTIFACT_PATH  = resolve(BLOCKCHAIN_DIR, 'artifacts', 'src', 'mocks', 'MockVASP.sol', 'MockVASP.json');
const SCHEMA_PATH    = resolve(__dirname, '..', 'setup', 'schema.sql');
const INDEX_PATH     = resolve(__dirname, '..', '..', 'apps', 'issuer-service', 'src', 'index.ts');

const NETWORK_NAME = 'kyobo-demo-net';
const CONTAINERS   = ['kyobo-demo-hardhat', 'kyobo-demo-postgres', 'kyobo-demo-redis', 'kyobo-demo-java'];
const DEMO_PORTS   = [HARDHAT_PORT, PG_PORT, REDIS_PORT];

// ── Docker 유틸 ───────────────────────────────────────────────────────────────

function dockerNetworkEnsure(name: string): void {
  try { execSync(`docker network create ${name}`, { stdio: 'pipe' }); } catch {}
}

function dockerNetworkRemove(name: string): void {
  try { execSync(`docker network rm ${name}`, { stdio: 'pipe' }); } catch {}
}

function dockerRun(name: string, image: string, portMap: string, envArgs: string[], network?: string): void {
  const envStr = envArgs.map(e => `-e "${e}"`).join(' ');
  const netStr = network ? `--network ${network}` : '';
  execSync(`docker run -d --rm --name ${name} -p ${portMap} ${envStr} ${netStr} ${image}`, { stdio: 'pipe' });
  console.log(`  [docker] ${name} 기동 (${image})`);
}

function dockerStop(name: string): void {
  try { execSync(`docker stop ${name}`, { stdio: 'pipe' }); } catch {}
}

function freePort(port: number): void {
  try {
    const ids = execSync(`docker ps -q --filter publish=${port}`, { stdio: 'pipe' }).toString().trim();
    if (ids) {
      execSync(`docker stop ${ids.replace(/\n/g, ' ')}`, { stdio: 'pipe' });
      console.log(`  [docker] 포트 ${port} 점유 컨테이너 종료`);
    }
  } catch {}
}

async function waitPort(host: string, port: number, label: string, maxMs = 30_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = require('net').createConnection(port, host);
        s.on('connect', () => { s.destroy(); resolve(); });
        s.on('error', reject);
      });
      console.log(`  [ready] ${label} :${port}`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`Timeout waiting for ${label} :${port}`);
}

async function waitForRpc(url: string, label: string, maxMs = 60_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 });
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => { res.resume(); res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)); });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      console.log(`  [ready] ${label} RPC`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`Timeout waiting for ${label} RPC`);
}

async function waitHttp(url: string, label: string, maxMs = 60_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        http.get(url, res => {
          if (res.statusCode === 200) { res.resume(); resolve(); }
          else { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); }
        }).on('error', reject);
      });
      console.log(`  [ready] ${label}`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(`Timeout waiting for ${label}`);
}

// ── MockVASP 배포 ─────────────────────────────────────────────────────────────

async function deployMockVASP(): Promise<string> {
  const artifact    = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8'));
  const provider    = new ethers.JsonRpcProvider(RPC_URL);
  const deployerRaw = new ethers.Wallet(DEPLOYER_KEY, provider);
  const deployer    = new ethers.NonceManager(deployerRaw);
  const factory     = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const contract    = await factory.deploy(OPERATOR_ADDR);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();

  const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes('OPERATOR_ROLE'));
  const mockVasp = new ethers.Contract(addr, artifact.abi, deployer);
  await (await (mockVasp['grantRole'] as Function)(OPERATOR_ROLE, DEPLOYER_ADDR)).wait();

  console.log(`  [deploy] MockVASP → ${addr}`);
  return addr;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== kyobo issuer-service 시나리오 데모 시작 ===\n');

  // ── 1. 기존 컨테이너 + 네트워크 정리 ─────────────────────────────────────────
  console.log('[1] 기존 컨테이너 정리...');
  for (const c of CONTAINERS) dockerStop(c);
  for (const p of DEMO_PORTS) freePort(p);
  dockerNetworkRemove(NETWORK_NAME);
  dockerNetworkEnsure(NETWORK_NAME);

  // ── 2. Docker 인프라 기동 ────────────────────────────────────────────────────
  console.log('[2] Docker 인프라 기동...');
  dockerRun('kyobo-demo-hardhat',  'kyobo/hardhat-node:test', `${HARDHAT_PORT}:8545`, [], NETWORK_NAME);
  dockerRun('kyobo-demo-postgres', 'postgres:16-alpine',      `${PG_PORT}:5432`,
    ['POSTGRES_PASSWORD=demo', 'POSTGRES_DB=postgres'], NETWORK_NAME);
  dockerRun('kyobo-demo-redis',    'redis:7-alpine',          `${REDIS_PORT}:6379`, [], NETWORK_NAME);

  await waitPort('localhost', HARDHAT_PORT, 'Hardhat');
  await waitForRpc(RPC_URL, 'Hardhat');
  await waitPort('localhost', PG_PORT,      'PostgreSQL');
  await waitPort('localhost', REDIS_PORT,   'Redis');

  // ── 3. DB 스키마 + 시드 ──────────────────────────────────────────────────────
  console.log('[3] DB 스키마 적용 및 시드...');
  await new Promise(r => setTimeout(r, 1000));
  const pool = new Pool({ connectionString: PG_URL });
  await pool.query(readFileSync(SCHEMA_PATH, 'utf-8'));
  await pool.query(
    `INSERT INTO issuance_policies (event_type, token_id, amount)
     VALUES ($1, $2, 1) ON CONFLICT (event_type) DO NOTHING`,
    [TEST_EVENT_TYPE, TOKEN_ID],
  );
  for (let i = 1; i <= 5; i++) {
    await pool.query(
      `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
       VALUES ($1, $2, 'ANVIL', true) ON CONFLICT (user_id) DO NOTHING`,
      [`demo-user-${String(i).padStart(3, '0')}`, DEMO_WALLETS[i - 1]],
    );
  }
  await pool.end();
  console.log('  [db] issuance_policies + user_wallet_mapping 시드 완료');

  // ── 4. MockVASP 배포 ─────────────────────────────────────────────────────────
  console.log('[4] MockVASP 컨트랙트 배포...');
  const mockVaspAddr = await deployMockVASP();

  // ── 5. Java internal-ledger 컨테이너 기동 ─────────────────────────────────────
  // 실제 Java 서비스: audit_log·user_nft_holdings DB 쓰기 + SHA-256 체인 검증
  console.log('[5] Java internal-ledger 기동...');
  const demoUsersEnv = DEMO_WALLETS.map((w, i) =>
    `demo-user-${String(i + 1).padStart(3, '0')}:${w}`,
  ).join(',');
  dockerRun(
    'kyobo-demo-java',
    'kyobo/internal-ledger:test',
    `${JAVA_PORT}:8080`,
    [
      `DB_URL=jdbc:postgresql://kyobo-demo-postgres:5432/postgres`,
      `DB_USERNAME=postgres`,
      `DB_PASSWORD=demo`,
      `DEMO_MODE=true`,
      `DEMO_USERS=${demoUsersEnv}`,
      `CORE_BANKING_URL=http://localhost:9090`,
    ],
    NETWORK_NAME,
  );
  await waitHttp(`http://localhost:${JAVA_PORT}/api/internal/health`, 'Java internal-ledger', 60_000);

  // ── 6. VASPServer 기동 ───────────────────────────────────────────────────────
  console.log('[6] VASPServer 기동...');
  const vaspServer = new VASPServer({
    port:            VASP_PORT,
    rpcUrl:          RPC_URL,
    signerKey:       OPERATOR_KEY,
    contractAddr:    mockVaspAddr,
    callbackUrl:     `http://localhost:${WEBHOOK_PORT}`,
    callbackSecret:  WEBHOOK_SECRET,
    pollingInterval: 200,
  });
  await vaspServer.start();

  // ── 7. Redis Stream + Consumer Group 초기화 ─────────────────────────────────
  console.log('[7] Redis Stream 초기화...');
  const redisInit = new Redis(REDIS_URL);
  for (const group of ['nft-consumers', 'activity-consumers']) {
    try {
      await (redisInit as any).xgroup('CREATE', 'kyobo:events', group, '$', 'MKSTREAM');
      console.log(`  [redis] Consumer Group 생성: ${group}`);
    } catch (err: any) {
      if (!String(err).includes('BUSYGROUP')) throw err;
      console.log(`  [redis] Consumer Group 이미 존재: ${group}`);
    }
  }
  await redisInit.quit();

  // ── 8. issuer-service 기동 ──────────────────────────────────────────────────
  console.log('[8] issuer-service 기동...');
  const env = {
    ...process.env,
    RPC_URL,
    CHAIN_ID:             '31337',
    OPERATOR_PRIVATE_KEY: OPERATOR_KEY,
    NFT_CONTRACT_ADDR:    mockVaspAddr,
    NFT_ISSUER_ADDR:      mockVaspAddr,
    VASP_API_URL:         `http://localhost:${VASP_PORT}`,
    VASP_API_KEY,
    CORE_BANKING_URL:     `http://localhost:${JAVA_PORT}`,
    CORE_BANKING_SECRET:  CORE_BANKING_SEC,
    INTERNAL_LEDGER_URL:  `http://localhost:${JAVA_PORT}`,
    WEBHOOK_SECRET,
    WEBHOOK_PORT:         String(WEBHOOK_PORT),
    ADMIN_PORT:           String(ADMIN_PORT),
    REDIS_URL,
    DATABASE_URL:         PG_URL,
  };

  const issuerProc = spawn(
    'npx', ['ts-node', '--project', 'tsconfig.json', INDEX_PATH],
    { env, cwd: resolve(__dirname, '..'), stdio: 'inherit', shell: true },
  );
  issuerProc.on('error', err => console.error('[issuer-service] spawn error:', err));

  // ── 9. 준비 대기 + 배너 ─────────────────────────────────────────────────────
  await waitPort('localhost', WEBHOOK_PORT, 'WebhookServer');
  await new Promise(r => setTimeout(r, 500));

  console.log(`
╔══════════════════════════════════════════════════════╗
║       issuer-service 시나리오 데모 준비 완료           ║
╠══════════════════════════════════════════════════════╣
║  체인           : Hardhat 로컬 (chainId=31337)        ║
║  WebhookServer  : http://localhost:${WEBHOOK_PORT}         ║
║  VASPServer     : http://localhost:${VASP_PORT}         ║
║  Java ledger    : http://localhost:${JAVA_PORT}         ║
║  Hardhat RPC    : http://localhost:${HARDHAT_PORT}          ║
╠══════════════════════════════════════════════════════╣
║  발행 요청 보내기:                                    ║
║  npm run demo:issue                                  ║
╚══════════════════════════════════════════════════════╝
`);

  // ── 10. DB 상태 폴러 (3초마다 현재 파이프라인 상태 출력) ────────────────────
  const dbPoller = new Pool({ connectionString: PG_URL });
  let lastSnapshot = '';

  const pollInterval = setInterval(async () => {
    try {
      const [issuance, mint, tx, holdings, auditLog] = await Promise.all([
        dbPoller.query(`SELECT id, user_id, status, tx_hash, fail_reason FROM issuance_requests ORDER BY created_at DESC LIMIT 3`),
        dbPoller.query(`SELECT id, status, tx_hash FROM mint_requests ORDER BY created_at DESC LIMIT 3`),
        dbPoller.query(`SELECT id, status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3`),
        dbPoller.query(`SELECT user_id, token_id, amount, on_chain_tx FROM user_nft_holdings ORDER BY acquired_at DESC LIMIT 3`),
        dbPoller.query(`SELECT actor, action, resource_type, resource_id, checksum, prev_checksum FROM audit_log ORDER BY id DESC LIMIT 5`),
      ]);

      if (issuance.rows.length === 0) return;

      const snapshot = JSON.stringify({ issuance: issuance.rows, mint: mint.rows, tx: tx.rows, holdings: holdings.rows, auditLog: auditLog.rows });
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;

      console.log('\n─── DB 상태 스냅샷 ─────────────────────────────────────────');
      for (const r of issuance.rows) {
        console.log(`  [issuance_requests]  status=${r.status.padEnd(10)}  tx=${(r.tx_hash ?? 'null').slice(0, 12)}…  user=${r.user_id}`);
        if (r.fail_reason) console.log(`                       fail_reason=${r.fail_reason}`);
      }
      for (const r of mint.rows)     console.log(`  [mint_requests]      status=${r.status.padEnd(10)}  tx=${(r.tx_hash ?? 'null').slice(0, 12)}…`);
      for (const r of tx.rows)       console.log(`  [tx_mint_requests]   status=${r.status.padEnd(10)}  tx=${(r.tx_hash ?? 'null').slice(0, 12)}…`);
      for (const r of holdings.rows) console.log(`  [user_nft_holdings]  userId=${r.user_id}  tokenId=${r.token_id}  amount=${r.amount}  tx=${String(r.on_chain_tx).slice(0, 12)}…`);
      for (const r of auditLog.rows) console.log(`  [audit_log]          actor=${r.actor}  action=${r.action}  ${r.resource_type}/${String(r.resource_id).slice(0, 10)}…  checksum=${String(r.checksum).slice(0, 12)}…  chained=${r.prev_checksum ? 'Y' : 'N(first)'}`);
      console.log('────────────────────────────────────────────────────────────\n');
    } catch {}
  }, 3000);

  // ── 11. 종료 핸들링 ──────────────────────────────────────────────────────────
  const shutdown = async () => {
    console.log('\n[종료] 컨테이너 정리 중...');
    clearInterval(pollInterval);
    await dbPoller.end().catch(() => {});
    issuerProc.kill('SIGTERM');
    await vaspServer.stop().catch(() => {});
    for (const c of CONTAINERS) dockerStop(c);
    dockerNetworkRemove(NETWORK_NAME);
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[demo] fatal:', err);
  process.exit(1);
});
