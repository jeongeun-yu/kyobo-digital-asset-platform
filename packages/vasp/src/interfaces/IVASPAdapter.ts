/**
 * IVASPAdapter — VASP 추상화 인터페이스
 *
 * Phase 1 (확정): ExternalVASPAdapter (외부 인가 VASP 연동)
 * 향후 내재화 시 (미확정): KyoboVASPAdapter (교보 자체 VASP 운영)
 *
 * 이 인터페이스를 사용하는 상위 레이어(issuer-service 등)는
 * VASP가 외부인지 내부인지 알 필요 없다.
 * 교체는 어댑터 구현체 교체만으로 완료 — 비즈니스 로직 수정 없음.
 *
 * 규제 맥락:
 *   - 특금법상 가상자산사업자(VASP) 신고/인가 없이는 직접 운영 불가
 *   - Phase 1: 외부 VASP를 통해 지갑 관리, 출금 처리
 *   - 향후: 교보생명이 VASP 인가 취득 시 이 인터페이스 직접 구현
 */

export interface WalletInfo {
  address:   string;
  publicKey: string;
  custodyId: string;  // VASP 내부 식별자
}

export interface TransferRequest {
  from:      string;
  to:        string;
  amount:    bigint;
  tokenAddr: string;
  memo?:     string;
  travelRuleData?: TravelRuleData;
}

export interface TravelRuleData {
  originator: { name: string; accountId: string; vasp: string };
  beneficiary: { name: string; accountId: string; vasp: string };
}

export interface TransferResult {
  txHash:    string;
  status:    'pending' | 'completed' | 'failed';
  fee?:      bigint;
}

export interface IVASPAdapter {
  /**
   * 사용자 수탁 지갑 생성
   * Phase 1: 외부 VASP가 생성·관리
   * 향후 내재화 시: 교보 자체 HSM/MPC 기반 생성
   */
  createWallet(userId: string): Promise<WalletInfo>;

  /**
   * 지갑 조회
   */
  getWallet(userId: string): Promise<WalletInfo | null>;

  /**
   * 토큰 전송 (Travel Rule 데이터 포함)
   */
  transfer(req: TransferRequest): Promise<TransferResult>;

  /**
   * 전송 상태 조회
   */
  getTransferStatus(txHash: string): Promise<TransferResult>;

  /**
   * AML 스크리닝 — 블랙리스트 주소 여부
   */
  screenAddress(address: string): Promise<{ flagged: boolean; reason?: string }>;
}
