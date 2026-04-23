import type { IKYCProvider, KYCStatus } from '../interfaces/IKYCProvider';

/**
 * PermissiveComplianceAdapter — Phase 1 컴플라이언스 어댑터
 *
 * 역할:
 *   - 온체인 PermissiveCompliance.sol과 짝을 이루는 오프체인 레이어
 *   - KYC BASIC(1) 이상인 지갑만 활동 NFT 수령 허용
 *   - AML 스크리닝은 ExternalVASPAdapter에 위임
 *
 * Phase 3 전환:
 *   - 이 클래스를 InvestorRegistryService로 교체
 *   - 온체인: BaseToken.updateCompliance(InvestorCompliance 주소)
 */
export class PermissiveComplianceAdapter {
  constructor(private readonly kyc: IKYCProvider) {}

  /**
   * NFT 수령 전 KYC BASIC 확인
   * Phase 1에서는 BASIC(1) 이상이면 허용 — 투자자 한도·락업 불필요
   */
  async canReceiveNFT(address: string): Promise<{ allowed: boolean; reason?: string }> {
    const status = await this.kyc.getStatusByAddress(address);

    if (!status) {
      return { allowed: false, reason: 'KYC_NOT_FOUND' };
    }
    if (status.level < 1) {
      return { allowed: false, reason: 'KYC_LEVEL_INSUFFICIENT' };
    }
    if (status.expiredAt && status.expiredAt < Date.now() / 1000) {
      return { allowed: false, reason: 'KYC_EXPIRED' };
    }

    return { allowed: true };
  }

  /**
   * 주소 → KYC 상태 조회 (감사 로그용)
   */
  async getKYCStatus(address: string): Promise<KYCStatus | null> {
    return this.kyc.getStatusByAddress(address);
  }
}
