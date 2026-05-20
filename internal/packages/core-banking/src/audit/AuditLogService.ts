import { createHash } from 'crypto';

export interface AuditEntry {
  id: number;
  eventTime: Date;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  beforeState?: unknown;
  afterState: unknown;
  ipAddress?: string;
  sessionId?: string;
  checksum: string;
}

export interface VerifyResult {
  id: number;
  valid: boolean;
  storedChecksum: string;
  computedChecksum: string;
}

/**
 * AuditLogService — 감사 로그 조회·검증 (읽기 전용)
 *
 * 쓰기(INSERT)는 Java internal-ledger가 전담한다.
 * Node.js에서 감사 이벤트 발생 시 ICoreBankingAdapter.recordAuditLog()로 위임.
 *
 * 규제 근거:
 *   전자금융감독규정 §34: 접근 기록 1년 이상 보존
 *   가상자산이용자보호법 §15: 거래 기록 5년 보존
 *   ISMS-P: 암호 무결성 검증 요건
 */
export class AuditLogService {
  constructor(private readonly db: DatabaseClient) {}

  async verifyIntegrity(id: number): Promise<VerifyResult> {
    const { rows } = await this.db.query(
      'SELECT * FROM audit_log WHERE id = $1',
      [id],
    );
    if (rows.length === 0) throw new Error(`AuditLog not found: ${id}`);

    const row             = rows[0]!;
    const storedChecksum  = row['checksum'] as string;
    const computedChecksum = this.generateChecksum(
      new Date(row['event_time'] as string),
      row['actor'] as string,
      row['action'] as string,
      row['resource_id'] as string,
      JSON.parse(row['after_state'] as string),
    );

    return { id, valid: storedChecksum === computedChecksum, storedChecksum, computedChecksum };
  }

  async queryByResource(
    resourceType: string,
    resourceId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<AuditEntry[]> {
    const limit  = opts?.limit  ?? 100;
    const offset = opts?.offset ?? 0;

    const { rows } = await this.db.query(
      `SELECT * FROM audit_log
       WHERE resource_type = $1 AND resource_id = $2
       ORDER BY event_time ASC
       LIMIT $3 OFFSET $4`,
      [resourceType, resourceId, limit, offset],
    );
    return rows.map(this._rowToEntry);
  }

  async queryByActor(actor: string, from: Date, to: Date): Promise<AuditEntry[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM audit_log
       WHERE actor = $1 AND event_time BETWEEN $2 AND $3
       ORDER BY event_time ASC`,
      [actor, from.toISOString(), to.toISOString()],
    );
    return rows.map(this._rowToEntry);
  }

  // ── Private ───────────────────────────────────────────────────

  private generateChecksum(
    eventTime: Date,
    actor: string,
    action: string,
    resourceId: string,
    afterState: unknown,
  ): string {
    const raw = `${eventTime.toISOString()}${actor}${action}${resourceId}${JSON.stringify(afterState)}`;
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  private _rowToEntry(row: Record<string, unknown>): AuditEntry {
    return {
      id:           row['id'] as number,
      eventTime:    new Date(row['event_time'] as string),
      actor:        row['actor'] as string,
      action:       row['action'] as string,
      resourceType: row['resource_type'] as string,
      resourceId:   row['resource_id'] as string,
      beforeState:  row['before_state'] ? JSON.parse(row['before_state'] as string) : undefined,
      afterState:   JSON.parse(row['after_state'] as string),
      ipAddress:    row['ip_address'] as string | undefined,
      sessionId:    row['session_id'] as string | undefined,
      checksum:     row['checksum'] as string,
    };
  }
}

// ── Interface ─────────────────────────────────────────────────

interface DatabaseClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
