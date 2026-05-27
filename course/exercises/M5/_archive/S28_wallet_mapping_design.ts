/**
 * S28 실습 — 온체인 식별자와 내부 사용자 ID의 매핑 설계
 *
 * 사전 준비:
 *   npm run exercise:s27:db:up      ← S27과 같은 DB 사용
 *
 * 실행:
 *   npm run exercise:s28            → 전체 실행
 *   npm run exercise:s28:1          → [1] 미등록 userId → WalletNotFoundError
 *   npm run exercise:s28:2          → [2] EXTERNAL 등록 → verified=false → WalletNotVerifiedError
 *   npm run exercise:s28:3          → [3] markVerified() → verified=true → 정상 반환
 *   npm run exercise:s28:4          → [4] KYOBO 방식 → 즉시 verified=true
 *   npm run exercise:s28:5          → [5] 지갑 교체 — UPSERT (1:1 강제)
 *   npm run exercise:s28:6          → [6] 역방향 조회 getUserIdByAddr()
 *   npm run exercise:s28:7          → [7] 컨트롤러 에러 분류 시뮬레이션
 */

import { Pool } from 'pg';

// ── 타입 정의 ─────────────────────────────────────────────────────────────────

type VaspType = 'EXTERNAL' | 'KYOBO';

// ── 에러 클래스 ───────────────────────────────────────────────────────────────

export class WalletNotFoundError extends Error {
  constructor(userId: string) {
    super(`Wallet not found for user: ${userId}`);
    this.name = 'WalletNotFoundError';
  }
}

export class WalletNotVerifiedError extends Error {
  constructor(userId: string) {
    super(`Wallet not verified for user: ${userId}. Run wallet verification first.`);
    this.name = 'WalletNotVerifiedError';
  }
}

// ── WalletMappingService — 실제 PostgreSQL 기반 ───────────────────────────────

export class WalletMappingService {
  constructor(private readonly pool: Pool) {}

  /**
   * 발행 요청마다 호출되는 핵심 메서드
   * 미등록 → WalletNotFoundError  (자동 생성 절대 금지)
   * 미검증 → WalletNotVerifiedError (서명 검증 후에만 발행 가능)
   */
  async getWalletAddr(userId: string): Promise<string> {
    const res = await this.pool.query<{ wallet_addr: string; verified: boolean }>(
      `SELECT wallet_addr, verified FROM user_wallet_mapping WHERE user_id = $1`,
      [userId],
    );
    console.log(`  [DB] SELECT wallet_addr, verified`);
    console.log(`       FROM   user_wallet_mapping WHERE user_id = '${userId}'`);
    console.log(`       → rowCount=${res.rowCount}${res.rowCount ? `  wallet_addr=${res.rows[0].wallet_addr}  verified=${res.rows[0].verified}` : ''}`);

    if (!res.rowCount) {
      throw new WalletNotFoundError(userId);
    }

    const row = res.rows[0];
    if (!row.verified) {
      throw new WalletNotVerifiedError(userId);
    }

    return row.wallet_addr;
  }

  /** provision() 완료 후 1회 호출 — DB에 매핑 저장 (UPSERT: userId당 1개 지갑 강제) */
  async saveMapping(userId: string, walletAddr: string, vaspType: VaspType): Promise<void> {
    const verified = vaspType === 'KYOBO';
    await this.pool.query(
      `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET wallet_addr = EXCLUDED.wallet_addr,
             vasp_type   = EXCLUDED.vasp_type,
             verified    = EXCLUDED.verified`,
      [userId, walletAddr, vaspType, verified],
    );
    console.log(`  [DB] UPSERT user_id='${userId}'  wallet_addr='${walletAddr}'  vasp_type='${vaspType}'  verified=${verified}`);
  }

  /** 서명 검증 완료 후 verified=true 업데이트 (S29 verifyOwnership() 에서 호출) */
  async markVerified(userId: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE user_wallet_mapping SET verified = true WHERE user_id = $1`,
      [userId],
    );
    console.log(`  [DB] UPDATE user_wallet_mapping SET verified=true WHERE user_id='${userId}'  → rowCount=${res.rowCount}`);
  }

  /** 역방향 조회: 지갑 주소 → userId (감사·모니터링 용도) */
  async getUserIdByAddr(walletAddr: string): Promise<string | null> {
    const res = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM user_wallet_mapping WHERE wallet_addr = $1`,
      [walletAddr],
    );
    console.log(`  [DB] SELECT user_id FROM user_wallet_mapping WHERE wallet_addr='${walletAddr}'  → rowCount=${res.rowCount}${res.rowCount ? `  user_id=${res.rows[0].user_id}` : '  (없음)'}`);
    return res.rowCount ? res.rows[0].user_id : null;
  }
}

// ── DB 상태 출력 헬퍼 ────────────────────────────────────────────────────────

async function showDb(pool: Pool, where?: string): Promise<void> {
  const sql = where
    ? `SELECT id, user_id, wallet_addr, vasp_type, verified, created_at FROM user_wallet_mapping WHERE ${where} ORDER BY id`
    : `SELECT id, user_id, wallet_addr, vasp_type, verified, created_at FROM user_wallet_mapping ORDER BY id`;
  const res = await pool.query(sql);
  console.table(res.rows);
}

// ── 섹션 함수 ─────────────────────────────────────────────────────────────────

async function section1(pool: Pool): Promise<void> {
  console.log('[1] 미등록 userId → WalletNotFoundError');
  const svc = new WalletMappingService(pool);

  let err: unknown;
  try {
    await svc.getWalletAddr('K-99999');
  } catch (e) {
    err = e;
  }

  console.log('  에러 클래스:', (err as Error).constructor.name);
  console.log('  에러 메시지:', (err as Error).message);
}

async function section2(pool: Pool): Promise<void> {
  console.log('[2] EXTERNAL 등록 → verified=false → WalletNotVerifiedError');
  const svc = new WalletMappingService(pool);

  await svc.saveMapping('K-28240001', '0xEEEE000000000000000000000000000000000001', 'EXTERNAL');
  await showDb(pool, `user_id = 'K-28240001'`);

  let err: unknown;
  try {
    await svc.getWalletAddr('K-28240001');
  } catch (e) {
    err = e;
  }

  console.log('  에러 클래스:', (err as Error).constructor.name);
  console.log('  에러 메시지:', (err as Error).message);
}

async function section3(pool: Pool): Promise<void> {
  console.log('[3] markVerified() → verified=true → 정상 반환');
  const svc = new WalletMappingService(pool);

  await svc.saveMapping('K-28240001', '0xEEEE000000000000000000000000000000000001', 'EXTERNAL');
  await svc.markVerified('K-28240001');
  await showDb(pool, `user_id = 'K-28240001'`);

  const addr = await svc.getWalletAddr('K-28240001');
  console.log('  getWalletAddr 결과:', addr);
}

async function section4(pool: Pool): Promise<void> {
  console.log('[4] KYOBO 방식 → 즉시 verified=true');
  const svc = new WalletMappingService(pool);

  await svc.saveMapping('K-28240002', '0xBBBB000000000000000000000000000000000002', 'KYOBO');
  await showDb(pool, `user_id = 'K-28240002'`);

  const addr = await svc.getWalletAddr('K-28240002');
  console.log('  getWalletAddr 결과:', addr, '← 즉시 성공');
}

async function section5(pool: Pool): Promise<void> {
  console.log('[5] 지갑 교체 — UPSERT (1:1 강제)');
  const svc = new WalletMappingService(pool);

  const OLD_ADDR = '0xCCCC000000000000000000000000000000000001';
  const NEW_ADDR = '0xCCCC000000000000000000000000000000000002';

  // 초기 등록
  await svc.saveMapping('K-28240003', OLD_ADDR, 'EXTERNAL');
  console.log('  [교체 전] DB 상태');
  await showDb(pool, `user_id = 'K-28240003'`);

  // 지갑 교체
  await svc.saveMapping('K-28240003', NEW_ADDR, 'EXTERNAL');
  console.log('  [교체 후] DB 상태');
  await showDb(pool, `user_id = 'K-28240003'`);

  // 역방향 조회
  const oldOwner = await svc.getUserIdByAddr(OLD_ADDR);
  const newOwner = await svc.getUserIdByAddr(NEW_ADDR);
  console.log('  OLD_ADDR 역방향 조회:', oldOwner, '← null (교체로 무효화)');
  console.log('  NEW_ADDR 역방향 조회:', newOwner, '← K-28240003');
}

async function section6(pool: Pool): Promise<void> {
  console.log('[6] 역방향 조회 getUserIdByAddr()');
  const svc = new WalletMappingService(pool);

  const WALLET_ADDR = '0xDDDD000000000000000000000000000000000004';
  await svc.saveMapping('K-28240004', WALLET_ADDR, 'KYOBO');

  const userId = await svc.getUserIdByAddr(WALLET_ADDR);
  console.log('  등록된 주소 조회 결과:', userId, '← K-28240004');

  const unknown = await svc.getUserIdByAddr('0x0000000000000000000000000000000000000000');
  console.log('  미등록 주소 조회 결과:', unknown, '← null');
}

async function section7(pool: Pool): Promise<void> {
  console.log('[7] 컨트롤러 에러 분류 시뮬레이션');
  const svc = new WalletMappingService(pool);

  // 케이스 데이터 준비
  await svc.saveMapping('K-28240005', '0xEEEE000000000000000000000000000000000005', 'EXTERNAL');  // verified=false
  await svc.saveMapping('K-28240006', '0xEEEE000000000000000000000000000000000006', 'KYOBO');     // verified=true

  async function simulateController(userId: string): Promise<{ userId: string; status: number; body: string }> {
    try {
      const addr = await svc.getWalletAddr(userId);
      return { userId, status: 200, body: `wallet=${addr}` };
    } catch (err) {
      if (err instanceof WalletNotFoundError)    return { userId, status: 404, body: err.message };
      if (err instanceof WalletNotVerifiedError) return { userId, status: 403, body: err.message };
      return { userId, status: 500, body: (err as Error).message };
    }
  }

  console.log('  K-99998  (미등록)     →', await simulateController('K-99998'));
  console.log('  K-28240005 (미검증)   →', await simulateController('K-28240005'));
  console.log('  K-28240006 (KYOBO)    →', await simulateController('K-28240006'));
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
  const pool = new Pool({
    host:     'localhost',
    port:     5434,
    database: 'kyobo_exercise',
    user:     'kyobo',
    password: 'kyobo',
  });

  const arg = process.argv[2];

  if (arg && SECTIONS[arg]) {
    // 단일 섹션 실행
    await pool.query('TRUNCATE TABLE user_wallet_mapping RESTART IDENTITY');
    console.log(`=== S28: 섹션 [${arg}] ===\n`);
    await SECTIONS[arg]!(pool);
  } else {
    // 전체 실행
    await pool.query('TRUNCATE TABLE user_wallet_mapping RESTART IDENTITY');
    console.log('=== S28: 지갑 매핑 설계 — userId ↔ walletAddr 전체 실행 ===\n');
    for (const [num, fn] of Object.entries(SECTIONS)) {
      await fn(pool);
      console.log();
    }
    console.log('[최종] user_wallet_mapping 전체 조회');
    await showDb(pool);
  }

  await pool.end();
  console.log('\nS28 완료');
})();
