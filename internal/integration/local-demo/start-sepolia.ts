/**
 * local-demo/start-sepolia.ts — issuer-service Sepolia 풀 파이프라인 데모
 *
 * 실행: npm run demo:start-sepolia   (internal/integration/)
 *
 * 사전 조건:
 *   1. local-demo/.env.sepolia 파일에 환경변수 기입 (OPERATOR 계정에 Sepolia ETH 필요)
 *   2. Sepolia에 MockVASP 컨트랙트가 이미 배포되어 있어야 함
 *
 * 기동 순서:
 *   1. .env.sepolia 로드 + 필수 환경변수 검증
 *   2. 기존 컨테이너 정리
 *   3. Docker — PostgreSQL(15432) + Redis(16379)
 *   4. DB 스키마 적용 + 시드
 *   5. Java API 스텁 기동 (19875)
 *   6. VASPServer 기동 (19876) — Sepolia RPC + 고정 MockVASP 주소
 *   7. Redis Stream + Consumer Group 초기화
 *   8. issuer-service 기동 (WebhookServer :19877)
 *   9. READY 배너 출력 (블록 확정 ~12s 안내)
 *
 * 종료: Ctrl+C → 컨테이너 자동 정리
 */

import { execSync, spawn }  from 'child_process';
import { readFileSync }     from 'fs';
import { resolve }          from 'path';
import http                 from 'http';
import crypto               from 'crypto';
import dotenv               from 'dotenv';
import { Pool }             from 'pg';
import Redis                from 'ioredis';
import { VASPServer }       from '../../packages/vasp/src/testing/VASPServer';

// ── 루트 .env 로드 ────────────────────────────────────────────────────────────

const ENV_PATH = resolve(__dirname, '..', '..', '..', '.env');
dotenv.config({ path: ENV_PATH });

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`환경변수 미설정: ${key}  (루트 .env 확인: ${ENV_PATH})`);
  return val;
}

const SEPOLIA_RPC_URL      = requireEnv('SEPOLIA_RPC_URL');
const MOCK_VASP_ADDR       = requireEnv('SEPOLIA_MOCK_VASP_ADDR');
const OPERATOR_PRIVATE_KEY = requireEnv('SEPOLIA_OPERATOR_KEY');
// DEPLOYER_PRIVATE_KEY — setMode 제어용
const DEPLOYER_PRIVATE_KEY = process.env['DEPLOYER_PRIVATE_KEY'] ?? OPERATOR_PRIVATE_KEY;

// ── 상수 ──────────────────────────────────────────────────────────────────────

const PG_PORT        = 15432;
const REDIS_PORT     = 16379;
const JAVA_STUB_PORT = 19875;
const VASP_PORT      = 19876;
const WEBHOOK_PORT   = 19877;
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

// Sepolia에서 OPERATOR 지갑 주소 추출 (ethers 없이 간단히 계산)
function deriveAddress(privateKey: string): string {
  const { ethers } = require('ethers') as typeof import('ethers');
  return new ethers.Wallet(privateKey).address;
}
const OPERATOR_ADDR = deriveAddress(OPERATOR_PRIVATE_KEY);

const CONTAINERS  = ['kyobo-sepolia-postgres', 'kyobo-sepolia-redis'];
const DEMO_PORTS  = [PG_PORT, REDIS_PORT];
const SCHEMA_PATH = resolve(__dirname, '..', 'setup', 'schema.sql');
const INDEX_PATH  = resolve(__dirname, '..', '..', 'apps', 'issuer-service', 'src', 'index.ts');

// ── Docker 유틸 ───────────────────────────────────────────────────────────────

function dockerRun(name: string, image: string, portMap: string, envArgs: string[]): void {
  const envStr = envArgs.map(e => `-e ${e}`).join(' ');
  execSync(`docker run -d --rm --name ${name} -p ${portMap} ${envStr} ${image}`, { stdio: 'pipe' });
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

// ── Java API 스텁 ─────────────────────────────────────────────────────────────

function startJavaStub(pool: Pool): http.Server {
  let prevChecksum: string | null = null;

  function computeChecksum(actor: string, action: string, resourceType: string, resourceId: string, afterState: string, prev: string | null): string {
    return crypto.createHash('sha256')
      .update([actor, action, resourceType, resourceId, afterState, prev ?? ''].join('|'))
      .digest('hex');
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';

    if (req.method === 'GET' && url === '/api/internal/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'UP' }));
      return;
    }

    const userMatch = url.match(/^\/api\/internal\/users\/([^/]+)$/);
    if (req.method === 'GET' && userMatch) {
      const userId = decodeURIComponent(userMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        userId,
        walletAddress: OPERATOR_ADDR,
        kycLevel:      'BASIC',
        isActive:      true,
      }));
      console.log(`  [java-stub] GET /users/${userId} → ${OPERATOR_ADDR.slice(0, 10)}…`);
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');

        if (url === '/api/internal/audit-log') {
          try {
            const p = JSON.parse(body);
            const afterState  = p.afterState  ?? '{}';
            const beforeState = p.beforeState ?? null;
            const checksum    = computeChecksum(p.actor, p.action, p.resourceType, p.resourceId, afterState, prevChecksum);

            pool.query(
              `INSERT INTO audit_log
                 (actor, action, resource_type, resource_id, before_state, after_state, prev_checksum, checksum)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [p.actor, p.action, p.resourceType, p.resourceId,
               beforeState ? JSON.parse(beforeState) : null,
               JSON.parse(afterState),
               prevChecksum, checksum],
            ).then(() => {
              prevChecksum = checksum;
              console.log(`  [java-stub] audit_log 저장  actor=${p.actor}  action=${p.action}  checksum=${checksum.slice(0, 12)}…`);
            }).catch(err => console.error('  [java-stub] audit_log 오류:', err.message));
          } catch (e) { console.error('  [java-stub] audit-log 파싱 오류:', e); }

        } else if (url.includes('/nft-holdings')) {
          try {
            const p = JSON.parse(body);
            const userIdMatch = url.match(/\/users\/([^/]+)\/nft-holdings/);
            const userId = userIdMatch ? decodeURIComponent(userIdMatch[1]) : 'unknown';

            pool.query(
              `INSERT INTO user_nft_holdings
                 (user_id, token_id, contract_addr, chain_id, amount, acquired_at, on_chain_tx)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (user_id, token_id, contract_addr, chain_id)
               DO UPDATE SET amount      = user_nft_holdings.amount + EXCLUDED.amount,
                             on_chain_tx = EXCLUDED.on_chain_tx`,
              [userId, BigInt(p.tokenId), p.contractAddr, p.chainId, p.amount, new Date(p.acquiredAt), p.onChainTx],
            ).then(() => {
              console.log(`  [java-stub] user_nft_holdings 저장  userId=${userId}  tokenId=${p.tokenId}  amount=${p.amount}  tx=${String(p.onChainTx).slice(0, 10)}…`);
            }).catch(err => console.error('  [java-stub] user_nft_holdings 오류:', err.message));
          } catch (e) { console.error('  [java-stub] nft-holdings 파싱 오류:', e); }

        } else if (url === '/api/internal/rewards/notify') {
          try {
            const p = JSON.parse(body);
            console.log(`  [java-stub] rewards/notify (no-op)  userId=${p.userId}  tokenId=${p.tokenId}`);
          } catch { console.log('  [java-stub] rewards/notify (no-op)'); }
        }
      });
      return;
    }

    res.writeHead(404).end('{}');
  });

  server.listen(JAVA_STUB_PORT, () =>
    console.log(`  [java-stub] 기동 완료 → :${JAVA_STUB_PORT}`),
  );
  return server;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== kyobo issuer-service Sepolia 데모 시작 ===\n');
  console.log(`  네트워크     : Sepolia (chainId=${CHAIN_ID})`);
  console.log(`  RPC          : ${SEPOLIA_RPC_URL.slice(0, 50)}…`);
  console.log(`  MockVASP     : ${MOCK_VASP_ADDR}`);
  console.log(`  OPERATOR     : ${OPERATOR_ADDR}`);
  console.log(`  TOKEN_ID     : ${TOKEN_ID}  (실행마다 고유 — 이전 잔액 충돌 방지)\n`);

  // ── 1. 기존 컨테이너 정리 ────────────────────────────────────────────────────
  console.log('[1] 기존 컨테이너 정리...');
  for (const c of CONTAINERS) dockerStop(c);
  for (const p of DEMO_PORTS) freePort(p);

  // ── 2. Docker 인프라 기동 (PostgreSQL + Redis만 — Hardhat 없음) ──────────────
  console.log('[2] Docker 인프라 기동 (PostgreSQL + Redis)...');
  dockerRun('kyobo-sepolia-postgres', 'postgres:16-alpine', `${PG_PORT}:5432`,
    ['POSTGRES_PASSWORD=demo', 'POSTGRES_DB=postgres']);
  dockerRun('kyobo-sepolia-redis', 'redis:7-alpine', `${REDIS_PORT}:6379`, []);

  await waitPort('localhost', PG_PORT,    'PostgreSQL');
  await waitPort('localhost', REDIS_PORT, 'Redis');

  // ── 3. DB 스키마 + 시드 ──────────────────────────────────────────────────────
  console.log('[3] DB 스키마 적용 및 시드...');
  await new Promise(r => setTimeout(r, 1000)); // PG 초기화 대기
  const pool = new Pool({ connectionString: PG_URL });
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  await pool.query(schema);
  await pool.query(
    `INSERT INTO issuance_policies (event_type, token_id, amount)
     VALUES ($1, $2, 1) ON CONFLICT (event_type) DO NOTHING`,
    [TEST_EVENT_TYPE, TOKEN_ID],
  );
  await pool.query(
    `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
     VALUES ($1, $2, 'SEPOLIA', true) ON CONFLICT (user_id) DO NOTHING`,
    [DEMO_USER_ID, OPERATOR_ADDR],
  );
  await pool.end();
  console.log('  [db] issuance_policies + user_wallet_mapping 시드 완료');

  // ── 4. Java API 스텁 기동 ────────────────────────────────────────────────────
  console.log('[4] Java API 스텁 기동...');
  const javaStubPool = new Pool({ connectionString: PG_URL });
  const javaStub = startJavaStub(javaStubPool);
  await waitPort('localhost', JAVA_STUB_PORT, 'Java-stub');

  // ── 5. 현재 Sepolia 블록 번호 조회 (CHAIN_START_BLOCK 주입용) ─────────────────
  // Alchemy 무료 플랜은 eth_getLogs 범위가 10블록으로 제한됨.
  // getLastProcessedBlock()이 0을 반환하면 genesis부터 조회해 에러 발생.
  // 현재 블록부터 구독 시작하도록 CHAIN_START_BLOCK을 주입한다.
  const { ethers: _ethers } = await import('ethers');
  const _provider = new _ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const chainStartBlock = await _provider.getBlockNumber();
  await (_provider as any).destroy?.();
  console.log(`  [sepolia] 현재 블록: ${chainStartBlock} → CHAIN_START_BLOCK 설정`);

  // ── 6. VASPServer 기동 (Sepolia RPC + 고정 MockVASP) ────────────────────────
  console.log('[6] VASPServer 기동 (Sepolia)...');
  console.log('  [info] Sepolia 블록 확정 ~12s — TX 제출 후 잠시 대기 필요');
  const vaspServer = new VASPServer({
    port:            VASP_PORT,
    rpcUrl:          SEPOLIA_RPC_URL,
    signerKey:       OPERATOR_PRIVATE_KEY,
    contractAddr:    MOCK_VASP_ADDR,
    callbackUrl:     `http://localhost:${WEBHOOK_PORT}`,
    callbackSecret:  WEBHOOK_SECRET,
    pollingInterval: 4000,
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

  // ── 8. issuer-service 기동 (Sepolia 환경변수) ───────────────────────────────
  console.log('[8] issuer-service 기동...');
  const env = {
    ...process.env,
    RPC_URL:               SEPOLIA_RPC_URL,
    CHAIN_ID:              String(CHAIN_ID),
    OPERATOR_PRIVATE_KEY,
    NFT_CONTRACT_ADDR:     MOCK_VASP_ADDR,
    NFT_ISSUER_ADDR:       MOCK_VASP_ADDR,
    VASP_API_URL:          `http://localhost:${VASP_PORT}`,
    VASP_API_KEY:          VASP_API_KEY,
    CORE_BANKING_URL:      `http://localhost:${JAVA_STUB_PORT}`,
    CORE_BANKING_SECRET:   CORE_BANKING_SEC,
    WEBHOOK_SECRET,
    WEBHOOK_PORT:          String(WEBHOOK_PORT),
    REDIS_URL,
    DATABASE_URL:          PG_URL,
    CHAIN_START_BLOCK:     String(chainStartBlock),
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
╔═══════════════════════════════════════════════════════════════╗
║       issuer-service Sepolia 데모 준비 완료                    ║
╠═══════════════════════════════════════════════════════════════╣
║  네트워크       : Ethereum Sepolia (chainId=11155111)          ║
║  MockVASP       : ${MOCK_VASP_ADDR.slice(0, 42).padEnd(42)}  ║
║  OPERATOR       : ${OPERATOR_ADDR.slice(0, 42).padEnd(42)}  ║
╠═══════════════════════════════════════════════════════════════╣
║  WebhookServer  : http://localhost:${WEBHOOK_PORT}               ║
║  VASPServer     : http://localhost:${VASP_PORT}               ║
║  Java stub      : http://localhost:${JAVA_STUB_PORT}               ║
╠═══════════════════════════════════════════════════════════════╣
║  ⚠  Sepolia 블록 확정 ~12s — NFT_ISSUED 콜백까지 대기 필요   ║
╠═══════════════════════════════════════════════════════════════╣
║  발행 요청 보내기:                                              ║
║  npm run demo:issue-sepolia                                   ║
╚═══════════════════════════════════════════════════════════════╝
`);

  // ── 9. DB 상태 폴러 (5초마다 현재 파이프라인 상태 출력) ─────────────────────
  // Sepolia는 블록 시간이 길어 5초 간격으로 폴링
  const dbPoller = new Pool({ connectionString: PG_URL });
  let lastSnapshot = '';

  const pollInterval = setInterval(async () => {
    try {
      const [issuance, mint, tx, holdings, auditLog] = await Promise.all([
        dbPoller.query(`
          SELECT id, user_id, status, tx_hash, fail_reason
          FROM issuance_requests ORDER BY created_at DESC LIMIT 3
        `),
        dbPoller.query(`
          SELECT id, status, tx_hash FROM mint_requests ORDER BY created_at DESC LIMIT 3
        `),
        dbPoller.query(`
          SELECT id, status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3
        `),
        dbPoller.query(`
          SELECT user_id, token_id, amount, on_chain_tx FROM user_nft_holdings ORDER BY acquired_at DESC LIMIT 3
        `),
        dbPoller.query(`
          SELECT actor, action, resource_type, resource_id, checksum, prev_checksum
          FROM audit_log ORDER BY id DESC LIMIT 5
        `),
      ]);

      if (issuance.rows.length === 0) return;

      const snapshot = JSON.stringify({
        issuance: issuance.rows, mint: mint.rows, tx: tx.rows,
        holdings: holdings.rows, auditLog: auditLog.rows,
      });
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;

      console.log('\n─── DB 상태 스냅샷 (Sepolia) ───────────────────────────────────');
      for (const r of issuance.rows) {
        console.log(`  [issuance_requests]  status=${r.status.padEnd(10)}  tx=${(r.tx_hash ?? 'null').slice(0, 12)}…  user=${r.user_id}`);
        if (r.fail_reason) console.log(`                       fail_reason=${r.fail_reason}`);
      }
      for (const r of mint.rows) {
        console.log(`  [mint_requests]      status=${r.status.padEnd(10)}  tx=${(r.tx_hash ?? 'null').slice(0, 12)}…`);
      }
      for (const r of tx.rows) {
        console.log(`  [tx_mint_requests]   status=${r.status.padEnd(10)}  tx=${(r.tx_hash ?? 'null').slice(0, 12)}…`);
      }
      for (const r of holdings.rows) {
        console.log(`  [user_nft_holdings]  userId=${r.user_id}  tokenId=${r.token_id}  amount=${r.amount}  tx=${String(r.on_chain_tx).slice(0, 12)}…`);
      }
      for (const r of auditLog.rows) {
        console.log(`  [audit_log]          actor=${r.actor}  action=${r.action}  ${r.resource_type}/${String(r.resource_id).slice(0, 10)}…  checksum=${String(r.checksum).slice(0, 12)}…  chained=${r.prev_checksum ? 'Y' : 'N(first)'}`);
      }
      console.log('─────────────────────────────────────────────────────────────────\n');
    } catch {}
  }, 5000);

  // ── 10. 종료 핸들링 ─────────────────────────────────────────────────────────
  const shutdown = async () => {
    console.log('\n[종료] 컨테이너 정리 중...');
    clearInterval(pollInterval);
    await dbPoller.end().catch(() => {});
    await javaStubPool.end().catch(() => {});
    issuerProc.kill('SIGTERM');
    await vaspServer.stop().catch(() => {});
    javaStub.close();
    for (const c of CONTAINERS) dockerStop(c);
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[demo] fatal:', err);
  process.exit(1);
});
