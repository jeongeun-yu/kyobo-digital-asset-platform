import type { IKYCProvider } from '../interfaces/IKYCProvider';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export type InvestorType = 'RETAIL' | 'PROFESSIONAL';

export interface InvestorRecord {
  address:      string;
  userId:       string;
  investorType: InvestorType;
  registeredAt: number;
  revokedAt?:   number;
}

export interface PartitionLimit {
  maxHolding:   bigint;   // 파티션별 최대 보유량 (원 단위)
  currentHolding: bigint;
  lockedUntil:  number;   // Unix timestamp (0 = 락업 없음)
}

// ─── 서비스 ───────────────────────────────────────────────────────────────────

/**
 * InvestorRegistryService — Phase 3 투자자 레지스트리 오프체인 서비스
 *
 * 역할:
 *   - 온체인 IInvestorRegistry.sol의 오프체인 프록시
 *   - 투자자 등록/조회/보유량 관리 → 컨트랙트 트랜잭션 생성
 *   - KYC INVESTOR(3) 레벨 이상 확인 후 온체인 register() 호출
 *
 * 데이터 흐름:
 *   IssuerService.issueSTO() → InvestorRegistryService.canAccept()
 *     → 온체인 InvestorCompliance.canTransfer() → SecurityToken
 *
 * Phase 3 구현 시:
 *   - onchain 파라미터에 실제 ethers.Contract 주입
 *   - DB 캐시 레이어 추가 (투자자 수 수백~수천 예상, 매 TX마다 온체인 조회 비용)
 */
export class InvestorRegistryService {
  constructor(
    private readonly kyc: IKYCProvider,
    private readonly onchain: {
      register(address: string, investorType: number): Promise<string>;  // returns txHash
      revoke(address: string, reason: string): Promise<string>;
      isRegistered(address: string): Promise<boolean>;
      getPartitionLimit(address: string, partition: string): Promise<PartitionLimit>;
      setLockup(address: string, partition: string, until: number): Promise<string>;
    },
  ) {}

  /**
   * 투자자 온보딩
   *   1. KYC INVESTOR(3) 확인
   *   2. 온체인 register() 트랜잭션
   */
  async registerInvestor(params: {
    userId:   string;
    address:  string;
    investorType: InvestorType;
  }): Promise<{ txHash: string }> {
    const kycStatus = await this.kyc.getStatus(params.userId);
    if (!kycStatus || kycStatus.level < 3) {
      throw new Error(`InvestorRegistry: KYC level insufficient for STO — userId: ${params.userId}`);
    }

    const typeCode = params.investorType === 'PROFESSIONAL' ? 2 : 1;
    const txHash = await this.onchain.register(params.address, typeCode);
    return { txHash };
  }

  /**
   * STO 수령 가능 여부 — 등록·한도·락업 통합 확인
   * SecurityToken.issueByPartition() 호출 전 IssuerService에서 사전 검증용
   */
  async canAccept(params: {
    address:   string;
    partition: string;
    amount:    bigint;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const registered = await this.onchain.isRegistered(params.address);
    if (!registered) return { allowed: false, reason: 'NOT_REGISTERED' };

    const limit = await this.onchain.getPartitionLimit(params.address, params.partition);

    if (limit.lockedUntil > 0 && limit.lockedUntil > Date.now() / 1000) {
      return { allowed: false, reason: 'LOCKED_UP' };
    }

    if (limit.maxHolding > 0n && limit.currentHolding + params.amount > limit.maxHolding) {
      return { allowed: false, reason: 'HOLDING_LIMIT_EXCEEDED' };
    }

    return { allowed: true };
  }

  /**
   * 발행 후 락업 설정 — STO 의무 보유 기간
   * issueByPartition() 트랜잭션 완료 후 호출
   */
  async setPostIssuanceLockup(params: {
    address:   string;
    partition: string;
    daysLocked: number;
  }): Promise<{ txHash: string }> {
    const until = Math.floor(Date.now() / 1000) + params.daysLocked * 86400;
    const txHash = await this.onchain.setLockup(params.address, params.partition, until);
    return { txHash };
  }
}
