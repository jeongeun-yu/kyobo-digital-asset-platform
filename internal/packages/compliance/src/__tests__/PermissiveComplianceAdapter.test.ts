/**
 * PermissiveComplianceAdapter 단위 테스트
 *
 * KYC BASIC 확인, 미확인·만료·레벨 부족 케이스 검증
 */

import { PermissiveComplianceAdapter } from '../rewards/PermissiveComplianceAdapter';
import type { IKYCProvider, KYCStatus } from '../interfaces/IKYCProvider';

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function makeKYCByAddress(status: KYCStatus | null): IKYCProvider {
  return {
    getStatus:          async () => status,
    getStatusByAddress: async () => status,
    isVerified:         async (_addr, minLevel) => status !== null && status.level >= minLevel,
    register:           async () => {},
    revoke:             async () => {},
  };
}

const ACTIVE_STATUS: KYCStatus = {
  userId:     'u-001',
  address:    '0xvalid',
  level:      1,
  verifiedAt: Math.floor(Date.now() / 1000) - 3600,
  // expiredAt 없음 = 미만료
};

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('PermissiveComplianceAdapter.canReceiveNFT()', () => {
  it('KYC BASIC(1) 이상 + 미만료 → allowed: true', async () => {
    const adapter = new PermissiveComplianceAdapter(makeKYCByAddress(ACTIVE_STATUS));
    const result = await adapter.canReceiveNFT('0xvalid');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('KYC 레코드 없음 → allowed: false, reason: KYC_NOT_FOUND', async () => {
    const adapter = new PermissiveComplianceAdapter(makeKYCByAddress(null));
    const result = await adapter.canReceiveNFT('0xunknown');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('KYC_NOT_FOUND');
  });

  it('KYC level 0 → allowed: false, reason: KYC_LEVEL_INSUFFICIENT', async () => {
    const status: KYCStatus = { ...ACTIVE_STATUS, level: 0 };
    const adapter = new PermissiveComplianceAdapter(makeKYCByAddress(status));
    const result = await adapter.canReceiveNFT('0xaddress');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('KYC_LEVEL_INSUFFICIENT');
  });

  it('KYC 만료(expiredAt 과거) → allowed: false, reason: KYC_EXPIRED', async () => {
    const expired: KYCStatus = {
      ...ACTIVE_STATUS,
      expiredAt: Math.floor(Date.now() / 1000) - 1,  // 방금 전 만료
    };
    const adapter = new PermissiveComplianceAdapter(makeKYCByAddress(expired));
    const result = await adapter.canReceiveNFT('0xexpired');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('KYC_EXPIRED');
  });

  it('KYC level 2(ENHANCED) 이상도 허용', async () => {
    const enhanced: KYCStatus = { ...ACTIVE_STATUS, level: 2 };
    const adapter = new PermissiveComplianceAdapter(makeKYCByAddress(enhanced));
    const result = await adapter.canReceiveNFT('0xenhanced');
    expect(result.allowed).toBe(true);
  });

  it('KYC 만료 시간이 미래 → 허용', async () => {
    const notExpired: KYCStatus = {
      ...ACTIVE_STATUS,
      expiredAt: Math.floor(Date.now() / 1000) + 86400,  // 내일
    };
    const adapter = new PermissiveComplianceAdapter(makeKYCByAddress(notExpired));
    const result = await adapter.canReceiveNFT('0xfuture');
    expect(result.allowed).toBe(true);
  });
});

describe('PermissiveComplianceAdapter.getKYCStatus()', () => {
  it('주소에 대한 KYC 상태 반환', async () => {
    const adapter = new PermissiveComplianceAdapter(makeKYCByAddress(ACTIVE_STATUS));
    const status = await adapter.getKYCStatus('0xvalid');
    expect(status?.userId).toBe('u-001');
    expect(status?.level).toBe(1);
  });

  it('KYC 없으면 null 반환', async () => {
    const adapter = new PermissiveComplianceAdapter(makeKYCByAddress(null));
    const status = await adapter.getKYCStatus('0xunknown');
    expect(status).toBeNull();
  });
});
