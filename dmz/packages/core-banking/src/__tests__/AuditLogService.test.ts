/**
 * AuditLogService 단위 테스트
 *
 * SHA-256 체크섬 생성, 무결성 검증, 조작 감지 검증
 */

import { AuditLogService } from '../audit/AuditLogService';
import type { LogParams } from '../audit/AuditLogService';

// ── In-Memory DB Mock ────────────────────────────────────────────────────────

function makeDb() {
  let nextId = 1;
  const rows: Record<string, unknown>[] = [];

  return {
    rows,
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      const s = sql.trim().toUpperCase();

      if (s.startsWith('INSERT INTO AUDIT_LOG')) {
        const [eventTime, actor, action, resourceType, resourceId, beforeState, afterState, ip, session, checksum] = params;
        const row: Record<string, unknown> = {
          id:            nextId++,
          event_time:    eventTime,
          actor,
          action,
          resource_type: resourceType,
          resource_id:   resourceId,
          before_state:  beforeState,
          after_state:   afterState,
          ip_address:    ip,
          session_id:    session,
          checksum,
        };
        rows.push(row);
        return { rows: [{ id: row['id'] }] };
      }

      if (s.startsWith('SELECT * FROM AUDIT_LOG WHERE ID')) {
        const id = params[0] as number;
        return { rows: rows.filter(r => r['id'] === id) };
      }

      if (s.startsWith('SELECT * FROM AUDIT_LOG\n       WHERE RESOURCE_TYPE') ||
          s.startsWith('SELECT * FROM AUDIT_LOG\n       WHERE RESOURCE_TYPE')) {
        return { rows: rows.filter(r => r['resource_type'] === params[0] && r['resource_id'] === params[1]) };
      }

      if (s.startsWith('SELECT * FROM AUDIT_LOG\n       WHERE ACTOR')) {
        return { rows: rows.filter(r => r['actor'] === params[0]) };
      }

      return { rows };
    },
  };
}

const BASE_PARAMS: LogParams = {
  actor:        'system',
  action:       'MINT_REQUESTED',
  resourceType: 'MintRequest',
  resourceId:   'req-001',
  afterState:   { status: 'PENDING' },
};

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('AuditLogService.log()', () => {
  it('로그 ID(숫자) 반환', async () => {
    const svc = new AuditLogService(makeDb());
    const id = await svc.log(BASE_PARAMS);
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('DB에 레코드 1건 저장', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    await svc.log(BASE_PARAMS);
    expect(db.rows).toHaveLength(1);
  });

  it('저장된 레코드의 actor, action, resourceId 일치', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    await svc.log(BASE_PARAMS);
    const row = db.rows[0]!;
    expect(row['actor']).toBe('system');
    expect(row['action']).toBe('MINT_REQUESTED');
    expect(row['resource_id']).toBe('req-001');
  });

  it('checksum이 64자 hex 문자열', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    await svc.log(BASE_PARAMS);
    const checksum = db.rows[0]!['checksum'] as string;
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('beforeState가 있으면 직렬화하여 저장', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    await svc.log({ ...BASE_PARAMS, beforeState: { status: 'SUBMITTED' } });
    const row = db.rows[0]!;
    expect(row['before_state']).not.toBeNull();
  });

  it('beforeState 없으면 null 저장', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    await svc.log(BASE_PARAMS);
    const row = db.rows[0]!;
    expect(row['before_state']).toBeNull();
  });
});

describe('AuditLogService.verifyIntegrity()', () => {
  it('저장된 직후 체크섬 검증 → valid: true', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    const id  = await svc.log(BASE_PARAMS);
    const result = await svc.verifyIntegrity(id);
    expect(result.valid).toBe(true);
    expect(result.storedChecksum).toBe(result.computedChecksum);
  });

  it('체크섬 조작 후 검증 → valid: false', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    const id  = await svc.log(BASE_PARAMS);

    // 체크섬 조작
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
    await svc.log({ ...BASE_PARAMS, beforeState: { status: 'SUBMITTED' } });

    const results = await svc.queryByResource('MintRequest', 'req-001');
    expect(results[0]!.beforeState).toEqual({ status: 'SUBMITTED' });
  });

  it('해당 resource의 로그만 반환', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    await svc.log({ ...BASE_PARAMS, resourceId: 'req-001' });
    await svc.log({ ...BASE_PARAMS, resourceId: 'req-002' });

    const results = await svc.queryByResource('MintRequest', 'req-001');
    expect(results).toHaveLength(1);
    expect(results[0]!.resourceId).toBe('req-001');
  });
});

describe('AuditLogService.queryByActor()', () => {
  it('actor + 시간 범위에 해당하는 로그 반환', async () => {
    const db  = makeDb();
    const svc = new AuditLogService(db);
    await svc.log({ ...BASE_PARAMS, actor: 'admin-01' });
    await svc.log({ ...BASE_PARAMS, actor: 'admin-02' });

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
