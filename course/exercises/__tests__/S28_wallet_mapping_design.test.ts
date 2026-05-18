/**
 * S28 채점 — 온체인 식별자와 내부 사용자 ID의 매핑 설계
 *
 * 채점 기준:
 *   · 미등록 userId → WalletNotFoundError
 *   · verified=false 지갑 → WalletNotVerifiedError
 *   · saveMapping() upsert — userId당 1개 지갑 강제
 *   · KYOBO 방식 → 즉시 verified=true
 *   · 역방향 조회 getUserIdByAddr()
 */

import {
  WalletMappingService,
  WalletNotFoundError,
  WalletNotVerifiedError,
} from '../M5/S28_wallet_mapping_design';

// ── InMemoryWalletRepo 재현 (S28 내부 클래스이므로 테스트 내에서 재구현) ─────────

type VaspType = 'EXTERNAL' | 'KYOBO';

interface WalletRecord {
  id:         number;
  userId:     string;
  walletAddr: string;
  vaspType:   VaspType;
  verified:   boolean;
  createdAt:  Date;
}

class TestWalletRepo {
  private store    = new Map<string, WalletRecord>();
  private byAddr   = new Map<string, string>();
  private sequence = 0;

  async findByUserId(userId: string): Promise<WalletRecord | null> {
    return this.store.get(userId) ?? null;
  }

  async findByWalletAddr(walletAddr: string): Promise<WalletRecord | null> {
    const userId = this.byAddr.get(walletAddr.toLowerCase());
    if (!userId) return null;
    return this.store.get(userId) ?? null;
  }

  async upsert(record: Omit<WalletRecord, 'id' | 'createdAt'>): Promise<WalletRecord> {
    const existing = this.store.get(record.userId);
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

// ── 채점 테스트 ───────────────────────────────────────────────────────────────

describe('S28 채점 — 지갑 매핑 설계', () => {

  describe('[1] WalletNotFoundError — 미등록 userId', () => {
    it('TODO: 미등록 userId → WalletNotFoundError 발생', async () => {
      const repo = new TestWalletRepo();
      const svc  = new WalletMappingService(repo as any);
      await expect(svc.getWalletAddr('K-99999')).rejects.toBeInstanceOf(WalletNotFoundError);
    });

    it('TODO: WalletNotFoundError 메시지에 userId 포함', async () => {
      const repo = new TestWalletRepo();
      const svc  = new WalletMappingService(repo as any);
      await expect(svc.getWalletAddr('K-99999')).rejects.toThrow('K-99999');
    });

    it('TODO: WalletNotFoundError는 Error를 상속한다', () => {
      const err = new WalletNotFoundError('K-99999');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('WalletNotFoundError');
    });

    it('TODO: getWalletAddr 실패 시 자동으로 지갑 생성하지 않는다', async () => {
      const repo = new TestWalletRepo();
      const svc  = new WalletMappingService(repo as any);
      try { await svc.getWalletAddr('K-AUTO'); } catch {}
      expect(repo.count()).toBe(0);
    });
  });

  describe('[2] WalletNotVerifiedError — verified=false 지갑', () => {
    it('TODO: EXTERNAL 등록 직후 verified=false → WalletNotVerifiedError', async () => {
      const repo = new TestWalletRepo();
      const svc  = new WalletMappingService(repo as any);
      await svc.saveMapping('K-20240001', '0xAbCd1234Ef5678901234567890abcdef01234567', 'EXTERNAL');
      await expect(svc.getWalletAddr('K-20240001')).rejects.toBeInstanceOf(WalletNotVerifiedError);
    });

    it('TODO: WalletNotVerifiedError 메시지에 userId 포함', async () => {
      const repo = new TestWalletRepo();
      const svc  = new WalletMappingService(repo as any);
      await svc.saveMapping('K-20240001', '0xAbCd1234Ef5678901234567890abcdef01234567', 'EXTERNAL');
      await expect(svc.getWalletAddr('K-20240001')).rejects.toThrow('K-20240001');
    });

    it('TODO: WalletNotVerifiedError는 Error를 상속한다', () => {
      const err = new WalletNotVerifiedError('K-20240001');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('WalletNotVerifiedError');
    });

    it('TODO: markVerified() 후 getWalletAddr() 정상 반환', async () => {
      const repo = new TestWalletRepo();
      const svc  = new WalletMappingService(repo as any);
      const ADDR = '0xAbCd1234Ef5678901234567890abcdef01234567';
      await svc.saveMapping('K-20240001', ADDR, 'EXTERNAL');
      await svc.markVerified('K-20240001');
      const addr = await svc.getWalletAddr('K-20240001');
      expect(addr).toBe(ADDR);
    });
  });

  describe('[3] KYOBO 방식 → 즉시 verified=true', () => {
    it('TODO: KYOBO saveMapping 후 markVerified 없이 발행 가능', async () => {
      const repo = new TestWalletRepo();
      const svc  = new WalletMappingService(repo as any);
      await svc.saveMapping('K-20240002', '0xb10c0000000000000000000000000000000000b2', 'KYOBO');
      await expect(svc.getWalletAddr('K-20240002')).resolves.toBeTruthy();
    });

    it('TODO: KYOBO 지갑 주소가 0x로 시작함', async () => {
      const repo = new TestWalletRepo();
      const svc  = new WalletMappingService(repo as any);
      const ADDR = '0xb10c0000000000000000000000000000000000b2';
      await svc.saveMapping('K-20240002', ADDR, 'KYOBO');
      const addr = await svc.getWalletAddr('K-20240002');
      expect(addr.startsWith('0x')).toBe(true);
    });
  });

  describe('[4] upsert 1:1 매핑 강제', () => {
    it('TODO: 지갑 교체 후 새 주소 반환', async () => {
      const repo     = new TestWalletRepo();
      const svc      = new WalletMappingService(repo as any);
      const OLD_ADDR = '0x01d000000000000000000000000000000000000a';
      const NEW_ADDR = '0x0e0000000000000000000000000000000000b000';
      await svc.saveMapping('K-20240003', OLD_ADDR, 'EXTERNAL');
      await svc.markVerified('K-20240003');
      await svc.saveMapping('K-20240003', NEW_ADDR, 'EXTERNAL');
      await svc.markVerified('K-20240003');
      const addr = await svc.getWalletAddr('K-20240003');
      expect(addr).toBe(NEW_ADDR);
    });

    it('TODO: upsert — 동일 userId 재저장 시 레코드 수 변화 없음', async () => {
      const repo = new TestWalletRepo();
      const svc  = new WalletMappingService(repo as any);
      await svc.saveMapping('K-20240003', '0xadd0000000000000000000000000000000000aa', 'EXTERNAL');
      const before = repo.count();
      await svc.saveMapping('K-20240003', '0xadd0000000000000000000000000000000000bb', 'EXTERNAL');
      const after = repo.count();
      expect(before).toBe(after);
    });
  });

  describe('[5] 역방향 조회 getUserIdByAddr()', () => {
    it('TODO: 새 주소로 역방향 조회 → userId 반환', async () => {
      const repo     = new TestWalletRepo();
      const svc      = new WalletMappingService(repo as any);
      const NEW_ADDR = '0x0e0000000000000000000000000000000000b000';
      await svc.saveMapping('K-20240003', '0x01d000000000000000000000000000000000000a', 'EXTERNAL');
      await svc.saveMapping('K-20240003', NEW_ADDR, 'EXTERNAL');
      const userId = await svc.getUserIdByAddr(NEW_ADDR);
      expect(userId).toBe('K-20240003');
    });

    it('TODO: 이전 주소 역방향 조회 → null', async () => {
      const repo     = new TestWalletRepo();
      const svc      = new WalletMappingService(repo as any);
      const OLD_ADDR = '0x01d000000000000000000000000000000000000a';
      const NEW_ADDR = '0x0e0000000000000000000000000000000000b000';
      await svc.saveMapping('K-20240003', OLD_ADDR, 'EXTERNAL');
      await svc.saveMapping('K-20240003', NEW_ADDR, 'EXTERNAL');
      const oldOwner = await svc.getUserIdByAddr(OLD_ADDR);
      expect(oldOwner).toBeNull();
    });

    it('TODO: 미등록 주소 → null 반환', async () => {
      const repo = new TestWalletRepo();
      const svc  = new WalletMappingService(repo as any);
      const result = await svc.getUserIdByAddr('0x0000000000000000000000000000000000000000');
      expect(result).toBeNull();
    });

    it('TODO: 대소문자 정규화 — lowercase 주소로도 조회 가능', async () => {
      const repo = new TestWalletRepo();
      const svc  = new WalletMappingService(repo as any);
      const ADDR = '0xAbCd1234Ef5678901234567890abcdef01234567';
      await svc.saveMapping('K-20240010', ADDR, 'KYOBO');
      const userId = await svc.getUserIdByAddr(ADDR.toLowerCase());
      expect(userId).toBe('K-20240010');
    });
  });
});
