/**
 * ExternalVaspTxClient — Phase 1 VaspTxClient 구현체
 *
 * TxStateMachineService가 주입받는 VaspTxClient 인터페이스의 월렛원 REST API 래퍼.
 *
 * Phase 1 엔드포인트 (월렛원 기준):
 *   submitMint()          → POST /v1/nft/mint
 *   getStatus()           → GET  /v1/tx/{txHash}/status
 *   resubmitWithGasBump() → POST /v1/tx/{txHash}/resubmit
 *
 * Phase 3 교체 계획:
 *   이 클래스를 Phase3VaspTxClient로 교체 — 내부 직접 Custody 구현
 *   NonceManager + ISignerService + Broadcaster + ConfirmationTracker 조합
 *   TxStateMachineService 코드 변경 없이 DI 교체만으로 전환 가능
 */

import type { VaspTxClient } from './TxStateMachineService';

// TODO: 월렛원 실제 API 응답 스펙 확인 후 타입 구체화
interface WalletOneSubmitResponse {
  txHash: string;
  // TODO: 응답에 추가 필드 있으면 여기 추가
}

interface WalletOneStatusResponse {
  status: 'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found';
  blockNumber?: number;
  revertReason?: string;
  // TODO: 월렛원 상태 코드 → 위 5가지 enum 매핑 필요 (실제 응답값 확인)
}

interface WalletOneResubmitResponse {
  txHash: string;
  // TODO: 응답 필드 확인
}

export class ExternalVaspTxClient implements VaspTxClient {
  private readonly baseUrl: string;
  private readonly apiKey:  string;

  constructor(config: { baseUrl: string; apiKey: string }) {
    this.baseUrl = config.baseUrl;
    this.apiKey  = config.apiKey;
  }

  /**
   * NFT 민팅 TX를 월렛원에 위탁
   * TODO: 월렛원 POST /v1/nft/mint 실제 요청 바디 스펙 확인
   * TODO: requestId → 월렛원 idempotencyKey 필드명 확인
   * TODO: tokenId(bigint) → 월렛원 API string/number 타입 변환 필요 여부 확인
   */
  async submitMint(params: {
    to:        string;
    tokenId:   bigint;
    amount:    bigint;
    requestId: string;
  }): Promise<{ txHash: string }> {
    // TODO: 구현
    // const res = await this._request<WalletOneSubmitResponse>('POST', '/v1/nft/mint', {
    //   to:             params.to,
    //   tokenId:        params.tokenId.toString(),
    //   amount:         params.amount.toString(),
    //   idempotencyKey: params.requestId,
    // });
    // return { txHash: res.txHash };
    throw new Error('ExternalVaspTxClient.submitMint: NOT IMPLEMENTED');
  }

  /**
   * TX 현재 상태 조회
   * TODO: 월렛원 GET /v1/tx/{txHash}/status 응답 status 값 → 내부 enum 매핑 확인
   *   - 월렛원 상태값이 다를 수 있음 (예: 'SUCCESS' → 'confirmed', 'DROPPED' → 'not_found')
   * TODO: revertReason 필드 포함 여부 확인
   */
  async getStatus(txHash: string): Promise<{
    status:        'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found';
    blockNumber?:  number;
    revertReason?: string;
  }> {
    // TODO: 구현
    // const res = await this._request<WalletOneStatusResponse>('GET', `/v1/tx/${txHash}/status`);
    // return {
    //   status:       this._mapStatus(res.status),
    //   blockNumber:  res.blockNumber,
    //   revertReason: res.revertReason,
    // };
    throw new Error('ExternalVaspTxClient.getStatus: NOT IMPLEMENTED');
  }

  /**
   * Gas bump 후 TX 재전송
   * TODO: 월렛원 POST /v1/tx/{txHash}/resubmit 요청 바디 확인
   *   - gasBumpPercent(20)를 월렛원이 직접 받는지, 절대 gas 값으로 변환해서 넘기는지 확인
   * TODO: 기존 txHash 취소 후 신규 txHash 반환 플로우인지 확인
   */
  async resubmitWithGasBump(
    txHash:         string,
    gasBumpPercent: number,
  ): Promise<{ txHash: string }> {
    // TODO: 구현
    // const res = await this._request<WalletOneResubmitResponse>('POST', `/v1/tx/${txHash}/resubmit`, {
    //   gasBumpPercent,
    // });
    // return { txHash: res.txHash };
    throw new Error('ExternalVaspTxClient.resubmitWithGasBump: NOT IMPLEMENTED');
  }

  // ── 내부 HTTP 유틸 ──────────────────────────────────────────────────────

  // TODO: 재시도 로직 필요 여부 검토 (월렛원 API 일시 오류 대응)
  // TODO: 타임아웃 설정 (기본값 제안: 10s)
  // TODO: 에러 응답 파싱 — 월렛원 에러 코드 → 내부 에러 타입 매핑
  private async _request<T>(
    method: 'GET' | 'POST',
    path:   string,
    body?:  unknown,
  ): Promise<T> {
    // TODO: 구현
    // const res = await fetch(`${this.baseUrl}${path}`, {
    //   method,
    //   headers: {
    //     'Content-Type': 'application/json',
    //     'X-API-Key':    this.apiKey,           // TODO: 월렛원 인증 헤더명 확인
    //   },
    //   body: body ? JSON.stringify(body) : undefined,
    // });
    // if (!res.ok) throw new WalletOneApiError(res.status, await res.text());
    // return res.json() as Promise<T>;
    throw new Error('ExternalVaspTxClient._request: NOT IMPLEMENTED');
  }
}

// TODO: 월렛원 API 에러 응답 구조 확인 후 구체화
export class WalletOneApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body:       string,
  ) {
    super(`WalletOne API error ${statusCode}: ${body}`);
    this.name = 'WalletOneApiError';
  }
}
