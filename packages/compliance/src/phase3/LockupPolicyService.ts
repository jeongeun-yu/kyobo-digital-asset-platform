/**
 * LockupPolicyService — Phase 3 락업 정책 관리
 *
 * 배경:
 *   토큰증권 발행 시 의무 보유 기간(락업)은 금융위 가이드라인 및
 *   투자자 유형(소매/전문)에 따라 상이하다.
 *   이 서비스는 정책 규칙을 중앙화하여 InvestorRegistryService에 주입한다.
 *
 * 정책 (예시 — 실제 값은 금융위 가이드라인 확정 후 업데이트):
 *   - INSURANCE_CLASS_A (소매): 1년 락업
 *   - INSURANCE_CLASS_A (전문): 락업 없음
 *   - INSURANCE_CLASS_B (소매): 6개월 락업
 *   - INSURANCE_CLASS_B (전문): 락업 없음
 */

export type InvestorType = 'RETAIL' | 'PROFESSIONAL';

export interface LockupPolicy {
  partition:    string;   // bytes32 hex string
  investorType: InvestorType;
  lockupDays:   number;   // 0 = 락업 없음
  maxHolding:   bigint;   // 0 = 한도 없음 (전문투자자)
}

const PARTITION_CLASS_A = '0x' + Buffer.from('INSURANCE_CLASS_A').toString('hex').padEnd(64, '0');
const PARTITION_CLASS_B = '0x' + Buffer.from('INSURANCE_CLASS_B').toString('hex').padEnd(64, '0');

// 기본 정책 테이블 — Phase 3 배포 전 금융위 최종 가이드라인으로 교체
const DEFAULT_POLICIES: LockupPolicy[] = [
  { partition: PARTITION_CLASS_A, investorType: 'RETAIL',       lockupDays: 365,  maxHolding: 50_000_000n },
  { partition: PARTITION_CLASS_A, investorType: 'PROFESSIONAL', lockupDays: 0,    maxHolding: 0n },
  { partition: PARTITION_CLASS_B, investorType: 'RETAIL',       lockupDays: 180,  maxHolding: 100_000_000n },
  { partition: PARTITION_CLASS_B, investorType: 'PROFESSIONAL', lockupDays: 0,    maxHolding: 0n },
];

export class LockupPolicyService {
  private readonly policies: Map<string, LockupPolicy>;

  constructor(overrides?: LockupPolicy[]) {
    this.policies = new Map();
    const source = overrides ?? DEFAULT_POLICIES;
    for (const p of source) {
      this.policies.set(this._key(p.partition, p.investorType), p);
    }
  }

  getPolicy(partition: string, investorType: InvestorType): LockupPolicy | undefined {
    return this.policies.get(this._key(partition, investorType));
  }

  /**
   * 발행 시 적용할 락업 종료 시각 (Unix timestamp)
   * 전문투자자 또는 정책 없는 파티션은 0 반환
   */
  getLockupUntil(partition: string, investorType: InvestorType): number {
    const policy = this.getPolicy(partition, investorType);
    if (!policy || policy.lockupDays === 0) return 0;
    return Math.floor(Date.now() / 1000) + policy.lockupDays * 86400;
  }

  /**
   * 파티션별 최대 보유 한도 조회
   * 0 = 한도 없음
   */
  getMaxHolding(partition: string, investorType: InvestorType): bigint {
    return this.getPolicy(partition, investorType)?.maxHolding ?? 0n;
  }

  private _key(partition: string, investorType: InvestorType): string {
    return `${partition.toLowerCase()}:${investorType}`;
  }
}
