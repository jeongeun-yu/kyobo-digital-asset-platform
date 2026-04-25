/**
 * DMZ Operational Ledger
 *
 * 이 서비스는 DMZ 레이어(Node.js)의 블록체인 운영 데이터만 관리한다.
 * 임시적/기술적 데이터: 트랜잭션 in-flight 상태, 이벤트 중복 방지
 *
 * 영구 금융 원장(NFT 보유 현황, 감사 로그)은 내부망 Java Gateway가 관리한다.
 * TX 확정(CONFIRMED) 시 ICoreBankingAdapter.recordNftHolding()을 호출한다.
 *
 * 데이터 수명:
 *   - mint_requests: CONFIRMED/FAILED 후 30일 자동 만료 (운영 편의)
 *   - processed_events: 90일 보존 (Reorg 감지 목적)
 */

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

export interface ProcessedEventResult {
  skipped: boolean;
  id?: number;
}

/**
 * LedgerService — DMZ 운영 원장 단일 진입점
 *
 * 설계 원칙:
 *   - 온체인이 단일 진실. 이 서비스의 데이터는 항상 온체인에서 파생된다.
 *   - 역방향 동기화(오프체인 → 온체인) 절대 금지.
 *   - 상태 전이는 VALID_TRANSITIONS guard를 통해서만 허용.
 *   - TX CONFIRMED 시 ICoreBankingAdapter.recordNftHolding() 호출 — Java가 영구 원장에 기록.
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
    // NOTE: status=CONFIRMED 시 coreBankingAdapter.recordNftHolding() 호출 필요
    //       → ICoreBankingAdapter 참조 (Java blockchain-gateway가 영구 원장에 기록)
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
