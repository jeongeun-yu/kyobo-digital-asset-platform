/**
 * IKYCProvider — KYC(고객확인) 제공자 인터페이스
 *
 * Phase 1 (확정): 교보생명 기존 고객 DB 연동 (이미 KYC된 보험 가입자)
 * 향후 확장: 투자자 적합성 검증, 자체 KYC 시스템 등 (교보생명 내부 결정)
 */
export interface KYCLevel {
  NONE:        0;
  BASIC:       1;  // 실명 확인 (Phase 1 NFT 수령 최소 요건)
  ENHANCED:    2;  // 고액 거래자 (Travel Rule 대상)
  INVESTOR:    3;  // 향후 증권형 토큰 참여 시 요건
}

export interface KYCStatus {
  userId:    string;
  address:   string;
  level:     number;
  verifiedAt: number;
  expiredAt?:  number;
}

export interface IKYCProvider {
  getStatus(userId: string): Promise<KYCStatus | null>;
  getStatusByAddress(address: string): Promise<KYCStatus | null>;
  isVerified(address: string, minLevel: number): Promise<boolean>;
  register(userId: string, address: string, level: number): Promise<void>;
  revoke(userId: string, reason: string): Promise<void>;
}
