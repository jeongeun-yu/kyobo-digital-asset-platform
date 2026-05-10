/**
 * S45 채점 — Admin API: 운영 관리 엔드포인트 설계와 RBAC 검증
 *
 * 채점 기준:
 *   · requireRole: ADMIN_ROLE 미보유 → statusCode 401 + Unauthorized 메시지
 *   · pauseContract / unpauseContract: 상태 전이 + 감사 로그
 *   · triggerReconcile: 불일치 건수 반환 + severity 판정
 *   · grantRole / revokeRole: 역할 부여·회수 + 감사 로그
 *   · getIssuanceStats: 상태별 카운트 집계
 */

import { ethers } from 'ethers';
import {
  AdminController,
  MockAuditLogService,
  MockReconcileService,
  MockKyoboNFT,
  MockDatabase,
  RequestContext,
  ReconcileResult,
  IssuanceStats,
} from '../M8/S45_admin_api';

// ─── 픽스처 팩토리 ───────────────────────────────────────────────────────────

function makeFixtures(mismatches: ReconcileResult['mismatches'] = []) {
  const contract        = new MockKyoboNFT();
  const auditLog        = new MockAuditLogService();
  const db              = new MockDatabase();
  const reconcileSvc    = new MockReconcileService(mismatches);
  const ctrl            = new AdminController(contract, reconcileSvc, auditLog, db);
  const adminCtx: RequestContext = { user: { id: 'admin-001', roles: ['ADMIN_ROLE'] }, ipAddress: '10.0.1.55' };
  const userCtx: RequestContext  = { user: { id: 'user-001', roles: ['MINTER_ROLE'] }, ipAddress: '10.0.1.99' };
  return { contract, auditLog, db, ctrl, adminCtx, userCtx };
}

// ─── 채점 테스트 ─────────────────────────────────────────────────────────────

describe('S45 채점 — Admin API', () => {

  describe('TODO: ADMIN_ROLE 없으면 401 반환', () => {
    it('일반 사용자가 pauseContract 호출 → statusCode 401', async () => {
      const { ctrl, userCtx } = makeFixtures();
      await expect(ctrl.pauseContract(userCtx, '테스트')).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('일반 사용자가 triggerReconcile 호출 → Unauthorized 메시지', async () => {
      const { ctrl, userCtx } = makeFixtures();
      await expect(ctrl.triggerReconcile(userCtx)).rejects.toThrow(/Unauthorized/);
    });

    it('일반 사용자가 grantRole 호출 → statusCode 401', async () => {
      const { ctrl, userCtx } = makeFixtures();
      await expect(ctrl.grantRole(userCtx, '0x1234', 'MINTER_ROLE')).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('일반 사용자가 getIssuanceStats 호출 → statusCode 401', async () => {
      const { ctrl, userCtx } = makeFixtures();
      await expect(ctrl.getIssuanceStats(userCtx)).rejects.toMatchObject({
        statusCode: 401,
      });
    });
  });

  describe('TODO: pause / unpause → 컨트랙트 상태 전이 + 감사 로그', () => {
    it('초기 상태는 paused = false', () => {
      const { contract } = makeFixtures();
      expect(contract.isPaused()).toBe(false);
    });

    it('pauseContract 성공: success = true, txHash 반환', async () => {
      const { ctrl, adminCtx } = makeFixtures();
      const result = await ctrl.pauseContract(adminCtx, '보안 점검');
      expect(result.success).toBe(true);
      expect(result.txHash).toMatch(/^0x/);
    });

    it('pauseContract 후 컨트랙트 상태: paused = true', async () => {
      const { ctrl, contract, adminCtx } = makeFixtures();
      await ctrl.pauseContract(adminCtx, '보안 점검');
      expect(contract.isPaused()).toBe(true);
    });

    it('pauseContract 후 감사 로그 action: CONTRACT_PAUSED', async () => {
      const { ctrl, auditLog, adminCtx } = makeFixtures();
      await ctrl.pauseContract(adminCtx, '보안 점검');
      expect(auditLog.getLastLog()?.action).toBe('CONTRACT_PAUSED');
    });

    it('pauseContract 감사 로그 actor: admin-001', async () => {
      const { ctrl, auditLog, adminCtx } = makeFixtures();
      await ctrl.pauseContract(adminCtx, '보안 점검');
      expect(auditLog.getLastLog()?.actor).toBe('admin-001');
    });

    it('pauseContract 감사 로그 afterState.paused = true', async () => {
      const { ctrl, auditLog, adminCtx } = makeFixtures();
      await ctrl.pauseContract(adminCtx, '보안 점검');
      expect(auditLog.getLastLog()?.afterState['paused']).toBe(true);
    });

    it('unpauseContract 후 컨트랙트 상태: paused = false', async () => {
      const { ctrl, contract, adminCtx } = makeFixtures();
      await ctrl.pauseContract(adminCtx);
      await ctrl.unpauseContract(adminCtx);
      expect(contract.isPaused()).toBe(false);
    });

    it('unpauseContract 감사 로그 action: CONTRACT_UNPAUSED', async () => {
      const { ctrl, auditLog, adminCtx } = makeFixtures();
      await ctrl.pauseContract(adminCtx);
      await ctrl.unpauseContract(adminCtx);
      expect(auditLog.getLastLog()?.action).toBe('CONTRACT_UNPAUSED');
    });
  });

  describe('TODO: reconcile 트리거 → 불일치 건수 반환', () => {
    it('불일치 0건 → mismatchCount: 0, severity: OK', async () => {
      const { ctrl, adminCtx } = makeFixtures([]);
      const result = await ctrl.triggerReconcile(adminCtx);
      expect(result.mismatchCount).toBe(0);
      expect(result.severity).toBe('OK');
    });

    it('불일치 3건 → mismatchCount: 3, severity: WARNING', async () => {
      const mismatches = [
        { userId: 'u1', tokenId: '1001', ledgerBalance: 5,  onchainBalance: 10 },
        { userId: 'u2', tokenId: '1002', ledgerBalance: 3,  onchainBalance: 0  },
        { userId: 'u3', tokenId: '1003', ledgerBalance: 10, onchainBalance: 7  },
      ];
      const { ctrl, adminCtx } = makeFixtures(mismatches);
      const result = await ctrl.triggerReconcile(adminCtx);
      expect(result.mismatchCount).toBe(3);
      expect(result.severity).toBe('WARNING');
    });

    it('totalChecked: 1200 반환', async () => {
      const { ctrl, adminCtx } = makeFixtures([]);
      const result = await ctrl.triggerReconcile(adminCtx);
      expect(result.totalChecked).toBe(1200);
    });

    it('reconcile 후 감사 로그 action: RECONCILE_TRIGGERED', async () => {
      const mismatches = [
        { userId: 'u1', tokenId: '1001', ledgerBalance: 5, onchainBalance: 10 },
        { userId: 'u2', tokenId: '1002', ledgerBalance: 3, onchainBalance: 0  },
        { userId: 'u3', tokenId: '1003', ledgerBalance: 10, onchainBalance: 7 },
      ];
      const { ctrl, auditLog, adminCtx } = makeFixtures(mismatches);
      await ctrl.triggerReconcile(adminCtx);
      expect(auditLog.getLastLog()?.action).toBe('RECONCILE_TRIGGERED');
    });

    it('감사 로그 afterState.mismatchCount: 3', async () => {
      const mismatches = [
        { userId: 'u1', tokenId: '1001', ledgerBalance: 5, onchainBalance: 10 },
        { userId: 'u2', tokenId: '1002', ledgerBalance: 3, onchainBalance: 0  },
        { userId: 'u3', tokenId: '1003', ledgerBalance: 10, onchainBalance: 7 },
      ];
      const { ctrl, auditLog, adminCtx } = makeFixtures(mismatches);
      await ctrl.triggerReconcile(adminCtx);
      expect(auditLog.getLastLog()?.afterState['mismatchCount']).toBe(3);
    });
  });

  describe('TODO: grantRole / revokeRole → 감사 로그 기록', () => {
    const TARGET = '0xAbCd000000000000000000000000000000000000';
    const ROLE   = 'MINTER_ROLE';

    it('grantRole 전: hasRole = false', async () => {
      const { contract } = makeFixtures();
      expect(await contract.hasRole(ethers.id(ROLE), TARGET)).toBe(false);
    });

    it('grantRole 후: success = true, txHash 반환', async () => {
      const { ctrl, adminCtx } = makeFixtures();
      const result = await ctrl.grantRole(adminCtx, TARGET, ROLE);
      expect(result.success).toBe(true);
      expect(result.txHash).toMatch(/^0x/);
    });

    it('grantRole 후: hasRole = true', async () => {
      const { ctrl, contract, adminCtx } = makeFixtures();
      await ctrl.grantRole(adminCtx, TARGET, ROLE);
      expect(await contract.hasRole(ethers.id(ROLE), TARGET)).toBe(true);
    });

    it('grantRole 감사 로그 action: ROLE_GRANTED', async () => {
      const { ctrl, auditLog, adminCtx } = makeFixtures();
      await ctrl.grantRole(adminCtx, TARGET, ROLE);
      expect(auditLog.getLastLog()?.action).toBe('ROLE_GRANTED');
    });

    it('grantRole 감사 로그 resourceId: targetAddress', async () => {
      const { ctrl, auditLog, adminCtx } = makeFixtures();
      await ctrl.grantRole(adminCtx, TARGET, ROLE);
      expect(auditLog.getLastLog()?.resourceId).toBe(TARGET);
    });

    it('revokeRole 후: hasRole = false', async () => {
      const { ctrl, contract, adminCtx } = makeFixtures();
      await ctrl.grantRole(adminCtx, TARGET, ROLE);
      await ctrl.revokeRole(adminCtx, TARGET, ROLE);
      expect(await contract.hasRole(ethers.id(ROLE), TARGET)).toBe(false);
    });

    it('revokeRole 감사 로그 action: ROLE_REVOKED', async () => {
      const { ctrl, auditLog, adminCtx } = makeFixtures();
      await ctrl.grantRole(adminCtx, TARGET, ROLE);
      await ctrl.revokeRole(adminCtx, TARGET, ROLE);
      expect(auditLog.getLastLog()?.action).toBe('ROLE_REVOKED');
    });
  });

  describe('TODO: 발행 통계 조회 → 상태별 카운트 집계', () => {
    it('PENDING: 45, SUBMITTED: 12, CONFIRMED: 8934, FAILED: 3, CANCELLED: 2', async () => {
      const { ctrl, db, adminCtx } = makeFixtures();
      db.seed({ PENDING: 45, SUBMITTED: 12, CONFIRMED: 8934, FAILED: 3, CANCELLED: 2 });
      const stats = await ctrl.getIssuanceStats(adminCtx);
      expect(stats.PENDING).toBe(45);
      expect(stats.SUBMITTED).toBe(12);
      expect(stats.CONFIRMED).toBe(8934);
      expect(stats.FAILED).toBe(3);
      expect(stats.CANCELLED).toBe(2);
    });

    it('빈 DB → 모든 상태 카운트 0', async () => {
      const { ctrl, adminCtx } = makeFixtures();
      const stats = await ctrl.getIssuanceStats(adminCtx);
      expect(stats.PENDING).toBe(0);
      expect(stats.CONFIRMED).toBe(0);
    });
  });
});
