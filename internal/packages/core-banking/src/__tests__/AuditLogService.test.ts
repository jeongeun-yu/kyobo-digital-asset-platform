/**
 * AuditLogService 단위 테스트 — 읽기 전용 (조회·무결성 검증)
 *
 * 쓰기(log())는 Java 위임으로 변경됨. 이 테스트는 조회·검증 경로만 다룬다.
 */

import { createHash } from 'crypto';
import { AuditLogService } from '../audit/AuditLogService';

// ── In-Memory DB Mock ────────────────────────────────────────────────────────

function makeDb() {
  let nextId = 1;
  const rows: Record<string, unknown>[] = [];

  return {
    rows,
    get nextId() { return nextId; },
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      const s = sql.trim().toUpperCase();

      if (s.startsWith('SELECT * FROM AUDIT_LOG WHERE ID')) {
        const id = params[0] as number;
        return { rows: rows.filter(r => r['id'] === id) };
      }

      if (s.startsWith('SELECT * FROM AUDIT_LOG\n       WHERE RESOURCE_TYPE')) {
        return { rows: rows.filter(r => r['resource_type'] === params[0] && r['resource_id'] === params[1]) };
      }

      if (s.startsWith('SELECT * FROM AUDIT_LOG\n       WHERE ACTOR')) {
        return { rows: rows.filter(r => r['actor'] === params[0]) };
      }

      return { rows };
    },
    // 테스트 데이터 직접 삽입 헬퍼
    seed(params: {
      actor: string; action: string; resourceType: string;
      resourceId: string; afterState: unknown; beforeState?: unknown;
    }): number {
      const eventTime = new Date();
      const raw = `${eventTime.toISOString()}${params.actor}${params.action}${params.resourceId}${JSON.stringify(params.afterState)}`;
      const checksum = createHash('sha256').update(raw, 'utf8').digest('hex');
      const id = nextId++;
      rows.push({
        id,
        event_time:    eventTime.toISOString(),
        actor:         params.actor,
        action:        params.action,
        resource_type: params.resourceType,
        resource_id:   params.resourceId,
        before_state:  params.beforeState !== undefined ? JSON.stringify(params.beforeState) : null,
        after_state:   JSON.stringify(params.afterState),
        ip_address:    null,
        session_id:    null,
        checksum,
      });
      return id;
    },
  };
}

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('AuditLogService.verifyIntegrity()', () => {
  it('정상 레코드 검증 → valid: true', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    const id  = db.seed({ actor: 'system', action: 'MINT_REQUESTED', resourceType: 'MintRequest', resourceId: 'req-001', afterState: { status: 'REQUESTED' } });
    const result = await svc.verifyIntegrity(id);
    expect(result.valid).toBe(true);
    expect(result.storedChecksum).toBe(result.computedChecksum);
  });

  it('체크섬 조작 후 검증 → valid: false', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    const id  = db.seed({ actor: 'system', action: 'MINT_REQUESTED', resourceType: 'MintRequest', resourceId: 'req-001', afterState: { status: 'REQUESTED' } });

    const row = db.rows.find(r => r['id'] === id)!;
    row['checksum'] = '0'.repeat(64);

    const result = await svc.verifyIntegrity(id);
    expect(result.valid).toBe(false);
  });

  it('존재하지 않는 ID → Error throw', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    await expect(svc.verifyIntegrity(9999)).rejects.toThrow('AuditLog not found');
  });
});

describe('AuditLogService.queryByResource()', () => {
  it('beforeState 포함 로그 조회 시 역직렬화 반환', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    db.seed({ actor: 'system', action: 'MINT_REQUESTED', resourceType: 'MintRequest', resourceId: 'req-001', afterState: { status: 'REQUESTED' }, beforeState: { status: 'SUBMITTED' } });

    const results = await svc.queryByResource('MintRequest', 'req-001');
    expect(results[0]!.beforeState).toEqual({ status: 'SUBMITTED' });
  });

  it('해당 resource의 로그만 반환', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    db.seed({ actor: 'system', action: 'MINT_REQUESTED', resourceType: 'MintRequest', resourceId: 'req-001', afterState: {} });
    db.seed({ actor: 'system', action: 'MINT_REQUESTED', resourceType: 'MintRequest', resourceId: 'req-002', afterState: {} });

    const results = await svc.queryByResource('MintRequest', 'req-001');
    expect(results).toHaveLength(1);
    expect(results[0]!.resourceId).toBe('req-001');
  });
});

describe('AuditLogService.queryByActor()', () => {
  it('actor + 시간 범위에 해당하는 로그 반환', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    db.seed({ actor: 'admin-01', action: 'MINT_REQUESTED', resourceType: 'MintRequest', resourceId: 'req-001', afterState: {} });
    db.seed({ actor: 'admin-02', action: 'MINT_REQUESTED', resourceType: 'MintRequest', resourceId: 'req-002', afterState: {} });

    const from = new Date(Date.now() - 60_000);
    const to   = new Date(Date.now() + 60_000);
    const results = await svc.queryByActor('admin-01', from, to);

    expect(results).toHaveLength(1);
    expect(results[0]!.actor).toBe('admin-01');
  });

  it('해당 actor 로그 없으면 빈 배열', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);

    const from = new Date(Date.now() - 60_000);
    const to   = new Date(Date.now() + 60_000);
    const results = await svc.queryByActor('no-such-actor', from, to);
    expect(results).toHaveLength(0);
  });
});
