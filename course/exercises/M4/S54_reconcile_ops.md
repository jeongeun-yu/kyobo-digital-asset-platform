# S54 운영 실습 — Reconcile 운영 · 스케줄 설계와 불일치 대응 절차

강의 노트: `M4_S54_reconcile_ops.md`
소요 시간: 60 분

---

## 목표

- Hourly / Daily Reconcile 스케줄 실행 및 이력 조회 방법 숙지
- 불일치 발견 시 원인 분류 → 대응 → 감사 로그 기록 절차 습득
- 역방향 수정 금지 원칙을 운영 관점에서 재확인
- ReconcileAdminService 수동 트리거 API 사용법 익히기

---

## 사전 준비

```bash
# 개발 서버 기동
npm run dev

# 또는 Docker Compose (DB 포함)
docker-compose up -d
```

---

## Step 1 — Reconcile 스케줄 등록 확인

ReconcileAdminService의 cron이 정상 등록됐는지 확인한다.

```typescript
// src/admin/index.ts 의 cron 등록 확인
import cron from 'node-cron';

// Hourly: 매시간 정각
cron.schedule('0 * * * *', async () => {
  const result = await reconcileAdmin.runHourlyReconcile();
  console.log(`[Hourly] 대상=${result.targetCount}, 불일치=${result.mismatchCount}`);
}, { timezone: 'Asia/Seoul' });

// Daily: 새벽 3시 KST
cron.schedule('0 3 * * *', async () => {
  const result = await reconcileAdmin.runDailyReconcile();
  console.log(`[Daily] 대상=${result.targetCount}, 불일치=${result.mismatchCount}`);
}, { timezone: 'Asia/Seoul' });
```

예상 로그 (서버 시작 시):

```
[ReconcileAdmin] cron 등록 완료: Hourly(0 * * * *), Daily(0 3 * * * KST)
```

---

## Step 2 — 수동 Reconcile 트리거 (개발 환경 테스트)

실제 Hourly cron을 기다리지 않고 수동으로 즉시 실행한다.

```bash
# 특정 사용자 수동 reconcile
curl -X POST http://localhost:3000/admin/reconcile/run \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-001",
    "operator": "ops-kim@kyobo.com",
    "reason": "불일치 신고 접수 후 수동 검증"
  }'
```

예상 응답:

```json
{
  "userId": "user-001",
  "mismatch": false,
  "mismatchCount": 0,
  "durationMs": 142
}
```

불일치가 있는 경우:

```json
{
  "userId": "user-001",
  "mismatch": true,
  "mismatchCount": 1,
  "durationMs": 98
}
```

---

## Step 3 — Reconcile 이력 조회

```bash
# 전체 이력 조회 (최근 20건)
curl http://localhost:3000/admin/reconcile/history

# Hourly 이력만 조회
curl "http://localhost:3000/admin/reconcile/history?runType=HOURLY&limit=10"

# Daily 이력만 조회
curl "http://localhost:3000/admin/reconcile/history?runType=DAILY"
```

예상 응답:

```json
{
  "history": [
    {
      "run_at": "2026-05-10T09:00:00.000Z",
      "run_type": "HOURLY",
      "target_count": 42,
      "mismatch_count": 1,
      "mismatch_user_ids": ["user-007"],
      "duration_ms": 12450
    },
    {
      "run_at": "2026-05-09T18:00:00.000Z",
      "run_type": "DAILY",
      "target_count": 8923,
      "mismatch_count": 0,
      "mismatch_user_ids": [],
      "duration_ms": 384200
    }
  ]
}
```

확인 포인트:

- `mismatch_count`: 0이 정상 운영 상태
- `duration_ms`: Hourly는 수 초~수십 초, Daily는 수 분 이상 예상
- `mismatch_user_ids`: 불일치 발생 시 즉시 원인 분석 시작

---

## Step 4 — 강제 불일치 삽입 및 감지 시나리오

개발 환경에서 불일치를 강제로 만들어 reconcile이 감지하는지 확인한다.

```sql
-- [시나리오 A] 원장에만 있고 온체인에 없는 케이스 시뮬레이션
-- user_nft_holdings에 가짜 tokenId 삽입
INSERT INTO user_nft_holdings (user_id, token_id, policy_id)
VALUES ('user-001', 99999, 'FAKE-POLICY')
ON CONFLICT (user_id, token_id) DO NOTHING;
```

삽입 후 수동 reconcile 실행:

```bash
curl -X POST http://localhost:3000/admin/reconcile/run \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-001",
    "operator": "ops-kim@kyobo.com",
    "reason": "강제 불일치 시나리오 테스트"
  }'
```

예상 응답:

```json
{
  "userId": "user-001",
  "mismatch": true,
  "mismatchCount": 1,
  "durationMs": 103
}
```

감사 로그 확인:

```sql
SELECT id, event_time, actor, action, resource_id, after_state
FROM audit_log
WHERE action = 'RECONCILE_MISMATCH_DETECTED'
  AND resource_id = 'user-001'
ORDER BY id DESC
LIMIT 5;
```

---

## Step 5 — 불일치 원인 분류 절차

불일치 알림 수신 시 아래 순서로 원인을 분류한다.

### 원인 A 확인: Consumer 누락 (DLQ 교차 검색)

```bash
# DLQ에 해당 사용자 관련 이벤트 있는지 확인
curl http://localhost:3000/admin/dlq/pending | jq '.items[] | select(.event.userId == "user-001")'
```

결과에 이벤트가 있으면 → DLQ requeue (S51 절차 참조)

### 원인 B 확인: REORG 미처리

```sql
-- REORGED 또는 REVERTED 상태 TX 확인 (최근 2시간)
SELECT id, tx_hash, status, updated_at
FROM mint_requests
WHERE user_id = 'user-001'
  AND status IN ('REORGED', 'FAILED')
  AND updated_at >= NOW() - INTERVAL '2 hours';
```

```bash
# 온체인 TX 수신 확인
cast receipt <txHash> --rpc-url $RPC_URL
# → null이면 REORG로 TX 소실 확인
```

### 원인 C 확인: 수동 DB 조작

```sql
-- 감사 로그에서 사람이 직접 실행한 행위 확인
SELECT id, event_time, actor, action
FROM audit_log
WHERE resource_id = 'user-001'
  AND actor NOT LIKE '%service%'
  AND actor NOT LIKE '%system%'
  AND event_time >= NOW() - INTERVAL '24 hours'
ORDER BY id DESC;
```

시스템 행위자(`system:`, `reconcile-service`)가 아닌 사람 계정이 나오면 → 보안팀 보고

### 원인 D 확인: 코드 버그

```sql
-- 동일 이벤트 타입에서 반복 불일치 패턴 분석
SELECT mismatch_user_ids, run_at
FROM reconcile_history
WHERE mismatch_count > 0
ORDER BY run_at DESC
LIMIT 20;
```

동일 `userId`가 반복해서 나오면 → 개발팀 에스컬레이션

---

## Step 6 — 보정 실행 및 감사 로그 기록

보정 결정 후 2인 확인 완료 시 실행한다.

```bash
# 보정 후 감사 로그 기록 (AuditLogService 직접 호출 또는 API)
curl -X POST http://localhost:3000/admin/audit/log \
  -H "Content-Type: application/json" \
  -d '{
    "actor": "ops-kim@kyobo.com",
    "action": "RECONCILE_CORRECTION",
    "resourceId": "user-001",
    "beforeState": { "holdings": ["1001", "99999"] },
    "afterState": {
      "holdings": ["1001"],
      "reason": "토큰 99999는 온체인에 없음 — REORG 후 원장 과잉 레코드 삭제",
      "approvedBy": "ops-park@kyobo.com",
      "resolvedAt": "2026-05-10T10:30:00Z"
    }
  }'
```

보정 후 즉시 재Reconcile로 정상 확인:

```bash
curl -X POST http://localhost:3000/admin/reconcile/run \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-001",
    "operator": "ops-kim@kyobo.com",
    "reason": "보정 후 검증"
  }'
# 기대 결과: "mismatch": false
```

---

## Step 7 — 역방향 수정 금지 확인

ReconcileAdminService 소스에 온체인 TX 발행 메서드가 없는지 검증한다.

```bash
# 온체인 TX 관련 메서드 없음 확인 (결과 없어야 정상)
grep -n "mintBatch\|mint(\|sendTransaction\|forceMint" \
  src/admin/ReconcileAdminService.ts

# → 결과 없음이 정상
# → 결과가 있으면 즉시 코드 리뷰 요청
```

판단 카드:

```
Q1. 온체인 balanceOf를 기준으로 보정하는가?       Y → OK
Q2. 원장(DB)을 기준으로 온체인 TX를 발행하는가?   Y → 즉시 중단 ❌
```

---

## Step 8 — 불일치 건수별 알림 임계값 검증 (개발 환경)

```sql
-- 여러 사용자에게 강제 불일치 삽입
INSERT INTO user_nft_holdings (user_id, token_id, policy_id)
SELECT 'user-' || LPAD(i::TEXT, 3, '0'), 99000 + i, 'TEST'
FROM generate_series(1, 12) AS i
ON CONFLICT DO NOTHING;
```

Daily Reconcile 수동 트리거:

```bash
curl -X POST http://localhost:3000/admin/reconcile/run-daily \
  -H "Content-Type: application/json" \
  -d '{ "operator": "ops-kim@kyobo.com" }'
```

예상 알림:

- 불일치 1~4건: P3 (Slack DM)
- 불일치 5~9건: P2 (팀 채널 @channel)
- 불일치 10건+: P1 (즉시 에스컬레이션)

---

## 토론 포인트

1. **Hourly vs Daily 두 계층이 필요한 이유는?**
   - Hourly: 최근 이벤트 누락을 빠르게 감지 (Consumer 장애, 지연)
   - Daily: 전체 순회로 누적 오차 발견 (Reorg, 코드 버그, 수동 조작)
   - 하나만으로는 커버할 수 없는 영역이 있다

2. **자동 보정을 하지 않는 이유는?**
   - 처리 지연과 진짜 불일치를 코드가 구분할 수 없다
   - Reorg 중 자동 보정 시 결과 예측 불가
   - 원장 → 온체인 코드가 있으면 DB 조작으로 임의 TX 유발 가능 (보안 취약점)

3. **보정 전 2인 확인이 필요한 이유는?**
   - 보정 방향 오류 방지 (온체인 기준인지 확인)
   - 내부 통제 요건 (ISO 27001, ISMS-P)
   - 책임 분리 — 보정 실행자 ≠ 승인자

---

## 운영 체크리스트 — Reconcile 불일치 알림 수신 시

```
□ /admin/reconcile/history 조회 → 최근 실행 결과 + 불일치 건수 파악
□ mismatch_user_ids 확인 → 특정 사용자/패턴 있는지 분석

□ 원인 분류
    ├── GET /admin/dlq/pending → txHash 검색          (원인 A: Consumer 누락)
    ├── getReceipt(txHash) 확인                        (원인 B: REORG)
    ├── DB 접근 로그 + 감사 로그 cross-check            (원인 C: 수동 조작)
    └── 이벤트 타입별 패턴 분석                         (원인 D: 코드 버그)

□ 역방향 수정 금지 확인 — 온체인 기준으로 원장 보정
□ 보정 전 2인 확인
□ 보정 후 AuditLogService.log() 기록 (필수)
□ 보정 후 즉시 POST /admin/reconcile/run → mismatch: false 확인
□ 10건+ → 인시던트 생성 + 서비스 관리자 호출
```

---

## 워크시트 — Reconcile 불일치 대응 시트

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Reconcile 불일치 대응 시트
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[기본 정보]
  수신 시각    : ____________________
  알림 심각도  : ( ) P1  ( ) P2  ( ) P3
  실행 유형    : ( ) HOURLY  ( ) DAILY  ( ) MANUAL
  불일치 건수  : ____  건
  대상 사용자  : ____________________

[원인 분석]
  ( ) A: Consumer 누락  → DLQ 확인: ____________________
  ( ) B: REORG 미처리   → txHash: ________________________
  ( ) C: 수동 DB 조작   → 접근 로그 결과: ________________
  ( ) D: 코드 버그      → 패턴: __________________________

[방향 확인]
  불일치 방향:
  ( ) 온체인 있음 + 원장 없음  → 원장에 추가
  ( ) 온체인 없음 + 원장 있음  → 원장 무효 처리
  역방향 수정 의도 없음: ( ) 확인 완료

[보정 결정]
  보정 유형: ( ) 즉시  ( ) 원인 해소 후  ( ) 불필요
  1차 확인자: ____________________
  2차 확인자: ____________________

[실행 기록]
  AuditLog 기록: ( ) 완료
  POST /admin/reconcile/run 결과: mismatch = ( ) true  ( ) false ✅
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
