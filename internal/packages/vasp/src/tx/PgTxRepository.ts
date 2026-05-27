/**
 * PgTxRepository — TxRepository PostgreSQL 구현체
 *
 * CREATE TABLE tx_mint_requests (
 *   id              UUID        PRIMARY KEY,
 *   user_id         TEXT        NOT NULL,
 *   token_id        NUMERIC     NOT NULL,
 *   amount          NUMERIC     NOT NULL,
 *   status          TEXT        NOT NULL,
 *   tx_hash         TEXT,
 *   block_number    INTEGER,
 *   retry_count     INTEGER     NOT NULL DEFAULT 0,
 *   gas_price_gwei  NUMERIC,
 *   fail_reason     TEXT,
 *   created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *   updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 *
 * CREATE INDEX idx_tx_mint_requests_status ON tx_mint_requests(status);
 * CREATE INDEX idx_tx_mint_requests_pending ON tx_mint_requests(created_at) WHERE status = 'PENDING';
 */

import type { Pool }                                 from 'pg';
import type { MintRequest, TxRepository, TxStatus } from './TxStateMachineService';

type DbRow = {
  id:             string;
  user_id:        string;
  token_id:       string;
  amount:         string;
  status:         string;
  tx_hash:        string | null;
  block_number:   number | null;
  retry_count:    number;
  gas_price_gwei: string | null;
  fail_reason:    string | null;
  created_at:     Date;
  updated_at:     Date;
};

export class PgTxRepository implements TxRepository {
  constructor(private readonly pool: Pool) {}

  async save(req: MintRequest): Promise<void> {
    await this.pool.query(
      `INSERT INTO tx_mint_requests
       (id, user_id, token_id, amount, status, tx_hash, block_number,
        retry_count, gas_price_gwei, fail_reason, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        req.id,
        req.userId,
        req.tokenId.toString(),
        req.amount.toString(),
        req.status,
        req.txHash        ?? null,
        req.blockNumber   ?? null,
        req.retryCount,
        req.gasPriceGwei  ?? null,
        req.failReason    ?? null,
        req.createdAt,
        req.updatedAt,
      ],
    );
  }

  async findById(id: string): Promise<MintRequest | null> {
    const res = await this.pool.query<DbRow>(
      'SELECT * FROM tx_mint_requests WHERE id = $1',
      [id],
    );
    if (!res.rowCount) return null;
    return this._toModel(res.rows[0]!);
  }

  /**
   * 상태 + extra 필드 원자적 UPDATE
   * 종단 상태(FINALIZED, FAILED)는 WHERE 절에서 제외 — 덮어쓰기 방지
   */
  async updateStatus(
    id:     string,
    status: TxStatus,
    extra?: Partial<MintRequest>,
  ): Promise<void> {
    const sets: string[]    = ['status = $2', 'updated_at = NOW()'];
    const params: unknown[] = [id, status];
    let   idx               = 3;

    if (extra?.txHash       !== undefined) { sets.push(`tx_hash = $${idx++}`);        params.push(extra.txHash); }
    if (extra?.blockNumber  !== undefined) { sets.push(`block_number = $${idx++}`);   params.push(extra.blockNumber); }
    if (extra?.retryCount   !== undefined) { sets.push(`retry_count = $${idx++}`);    params.push(extra.retryCount); }
    if (extra?.gasPriceGwei !== undefined) { sets.push(`gas_price_gwei = $${idx++}`); params.push(extra.gasPriceGwei); }
    if (extra?.failReason   !== undefined) { sets.push(`fail_reason = $${idx++}`);    params.push(extra.failReason); }

    await this.pool.query(
      `UPDATE tx_mint_requests
       SET ${sets.join(', ')}
       WHERE id = $1 AND status NOT IN ('FINALIZED', 'FAILED')`,
      params,
    );
  }

  /** txHash로 단건 조회 — 온체인 이벤트 핸들러에서 tx_mint_requests 찾을 때 사용 */
  async findByTxHash(txHash: string): Promise<MintRequest | null> {
    const res = await this.pool.query<DbRow>(
      'SELECT * FROM tx_mint_requests WHERE tx_hash = $1 LIMIT 1',
      [txHash],
    );
    if (!res.rowCount) return null;
    return this._toModel(res.rows[0]!);
  }

  /**
   * PENDING 상태이면서 minutes 분 이상 경과한 요청 조회
   * FOR UPDATE SKIP LOCKED — 다중 인스턴스 중복 처리 방지
   */
  async findPendingOlderThan(minutes: number): Promise<MintRequest[]> {
    const res = await this.pool.query<DbRow>(
      `SELECT * FROM tx_mint_requests
       WHERE status = 'PENDING'
         AND created_at < NOW() - ($1 * INTERVAL '1 minute')
       ORDER BY created_at ASC
       LIMIT 100
       FOR UPDATE SKIP LOCKED`,
      [minutes],
    );
    return res.rows.map(r => this._toModel(r));
  }

  private _toModel(row: DbRow): MintRequest {
    return {
      id:           row.id,
      userId:       row.user_id,
      tokenId:      BigInt(row.token_id),
      amount:       BigInt(row.amount),
      status:       row.status       as TxStatus,
      txHash:       row.tx_hash      ?? undefined,
      blockNumber:  row.block_number ?? undefined,
      retryCount:   row.retry_count,
      gasPriceGwei: row.gas_price_gwei != null ? Number(row.gas_price_gwei) : undefined,
      failReason:   row.fail_reason  ?? undefined,
      createdAt:    new Date(row.created_at),
      updatedAt:    new Date(row.updated_at),
    };
  }
}
