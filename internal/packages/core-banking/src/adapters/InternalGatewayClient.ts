/**
 * InternalGatewayClient ??issuer-service ??internal/internal-ledger (Java) HTTP ?대씪?댁뼵??
 *
 * ???대씪?댁뼵?멸? ?몄텧?섎뒗 ?붾뱶?ъ씤??
 *   GET  /api/internal/users/{userId}              ???ъ슜??怨꾩젙쨌吏媛뫢텸YC 議고쉶
 *   POST /api/internal/users/{userId}/nft-holdings ??NFT 蹂댁쑀 ?꾪솴 ?곴뎄 湲곕줉
 *   POST /api/internal/audit-log                   ??媛먯궗 濡쒓렇 append-only 湲곕줉
 *   POST /api/internal/rewards/notify              ??Core Banking 由ъ썙???뚮┝
 *   GET  /api/internal/health                      ???ъ뒪泥댄겕
 *
 * ?몄쬆: X-Internal-Secret ?ㅻ뜑 (?대?留?怨듭쑀 ?쒗겕由? KMS?먯꽌 二쇱엯)
 * ?ν썑: mTLS濡??꾪솚 ?덉젙 (Phase 2 蹂댁븞 媛뺥솕)
 *
 * Node.js 18+ built-in fetch ?ъ슜. undici 異붽? ?ㅼ튂 遺덊븘??
 *
 * Circuit Breaker ?듯빀:
 *   5???곗냽 ?ㅽ뙣 ??OPEN ??30珥?李⑤떒 ??HALF_OPEN 蹂듦뎄 ?먯깋.
 *   health() ?붾뱶?ъ씤?몃줈 ?섎룞 蹂듦뎄 ?뺤씤 媛??
 */

import { CircuitBreaker } from './CircuitBreaker';
export { CircuitOpenError } from './CircuitBreaker';

// ?? Java DTO mirror types ?????????????????????????????????????????????????????

/** mirrors Java: UserAccountResponse record */
export interface GatewayUserAccountResponse {
  userId:      string;
  walletAddress: string | null;   // 吏媛?誘몄뿰????null
  kycLevel:    'NONE' | 'BASIC' | 'ENHANCED' | 'INVESTOR';
  isActive:    boolean;
}

/** mirrors Java: NftHoldingRequest record */
export interface GatewayNftHoldingRequest {
  tokenId:      number;   // Java Long ??TS number (NFT tokenId 踰붿쐞?먯꽌 ?덉쟾)
  contractAddr: string;
  chainId:      number;
  acquiredAt:   string;   // ISO-8601 (Java Instant)
  onChainTx:    string;
}

/** mirrors Java: AuditLogRequest record */
export interface GatewayAuditLogRequest {
  actor:        string;
  action:       string;
  resourceType: string;
  resourceId:   string;
  beforeState:  string | null;  // JSON string, nullable
  afterState:   string;         // JSON string
}

/** mirrors Java: RewardNotificationRequest record */
export interface GatewayRewardNotificationRequest {
  userId:     string;
  rewardType: string;
  tokenId:    string;
  txHash:     string;
  issuedAt:   number;  // epoch seconds
  metadata?:  Record<string, unknown>;
}

// ?? Client ????????????????????????????????????????????????????????????????????

export class InternalGatewayClient {
  private readonly baseUrl: string;
  private readonly secret:  string;
  private readonly cb:      CircuitBreaker;

  constructor(config: {
    /** e.g. "http://internal-ledger:8080" ???대?留??몄뒪??*/
    baseUrl: string;
    /** X-Internal-Secret 媛????섍꼍蹂??INTERNAL_GATEWAY_SECRET?먯꽌 二쇱엯 */
    secret: string;
    /** Circuit breaker ?ㅼ젙 (湲곕낯: 5???ㅽ뙣 ??30珥?李⑤떒) */
    circuitBreaker?: { failureThreshold?: number; recoveryTimeMs?: number };
  }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.secret  = config.secret;
    this.cb      = new CircuitBreaker(config.circuitBreaker);
  }

  getCircuitState() { return this.cb.getState(); }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Internal-Secret': this.secret,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.cb.execute(async () => {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new InternalGatewayError(method, path, res.status, text);
      }

      // 200 OK with no body (void endpoints)
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) return undefined as T;
      return res.json() as Promise<T>;
    });
  }

  // ?? Endpoints ??????????????????????????????????????????????????????????????

  /**
   * ?ъ슜??怨꾩젙쨌吏媛?二쇱냼쨌KYC ?덈꺼 議고쉶
   * ??NFT 諛쒗뻾 ??援먮낫 Core Banking?먯꽌 ?ъ슜???좏슚???뺤씤 ???몄텧
   * Returns null if user not found (404)
   */
  async getUserAccount(userId: string): Promise<GatewayUserAccountResponse | null> {
    try {
      return await this.request<GatewayUserAccountResponse>(
        'GET',
        `/api/internal/users/${encodeURIComponent(userId)}`,
      );
    } catch (err) {
      if (err instanceof InternalGatewayError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * NFT 蹂댁쑀 ?꾪솴 ?곴뎄 湲곕줉
   * ??on-chain Transfer ?대깽???뺤젙 ???몄텧 (Java Oracle DB?????
   */
  async recordNftHolding(
    userId: string,
    req: GatewayNftHoldingRequest,
  ): Promise<void> {
    await this.request<void>(
      'POST',
      `/api/internal/users/${encodeURIComponent(userId)}/nft-holdings`,
      req,
    );
  }

  /**
   * 媛먯궗 濡쒓렇 append-only 湲곕줉
   * ??issuer-service??紐⑤뱺 ?곹깭 蹂寃????몄텧 (ISMS-P ?붽굔)
   * Java 履쎌뿉??SHA-256 泥댁씤?쇰줈 蹂議?媛먯?
   */
  async recordAuditLog(req: GatewayAuditLogRequest): Promise<void> {
    await this.request<void>('POST', '/api/internal/audit-log', req);
  }

  /**
   * Core Banking 由ъ썙???뚮┝
   * ??NFT 諛쒗뻾 ?꾨즺 ???ъ씤???쒗깮 吏湲??몃━嫄?
   */
  async notifyReward(req: GatewayRewardNotificationRequest): Promise<void> {
    await this.request<void>('POST', '/api/internal/rewards/notify', req);
  }

  /**
   * ?ъ뒪泥댄겕 ???쒕퉬??湲곕룞 ?? ?먮뒗 circuit breaker 蹂듦뎄 ?뺤씤 ???몄텧
   */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/internal/health`, {
        headers: this.headers(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ?? Error ?????????????????????????????????????????????????????????????????????

export class InternalGatewayError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`InternalGateway ${method} ${path} ??HTTP ${status}: ${body}`);
    this.name = 'InternalGatewayError';
  }
}
