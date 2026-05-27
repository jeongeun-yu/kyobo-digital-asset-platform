/**
 * local-demo/scenario.ts — 실패 시나리오 CLI
 *
 * 실행: npm run demo:scenario -- <scenario> [userId]
 *   또는 npx ts-node --project tsconfig.json local-demo/scenario.ts <scenario>
 *
 * start.ts가 실행 중인 상태에서 실행한다.
 *
 * 시나리오 목록:
 *   revert        MockVASP TX revert → issuance_requests FAILED
 *   no-emit       mint 성공 + Issued 이벤트 없음 → ChainEventListener 폴백
 *   invalid-hmac  HMAC 서명 위조 → WebhookServer 401
 *   unknown-user  wallet mapping 없는 userId → 발행 FAILED
 *   pending       evm_setAutomine(false) → TX mempool 체류 → 30초 후 자동 복원
 *   reorg         정상 발행 후 evm_revert로 체인 롤백 → REORGED 상태 검증
 *   reset         MockVASP mode → NORMAL 복원 (비정상 종료 후 수동 복구용)
 */

import http           from 'http';
import crypto         from 'crypto';
import { randomUUID } from 'crypto';
import { ethers }     from 'ethers';
import { readFileSync } from 'fs';
import { resolve }    from 'path';

// ── 상수 (start.ts와 동일) ────────────────────────────────────────────────────

const HARDHAT_PORT    = 8545;
const WEBHOOK_PORT    = 19877;
const ADMIN_PORT      = 19870;
const WEBHOOK_SECRET  = 'local-demo-webhook-secret-32ch!!';
const OPERATOR_KEY    = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DEPLOYER_ADDR   = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TEST_EVENT_TYPE = 'WALK_GOAL_MET';
const RPC_URL         = `http://localhost:${HARDHAT_PORT}`;

// Hardhat은 결정론적: deployer nonce=0 이 MockVASP 배포
const MOCK_VASP_ADDR = ethers.getCreateAddress({ from: DEPLOYER_ADDR, nonce: 0 });

const ARTIFACT_PATH = resolve(
  __dirname, '..', '..', '..', 'blockchain',
  'artifacts', 'src', 'mocks', 'MockVASP.sol', 'MockVASP.json',
);

// MockVASP.MintMode enum
const MintMode = { NORMAL: 0, REVERT: 1, NO_EMIT: 2 } as const;
type MintModeValue = typeof MintMode[keyof typeof MintMode];

// ── ethers 헬퍼 ──────────────────────────────────────────────────────────────

function getProvider() {
  return new ethers.JsonRpcProvider(RPC_URL);
}

function getMockVasp() {
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8'));
  const signer   = new ethers.Wallet(OPERATOR_KEY, getProvider());
  return new ethers.Contract(MOCK_VASP_ADDR, artifact.abi, signer);
}

async function verifyContractDeployed(): Promise<void> {
  const code = await getProvider().getCode(MOCK_VASP_ADDR);
  if (code === '0x') {
    throw new Error(
      `MockVASP가 ${MOCK_VASP_ADDR} 에 없습니다.\n` +
      `  → start.ts가 실행 중인지 확인하세요.`,
    );
  }
}

async function setMode(mode: MintModeValue, label: string): Promise<void> {
  const contract = getMockVasp();
  const tx = await (contract['setMode'] as Function)(mode);
  await tx.wait();
  console.log(`[scenario] MockVASP.mode → ${label}`);
}

// Hardhat JSON-RPC 확장 메서드
async function hardhatRpc(method: string, params: unknown[] = []): Promise<unknown> {
  return getProvider().send(method, params);
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

  console.log(`[scenario] POST webhook  userId=${userId}  requestId=${payload.requestId}`);

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

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function printDbHint(queries: string[]) {
  console.log('\n[scenario] 확인 명령:');
  for (const q of queries) {
    console.log(`  docker exec -it kyobo-demo-postgres psql -U postgres -c "${q}"`);
  }
  console.log('');
}

// ── 시나리오 구현 ──────────────────────────────────────────────────────────────

async function scenarioRevert(userId: string) {
  console.log('\n=== REVERT: TX on-chain 실패 시나리오 ===');
  console.log('  MockVASP가 issueActivityNFT() 호출을 revert한다.');
  console.log('  → issuance_requests.status: FAILED\n');

  await verifyContractDeployed();
  await setMode(MintMode.REVERT, 'REVERT');

  try {
    const status = await sendWebhook({ userId });
    console.log(`[scenario] HTTP ${status} (202면 파이프라인 진입, VASPServer가 TX revert 감지 후 FAILED 처리)`);
  } finally {
    // 실패해도 반드시 복원
    await setMode(MintMode.NORMAL, 'NORMAL');
  }

  printDbHint([
    'SELECT user_id, status, fail_reason FROM issuance_requests ORDER BY created_at DESC LIMIT 3;',
    'SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3;',
  ]);
}

async function scenarioNoEmit(userId: string) {
  console.log('\n=== NO_EMIT: Issued 이벤트 없음 시나리오 ===');
  console.log('  ERC-1155 mint()는 성공하지만 Issued 이벤트를 emit하지 않는다.');
  console.log('  → ChainEventListener가 이벤트를 수신하지 못해 CONFIRMED 전이 없음.');
  console.log('  → mint_requests.status가 SUBMITTED 또는 MINED에서 멈춤 (폴백 경로 동작)\n');

  await verifyContractDeployed();
  await setMode(MintMode.NO_EMIT, 'NO_EMIT');

  try {
    const status = await sendWebhook({ userId });
    console.log(`[scenario] HTTP ${status}`);
  } finally {
    await setMode(MintMode.NORMAL, 'NORMAL');
  }

  printDbHint([
    'SELECT status, tx_hash FROM mint_requests ORDER BY created_at DESC LIMIT 3;',
    'SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3;',
    'SELECT user_id, status FROM issuance_requests ORDER BY created_at DESC LIMIT 3;',
  ]);
}

async function scenarioInvalidHmac(userId: string) {
  console.log('\n=== INVALID_HMAC: 서명 위조 시나리오 ===');
  console.log('  조작된 HMAC 서명으로 웹훅 전송.');
  console.log('  → WebhookServer가 401 반환, 파이프라인 진입 없음\n');

  const status = await sendWebhook({ userId, badSig: true });
  console.log(`[scenario] HTTP ${status}`);

  if (status === 401) {
    console.log('[scenario] 예상 결과: 401 Unauthorized');
    console.log('  → Redis Stream에 이벤트 적재되지 않음 (DB 변화 없음)');
  } else {
    console.error(`[scenario] 예상치 못한 응답: ${status}`);
  }
}

async function scenarioUnknownUser() {
  const fakeUserId = `nonexistent-${randomUUID().slice(0, 8)}`;
  console.log('\n=== UNKNOWN_USER: 존재하지 않는 사용자 시나리오 ===');
  console.log(`  userId=${fakeUserId} 로 발행 요청.`);
  console.log('  → user_wallet_mapping 조회 실패 → issuance_requests FAILED\n');

  const status = await sendWebhook({ userId: fakeUserId });
  console.log(`[scenario] HTTP ${status}`);

  printDbHint([
    `SELECT user_id, status, fail_reason FROM issuance_requests ORDER BY created_at DESC LIMIT 3;`,
  ]);
}

async function scenarioPending(userId: string) {
  const PENDING_SEC = 30;
  console.log('\n=== PENDING: TX mempool 체류 시나리오 ===');
  console.log('  evm_setAutomine(false) → 블록 채굴 중단 → TX가 mempool에서 체류.');
  console.log(`  ${PENDING_SEC}초 후 자동으로 evm_setAutomine(true) 복원.\n`);

  await verifyContractDeployed();

  console.log('[scenario] Hardhat automining OFF...');
  await hardhatRpc('evm_setAutomine', [false]);

  try {
    const status = await sendWebhook({ userId });
    console.log(`[scenario] HTTP ${status}`);
    console.log(`[scenario] TX가 mempool에 체류 중 — ${PENDING_SEC}초 대기...`);

    printDbHint([
      'SELECT user_id, status, tx_hash FROM issuance_requests ORDER BY created_at DESC LIMIT 3;',
      'SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3;',
    ]);

    await sleep(PENDING_SEC * 1000);
  } finally {
    console.log('[scenario] Hardhat automining ON (복원)...');
    await hardhatRpc('evm_setAutomine', [true]);
    // 쌓인 TX 처리를 위해 블록 한 개 강제 채굴
    await hardhatRpc('evm_mine', []);
    console.log('[scenario] 블록 채굴 재개 — TX가 이제 확정됨');
  }
}

async function scenarioReorg(userId: string) {
  console.log('\n=== REORG: 체인 롤백 시나리오 ===');
  console.log('  정상 발행 → confirmed → evm_revert로 체인 롤백.');
  console.log('  → tx_mint_requests.status → REORGED 전이 검증\n');

  await verifyContractDeployed();

  console.log('[scenario] evm_snapshot 저장...');
  const snapshotId = await hardhatRpc('evm_snapshot', []) as string;
  console.log(`[scenario] snapshotId=${snapshotId}`);

  const status = await sendWebhook({ userId });
  console.log(`[scenario] HTTP ${status} — 발행 파이프라인 진행 대기 (8초)...`);

  // ChainEventListener가 Issued를 감지하고 CONFIRMED 처리할 때까지 대기
  await sleep(8000);

  console.log('[scenario] 현재 DB 상태 (롤백 전):');
  printDbHint([
    'SELECT user_id, status, tx_hash FROM issuance_requests ORDER BY created_at DESC LIMIT 3;',
    'SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3;',
  ]);

  console.log(`[scenario] evm_revert(snapshotId=${snapshotId}) — 체인 롤백...`);
  const reverted = await hardhatRpc('evm_revert', [snapshotId]) as boolean;

  if (!reverted) {
    console.error('[scenario] evm_revert 실패 — snapshotId가 이미 소비됐거나 invalid합니다.');
    return;
  }

  console.log('[scenario] 체인 롤백 완료');
  console.log('  → ChainEventListener가 블록 재조직 감지 → tx_mint_requests.status → REORGED');
  console.log('  → TxTransitionBridge가 재발행 시도 여부 확인');

  printDbHint([
    'SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 5;',
    'SELECT user_id, status FROM issuance_requests ORDER BY created_at DESC LIMIT 3;',
  ]);
}

async function scenarioPollStale(userId: string) {
  console.log('\n=== POLL_STALE: pollStaleRequests — PENDING 10분 초과 TX 강제 복구 ===');
  console.log('  NO_EMIT 모드로 TX 확정 + Issued 이벤트 없음 → tx_mint_requests SUBMITTED 유지');
  console.log('  DB 조작: SUBMITTED → PENDING + created_at -11분');
  console.log('  → POST /admin/poll-stale → findPendingOlderThan(10) → getTransferStatus → CONFIRMED\n');

  const pgUrl = process.env['POSTGRES_URL'] ?? `postgresql://postgres:demo@localhost:15432/postgres`;
  const { Pool: PgPool } = await import('pg');
  const pool = new PgPool({ connectionString: pgUrl });

  await verifyContractDeployed();
  await setMode(MintMode.NO_EMIT, 'NO_EMIT');

  try {
    const status = await sendWebhook({ userId });
    console.log(`[scenario] HTTP ${status} — SUBMITTED 대기 중...`);

    // SUBMITTED + txHash 확보
    const deadline = Date.now() + 20_000;
    let txHash = '';
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        "SELECT tx_hash FROM tx_mint_requests WHERE status = 'SUBMITTED' AND tx_hash IS NOT NULL",
      );
      if (rows[0]?.tx_hash) { txHash = rows[0].tx_hash as string; break; }
      await sleep(1000);
    }
    if (!txHash) { console.error('[scenario] SUBMITTED 전이 타임아웃'); return; }
    console.log(`[scenario] tx_hash=${txHash.slice(0, 16)}…`);

    // Hardhat: TX 즉시 채굴 → VASPServer txStatuses='completed' 설정 여유
    await sleep(2000);

    // DB 조작: SUBMITTED → PENDING + created_at -11분
    await pool.query(
      "UPDATE tx_mint_requests SET status='PENDING', created_at=NOW()-INTERVAL '11 minutes' WHERE status='SUBMITTED'",
    );
    console.log('[scenario] tx_mint_requests → PENDING (created_at -11분 조작)');

    // POST /admin/poll-stale → pollStaleRequests() 트리거
    console.log('[scenario] POST /admin/poll-stale...');
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
    console.log(`[scenario] pollStaleRequests processed=${result.processed}`);

    // issuance_requests CONFIRMED 확인
    await sleep(1000);
    const { rows } = await pool.query('SELECT status FROM issuance_requests ORDER BY created_at DESC LIMIT 1');
    console.log(`[scenario] issuance_requests.status = ${rows[0]?.status}`);
  } finally {
    await setMode(MintMode.NORMAL, 'NORMAL');
    await pool.end();
  }

  printDbHint([
    'SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3;',
    'SELECT user_id, status FROM issuance_requests ORDER BY created_at DESC LIMIT 3;',
  ]);
}

async function scenarioBurst(_userId: string) {
  const COUNT = 5;
  console.log(`\n=== BURST: ${COUNT}개 발행 요청 동시 전송 ===`);
  console.log('  demo-user-001 ~ demo-user-005 에 대해 동시에 NFT 발행 요청.');
  console.log('  VASPServer NonceManager가 nonce 충돌 없이 순번 처리.\n');

  await verifyContractDeployed();

  const users = Array.from({ length: COUNT }, (_, i) => `demo-user-${String(i + 1).padStart(3, '0')}`);
  const start = Date.now();

  console.log(`[scenario] ${COUNT}개 웹훅 동시 전송...`);
  const statuses = await Promise.all(users.map(u => sendWebhook({ userId: u })));
  statuses.forEach((s, i) => console.log(`  ${users[i]} → HTTP ${s}`));

  console.log('\n[scenario] 전체 CONFIRMED 대기 중...');
  const pgUrl = process.env['POSTGRES_URL'] ?? `postgresql://postgres:demo@localhost:15432/postgres`;
  const { Pool: PgPool } = await import('pg');
  const pool = new PgPool({ connectionString: pgUrl });

  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        `SELECT user_id, status FROM issuance_requests
         WHERE user_id = ANY($1) ORDER BY created_at DESC`,
        [users],
      );
      const done = rows.filter(r => ['CONFIRMED', 'FAILED'].includes(r.status as string));
      console.log(`  [+${((Date.now() - start) / 1000).toFixed(1)}s] ${done.length}/${COUNT} 완료`);
      if (done.length >= COUNT) {
        console.log('\n[scenario] 최종 결과:');
        rows.forEach(r => console.log(`  ${r.user_id}: ${r.status}`));
        break;
      }
      await sleep(2000);
    }
  } finally {
    await pool.end();
  }

  printDbHint([
    'SELECT user_id, status, tx_hash FROM issuance_requests ORDER BY created_at DESC LIMIT 5;',
    'SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 5;',
    'SELECT user_id, token_id, balance FROM user_nft_holdings ORDER BY user_id LIMIT 5;',
  ]);
}

async function scenarioReset() {
  console.log('\n=== RESET: MockVASP mode 복원 ===');
  await verifyContractDeployed();
  await setMode(MintMode.NORMAL, 'NORMAL');
  const current = await (getMockVasp()['mode'] as Function)();
  console.log(`[scenario] 현재 mode=${current} (0=NORMAL, 1=REVERT, 2=NO_EMIT)`);
}

// ── 엔트리포인트 ──────────────────────────────────────────────────────────────

const SCENARIOS: Record<string, (userId: string) => Promise<void>> = {
  'revert':       scenarioRevert,
  'no-emit':      scenarioNoEmit,
  'invalid-hmac': (u) => scenarioInvalidHmac(u),
  'unknown-user': () => scenarioUnknownUser(),
  'pending':      scenarioPending,
  'reorg':        scenarioReorg,
  'poll-stale':   scenarioPollStale,
  'burst':        scenarioBurst,
  'reset':        () => scenarioReset(),
};

const scenarioName = process.argv[2];
const userId       = process.argv[3] ?? 'demo-user-001';

if (!scenarioName || !SCENARIOS[scenarioName]) {
  console.error(`
사용법: npm run demo:scenario -- <scenario> [userId]

시나리오:
  revert        MockVASP TX revert → issuance_requests FAILED
  no-emit       mint 성공 + Issued 이벤트 없음 → ChainEventListener 폴백
  invalid-hmac  HMAC 서명 위조 → WebhookServer 401
  unknown-user  wallet mapping 없는 userId → 발행 FAILED
  pending       evm_setAutomine(false) → TX mempool 체류 (30초 후 자동 복원)
  reorg         정상 발행 후 evm_revert → 체인 롤백 → REORGED 상태
  poll-stale    NO_EMIT → PENDING 조작 → pollStaleRequests() → CONFIRMED
  burst         5개 요청 동시 전송 → NonceManager nonce 충돌 없이 전체 CONFIRMED
  reset         MockVASP mode → NORMAL 복원 (비정상 종료 후 수동 복구)
`);
  process.exit(1);
}

const DIVIDER = '\n' + '─'.repeat(65);

SCENARIOS[scenarioName]!(userId)
  .then(() => console.log(DIVIDER))
  .catch(err => {
    console.error('\n[scenario] 오류:', err.message);
    console.error('  → start.ts가 실행 중인지 확인하세요.');
    console.log(DIVIDER);
    process.exit(1);
  });
