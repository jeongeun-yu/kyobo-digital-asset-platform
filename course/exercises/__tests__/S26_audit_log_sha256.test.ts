/**
 * S26 채점 — SHA-256 체인 감사 로그: checksum 생성 · 중간 수정 감지 · 연속 감사 로그
 *
 * 채점 기준:
 *   · log() — SHA-256 체인 방식 checksum 생성 + INSERT, 순차 id 증가
 *   · verifyIntegrity(id) — 단건 무결성 검증
 *   · verifyChainIntegrity() — 전체 체인 순차 검증
 *   · 중간 레코드 DELETE → 이후 체인 불일치 감지
 *   · afterState 수정 → 해당 레코드부터 체인 불일치 감지
 *   · queryByResource / queryByActor 조회
 *   · 단일 Writer 큐 — 동시 log() 호출 시 체인 무결성 유지
 */

import {
  AuditLogService,
} from '../M4/S26_audit_log_sha256';

// ── 채점 테스트 ───────────────────────────────────────────────────────────────

describe('S26 채점 — SHA-256 체인 감사 로그', () => {

  describe('log() — SHA-256 체인 checksum 생성 및 순차 id', () => {
    it('TODO: log() 반환 id가 1부터 순차 증가해야 한다', async () => {
      const auditLog = new AuditLogService();
      const id1 = await auditLog.log({ actor: 'system', action: 'MINT_REQUESTED', resourceId: 'req-001', afterState: { status: 'REQUESTED' } });
      const id2 = await auditLog.log({ actor: 'system', action: 'STATUS_SUBMITTED', resourceId: 'req-001', afterState: { status: 'SUBMITTED' } });
      const id3 = await auditLog.log({ actor: 'system', action: 'STATUS_CONFIRMED', resourceId: 'req-001', afterState: { status: 'CONFIRMED' } });
      expect(id1).toBe(1);
      expect(id2).toBe(2);
      expect(id3).toBe(3);
    });

    it('TODO: checksum이 64자 소문자 hex 형식이어야 한다', async () => {
      const auditLog = new AuditLogService();
      await auditLog.log({ actor: 'system', action: 'MINT_REQUESTED', resourceId: 'req-001', afterState: { status: 'REQUESTED' } });
      const v = await auditLog.verifyIntegrity(1);
      expect(v.storedChecksum).toHaveLength(64);
      expect(v.storedChecksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('TODO: 각 레코드의 checksum이 서로 달라야 한다 (체인 연결 효과)', async () => {
      const auditLog = new AuditLogService();
      const id1 = await auditLog.log({ actor: 'system', action: 'A', resourceId: 'r1', afterState: { i: 1 } });
      const id2 = await auditLog.log({ actor: 'system', action: 'B', resourceId: 'r2', afterState: { i: 2 } });
      const v1 = await auditLog.verifyIntegrity(id1);
      const v2 = await auditLog.verifyIntegrity(id2);
      expect(v1.storedChecksum).not.toBe(v2.storedChecksum);
    });
  });

  describe('verifyIntegrity() — 단건 무결성 검증', () => {
    it('TODO: 정상 삽입된 레코드의 verifyIntegrity는 valid=true이어야 한다', async () => {
      const auditLog = new AuditLogService();
      const id1 = await auditLog.log({ actor: 'system:IssuerService', action: 'MINT_REQUESTED', resourceType: 'MintRequest', resourceId: 'req-001', afterState: { status: 'REQUESTED', userId: 'K-20240001' } });
      const id2 = await auditLog.log({ actor: 'system', action: 'STATUS_SUBMITTED', resourceType: 'MintRequest', resourceId: 'req-001', beforeState: { status: 'REQUESTED' }, afterState: { status: 'SUBMITTED', txHash: '0xabcabc0000000000abcabc0000000000abcabc0000000000abcabc0000000000' } });
      const id3 = await auditLog.log({ actor: 'system', action: 'STATUS_CONFIRMED', resourceType: 'MintRequest', resourceId: 'req-001', afterState: { status: 'CONFIRMED', tokenId: 1001 } });
      const v1 = await auditLog.verifyIntegrity(id1);
      const v2 = await auditLog.verifyIntegrity(id2);
      const v3 = await auditLog.verifyIntegrity(id3);
      expect(v1.valid).toBe(true);
      expect(v2.valid).toBe(true);
      expect(v3.valid).toBe(true);
    });

    it('TODO: 존재하지 않는 id 조회 시 에러가 발생해야 한다', async () => {
      const auditLog = new AuditLogService();
      await expect(auditLog.verifyIntegrity(999)).rejects.toThrow();
    });
  });

  describe('verifyChainIntegrity() — 전체 체인 검증', () => {
    it('TODO: 정상 상태에서 체인 전체가 valid=true이어야 한다', async () => {
      const auditLog = new AuditLogService();
      await auditLog.log({ actor: 'system', action: 'MINT_REQUESTED', resourceId: 'req-001', afterState: { status: 'REQUESTED' } });
      await auditLog.log({ actor: 'system', action: 'STATUS_SUBMITTED', resourceId: 'req-001', afterState: { status: 'SUBMITTED' } });
      await auditLog.log({ actor: 'system', action: 'STATUS_CONFIRMED', resourceId: 'req-001', afterState: { status: 'CONFIRMED' } });
      const chain = await auditLog.verifyChainIntegrity();
      expect(chain.valid).toBe(true);
      expect(chain.firstInvalidId).toBeUndefined();
      expect(chain.checkedCount).toBe(3);
    });

    it('TODO: 빈 로그의 체인 검증은 valid=true, checkedCount=0이어야 한다', async () => {
      const auditLog = new AuditLogService();
      const chain = await auditLog.verifyChainIntegrity();
      expect(chain.valid).toBe(true);
      expect(chain.checkedCount).toBe(0);
    });
  });

  describe('중간 레코드 DELETE → 체인 불일치 감지', () => {
    it('TODO: 중간 레코드 삭제 시 체인 불일치가 감지되어야 한다', async () => {
      const auditLog = new AuditLogService();
      await auditLog.log({ actor: 'system', action: 'MINT_REQUESTED', resourceId: 'req-001', afterState: { status: 'REQUESTED' } });
      const id2 = await auditLog.log({ actor: 'system', action: 'STATUS_SUBMITTED', resourceId: 'req-001', afterState: { status: 'SUBMITTED' } });
      const id3 = await auditLog.log({ actor: 'system', action: 'STATUS_CONFIRMED', resourceId: 'req-001', afterState: { status: 'CONFIRMED' } });
      auditLog._dangerousDeleteRow(id2);
      const chain = await auditLog.verifyChainIntegrity();
      expect(chain.valid).toBe(false);
      expect(chain.firstInvalidId).toBe(id3);
    });

    it('TODO: 삭제 후 첫 번째 불일치 레코드 id가 정확해야 한다', async () => {
      const auditLog = new AuditLogService();
      const id1 = await auditLog.log({ actor: 'sys', action: 'A', resourceId: 'r1', afterState: {} });
      const id2 = await auditLog.log({ actor: 'sys', action: 'B', resourceId: 'r2', afterState: {} });
      await auditLog.log({ actor: 'sys', action: 'C', resourceId: 'r3', afterState: {} });
      auditLog._dangerousDeleteRow(id1);
      const chain = await auditLog.verifyChainIntegrity();
      expect(chain.valid).toBe(false);
      expect(chain.firstInvalidId).toBe(id2);
    });
  });

  describe('afterState 수정 → 체인 불일치 감지', () => {
    it('TODO: afterState 수정 시 해당 레코드부터 체인 불일치가 감지되어야 한다', async () => {
      const auditLog = new AuditLogService();
      const aid1 = await auditLog.log({ actor: 'system', action: 'A', resourceId: 'r1', afterState: { status: 'PENDING' } });
      await auditLog.log({ actor: 'system', action: 'B', resourceId: 'r2', afterState: { status: 'DONE' } });
      const chain3 = await auditLog.verifyChainIntegrity();
      expect(chain3.valid).toBe(true);
      auditLog._dangerousModifyAfterState(aid1, { status: 'CONFIRMED' });
      const chain4 = await auditLog.verifyChainIntegrity();
      expect(chain4.valid).toBe(false);
      expect(chain4.firstInvalidId).toBe(aid1);
    });

    it('TODO: 마지막 레코드 afterState 수정 시 해당 레코드만 불일치여야 한다', async () => {
      const auditLog = new AuditLogService();
      await auditLog.log({ actor: 'system', action: 'A', resourceId: 'r1', afterState: { v: 1 } });
      const id2 = await auditLog.log({ actor: 'system', action: 'B', resourceId: 'r2', afterState: { v: 2 } });
      const chainBefore = await auditLog.verifyChainIntegrity();
      expect(chainBefore.valid).toBe(true);
      auditLog._dangerousModifyAfterState(id2, { v: 999 });
      const chainAfter = await auditLog.verifyChainIntegrity();
      expect(chainAfter.valid).toBe(false);
      expect(chainAfter.firstInvalidId).toBe(id2);
    });
  });

  describe('queryByResource / queryByActor 조회', () => {
    let auditLog: AuditLogService;

    beforeEach(async () => {
      auditLog = new AuditLogService();
      await auditLog.log({ actor: 'user-001', action: 'LOGIN',   resourceId: 'session-1', afterState: {} });
      await auditLog.log({ actor: 'system',   action: 'MINT',    resourceId: 'req-100',   afterState: { status: 'REQUESTED' } });
      await auditLog.log({ actor: 'user-001', action: 'LOGOUT',  resourceId: 'session-1', afterState: {} });
      await auditLog.log({ actor: 'system',   action: 'CONFIRM', resourceId: 'req-100',   afterState: { status: 'CONFIRMED' } });
      await auditLog.log({ actor: 'user-002', action: 'LOGIN',   resourceId: 'session-2', afterState: {} });
    });

    it('TODO: queryByResource는 해당 resourceId의 항목만 반환해야 한다', () => {
      const byResource = auditLog.queryByResource('req-100', { orderBy: 'asc' });
      expect(byResource).toHaveLength(2);
    });

    it('TODO: queryByResource orderBy=asc 시 첫 번째 action이 MINT이어야 한다', () => {
      const byResource = auditLog.queryByResource('req-100', { orderBy: 'asc' });
      expect(byResource[0]?.action).toBe('MINT');
    });

    it('TODO: queryByResource orderBy=asc 시 두 번째 action이 CONFIRM이어야 한다', () => {
      const byResource = auditLog.queryByResource('req-100', { orderBy: 'asc' });
      expect(byResource[1]?.action).toBe('CONFIRM');
    });

    it('TODO: queryByActor는 해당 actor의 항목만 반환해야 한다', () => {
      const byActor = auditLog.queryByActor('user-001', { orderBy: 'asc' });
      expect(byActor).toHaveLength(2);
      expect(byActor.some(r => r.action === 'LOGIN')).toBe(true);
      expect(byActor.some(r => r.action === 'LOGOUT')).toBe(true);
    });

    it('TODO: queryByActor user-002는 1건을 반환해야 한다', () => {
      const byActor2 = auditLog.queryByActor('user-002');
      expect(byActor2).toHaveLength(1);
    });
  });

  describe('단일 Writer 큐 — 동시 log() 호출 시 체인 무결성', () => {
    it('TODO: Promise.all 동시 삽입 후에도 체인 무결성이 유지되어야 한다', async () => {
      const auditLog = new AuditLogService();
      await Promise.all([
        auditLog.log({ actor: 'w1', action: 'E1', resourceId: 'r1', afterState: { i: 1 } }),
        auditLog.log({ actor: 'w2', action: 'E2', resourceId: 'r2', afterState: { i: 2 } }),
        auditLog.log({ actor: 'w3', action: 'E3', resourceId: 'r3', afterState: { i: 3 } }),
        auditLog.log({ actor: 'w4', action: 'E4', resourceId: 'r4', afterState: { i: 4 } }),
        auditLog.log({ actor: 'w5', action: 'E5', resourceId: 'r5', afterState: { i: 5 } }),
      ]);
      const chain = await auditLog.verifyChainIntegrity();
      expect(chain.valid).toBe(true);
      expect(chain.checkedCount).toBe(5);
    });

    it('TODO: 동시 삽입 후 id 중복이 없어야 한다', async () => {
      const auditLog = new AuditLogService();
      const ids = await Promise.all([
        auditLog.log({ actor: 'w1', action: 'E1', resourceId: 'r1', afterState: { i: 1 } }),
        auditLog.log({ actor: 'w2', action: 'E2', resourceId: 'r2', afterState: { i: 2 } }),
        auditLog.log({ actor: 'w3', action: 'E3', resourceId: 'r3', afterState: { i: 3 } }),
      ]);
      expect(new Set(ids).size).toBe(3);
    });
  });

  describe('Append-only 보정 패턴', () => {
    it('TODO: 보정 레코드를 새 INSERT로 추가해도 체인 무결성이 유지되어야 한다', async () => {
      const auditLog = new AuditLogService();
      await auditLog.log({ actor: 'system', action: 'MINT_REQUESTED',  resourceId: 'req-200', afterState: { status: 'PENDING' } });
      await auditLog.log({ actor: 'system', action: 'STATUS_CONFIRMED', resourceId: 'req-200', afterState: { status: 'CONFIRMED', txHash: '0x...' } });
      await auditLog.log({ actor: 'ops-team/reconcile-runbook', action: 'RECONCILE_CORRECTION', resourceId: 'req-200', afterState: { reason: 'consumer_delay', action_taken: 'waited_30min_resolved' } });
      const chain = await auditLog.verifyChainIntegrity();
      expect(chain.valid).toBe(true);
      expect(chain.checkedCount).toBe(3);
    });

    it('TODO: 보정 포함 전체 이력에서 마지막 항목이 RECONCILE_CORRECTION이어야 한다', async () => {
      const auditLog = new AuditLogService();
      await auditLog.log({ actor: 'system', action: 'MINT_REQUESTED',  resourceId: 'req-200', afterState: { status: 'PENDING' } });
      await auditLog.log({ actor: 'system', action: 'STATUS_CONFIRMED', resourceId: 'req-200', afterState: { status: 'CONFIRMED', txHash: '0x...' } });
      await auditLog.log({ actor: 'ops-team/reconcile-runbook', action: 'RECONCILE_CORRECTION', resourceId: 'req-200', afterState: { reason: 'consumer_delay' } });
      const byReq = auditLog.queryByResource('req-200', { orderBy: 'asc' });
      expect(byReq).toHaveLength(3);
      expect(byReq[2]?.action).toBe('RECONCILE_CORRECTION');
    });
  });
});
