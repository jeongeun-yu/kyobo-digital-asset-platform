/**
 * S28 실습 — 온체인 식별자와 내부 사용자 ID의 매핑 설계
 *
 * 강의 노트: M5_S28_wallet_mapping_design.md
 *
 * 실행 방법 (루트에서): npm run exercise:s28
 *
 * 목표:
 *   [1] WalletMappingService.getWalletAddr() — 미등록 userId → WalletNotFoundError
 *   [2] verified=false 지갑 → WalletNotVerifiedError
 *   [3] saveMapping() — 1:1 매핑 (userId당 1개 지갑) 강제
 *   [4] 역방향 조회 getUserIdByAddr()
 */

// ────────────────────────────────────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────────────────────────────────────

type VaspType = 'EXTERNAL' | 'KYOBO';

interface WalletRecord {
  id:         number;
  userId:     string;
  walletAddr: string;
  vaspType:   VaspType;
  verified:   boolean;     // false: 서명 검증 미완료 → 발행 차단
  createdAt:  Date;
}

// ────────────────────────────────────────────────────────────────────────
// 에러 클래스
//
// WalletNotFoundError:   userId에 대한 매핑 레코드 자체가 없음
// WalletNotVerifiedError: 매핑은 있으나 소유권 서명 검증 미완료
// ────────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────────
// InMemory Repository (실제 환경에서는 PostgreSQL user_wallet_mapping 테이블)
//
// 실제 DDL (참고):
//   CREATE TABLE user_wallet_mapping (
//     id          SERIAL PRIMARY KEY,
//     user_id     VARCHAR(64)  NOT NULL UNIQUE,   -- UNIQUE: userId당 1개 지갑
//     wallet_addr VARCHAR(42)  NOT NULL,
//     vasp_type   VARCHAR(16)  NOT NULL,
//     verified    BOOLEAN      NOT NULL DEFAULT FALSE,
//     created_at  TIMESTAMPTZ  DEFAULT NOW()
//   );
//   CREATE INDEX idx_wallet_mapping_addr ON user_wallet_mapping(wallet_addr);
// ────────────────────────────────────────────────────────────────────────

class InMemoryWalletRepo {
  private store    = new Map<string, WalletRecord>();   // key: userId
  private byAddr   = new Map<string, string>();          // key: walletAddr → userId
  private sequence = 0;

  async findByUserId(userId: string): Promise<WalletRecord | null> {
    return this.store.get(userId) ?? null;
  }

  async findByWalletAddr(walletAddr: string): Promise<WalletRecord | null> {
    const userId = this.byAddr.get(walletAddr.toLowerCase());
    if (!userId) return null;
    return this.store.get(userId) ?? null;
  }

  /** UNIQUE(user_id): userId당 1개 지갑만 허용 — upsert 방식으로 덮어쓰기 */
  async upsert(record: Omit<WalletRecord, 'id' | 'createdAt'>): Promise<WalletRecord> {
    const existing = this.store.get(record.userId);

    // 기존 지갑 주소 인덱스 제거 (지갑 교체 시)
    if (existing) {
      this.byAddr.delete(existing.walletAddr.toLowerCase());
    }

    const saved: WalletRecord = {
      ...record,
      id:        existing?.id ?? ++this.sequence,
      createdAt: existing?.createdAt ?? new Date(),
    };

    this.store.set(record.userId, saved);
    this.byAddr.set(record.walletAddr.toLowerCase(), record.userId);
    return saved;
  }

  async setVerified(userId: string, verified: boolean): Promise<void> {
    const record = this.store.get(userId);
    if (record) this.store.set(userId, { ...record, verified });
  }

  count(): number { return this.store.size; }
}

// ────────────────────────────────────────────────────────────────────────
// WalletMappingService
//
// 역할: 지갑 주소를 "관리"하는 역할
//   - userId ↔ walletAddr 매핑 DB 조회/저장
//   - getWalletAddr(): 발행 요청마다 호출
//   - saveMapping(): provision() 완료 후 1회 호출
// ────────────────────────────────────────────────────────────────────────

export class WalletMappingService {
  constructor(private readonly repo: InMemoryWalletRepo) {}

  /**
   * 발행 요청마다 호출되는 핵심 메서드
   * 미등록 → WalletNotFoundError (자동 생성 절대 금지)
   * 미검증 → WalletNotVerifiedError (서명 검증 후에만 발행 가능)
   */
  async getWalletAddr(userId: string): Promise<string> {
    const record = await this.repo.findByUserId(userId);

    if (!record) {
      // 자동 생성 금지: 지갑 생성은 명시적 provision() 프로세스를 통해서만
      throw new WalletNotFoundError(userId);
    }

    if (!record.verified) {
      // verified=false: 소유권 서명 검증 미완료 → 발행 차단
      throw new WalletNotVerifiedError(userId);
    }

    return record.walletAddr;
  }

  /** provision() 완료 후 1회 호출 — DB에 매핑 저장 */
  async saveMapping(userId: string, walletAddr: string, vaspType: VaspType): Promise<void> {
    // KYOBO 방식: VASP가 지갑을 생성하므로 즉시 verified=true
    // EXTERNAL 방식: 사용자가 서명으로 소유권 증명 필요 → verified=false (S29에서 처리)
    const verified = vaspType === 'KYOBO';
    await this.repo.upsert({ userId, walletAddr, vaspType, verified });
  }

  /** 서명 검증 완료 후 verified=true 업데이트 (S29 verifyOwnership() 에서 호출) */
  async markVerified(userId: string): Promise<void> {
    await this.repo.setVerified(userId, true);
  }

  /** 역방향 조회: 지갑 주소 → userId (감사·모니터링 용도) */
  async getUserIdByAddr(walletAddr: string): Promise<string | null> {
    const record = await this.repo.findByWalletAddr(walletAddr);
    return record?.userId ?? null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S28: 지갑 매핑 설계 — userId ↔ walletAddr ===\n');

  const repo    = new InMemoryWalletRepo();
  const service = new WalletMappingService(repo);

  // ── [1] 미등록 userId → WalletNotFoundError ─────────────────────────────
  console.log('[검증 1] 미등록 userId → WalletNotFoundError (자동 생성 금지)');
  let err1: unknown;
  try { await service.getWalletAddr('K-99999'); } catch (e) { err1 = e; }
  check('WalletNotFoundError 발생',               err1 instanceof WalletNotFoundError);
  check('에러 메시지에 userId 포함',               err1 instanceof Error && err1.message.includes('K-99999'));

  // ── [2] EXTERNAL 등록 후 verified=false → WalletNotVerifiedError ─────────
  console.log('\n[검증 2] EXTERNAL 등록 직후 verified=false → WalletNotVerifiedError');
  await service.saveMapping('K-20240001', '0xAbCd1234Ef5678901234567890abcdef01234567', 'EXTERNAL');
  let err2: unknown;
  try { await service.getWalletAddr('K-20240001'); } catch (e) { err2 = e; }
  check('WalletNotVerifiedError 발생',             err2 instanceof WalletNotVerifiedError);
  check('에러 메시지에 userId 포함',               err2 instanceof Error && err2.message.includes('K-20240001'));

  // ── [3] markVerified() 후 → 정상 반환 ─────────────────────────────────
  console.log('\n[검증 3] markVerified() 후 → getWalletAddr() 정상 반환');
  await service.markVerified('K-20240001');
  const addr = await service.getWalletAddr('K-20240001');
  check('지갑 주소 반환됨',                       addr === '0xAbCd1234Ef5678901234567890abcdef01234567');

  // ── [4] KYOBO 방식 → 즉시 verified=true ───────────────────────────────
  console.log('\n[검증 4] KYOBO 방식 → saveMapping() 즉시 verified=true');
  await service.saveMapping('K-20240002', '0xKyobo0000000000000000000000000000000002', 'KYOBO');
  let kyoboAddr: string | undefined;
  let err4: unknown;
  try { kyoboAddr = await service.getWalletAddr('K-20240002'); } catch (e) { err4 = e; }
  check('KYOBO 방식 즉시 발행 가능 (에러 없음)',  err4 === undefined);
  check('KYOBO 지갑 주소 반환됨',                 kyoboAddr?.startsWith('0x') === true);

  // ── [5] 1:1 강제 — 지갑 교체 시 이전 주소 무효화 ─────────────────────────
  console.log('\n[검증 5] 1:1 강제 — 지갑 교체 (기존 주소 대체)');
  const OLD_ADDR = '0xOld0000000000000000000000000000000000AA';
  const NEW_ADDR = '0xNew0000000000000000000000000000000000BB';
  await service.saveMapping('K-20240003', OLD_ADDR, 'EXTERNAL');
  await service.markVerified('K-20240003');
  await service.saveMapping('K-20240003', NEW_ADDR, 'EXTERNAL');
  await service.markVerified('K-20240003');
  const newAddr = await service.getWalletAddr('K-20240003');
  check('지갑 교체 후 새 주소 반환',              newAddr === NEW_ADDR);

  // 역방향: 이전 주소로는 조회 불가
  const oldOwner = await service.getUserIdByAddr(OLD_ADDR);
  const newOwner = await service.getUserIdByAddr(NEW_ADDR);
  check('이전 주소 역방향 조회 → null',           oldOwner === null);
  check('새 주소 역방향 조회 → K-20240003',       newOwner === 'K-20240003');

  // ── [6] DB UNIQUE(user_id) 보장 — userId당 레코드 1개만 존재 ─────────────
  console.log('\n[검증 6] UNIQUE(user_id) — 지갑 교체 후 레코드 수 변화 없음');
  const countBefore = repo.count();
  await service.saveMapping('K-20240003', '0xAnother000000000000000000000000000000CC', 'EXTERNAL');
  const countAfter = repo.count();
  check('upsert — 레코드 수 동일 (INSERT가 아닌 UPDATE)',  countBefore === countAfter);

  // ── [7] 역방향 조회 — 미등록 주소 → null ────────────────────────────────
  console.log('\n[검증 7] 역방향 조회 — 미등록 주소 → null');
  const unknown = await service.getUserIdByAddr('0x0000000000000000000000000000000000000000');
  check('미등록 주소 → null 반환',               unknown === null);

  // ── 핵심 구조 출력 ────────────────────────────────────────────────────
  console.log('\n=== S28 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. userId(교보 내부) ↔ walletAddr(블록체인)는 서로 무관한 식별자 공간');
  console.log('  2. userId를 블록체인에 직접 저장 금지 — 개인정보 삭제권 위반, 지갑 교체 불가');
  console.log('  3. verified=false 지갑으로 발행 차단 — 소유권 미증명 주소 보호');
  console.log('  4. EXTERNAL: 서명 검증 후 verified=true / KYOBO: 생성 시 즉시 verified=true');
  console.log('  5. getWalletAddr(): 미등록→WalletNotFoundError, 미검증→WalletNotVerifiedError');
  console.log('  6. UNIQUE(user_id): Phase 1은 1:1 매핑 (Phase 2+에서 1:N으로 확장)');
})();
