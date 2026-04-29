# M8 S45 — 운영 관리 API 설계 · 컨트랙트 제어와 시스템 운영 인터페이스

> 모듈 8 · 세션 45 · 1시간  
> 스켈레톤: `dmz/packages/vasp/src/governance/KeyGovernanceService.ts`

---

## 강의 파트 (15분)

### 1. "버튼이 없는 시스템" — 왜 Admin API가 필요한가

M6에서 KyoboNFT.sol의 `pause()`, `grantRole()`, `upgradeToAndCall()` 함수를 직접 구현했다.
M4에서 ReconcileService의 불일치 감지 로직을 완성했다.

그런데 운영팀 담당자가 실제로 이 기능을 어떻게 실행하는가?

현재 상황:
```
운영팀: "지금 당장 NFT 발행을 멈춰야 합니다!"
개발자: "잠깐요, hardhat console 열고..."
             ethers.attach(proxyAddr).pause()...
운영팀: "????"
```

컨트랙트 함수와 서비스 클래스는 "기능"이다. Admin API는 그 기능에 접근할 수 있는 "문"이다. 문이 없으면 아무리 좋은 기능도 의미가 없다.

**Admin API가 없을 때 발생하는 문제:**

| 상황 | 문제 |
|------|------|
| 긴급 일시정지 필요 | 개발자만 실행 가능 → 야간 연락 불가 시 피해 계속 |
| 불일치 모니터링 | ReconcileService를 수동 실행해야 함 |
| 역할 부여/회수 | Solidity console 없이는 불가 |
| 대시보드 현황 | 발행 통계를 코드 없이 볼 수 없음 |

---

### 2. Admin API 보안 3원칙

Admin API는 일반 발행 API보다 권한이 더 강하다. 그만큼 보안이 더 엄격해야 한다.

**원칙 1: 역할 기반 접근 제어 (RBAC)**

```
일반 API:   MINTER_ROLE → mint, burn
Admin API:  ADMIN_ROLE  → pause, unpause, reconcile, role 관리
```

같은 JWT 토큰을 써도 Admin API 엔드포인트는 ADMIN_ROLE을 추가로 확인한다.

**원칙 2: IP 허용 목록**

Admin API는 인터넷에 열려 있으면 안 된다.

```
일반 API:  Public Internet → API Gateway → VASP Server
Admin API: 내부 VPC만 → 허용된 IP 목록 → Admin Server
```

교보 사내망 IP 대역, 개발자 VPN IP만 허용한다.

**원칙 3: 모든 호출 감사 로그 의무 기록**

누가 언제 어떤 Admin 명령을 실행했는지 반드시 기록한다.

```
actor: "admin-user-001"
action: "CONTRACT_PAUSED"
timestamp: "2026-04-28T14:23:05Z"
reason: "긴급 보안 점검"
ipAddress: "10.0.1.55"
```

M4에서 만든 SHA-256 감사 체인과 연결된다. Admin API 호출도 체인에 편입된다.

---

### 3. Admin API 엔드포인트 설계

**일시정지 관련:**

```
POST /admin/contract/pause
  → KyoboNFT.pause() 호출 (PAUSER_ROLE)
  → 감사 로그: CONTRACT_PAUSED

POST /admin/contract/unpause
  → KyoboNFT.unpause() 호출 (PAUSER_ROLE)
  → 감사 로그: CONTRACT_UNPAUSED
```

일시정지 후 발행 요청이 들어오면: KyoboNFT의 `whenNotPaused` modifier가 revert. 새 mint는 실패하고, 기존 보유 잔액은 그대로 유지된다.

**Reconcile 트리거:**

```
POST /admin/reconcile
  응답: { mismatchCount: 3, totalChecked: 1200 }
```

ReconcileService.reconcile()을 수동 트리거한다. 정기적으로 스케줄러가 실행하지만, 의심 상황에서 즉시 확인할 때 사용한다.

**통계 조회:**

```
GET /admin/issuance/stats
  응답:
  {
    PENDING:   45,
    SUBMITTED: 12,
    CONFIRMED: 8934,
    FAILED:    3,
    CANCELLED: 2
  }
```

**역할 관리:**

```
POST /admin/roles/grant
  body: { address: "0xAbCd...", role: "MINTER_ROLE" }
  → KyoboNFT.grantRole() 호출
  → 감사 로그: ROLE_GRANTED

POST /admin/roles/revoke
  body: { address: "0xAbCd...", role: "MINTER_ROLE" }
  → KyoboNFT.revokeRole() 호출
  → 감사 로그: ROLE_REVOKED
```

역할 부여/회수는 M8 S46~S48에서 만들 Gnosis Safe 2-of-3 서명 절차를 거친다. Admin API는 그 절차의 시작점(제안 등록)이다.

---

## 실습 파트 (40분)

### Admin API 라우터 구현

```typescript
// dmz/apps/admin-service/src/routes/adminRoutes.ts
import express from 'express';
import { requireRole } from '../middleware/auth';
import { AdminController } from '../controllers/AdminController';

const router = express.Router();
const ctrl = new AdminController();

// 모든 Admin 경로: ADMIN_ROLE 필요 + 내부망 IP 필터
router.use(requireRole('ADMIN_ROLE'));

// 일시정지 관련
router.post('/contract/pause',   ctrl.pauseContract);
router.post('/contract/unpause', ctrl.unpauseContract);

// Reconcile
router.post('/reconcile', ctrl.triggerReconcile);

// 통계
router.get('/issuance/stats', ctrl.getIssuanceStats);

// 역할 관리
router.post('/roles/grant',  ctrl.grantRole);
router.post('/roles/revoke', ctrl.revokeRole);

export default router;
```

### AdminController 구현

```typescript
// dmz/apps/admin-service/src/controllers/AdminController.ts
import { Request, Response } from 'express';
import { ethers } from 'ethers';
import { KyoboNFT__factory } from '../../../blockchain/typechain';
import { ReconcileService } from '../../../core-banking/src/reconcile/ReconcileService';
import { AuditLogService } from '../../../core-banking/src/audit/AuditLogService';
import { db } from '../db';

export class AdminController {
  private readonly contract: ethers.Contract;
  private readonly reconcileService: ReconcileService;
  private readonly auditLog: AuditLogService;

  constructor() {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
    const signer = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY!, provider);
    this.contract = KyoboNFT__factory.connect(
      process.env.CONTRACT_ADDRESS!,
      signer
    );
    this.reconcileService = new ReconcileService(this.contract, db);
    this.auditLog = new AuditLogService(db);
  }

  // ── 일시정지 ─────────────────────────────────────────────────

  pauseContract = async (req: Request, res: Response) => {
    const actor = req.user!.id;

    // 컨트랙트 일시정지
    const tx = await this.contract.pause();
    await tx.wait();

    // 감사 로그 기록 (M4 AuditLogService 연결)
    await this.auditLog.log({
      actor,
      action: 'CONTRACT_PAUSED',
      resourceType: 'CONTRACT',
      resourceId: process.env.CONTRACT_ADDRESS!,
      afterState: { paused: true, reason: req.body.reason ?? '' },
    });

    res.json({ success: true, txHash: tx.hash });
  };

  unpauseContract = async (req: Request, res: Response) => {
    const actor = req.user!.id;

    const tx = await this.contract.unpause();
    await tx.wait();

    await this.auditLog.log({
      actor,
      action: 'CONTRACT_UNPAUSED',
      resourceType: 'CONTRACT',
      resourceId: process.env.CONTRACT_ADDRESS!,
      afterState: { paused: false },
    });

    res.json({ success: true, txHash: tx.hash });
  };

  // ── Reconcile 트리거 ──────────────────────────────────────────

  triggerReconcile = async (req: Request, res: Response) => {
    const actor = req.user!.id;

    // ReconcileService (M4에서 구현)
    const result = await this.reconcileService.reconcile();

    await this.auditLog.log({
      actor,
      action: 'RECONCILE_TRIGGERED',
      resourceType: 'RECONCILE',
      resourceId: `reconcile-${Date.now()}`,
      afterState: { mismatchCount: result.mismatches.length, totalChecked: result.totalChecked },
    });

    res.json({
      mismatchCount: result.mismatches.length,
      totalChecked: result.totalChecked,
      severity: result.severity,
    });
  };

  // ── 발행 통계 ─────────────────────────────────────────────────

  getIssuanceStats = async (_req: Request, res: Response) => {
    const { rows } = await db.query(`
      SELECT status, COUNT(*) AS count
      FROM mint_requests
      GROUP BY status
    `);

    const stats: Record<string, number> = {};
    for (const row of rows) {
      stats[row.status as string] = Number(row.count);
    }

    res.json(stats);
  };

  // ── 역할 관리 ──────────────────────────────────────────────────

  grantRole = async (req: Request, res: Response) => {
    const { address, role } = req.body as { address: string; role: string };
    const actor = req.user!.id;

    // 역할 이름 → bytes32 해시
    const roleHash = ethers.id(role);
    const tx = await this.contract.grantRole(roleHash, address);
    await tx.wait();

    await this.auditLog.log({
      actor,
      action: 'ROLE_GRANTED',
      resourceType: 'ROLE',
      resourceId: address,
      afterState: { role, address },
    });

    res.json({ success: true, txHash: tx.hash });
  };

  revokeRole = async (req: Request, res: Response) => {
    const { address, role } = req.body as { address: string; role: string };
    const actor = req.user!.id;

    const roleHash = ethers.id(role);
    const tx = await this.contract.revokeRole(roleHash, address);
    await tx.wait();

    await this.auditLog.log({
      actor,
      action: 'ROLE_REVOKED',
      resourceType: 'ROLE',
      resourceId: address,
      afterState: { role, address },
    });

    res.json({ success: true, txHash: tx.hash });
  };
}
```

### Admin API 통합 테스트

```typescript
// test/adminApi.test.ts
import request from 'supertest';
import app from '../src/app';
import { mockContract, mockAuditLog, mockDb } from './mocks';

describe('Admin API', () => {
  const adminToken = createAdminJwt();  // ADMIN_ROLE 포함

  // ── 일시정지 ─────────────────────────────────────────────────

  it('POST /admin/contract/pause → 컨트랙트 pause + 감사 로그', async () => {
    mockContract.pause.mockResolvedValue({ hash: '0xabc', wait: async () => {} });
    mockAuditLog.log.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/admin/contract/pause')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '보안 점검' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockContract.pause).toHaveBeenCalledTimes(1);
    expect(mockAuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CONTRACT_PAUSED' })
    );
  });

  it('POST /admin/contract/pause — 권한 없는 토큰 → 401', async () => {
    const userToken = createUserJwt();  // ADMIN_ROLE 없음

    const res = await request(app)
      .post('/admin/contract/pause')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(401);
  });

  // ── Reconcile ──────────────────────────────────────────────────

  it('POST /admin/reconcile → 불일치 건수 반환', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { user_id: 'u1', token_id: '1001', ledger_balance: 5, onchain_balance: 10 },
      ],
    });

    const res = await request(app)
      .post('/admin/reconcile')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.mismatchCount).toBe(1);
  });

  // ── 역할 관리 ──────────────────────────────────────────────────

  it('POST /admin/roles/grant → 역할 부여 + 감사 로그', async () => {
    mockContract.grantRole.mockResolvedValue({ hash: '0xdef', wait: async () => {} });

    const res = await request(app)
      .post('/admin/roles/grant')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ address: '0xAbCd...', role: 'MINTER_ROLE' });

    expect(res.status).toBe(200);
    expect(mockContract.grantRole).toHaveBeenCalledWith(
      expect.any(String),  // ethers.id('MINTER_ROLE')
      '0xAbCd...'
    );
    expect(mockAuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ROLE_GRANTED' })
    );
  });
});
```

---

## 완료 기준

- [ ] `POST /admin/contract/pause` · `unpause` → 컨트랙트 상태 변경 확인
- [ ] `POST /admin/reconcile` → 불일치 건수 반환
- [ ] `POST /admin/roles/grant` · `revoke` → 감사 로그 기록
- [ ] ADMIN_ROLE 없는 요청 → 401 응답 확인
