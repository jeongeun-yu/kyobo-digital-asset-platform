/**
 * local-demo/scenario-sepolia.ts — Sepolia 실패 시나리오 CLI
 *
 * 실행: npm run demo:scenario-sepolia -- <scenario> [userId]
 *   또는 npx ts-node --project tsconfig.json local-demo/scenario-sepolia.ts <scenario>
 *
 * start-sepolia.ts가 실행 중인 상태에서 실행한다.
 *
 * ⚠ setMode는 VASPServer HTTP(/admin/mode) 경유 — Sepolia ETH 소모 없음
 * ⚠ 블록 확정 ~12s — 결과 확인까지 20~30초 소요 정상
 *
 * 사용 가능한 시나리오:
 *   revert        MockVASP TX revert → issuance_requests FAILED
 *   no-emit       mint 성공 + Issued 이벤트 없음 → ChainEventListener 폴백
 *   invalid-hmac  HMAC 서명 위조 → WebhookServer 401
 *   unknown-user  wallet mapping 없는 userId → 발행 FAILED
 *   poll-stale    NO_EMIT → SUBMITTED 10분 초과 → pollStaleRequests() → CONFIRMED
 *   burst         5개 요청 동시 전송 → NonceManager nonce 충돌 없이 전체 CONFIRMED
 *   reconcile     온체인 vs 원장 불일치 감지 → userId·tokenId 출력 (no-emit 이후 실행 권장)
 *   reset         MockVASP mode → NORMAL 복원
 */

import http             from 'http';
import crypto           from 'crypto';
import { randomUUID }   from 'crypto';
import { ethers }       from 'ethers';
import { readFileSync }  from 'fs';
import { resolve }      from 'path';
import dotenv           from 'dotenv';

// ── 환경변수 로드 ─────────────────────────────────────────────────────────────

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

// ── 상수 (start-sepolia.ts와 동일) ───────────────────────────────────────────

const WEBHOOK_PORT   = 19887;
const VASP_PORT      = 19886;
const ADMIN_PORT     = 19880;
const DEMO_PG_PORT   = 15442;
const WEBHOOK_SECRET = 'sepolia-demo-webhook-secret-32ch!!';
const TEST_EVENT_TYPE = 'WALK_GOAL_MET';

// MockVASP MintMode enum
const MintMode = { NORMAL: 0, REVERT: 1, NO_EMIT: 2 } as const;
type MintModeValue = typeof MintMode[keyof typeof MintMode];

const ARTIFACT_PATH = resolve(
  __dirname, '..', '..', '..', 'blockchain',
  'artifacts', 'src', 'mocks', 'MockVASP.sol', 'MockVASP.json',
);

// ── ethers 헬퍼 ──────────────────────────────────────────────────────────────

function getMockVasp() {
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8'));
  const provider  = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const signer    = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
  return new ethers.Contract(MOCK_VASP_ADDR, artifact.abi, signer);
}

async function verifyContractDeployed(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const code = await provider.getCode(MOCK_VASP_ADDR);
  if (code === '0x') {
    throw new Error(
      `MockVASP가 Sepolia ${MOCK_VASP_ADDR} 에 없습니다.\n` +
      `  → SEPOLIA_MOCK_VASP_ADDR 환경변수 확인`,
    );
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const MODE_NAME: Record<MintModeValue, string> = { 0: 'NORMAL', 1: 'REVERT', 2: 'NO_EMIT' };

async function setMode(mode: MintModeValue, label: string): Promise<void> {
  const body = JSON.stringify({ mode: MODE_NAME[mode] });
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port:     VASP_PORT,
        method:   'POST',
        path:     '/admin/mode',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      res => { res.resume(); res.on('end', resolve); },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  console.log(`[scenario-sepolia] MockVASP.mode → ${label}`);
}

// ── 웹훅 전송 ─────────────────────────────────────────────────────────────────

interface WebhookOpts {
  userId: string;
  badSig?: boolean;
}

function sendWebhook(opts: WebhookOpts): Promise<number> {
  const { userId, badSig = false } = opts;

  const payload = {
    eventType: 'ACTIVITY_ACHIEVED',
    requestId: randomUUID(),
    timestamp: Date.now(),
    data: {
      userId,
      activityId: randomUUID(),
      eventType:  TEST_EVENT_TYPE,
      eventCode:  1,
      data:       { steps: 15_000 },
    },
  };

  const body = JSON.stringify(payload);
  const sig  = badSig
    ? 'deadbeef0000000000000000000000000000000000000000000000000000dead'
    : crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

  console.log(`[scenario-sepolia] POST webhook  userId=${userId}  requestId=${payload.requestId}`);

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
      res => resolve(res.statusCode ?? 0),
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function printDbHint(queries: string[]) {
  console.log('\n[scenario-sepolia] 확인 명령:');
  for (const q of queries) {
    console.log(`  docker exec -it kyobo-sepolia-postgres psql -U postgres -c "${q}"`);
  }
  console.log('  ⚠ Sepolia는 블록 확정 ~12s — 결과 반영까지 잠시 대기\n');
}

// ── 시나리오 구현 ──────────────────────────────────────────────────────────────

async function scenarioRevert(userId: string) {
  console.log('\n=== REVERT: TX on-chain 실패 시나리오 (Sepolia) ===');
  console.log('  MockVASP가 issueActivityNFT() 호출을 revert한다.');
  console.log('  → issuance_requests.status: FAILED\n');

  await verifyContractDeployed();

  const pgUrl = 'postgresql://postgres:demo@localhost:15442/postgres';
  const { Pool: PgPool } = await import('pg');
  const pool = new PgPool({ connectionString: pgUrl });

  await setMode(MintMode.REVERT, 'REVERT');

  try {
    const webhookSentAt = new Date();
    const status = await sendWebhook({ userId });
    console.log(`[scenario-sepolia] HTTP ${status} — issuance_requests FAILED 대기 중...`);

    // REVERT 모드에서 issueActivityNFT()는 estimateGas 단계에서 revert → tx_hash 미생성
    // tx_hash 폴링 대신 issuance_requests.status = FAILED/CONFIRMED 를 확인한다.
    // tx_hash 기반 폴링은 이전 시나리오의 잔여 tx_hash(60초 이내)를 잘못 집어올 수 있음.
    const deadline = Date.now() + 45_000;
    let finalStatus: string | undefined;
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        `SELECT status FROM issuance_requests
         WHERE user_id = $1 AND created_at > $2
         ORDER BY created_at DESC LIMIT 1`,
        [userId, webhookSentAt.toISOString()],
      );
      const s = rows[0]?.status as string | undefined;
      if (s === 'FAILED' || s === 'CONFIRMED') {
        finalStatus = s;
        console.log(`[scenario-sepolia] issuance_requests.status = ${s} — NORMAL 복원`);
        break;
      }
      await sleep(1_000);
    }
    if (!finalStatus) console.warn('[scenario-sepolia] 상태 확정 타임아웃 — DB를 직접 확인하세요');
  } finally {
    await setMode(MintMode.NORMAL, 'NORMAL');
    await pool.end();
  }

  printDbHint([
    'SELECT user_id, status, fail_reason FROM issuance_requests ORDER BY created_at DESC LIMIT 3;',
    'SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3;',
  ]);
}

async function scenarioNoEmit(userId: string) {
  console.log('\n=== NO_EMIT: Issued 이벤트 없음 시나리오 (Sepolia) ===');
  console.log('  ERC-1155 mint()는 성공하지만 Issued 이벤트를 emit하지 않는다.');
  console.log('  → ChainEventListener 폴백 경로 동작\n');

  await verifyContractDeployed();
  await setMode(MintMode.NO_EMIT, 'NO_EMIT');

  // sendWebhook() 직후 즉시 NORMAL로 복원하면 파이프라인이 VASPServer를 호출하기 전에
  // 모드가 바뀌어 TX가 NORMAL로 브로드캐스트된다. tx_hash 등록 = TX 브로드캐스트 완료이므로
  // DB에서 tx_hash가 나타날 때까지 대기한 뒤 모드를 복원한다.
  const pgUrl = 'postgresql://postgres:demo@localhost:15442/postgres';
  const { Pool: PgPool } = await import('pg');
  const pool = new PgPool({ connectionString: pgUrl });
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);

  try {
    const status = await sendWebhook({ userId });
    console.log(`[scenario-sepolia] HTTP ${status} — NO_EMIT TX 브로드캐스트 대기 중...`);

    const deadline = Date.now() + 30_000;
    let txHash: string | undefined;
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        `SELECT tx_hash FROM tx_mint_requests
         WHERE tx_hash IS NOT NULL AND created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY created_at DESC LIMIT 1`,
      );
      if (rows[0]?.tx_hash) {
        txHash = String(rows[0].tx_hash);
        console.log(`[scenario-sepolia] TX 브로드캐스트 확인: ${txHash.slice(0, 16)}… — Sepolia 채굴 대기 중 (~12s)`);
        break;
      }
      await sleep(500);
    }
    if (!txHash) console.warn('[scenario-sepolia] TX 브로드캐스트 타임아웃 — DB를 직접 확인하세요');

    if (txHash) {
      await provider.waitForTransaction(txHash, 1, 60_000);
      console.log('[scenario-sepolia] Sepolia 채굴 완료 — NO_EMIT 모드 복원');
    }
  } finally {
    await setMode(MintMode.NORMAL, 'NORMAL');
    await pool.end();
  }

  printDbHint([
    'SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3;',
  ]);
}

async function scenarioInvalidHmac(userId: string) {
  console.log('\n=== INVALID_HMAC: 서명 위조 시나리오 (Sepolia) ===');
  console.log('  조작된 HMAC 서명으로 웹훅 전송 → 401 반환\n');

  const status = await sendWebhook({ userId, badSig: true });
  console.log(`[scenario-sepolia] HTTP ${status}`);

  if (status === 401) {
    console.log('[scenario-sepolia] 예상 결과: 401 Unauthorized');
    console.log('  → 파이프라인 진입 없음 (DB 변화 없음, Sepolia ETH 소모 없음)');
  } else {
    console.error(`[scenario-sepolia] 예상치 못한 응답: ${status}`);
  }
}

async function scenarioUnknownUser() {
  const fakeUserId = `nonexistent-${randomUUID().slice(0, 8)}`;
  console.log('\n=== UNKNOWN_USER: 존재하지 않는 사용자 시나리오 (Sepolia) ===');
  console.log(`  userId=${fakeUserId} 로 발행 요청.`);
  console.log('  → user_wallet_mapping 조회 실패 → issuance_requests FAILED\n');

  const status = await sendWebhook({ userId: fakeUserId });
  console.log(`[scenario-sepolia] HTTP ${status}`);

  printDbHint([
    `SELECT user_id, status, fail_reason FROM issuance_requests ORDER BY created_at DESC LIMIT 3;`,
  ]);
}


async function scenarioPollStale(userId: string) {
  console.log('\n=== POLL_STALE: pollStaleRequests — PENDING 10분 초과 TX 강제 복구 (Sepolia) ===');
  console.log('  NO_EMIT 모드로 TX 확정 + Issued 이벤트 없음 → tx_mint_requests SUBMITTED 유지');
  console.log('  Sepolia TX 채굴 확인 후 DB 조작: SUBMITTED → PENDING + created_at -11분');
  console.log('  → POST /admin/poll-stale → getTransferStatus(VASPServer) → CONFIRMED\n');

  // 시나리오 스크립트는 호스트에서 실행 → Docker 노출 포트(15442) 고정
  const pgUrl = 'postgresql://postgres:demo@localhost:15442/postgres';

  const { Pool: PgPool } = await import('pg');
  const pool = new PgPool({ connectionString: pgUrl });
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);

  await verifyContractDeployed();
  await setMode(MintMode.NO_EMIT, 'NO_EMIT');

  try {
    const status = await sendWebhook({ userId });
    console.log(`[scenario-sepolia] HTTP ${status} — SUBMITTED 대기 중...`);

    // SUBMITTED + txHash 확보
    const deadline = Date.now() + 60_000;
    let txHash = '';
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        "SELECT tx_hash FROM tx_mint_requests WHERE status = 'SUBMITTED' AND tx_hash IS NOT NULL",
      );
      if (rows[0]?.tx_hash) { txHash = rows[0].tx_hash as string; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!txHash) { console.error('[scenario-sepolia] SUBMITTED 전이 타임아웃'); return; }
    console.log(`[scenario-sepolia] tx_hash=${txHash.slice(0, 16)}…`);

    // Sepolia TX 채굴 대기 (txStatuses='completed' 설정 확인)
    console.log('[scenario-sepolia] Sepolia TX 채굴 대기 중 (~12s)...');
    await provider.waitForTransaction(txHash, 1, 60_000);
    await new Promise(r => setTimeout(r, 2_000));
    console.log('[scenario-sepolia] TX 채굴 확인');

    // DB 조작: SUBMITTED → PENDING + created_at -11분
    await pool.query(
      "UPDATE tx_mint_requests SET status='PENDING', created_at=NOW()-INTERVAL '11 minutes' WHERE status='SUBMITTED'",
    );
    console.log('[scenario-sepolia] tx_mint_requests → PENDING (created_at -11분 조작)');

    // POST /admin/poll-stale → pollStaleRequests() 트리거
    console.log('[scenario-sepolia] POST /admin/poll-stale...');
    const result = await new Promise<{ processed: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port: ADMIN_PORT, method: 'POST', path: '/admin/poll-stale' },
        res => {
          let body = '';
          res.on('data', d => { body += d; });
          res.on('end', () => resolve(JSON.parse(body)));
        },
      );
      req.on('error', reject);
      req.end();
    });
    console.log(`[scenario-sepolia] pollStaleRequests processed=${result.processed}`);

    // issuance_requests CONFIRMED 확인
    await new Promise(r => setTimeout(r, 1000));
    const { rows } = await pool.query(
      'SELECT status, token_id FROM issuance_requests ORDER BY created_at DESC LIMIT 1',
    );
    console.log(`[scenario-sepolia] issuance_requests.status = ${rows[0]?.status}`);

    // IssuanceTransitionBridge(source='POLL_STALE')가 recordNftHolding → CREDITED를 자동 처리하므로
    // 별도 /admin/credit-nft 호출 불필요
  } finally {
    await setMode(MintMode.NORMAL, 'NORMAL');
    await pool.end();
    (provider as any).destroy?.();
  }

  printDbHint([
    'SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3;',
    'SELECT user_id, status FROM issuance_requests ORDER BY created_at DESC LIMIT 3;',
  ]);
}

async function clearNonTerminalIssuanceState(users: string[]): Promise<void> {
  const pgUrl = `postgresql://postgres:demo@localhost:${DEMO_PG_PORT}/postgres`;
  const { Pool: PgPool } = await import('pg');
  const pool = new PgPool({ connectionString: pgUrl });
  try {
    await pool.query(
      `DELETE FROM issuance_requests
       WHERE user_id = ANY($1)
         AND status NOT IN ('CONFIRMED', 'FAILED')`,
      [users],
    );
    console.log('[scenario-sepolia] 비완료 issuance_requests 초기화 완료');
  } finally {
    await pool.end();
  }
}

async function scenarioBurst(_userId: string) {
  const COUNT = 5;
  console.log(`\n=== BURST: ${COUNT}개 발행 요청 동시 전송 (Sepolia) ===`);
  console.log('  demo-user-001 ~ demo-user-005 에 대해 동시에 NFT 발행 요청.');
  console.log('  VASPServer NonceManager가 nonce 충돌 없이 순번 처리.');
  console.log('  Sepolia 블록 ~12s — 전체 완료까지 최대 3분 소요.\n');

  await verifyContractDeployed();

  const users = Array.from({ length: COUNT }, (_, i) => `demo-user-${String(i + 1).padStart(3, '0')}`);
  await clearNonTerminalIssuanceState(users);

  const start = Date.now();

  console.log(`[scenario-sepolia] ${COUNT}개 웹훅 동시 전송...`);
  const statuses = await Promise.all(users.map(u => sendWebhook({ userId: u })));
  statuses.forEach((s, i) => console.log(`  ${users[i]} → HTTP ${s}`));

  console.log('\n[scenario-sepolia] 전체 CONFIRMED 대기 중 (최대 3분)...');
  const pgUrl = `postgresql://postgres:demo@localhost:${DEMO_PG_PORT}/postgres`;
  console.log(`[scenario-sepolia] DB 연결 중... (${pgUrl.replace(/:\/\/[^@]+@/, '://*@')})`);

  const { Pool: PgPool } = await import('pg');
  const pool = new PgPool({ connectionString: pgUrl });

  let queryErr: Error | undefined;
  try {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        `SELECT user_id, status FROM issuance_requests
         WHERE user_id = ANY($1) ORDER BY created_at DESC`,
        [users],
      );
      const done = rows.filter(r => ['CONFIRMED', 'FAILED'].includes(r.status as string));
      console.log(`  [+${((Date.now() - start) / 1000).toFixed(1)}s] ${done.length}/${COUNT} 완료`);
      if (done.length >= COUNT) {
        console.log('\n[scenario-sepolia] 최종 결과:');
        rows.forEach(r => console.log(`  ${r.user_id}: ${r.status}`));
        break;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (e) {
    queryErr = e as Error;
    console.error('[scenario-sepolia] DB 쿼리 오류:', (e as Error)?.message, (e as Error)?.stack);
  } finally {
    await pool.end().catch(e =>
      console.error('[scenario-sepolia] pool.end() 오류:', (e as Error)?.message));
  }
  if (queryErr) throw queryErr;

  printDbHint([
    'SELECT user_id, status, tx_hash FROM issuance_requests ORDER BY created_at DESC LIMIT 5;',
    'SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 5;',
    'SELECT user_id, token_id, balance FROM user_nft_holdings ORDER BY user_id LIMIT 5;',
  ]);
}

async function scenarioReconcile(userId: string) {
  console.log('\n=== RECONCILE: 온체인 ↔ 원장 불일치 감지 (Sepolia) ===');
  console.log('  POST /admin/reconcile/run → 온체인 잔고 vs user_nft_holdings 비교');
  console.log('  no-emit 이후 실행 시: 온체인에 NFT 있지만 원장 미기록 → ONCHAIN_ONLY 감지');
  console.log('  불일치 발견 시 표시된 userId + tokenId로 /admin/credit-nft 호출하여 보정\n');

  await verifyContractDeployed();

  console.log(`[scenario-sepolia] POST /admin/reconcile/run  userId=${userId}...`);
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const body = JSON.stringify({ userId, operator: 'demo-admin' });
    const req = http.request(
      {
        hostname: 'localhost',
        port:     ADMIN_PORT,
        method:   'POST',
        path:     '/admin/reconcile/run',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      res => {
        let buf = '';
        res.on('data', d => { buf += d; });
        res.on('end', () => resolve(JSON.parse(buf)));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  console.log('[scenario-sepolia] reconcile 결과:');
  console.log(JSON.stringify(result, null, 2));

  const discrepancies = result['discrepancies'] as Array<{ userId: string; tokenId: string; type: string }>;
  if (discrepancies.length > 0) {
    console.log('\n[scenario-sepolia] /admin/credit-nft 보정 명령:');
    for (const d of discrepancies) {
      console.log(`  Invoke-RestMethod -Method Post -Uri http://localhost:${ADMIN_PORT}/admin/credit-nft \`\n    -ContentType "application/json" \`\n    -Body '{"userId":"${d.userId}","tokenId":"${d.tokenId}","amount":1,"txHash":"<txHash>"}'`);
    }
  }

  printDbHint([
    `SELECT user_id, token_id, discrepancy_type, checked_at FROM reconcile_history ORDER BY checked_at DESC LIMIT 5;`,
    `SELECT user_id, token_id, amount FROM user_nft_holdings WHERE user_id = '${userId}';`,
  ]);
}

async function scenarioReset() {
  console.log('\n=== RESET: MockVASP mode 복원 (Sepolia) ===');
  await verifyContractDeployed();
  try {
    await setMode(MintMode.NORMAL, 'NORMAL');
    const current = await (getMockVasp()['mode'] as Function)();
    console.log(`[scenario-sepolia] 현재 mode=${current} (0=NORMAL, 1=REVERT, 2=NO_EMIT)`);
  } catch (err: any) {
    // 0xe2517d3f = AccessControlUnauthorizedAccount — 이 키에 OPERATOR_ROLE 없음
    if (String(err?.data ?? err?.message ?? '').includes('e2517d3f')) {
      console.error(`[scenario-sepolia] ❌ AccessControl 오류: OPERATOR 키가 이 컨트랙트의 OPERATOR_ROLE이 없습니다.`);
      console.error(`  컨트랙트: ${MOCK_VASP_ADDR}`);
      console.error(`  → start-sepolia.ts를 먼저 실행하세요. 매 실행마다 신규 컨트랙트를 배포하므로 reset이 필요 없습니다.`);
      process.exit(1);
    }
    throw err;
  }
}

// ── 엔트리포인트 ──────────────────────────────────────────────────────────────

const SCENARIOS: Record<string, (userId: string) => Promise<void>> = {
  'revert':       scenarioRevert,
  'no-emit':      scenarioNoEmit,
  'invalid-hmac': (u) => scenarioInvalidHmac(u),
  'unknown-user': () => scenarioUnknownUser(),
  'poll-stale':   scenarioPollStale,
  'burst':        scenarioBurst,
  'reconcile':    scenarioReconcile,
  'reset':        () => scenarioReset(),
};

const scenarioName = process.argv[2];
const userId       = process.argv[3] ?? 'demo-user-001';

if (!scenarioName || !SCENARIOS[scenarioName]) {
  console.error(`
사용법: npm run demo:scenario-sepolia -- <scenario> [userId]

시나리오:
  revert        MockVASP TX revert → issuance_requests FAILED
  no-emit       mint 성공 + Issued 이벤트 없음 → ChainEventListener 폴백
  invalid-hmac  HMAC 서명 위조 → WebhookServer 401
  unknown-user  wallet mapping 없는 userId → 발행 FAILED
  poll-stale    NO_EMIT → SUBMITTED 10분 초과 → pollStaleRequests() → CONFIRMED
  burst         5개 요청 동시 전송 → NonceManager nonce 충돌 없이 전체 CONFIRMED
  reconcile     온체인 vs 원장 불일치 감지 → userId·tokenId 출력 (no-emit 이후 실행 권장)
  reset         MockVASP mode → NORMAL 복원

⚠ setMode TX는 실제 Sepolia에 브로드캐스트됨 (Sepolia ETH 소모)
⚠ 블록 확정 ~12s — 결과 확인까지 20~30초 소요 정상
`);
  process.exit(1);
}

const DIVIDER = '\n' + '─'.repeat(65);

SCENARIOS[scenarioName]!(userId)
  .then(() => console.log(DIVIDER))
  .catch(err => {
    console.error('\n[scenario-sepolia] 오류:', err?.message ?? String(err));
    if (err?.stack) console.error(err.stack);
    console.error('  → start-sepolia.ts가 실행 중인지, .env 환경변수를 확인하세요.');
    console.log(DIVIDER);
    process.exit(1);
  });
