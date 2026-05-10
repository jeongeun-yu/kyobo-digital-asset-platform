/**
 * S27 채점 — 지갑 프로비저닝 · VASP별 분기
 *
 * 채점 기준:
 *   · EXTERNAL → vaspClient.getWalletAddr() 호출 → 0x... 주소 반환
 *   · KYOBO    → vaspClient.createWallet() 호출 → 0x... 주소 반환
 *   · 미지원 vaspType → UnsupportedVaspError 발생
 *   · saveMapping() 성공 시에만 호출됨 (에러 시 미호출)
 */

import { WalletProvisioningService, UnsupportedVaspError } from '../M5/S27_wallet_provisioning';

// ── Mock 구현체 ────────────────────────────────────────────────────────────────

function buildDeps(overrides: { getWalletAddrFail?: boolean; createWalletFail?: boolean } = {}) {
  const calls = { getWalletAddr: 0, createWallet: 0, saveMapping: 0 };
  const savedMappings: Array<{ userId: string; walletAddr: string; vaspType: string }> = [];

  const vaspClient = {
    async getWalletAddr(userId: string): Promise<string> {
      calls.getWalletAddr++;
      if (overrides.getWalletAddrFail) throw new Error('VASP getWalletAddr failed');
      return `0x${'external' + userId}`.padEnd(42, '0').slice(0, 42);
    },
    async createWallet(userId: string): Promise<string> {
      calls.createWallet++;
      if (overrides.createWalletFail) throw new Error('VASP createWallet failed');
      return `0x${'kyobo' + userId}`.padEnd(42, '0').slice(0, 42);
    },
  };

  const walletMapping = {
    async saveMapping(userId: string, walletAddr: string, vaspType: 'EXTERNAL' | 'KYOBO'): Promise<void> {
      calls.saveMapping++;
      savedMappings.push({ userId, walletAddr, vaspType });
    },
  };

  return { vaspClient, walletMapping, calls, savedMappings };
}

// ── 채점 테스트 ───────────────────────────────────────────────────────────────

describe('S27 채점 — 지갑 프로비저닝', () => {

  describe('[1] EXTERNAL → vaspClient.getWalletAddr() 호출', () => {
    it('TODO: EXTERNAL VASP → 외부 지갑 주소 반환', async () => {
      const { vaspClient, walletMapping } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      const result = await svc.provision('K-20240001', 'EXTERNAL');
      expect(result.walletAddress).toMatch(/^0x/);
    });

    it('TODO: EXTERNAL → vaspType 필드 = EXTERNAL', async () => {
      const { vaspClient, walletMapping } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      const result = await svc.provision('K-20240001', 'EXTERNAL');
      expect(result.vaspType).toBe('EXTERNAL');
    });

    it('TODO: EXTERNAL → userId 필드 일치', async () => {
      const { vaspClient, walletMapping } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      const result = await svc.provision('K-20240001', 'EXTERNAL');
      expect(result.userId).toBe('K-20240001');
    });

    it('TODO: EXTERNAL → provisionedAt이 Date 타입', async () => {
      const { vaspClient, walletMapping } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      const result = await svc.provision('K-20240001', 'EXTERNAL');
      expect(result.provisionedAt).toBeInstanceOf(Date);
    });

    it('TODO: EXTERNAL → saveMapping() 1회 호출됨', async () => {
      const { vaspClient, walletMapping, calls } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      await svc.provision('K-20240001', 'EXTERNAL');
      expect(calls.saveMapping).toBe(1);
    });

    it('TODO: EXTERNAL → getWalletAddr() 1회, createWallet() 0회', async () => {
      const { vaspClient, walletMapping, calls } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      await svc.provision('K-20240001', 'EXTERNAL');
      expect(calls.getWalletAddr).toBe(1);
      expect(calls.createWallet).toBe(0);
    });
  });

  describe('[2] KYOBO → vaspClient.createWallet() 호출', () => {
    it('TODO: KYOBO VASP → 신규 지갑 주소 반환', async () => {
      const { vaspClient, walletMapping } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      const result = await svc.provision('K-20240002', 'KYOBO');
      expect(result.walletAddress).toMatch(/^0x/);
    });

    it('TODO: KYOBO → vaspType 필드 = KYOBO', async () => {
      const { vaspClient, walletMapping } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      const result = await svc.provision('K-20240002', 'KYOBO');
      expect(result.vaspType).toBe('KYOBO');
    });

    it('TODO: KYOBO → createWallet() 1회, getWalletAddr() 0회', async () => {
      const { vaspClient, walletMapping, calls } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      await svc.provision('K-20240002', 'KYOBO');
      expect(calls.createWallet).toBe(1);
      expect(calls.getWalletAddr).toBe(0);
    });

    it('TODO: KYOBO → saveMapping() 1회 호출됨', async () => {
      const { vaspClient, walletMapping, calls } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      await svc.provision('K-20240002', 'KYOBO');
      expect(calls.saveMapping).toBe(1);
    });
  });

  describe('[3] UnsupportedVaspError — 미지원 vaspType', () => {
    it('TODO: 미지원 vaspType → UnsupportedVaspError 발생', async () => {
      const { vaspClient, walletMapping } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      await expect(svc.provision('K-20240003', 'UNKNOWN_VASP' as 'EXTERNAL')).rejects.toBeInstanceOf(UnsupportedVaspError);
    });

    it('TODO: UnsupportedVaspError 메시지에 vaspType 포함', async () => {
      const { vaspClient, walletMapping } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      await expect(svc.provision('K-20240003', 'LEGACY_VASP' as 'EXTERNAL')).rejects.toThrow('LEGACY_VASP');
    });

    it('TODO: UnsupportedVaspError 시 saveMapping() 미호출', async () => {
      const { vaspClient, walletMapping, calls } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      try { await svc.provision('K-20240003', 'BAD_VASP' as 'EXTERNAL'); } catch {}
      expect(calls.saveMapping).toBe(0);
    });

    it('TODO: UnsupportedVaspError는 Error를 상속한다', () => {
      const err = new UnsupportedVaspError('TEST_VASP');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('UnsupportedVaspError');
    });
  });

  describe('[4] 지갑 주소 형식 검증', () => {
    it('TODO: EXTERNAL 반환 주소는 0x로 시작하는 문자열', async () => {
      const { vaspClient, walletMapping } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      const result = await svc.provision('K-20240004', 'EXTERNAL');
      expect(typeof result.walletAddress).toBe('string');
      expect(result.walletAddress.startsWith('0x')).toBe(true);
    });

    it('TODO: KYOBO 반환 주소는 0x로 시작하는 문자열', async () => {
      const { vaspClient, walletMapping } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      const result = await svc.provision('K-20240004', 'KYOBO');
      expect(typeof result.walletAddress).toBe('string');
      expect(result.walletAddress.startsWith('0x')).toBe(true);
    });

    it('TODO: saveMapping에 전달되는 walletAddr가 실제 반환 주소와 일치', async () => {
      const { vaspClient, walletMapping, savedMappings } = buildDeps();
      const svc = new WalletProvisioningService(vaspClient, walletMapping);
      const result = await svc.provision('K-20240005', 'EXTERNAL');
      expect(savedMappings[0]?.walletAddr).toBe(result.walletAddress);
    });
  });
});
