import type { Pool } from 'pg';

export class PgNftHoldingRepository {
  constructor(private readonly pool: Pool) {}

  async getHoldings(userId: string): Promise<bigint[]> {
    const { rows } = await this.pool.query(
      `SELECT token_id FROM user_nft_holdings
       WHERE user_id = $1 AND released_at IS NULL`,
      [userId],
    );
    return rows.map(r => BigInt(r.token_id as string));
  }

  async getHoldingAmount(userId: string, tokenId: bigint): Promise<bigint> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM user_nft_holdings
       WHERE user_id = $1 AND token_id = $2 AND released_at IS NULL`,
      [userId, tokenId.toString()],
    );
    return BigInt(rows[0]?.['total'] ?? 0);
  }

  async getAllUserIds(): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT user_id FROM user_nft_holdings
       WHERE released_at IS NULL ORDER BY user_id`,
    );
    return rows.map(r => r.user_id as string);
  }
}
