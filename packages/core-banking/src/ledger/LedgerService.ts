import { randomUUID } from 'crypto';

export type MintStatus = 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'REORGED';

export interface MintRequest {
  id: string;            // UUID
  userId: string;
  policyId: string;
  status: MintStatus;
  txHash?: string;
  tokenId?: bigint;
  createdAt: Date;
  updatedAt: Date;
  errorMsg?: string;
}

export interface NftHolding {
  userId: string;
  tokenId: bigint;
  contractAddr: string;
  chainId: number;
  acquiredAt: Date;
  releasedAt?: Date;
  onChainTx: string;
}

export interface ProcessedEventResult {
  skipped: boolean;
  id?: number;
}

/**
 * LedgerService — 내부 원장 단일 진입점
 *
 * 설계 원칙:
 *   - 온체인이 단일 진실. 이 서비스의 데이터는 항상 온체인에서 파생된다.
 *   - 역방향 동기화(오프체인 → 온체인) 절대 금지.
 *   - 상태 전이는 VALID_TRANSITIONS guard를 통해서만 허용.
 *   - 모든 상태 변경은 AuditLogService.log() 호출을 수반한다.
 */
export class LedgerService {
  // 허용된 상태 전이 맵
  private static readonly VALID_TRANSITIONS: Record<MintStatus, MintStatus[]> = {
    PENDING:   ['SUBMITTED', 'FAILED'],
    SUBMITTED: ['CONFIRMED', 'FAILED', 'REORGED'],
    CONFIRMED: ['REORGED'],
    FAILED:    [],
    REORGED:   ['SUBMITTED', 'FAILED'],
  };

  constructor(
    private readonly db: DatabaseClient,
    private readonly auditLog: AuditLogClient,
  ) {}

  // ── Mint Request ──────────────────────────────────────────────

  async createMintRequest(userId: string, policyId: string): Promise<MintRequest> {
    const requestId = randomUUID();
    // TODO: DB INSERT into mint_requests (requestId, userId, policyId, status='PENDING')
    // TODO: auditLog.log({ actor: 'system', action: 'MINT_REQUESTED', resourceType: 'MintRequest', resourceId: requestId, afterState: { userId, policyId, status: 'PENDING' } })
    throw new Error('Not implemented');
  }

  async getMintRequest(requestId: string): Promise<MintRequest | null> {
    // TODO: SELECT * FROM mint_requests WHERE request_id = requestId
    throw new Error('Not implemented');
  }

  async updateMintRequest(
    requestId: string,
    patch: { status: MintStatus; txHash?: string; tokenId?: bigint; errorMsg?: string },
  ): Promise<MintRequest> {
    const current = await this.getMintRequest(requestId);
    if (!current) throw new MintRequestNotFoundError(requestId);

    // 상태 전이 guard
    const allowed = LedgerService.VALID_TRANSITIONS[current.status];
    if (!allowed.includes(patch.status)) {
      throw new InvalidStateTransitionError(current.status, patch.status);
    }

    // TODO: UPDATE mint_requests SET status=$1, tx_hash=$2, ... WHERE request_id=$3
    // TODO: auditLog.log({ action: `STATUS_${patch.status}`, before: current, after: { ...current, ...patch } })
    throw new Error('Not implemented');
  }

  // ── NFT Holdings ─────────────────────────────────────────────

  async recordNftAcquired(holding: Omit<NftHolding, 'releasedAt'>): Promise<void> {
    // TODO: INSERT INTO user_nft_holdings (...) ON CONFLICT (token_id, contract_addr, chain_id) DO UPDATE
    // TODO: auditLog.log({ action: 'NFT_ACQUIRED', resourceType: 'NftHolding', resourceId: `${holding.contractAddr}:${holding.tokenId}`, afterState: holding })
    throw new Error('Not implemented');
  }

  async recordNftReleased(contractAddr: string, tokenId: bigint, chainId: number): Promise<void> {
    // TODO: UPDATE user_nft_holdings SET released_at = NOW() WHERE token_id=$1 AND contract_addr=$2 AND chain_id=$3 AND released_at IS NULL
    // TODO: auditLog.log({ action: 'NFT_RELEASED', ... })
    throw new Error('Not implemented');
  }

  async getNftHoldings(userId: string): Promise<NftHolding[]> {
    // TODO: SELECT * FROM user_nft_holdings WHERE user_id=$1 AND released_at IS NULL
    throw new Error('Not implemented');
  }

  // ── Event Idempotency ─────────────────────────────────────────

  async recordProcessedEvent(
    txHash: string,
    logIndex: number,
    eventName: string,
    blockNumber: bigint,
    payload: unknown,
  ): Promise<ProcessedEventResult> {
    // TODO:
    // INSERT INTO processed_events (tx_hash, log_index, event_name, block_number, payload)
    // VALUES ($1,$2,$3,$4,$5)
    // ON CONFLICT (tx_hash, log_index) DO NOTHING
    // RETURNING id
    //
    // rows.length === 0 → { skipped: true }
    // rows.length === 1 → { skipped: false, id: rows[0].id }
    throw new Error('Not implemented');
  }
}

// ── Errors ────────────────────────────────────────────────────

export class MintRequestNotFoundError extends Error {
  constructor(requestId: string) {
    super(`MintRequest not found: ${requestId}`);
    this.name = 'MintRequestNotFoundError';
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(from: MintStatus, to: MintStatus) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

// ── Interfaces (의존성 역전) ───────────────────────────────────

interface DatabaseClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface AuditLogClient {
  log(entry: {
    actor: string;
    action: string;
    resourceType: string;
    resourceId: string;
    beforeState?: unknown;
    afterState: unknown;
  }): Promise<void>;
}
