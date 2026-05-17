/**
 * PgTxRepository — TxRepository PostgreSQL 구현체
 *
 * TxStateMachineService가 주입받는 TxRepository 인터페이스의 실제 DB 구현.
 * LedgerService와 동일하게 node-postgres(pg) raw SQL 패턴 사용.
 *
 * TODO: 테이블 생성 마이그레이션 필요 (아래 스키마 참고)
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

import type { MintRequest, TxRepository, TxStatus } from './TxStateMachineService';

// TODO: 공용 DB 클라이언트 인터페이스 확정 후 import 경로 수정
// LedgerService 패턴 참고: this.db.query(sql, params)
interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class PgTxRepository implements TxRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * MintRequest 최초 INSERT (REQUESTED 상태)
   * TODO: tx_mint_requests 테이블명 확정 (LedgerService의 mint_requests와 구분)
   * TODO: tokenId / amount bigint → NUMERIC 변환 시 정밀도 손실 없는지 확인
   */
  async save(req: MintRequest): Promise<void> {
    // TODO: 구현
    // await this.db.query(
    //   `INSERT INTO tx_mint_requests
    //    (id, user_id, token_id, amount, status, tx_hash, block_number,
    //     retry_count, gas_price_gwei, fail_reason, created_at, updated_at)
    //    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    //   [
    //     req.id,
    //     req.userId,
    //     req.tokenId.toString(),
    //     req.amount.toString(),
    //     req.status,
    //     req.txHash        ?? null,
    //     req.blockNumber   ?? null,
    //     req.retryCount,
    //     req.gasPriceGwei  ?? null,
    //     req.failReason    ?? null,
    //     req.createdAt.toISOString(),
    //     req.updatedAt.toISOString(),
    //   ],
    // );
    throw new Error('PgTxRepository.save: NOT IMPLEMENTED');
  }

  /**
   * TODO: row → MintRequest 매핑 함수 _toModel() 공통화 검토
   * TODO: token_id NUMERIC → bigint 변환 (BigInt(row.token_id))
   */
  async findById(id: string): Promise<MintRequest | null> {
    // TODO: 구현
    // const { rows } = await this.db.query(
    //   'SELECT * FROM tx_mint_requests WHERE id = $1',
    //   [id],
    // );
    // if (rows.length === 0) return null;
    // return this._toModel(rows[0]!);
    throw new Error('PgTxRepository.findById: NOT IMPLEMENTED');
  }

  /**
   * 상태 + extra 필드 원자적 UPDATE
   * extra의 어떤 필드가 넘어올지 런타임에 결정되므로 동적 SET 절 구성 필요
   *
   * TODO: 동적 SET 절 구성 — extra 키별로 컬럼명 매핑 (camelCase → snake_case)
   * TODO: updated_at은 항상 NOW()로 갱신
   */
  async updateStatus(
    id:     string,
    status: TxStatus,
    extra?: Partial<MintRequest>,
  ): Promise<void> {
    // TODO: 구현
    // const sets: string[]  = ['status = $2', 'updated_at = NOW()'];
    // const params: unknown[] = [id, status];
    // let   idx = 3;
    //
    // if (extra?.txHash       !== undefined) { sets.push(`tx_hash = $${idx++}`);        params.push(extra.txHash); }
    // if (extra?.blockNumber  !== undefined) { sets.push(`block_number = $${idx++}`);   params.push(extra.blockNumber); }
    // if (extra?.retryCount   !== undefined) { sets.push(`retry_count = $${idx++}`);    params.push(extra.retryCount); }
    // if (extra?.gasPriceGwei !== undefined) { sets.push(`gas_price_gwei = $${idx++}`); params.push(extra.gasPriceGwei); }
    // if (extra?.failReason   !== undefined) { sets.push(`fail_reason = $${idx++}`);    params.push(extra.failReason); }
    //
    // await this.db.query(
    //   `UPDATE tx_mint_requests SET ${sets.join(', ')} WHERE id = $1`,
    //   params,
    // );
    throw new Error('PgTxRepository.updateStatus: NOT IMPLEMENTED');
  }

  /**
   * PENDING 상태 + createdAt 기준 stale 조회
   * pollStaleRequests()에서 30분 초과 건 감지용
   *
   * TODO: LIMIT 추가 검토 — 한 번에 너무 많은 건 처리 시 부하 방지
   * TODO: FOR UPDATE SKIP LOCKED 검토 — 다중 인스턴스 중복 처리 방지
   */
  async findPendingOlderThan(minutes: number): Promise<MintRequest[]> {
    // TODO: 구현
    // const { rows } = await this.db.query(
    //   `SELECT * FROM tx_mint_requests
    //    WHERE status = 'PENDING'
    //      AND created_at < NOW() - INTERVAL '${minutes} minutes'
    //    ORDER BY created_at ASC
    //    LIMIT 100`,   // TODO: LIMIT 값 설정 검토
    // );
    // return rows.map(r => this._toModel(r));
    throw new Error('PgTxRepository.findPendingOlderThan: NOT IMPLEMENTED');
  }

  // ── 내부 유틸 ──────────────────────────────────────────────────────────

  // TODO: 구현
  // private _toModel(row: Record<string, unknown>): MintRequest {
  //   return {
  //     id:           row['id']             as string,
  //     userId:       row['user_id']         as string,
  //     tokenId:      BigInt(row['token_id'] as string),
  //     amount:       BigInt(row['amount']   as string),
  //     status:       row['status']          as TxStatus,
  //     txHash:       row['tx_hash']         as string | undefined,
  //     blockNumber:  row['block_number']    as number | undefined,
  //     retryCount:   row['retry_count']     as number,
  //     gasPriceGwei: row['gas_price_gwei']  as number | undefined,
  //     failReason:   row['fail_reason']     as string | undefined,
  //     createdAt:    new Date(row['created_at'] as string),
  //     updatedAt:    new Date(row['updated_at'] as string),
  //   };
  // }
}
