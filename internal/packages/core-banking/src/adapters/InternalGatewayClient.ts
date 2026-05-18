/**
 * InternalGatewayClient — issuer-service → internal/internal-ledger (Java) HTTP 클라이언트
 *
 * 이 클라이언트가 호출하는 엔드포인트:
 *   GET  /api/internal/users/{userId}              — 사용자 계정/지갑주소/KYC 조회
 *   POST /api/internal/users/{userId}/nft-holdings — NFT 보유 이력 온체인 기록
 *   POST /api/internal/audit-log                   — 감사 로그 append-only 기록
 *   POST /api/internal/rewards/notify              — Core Banking 리워드 알림
 *   GET  /api/internal/health                      — 헬스체크
 *
 * 인증: X-Internal-Secret 헤더 (하드코딩 금지, KMS에서 주입)
 * 향후: mTLS로 교체 예정 (Phase 2 마일스톤 완료시)
 *
 * Node.js 18+ built-in fetch 사용. undici 의존성 없음
 *
 * Circuit Breaker 적용:
 *   5회 연속 실패 → OPEN → 30초 쿨다운 → HALF_OPEN 전이.
 *   health() 엔드포인트로 자동 복구 확인 가능.
 */

import { CircuitBreaker } from './CircuitBreaker';
export { CircuitOpenError } from './CircuitBreaker';

// ── Java DTO mirror types ─────────────────────────────────────────────────────

/** mirrors Java: UserAccountResponse record */
export interface GatewayUserAccountResponse {
  userId:      string;
  walletAddress: string | null;   // 지갑 미연동시 null
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
  private readonly secret:  string;
  private readonly cb:      CircuitBreaker;

  constructor(config: {
    /** e.g. "http://internal-ledger:8080" 내부망 도메인 */
    baseUrl: string;
    /** X-Internal-Secret 값 — 반드시 환경변수 INTERNAL_GATEWAY_SECRET에서 주입 */
    secret: string;
    /** Circuit breaker 설정 (기본: 5회 실패 → 30초 쿨다운) */
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

  // ── Endpoints ────────────────────────────────────────────────────────────────

  /**
   * 사용자 계정/지갑주소/KYC 상태 조회
   * NFT 발행 전 Core Banking에서 사용자 유효성 확인 후 호출
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
   * NFT 보유 이력 온체인 기록
   * on-chain Transfer 이벤트 수신 후 호출 (Java Oracle DB에 저장)
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
   * issuer-service의 모든 상태 변경시 호출 (ISMS-P 요건)
   * Java 측에서 SHA-256 체인으로 변조 감지
   */
  async recordAuditLog(req: GatewayAuditLogRequest): Promise<void> {
    await this.request<void>('POST', '/api/internal/audit-log', req);
  }

  /**
   * Core Banking 리워드 알림
   * NFT 발행 완료 후 사용자에게 알림 발송 요청
   */
  async notifyReward(req: GatewayRewardNotificationRequest): Promise<void> {
    await this.request<void>('POST', '/api/internal/rewards/notify', req);
  }

  /**
   * 헬스체크 — 연결 확인 또는 circuit breaker 상태 확인 시 호출
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
