# M4 S54 — Reconcile 운영 · 스케줄 설계와 불일치 대응 절차

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.

> 모듈 4 · 세션 54 · 1시간 `운영`
> 전제: S25에서 ReconcileService 구현 완료, S24 TxStateMachineService 운영 중
> 스켈레톤: `internal/packages/core-banking/src/admin/ReconcileAdminService.ts`

> ⚠️ **운영 세션** — S25에서 ReconcileService가 왜 필요한지, `reconcile()` 로직이 어떻게 동작하는지는 이미 배웠다. 이번 세션은 **그 reconcile을 언제, 얼마나 자주 실행하는가**와 **불일치를 발견했을 때 운영자가 무엇을 어떻게 결정하는가**다. 역방향 수정 절대 금지 원칙은 이 세션에서 다시 한번 운영 관점에서 재확인한다.

---

## 강의 파트 (25분)

### 1. Reconcile 스케줄링 설계 (8분)

S25에서 구현한 `ReconcileService.reconcile()`은 전체 상태를 대조하는 연산이다. 이것을 얼마나 자주 실행해야 할까?

**비용 계산 먼저:**

```
매번 reconcile = 전체 user_nft_holdings 순회
  → 사용자 10,000명 × eth_call 1회 = 10,000 RPC 호출
  → RPC 비용 + 처리 시간 (수 분 이상)
  → 1분마다 실행하면 시스템 부하 과다
```

그렇다고 하루 1번만 실행하면:

```
23시간 동안 불일치를 모른 채 방치
→ 사용자 앱에서 잘못된 NFT 잔액 표시
→ 컴플라이언스 리스크
```

해결: **두 계층 분리**

```
┌────────────────────────────────────────────────────────────┐
│  Reconcile 스케줄 아키텍처                                   │
│                                                             │
│  Hourly Reconcile (매시간 정각)                              │
│    대상: 최근 1시간 내 업데이트된 user_nft_holdings만        │
│    비용: 적음 (변경된 사용자만 조회)                         │
│    목적: 실시간 이벤트 미처리 감지 (Consumer 누락, 지연)     │
│                                                             │
│  Daily Reconcile (새벽 3시 KST)                             │
│    대상: 전체 user_nft_holdings 순회                         │
│    비용: 높음 (전체 eth_call)                                │
│    목적: 누적 오차 보정 (Reorg, 수동 DB 조작 등)             │
└────────────────────────────────────────────────────────────┘
```

**왜 두 계층이 필요한가:**

| 상황 | Hourly | Daily |
|------|--------|-------|
| Consumer 누락 (이벤트 처리 지연) | ✅ 1시간 내 감지 | ✅ 감지 (but 늦음) |
| Reorg 후 원장 미업데이트 | △ 대상이 아닐 수 있음 | ✅ 전체 순회 |
| 수동 DB 조작 | △ 최근 변경이면 감지 | ✅ 반드시 감지 |
| 코드 버그로 전체 오차 | ❌ 범위 밖 | ✅ 감지 |

**S25 ReconcileService와의 연결:**

```typescript
// S25에서 구현한 reconcile() — 사용자 단위
ReconcileService.reconcile(userId)  // 온체인 vs 원장 1:1 비교

// S54에서 추가하는 것 — 운영 레이어
ReconcileAdminService.runHourlyReconcile()  // 대상 필터링 → 루프
ReconcileAdminService.runDailyReconcile()   // 전체 순회
```

Hourly는 "최근에 뭔가 바뀐 사람들만" 체크한다. Daily는 "모두를" 체크한다.

---

### 2. 불일치 알림 설계 (8분)

불일치 1건과 100건은 의미가 다르다. 건수에 따라 즉각 대응 필요 여부가 달라진다.

**건수별 단계:**

```
1건 발견
  → 담당자 Slack DM
  → 의미: 단발성 이슈. 개별 사용자 이벤트 미처리 가능성
  → 조치: 로그 조회 → 원인 파악 → 이벤트 재처리 또는 기다림

5건 발견 (단일 reconcile 실행 중)
  → 팀 채널 @ 채널 태그
  → 의미: 특정 이벤트 타입 또는 시간대에 반복 누락 가능성
  → 조치: Consumer 상태 확인 + DLQ 조회

10건 이상 발견
  → 즉시 에스컬레이션 (서비스 관리자 호출)
  → 의미: 시스템 전반 장애 가능성 (Consumer 다운, VASP 장애, DB 문제)
  → 조치: 전체 파이프라인 점검 + 인시던트 생성
```

**불일치 원인 분류 — 원인에 따라 조치가 다르다:**

```
┌─────────────────────────────────────────────────────────┐
│  불일치 원인 분류                                         │
│                                                          │
│  원인 A: Consumer 누락                                   │
│    증상: DLQ에 해당 txHash 이벤트 존재                   │
│    확인: GET /admin/dlq/pending → txHash 검색            │
│    조치: DLQ requeue (S51 절차)                          │
│                                                          │
│  원인 B: REORG 미처리                                    │
│    증상: 원장에 기록됐지만 온체인에 없음                  │
│    확인: getReceipt(txHash) = null 또는 다른 블록         │
│    조치: 원장 레코드 무효 처리 (새 INSERT로 보정 기록)    │
│                                                          │
│  원인 C: 수동 DB 조작                                    │
│    증상: 감사 로그에 직접 쿼리 이력 없음                  │
│    확인: DB 접근 로그 조회 + 감사 로그 cross-check        │
│    조치: 감사 로그 기록 + 보안팀 보고                     │
│                                                          │
│  원인 D: 코드 버그                                       │
│    증상: 특정 이벤트 타입에서만 반복 발생                 │
│    확인: 불일치 사용자 × 이벤트 타입 패턴 분석            │
│    조치: 코드 수정 + 배포 + 보정                          │
└─────────────────────────────────────────────────────────┘
```

**⚠️ 역방향 수정 절대 금지 원칙 재확인:**

S25에서 설계 원칙으로 배웠다. 운영 세션에서 다시 확인한다.

```
온체인 → 원장 보정   ✅ 항상 이 방향
원장 → 온체인 수정   ❌ 절대 금지 (보안 취약점)
```

왜 절대 금지인가? 운영 관점에서:

```
상황: user_nft_holdings에 잘못된 레코드가 있음
잘못된 대응: "원장에 있으니 온체인에 mint해주자"
  → DB에 접근 가능한 운영자가 원장 조작 → 임의 NFT 발행 가능
  → 이것은 내부 통제 실패, 금융 사기 경로

올바른 대응: 원장 레코드를 온체인 상태에 맞게 보정
  → 온체인 balanceOf = 0이면 → 원장의 잘못된 레코드를 NULL로 보정 기록
  → 온체인 balanceOf = 1이면 → 원장에 누락된 레코드를 추가
```

"즉시 보정 vs 확인 후 보정" 트레이드오프:

| 전략 | 장점 | 단점 |
|------|------|------|
| 즉시 자동 보정 | 불일치 최소화 | 진단 전 보정 → 원인 파악 어려움 |
| 확인 후 수동 보정 | 원인 파악 + 2인 확인 | 불일치 상태 지속 (사용자 오표시) |

**권장: 확인 후 보정.** 단, 불일치 상태 중 사용자에게 영향이 있는 경우(앱에서 NFT 0으로 표시) → 원인 파악과 병행하여 임시 보정 처리 가능 (감사 로그 필수).

---

### 3. 에스컬레이션 + 감사 로그 연계 (9분)

불일치 발견 → 원인 분류 → 대응 절차:

```
불일치 감지
  ↓
reconcile_history 테이블 기록 (자동)
  ↓
알림 발송 (건수별 단계)
  ↓
운영자 원인 분석
  ├── 원인 A (Consumer 누락) → S51 DLQ Runbook 실행
  ├── 원인 B (REORG) → mint_requests 상태 확인 → TIMEOUT 전이 확인
  ├── 원인 C (수동 조작) → 보안팀 + 감사팀 에스컬레이션
  └── 원인 D (코드 버그) → 개발팀 에스컬레이션 + 핫픽스
  ↓
보정 결정 (2인 확인)
  ↓
보정 실행 → S26 AuditLogService에 기록 (필수)
  ↓
보정 후 재Reconcile → 불일치 0 확인
```

**S26 AuditLogService 연계 — 모든 보정 행위는 감사 로그에:**

```typescript
// 보정 시 감사 로그 기록 패턴
await auditLog.log({
  actor: 'ops-kim@kyobo.com',
  action: 'RECONCILE_CORRECTION',
  resourceId: userId,
  beforeState: { holdings: prevHoldings },
  afterState: { holdings: correctedHoldings, reason: 'Consumer 누락 보정, DLQ requeue 후 처리됨' },
});
```

보정 후 재Reconcile 확인 절차:

```bash
# 보정 완료 후 즉시 확인
curl -X POST http://localhost:3000/admin/reconcile/run \
  -d '{"userId": "user-001", "operator": "ops-kim@kyobo.com", "reason": "보정 후 검증"}'

# 결과 확인 — disparity: 0n, isHealthy: true 여야 정상
```

---

## 실습 파트 (30분)

### 실습 1 — ReconcileAdminService 구현 (10분)

```typescript
// internal/packages/core-banking/src/admin/ReconcileAdminService.ts

export interface ReconcileRunResult {
  runAt: Date;
  runType: 'HOURLY' | 'DAILY' | 'MANUAL';
  targetCount: number;
  mismatchCount: number;
  mismatchUserIds: string[];
  durationMs: number;
}

export class ReconcileAdminService {
  constructor(
    private readonly db: Database,
    private readonly reconcileService: ReconcileService,  // S25 구현체
    private readonly auditLog: AuditLogService,           // S26 구현체
    private readonly notifier: NotifierAdapter,
  ) {}

  // ── Hourly: 최근 1시간 변경된 사용자만 ──────────────────────
  async runHourlyReconcile(): Promise<ReconcileRunResult> {
    const start = Date.now();
    const runAt = new Date();

    // 최근 1시간 내 업데이트된 user_nft_holdings 대상 조회
    const rows = await this.db.query<{ user_id: string }>(
      `SELECT DISTINCT user_id
       FROM user_nft_holdings
       WHERE updated_at >= NOW() - INTERVAL '1 hour'
       ORDER BY user_id`,
    );

    return this._runReconcileForUsers(rows.rows.map(r => r.user_id), 'HOURLY', start, runAt);
  }

  // ── Daily: 전체 사용자 순회 ──────────────────────────────────
  async runDailyReconcile(): Promise<ReconcileRunResult> {
    const start = Date.now();
    const runAt = new Date();

    const rows = await this.db.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM user_nft_holdings ORDER BY user_id`,
    );

    return this._runReconcileForUsers(rows.rows.map(r => r.user_id), 'DAILY', start, runAt);
  }

  // ── Manual: 특정 userId 수동 트리거 ─────────────────────────
  async runManualReconcile(userId: string, operator: string): Promise<ReconcileRunResult> {
    const start = Date.now();
    const runAt = new Date();

    await this.auditLog.log({
      actor: operator,
      action: 'RECONCILE_MANUAL_TRIGGER',
      resourceId: userId,
      afterState: { reason: '수동 reconcile 트리거' },
    });

    return this._runReconcileForUsers([userId], 'MANUAL', start, runAt);
  }

  // ── 내부 공통 실행 로직 ──────────────────────────────────────
  private async _runReconcileForUsers(
    userIds: string[],
    runType: ReconcileRunResult['runType'],
    startMs: number,
    runAt: Date,
  ): Promise<ReconcileRunResult> {
    const mismatchUserIds: string[] = [];

    for (const userId of userIds) {
      try {
        const result = await this.reconcileService.reconcile(userId);

        if (!result.isHealthy) {
          mismatchUserIds.push(userId);

          // 불일치 발견 즉시 감사 로그 기록
          await this.auditLog.log({
            actor: 'reconcile-service',
            action: 'RECONCILE_MISMATCH_DETECTED',
            resourceId: userId,
            afterState: {
              onchainSupply: result.onchainSupply?.toString(),
              bankBalance:   result.bankBalance?.toString(),
              disparity:     result.disparity?.toString(),
              runType,
            },
          });
        }
      } catch (err) {
        // 개별 사용자 오류는 로그만 기록하고 계속 진행
        console.error(`[ReconcileAdmin] reconcile 오류 userId=${userId}`, err);
      }
    }

    const durationMs = Date.now() - startMs;
    const runResult: ReconcileRunResult = {
      runAt,
      runType,
      targetCount:    userIds.length,
      mismatchCount:  mismatchUserIds.length,
      mismatchUserIds,
      durationMs,
    };

    // reconcile_history 저장
    await this.db.query(
      `INSERT INTO reconcile_history
         (run_at, run_type, target_count, mismatch_count, mismatch_user_ids, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [runAt, runType, userIds.length, mismatchUserIds.length,
       JSON.stringify(mismatchUserIds), durationMs],
    );

    // 불일치 건수별 알림
    await this._sendMismatchAlert(mismatchUserIds.length, runType, runResult);

    return runResult;
  }

  private async _sendMismatchAlert(
    mismatchCount: number,
    runType: string,
    result: ReconcileRunResult,
  ): Promise<void> {
    if (mismatchCount === 0) return;

    const severity = mismatchCount >= 10 ? 'P1'
                   : mismatchCount >= 5  ? 'P2'
                   : 'P3';

    await this.notifier.sendAlert({
      title:    `[Reconcile] 불일치 ${mismatchCount}건 감지 (${runType})`,
      severity,
      body: [
        `실행 유형: ${runType}`,
        `대상 사용자: ${result.targetCount}명`,
        `불일치 건수: ${mismatchCount}건`,
        `소요 시간: ${result.durationMs}ms`,
        mismatchCount >= 10 ? '⚠️ 즉시 에스컬레이션 필요' : '',
        `조회: GET /admin/reconcile/history`,
      ].filter(Boolean).join('\n'),
      metadata: { mismatchCount },
    });
  }
}
```

---

### 실습 2 — Reconcile 관리 API 구현 (10분)

```typescript
// admin/router.ts 추가

// 실행 이력 조회
router.get('/admin/reconcile/history', async (req, res) => {
  const limit = Number(req.query.limit) || 20;
  const runType = req.query.runType as string | undefined;

  const rows = await db.query(
    `SELECT
       run_at, run_type, target_count, mismatch_count,
       mismatch_user_ids, duration_ms
     FROM reconcile_history
     ${runType ? `WHERE run_type = '${runType}'` : ''}
     ORDER BY run_at DESC
     LIMIT $1`,
    [limit],
  );

  res.json({ history: rows.rows });
});
```

기대 응답:

```json
{
  "history": [
    {
      "run_at": "2026-05-03T18:00:00.000Z",
      "run_type": "HOURLY",
      "target_count": 42,
      "mismatch_count": 1,
      "mismatch_user_ids": ["user-007"],
      "duration_ms": 12450
    },
    {
      "run_at": "2026-05-03T03:00:00.000Z",
      "run_type": "DAILY",
      "target_count": 8923,
      "mismatch_count": 0,
      "mismatch_user_ids": [],
      "duration_ms": 384200
    }
  ]
}
```

```typescript
// 수동 reconcile 트리거 — 특정 userId 즉시 실행
router.post('/admin/reconcile/run', async (req, res) => {
  const { userId, operator, reason } = req.body;

  if (!userId || !operator) {
    return res.status(400).json({ error: 'userId, operator 필수' });
  }

  const result = await reconcileAdmin.runManualReconcile(userId, operator);

  res.json({
    userId,
    mismatch: result.mismatchCount > 0,
    mismatchCount: result.mismatchCount,
    durationMs: result.durationMs,
  });
});
```

테스트:

```bash
# 이력 조회
curl http://localhost:3000/admin/reconcile/history

# 수동 트리거
curl -X POST http://localhost:3000/admin/reconcile/run \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-007",
    "operator": "ops-kim@kyobo.com",
    "reason": "불일치 신고 접수 후 수동 검증"
  }'
```

---

### 실습 3 — 불일치 알림 트리거 + cron 등록 (10분)

```typescript
// internal/packages/core-banking/src/admin/index.ts

import cron from 'node-cron';

// Hourly Reconcile: 매시간 정각 (최근 1시간 대상)
cron.schedule('0 * * * *', async () => {
  console.log('[ReconcileAdmin] Hourly reconcile 시작');
  try {
    const result = await reconcileAdmin.runHourlyReconcile();
    console.log(
      `[ReconcileAdmin] Hourly 완료: 대상=${result.targetCount}, 불일치=${result.mismatchCount}`,
    );
  } catch (err) {
    console.error('[ReconcileAdmin] Hourly reconcile 오류', err);
    await notifier.sendAlert({
      title: '[ReconcileAdmin] Hourly reconcile 실행 오류',
      severity: 'P2',
      body: String(err),
    });
  }
}, { timezone: 'Asia/Seoul' });

// Daily Reconcile: 새벽 3시 KST (전체 사용자)
cron.schedule('0 3 * * *', async () => {
  console.log('[ReconcileAdmin] Daily reconcile 시작 (전체)');
  try {
    const result = await reconcileAdmin.runDailyReconcile();
    console.log(
      `[ReconcileAdmin] Daily 완료: 대상=${result.targetCount}, 불일치=${result.mismatchCount}, 소요=${result.durationMs}ms`,
    );
  } catch (err) {
    console.error('[ReconcileAdmin] Daily reconcile 오류', err);
    await notifier.sendAlert({
      title: '[ReconcileAdmin] Daily reconcile 실행 오류',
      severity: 'P1',
      body: String(err),
    });
  }
}, { timezone: 'Asia/Seoul' });
```

불일치 임계값별 알림 확인:

```typescript
// 임계값 테스트 (개발 환경에서 강제 불일치 삽입)
it('불일치 1건 → P3 알림 발송', async () => {
  // user-001 원장 강제 조작
  await db.query("UPDATE user_nft_holdings SET token_id = 9999 WHERE user_id = 'user-001'");

  const alertSpy = jest.fn();
  const result = await reconcileAdmin.runHourlyReconcile();

  expect(result.mismatchCount).toBe(1);
  expect(alertSpy).toHaveBeenCalledWith(
    expect.objectContaining({ severity: 'P3' }),
  );
});

it('불일치 10건 이상 → P1 즉시 에스컬레이션', async () => {
  // 10개 사용자 원장 강제 조작
  // ...
  const result = await reconcileAdmin.runDailyReconcile();
  expect(alertSpy).toHaveBeenCalledWith(
    expect.objectContaining({ severity: 'P1' }),
  );
});
```

---

## 완료 기준

- [ ] `runHourlyReconcile()` — 최근 1시간 변경 사용자만 대상, 불일치 감사 로그 자동 기록
- [ ] `runDailyReconcile()` — 전체 순회, reconcile_history 저장 확인
- [ ] `GET /admin/reconcile/history` — 이력 조회 (run_type 필터 동작)
- [ ] `POST /admin/reconcile/run` — 특정 userId 수동 트리거, 감사 로그 기록 확인
- [ ] 불일치 1건 → P3, 5건 → P2, 10건+ → P1 알림 단계 확인
- [ ] Hourly cron (매시간), Daily cron (새벽 3시 KST) 등록 확인
- [ ] 역방향 수정 코드 없음 확인 (`grep mintBatch ReconcileAdminService.ts` → 결과 없음)

---

### 운영 체크리스트 — Reconcile 불일치 알림 수신 시

```
□ /admin/reconcile/history 조회 → 최근 실행 결과 + 불일치 건수 파악
□ mismatch_user_ids 확인 → 특정 사용자/이벤트 타입 패턴 있는지 분석

□ 원인 분류
    ├── GET /admin/dlq/pending → txHash 검색 (원인 A: Consumer 누락)
    ├── getReceipt(txHash) 확인 (원인 B: REORG)
    ├── DB 접근 로그 + 감사 로그 cross-check (원인 C: 수동 조작)
    └── 이벤트 타입별 패턴 분석 (원인 D: 코드 버그)

□ 역방향 수정 금지 확인 — 온체인 기준으로 원장 보정
□ 보정 전 2인 확인
□ 보정 후 AuditLogService.log() 기록 (필수)
□ 보정 후 즉시 POST /admin/reconcile/run → mismatch: false 확인
□ 10건+ → 인시던트 생성 + 서비스 관리자 호출
```

---

## 워크시트

### Reconcile 불일치 대응 시트

> Reconcile 알림 수신 시 이 시트를 순서대로 채운다.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Reconcile 불일치 대응 시트
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[기본 정보]
  수신 시각    : ____________________
  알림 심각도  : ( ) P1  ( ) P2  ( ) P3
  실행 유형    : ( ) HOURLY  ( ) DAILY
  불일치 건수  : ____  건
  대상 사용자 수: ____  명

[불일치 사용자 목록]
  userId 1: ____________________
  userId 2: ____________________
  userId 3: ____________________ (이하 생략)

[원인 분석]
  원인 분류 (해당 항목에 V):
  ( ) A: Consumer 누락  → DLQ 확인: ____________________
  ( ) B: REORG 미처리   → txHash: ________________________
  ( ) C: 수동 DB 조작   → 접근 로그 확인 결과: ____________
  ( ) D: 코드 버그      → 패턴: __________________________
  ( ) E: 기타           → 설명: __________________________

[방향 확인 — 필수]
  불일치 방향:
  ( ) 온체인 있음 + 원장 없음  → 원장에 추가해야 함
  ( ) 온체인 없음 + 원장 있음  → 원장 무효 처리해야 함

  역방향 수정 의도 없음 확인: ( ) 확인 완료

[보정 결정]
  보정 필요 여부: ( ) 즉시 보정  ( ) 원인 해소 후 보정  ( ) 보정 불필요
  1차 확인자: ____________________
  2차 확인자: ____________________

[실행 기록]
  보정 실행 시각: ____________________
  AuditLog 기록 확인: ( ) 완료
  POST /admin/reconcile/run 결과:
    mismatch: ( ) true (아직 불일치)  ( ) false ✅

[사후 확인]
  다음 Hourly reconcile 후 동일 사용자 불일치 재발: ( ) 재발  ( ) 해소 ✅
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### 역방향 수정 금지 판단 카드

```
┌─────────────────────────────────────────────────────────┐
│  지금 하려는 보정이 올바른 방향인가?                      │
│                                                          │
│  보정 전 반드시 이 카드를 확인한다.                      │
│                                                          │
│  Q1. 온체인 balanceOf를 기준으로 보정하는가?       Y / N │
│  Q2. 원장(DB)을 기준으로 온체인 TX를 발행하는가?   Y / N │
│                                                          │
│  Q1 = Y, Q2 = N → 올바른 방향 ✅                        │
│  Q2 = Y        → 즉시 중단 ❌                           │
│                   역방향 수정 = 보안 취약점              │
│                   담당 개발자에게 에스컬레이션           │
│                                                          │
│  보정 코드에 다음이 있으면 즉시 멈추고 코드 리뷰 요청:   │
│    - mintBatch()                                         │
│    - mint()                                              │
│    - sendTransaction()                                   │
│    → 이 함수들이 ReconcileAdminService 내부에 있으면 안됨│
└─────────────────────────────────────────────────────────┘
```

---

### 주간 Reconcile 리뷰 시트

> 매주 월요일, 지난주 Reconcile 운영 현황 기록.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
주간 Reconcile 리뷰 — ____년 __월 __일 ~ __월 __일
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[실행 현황]
  Hourly 실행 횟수: ____ 회  (정상: 168회/주)
  Daily 실행 횟수 : ____  회  (정상: 7회/주)
  실행 실패       : ____  회  → 사유: ________________

[불일치 집계]
  총 불일치 건수: ____  건
  원인별 분류:
    A. Consumer 누락: ____ 건
    B. REORG 미처리 : ____ 건
    C. 수동 DB 조작 : ____ 건 ← 0이어야 정상
    D. 코드 버그    : ____ 건 ← 0이어야 정상

[보정 현황]
  보정 완료 건수: ____  건
  미해소 건수   : ____  건 → 사유: ________________

[반복 패턴]
  동일 사용자 2회 이상 불일치: ____ 명
  → 해당 userId: ____________________

[이번 주 주요 이슈]
  1. ________________________________________________
  2. ________________________________________________

[다음 주 개선 과제]
  □ _______________________________ (담당: ____)
  □ _______________________________ (담당: ____)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 자동화 확장 — ReconcileIncidentService

> 위 워크시트의 디지털 버전. 불일치 발견 → 자동 인시던트 생성 + 원인 자동 분류.

### 설계 원칙

```
자동 수집 가능                     운영자 판단 필요
──────────────────────             ─────────────────────────
불일치 userId 목록                 보정 결정 (즉시 vs 대기)
DLQ 교차 검색 (원인 A 여부)        역방향 수정 승인 거부
processed_events 조회              2차 확인자 지정
REORG 이력 확인 (원인 B 여부)      외부 에스컬레이션 판단
```

### TypeScript 서비스 클래스 구현

```typescript
// internal/packages/core-banking/src/admin/ReconcileIncidentService.ts

export type MismatchCause = 'CONSUMER_LAG' | 'REORG' | 'MANUAL_DB' | 'CODE_BUG' | 'UNKNOWN';

export interface ReconcileIncident {
  id: string;
  detectedAt: Date;
  runType: 'HOURLY' | 'DAILY';
  mismatchUserIds: string[];

  // 자동 분류
  autoClassification: Array<{
    userId: string;
    cause: MismatchCause;
    evidence: string;
  }>;

  status: 'OPEN' | 'INVESTIGATING' | 'CORRECTED' | 'RESOLVED';
  resolvedBy?: string;
  resolutionNote?: string;
}

export class ReconcileIncidentService {
  constructor(
    private readonly db: Database,
    private readonly dlqAdmin: DLQAdminService,
    private readonly auditLog: AuditLogService,
    private readonly notifier: NotifierAdapter,
  ) {}

  async create(runResult: ReconcileRunResult): Promise<ReconcileIncident> {
    const { mismatchUserIds, runType } = runResult;

    // 자동 원인 분류
    const autoClassification = await Promise.all(
      mismatchUserIds.map(async userId => {
        return this._classifyCause(userId);
      }),
    );

    const incident: ReconcileIncident = {
      id: crypto.randomUUID(),
      detectedAt: new Date(),
      runType,
      mismatchUserIds,
      autoClassification,
      status: 'OPEN',
    };

    await this.db.query(
      `INSERT INTO reconcile_incidents
         (id, detected_at, run_type, mismatch_user_ids, auto_classification, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [incident.id, incident.detectedAt, runType,
       JSON.stringify(mismatchUserIds), JSON.stringify(autoClassification), 'OPEN'],
    );

    await this.notifier.sendAlert({
      title: `[Reconcile 인시던트] 불일치 ${mismatchUserIds.length}건`,
      severity: mismatchUserIds.length >= 10 ? 'P1' : mismatchUserIds.length >= 5 ? 'P2' : 'P3',
      body: [
        `자동 분류 결과:`,
        ...autoClassification.map(c => `  ${c.userId}: ${c.cause} (${c.evidence})`),
        `조회: GET /admin/reconcile/incidents/${incident.id}`,
      ].join('\n'),
    });

    return incident;
  }

  private async _classifyCause(userId: string): Promise<{ userId: string; cause: MismatchCause; evidence: string }> {
    // 1. DLQ에 해당 userId 관련 이벤트 있는지 확인 (원인 A)
    const dlqItems = await this.dlqAdmin.listPending({ limit: 500 });
    const dlqMatch = dlqItems.find(item => item.event?.['userId'] === userId);
    if (dlqMatch) {
      return { userId, cause: 'CONSUMER_LAG', evidence: `DLQ ID: ${dlqMatch.dlqId}` };
    }

    // 2. processed_events + mint_requests REORG 이력 확인 (원인 B)
    const reorgRows = await this.db.query(
      `SELECT id FROM mint_requests
       WHERE user_id = $1 AND status = 'REVERTED'
       AND updated_at >= NOW() - INTERVAL '2 hours'
       LIMIT 1`,
      [userId],
    );
    if (reorgRows.rows.length > 0) {
      return { userId, cause: 'REORG', evidence: `REVERTED TX: ${reorgRows.rows[0].id}` };
    }

    // 3. 감사 로그에 직접 DB 조작 기록 없는데 불일치 → 수동 조작 의심 (원인 C)
    const auditRows = await this.db.query(
      `SELECT id FROM audit_log
       WHERE resource_id = $1
       AND actor NOT LIKE '%service%'
       AND actor NOT LIKE '%system%'
       AND event_time >= NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [userId],
    );
    if (auditRows.rows.length > 0) {
      return { userId, cause: 'MANUAL_DB', evidence: `감사 로그 ID: ${auditRows.rows[0].id}` };
    }

    return { userId, cause: 'UNKNOWN', evidence: '자동 분류 실패. 수동 조사 필요.' };
  }
}
```

### API 엔드포인트

```typescript
// Reconcile 인시던트 목록 조회
router.get('/admin/reconcile/incidents', async (req, res) => {
  const { status, limit } = req.query;
  const rows = await db.query(
    `SELECT * FROM reconcile_incidents
     ${status ? `WHERE status = '${status}'` : ''}
     ORDER BY detected_at DESC
     LIMIT $1`,
    [Number(limit) || 20],
  );
  res.json({ incidents: rows.rows });
});

// 인시던트 해소
router.post('/admin/reconcile/incidents/:id/resolve', async (req, res) => {
  const { operator, note } = req.body;
  await db.query(
    `UPDATE reconcile_incidents
     SET status = 'RESOLVED', resolved_by = $1, resolution_note = $2
     WHERE id = $3`,
    [operator, note, req.params.id],
  );
  res.json({ ok: true });
});
```

### 아날로그↔디지털 대응 요약 테이블

| 아날로그 (워크시트) | 디지털 (API/서비스) | 자동화 여부 |
|---|---|---|
| 불일치 사용자 목록 확인 | `POST /admin/reconcile/incidents` 응답 `mismatchUserIds` | ✅ 자동 |
| DLQ 교차 검색 (원인 A) | `autoClassification[].cause === 'CONSUMER_LAG'` | ✅ 자동 |
| REORG 이력 확인 (원인 B) | `autoClassification[].cause === 'REORG'` | ✅ 자동 |
| 역방향 수정 방향 확인 | 판단 카드 + 코드 grep | 운영자 확인 |
| 2인 확인 | `POST .../incidents/:id/resolve` 기록 | 운영자 입력 |
| 보정 후 재Reconcile | `POST /admin/reconcile/run` | 운영자 실행 |
| 주간 리뷰 집계 | `GET /admin/reconcile/history` + incidents 조회 | ✅ 자동 |
