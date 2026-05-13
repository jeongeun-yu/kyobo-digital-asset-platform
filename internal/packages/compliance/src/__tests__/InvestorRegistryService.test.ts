/**
 * InvestorRegistryService 단위 테스트
 *
 * KYC 레벨 검증, 온체인 register 호출, canAccept 다단계 검증
 */

import { InvestorRegistryService } from '../securities/InvestorRegistryService';
import type { PartitionLimit } from '../securities/InvestorRegistryService';
import type { IKYCProvider, KYCStatus } from '../interfaces/IKYCProvider';

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function makeKYC(level: number): IKYCProvider {
  const status: KYCStatus = {
    userId:     'user-001',
    address:    '0xinvestor',
    level,
    verifiedAt: Math.floor(Date.now() / 1000) - 3600,
  };
  return {
    getStatus:          async () => status,
    getStatusByAddress: async () => status,
    isVerified:         async (_addr, minLevel) => level >= minLevel,
    register:           async () => {},
    revoke:             async () => {},
  };
}

function makeOnchain(overrides: Partial<{
  isRegistered: boolean;
  limit: PartitionLimit;
}> = {}) {
  const limit: PartitionLimit = overrides.limit ?? {
    maxHolding:     0n,
    currentHolding: 0n,
    lockedUntil:    0,
  };
  return {
    register:         jest.fn().mockResolvedValue('0xtxhash'),
    revoke:           jest.fn().mockResolvedValue('0xtxhash'),
    isRegistered:     jest.fn().mockResolvedValue(overrides.isRegistered ?? true),
    getPartitionLimit: jest.fn().mockResolvedValue(limit),
    setLockup:        jest.fn().mockResolvedValue('0xtxhash'),
  };
}

const PARTITION = '0x' + Buffer.from('INSURANCE_CLASS_A').toString('hex').padEnd(64, '0');

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('InvestorRegistryService.registerInvestor()', () => {
  it('KYC level 3 → 온체인 register 호출 후 txHash 반환', async () => {
    const onchain = makeOnchain();
    const svc = new InvestorRegistryService(makeKYC(3), onchain);

    const result = await svc.registerInvestor({
      userId: 'user-001', address: '0xinvestor', investorType: 'RETAIL',
    });

    expect(result.txHash).toBe('0xtxhash');
    expect(onchain.register).toHaveBeenCalledTimes(1);
  });

  it('PROFESSIONAL 투자자 → typeCode 2로 register 호출', async () => {
    const onchain = makeOnchain();
    const svc = new InvestorRegistryService(makeKYC(3), onchain);

    await svc.registerInvestor({
      userId: 'user-001', address: '0xinvestor', investorType: 'PROFESSIONAL',
    });

    expect(onchain.register).toHaveBeenCalledWith('0xinvestor', 2);
  });

  it('RETAIL 투자자 → typeCode 1로 register 호출', async () => {
    const onchain = makeOnchain();
    const svc = new InvestorRegistryService(makeKYC(3), onchain);

    await svc.registerInvestor({
      userId: 'user-001', address: '0xinvestor', investorType: 'RETAIL',
    });

    expect(onchain.register).toHaveBeenCalledWith('0xinvestor', 1);
  });

  it('KYC level 2 → 에러 throw (STO 미충족)', async () => {
    const svc = new InvestorRegistryService(makeKYC(2), makeOnchain());

    await expect(svc.registerInvestor({
      userId: 'user-001', address: '0xinvestor', investorType: 'RETAIL',
    })).rejects.toThrow('KYC level insufficient');
  });

  it('KYC 없음(null) → 에러 throw', async () => {
    const kyc: IKYCProvider = {
      getStatus: async () => null,
      getStatusByAddress: async () => null,
      isVerified: async () => false,
      register: async () => {},
      revoke: async () => {},
    };
    const svc = new InvestorRegistryService(kyc, makeOnchain());

    await expect(svc.registerInvestor({
      userId: 'user-001', address: '0xinvestor', investorType: 'RETAIL',
    })).rejects.toThrow();
  });
});

describe('InvestorRegistryService.canAccept()', () => {
  it('미등록 주소 → allowed: false, reason: NOT_REGISTERED', async () => {
    const onchain = makeOnchain({ isRegistered: false });
    const svc = new InvestorRegistryService(makeKYC(3), onchain);

    const result = await svc.canAccept({ address: '0xunreg', partition: PARTITION, amount: 100n });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('NOT_REGISTERED');
  });

  it('락업 중인 주소 → allowed: false, reason: LOCKED_UP', async () => {
    const futureTimestamp = Math.floor(Date.now() / 1000) + 86400; // 내일
    const onchain = makeOnchain({
      isRegistered: true,
      limit: { maxHolding: 0n, currentHolding: 0n, lockedUntil: futureTimestamp },
    });
    const svc = new InvestorRegistryService(makeKYC(3), onchain);

    const result = await svc.canAccept({ address: '0xinvestor', partition: PARTITION, amount: 100n });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('LOCKED_UP');
  });

  it('보유 한도 초과 → allowed: false, reason: HOLDING_LIMIT_EXCEEDED', async () => {
    const onchain = makeOnchain({
      isRegistered: true,
      limit: { maxHolding: 1000n, currentHolding: 900n, lockedUntil: 0 },
    });
    const svc = new InvestorRegistryService(makeKYC(3), onchain);

    // 900 + 200 > 1000 → 초과
    const result = await svc.canAccept({ address: '0xinvestor', partition: PARTITION, amount: 200n });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('HOLDING_LIMIT_EXCEEDED');
  });

  it('모든 조건 통과 → allowed: true', async () => {
    const onchain = makeOnchain({
      isRegistered: true,
      limit: { maxHolding: 0n, currentHolding: 0n, lockedUntil: 0 },
    });
    const svc = new InvestorRegistryService(makeKYC(3), onchain);

    const result = await svc.canAccept({ address: '0xinvestor', partition: PARTITION, amount: 100n });
    expect(result.allowed).toBe(true);
  });

  it('락업 만료(과거 timestamp) → 락업 무시', async () => {
    const pastTimestamp = Math.floor(Date.now() / 1000) - 86400; // 어제
    const onchain = makeOnchain({
      isRegistered: true,
      limit: { maxHolding: 0n, currentHolding: 0n, lockedUntil: pastTimestamp },
    });
    const svc = new InvestorRegistryService(makeKYC(3), onchain);

    const result = await svc.canAccept({ address: '0xinvestor', partition: PARTITION, amount: 100n });
    expect(result.allowed).toBe(true);
  });
});

describe('InvestorRegistryService.setPostIssuanceLockup()', () => {
  it('daysLocked 기준 onchain.setLockup 호출', async () => {
    const onchain = makeOnchain();
    const svc = new InvestorRegistryService(makeKYC(3), onchain);
    const before = Math.floor(Date.now() / 1000);

    await svc.setPostIssuanceLockup({ address: '0xinvestor', partition: PARTITION, daysLocked: 30 });

    expect(onchain.setLockup).toHaveBeenCalledTimes(1);
    const [, , until] = onchain.setLockup.mock.calls[0] as [string, string, number];
    expect(until).toBeGreaterThanOrEqual(before + 30 * 86400 - 10);
  });
});
