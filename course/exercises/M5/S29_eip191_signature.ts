/**
 * S29 실습 — 블록체인 서명 기반 지갑 소유권 증명 원리
 *
 * 사전 준비:
 *   npm run exercise:s27:db:up      ← S27과 같은 DB 사용
 *
 * 실행:
 *   npm run exercise:s29            → 전체 실행
 *   npm run exercise:s29:1          → [1] EIP-191 실제 서명 흐름 (ethers.js)
 *   npm run exercise:s29:2          → [2] 올바른 서명 → verifyOwnership → verified=true
 *   npm run exercise:s29:3          → [3] 잘못된 서명 → false → DB 변화 없음
 *   npm run exercise:s29:4          → [4] nonce 재사용 방지 (replay attack)
 *   npm run exercise:s29:5          → [5] 미발급 nonce → false
 *   npm run exercise:s29:6          → [6] 주소 대소문자 정규화 (EIP-55 checksum)
 *   npm run exercise:s29:7          → [7] 지갑 교체 시나리오
 */

import { createHash } from 'crypto';
import { ethers }     from 'ethers';
import { Pool }       from 'pg';

// ── 타입 정의 ─────────────────────────────────────────────────────────────────

type VaspType = 'EXTERNAL' | 'KYOBO';

interface SignatureVerifier {
  recoverAddress(message: string, signature: string): Promise<string>;
}

// ── EthersSignatureVerifier — 실제 EIP-191 검증 ──────────────────────────────
//
// ethers.verifyMessage()가 "\x19Ethereum Signed Message:\n{len}{msg}" 접두사를
// 자동으로 처리한다. 접두사가 없으면 ecrecover 결과가 달라짐 (피싱 방지 목적).

class EthersSignatureVerifier implements SignatureVerifier {
  async recoverAddress(message: string, signature: string): Promise<string> {
    return ethers.verifyMessage(message, signature);
  }
}

// ── WalletMappingService — S29 확장 버전 ─────────────────────────────────────
//
// nonce: in-memory Map (운영에서는 Redis — TTL 5분)
// wallet: PostgreSQL (user_wallet_mapping 테이블)
//
// 검증 순서 (반드시 이 순서로!):
//   ① nonce 확인   — cheap check (DB/ECDSA 연산 전 DoS 방지)
//   ② ecrecover    — ECDSA 서명 복원 (연산 비용 높음, nonce 확인 후 실행)
//   ③ 주소 일치    — lowercase 정규화 필수 (EIP-55 checksum 차이 방지)
//   ④ nonce 무효화 — 검증 성공 후에만 (실패 시 재시도 허용)
//   ⑤ DB markVerified — verified=true 업데이트

export class WalletMappingService {
  private readonly nonceStore = new Map<string, string>();  // userId → nonce

  constructor(
    private readonly pool:        Pool,
    private readonly sigVerifier: SignatureVerifier,
  ) {}

  // ── nonce 발급 ──────────────────────────────────────────────────────────────

  generateNonce(userId: string): string {
    const raw = `${userId}:${Date.now()}:${Math.random()}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  async issueNonce(userId: string): Promise<string> {
    const nonce = this.generateNonce(userId);
    this.nonceStore.set(userId, nonce);
    console.log(`  [NONCE] issueNonce  userId='${userId}'  nonce='${nonce}'`);
    return nonce;
  }

  // ── 지갑 등록 (S27 provision 이후 호출 — UPSERT) ──────────────────────────

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

  // ── EIP-191 서명 기반 소유권 검증 ──────────────────────────────────────────

  async verifyOwnership(params: {
    userId:     string;
    walletAddr: string;
    signature:  string;
    nonce:      string;
  }): Promise<boolean> {
    const { userId, walletAddr, signature, nonce } = params;

    // ① nonce 확인 (cheap check — ECDSA 연산 전에 수행)
    const storedNonce = this.nonceStore.get(userId) ?? null;
    console.log(`  [NONCE] check  userId='${userId}'  stored='${storedNonce}'  given='${nonce}'`);
    if (!storedNonce || storedNonce !== nonce) {
      console.log(`  [NONCE] 불일치 또는 미발급 → false 반환`);
      return false;
    }

    // ② 서명에서 주소 복원 (ECDSA ecrecover)
    const message   = `Kyobo Digital Asset Wallet: ${userId}:${nonce}`;
    const recovered = await this.sigVerifier.recoverAddress(message, signature);
    console.log(`  [SIG]   recovered='${recovered}'  claimed='${walletAddr}'`);

    // ③ 복원 주소 일치 확인 (lowercase 정규화)
    if (recovered.toLowerCase() !== walletAddr.toLowerCase()) {
      console.log(`  [SIG]   주소 불일치 → false 반환`);
      return false;
    }

    // ④ nonce 무효화 (재생 공격 방지 — 성공 후에만)
    this.nonceStore.delete(userId);
    console.log(`  [NONCE] 무효화 완료`);

    // ⑤ DB markVerified
    const res = await this.pool.query(
      `UPDATE user_wallet_mapping SET verified = true WHERE user_id = $1`,
      [userId],
    );
    console.log(`  [DB] UPDATE verified=true WHERE user_id='${userId}'  → rowCount=${res.rowCount}`);

    return true;
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

async function section1(_pool: Pool): Promise<void> {
  console.log('[1] EIP-191 실제 서명 흐름 (ethers.js)');

  const wallet  = ethers.Wallet.createRandom();
  const userId  = 'K-29240001';
  const nonce   = createHash('sha256').update(`${userId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16);
  const message = `Kyobo Digital Asset Wallet: ${userId}:${nonce}`;

  console.log(`  [WALLET] address    ${wallet.address}`);
  console.log(`  [WALLET] privateKey ${wallet.privateKey}  ← 교육용, 절대 실제 키 노출 금지`);
  console.log(`  [MSG]    ${message}`);

  const signature = await wallet.signMessage(message);
  console.log(`  [SIG]    ${signature}`);

  const recovered = ethers.verifyMessage(message, signature);
  console.log(`  [RECOVER] ${recovered}`);
  console.log(`  [CHECK]   일치: ${recovered.toLowerCase() === wallet.address.toLowerCase()}`);
}

async function section2(pool: Pool): Promise<void> {
  console.log('[2] 올바른 서명 → verifyOwnership → verified=true');

  const wallet = ethers.Wallet.createRandom();
  const svc    = new WalletMappingService(pool, new EthersSignatureVerifier());

  // S27 provision 후 상태 재현 (EXTERNAL → verified=false)
  await svc.saveMapping('K-29240001', wallet.address, 'EXTERNAL');
  await showDb(pool, `user_id = 'K-29240001'`);

  const nonce     = await svc.issueNonce('K-29240001');
  const message   = `Kyobo Digital Asset Wallet: K-29240001:${nonce}`;
  const signature = await wallet.signMessage(message);

  const result = await svc.verifyOwnership({
    userId:     'K-29240001',
    walletAddr: wallet.address,
    signature,
    nonce,
  });

  console.log(`  verifyOwnership 결과: ${result}`);
  await showDb(pool, `user_id = 'K-29240001'`);
}

async function section3(pool: Pool): Promise<void> {
  console.log('[3] 잘못된 서명 → false → DB 변화 없음');

  const wallet      = ethers.Wallet.createRandom();
  const wrongWallet = ethers.Wallet.createRandom();  // 다른 키로 서명
  const svc         = new WalletMappingService(pool, new EthersSignatureVerifier());

  await svc.saveMapping('K-29240002', wallet.address, 'EXTERNAL');

  const nonce     = await svc.issueNonce('K-29240002');
  const message   = `Kyobo Digital Asset Wallet: K-29240002:${nonce}`;
  const badSig    = await wrongWallet.signMessage(message);  // 다른 지갑이 서명

  const result = await svc.verifyOwnership({
    userId:     'K-29240002',
    walletAddr: wallet.address,
    signature:  badSig,
    nonce,
  });

  console.log(`  verifyOwnership 결과: ${result}  (false 예상)`);
  await showDb(pool, `user_id = 'K-29240002'`);
  console.log(`  → verified 여전히 false  DB 변화 없음`);
}

async function section4(pool: Pool): Promise<void> {
  console.log('[4] nonce 재사용 방지 (replay attack)');

  const wallet = ethers.Wallet.createRandom();
  const svc    = new WalletMappingService(pool, new EthersSignatureVerifier());

  await svc.saveMapping('K-29240003', wallet.address, 'EXTERNAL');

  const nonce     = await svc.issueNonce('K-29240003');
  const message   = `Kyobo Digital Asset Wallet: K-29240003:${nonce}`;
  const signature = await wallet.signMessage(message);

  const first  = await svc.verifyOwnership({ userId: 'K-29240003', walletAddr: wallet.address, signature, nonce });
  console.log(`  1차 검증 결과: ${first}  (true 예상)`);

  // 같은 nonce·서명 재전송 (재생 공격 시뮬레이션)
  const second = await svc.verifyOwnership({ userId: 'K-29240003', walletAddr: wallet.address, signature, nonce });
  console.log(`  2차 검증 결과: ${second}  (false 예상 — nonce 이미 무효화)`);
}

async function section5(pool: Pool): Promise<void> {
  console.log('[5] 미발급 nonce → false (nonce 없이 서명 전송)');

  const wallet = ethers.Wallet.createRandom();
  const svc    = new WalletMappingService(pool, new EthersSignatureVerifier());

  await svc.saveMapping('K-29240004', wallet.address, 'EXTERNAL');

  const fakeNonce = 'never-issued-nonce';
  const message   = `Kyobo Digital Asset Wallet: K-29240004:${fakeNonce}`;
  const signature = await wallet.signMessage(message);

  const result = await svc.verifyOwnership({
    userId:     'K-29240004',
    walletAddr: wallet.address,
    signature,
    nonce:      fakeNonce,
  });

  console.log(`  verifyOwnership 결과: ${result}  (false 예상 — nonce 미발급)`);
}

async function section6(pool: Pool): Promise<void> {
  console.log('[6] 주소 대소문자 정규화 (EIP-55 checksum)');

  const wallet = ethers.Wallet.createRandom();
  const svc    = new WalletMappingService(pool, new EthersSignatureVerifier());

  // EIP-55 checksum 형식(대소문자 혼합) vs lowercase 주소
  const checksumAddr = wallet.address;                         // 예: 0xAbCd...
  const upperAddr    = checksumAddr.toUpperCase().replace('0X', '0x');  // 예: 0xABCD...

  console.log(`  checksum 주소:  ${checksumAddr}`);
  console.log(`  upper 주소:     ${upperAddr}`);

  await svc.saveMapping('K-29240005', checksumAddr, 'EXTERNAL');

  const nonce     = await svc.issueNonce('K-29240005');
  const message   = `Kyobo Digital Asset Wallet: K-29240005:${nonce}`;
  const signature = await wallet.signMessage(message);

  // walletAddr를 uppercase로 전달해도 toLowerCase() 비교 덕분에 통과
  const result = await svc.verifyOwnership({
    userId:     'K-29240005',
    walletAddr: upperAddr,
    signature,
    nonce,
  });

  console.log(`  verifyOwnership 결과: ${result}  (true 예상 — lowercase 정규화 동작)`);
}

async function section7(pool: Pool): Promise<void> {
  console.log('[7] 지갑 교체 시나리오 — 재등록 후 최신 주소로 verified');

  const oldWallet = ethers.Wallet.createRandom();
  const newWallet = ethers.Wallet.createRandom();
  const svc       = new WalletMappingService(pool, new EthersSignatureVerifier());

  // 초기 등록
  await svc.saveMapping('K-29240006', oldWallet.address, 'EXTERNAL');
  console.log('  [등록] 구 지갑');
  await showDb(pool, `user_id = 'K-29240006'`);

  // 구 지갑으로 검증
  const nonce1 = await svc.issueNonce('K-29240006');
  const msg1   = `Kyobo Digital Asset Wallet: K-29240006:${nonce1}`;
  const sig1   = await oldWallet.signMessage(msg1);
  const r1     = await svc.verifyOwnership({ userId: 'K-29240006', walletAddr: oldWallet.address, signature: sig1, nonce: nonce1 });
  console.log(`  구 지갑 검증: ${r1}`);
  await showDb(pool, `user_id = 'K-29240006'`);

  // 지갑 교체 (새 지갑으로 UPSERT — verified 다시 false)
  await svc.saveMapping('K-29240006', newWallet.address, 'EXTERNAL');
  console.log('  [교체] 신 지갑 등록');
  await showDb(pool, `user_id = 'K-29240006'`);

  // 새 지갑으로 검증
  const nonce2 = await svc.issueNonce('K-29240006');
  const msg2   = `Kyobo Digital Asset Wallet: K-29240006:${nonce2}`;
  const sig2   = await newWallet.signMessage(msg2);
  const r2     = await svc.verifyOwnership({ userId: 'K-29240006', walletAddr: newWallet.address, signature: sig2, nonce: nonce2 });
  console.log(`  신 지갑 검증: ${r2}`);
  await showDb(pool, `user_id = 'K-29240006'`);
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
    await pool.query('TRUNCATE TABLE user_wallet_mapping RESTART IDENTITY');
    console.log(`=== S29: 섹션 [${arg}] ===\n`);
    await SECTIONS[arg]!(pool);
  } else {
    await pool.query('TRUNCATE TABLE user_wallet_mapping RESTART IDENTITY');
    console.log('=== S29: EIP-191 서명 기반 지갑 소유권 증명 — 전체 실행 ===\n');
    for (const [num, fn] of Object.entries(SECTIONS)) {
      await fn(pool);
      console.log();
    }
    console.log('[최종] user_wallet_mapping 전체 조회');
    await showDb(pool);
  }

  await pool.end();
  console.log('\nS29 완료');
})();
