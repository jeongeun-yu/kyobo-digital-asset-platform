/**
 * local-demo/start-sepolia.ts — issuer-service Sepolia 풀 파이프라인 데모
 *
 * 실행: npm run demo:start-sepolia   (internal/integration/)
 *
 * 사전 조건:
 *   1. local-demo/.env.sepolia 파일에 환경변수 기입 (OPERATOR 계정에 Sepolia ETH 필요)
 *   2. OPERATOR 계정에 Sepolia ETH 충분 (MockVASP 배포 가스비 포함)
 *
 * 기동 순서:
 *   1. Docker 네트워크 생성 (kyobo-sepolia-net) + 기존 컨테이너 정리
 *   2. Docker — PostgreSQL(15432) + Redis(16379)
 *   3. DB 스키마 적용 + 시드
 *   4. MockVASP 컨트랙트 배포 (Sepolia) + .env SEPOLIA_MOCK_VASP_ADDR 자동 업데이트
 *   5. Java internal-ledger 컨테이너 기동 (19875) — 실제 원장 서비스
 *   6. 현재 Sepolia 블록 번호 조회 (CHAIN_START_BLOCK)
 *   7. VASPServer 기동 (19876) — Sepolia RPC + 신규 배포 MockVASP 주소
 *   8. Redis Stream + Consumer Group 초기화
 *   9. issuer-service 기동 (WebhookServer :19877)
 *  10. READY 배너 출력 (블록 확정 ~12s 안내)
 *
 * 종료: Ctrl+C → 컨테이너 자동 정리
 */

import { execSync, spawn }          from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve }                   from 'path';
import http                 from 'http';
import dotenv               from 'dotenv';
import { Pool }             from 'pg';
import Redis                from 'ioredis';
import { VASPServer }       from '../vasp-testing/VASPServer';

// ── 루트 .env 로드 ────────────────────────────────────────────────────────────

const ENV_PATH = resolve(__dirname, '..', '..', '..', '.env');
dotenv.config({ path: ENV_PATH });

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`환경변수 미설정: ${key}  (루트 .env 확인: ${ENV_PATH})`);
  return val;
}

const SEPOLIA_RPC_URL      = requireEnv('SEPOLIA_RPC_URL');
const OPERATOR_PRIVATE_KEY = requireEnv('SEPOLIA_OPERATOR_KEY');
// DEPLOYER_PRIVATE_KEY — setMode 제어용
const DEPLOYER_PRIVATE_KEY = process.env['DEPLOYER_PRIVATE_KEY'] ?? OPERATOR_PRIVATE_KEY;

// ── 상수 ──────────────────────────────────────────────────────────────────────

const PG_PORT        = 15432;
const REDIS_PORT     = 16379;
const JAVA_PORT      = 19875;
const VASP_PORT      = 19876;
const WEBHOOK_PORT   = 19877;
const ADMIN_PORT     = 19870;
const CHAIN_ID       = 11155111; // Sepolia

const WEBHOOK_SECRET   = 'sepolia-demo-webhook-secret-32ch!!';
const CORE_BANKING_SEC = 'sepolia-demo-internal-secret';
const VASP_API_KEY     = 'sepolia-demo-vasp-key';
const DEMO_USER_ID     = 'demo-user-001';
const TEST_EVENT_TYPE  = 'WALK_GOAL_MET';
// Sepolia 고정 컨트랙트 — 이전 실행 잔액과 충돌하지 않도록 실행마다 고유 TOKEN_ID 사용
const TOKEN_ID         = String(Date.now());

const PG_URL    = `postgresql://postgres:demo@localhost:${PG_PORT}/postgres`;
const REDIS_URL = `redis://localhost:${REDIS_PORT}`;

// Sepolia에서 OPERATOR 지갑 주소 추출
function deriveAddress(privateKey: string): string {
  const { ethers } = require('ethers') as typeof import('ethers');
  return new ethers.Wallet(privateKey).address;
}
const OPERATOR_ADDR = deriveAddress(OPERATOR_PRIVATE_KEY);

// demo-user-001~005 수신 지갑 — OPERATOR 키 해시 파생 EOA
// Hardhat 결정적 주소는 Sepolia에 컨트랙트가 배포되어 있을 수 있어
// ERC1155InvalidReceiver revert 발생 → OPERATOR 키 기반 파생 주소 사용
function deriveDemoWallet(index: number): string {
  const { ethers } = require('ethers') as typeof import('ethers');
  const key = OPERATOR_PRIVATE_KEY.startsWith('0x') ? OPERATOR_PRIVATE_KEY : `0x${OPERATOR_PRIVATE_KEY}`;
  const hash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256'],
      [key, index],
    ),
  );
  return new ethers.Wallet(hash).address;
}

const DEMO_WALLETS = [
  OPERATOR_ADDR,           // demo-user-001 (OPERATOR 본인)
  deriveDemoWallet(2),     // demo-user-002
  deriveDemoWallet(3),     // demo-user-003
  deriveDemoWallet(4),     // demo-user-004
  deriveDemoWallet(5),     // demo-user-005
];

const NETWORK_NAME = 'kyobo-sepolia-net';
const CONTAINERS   = ['kyobo-sepolia-postgres', 'kyobo-sepolia-redis', 'kyobo-sepolia-java'];
const DEMO_PORTS   = [PG_PORT, REDIS_PORT];
const SCHEMA_PATH  = resolve(__dirname, '..', 'setup', 'schema.sql');
const INDEX_PATH   = resolve(__dirname, '..', '..', 'apps', 'issuer-service', 'src', 'index.ts');
const ARTIFACT_PATH = resolve(
  __dirname, '..', '..', '..', 'blockchain',
  'artifacts', 'src', 'mocks', 'MockVASP.sol', 'MockVASP.json',
);

// ── .env 단일 키 업데이트 ─────────────────────────────────────────────────────
function updateEnvKey(key: string, value: string): void {
  const content = readFileSync(ENV_PATH, 'utf-8');
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const updated = content.match(new RegExp(`^${key}=`, 'm'))
    ? content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
    : content + `\n${key}=${value}`;
  writeFileSync(ENV_PATH, updated, 'utf-8');
  console.log(`  [.env] ${key} → ${value}`);
}

// ── MockVASP 배포 (Sepolia) ───────────────────────────────────────────────────
async function deployMockVASP(): Promise<string> {
  const { ethers } = await import('ethers');
  const artifact   = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8'));
  const provider   = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const deployer   = new ethers.NonceManager(new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider));
  const factory    = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);

  console.log('  [deploy] MockVASP 배포 중 (Sepolia TX 브로드캐스트)...');
  const contract = await factory.deploy(OPERATOR_ADDR);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();

  console.log(`  [deploy] MockVASP → ${addr}`);
  updateEnvKey('SEPOLIA_MOCK_VASP_ADDR', addr);
  return addr;
}

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


// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== kyobo issuer-service Sepolia 시나리오 데모 시작 ===\n');
  console.log(`  네트워크     : Sepolia (chainId=${CHAIN_ID})`);
  console.log(`  RPC          : ${SEPOLIA_RPC_URL.slice(0, 50)}…`);
  console.log(`  OPERATOR     : ${OPERATOR_ADDR}`);
  console.log(`  TOKEN_ID     : ${TOKEN_ID}  (실행마다 고유 — 이전 잔액 충돌 방지)\n`);

  // ── 1. 기존 컨테이너 + 네트워크 정리 ─────────────────────────────────────────
  console.log('[1] 기존 컨테이너 정리...');
  for (const c of CONTAINERS) dockerStop(c);
  for (const p of DEMO_PORTS) freePort(p);
  dockerNetworkRemove(NETWORK_NAME);
  dockerNetworkEnsure(NETWORK_NAME);

  // ── 2. Docker 인프라 기동 (PostgreSQL + Redis — Hardhat 없음) ────────────────
  console.log('[2] Docker 인프라 기동 (PostgreSQL + Redis)...');
  dockerRun('kyobo-sepolia-postgres', 'postgres:16-alpine', `${PG_PORT}:5432`,
    ['POSTGRES_PASSWORD=demo', 'POSTGRES_DB=postgres'], NETWORK_NAME);
  dockerRun('kyobo-sepolia-redis', 'redis:7-alpine', `${REDIS_PORT}:6379`, [], NETWORK_NAME);

  await waitPort('localhost', PG_PORT,    'PostgreSQL');
  await waitPort('localhost', REDIS_PORT, 'Redis');

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
       VALUES ($1, $2, 'SEPOLIA', true) ON CONFLICT (user_id) DO NOTHING`,
      [`demo-user-${String(i).padStart(3, '0')}`, DEMO_WALLETS[i - 1]],
    );
  }
  await pool.end();
  console.log('  [db] issuance_policies + user_wallet_mapping 시드 완료');

  // ── 4. MockVASP 배포 (Sepolia) ───────────────────────────────────────────────
  console.log('[4] MockVASP 컨트랙트 배포 (Sepolia)...');
  const mockVaspAddr = await deployMockVASP();
  console.log(`  [info] SEPOLIA_MOCK_VASP_ADDR .env 자동 업데이트 완료`);

  // ── 5. Java internal-ledger 컨테이너 기동 ─────────────────────────────────────
  console.log('[5] Java internal-ledger 기동...');
  const demoUsersEnv = DEMO_WALLETS.map((w, i) =>
    `demo-user-${String(i + 1).padStart(3, '0')}:${w}`,
  ).join(',');
  dockerRun(
    'kyobo-sepolia-java',
    'kyobo/internal-ledger:test',
    `${JAVA_PORT}:8080`,
    [
      `DB_URL=jdbc:postgresql://kyobo-sepolia-postgres:5432/postgres`,
      `DB_USERNAME=postgres`,
      `DB_PASSWORD=demo`,
      `DEMO_MODE=true`,
      `DEMO_USERS=${demoUsersEnv}`,
      `CORE_BANKING_URL=http://localhost:9090`,
    ],
    NETWORK_NAME,
  );
  await waitHttp(`http://localhost:${JAVA_PORT}/api/internal/health`, 'Java internal-ledger', 60_000);

  // ── 6. 현재 Sepolia 블록 번호 조회 (CHAIN_START_BLOCK 주입용) ─────────────────
  // Alchemy 무료 플랜은 eth_getLogs 범위가 10블록으로 제한됨.
  // getLastProcessedBlock()이 0을 반환하면 genesis부터 조회해 에러 발생.
  // 현재 블록부터 구독 시작하도록 CHAIN_START_BLOCK을 주입한다.
  const { ethers: _ethers } = await import('ethers');
  const _provider = new _ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const chainStartBlock = await _provider.getBlockNumber();
  await (_provider as any).destroy?.();
  console.log(`  [sepolia] 현재 블록: ${chainStartBlock} → CHAIN_START_BLOCK 설정`);

  // ── 7. VASPServer 기동 (Sepolia RPC + 신규 배포 MockVASP) ────────────────────
  console.log('[7] VASPServer 기동 (Sepolia)...');
  console.log('  [info] Sepolia 블록 확정 ~12s — TX 제출 후 잠시 대기 필요');
  const vaspServer = new VASPServer({
    port:            VASP_PORT,
    rpcUrl:          SEPOLIA_RPC_URL,
    signerKey:       OPERATOR_PRIVATE_KEY,
    contractAddr:    mockVaspAddr,
    callbackUrl:     `http://localhost:${WEBHOOK_PORT}`,
    callbackSecret:  WEBHOOK_SECRET,
    pollingInterval: 4000,
  });
  await vaspServer.start();

  // ── 8. Redis Stream + Consumer Group 초기화 ─────────────────────────────────
  console.log('[8] Redis Stream 초기화...');
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

  // ── 9. issuer-service 기동 (Sepolia 환경변수) ───────────────────────────────
  console.log('[9] issuer-service 기동...');
  const env = {
    ...process.env,
    RPC_URL:              SEPOLIA_RPC_URL,
    CHAIN_ID:             String(CHAIN_ID),
    OPERATOR_PRIVATE_KEY,
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
    CHAIN_START_BLOCK:    String(chainStartBlock),
  };

  const issuerProc = spawn(
    'npx', ['ts-node', '--project', 'tsconfig.json', INDEX_PATH],
    { env, cwd: resolve(__dirname, '..'), stdio: 'inherit', shell: true },
  );
  issuerProc.on('error', err => console.error('[issuer-service] spawn error:', err));

  // ── 10. 준비 대기 + 배너 ────────────────────────────────────────────────────
  await waitPort('localhost', WEBHOOK_PORT, 'WebhookServer');
  await new Promise(r => setTimeout(r, 500));

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║       issuer-service Sepolia 시나리오 데모 준비 완료            ║
╠═══════════════════════════════════════════════════════════════╣
║  네트워크       : Ethereum Sepolia (chainId=11155111)          ║
║  MockVASP       : ${mockVaspAddr.slice(0, 42).padEnd(42)}  ║
║  OPERATOR       : ${OPERATOR_ADDR.slice(0, 42).padEnd(42)}  ║
╠═══════════════════════════════════════════════════════════════╣
║  WebhookServer  : http://localhost:${WEBHOOK_PORT}               ║
║  VASPServer     : http://localhost:${VASP_PORT}               ║
║  Java ledger    : http://localhost:${JAVA_PORT}               ║
╠═══════════════════════════════════════════════════════════════╣
║  ⚠  Sepolia 블록 확정 ~12s — NFT_ISSUED 콜백까지 대기 필요   ║
╠═══════════════════════════════════════════════════════════════╣
║  발행 요청 보내기:                                              ║
║  npm run demo:issue-sepolia                                   ║
╚═══════════════════════════════════════════════════════════════╝
`);

  // ── 11. DB 상태 폴러 (5초마다 현재 파이프라인 상태 출력) ────────────────────
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

      console.log('\n─── DB 상태 스냅샷 (Sepolia) ───────────────────────────────────');
      for (const r of issuance.rows) {
        console.log(`  [issuance_requests]  status=${r.status.padEnd(10)}  tx=${(r.tx_hash ?? 'null').slice(0, 12)}…  user=${r.user_id}`);
        if (r.fail_reason) console.log(`                       fail_reason=${r.fail_reason}`);
      }
      for (const r of mint.rows)     console.log(`  [mint_requests]      status=${r.status.padEnd(10)}  tx=${(r.tx_hash ?? 'null').slice(0, 12)}…`);
      for (const r of tx.rows)       console.log(`  [tx_mint_requests]   status=${r.status.padEnd(10)}  tx=${(r.tx_hash ?? 'null').slice(0, 12)}…`);
      for (const r of holdings.rows) console.log(`  [user_nft_holdings]  userId=${r.user_id}  tokenId=${r.token_id}  amount=${r.amount}  tx=${String(r.on_chain_tx).slice(0, 12)}…`);
      for (const r of auditLog.rows) console.log(`  [audit_log]          actor=${r.actor}  action=${r.action}  ${r.resource_type}/${String(r.resource_id).slice(0, 10)}…  checksum=${String(r.checksum).slice(0, 12)}…  chained=${r.prev_checksum ? 'Y' : 'N(first)'}`);
      console.log('─────────────────────────────────────────────────────────────────\n');
    } catch {}
  }, 5000);

  // ── 12. 종료 핸들링 ─────────────────────────────────────────────────────────
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
