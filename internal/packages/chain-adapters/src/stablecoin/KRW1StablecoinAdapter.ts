// =============================================================================
// Phase 2 STUB — 원화 스테이블코인(KRW1) 발행·상환 어댑터
// =============================================================================
// 구현 시점: Phase 2 — 교보생명 원화 스테이블코인 도입 시
//
// KRW1 개요:
//   - 원화(KRW) 1:1 페깅 스테이블코인
//   - 발행 주체: 교보생명 (또는 제휴 은행/핀테크)
//   - 활용: 보험료 납입·보험금 지급·환급금 정산을 온체인으로 처리
//   - 규제: 전자금융거래법 + 가상자산이용자보호법 준수 필요
//
// 구현 옵션 (Phase 2 결정 전 검토 필요):
//
//   Option A — XRPL IOU 방식
//     교보생명이 XRPL Issuer 계정 보유
//     수신자가 Trust Line 설정 후 KRW1 IOU 수신
//     → XRPLAdapter와 통합 운영
//
//   Option B — EVM ERC-20 방식
//     Ethereum(또는 L2)에 KRW1 ERC-20 컨트랙트 배포
//     교보생명이 Minter 역할, 중앙화 발행·상환
//     → EVMAdapter.sendTransaction()으로 mint/burn 호출
//
//   Option C — 한국은행 CBDC 연동 (미래)
//     한국은행 디지털화폐(CBDC) 인프라 연동
//     현재 파일럿 단계 — 도입 시점 미확정
//
// Phase 1과의 차이:
//   Phase 1: 보험금 지급은 기존 코어뱅킹(계좌이체)
//   Phase 2: KRW1 스테이블코인 지급 옵션 추가 (온체인 기록)
//
// IBlockchainAdapter 미구현 — 스테이블코인 발행·상환은 체인 어댑터가 아닌
// 별도 KRW1IssuerService로 분리 예정 (Phase 2 설계 시 결정).
// =============================================================================

// ── 타입 ─────────────────────────────────────────────────────────────────────

export type KRW1IssueMode = 'XRPL_IOU' | 'EVM_ERC20' | 'CBDC';

export interface KRW1MintParams {
  recipientAddress: string;
  amountKRW:        bigint;   // 원화 단위 (소수점 없음)
  requestId:        string;   // 멱등성 키
  memo?:            string;   // Travel Rule 정보
}

export interface KRW1BurnParams {
  ownerAddress: string;
  amountKRW:    bigint;
  requestId:    string;
}

export interface KRW1Receipt {
  txHash:      string;
  amountKRW:   bigint;
  mode:        KRW1IssueMode;
  completedAt: Date;
}

// ── KRW1StablecoinAdapter ─────────────────────────────────────────────────────

/**
 * Phase 2: 원화 스테이블코인 발행·상환 전담 어댑터
 *
 * 구현 방식(mode)은 Phase 2 설계 시 결정.
 * 인터페이스는 고정 — 상위 레이어(IssuerService, CoreBanking) 수정 없음.
 */
export class KRW1StablecoinAdapter {
  constructor(
    private readonly mode: KRW1IssueMode,
    _config?: Record<string, unknown>,
  ) {}

  /**
   * Phase 2: KRW1 발행 (보험금·환급금 지급 시 호출)
   *   Option A: XRPL Payment TX (IOU 전송)
   *   Option B: ERC-20 mint() 호출
   */
  async mint(_params: KRW1MintParams): Promise<KRW1Receipt> {
    throw new Error(`KRW1StablecoinAdapter(${this.mode}): Phase 2 — mint 구현 필요`);
  }

  /**
   * Phase 2: KRW1 상환 (보험료 납입 수신 후 원화로 환전 시 호출)
   *   Option A: XRPL TrustLine 소각
   *   Option B: ERC-20 burn() 호출
   */
  async burn(_params: KRW1BurnParams): Promise<KRW1Receipt> {
    throw new Error(`KRW1StablecoinAdapter(${this.mode}): Phase 2 — burn 구현 필요`);
  }

  /**
   * Phase 2: 특정 주소의 KRW1 잔액 조회
   */
  async getBalance(_address: string): Promise<bigint> {
    throw new Error(`KRW1StablecoinAdapter(${this.mode}): Phase 2 — getBalance 구현 필요`);
  }

  /**
   * Phase 2: 헬스체크 — 발행자 계정 연결 상태 확인
   */
  async healthCheck(): Promise<{ healthy: boolean; mode: KRW1IssueMode }> {
    return { healthy: false, mode: this.mode };
  }
}
