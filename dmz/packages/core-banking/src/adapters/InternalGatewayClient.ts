/**
 * InternalGatewayClient — DMZ → internal/blockchain-gateway (Java) HTTP 클라이언트
 *
 * 이 클라이언트가 호출하는 엔드포인트:
 *   GET  /api/internal/users/{userId}              — 사용자 계정·지갑·KYC 조회
 *   POST /api/internal/users/{userId}/nft-holdings — NFT 보유 현황 영구 기록
 *   POST /api/internal/audit-log                   — 감사 로그 append-only 기록
 *   POST /api/internal/rewards/notify              — Core Banking 리워드 알림
 *   GET  /api/internal/health                      — 헬스체크
 *
 * 인증: X-Internal-Secret 헤더 (내부망 공유 시크릿, KMS에서 주입)
 * 향후: mTLS로 전환 예정 (Phase 2 보안 강화)
 *
 * Node.js 18+ built-in fetch 사용. undici 추가 설치 불필요.
 */

// ── Java DTO mirror types ─────────────────────────────────────────────────────

/** mirrors Java: UserAccountResponse record */
export interface GatewayUserAccountResponse {
  userId:      string;
  walletAddress: string | null;   // 지갑 미연동 시 null
  kycLevel:    'NONE' | 'BASIC' | 'ENHANCED' | 'INVESTOR';
  isActive:    boolean;
}

/** mirrors Java: NftHoldingRequest record */
export interface GatewayNftHoldingRequest {
  tokenId:      number;   // Java Long → TS number (NFT tokenId 범위에서 안전)
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

// ── Client ────────────────────────────────────────────────────────────────────

export class InternalGatewayClient {
  private readonly baseUrl: string;
  private readonly secret: string;

  constructor(config: {
    /** e.g. "http://blockchain-gateway:8080" — 내부망 호스트 */
    baseUrl: string;
    /** X-Internal-Secret 값 — 환경변수 INTERNAL_GATEWAY_SECRET에서 주입 */
    secret: string;
  }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.secret = config.secret;
  }

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
  }

  // ── Endpoints ──────────────────────────────────────────────────────────────

  /**
   * 사용자 계정·지갑 주소·KYC 레벨 조회
   * → NFT 발행 전 교보 Core Banking에서 사용자 유효성 확인 시 호출
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
   * NFT 보유 현황 영구 기록
   * → on-chain Transfer 이벤트 확정 후 호출 (Java Oracle DB에 저장)
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
   * 감사 로그 append-only 기록
   * → DMZ issuer-service의 모든 상태 변경 시 호출 (ISMS-P 요건)
   * Java 쪽에서 SHA-256 체인으로 변조 감지
   */
  async recordAuditLog(req: GatewayAuditLogRequest): Promise<void> {
    await this.request<void>('POST', '/api/internal/audit-log', req);
  }

  /**
   * Core Banking 리워드 알림
   * → NFT 발행 완료 후 포인트/혜택 지급 트리거
   */
  async notifyReward(req: GatewayRewardNotificationRequest): Promise<void> {
    await this.request<void>('POST', '/api/internal/rewards/notify', req);
  }

  /**
   * 헬스체크 — 서비스 기동 시, 또는 circuit breaker 복구 확인 시 호출
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

// ── Error ─────────────────────────────────────────────────────────────────────

export class InternalGatewayError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`InternalGateway ${method} ${path} → HTTP ${status}: ${body}`);
    this.name = 'InternalGatewayError';
  }
}
