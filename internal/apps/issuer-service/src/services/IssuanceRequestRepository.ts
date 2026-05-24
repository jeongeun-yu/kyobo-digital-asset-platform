import { randomUUID } from 'crypto';
import type { Pool }  from 'pg';

/**
 * IssuanceRequestRepository — 발행 요청 상태머신 퍼시스턴스
 *
 * IssuanceStatus 4-state 머신:
 *   REQUESTED → SUBMITTED → CONFIRMED (종단)
 *                         → FAILED    (종단)
 *
 * IssuerService가 관리하는 상태:
 *   REQUESTED  — create() 시 초기 상태
 *   SUBMITTED  — VASP 위탁 성공 후
 *   FAILED     — 지갑 조회·AML·VASP 실패 시
 *
 * CONFIRMED는 VASP Webhook 핸들러가 처리 (IssuerService 범위 밖).
 *
 * DIP 적용:
 *   IssuerService → IIssuanceRequestRepository (인터페이스)
 *   운영: PgIssuanceRequestRepository
 *   테스트: InMemoryIssuanceRequestRepository
 *
 */

// ── 도메인 타입 ───────────────────────────────────────────────────────────────

export type IssuanceStatus = 'REQUESTED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';

export interface IssuanceRequest {
  id:         string;        // UUID
  userId:     string;
  eventType:  string;
  tokenId:    bigint;        // NUMERIC → BigInt
  amount:     bigint;
  walletAddr: string | null;
  status:     IssuanceStatus;
  txHash:     string | null;
  failReason: string | null;
  createdAt:  Date;
  updatedAt:  Date;
}

// ── 리포지토리 인터페이스 (DIP 경계) ─────────────────────────────────────────

export interface IIssuanceRequestRepository {
  /** 발행 요청 생성 → REQUESTED 상태 */
  create(params: Omit<IssuanceRequest, 'id' | 'createdAt' | 'updatedAt'>): Promise<IssuanceRequest>;

  /** 지갑 주소 기록 (⑤ 지갑 조회 성공 후) */
  setWalletAddr(id: string, walletAddr: string): Promise<void>;

  /** 상태 전이 + txHash·failReason 옵션 기록 */
  updateStatus(
    id:        string,
    newStatus: IssuanceStatus,
    extra?:    { txHash?: string; failReason?: string },
  ): Promise<void>;

  /**
   * 진행 중인 요청 조회 (멱등성 체크)
   * REQUESTED·SUBMITTED 상태인 동일 (userId, eventType, tokenId) 조합 반환
   */
  findPending(userId: string, eventType: string, tokenId: bigint): Promise<IssuanceRequest | null>;

  findById(id: string): Promise<IssuanceRequest | null>;

  /** txHash로 단건 조회 — CONFIRMED·FAILED 전이 연결용 */
  findByTxHash(txHash: string): Promise<IssuanceRequest | null>;
}

// ── DB 행 타입 (내부) ────────────────────────────────────────────────────────

interface DbRow {
  id:          string;
  user_id:     string;
  event_type:  string;
  token_id:    string;   // NUMERIC → string
  amount:      string;
  wallet_addr: string | null;
  status:      string;
  tx_hash:     string | null;
  fail_reason: string | null;
  created_at:  Date;
  updated_at:  Date;
}

// ── 리포지토리 구현체: PostgreSQL ─────────────────────────────────────────────

/**
 * PgIssuanceRequestRepository
 *
 * DDL (init-db.sql):
 *
 *   CREATE TABLE IF NOT EXISTS issuance_requests (
 *     id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
 *     user_id     VARCHAR(64) NOT NULL,
 *     event_type  VARCHAR(64) NOT NULL,
 *     token_id    NUMERIC     NOT NULL,
 *     amount      NUMERIC     NOT NULL DEFAULT 1,
 *     wallet_addr VARCHAR(42),
 *     status      VARCHAR(16) NOT NULL CHECK (status IN ('REQUESTED','SUBMITTED','CONFIRMED','FAILED')),
 *     tx_hash     VARCHAR(66),
 *     fail_reason TEXT,
 *     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 */
export class PgIssuanceRequestRepository implements IIssuanceRequestRepository {
  constructor(private readonly pool: Pool) {}

  async create(params: Omit<IssuanceRequest, 'id' | 'createdAt' | 'updatedAt'>): Promise<IssuanceRequest> {
    const res = await this.pool.query<DbRow>(
      `INSERT INTO issuance_requests
         (id, user_id, event_type, token_id, amount, wallet_addr, status, tx_hash, fail_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        randomUUID(),
        params.userId,
        params.eventType,
        params.tokenId.toString(),
        params.amount.toString(),
        params.walletAddr,
        params.status,
        params.txHash,
        params.failReason,
      ],
    );
    return this._toModel(res.rows[0]!);
  }

  async setWalletAddr(id: string, walletAddr: string): Promise<void> {
    await this.pool.query(
      `UPDATE issuance_requests SET wallet_addr = $1, updated_at = NOW() WHERE id = $2`,
      [walletAddr, id],
    );
  }

  async updateStatus(
    id:        string,
    newStatus: IssuanceStatus,
    extra?:    { txHash?: string; failReason?: string },
  ): Promise<void> {
    const res = await this.pool.query<{ status: string }>(
      `UPDATE issuance_requests
       SET    status      = $1,
              tx_hash     = COALESCE($2, tx_hash),
              fail_reason = COALESCE($3, fail_reason),
              updated_at  = NOW()
       WHERE  id = $4
         AND  status NOT IN ('CONFIRMED', 'FAILED')
       RETURNING status`,
      [newStatus, extra?.txHash ?? null, extra?.failReason ?? null, id],
    );
    if (!res.rowCount) {
      const current = await this.findById(id);
      if (current && (current.status === 'CONFIRMED' || current.status === 'FAILED')) {
        throw new Error(`상태 전이 불가: ${current.status} → ${newStatus}`);
      }
    }
  }

  async findPending(userId: string, eventType: string, tokenId: bigint): Promise<IssuanceRequest | null> {
    const res = await this.pool.query<DbRow>(
      `SELECT * FROM issuance_requests
       WHERE  user_id    = $1
         AND  event_type = $2
         AND  token_id   = $3
         AND  status     IN ('REQUESTED', 'SUBMITTED')
       LIMIT 1`,
      [userId, eventType, tokenId.toString()],
    );
    if (!res.rowCount) return null;
    return this._toModel(res.rows[0]!);
  }

  async findById(id: string): Promise<IssuanceRequest | null> {
    const res = await this.pool.query<DbRow>(
      `SELECT * FROM issuance_requests WHERE id = $1`,
      [id],
    );
    if (!res.rowCount) return null;
    return this._toModel(res.rows[0]!);
  }

  async findByTxHash(txHash: string): Promise<IssuanceRequest | null> {
    const res = await this.pool.query<DbRow>(
      `SELECT * FROM issuance_requests WHERE tx_hash = $1 LIMIT 1`,
      [txHash],
    );
    if (!res.rowCount) return null;
    return this._toModel(res.rows[0]!);
  }

  private _toModel(row: DbRow): IssuanceRequest {
    return {
      id:         row.id,
      userId:     row.user_id,
      eventType:  row.event_type,
      tokenId:    BigInt(row.token_id),
      amount:     BigInt(row.amount),
      walletAddr: row.wallet_addr,
      status:     row.status as IssuanceStatus,
      txHash:     row.tx_hash,
      failReason: row.fail_reason,
      createdAt:  row.created_at,
      updatedAt:  row.updated_at,
    };
  }
}

// ── 리포지토리 구현체: InMemory (테스트용) ────────────────────────────────────

export class InMemoryIssuanceRequestRepository implements IIssuanceRequestRepository {
  private readonly store = new Map<string, IssuanceRequest>();

  async create(params: Omit<IssuanceRequest, 'id' | 'createdAt' | 'updatedAt'>): Promise<IssuanceRequest> {
    const req: IssuanceRequest = {
      ...params,
      id:        randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.store.set(req.id, { ...req });
    return { ...req };
  }

  async setWalletAddr(id: string, walletAddr: string): Promise<void> {
    const req = this._get(id);
    req.walletAddr = walletAddr;
    req.updatedAt  = new Date();
  }

  async updateStatus(
    id:        string,
    newStatus: IssuanceStatus,
    extra?:    { txHash?: string; failReason?: string },
  ): Promise<void> {
    const req = this._get(id);
    if (req.status === 'CONFIRMED' || req.status === 'FAILED') {
      throw new Error(`상태 전이 불가: ${req.status} → ${newStatus}`);
    }
    req.status    = newStatus;
    req.updatedAt = new Date();
    if (extra?.txHash)     req.txHash     = extra.txHash;
    if (extra?.failReason) req.failReason = extra.failReason;
  }

  async findPending(userId: string, eventType: string, tokenId: bigint): Promise<IssuanceRequest | null> {
    for (const req of this.store.values()) {
      if (
        req.userId    === userId &&
        req.eventType === eventType &&
        req.tokenId   === tokenId &&
        (req.status === 'REQUESTED' || req.status === 'SUBMITTED')
      ) {
        return { ...req };
      }
    }
    return null;
  }

  async findById(id: string): Promise<IssuanceRequest | null> {
    const req = this.store.get(id);
    return req ? { ...req } : null;
  }

  async findByTxHash(txHash: string): Promise<IssuanceRequest | null> {
    for (const req of this.store.values()) {
      if (req.txHash === txHash) return { ...req };
    }
    return null;
  }

  private _get(id: string): IssuanceRequest {
    const req = this.store.get(id);
    if (!req) throw new Error(`IssuanceRequest not found: ${id}`);
    return req;
  }
}
