/**
 * LockupPolicyService 단위 테스트
 *
 * 기본 정책 테이블 조회, 오버라이드, 락업 종료 시각 계산, 최대 보유 한도 검증
 */

import { LockupPolicyService } from '../securities/LockupPolicyService';
import type { LockupPolicy } from '../securities/LockupPolicyService';

// 파티션 hex 계산 (소스와 동일 방식)
const PARTITION_CLASS_A = '0x' + Buffer.from('INSURANCE_CLASS_A').toString('hex').padEnd(64, '0');
const PARTITION_CLASS_B = '0x' + Buffer.from('INSURANCE_CLASS_B').toString('hex').padEnd(64, '0');

describe('LockupPolicyService — 기본 정책 테이블', () => {
  let svc: LockupPolicyService;

  beforeEach(() => {
    svc = new LockupPolicyService();
  });

  it('CLASS_A RETAIL 락업 365일', () => {
    const policy = svc.getPolicy(PARTITION_CLASS_A, 'RETAIL');
    expect(policy?.lockupDays).toBe(365);
  });

  it('CLASS_A PROFESSIONAL 락업 없음(0일)', () => {
    const policy = svc.getPolicy(PARTITION_CLASS_A, 'PROFESSIONAL');
    expect(policy?.lockupDays).toBe(0);
  });

  it('CLASS_B RETAIL 락업 180일', () => {
    const policy = svc.getPolicy(PARTITION_CLASS_B, 'RETAIL');
    expect(policy?.lockupDays).toBe(180);
  });

  it('CLASS_B PROFESSIONAL 락업 없음(0일)', () => {
    const policy = svc.getPolicy(PARTITION_CLASS_B, 'PROFESSIONAL');
    expect(policy?.lockupDays).toBe(0);
  });

  it('미등록 파티션 → undefined', () => {
    expect(svc.getPolicy('0xunknown', 'RETAIL')).toBeUndefined();
  });
});

describe('LockupPolicyService — getLockupUntil()', () => {
  let svc: LockupPolicyService;
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    svc = new LockupPolicyService();
  });

  it('PROFESSIONAL → 0 (락업 없음)', () => {
    expect(svc.getLockupUntil(PARTITION_CLASS_A, 'PROFESSIONAL')).toBe(0);
  });

  it('미등록 파티션 → 0', () => {
    expect(svc.getLockupUntil('0xunknown', 'RETAIL')).toBe(0);
  });

  it('CLASS_A RETAIL → 현재 시각 + 365일 (±10초 허용)', () => {
    const expected = now + 365 * 86400;
    const result   = svc.getLockupUntil(PARTITION_CLASS_A, 'RETAIL');
    expect(result).toBeGreaterThanOrEqual(expected - 10);
    expect(result).toBeLessThanOrEqual(expected + 10);
  });

  it('CLASS_B RETAIL → 현재 시각 + 180일 (±10초 허용)', () => {
    const expected = now + 180 * 86400;
    const result   = svc.getLockupUntil(PARTITION_CLASS_B, 'RETAIL');
    expect(result).toBeGreaterThanOrEqual(expected - 10);
    expect(result).toBeLessThanOrEqual(expected + 10);
  });
});

describe('LockupPolicyService — getMaxHolding()', () => {
  let svc: LockupPolicyService;

  beforeEach(() => {
    svc = new LockupPolicyService();
  });

  it('CLASS_A RETAIL maxHolding = 50,000,000n', () => {
    expect(svc.getMaxHolding(PARTITION_CLASS_A, 'RETAIL')).toBe(50_000_000n);
  });

  it('CLASS_A PROFESSIONAL maxHolding = 0n (한도 없음)', () => {
    expect(svc.getMaxHolding(PARTITION_CLASS_A, 'PROFESSIONAL')).toBe(0n);
  });

  it('CLASS_B RETAIL maxHolding = 100,000,000n', () => {
    expect(svc.getMaxHolding(PARTITION_CLASS_B, 'RETAIL')).toBe(100_000_000n);
  });

  it('미등록 파티션 → 0n (한도 없음)', () => {
    expect(svc.getMaxHolding('0xunknown', 'RETAIL')).toBe(0n);
  });
});

describe('LockupPolicyService — 커스텀 오버라이드', () => {
  const CUSTOM_PARTITION = '0x' + 'ff'.repeat(32);
  const overrides: LockupPolicy[] = [
    { partition: CUSTOM_PARTITION, investorType: 'RETAIL', lockupDays: 90, maxHolding: 10_000_000n },
  ];

  it('오버라이드 정책으로 초기화 → 커스텀 값 반환', () => {
    const svc = new LockupPolicyService(overrides);
    const policy = svc.getPolicy(CUSTOM_PARTITION, 'RETAIL');
    expect(policy?.lockupDays).toBe(90);
    expect(policy?.maxHolding).toBe(10_000_000n);
  });

  it('오버라이드 시 기본 정책은 포함되지 않음', () => {
    const svc = new LockupPolicyService(overrides);
    // 기본 CLASS_A 정책이 없어야 함
    expect(svc.getPolicy(PARTITION_CLASS_A, 'RETAIL')).toBeUndefined();
  });
});
