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

export interface LogParams {
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  beforeState?: unknown;
  afterState: unknown;
  ipAddress?: string;
  sessionId?: string;
}

export interface VerifyResult {
  id: number;
  valid: boolean;
  storedChecksum: string;
  computedChecksum: string;
}

/**
 * AuditLogService — 금융 규제 기준 감사 로그
 *
 * 규제 근거:
 *   전자금융감독규정 §34: 접근 기록 1년 이상 보존
 *   가상자산이용자보호법 §15: 거래 기록 5년 보존
 *   ISMS-P: 암호 무결성 검증 요건
 *
 * 무결성 보장:
 *   checksum = SHA-256(eventTime || actor || action || resourceId || JSON(afterState))
 *   DB 레벨에서도 INSERT-only Row Security Policy 적용 필요
 */
export class AuditLogService {
  constructor(private readonly db: DatabaseClient) {}

  async log(params: LogParams): Promise<number> {
    const eventTime = new Date();
    const checksum = this.generateChecksum(
      eventTime,
      params.actor,
      params.action,
      params.resourceId,
      params.afterState,
    );

    // TODO:
    // INSERT INTO audit_log
    //   (event_time, actor, action, resource_type, resource_id,
    //    before_state, after_state, ip_address, session_id, checksum)
    // VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    // RETURNING id
    //
    // return rows[0].id
    throw new Error('Not implemented');
  }

  async verifyIntegrity(id: number): Promise<VerifyResult> {
    // TODO:
    // 1. SELECT * FROM audit_log WHERE id = $1
    // 2. 저장된 checksum 추출
    // 3. 나머지 필드로 checksum 재계산
    // 4. storedChecksum === computedChecksum 비교
    // return { id, valid, storedChecksum, computedChecksum }
    throw new Error('Not implemented');
  }

  async queryByResource(
    resourceType: string,
    resourceId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<AuditEntry[]> {
    // TODO:
    // SELECT * FROM audit_log
    // WHERE resource_type = $1 AND resource_id = $2
    // ORDER BY event_time ASC
    // LIMIT $3 OFFSET $4
    throw new Error('Not implemented');
  }

  async queryByActor(
    actor: string,
    from: Date,
    to: Date,
  ): Promise<AuditEntry[]> {
    // TODO:
    // SELECT * FROM audit_log
    // WHERE actor = $1 AND event_time BETWEEN $2 AND $3
    // ORDER BY event_time ASC
    throw new Error('Not implemented');
  }

  // ── Private ───────────────────────────────────────────────────

  private generateChecksum(
    eventTime: Date,
    actor: string,
    action: string,
    resourceId: string,
    afterState: unknown,
  ): string {
    // TODO:
    // 입력: eventTime.toISOString() + actor + action + resourceId + JSON.stringify(afterState)
    // 알고리즘: SHA-256
    // return hex digest
    const raw = `${eventTime.toISOString()}${actor}${action}${resourceId}${JSON.stringify(afterState)}`;
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }
}

// ── Interface ─────────────────────────────────────────────────

interface DatabaseClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
