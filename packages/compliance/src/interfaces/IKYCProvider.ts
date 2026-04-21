/**
 * IKYCProvider — KYC(고객확인) 제공자 인터페이스
 *
 * Phase 1: 교보생명 기존 고객 DB 연동 (이미 KYC된 보험 가입자)
 * Phase 3 STO: 투자자 적합성 + 전문투자자 여부 추가 검증
 * Phase 4: 자체 KYC 시스템 또는 외부 KYC 서비스 교체 가능
 */
export interface KYCLevel {
  NONE:        0;
  BASIC:       1;  // 실명 확인 (Phase 1 NFT 수령 최소 요건)
  ENHANCED:    2;  // 고액 거래자 (Travel Rule 대상)
  INVESTOR:    3;  // 투자자 등록 (Phase 3 STO 참여 요건)
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
