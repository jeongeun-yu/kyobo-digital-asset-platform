import type { Pool } from 'pg';

/**
 * PgDatabaseClient — pg.Pool → LedgerService.DatabaseClient 어댑터
 */
export class PgDatabaseClient {
  constructor(private readonly pool: Pool) {}

  async query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    const res = await this.pool.query(sql, params as any[]);
    return { rows: res.rows };
  }
}
