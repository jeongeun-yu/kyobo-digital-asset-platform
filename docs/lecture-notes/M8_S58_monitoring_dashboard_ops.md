# M8 S58 — 운영 대시보드 · Phase 1 전체 지표 통합과 온콜 운영 체계

> 모듈 8 · 세션 58 · 1시간 `운영`
> 전제: S51~S57 운영 세션 전체 완료. 각 모듈의 /admin/* 엔드포인트 구현 완료
> 스켈레톤: `dmz/packages/vasp/src/admin/DashboardService.ts`
> 이 세션은 Phase 1 운영 체계의 최종 통합이다.

> ⚠️ **운영 세션** — S51(DLQ), S52(Consumer), S53(VASP SLA), S54(Reconcile), S55(감사 로그), S56(배포), S57(거버넌스)에서 각 모듈별 운영 엔드포인트를 구현했다. 이번 세션은 **그 모든 것을 하나의 화면으로 통합**하는 것이다. 야간 온콜 담당자가 새벽 3시에 알림을 받았을 때 **단 하나의 API 호출로 시스템 전체 상태를 파악**할 수 있어야 한다.

---

## 강의 파트 (20분)

### 1. Phase 1 운영 핵심 지표 전체 (10분)

S51~S57에서 구현한 모든 /admin/* 엔드포인트의 지표를 통합 목록으로 정리한다.

**지표 전체 목록 + 의미:**

```
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1 운영 핵심 지표 (S51~S57 통합)                           │
│                                                                  │
│  [S51] DLQ 상태                                                  │
│    dlqCount: 적재된 DLQ 메시지 수                                │
│    의미: 처리 실패 이벤트 누적 수. 0이 정상.                     │
│                                                                  │
│  [S52] Consumer 상태                                             │
│    consumerCount: 활성 Consumer 프로세스 수                      │
│    pendingMessages: 처리 대기 메시지 (Lag)                       │
│    pelSize: PEL 크기 (처리 중 미ACK)                             │
│    redisConnected: Redis 연결 여부                               │
│                                                                  │
│  [S53] VASP 상태                                                 │
│    vaspAvailable: VASP API 응답 가능 여부                        │
│    vaspResponseMs: 응답시간 (p99 기준 비교)                      │
│    stuckTxCount: 30분 초과 PENDING/SUBMITTED TX 수               │
│    circuitBreakerStatus: CLOSED/OPEN/HALF_OPEN                  │
│                                                                  │
│  [S54] Reconcile 상태                                            │
│    lastReconcileAt: 마지막 Reconcile 실행 시각                   │
│    lastMismatchCount: 마지막 실행 불일치 건수                    │
│    pendingMismatch: 미해소 불일치 건수                           │
│                                                                  │
│  [S55] 감사 로그 무결성                                          │
│    integrityOk: 최근 24시간 체인 무결성 정상 여부               │
│    lastCheckedAt: 마지막 무결성 검증 시각                        │
│    firstInvalidId: 훼손 감지 시 첫 번째 무효 레코드 ID          │
│                                                                  │
│  [S56] 배포 상태                                                 │
│    currentVersion: 현재 운영 버전                                │
│    lastDeployedAt: 마지막 배포 시각                              │
│    deployStatus: STABLE / MONITORING / ROLLED_BACK              │
│    errorRate: 최근 5분 에러율                                    │
│    p99ResponseMs: P99 응답시간                                   │
│                                                                  │
│  [S57] 거버넌스                                                  │
│    pendingProposals: 서명 대기 중인 업그레이드 제안 수           │
│    readyToExecute: 실행 대기 중인 제안 수 (서명 완료)           │
└─────────────────────────────────────────────────────────────────┘
```

**지표 간 연관성 — 한 지표가 이상하면 다른 지표도 확인:**

```
DLQ 증가 → Consumer Lag 확인
  이유: DLQ 증가는 Consumer 처리 실패. Consumer 크래시 동반 가능.

VASP 장애 → TX Stuck 확인
  이유: VASP 연결 불가 → mint TX 처리 불가 → PENDING 누적.

Consumer Lag 급증 → VASP 응답시간 확인
  이유: Consumer 처리 중 VASP 조회 지연 → 처리 속도 저하.

Reconcile 불일치 → DLQ 확인
  이유: 원인 A(Consumer 누락)는 DLQ에서 확인 가능.

배포 후 에러율 증가 → 전체 지표 확인
  이유: 배포 문제는 모든 파이프라인에 영향.
```

---

### 2. 알림 우선순위 설계 (10분)

모든 이상 징후를 P1으로 보내면 알림 피로도(Alert Fatigue)가 생긴다. 야간에 P1이 너무 많으면 담당자가 무감각해진다.

**3단계 우선순위:**

```
P1 — 즉시 대응 (온콜 호출, 야간도 깨움)
  → Redis 다운 (redisConnected: false)
  → VASP 다운 (vaspAvailable: false)
  → Consumer 크래시 (consumerCount: 0)
  → Reconcile 불일치 10건 이상
  → 감사 로그 무결성 훼손 (integrityOk: false)
  → 에러율 1% 초과

P2 — 1시간 내 대응 (업무 시간 중 확인)
  → Consumer Lag 200건 이상 (pendingMessages >= 200)
  → DLQ 적재 1건 이상 (dlqCount > 0)
  → TX Stuck 10건 이상 (stuckTxCount >= 10)
  → VASP 응답시간 SLA p99 2배 초과
  → 배포 상태 MONITORING 15분 이상 지속

P3 — 일간 리뷰 (다음 업무 시간에 처리)
  → SLA 월간 리포트 생성
  → 업그레이드 서명 요청
  → Reconcile 주간 리뷰 알림
  → 배포 완료 알림
```

**알림 피로도 방지 — 중복 알림 억제:**

```
문제: 같은 원인으로 5분마다 같은 P1 알림 → 12시간이면 144번
해결: 동일 알림 5분 내 재발송 금지 (Redis TTL 활용)

구현:
  Redis Key: alert:dedup:{alertType}:{resourceId}
  TTL: 300초 (5분)
  발송 전 key 존재 여부 확인
  없으면 발송 + key 설정
  있으면 발송 생략 (로그만 기록)
```

**운영 교대 인수인계 체크리스트 — 교대 시 반드시 확인할 지표 7개:**

```
교대 인수인계 시 GET /admin/dashboard 호출 후 확인:

1. consumerCount ≥ 1         (Consumer 살아있는가)
2. redisConnected = true      (Redis 정상인가)
3. dlqCount = 0               (처리 실패 없는가)
4. vaspAvailable = true       (VASP 연결 가능한가)
5. stuckTxCount = 0           (TX Stuck 없는가)
6. pendingMismatch = 0        (Reconcile 미해소 없는가)
7. deployStatus = 'STABLE'    (배포 안정 상태인가)

7개 모두 정상이면 → 인수인계 완료 선언
하나라도 이상 → 인계자가 해소 후 인수인계
```

---

## 실습 파트 (35분)

### 실습 1 — 통합 대시보드 API 구현 (15분)

```typescript
// dmz/packages/vasp/src/admin/DashboardService.ts

export type ComponentStatus = 'OK' | 'WARNING' | 'CRITICAL';

export interface DashboardSnapshot {
  // 전체 시스템 상태
  systemStatus: ComponentStatus;
  snapshotAt: Date;

  // S52 Consumer
  queueStats: {
    consumerCount:   number;
    pendingMessages: number;
    pelSize:         number;
    redisConnected:  boolean;
    status:          ComponentStatus;
  };

  // S51 DLQ
  dlqStats: {
    dlqCount: number;
    status:   ComponentStatus;
  };

  // S53 VASP
  vaspHealth: {
    available:             boolean;
    responseTimeMs:        number | null;
    stuckCount:            number;
    circuitBreakerStatus:  string;
    status:                ComponentStatus;
  };

  // S54 Reconcile
  reconcileStatus: {
    lastRunAt:          Date | null;
    lastMismatchCount:  number;
    pendingMismatch:    number;
    status:             ComponentStatus;
  };

  // S55 감사 로그
  auditIntegrity: {
    integrityOk:    boolean;
    lastCheckedAt:  Date | null;
    firstInvalidId: number | null;
    status:         ComponentStatus;
  };

  // S56 배포
  deployMetrics: {
    currentVersion: string;
    lastDeployedAt: Date | null;
    deployStatus:   string;
    errorRate:      number;
    p99ResponseMs:  number | null;
    status:         ComponentStatus;
  };

  // S57 거버넌스
  governanceProposals: {
    pendingSignatures: number;
    readyToExecute:    number;
    status:            ComponentStatus;
  };

  // P1 알림 목록
  activeAlerts: string[];
}

export class DashboardService {
  constructor(
    private readonly consumerMonitor: ConsumerMonitorService,   // S52
    private readonly dlqAdmin:        DLQAdminService,          // S51
    private readonly vaspMonitor:     VASPMonitorService,       // S53
    private readonly reconcileAdmin:  ReconcileAdminService,    // S54
    private readonly auditLogAdmin:   AuditLogAdminService,     // S55
    private readonly deployAdmin:     DeployAdminService,       // S56
    private readonly govAdmin:        UpgradeGovernanceAdminService, // S57
    private readonly db:              Database,
  ) {}

  async getSnapshot(): Promise<DashboardSnapshot> {
    // 모든 섹션 병렬 수집 (Promise.all — 직렬 호출 금지)
    const [
      queueStatsRaw,
      dlqItems,
      vaspHealthRaw,
      reconcileHistoryRaw,
      deployMetricsRaw,
      proposalsRaw,
      integrityRaw,
    ] = await Promise.all([
      this.consumerMonitor.getStats(),
      this.dlqAdmin.listPending(),
      this.vaspMonitor.getHealth(),
      this._getLastReconcileHistory(),
      this.deployAdmin.getMetrics(5),
      this.govAdmin.listProposals(),
      this._getLastIntegrityCheck(),
    ]);

    // 각 섹션 상태 계산
    const queueStats = this._buildQueueStats(queueStatsRaw, dlqItems.length);
    const dlqStats   = this._buildDlqStats(dlqItems.length);
    const vaspHealth = this._buildVaspHealth(vaspHealthRaw);
    const reconcile  = this._buildReconcileStatus(reconcileHistoryRaw);
    const audit      = this._buildAuditIntegrity(integrityRaw);
    const deploy     = this._buildDeployMetrics(deployMetricsRaw);
    const gov        = this._buildGovernanceStatus(proposalsRaw);

    // 전체 상태 집계 — 하나라도 CRITICAL이면 전체 CRITICAL
    const sections = [queueStats, dlqStats, vaspHealth, reconcile, audit, deploy, gov];
    const systemStatus: ComponentStatus =
      sections.some(s => s.status === 'CRITICAL') ? 'CRITICAL' :
      sections.some(s => s.status === 'WARNING')  ? 'WARNING'  : 'OK';

    // P1 알림 수집
    const activeAlerts = this._collectAlerts({ queueStats, dlqStats, vaspHealth, reconcile, audit, deploy });

    return {
      systemStatus,
      snapshotAt: new Date(),
      queueStats,
      dlqStats,
      vaspHealth,
      reconcileStatus: reconcile,
      auditIntegrity: audit,
      deployMetrics: deploy,
      governanceProposals: gov,
      activeAlerts,
    };
  }

  // ── 섹션별 상태 계산 ─────────────────────────────────────────

  private _buildQueueStats(stats: ConsumerStats, dlqCount: number): DashboardSnapshot['queueStats'] {
    const status: ComponentStatus =
      !stats.redisConnected || stats.consumerCount === 0 ? 'CRITICAL' :
      stats.pendingMessages >= 200                        ? 'WARNING'  : 'OK';

    return {
      consumerCount:   stats.consumerCount,
      pendingMessages: stats.pendingMessages,
      pelSize:         stats.pelSize,
      redisConnected:  stats.redisConnected,
      status,
    };
  }

  private _buildDlqStats(dlqCount: number): DashboardSnapshot['dlqStats'] {
    return {
      dlqCount,
      status: dlqCount > 0 ? 'WARNING' : 'OK',
    };
  }

  private _buildVaspHealth(health: VASPHealth): DashboardSnapshot['vaspHealth'] {
    const status: ComponentStatus =
      !health.available                    ? 'CRITICAL' :
      health.stuckCount >= 10              ? 'WARNING'  : 'OK';

    return {
      available:            health.available,
      responseTimeMs:       health.responseTimeMs,
      stuckCount:           health.stuckCount,
      circuitBreakerStatus: health.circuitBreakerStatus,
      status,
    };
  }

  private _buildReconcileStatus(history: any): DashboardSnapshot['reconcileStatus'] {
    const lastMismatch = history?.mismatch_count ?? 0;
    const status: ComponentStatus =
      lastMismatch >= 10 ? 'CRITICAL' :
      lastMismatch >= 1  ? 'WARNING'  : 'OK';

    return {
      lastRunAt:         history?.run_at ? new Date(history.run_at) : null,
      lastMismatchCount: lastMismatch,
      pendingMismatch:   lastMismatch,  // 미해소 건수 (별도 집계 시 교체)
      status,
    };
  }

  private _buildAuditIntegrity(check: any): DashboardSnapshot['auditIntegrity'] {
    const integrityOk = check?.valid ?? true;

    return {
      integrityOk,
      lastCheckedAt:  check?.checked_at ? new Date(check.checked_at) : null,
      firstInvalidId: check?.first_invalid_id ?? null,
      status:         integrityOk ? 'OK' : 'CRITICAL',
    };
  }

  private _buildDeployMetrics(metrics: DeployMetrics): DashboardSnapshot['deployMetrics'] {
    const status: ComponentStatus =
      metrics.errorRate > 1                          ? 'CRITICAL' :
      (metrics.p99ResponseMs ?? 0) > 10_000         ? 'WARNING'  : 'OK';

    return {
      currentVersion: process.env.npm_package_version ?? 'unknown',
      lastDeployedAt: null,   // deploy_events 테이블 조회로 채움
      deployStatus:   'STABLE',
      errorRate:      metrics.errorRate,
      p99ResponseMs:  metrics.p99ResponseMs,
      status,
    };
  }

  private _buildGovernanceStatus(proposals: any[]): DashboardSnapshot['governanceProposals'] {
    const pendingSignatures = proposals.filter(p => p.status === 'PENDING_SIGNATURES').length;
    const readyToExecute    = proposals.filter(p => p.status === 'READY_TO_EXECUTE').length;

    return {
      pendingSignatures,
      readyToExecute,
      status: readyToExecute > 0 ? 'WARNING' : 'OK',  // 실행 대기 중이면 주의
    };
  }

  private _collectAlerts(sections: Record<string, { status: ComponentStatus }>): string[] {
    const alerts: string[] = [];
    if (sections['queueStats']?.status === 'CRITICAL') alerts.push('P1: Consumer/Redis 장애');
    if (sections['vaspHealth']?.status === 'CRITICAL')  alerts.push('P1: VASP 장애');
    if (sections['dlqStats']?.status === 'WARNING')     alerts.push('P2: DLQ 적재');
    if (sections['reconcile']?.status === 'CRITICAL')   alerts.push('P1: Reconcile 불일치 10건+');
    if (sections['audit']?.status === 'CRITICAL')       alerts.push('P1: 감사 로그 무결성 훼손');
    if (sections['deploy']?.status === 'CRITICAL')      alerts.push('P1: 에러율 1% 초과');
    return alerts;
  }

  // ── DB 조회 헬퍼 ────────────────────────────────────────────

  private async _getLastReconcileHistory(): Promise<any> {
    const row = await this.db.query(
      `SELECT run_at, mismatch_count FROM reconcile_history ORDER BY run_at DESC LIMIT 1`,
    );
    return row.rows[0] ?? null;
  }

  private async _getLastIntegrityCheck(): Promise<any> {
    const row = await this.db.query(
      `SELECT valid, first_invalid_id, checked_at FROM audit_integrity_log ORDER BY checked_at DESC LIMIT 1`,
    );
    return row.rows[0] ?? null;
  }
}
```

---

### 실습 2 — 알림 중복 억제 구현 (10분)

```typescript
// dmz/packages/vasp/src/admin/AlertDeduplicator.ts

export class AlertDeduplicator {
  constructor(
    private readonly redis: RedisClient,
    private readonly dedupeWindowSeconds = 300,  // 5분
  ) {}

  // 발송 여부 판단 + key 설정을 원자적으로 처리
  async shouldSend(alertType: string, resourceId: string): Promise<boolean> {
    const key = `alert:dedup:${alertType}:${resourceId}`;

    // SET key value NX EX — 원자적 set-if-not-exists
    const result = await this.redis.set(
      key,
      new Date().toISOString(),
      { NX: true, EX: this.dedupeWindowSeconds },
    );

    // SET NX 성공(null 아님) = 이전에 없던 key → 발송 가능
    // SET NX 실패(null) = 이미 있는 key → 억제
    return result !== null;
  }

  // 알림 억제 중이면 억제 만료 시각 반환
  async getSuppressedUntil(alertType: string, resourceId: string): Promise<Date | null> {
    const key = `alert:dedup:${alertType}:${resourceId}`;
    const ttl = await this.redis.ttl(key);

    if (ttl <= 0) return null;

    return new Date(Date.now() + ttl * 1000);
  }
}
```

대시보드 알림 발송에 적용:

```typescript
// DashboardService에 추가

constructor(
  // ... 기존 파라미터
  private readonly deduplicator: AlertDeduplicator,
  private readonly notifier: NotifierAdapter,
) {}

async sendAlertsIfNeeded(snapshot: DashboardSnapshot): Promise<void> {
  for (const alert of snapshot.activeAlerts) {
    const alertType = alert.split(':')[0];  // 'P1', 'P2' 등
    const resourceId = alert.replace(/[^a-z0-9]/gi, '_');

    const should = await this.deduplicator.shouldSend(alertType, resourceId);
    if (!should) {
      console.log(`[AlertDedup] 억제됨: ${alert}`);
      continue;
    }

    await this.notifier.sendAlert({
      title:    alert,
      severity: alertType as 'P1' | 'P2' | 'P3',
      body:     `GET /admin/dashboard 에서 전체 상태 확인`,
    });
  }
}
```

테스트 — 중복 억제 확인:

```typescript
it('동일 알림 5분 내 1번만 발송', async () => {
  const notifierSpy = jest.fn();
  // 같은 알림 3번 연속 호출
  await dashboard.sendAlertsIfNeeded(criticalSnapshot);
  await dashboard.sendAlertsIfNeeded(criticalSnapshot);
  await dashboard.sendAlertsIfNeeded(criticalSnapshot);

  // 발송은 1번만
  expect(notifierSpy).toHaveBeenCalledTimes(1);
});

it('5분 후 동일 알림 → 재발송', async () => {
  // Redis TTL 만료 시뮬레이션
  await redis.del('alert:dedup:P1:P1_Consumer_Redis_장애');

  await dashboard.sendAlertsIfNeeded(criticalSnapshot);
  // 다시 발송됨
  expect(notifierSpy).toHaveBeenCalledTimes(2);
});
```

---

### 실습 3 — Phase 1 최종 Runbook 작성 (10분)

```markdown
# Phase 1 운영 Runbook — KyoboNFT 시스템

> 파일: docs/runbooks/phase1-ops-runbook.md
> 최종 수정: 2026-05-03 | 이 문서는 S51~S57 각 Runbook의 통합본이다.

## 시스템 개요

```
이벤트 흐름: VASP Webhook → Redis Streams → Consumer → 원장(PostgreSQL)
                               ↓
                             DLQ (실패 시)

주요 컴포넌트:
  - Redis (Streams + Cache)
  - PostgreSQL (원장, 감사 로그, reconcile_history)
  - Consumer Workers (PM2)
  - VASP(월렛원) API
  - Gnosis Safe (업그레이드 거버넌스)
```

## 0. 야간 알림 수신 시 첫 5분 행동 지침

```bash
# Step 1: 전체 상태 즉시 파악 (30초)
curl http://localhost:3000/admin/dashboard

# Step 2: systemStatus 확인
# → OK: 오탐 가능성. 5분 후 재확인
# → WARNING: 해당 섹션 Runbook 이동
# → CRITICAL: 즉시 원인 섹션 Runbook 이동

# Step 3: activeAlerts 목록으로 섹션 이동
# P1: Consumer/Redis 장애 → 1번 Runbook
# P1: VASP 장애          → 3번 Runbook
# P2: DLQ 적재           → 2번 Runbook
# P1: Reconcile 불일치+  → 4번 Runbook
# P1: 감사 로그 훼손     → 5번 Runbook
# P1: 에러율 초과        → 6번 Runbook
```

## 1. Consumer 장애 (S52 Runbook)

**증상**: consumerCount=0, redisConnected=false

```bash
# Consumer 크래시 확인
pm2 status dmz-consumer
pm2 logs dmz-consumer --lines 100
pm2 restart dmz-consumer

# Redis 연결 끊김
redis-cli ping
# PONG → Consumer만 재시작
# 실패 → 인프라팀 즉시 호출: infra@kyobo.com
```

## 2. DLQ 대응 (S51 Runbook)

**증상**: dlqCount > 0

```bash
curl http://localhost:3000/admin/dlq/pending
# _reason 분석 → timeout: VASP 확인 / parse error: 발신팀 통보
# txHash 있으면 processed_events 조회 → 이미 있으면 drop
curl -X DELETE http://localhost:3000/admin/dlq/drop -d '{"dlqId":"...", "operator":"...", "reason":"..."}'
```

## 3. VASP 장애 (S53 Runbook)

**증상**: vaspAvailable=false, stuckCount 급증

```bash
curl http://localhost:3000/admin/vasp/health
curl http://localhost:3000/admin/vasp/stuck

# L1: 5분 대기 (RetryHandler 자동 재시도)
# L2: 월렛원 상태 페이지 확인
# L3: 장애 티켓 접수 + SLA 위반 기록
# L4: 경영진 보고
```

## 4. Reconcile 불일치 (S54 Runbook)

**증상**: pendingMismatch >= 10

```bash
curl http://localhost:3000/admin/reconcile/history
# 원인 분류: A(DLQ확인) / B(REORG) / C(DB조작) / D(버그)
# 역방향 수정 금지 — 온체인 기준으로 원장 보정
# 보정 후: curl -X POST http://localhost:3000/admin/reconcile/run -d '{"userId":"..."}'
```

## 5. 감사 로그 무결성 훼손 (S55 Runbook)

**증상**: integrityOk=false

```bash
curl "http://localhost:3000/admin/audit/integrity-check"
# firstInvalidId 기록
# 즉각: 감사팀, 보안팀, 법무팀 호출
# 감독원 제출 중이면 즉시 중단
```

## 6. 배포 이상 (S56 Runbook)

**증상**: errorRate > 1%, P99 2배 초과

```bash
curl http://localhost:3000/admin/deploy/metrics
# 롤백 판단: errorRate, P99, DLQ, Stuck TX 확인
# 2인 승인 후 롤백 실행
# 컨트랙트 업그레이드였으면 → 컨트랙트 롤백 불가, API 서버만 롤백
```

## 7. 거버넌스 (S57 Runbook)

**증상**: readyToExecute > 0

```bash
curl http://localhost:3000/admin/governance/proposals
# upgrade-checklist.md "실행 전 최종 확인" 완료 후 실행
```

## 에스컬레이션 연락처 (통합)

| 역할 | 이름 | 연락처 | 담당 |
|------|------|-------|------|
| Consumer 담당 | ____ | ____ | S52 유형 1~4 |
| VASP 담당 | ____ | ____ | S53 L2+ |
| 인프라팀 | ____ | ____ | Redis 다운, DB 장애 |
| 준법감시 | ____ | ____ | 감사 로그, 감독원 조회 |
| 서비스 관리자 | ____ | ____ | P1 전체 |
| 경영진 | ____ | ____ | L4, 대규모 장애 |
| 월렛원 기술지원 | ____ | ____ | VASP L3+ |
| 보안팀 | ____ | ____ | 감사 로그 훼손 |
```

라우터 등록:

```typescript
// router.ts

router.get('/admin/dashboard', async (req, res) => {
  const snapshot = await dashboardService.getSnapshot();

  // 동시에 알림 중복 억제 적용하여 발송
  await dashboardService.sendAlertsIfNeeded(snapshot);

  // systemStatus에 따라 HTTP 상태코드
  const statusCode = snapshot.systemStatus === 'CRITICAL' ? 503
                   : snapshot.systemStatus === 'WARNING'  ? 200
                   : 200;

  res.status(statusCode).json(snapshot);
});
```

테스트:

```bash
# 전체 상태 조회
curl http://localhost:3000/admin/dashboard
```

```json
{
  "systemStatus": "OK",
  "snapshotAt": "2026-05-03T09:00:00.000Z",
  "queueStats": {
    "consumerCount": 2, "pendingMessages": 8, "pelSize": 8,
    "redisConnected": true, "status": "OK"
  },
  "dlqStats": { "dlqCount": 0, "status": "OK" },
  "vaspHealth": {
    "available": true, "responseTimeMs": 234,
    "stuckCount": 0, "circuitBreakerStatus": "CLOSED", "status": "OK"
  },
  "reconcileStatus": {
    "lastRunAt": "2026-05-03T03:00:00.000Z",
    "lastMismatchCount": 0, "pendingMismatch": 0, "status": "OK"
  },
  "auditIntegrity": {
    "integrityOk": true, "lastCheckedAt": "2026-05-03T01:00:00.000Z",
    "firstInvalidId": null, "status": "OK"
  },
  "deployMetrics": {
    "currentVersion": "1.4.2", "errorRate": 0.12,
    "p99ResponseMs": 842, "deployStatus": "STABLE", "status": "OK"
  },
  "governanceProposals": {
    "pendingSignatures": 0, "readyToExecute": 0, "status": "OK"
  },
  "activeAlerts": []
}
```

VASP 장애 시 → 전체 CRITICAL:

```json
{
  "systemStatus": "CRITICAL",
  "vaspHealth": { "available": false, "stuckCount": 14, "status": "CRITICAL" },
  "activeAlerts": ["P1: VASP 장애"]
}
```

---

## 완료 기준

- [ ] `GET /admin/dashboard` — 전체 7개 섹션 단일 응답 (Promise.all 병렬 수집)
- [ ] 하나라도 CRITICAL → `systemStatus: CRITICAL` + HTTP 503 확인
- [ ] 모두 OK → `systemStatus: OK` + HTTP 200 확인
- [ ] 알림 중복 억제: 동일 알림 5분 내 1회만 발송 확인
- [ ] `phase1-ops-runbook.md` 완성 (S51~S57 전체 통합, 온콜 5분 가이드 포함)
- [ ] 에스컬레이션 연락처 테이블 작성 완료
- [ ] 운영 교대 인수인계 7개 지표 체크리스트 동작 확인

---

### 운영 체크리스트 — 야간 온콜 알림 수신 시 (5분 행동 지침)

```
[00:00] 알림 수신
  □ GET /admin/dashboard 즉시 호출

[00:30] systemStatus 판단
  OK      → 오탐 가능성, 5분 후 재확인
  WARNING → activeAlerts 섹션 확인
  CRITICAL → 즉시 해당 섹션 Runbook 이동

[01:00] activeAlerts 기반 섹션 이동
  P1: Consumer/Redis  → pm2 status / redis-cli ping
  P1: VASP 장애       → /admin/vasp/health + /admin/vasp/stuck
  P2: DLQ 적재        → /admin/dlq/pending
  P1: Reconcile       → /admin/reconcile/history
  P1: 감사 로그       → /admin/audit/integrity-check
  P1: 에러율          → /admin/deploy/metrics

[03:00] 30초 내 해소 불가 → 에스컬레이션
  Consumer/Redis → 인프라팀 즉시 호출
  VASP           → L2 담당자 호출
  감사 로그      → 감사팀 + 보안팀 즉시 호출

[05:00] 조치 시작 또는 에스컬레이션 완료
```

---

## 워크시트

### 운영 교대 인수인계 시트

> 교대 시각에 이 시트를 채우면서 GET /admin/dashboard 결과를 기록한다.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
운영 교대 인수인계 시트
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[교대 정보]
  교대 시각   : ____________________
  인계자      : ____________________
  인수자      : ____________________

[GET /admin/dashboard 결과] 시각: ____:____
  systemStatus : ( ) OK  ( ) WARNING  ( ) CRITICAL

  1. Consumer  consumerCount: ____  pendingMessages: ____
               redisConnected: ( ) true  ( ) false
               status: ( ) OK  ( ) WARNING  ( ) CRITICAL

  2. DLQ       dlqCount: ____
               status: ( ) OK  ( ) WARNING

  3. VASP      available: ( ) true  ( ) false
               stuckCount: ____  responseTimeMs: ____ ms
               circuitBreakerStatus: ____________________
               status: ( ) OK  ( ) WARNING  ( ) CRITICAL

  4. Reconcile lastRunAt: ____________________
               pendingMismatch: ____
               status: ( ) OK  ( ) WARNING  ( ) CRITICAL

  5. 감사 로그 integrityOk: ( ) true  ( ) false
               status: ( ) OK  ( ) CRITICAL

  6. 배포      currentVersion: ____  errorRate: ____ %
               deployStatus: ____________________
               status: ( ) OK  ( ) WARNING  ( ) CRITICAL

  7. 거버넌스  pendingSignatures: ____  readyToExecute: ____
               status: ( ) OK  ( ) WARNING

[이슈 인계]
  현재 진행 중인 인시던트: ____________________________________
  미해소 이슈            : ____________________________________
  주의 모니터링 항목     : ____________________________________

[인수 확인]
  7개 지표 모두 정상: ( ) 예 → 인수인계 완료
  이상 지표 있음    : ( ) 아니오 → 인계자가 해소 후 인수
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### 야간 온콜 첫 5분 체크리스트

```
┌─────────────────────────────────────────────────────────┐
│  야간 온콜 알림 — 첫 5분 행동 카드                        │
│                                                          │
│  [즉시] curl http://localhost:3000/admin/dashboard       │
│                                                          │
│  [30초] systemStatus 확인                                │
│   OK      → 5분 후 재확인. 해소되면 오탐으로 기록.       │
│   CRITICAL → activeAlerts 보고 섹션 Runbook 이동         │
│                                                          │
│  [1분] 섹션별 조치                                        │
│   Consumer크래시 → pm2 restart dmz-consumer              │
│   Redis다운      → redis-cli ping → 인프라팀             │
│   VASP장애       → /admin/vasp/health → L2 에스컬         │
│   DLQ적재        → /admin/dlq/pending → 원인분류         │
│   감사훼손       → 즉시 감사팀+보안팀 호출               │
│                                                          │
│  [3분] 30초 내 해소 불가 → 에스컬레이션                  │
│   가능하면 혼자 해결하지 말 것                           │
│   불확실하면 즉시 에스컬레이션                           │
│                                                          │
│  [5분] 조치 또는 에스컬레이션 완료                       │
│   모든 행위를 감사 로그에 기록                           │
└─────────────────────────────────────────────────────────┘
```

---

### 월간 운영 건강도 리뷰 시트

> 매월 말일, Phase 1 운영 전체 현황 리뷰.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
월간 운영 건강도 리뷰 — ____년 __월
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[전체 가용성]
  Consumer 다운타임: ____ 분
  VASP 다운타임    : ____ 분 (SLA 위반 여부: ____)
  전체 시스템 가용성: _____ %

[DLQ]
  총 적재 건수: ____  건
  requeue     : ____  건
  drop        : ____  건

[Reconcile]
  총 실행 횟수: Hourly ____ 회 / Daily ____ 회
  불일치 총계 : ____ 건
  원인별 분포 : A(Consumer누락) __건 / B(REORG) __건 / C(DB조작) __건 / D(버그) __건

[감사 로그]
  무결성 이상 발생: ( ) 없음  ( ) __건 (대응: ____________________)
  감독원 조회 대응: ____ 건

[배포]
  배포 횟수      : ____ 회
  롤백 발생      : ____ 회  (사유: ____________________)
  컨트랙트 업그레이드: ____ 회

[거버넌스]
  업그레이드 제안: ____ 건
  실행 완료      : ____ 건
  서명 지연 발생 : ____ 건

[P1 인시던트]
  총 발생 건수    : ____ 건
  평균 해소 시간  : ____ 분
  반복 원인       : ____________________________________

[다음 달 개선 과제]
  □ _______________________________ (담당: ____)
  □ _______________________________ (담당: ____)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 자동화 확장 — DashboardService + AlertDeduplicator

> 모든 지표 통합, 병렬 수집, 알림 중복 억제, 운영 교대 자동 브리핑.

### 운영 교대 자동 브리핑 — 교대 시각에 대시보드 스냅샷 자동 발송

```typescript
// dmz/packages/vasp/src/admin/DashboardService.ts 추가

// 교대 시각: 8시, 16시, 24시 (3교대 가정)
cron.schedule('0 8,16,0 * * *', async () => {
  const snapshot = await dashboardService.getSnapshot();

  const statusEmoji = snapshot.systemStatus === 'OK' ? '✅'
                    : snapshot.systemStatus === 'WARNING' ? '⚠️' : '🚨';

  await notifier.sendAlert({
    title: `${statusEmoji} 운영 교대 브리핑 — ${new Date().toLocaleTimeString('ko-KR')}`,
    severity: snapshot.systemStatus === 'CRITICAL' ? 'P1' : 'P3',
    body: [
      `시스템 전체: ${snapshot.systemStatus}`,
      `Consumer: ${snapshot.queueStats.status} (count=${snapshot.queueStats.consumerCount}, lag=${snapshot.queueStats.pendingMessages})`,
      `DLQ: ${snapshot.dlqStats.status} (count=${snapshot.dlqStats.dlqCount})`,
      `VASP: ${snapshot.vaspHealth.status} (stuck=${snapshot.vaspHealth.stuckCount})`,
      `Reconcile: ${snapshot.reconcileStatus.status} (mismatch=${snapshot.reconcileStatus.pendingMismatch})`,
      `감사 로그: ${snapshot.auditIntegrity.status}`,
      `배포: ${snapshot.deployMetrics.status} (v${snapshot.deployMetrics.currentVersion}, err=${snapshot.deployMetrics.errorRate.toFixed(2)}%)`,
      snapshot.activeAlerts.length > 0 ? `\n🚨 활성 알림:\n${snapshot.activeAlerts.join('\n')}` : '',
    ].filter(Boolean).join('\n'),
  });
}, { timezone: 'Asia/Seoul' });
```

### Phase 1 최종 아날로그↔디지털 대응 전체 요약 (S51~S58 통합)

| 세션 | 아날로그 (워크시트) | 디지털 (API) | 자동화 |
|------|-------------------|-------------|--------|
| S51 DLQ | DLQ 분석 시트 | `GET /admin/dlq/pending` | ✅ 인시던트 자동 생성 |
| S52 Consumer | 장애 대응 시트 | `GET /admin/queue/stats` | ✅ 주간 리포트 자동 |
| S53 VASP SLA | VASP 장애 시트 | `GET /admin/vasp/health` | ✅ SLA 기록 자동 |
| S54 Reconcile | 불일치 대응 시트 | `GET /admin/reconcile/history` | ✅ Hourly/Daily cron |
| S55 감사 보관 | 감독원 조회 시트 | `GET /admin/audit/export` | ✅ 무결성 cron |
| S56 배포 | 배포 당일 시트 | `GET /admin/deploy/metrics` | ✅ 15분 자동 모니터링 |
| S57 거버넌스 | 제안-서명-실행 시트 | `GET /admin/governance/proposals` | ✅ threshold 자동 감지 |
| S58 대시보드 | 교대 인수인계 시트 | `GET /admin/dashboard` | ✅ 교대 자동 브리핑 |
