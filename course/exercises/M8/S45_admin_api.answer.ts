/**
 * S45 실습 — Admin API: 운영 관리 엔드포인트 설계와 RBAC 검증
 *
 * 강의 노트: M8_S45_admin_api.md
 *
 * 실행 방법 (루트에서): npm run exercise:s45
 *
 * 목표:
 *   [1] ADMIN_ROLE 미보유 요청 → 401 차단 검증
 *   [2] pause / unpause → 컨트랙트 상태 전이 + 감사 로그 기록
 *   [3] reconcile 트리거 → 불일치 건수 반환
 *   [4] 역할 부여(grantRole) / 회수(revokeRole) → 감사 로그 기록
 *   [5] 발행 통계 조회 → 상태별 카운트 집계
 */

import { ethers } from 'ethers';

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

export type MintStatus = 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';

export interface AuditLogEntry {
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  afterState: Record<string, unknown>;
  timestamp: Date;
}

export interface ReconcileResult {
  mismatches: Array<{ userId: string; tokenId: string; ledgerBalance: number; onchainBalance: number }>;
  totalChecked: number;
  severity: 'OK' | 'WARNING' | 'CRITICAL';
}

export interface IssuanceStats {
  PENDING: number;
  SUBMITTED: number;
  CONFIRMED: number;
  FAILED: number;
  CANCELLED: number;
}

// ─── 감사 로그 서비스 (M4 AuditLogService 시뮬레이션) ─────────────────────────

export class MockAuditLogService {
  readonly logs: AuditLogEntry[] = [];

  async log(entry: Omit<AuditLogEntry, 'timestamp'>): Promise<void> {
    this.logs.push({ ...entry, timestamp: new Date() });
  }

  getLastLog(): AuditLogEntry | undefined {
    return this.logs[this.logs.length - 1];
  }
}

// ─── Reconcile 서비스 (M4 ReconcileService 시뮬레이션) ────────────────────────

export class MockReconcileService {
  private mismatches: ReconcileResult['mismatches'];

  constructor(mismatches: ReconcileResult['mismatches'] = []) {
    this.mismatches = mismatches;
  }

  async reconcile(): Promise<ReconcileResult> {
    const total = 1200;
    const count = this.mismatches.length;
    return {
      mismatches: this.mismatches,
      totalChecked: total,
      severity: count === 0 ? 'OK' : count < 10 ? 'WARNING' : 'CRITICAL',
    };
  }
}

// ─── KyoboNFT 컨트랙트 시뮬레이션 ────────────────────────────────────────────

export class MockKyoboNFT {
  private _paused = false;
  private _roles = new Map<string, Set<string>>(); // address → Set<roleHash>
  public txCount = 0;

  private nextTxHash(): string {
    return `0x${(++this.txCount).toString(16).padStart(64, 'a')}`;
  }

  async pause(): Promise<{ hash: string; wait: () => Promise<void> }> {
    if (this._paused) throw new Error('Already paused');
    const hash = this.nextTxHash();
    return { hash, wait: async () => { this._paused = true; } };
  }

  async unpause(): Promise<{ hash: string; wait: () => Promise<void> }> {
    if (!this._paused) throw new Error('Not paused');
    const hash = this.nextTxHash();
    return { hash, wait: async () => { this._paused = false; } };
  }

  async grantRole(roleHash: string, address: string): Promise<{ hash: string; wait: () => Promise<void> }> {
    const hash = this.nextTxHash();
    return {
      hash, wait: async () => {
        if (!this._roles.has(address)) this._roles.set(address, new Set());
        this._roles.get(address)!.add(roleHash);
      },
    };
  }

  async revokeRole(roleHash: string, address: string): Promise<{ hash: string; wait: () => Promise<void> }> {
    const hash = this.nextTxHash();
    return {
      hash, wait: async () => {
        this._roles.get(address)?.delete(roleHash);
      },
    };
  }

  async hasRole(roleHash: string, address: string): Promise<boolean> {
    return this._roles.get(address)?.has(roleHash) ?? false;
  }

  isPaused(): boolean { return this._paused; }
}

// ─── 인메모리 DB (mint_requests 시뮬레이션) ───────────────────────────────────

export class MockDatabase {
  private mintRequests: Array<{ status: MintStatus }> = [];

  seed(counts: Partial<IssuanceStats>): void {
    this.mintRequests = [];
    for (const [status, count] of Object.entries(counts)) {
      for (let i = 0; i < (count ?? 0); i++) {
        this.mintRequests.push({ status: status as MintStatus });
      }
    }
  }

  async queryIssuanceStats(): Promise<IssuanceStats> {
    const stats: IssuanceStats = { PENDING: 0, SUBMITTED: 0, CONFIRMED: 0, FAILED: 0, CANCELLED: 0 };
    for (const row of this.mintRequests) {
      stats[row.status] = (stats[row.status] ?? 0) + 1;
    }
    return stats;
  }
}

// ─── RBAC 미들웨어 시뮬레이션 ─────────────────────────────────────────────────

export interface RequestContext {
  user: { id: string; roles: string[] };
  ipAddress: string;
}

export function requireRole(requiredRole: string) {
  return (ctx: RequestContext): void => {
    if (!ctx.user.roles.includes(requiredRole)) {
      const err = new Error(`Unauthorized: ${requiredRole} required`);
      (err as any).statusCode = 401;
      throw err;
    }
  };
}

// ─── AdminController ──────────────────────────────────────────────────────────

export class AdminController {
  constructor(
    private readonly contract: MockKyoboNFT,
    private readonly reconcileService: MockReconcileService,
    private readonly auditLog: MockAuditLogService,
    private readonly db: MockDatabase,
  ) {}

  // ── 일시정지 ─────────────────────────────────────────────────────────────

  async pauseContract(ctx: RequestContext, reason = ''): Promise<{ success: boolean; txHash: string }> {
    requireRole('ADMIN_ROLE')(ctx);

    const tx = await this.contract.pause();
    await tx.wait();

    await this.auditLog.log({
      actor: ctx.user.id,
      action: 'CONTRACT_PAUSED',
      resourceType: 'CONTRACT',
      resourceId: '0xc0de000000000000000000000000000000000001',
      afterState: { paused: true, reason },
    });

    return { success: true, txHash: tx.hash };
  }

  async unpauseContract(ctx: RequestContext): Promise<{ success: boolean; txHash: string }> {
    requireRole('ADMIN_ROLE')(ctx);

    const tx = await this.contract.unpause();
    await tx.wait();

    await this.auditLog.log({
      actor: ctx.user.id,
      action: 'CONTRACT_UNPAUSED',
      resourceType: 'CONTRACT',
      resourceId: '0xc0de000000000000000000000000000000000001',
      afterState: { paused: false },
    });

    return { success: true, txHash: tx.hash };
  }

  // ── Reconcile 트리거 ──────────────────────────────────────────────────────

  async triggerReconcile(ctx: RequestContext): Promise<{ mismatchCount: number; totalChecked: number; severity: string }> {
    requireRole('ADMIN_ROLE')(ctx);

    const result = await this.reconcileService.reconcile();

    await this.auditLog.log({
      actor: ctx.user.id,
      action: 'RECONCILE_TRIGGERED',
      resourceType: 'RECONCILE',
      resourceId: `reconcile-${Date.now()}`,
      afterState: { mismatchCount: result.mismatches.length, totalChecked: result.totalChecked },
    });

    return {
      mismatchCount: result.mismatches.length,
      totalChecked: result.totalChecked,
      severity: result.severity,
    };
  }

  // ── 발행 통계 ─────────────────────────────────────────────────────────────

  async getIssuanceStats(ctx: RequestContext): Promise<IssuanceStats> {
    requireRole('ADMIN_ROLE')(ctx);
    return this.db.queryIssuanceStats();
  }

  // ── 역할 관리 ─────────────────────────────────────────────────────────────

  async grantRole(
    ctx: RequestContext,
    address: string,
    role: string,
  ): Promise<{ success: boolean; txHash: string }> {
    requireRole('ADMIN_ROLE')(ctx);

    const roleHash = ethers.id(role);
    const tx = await this.contract.grantRole(roleHash, address);
    await tx.wait();

    await this.auditLog.log({
      actor: ctx.user.id,
      action: 'ROLE_GRANTED',
      resourceType: 'ROLE',
      resourceId: address,
      afterState: { role, address },
    });

    return { success: true, txHash: tx.hash };
  }

  async revokeRole(
    ctx: RequestContext,
    address: string,
    role: string,
  ): Promise<{ success: boolean; txHash: string }> {
    requireRole('ADMIN_ROLE')(ctx);

    const roleHash = ethers.id(role);
    const tx = await this.contract.revokeRole(roleHash, address);
    await tx.wait();

    await this.auditLog.log({
      actor: ctx.user.id,
      action: 'ROLE_REVOKED',
      resourceType: 'ROLE',
      resourceId: address,
      afterState: { role, address },
    });

    return { success: true, txHash: tx.hash };
  }
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

async function expectAuthError(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(`${label} → 401 에러 발생해야 함`, false);
  } catch (err) {
    const is401 = (err as any)?.statusCode === 401 || (err as Error).message.includes('Unauthorized');
    check(`${label} → 401 Unauthorized`, is401);
  }
}

// ─── 실습 진입점 ──────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S45: Admin API — 운영 관리 엔드포인트 설계와 RBAC 검증 ===\n');

  // 픽스처 설정
  const contract  = new MockKyoboNFT();
  const auditLog  = new MockAuditLogService();
  const db        = new MockDatabase();
  const ctrl = new AdminController(
    contract,
    new MockReconcileService([]),
    auditLog,
    db,
  );

  const adminCtx: RequestContext = {
    user: { id: 'admin-001', roles: ['ADMIN_ROLE'] },
    ipAddress: '10.0.1.55',
  };
  const userCtx: RequestContext = {
    user: { id: 'user-001', roles: ['MINTER_ROLE'] },
    ipAddress: '10.0.1.99',
  };

  // ── [1] RBAC — 권한 없는 요청 → 401 ─────────────────────────────────────
  console.log('[검증 1] ADMIN_ROLE 미보유 → 401 차단');

  await expectAuthError('pause (일반 사용자)', () => ctrl.pauseContract(userCtx, '테스트'));
  await expectAuthError('reconcile (일반 사용자)', () => ctrl.triggerReconcile(userCtx));
  await expectAuthError('grantRole (일반 사용자)', () => ctrl.grantRole(userCtx, '0x1234', 'MINTER_ROLE'));
  await expectAuthError('getIssuanceStats (일반 사용자)', () => ctrl.getIssuanceStats(userCtx));

  // ── [2] pause / unpause → 상태 전이 + 감사 로그 ──────────────────────────
  console.log('\n[검증 2] pause / unpause — 컨트랙트 상태 전이 + 감사 로그');

  check('초기 상태: paused = false', !contract.isPaused());

  const pauseResult = await ctrl.pauseContract(adminCtx, '보안 점검');
  check('pause 응답: success = true', pauseResult.success);
  check('pause 응답: txHash 포함', /^0x/.test(pauseResult.txHash));
  check('컨트랙트 상태: paused = true', contract.isPaused());

  const pauseLog = auditLog.getLastLog();
  check('감사 로그 action: CONTRACT_PAUSED', pauseLog?.action === 'CONTRACT_PAUSED');
  check('감사 로그 actor: admin-001', pauseLog?.actor === 'admin-001');
  check('감사 로그 afterState.paused: true', pauseLog?.afterState['paused'] === true);

  const unpauseResult = await ctrl.unpauseContract(adminCtx);
  check('unpause 응답: success = true', unpauseResult.success);
  check('컨트랙트 상태: paused = false (복귀)', !contract.isPaused());

  const unpauseLog = auditLog.getLastLog();
  check('감사 로그 action: CONTRACT_UNPAUSED', unpauseLog?.action === 'CONTRACT_UNPAUSED');

  // ── [3] Reconcile 트리거 → 불일치 건수 반환 ──────────────────────────────
  console.log('\n[검증 3] Reconcile 트리거 — 불일치 건수 반환');

  // 불일치 3건 있는 서비스로 재생성
  const ctrlWithMismatch = new AdminController(
    contract,
    new MockReconcileService([
      { userId: 'u1', tokenId: '1001', ledgerBalance: 5,  onchainBalance: 10 },
      { userId: 'u2', tokenId: '1002', ledgerBalance: 3,  onchainBalance: 0  },
      { userId: 'u3', tokenId: '1003', ledgerBalance: 10, onchainBalance: 7  },
    ]),
    auditLog,
    db,
  );

  const reconcileResult = await ctrlWithMismatch.triggerReconcile(adminCtx);
  check('reconcile mismatchCount: 3', reconcileResult.mismatchCount === 3);
  check('reconcile totalChecked: 1200', reconcileResult.totalChecked === 1200);
  check('reconcile severity: WARNING', reconcileResult.severity === 'WARNING');

  const reconcileLog = auditLog.getLastLog();
  check('감사 로그 action: RECONCILE_TRIGGERED', reconcileLog?.action === 'RECONCILE_TRIGGERED');
  check('감사 로그 mismatchCount: 3', reconcileLog?.afterState['mismatchCount'] === 3);

  // ── [4] 발행 통계 조회 ────────────────────────────────────────────────────
  console.log('\n[검증 4] 발행 통계 조회 — 상태별 카운트');

  db.seed({ PENDING: 45, SUBMITTED: 12, CONFIRMED: 8934, FAILED: 3, CANCELLED: 2 });
  const stats = await ctrl.getIssuanceStats(adminCtx);

  check('PENDING: 45',    stats.PENDING   === 45);
  check('SUBMITTED: 12',  stats.SUBMITTED === 12);
  check('CONFIRMED: 8934', stats.CONFIRMED === 8934);
  check('FAILED: 3',      stats.FAILED    === 3);
  check('CANCELLED: 2',   stats.CANCELLED === 2);

  // ── [5] 역할 부여 / 회수 ──────────────────────────────────────────────────
  console.log('\n[검증 5] 역할 부여(grantRole) / 회수(revokeRole)');

  const targetAddress = '0xAbCd000000000000000000000000000000000000';
  const roleHash = ethers.id('MINTER_ROLE');

  check('사전 확인: hasRole MINTER_ROLE = false', !(await contract.hasRole(roleHash, targetAddress)));

  const grantResult = await ctrl.grantRole(adminCtx, targetAddress, 'MINTER_ROLE');
  check('grantRole 응답: success = true', grantResult.success);
  check('grantRole 후: hasRole = true', await contract.hasRole(roleHash, targetAddress));

  const grantLog = auditLog.getLastLog();
  check('감사 로그 action: ROLE_GRANTED', grantLog?.action === 'ROLE_GRANTED');
  check('감사 로그 resourceId: targetAddress', grantLog?.resourceId === targetAddress);

  const revokeResult = await ctrl.revokeRole(adminCtx, targetAddress, 'MINTER_ROLE');
  check('revokeRole 응답: success = true', revokeResult.success);
  check('revokeRole 후: hasRole = false', !(await contract.hasRole(roleHash, targetAddress)));

  const revokeLog = auditLog.getLastLog();
  check('감사 로그 action: ROLE_REVOKED', revokeLog?.action === 'ROLE_REVOKED');

  // ─── 정리 ───────────────────────────────────────────────────────────────
  console.log('\n=== S45 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. Admin API = 기능에 접근하는 "문" — 없으면 야간 긴급 상황에 개발자만 대응 가능');
  console.log('  2. RBAC: requireRole 미들웨어로 ADMIN_ROLE 보유 여부를 모든 엔드포인트에서 검증');
  console.log('  3. 모든 Admin 호출 → AuditLogService 기록 (SHA-256 체인 편입)');
  console.log('  4. grantRole/revokeRole: ethers.id(roleName) → bytes32 해시로 변환 후 컨트랙트 호출');
  console.log('  5. reconcile: 수동 트리거 + 즉시 불일치 현황 파악 — 정기 스케줄러 보완');
})();
