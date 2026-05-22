/**
 * S27 실습 — 사용자 레이어 진입점 설계 · VASP별 지갑 프로비저닝 분기
 *
 * 사전 준비:
 *   npm run exercise:s27:db:up
 *
 * 실행:
 *   npm run exercise:s27        → 전체 실행
 *   npm run exercise:s27:1      → [1] EXTERNAL HD 지갑 파생
 *   npm run exercise:s27:2      → [2] KYOBO HSM 신규 생성
 *   npm run exercise:s27:3      → [3] 미지원 vaspType → UnsupportedVaspError
 *   npm run exercise:s27:4      → [4] 컨트롤러 계층 시뮬레이션
 *   npm run exercise:s27:5      → [5] 멱등성
 *   npm run exercise:s27:6      → [6] VASP 실패 → DB 미저장
 *   npm run exercise:s27:7      → [7] 감사 로그 + SHA-256
 */

import { ethers }     from 'ethers';
import { createHash } from 'crypto';
import { Pool }       from 'pg';

// ── 타입 정의 ─────────────────────────────────────────────────────────────────

type VaspType = 'EXTERNAL' | 'KYOBO';

interface ProvisionResult {
  userId:        string;
  walletAddress: string;
  vaspType:      VaspType;
  provisionedAt: Date;
}

interface ExternalVaspClient {
  getWalletAddr(userId: string): Promise<string>;
  createWallet(userId: string):  Promise<string>;
}

interface WalletMappingService {
  getMapping(userId: string): Promise<{ walletAddr: string; vaspType: VaspType; createdAt: Date } | null>;
  saveMapping(userId: string, walletAddr: string, vaspType: VaspType): Promise<void>;
}

interface AuditLogAdapter {
  record(entry: { actor: string; action: string; resourceType: string; resourceId: string; afterState: unknown }): Promise<void>;
}

// ── UnsupportedVaspError ──────────────────────────────────────────────────────

export class UnsupportedVaspError extends Error {
  constructor(vaspType: string) {
    super(`지원하지 않는 VASP 타입: ${vaspType}`);
    this.name = 'UnsupportedVaspError';
  }
}

// ── WalletProvisioningService ─────────────────────────────────────────────────

export class WalletProvisioningService {
  constructor(
    private readonly vaspClient:    ExternalVaspClient,
    private readonly walletMapping: WalletMappingService,
    private readonly auditLog?:     AuditLogAdapter,
  ) {}

  async provision(userId: string, vaspType: VaspType | string): Promise<ProvisionResult> {
    const existing = await this.walletMapping.getMapping(userId);
    if (existing) {
      return { userId, walletAddress: existing.walletAddr, vaspType: existing.vaspType, provisionedAt: existing.createdAt };
    }

    let walletAddress: string;

    if (vaspType === 'EXTERNAL') {
      walletAddress = await this.vaspClient.getWalletAddr(userId);
    } else if (vaspType === 'KYOBO') {
      walletAddress = await this.vaspClient.createWallet(userId);
    } else {
      throw new UnsupportedVaspError(vaspType);
    }

    await this.walletMapping.saveMapping(userId, walletAddress, vaspType as VaspType);

    await this.auditLog?.record({
      actor: 'system', action: 'WALLET_PROVISIONED',
      resourceType: 'USER', resourceId: userId,
      afterState: { walletAddress, vaspType },
    });

    return { userId, walletAddress, vaspType: vaspType as VaspType, provisionedAt: new Date() };
  }
}

// ── VASP 클라이언트 ───────────────────────────────────────────────────────────

const VASP_MNEMONIC = 'test test test test test test test test test test test junk';

function makeVaspClient(opts: { failGetWalletAddr?: boolean } = {}): ExternalVaspClient & { callCount: number } {
  const hdRoot    = ethers.HDNodeWallet.fromPhrase(VASP_MNEMONIC, undefined, 'm');
  const store     = new Map<string, string>();
  let   hdIdx     = 0;
  let   callCount = 0;

  return {
    get callCount() { return callCount; },

    async getWalletAddr(userId: string): Promise<string> {
      callCount++;
      if (opts.failGetWalletAddr) throw new Error('VASP network timeout');

      if (!store.has(userId)) {
        const path  = `m/44'/60'/0'/0/${hdIdx++}`;
        const child = hdRoot.derivePath(path);
        store.set(userId, child.address);
        console.log(`  [VASP] HD 파생  path=${path}`);
        console.log(`  [VASP] address  ${child.address}`);
      } else {
        console.log(`  [VASP] 기존 custody 주소 반환  ${store.get(userId)}`);
      }
      return store.get(userId)!;
    },

    async createWallet(userId: string): Promise<string> {
      callCount++;
      const wallet = ethers.Wallet.createRandom();
      console.log(`  [KYOBO HSM] userId     ${userId}`);
      console.log(`  [KYOBO HSM] address    ${wallet.address}`);
      console.log(`  [KYOBO HSM] privateKey ${wallet.privateKey}  ← HSM 보관, 외부 노출 금지`);
      return wallet.address;
    },
  };
}

// ── WalletMapping — 실제 PostgreSQL ──────────────────────────────────────────

function makeWalletMapping(pool: Pool): WalletMappingService & { saveCalls: number } {
  let saveCalls = 0;

  return {
    get saveCalls() { return saveCalls; },

    async getMapping(userId: string) {
      const res = await pool.query(
        `SELECT wallet_addr, vasp_type, created_at FROM user_wallet_mapping WHERE user_id = $1`,
        [userId],
      );
      console.log(`  [DB] SELECT wallet_addr, vasp_type, created_at`);
      console.log(`       FROM   user_wallet_mapping WHERE user_id = '${userId}'`);
      console.log(`       → ${res.rowCount} row${res.rowCount === 1 ? '' : 's'}${res.rowCount ? `  (${res.rows[0].wallet_addr})` : ''}`);
      if (!res.rowCount) return null;
      const row = res.rows[0];
      return { walletAddr: row.wallet_addr, vaspType: row.vasp_type as VaspType, createdAt: row.created_at };
    },

    async saveMapping(userId: string, walletAddr: string, vaspType: VaspType) {
      saveCalls++;
      await pool.query(
        `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified) VALUES ($1, $2, $3, true)`,
        [userId, walletAddr, vaspType],
      );
      console.log(`  [DB] INSERT INTO user_wallet_mapping`);
      console.log(`       (user_id, wallet_addr, vasp_type, verified)`);
      console.log(`       VALUES ('${userId}', '${walletAddr}', '${vaspType}', true)  → 1 row inserted`);
    },
  };
}

// ── AuditLog — SHA-256 체크섬 ────────────────────────────────────────────────

function makeAuditLog(): AuditLogAdapter & { entries: unknown[] } {
  const entries: unknown[] = [];

  return {
    entries,
    async record({ actor, action, resourceType, resourceId, afterState }) {
      const eventTime = new Date().toISOString();
      const raw       = `${eventTime}${actor}${action}${resourceId}${JSON.stringify(afterState)}`;
      const checksum  = createHash('sha256').update(raw, 'utf8').digest('hex');
      const entry     = { eventTime, actor, action, resourceType, resourceId, afterState, checksum };
      entries.push(entry);
      console.log(`  [AUDIT] action     ${action}`);
      console.log(`  [AUDIT] resourceId ${resourceId}`);
      console.log(`  [AUDIT] afterState ${JSON.stringify(afterState)}`);
      console.log(`  [AUDIT] checksum   ${checksum}`);
    },
  };
}

// ── DB 상태 출력 헬퍼 ────────────────────────────────────────────────────────

async function showDb(pool: Pool, where?: string) {
  const sql = where
    ? `SELECT user_id, wallet_addr, vasp_type, verified, created_at FROM user_wallet_mapping WHERE ${where} ORDER BY id`
    : `SELECT user_id, wallet_addr, vasp_type, verified, created_at FROM user_wallet_mapping ORDER BY id`;
  const res = await pool.query(sql);
  console.table(res.rows);
}

// ── 섹션 함수 ─────────────────────────────────────────────────────────────────

async function section1(pool: Pool) {
  console.log('[1] EXTERNAL → VASP HD 지갑 파생');
  const vasp    = makeVaspClient();
  const mapping = makeWalletMapping(pool);
  const svc     = new WalletProvisioningService(vasp, mapping);

  const result = await svc.provision('K-20240001', 'EXTERNAL');
  console.log('  result     :', result);
  console.log('  vasp calls :', vasp.callCount);
  await showDb(pool, `user_id = 'K-20240001'`);
}

async function section2(pool: Pool) {
  console.log('[2] KYOBO → HSM 신규 지갑 생성');
  const vasp    = makeVaspClient();
  const mapping = makeWalletMapping(pool);
  const svc     = new WalletProvisioningService(vasp, mapping);

  const result = await svc.provision('K-20240002', 'KYOBO');
  console.log('  result     :', result);
  console.log('  vasp calls :', vasp.callCount);
  await showDb(pool, `user_id = 'K-20240002'`);
}

async function section3(pool: Pool) {
  console.log('[3] 미지원 vaspType → UnsupportedVaspError');
  const vasp    = makeVaspClient();
  const mapping = makeWalletMapping(pool);
  const svc     = new WalletProvisioningService(vasp, mapping);

  try {
    await svc.provision('K-20240003', 'LEGACY_VASP');
  } catch (err) {
    console.log('  에러       :', (err as Error).constructor.name, (err as Error).message);
  }
  console.log('  saveCalls  :', mapping.saveCalls);

  const check = await pool.query(`SELECT count(*) FROM user_wallet_mapping WHERE user_id = 'K-20240003'`);
  console.log('  DB rows    :', check.rows[0].count, '← INSERT 없음');
}

async function section4(pool: Pool) {
  console.log('[4] 컨트롤러 계층 — UnsupportedVaspError → 400, 나머지 → 200');
  const vasp    = makeVaspClient();
  const mapping = makeWalletMapping(pool);
  const svc     = new WalletProvisioningService(vasp, mapping);

  async function simulateController(userId: string, vaspType: string): Promise<number> {
    try {
      await svc.provision(userId, vaspType as VaspType);
      return 200;
    } catch (err) {
      if (err instanceof UnsupportedVaspError) return 400;
      return 500;
    }
  }

  console.log('  EXTERNAL   :', await simulateController('K-20240004', 'EXTERNAL'));
  console.log('  LEGACY_VASP:', await simulateController('K-20240005', 'LEGACY_VASP'));
  console.log('  KYOBO      :', await simulateController('K-20240006', 'KYOBO'));
  await showDb(pool, `user_id IN ('K-20240004','K-20240005','K-20240006')`);
}

async function section5(pool: Pool) {
  console.log('[5] 멱등성 — 동일 userId 3회 요청');
  const vasp    = makeVaspClient();
  const mapping = makeWalletMapping(pool);
  const svc     = new WalletProvisioningService(vasp, mapping);

  const r1 = await svc.provision('K-20240007', 'EXTERNAL');
  const r2 = await svc.provision('K-20240007', 'EXTERNAL');
  const r3 = await svc.provision('K-20240007', 'EXTERNAL');

  console.log('  r1.walletAddress :', r1.walletAddress);
  console.log('  r2.walletAddress :', r2.walletAddress);
  console.log('  r3.walletAddress :', r3.walletAddress);
  console.log('  vasp calls       :', vasp.callCount);    // 1
  console.log('  saveCalls        :', mapping.saveCalls); // 1

  const check = await pool.query(`SELECT count(*) FROM user_wallet_mapping WHERE user_id = 'K-20240007'`);
  console.log('  DB rows          :', check.rows[0].count, '← 3회 요청에도 1행');
}

async function section6(pool: Pool) {
  console.log('[6] VASP API 실패 → DB 저장 안 됨 (일관 상태)');
  const vasp    = makeVaspClient({ failGetWalletAddr: true });
  const mapping = makeWalletMapping(pool);
  const svc     = new WalletProvisioningService(vasp, mapping);

  try {
    await svc.provision('K-20240008', 'EXTERNAL');
  } catch (err) {
    console.log('  에러       :', (err as Error).message);
  }
  console.log('  saveCalls  :', mapping.saveCalls);

  const check = await pool.query(`SELECT count(*) FROM user_wallet_mapping WHERE user_id = 'K-20240008'`);
  console.log('  DB rows    :', check.rows[0].count, '← INSERT 없음');
}

async function section7(pool: Pool) {
  console.log('[7] 감사 로그 연동 — WALLET_PROVISIONED + SHA-256 체크섬');
  const vasp    = makeVaspClient();
  const mapping = makeWalletMapping(pool);
  const audit   = makeAuditLog();
  const svc     = new WalletProvisioningService(vasp, mapping, audit);

  await svc.provision('K-20240009', 'EXTERNAL');
  console.log('  entries count :', audit.entries.length);

  await svc.provision('K-20240009', 'EXTERNAL');
  console.log('  재요청 후     :', audit.entries.length, '← 멱등, 감사 로그 미기록');
}

// ── 진입점 ───────────────────────────────────────────────────────────────────

const SECTIONS: Record<string, (pool: Pool) => Promise<void>> = {
  '1': section1,
  '2': section2,
  '3': section3,
  '4': section4,
  '5': section5,
  '6': section6,
  '7': section7,
};

(async () => {
  const pool = new Pool({ host: 'localhost', port: 5434, database: 'kyobo_exercise', user: 'kyobo', password: 'kyobo' });

  const arg = process.argv[2];

  if (arg && SECTIONS[arg]) {
    // 단일 섹션 실행
    await pool.query('TRUNCATE TABLE user_wallet_mapping RESTART IDENTITY');
    console.log(`=== S27: 섹션 [${arg}] ===\n`);
    await SECTIONS[arg]!(pool);
  } else {
    // 전체 실행
    await pool.query('TRUNCATE TABLE user_wallet_mapping RESTART IDENTITY');
    console.log('=== S27: 지갑 프로비저닝 — 전체 실행 ===\n');
    for (const [num, fn] of Object.entries(SECTIONS)) {
      await fn(pool);
      console.log();
    }
    console.log('[최종] user_wallet_mapping 전체 조회');
    await showDb(pool);
  }

  await pool.end();
  console.log('\nS27 완료');
})();
