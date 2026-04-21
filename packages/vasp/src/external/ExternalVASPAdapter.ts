import type {
  IVASPAdapter,
  WalletInfo,
  TransferRequest,
  TransferResult,
} from '../interfaces/IVASPAdapter';

/**
 * ExternalVASPAdapter — Phase 1 외부 VASP 연동 어댑터
 *
 * 교보생명이 VASP 인가를 보유한 외부 파트너사 API를 호출한다.
 * 파트너사가 바뀌어도 이 클래스만 수정 (IVASPAdapter 인터페이스는 유지).
 *
 * 보안 요구사항:
 *   - API 키는 반드시 환경 변수 또는 KMS에서 주입 (코드 하드코딩 금지)
 *   - 모든 호출은 DMZ 내부망 → 외부 VASP API 방화벽 경유
 *   - Travel Rule: 10만원 이상 이체 시 travelRuleData 필수 (특금법 §8의4)
 */
export class ExternalVASPAdapter implements IVASPAdapter {
  private readonly baseUrl: string;
  private readonly apiKey:  string;

  constructor(config: { baseUrl: string; apiKey: string }) {
    this.baseUrl = config.baseUrl;
    this.apiKey  = config.apiKey;
  }

  async createWallet(userId: string): Promise<WalletInfo> {
    const res = await this._request('POST', '/wallets', { userId });
    return {
      address:   res.address,
      publicKey: res.publicKey,
      custodyId: res.custodyId,
    };
  }

  async getWallet(userId: string): Promise<WalletInfo | null> {
    try {
      const res = await this._request('GET', `/wallets/${userId}`);
      return { address: res.address, publicKey: res.publicKey, custodyId: res.custodyId };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async transfer(req: TransferRequest): Promise<TransferResult> {
    const payload: Record<string, unknown> = {
      from:      req.from,
      to:        req.to,
      amount:    req.amount.toString(),
      tokenAddr: req.tokenAddr,
      memo:      req.memo,
    };

    // Travel Rule — 특금법 의무 (100만원 상당 이상 이체)
    if (req.travelRuleData) {
      payload.travelRule = req.travelRuleData;
    }

    const res = await this._request('POST', '/transfers', payload);
    return { txHash: res.txHash, status: res.status, fee: BigInt(res.fee ?? 0) };
  }

  async getTransferStatus(txHash: string): Promise<TransferResult> {
    const res = await this._request('GET', `/transfers/${txHash}`);
    return { txHash: res.txHash, status: res.status, fee: BigInt(res.fee ?? 0) };
  }

  async screenAddress(address: string): Promise<{ flagged: boolean; reason?: string }> {
    const res = await this._request('GET', `/aml/screen/${address}`);
    return { flagged: res.flagged, reason: res.reason };
  }

  private async _request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type':  'application/json',
        'X-API-Key':     this.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`VASP API ${res.status}: ${path}`);
    return res.json() as Promise<Record<string, unknown>>;
  }
}
