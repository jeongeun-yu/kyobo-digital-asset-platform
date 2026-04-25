/**
 * KDEPAdapter — 한국예탁결제원(KDEP) 연동 어댑터
 *
 * 규제 연동 포인트 (토큰증권 발행·유통 규율체계):
 *   - 토큰증권 발행 통보  : SecurityToken.issueByPartition() 완료 후
 *   - 배당 지급 통보      : DividendDistributor.distributeDividend() 완료 후
 *   - 문서 변경 통보      : SecurityToken.setDocument() 완료 후
 *   - 상환·소각 통보      : SecurityToken.redeemByPartition() 완료 후
 *
 * Phase 3 구현 전 상태:
 *   모든 메서드는 stub — KDEP API 스펙 공개 후 채운다.
 *   현재 KDEP는 STO 인프라 파일럿 단계이므로 API가 미확정.
 *
 * 인증:
 *   mTLS + KDEP 발급 클라이언트 인증서 (교보생명 내부 PKI 연동)
 */

export interface KDEPIssuancePayload {
  securityTokenAddr: string;
  partition:         string;
  holder:            string;
  amount:            string;
  txHash:            string;
  issuedAt:          number;
  documentUri?:      string;
}

export interface KDEPDividendPayload {
  securityTokenAddr: string;
  distributionId:    string;
  partition:         string;
  totalAmount:       string;
  paymentToken:      string;
  snapshotBlock:     number;
  txHash:            string;
}

export interface KDEPDocumentPayload {
  securityTokenAddr: string;
  documentName:      string;
  documentUri:       string;
  documentHash:      string;
  updatedAt:         number;
}

export interface KDEPRedemptionPayload {
  securityTokenAddr: string;
  partition:         string;
  holder:            string;
  amount:            string;
  txHash:            string;
  redeemedAt:        number;
}

export class KDEPAdapter {
  constructor(private readonly config: {
    baseUrl:    string;   // KDEP API endpoint (내부망 전용)
    apiKey:     string;   // KMS에서 주입
    certPath?:  string;   // mTLS 인증서 경로
  }) {}

  /**
   * 토큰증권 발행 통보 — 예탁결제원 등록 의무 (토큰증권 규율체계 §12)
   */
  async notifyIssuance(payload: KDEPIssuancePayload): Promise<void> {
    // TODO Phase 3: KDEP REST API POST /v1/securities/issuance
    console.log('[KDEP] notifyIssuance stub:', {
      addr: payload.securityTokenAddr,
      holder: payload.holder,
      amount: payload.amount,
      txHash: payload.txHash,
    });
  }

  /**
   * 배당 지급 통보
   */
  async notifyDividendDistribution(payload: KDEPDividendPayload): Promise<void> {
    // TODO Phase 3: KDEP REST API POST /v1/securities/dividends
    console.log('[KDEP] notifyDividendDistribution stub:', payload.distributionId);
  }

  /**
   * 투자설명서·약관 문서 변경 통보
   * setDocument() 후 반드시 호출 — 문서 해시 불일치 시 KDEP에서 경보
   */
  async notifyDocumentUpdate(payload: KDEPDocumentPayload): Promise<void> {
    // TODO Phase 3: KDEP REST API PUT /v1/securities/documents
    console.log('[KDEP] notifyDocumentUpdate stub:', payload.documentName);
  }

  /**
   * 상환·소각 통보 — 만기 상환 또는 투자자 요청 상환
   */
  async notifyRedemption(payload: KDEPRedemptionPayload): Promise<void> {
    // TODO Phase 3: KDEP REST API POST /v1/securities/redemptions
    console.log('[KDEP] notifyRedemption stub:', {
      holder: payload.holder,
      amount: payload.amount,
      txHash: payload.txHash,
    });
  }
}
