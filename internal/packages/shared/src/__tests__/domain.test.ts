/**
 * shared domain 타입 및 UserAccount 구조 단위 테스트
 *
 * 타입 정의는 런타임이 없어서 구조·값 검증 형태로 작성
 */

import type { UserAccount } from '../types/domain';

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('UserAccount 구조', () => {
  function makeUser(overrides: Partial<UserAccount> = {}): UserAccount {
    return {
      userId:        'u-001',
      walletAddress: '0xabc123',
      kycLevel:      'BASIC',
      isActive:      true,
      ...overrides,
    };
  }

  it('정상 UserAccount 객체 생성', () => {
    const user = makeUser();
    expect(user.userId).toBe('u-001');
    expect(user.walletAddress).toBe('0xabc123');
    expect(user.kycLevel).toBe('BASIC');
    expect(user.isActive).toBe(true);
  });

  it('walletAddress가 null 허용', () => {
    const user = makeUser({ walletAddress: null });
    expect(user.walletAddress).toBeNull();
  });

  it('kycLevel "NONE" 허용', () => {
    const user = makeUser({ kycLevel: 'NONE' });
    expect(user.kycLevel).toBe('NONE');
  });

  it('kycLevel "ENHANCED" 허용', () => {
    const user = makeUser({ kycLevel: 'ENHANCED' });
    expect(user.kycLevel).toBe('ENHANCED');
  });

  it('kycLevel "INVESTOR" 허용', () => {
    const user = makeUser({ kycLevel: 'INVESTOR' });
    expect(user.kycLevel).toBe('INVESTOR');
  });

  it('isActive false 허용', () => {
    const user = makeUser({ isActive: false });
    expect(user.isActive).toBe(false);
  });

  it('userId 빈 문자열 허용 (런타임 제약 없음)', () => {
    const user = makeUser({ userId: '' });
    expect(user.userId).toBe('');
  });
});

describe('kycLevel 값 집합', () => {
  const VALID_LEVELS: UserAccount['kycLevel'][] = ['NONE', 'BASIC', 'ENHANCED', 'INVESTOR'];

  it('유효 kycLevel 값 4가지', () => {
    expect(VALID_LEVELS).toHaveLength(4);
  });

  it('각 kycLevel은 문자열', () => {
    for (const level of VALID_LEVELS) {
      expect(typeof level).toBe('string');
    }
  });
});
