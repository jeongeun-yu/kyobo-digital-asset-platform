/**
 * 운영 원장 (Operational Ledger)
 *
 * 이 서비스는 Node.js issuer-service(내부망)의 블록체인 운영 데이터만 관리한다.
 * 임시적/기술적 데이터: 트랜잭션 in-flight 상태, 이벤트 중복 방지
 *
 * 영구 금융 원장(NFT 보유 현황, 감사 로그)은 내부망 Java Gateway가 관리한다.
 * TX Finalized(FINALIZED) 시 ICoreBankingAdapter.recordNftHolding()을 호출한다.
 *
 * 데이터 수명:
 *   - mint_requests: CONFIRMED/FAILED 후 30일 자동 만료 (운영 편의)
 *   - processed_events: 90일 보존 (Reorg 감지 목적)
 */

import { randomUUID } from 'crypto';
import type { ICoreBankingAdapter } from '../interfaces/ICoreBankingAdapter';

export type MintStatus = 'REQUESTED' | 'SUBMITTED' | 'MINED' | 'CONFIRMED' | 'FINALIZED' | 'FAILED' | 'REORGED';

// ── 내부 원장 4단계 잔액 모델 (Phase 3: 직접 Custody 전환 시 활성화) ─────────
//
// 고객 자산을 4단계로 구분해 이중 인출을 선제 방지하는 모델.
// Phase 1: NFT 발행(단방향) 위주라 RESERVE 필요성 낮음.
//          CONFIRMED 시 Java 영구 원장에서 잔액 관리.
// Phase 3: 교보 자체 VASP 운영 시 출금 승인 즉시 RESERVE로 잠가야 함.
//
// Custody Track Session 2 참조: Internal Ledger 4단계 잔액 모델
//
//   Available  출금 가능한 실제 잔액 (사용자에게 보이는 잔액)
//   Reserved   출금 요청 승인(W3_APPROVED) 시 잠긴 금액 — 이중 인출 방지
//   Pending    TX 브로드캐스트 후 온체인 확정 대기 중
//   Settled    온체인 Finalized 후 최종 정산 완료

export interface InternalLedgerBalance {
  userId:    string;
  tokenId:   bigint;
  available: bigint;  // = Settled - Reserved - Pending
  reserved:  bigint;  // 출금 승인됐으나 아직 온체인 미확정
  pending:   bigint;  // TX 전송됨, 블록 미포함
  settled:   bigint;  // 온체인 Finalized 기준 최종 잔액
  updatedAt: Date;
}

// Phase 3: LedgerService에 잔액 관리 메서드 추가
//   reserve(userId, tokenId, amount): Available → Reserved (출금 승인 시)
//   settle(userId, tokenId, amount):  Reserved+Pending → Settled (FINALIZED 시)
//   release(userId, tokenId, amount): Reserved → Available (출금 취소 시)
//   getBalance(userId, tokenId): InternalLedgerBalance 반환

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
 * LedgerService — 운영 원장 단일 진입점
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
    REQUESTED: ['SUBMITTED', 'FAILED'],
    SUBMITTED: ['MINED',     'FAILED'],
    MINED:     ['CONFIRMED', 'REORGED', 'FAILED'],
    CONFIRMED: ['FINALIZED'],
    FINALIZED: [],                        // 종단 — 원장 업데이트 완료
    FAILED:    [],                        // 종단
    REORGED:   ['MINED',     'FAILED'],
  };

  constructor(
    private readonly db: DatabaseClient,
    private readonly coreBanking: ICoreBankingAdapter,
  ) {}

  // ── Mint Request ──────────────────────────────────────────────

  async createMintRequest(userId: string, policyId: string): Promise<MintRequest> {
    const requestId = randomUUID();
    const now       = new Date();

    await this.db.query(
      `INSERT INTO mint_requests (id, user_id, policy_id, status, created_at, updated_at)
       VALUES ($1,$2,$3,'REQUESTED',$4,$4)`,
      [requestId, userId, policyId, now.toISOString()],
    );

    await this.coreBanking.recordAuditLog({
      actor:        'system',
      action:       'MINT_REQUESTED',
      resourceType: 'MintRequest',
      resourceId:   requestId,
      afterState:   { userId, policyId, status: 'REQUESTED' },
    });

    return { id: requestId, userId, policyId, status: 'REQUESTED', createdAt: now, updatedAt: now };
  }

  async getMintRequest(requestId: string): Promise<MintRequest | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM mint_requests WHERE id = $1',
      [requestId],
    );
    if (rows.length === 0) return null;

    const r = rows[0]!;
    return {
      id:        r['id'] as string,
      userId:    r['user_id'] as string,
      policyId:  r['policy_id'] as string,
      status:    r['status'] as MintStatus,
      txHash:    r['tx_hash'] as string | undefined,
      tokenId:   r['token_id'] ? BigInt(r['token_id'] as string) : undefined,
      errorMsg:  r['error_msg'] as string | undefined,
      createdAt: new Date(r['created_at'] as string),
      updatedAt: new Date(r['updated_at'] as string),
    };
  }

  async updateMintRequest(
    requestId: string,
    patch: { status: MintStatus; txHash?: string; tokenId?: bigint; errorMsg?: string },
  ): Promise<MintRequest> {
    const current = await this.getMintRequest(requestId);
    if (!current) throw new MintRequestNotFoundError(requestId);

    const allowed = LedgerService.VALID_TRANSITIONS[current.status];
    if (!allowed.includes(patch.status)) {
      throw new InvalidStateTransitionError(current.status, patch.status);
    }

    const now = new Date();
    await this.db.query(
      `UPDATE mint_requests
       SET status=$1, tx_hash=$2, token_id=$3, error_msg=$4, updated_at=$5
       WHERE id=$6`,
      [
        patch.status,
        patch.txHash   ?? null,
        patch.tokenId  !== undefined ? patch.tokenId.toString() : null,
        patch.errorMsg ?? null,
        now.toISOString(),
        requestId,
      ],
    );

    await this.coreBanking.recordAuditLog({
      actor:        'system',
      action:       `STATUS_${patch.status}`,
      resourceType: 'MintRequest',
      resourceId:   requestId,
      beforeState:  current,
      afterState:   { ...current, ...patch, updatedAt: now },
    });

    return { ...current, ...patch, updatedAt: now };
  }

  // ── Event Idempotency ─────────────────────────────────────────

  async recordProcessedEvent(
    txHash: string,
    logIndex: number,
    eventName: string,
    blockNumber: bigint,
    payload: unknown,
  ): Promise<ProcessedEventResult> {
    const { rows } = await this.db.query(
      `INSERT INTO processed_events (tx_hash, log_index, event_name, block_number, payload)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tx_hash, log_index) DO NOTHING
       RETURNING id`,
      [txHash, logIndex, eventName, blockNumber.toString(), JSON.stringify(payload)],
    );

    if (rows.length === 0) return { skipped: true };
    return { skipped: false, id: rows[0]!['id'] as number };
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


