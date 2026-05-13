# S58 운영 실습 — 모니터링 대시보드 운영: Phase 1 전체 지표 통합과 온콜 체계

강의 노트: `M8_S58_monitoring_dashboard_ops.md`
소요 시간: 60 분

---

## 목표

- GET /admin/dashboard 단일 호출로 Phase 1 전체 시스템 상태 파악
- 7개 섹션별 상태(OK / WARNING / CRITICAL) 해석
- 알림 중복 억제(5분 TTL) 동작 확인
- 야간 온콜 시 첫 5분 행동 지침 실습
- 운영 교대 인수인계 7개 지표 체크리스트 완성

---

## 배경 (S51~S57 통합)

S51(DLQ)~S57(거버넌스)에서 구현한 각 `/admin/*` 엔드포인트들을 단일 대시보드로 통합한다. 야간 온콜 담당자가 새벽 3시에 알림을 받았을 때 **GET /admin/dashboard 한 번**으로 전체 상태를 파악할 수 있어야 한다.

---

## Step 1 — 대시보드 API 호출과 응답 해석

```bash
# 전체 상태 조회
curl http://localhost:3000/admin/dashboard \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

정상 상태 응답:

```json
{
  "systemStatus": "OK",
  "snapshotAt": "2026-05-10T09:00:00.000Z",
  "queueStats": {
    "consumerCount": 2,
    "pendingMessages": 8,
    "pelSize": 8,
    "redisConnected": true,
    "status": "OK"
  },
  "dlqStats": {
    "dlqCount": 0,
    "status": "OK"
  },
  "vaspHealth": {
    "available": true,
    "responseTimeMs": 234,
    "stuckCount": 0,
    "circuitBreakerStatus": "CLOSED",
    "status": "OK"
  },
  "reconcileStatus": {
    "lastRunAt": "2026-05-10T03:00:00.000Z",
    "lastMismatchCount": 0,
    "pendingMismatch": 0,
    "status": "OK"
  },
  "auditIntegrity": {
    "integrityOk": true,
    "lastCheckedAt": "2026-05-10T01:00:00.000Z",
    "firstInvalidId": null,
    "status": "OK"
  },
  "deployMetrics": {
    "currentVersion": "1.4.2",
    "errorRate": 0.12,
    "p99ResponseMs": 842,
    "deployStatus": "STABLE",
    "status": "OK"
  },
  "governanceProposals": {
    "pendingSignatures": 0,
    "readyToExecute": 0,
    "status": "OK"
  },
  "activeAlerts": []
}
```

---

## Step 2 — 각 섹션별 임계값과 판단 기준

| 섹션 | OK | WARNING | CRITICAL |
|------|-----|---------|----------|
| Consumer | consumerCount >= 1, redisConnected | pendingMessages >= 200 | consumerCount = 0 또는 redisConnected = false |
| DLQ | dlqCount = 0 | dlqCount > 0 | — |
| VASP | available = true, stuckCount < 10 | stuckCount >= 10 | available = false |
| Reconcile | mismatch = 0 | mismatch 1~9건 | mismatch >= 10건 |
| 감사 로그 | integrityOk = true | — | integrityOk = false |
| 배포 | errorRate < 1% | p99 > 10s | errorRate > 1% |
| 거버넌스 | readyToExecute = 0 | readyToExecute > 0 | — |

**전체 systemStatus 규칙:**
- 하나라도 CRITICAL → systemStatus: CRITICAL (HTTP 503)
- 하나라도 WARNING (CRITICAL 없음) → systemStatus: WARNING (HTTP 200)
- 모두 OK → systemStatus: OK (HTTP 200)

---

## Step 3 — 장애 시나리오 시뮬레이션

### 3-1. VASP 장애 시뮬레이션

```bash
# VASP API 응답 차단 (iptables 또는 mock 설정)
# docker exec vasp-mock kill -STOP 1  # VASP 프로세스 일시 중지

# 대시보드 조회
curl http://localhost:3000/admin/dashboard | jq '{
  systemStatus: .systemStatus,
  vaspHealth: .vaspHealth,
  activeAlerts: .activeAlerts
}'
```

기대 응답:

```json
{
  "systemStatus": "CRITICAL",
  "vaspHealth": {
    "available": false,
    "stuckCount": 14,
    "circuitBreakerStatus": "OPEN",
    "status": "CRITICAL"
  },
  "activeAlerts": ["P1: VASP 장애"]
}
```

**HTTP 상태 코드 확인:**

```bash
curl -o /dev/null -w "%{http_code}" http://localhost:3000/admin/dashboard
# 503 확인
```

### 3-2. Consumer 크래시 시뮬레이션

```bash
# PM2로 Consumer 강제 종료
pm2 stop issuer-consumer

# 대시보드 조회
curl http://localhost:3000/admin/dashboard | jq '.queueStats'
# consumerCount: 0, status: "CRITICAL"

# Consumer 재시작
pm2 start issuer-consumer

# 재시작 후 대시보드 재조회
curl http://localhost:3000/admin/dashboard | jq '.queueStats'
# consumerCount: 2, status: "OK"
```

### 3-3. DLQ 적재 시뮬레이션

```bash
# DLQ에 테스트 항목 추가 (mock API)
curl -X POST http://localhost:3000/admin/dlq/test-push \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 대시보드 조회
curl http://localhost:3000/admin/dashboard | jq '.dlqStats'
# dlqCount: 1, status: "WARNING"

# systemStatus: WARNING (CRITICAL 없으면 WARNING)
curl http://localhost:3000/admin/dashboard | jq '.systemStatus'
```

---

## Step 4 — 알림 중복 억제 확인

```bash
# 첫 번째 CRITICAL 상태 발생 → 알림 발송
curl http://localhost:3000/admin/dashboard
# 알림 채널(Slack/PagerDuty)에서 첫 번째 알림 수신 확인

# 5분 내 동일 CRITICAL 상태 재조회 → 알림 억제 (중복 발송 없음)
sleep 10
curl http://localhost:3000/admin/dashboard
# 알림 채널에 두 번째 알림 없음 확인

# Redis 억제 키 확인
redis-cli keys "alert:dedup:*"
# alert:dedup:P1:P1_VASP_장애  → TTL 확인
redis-cli ttl "alert:dedup:P1:P1_VASP_장애"
# 0~300 사이 값 (5분 억제 윈도우)

# 억제 키 수동 삭제 → 알림 재발송 확인 (5분 강제 만료 시뮬레이션)
redis-cli del "alert:dedup:P1:P1_VASP_장애"
curl http://localhost:3000/admin/dashboard
# 알림 채널에 다시 알림 수신 확인
```

---

## Step 5 — 야간 온콜 첫 5분 행동 지침 실습

> 실제 야간 알림 수신 상황을 가정하고 아래 순서를 따른다.

```
[00:00] 알림 수신: "P1: VASP 장애"

[00:30] GET /admin/dashboard 즉시 호출
  → systemStatus 확인
  → activeAlerts 확인

[01:00] activeAlerts 기반 섹션 이동
  P1: VASP 장애 → Step 3-1 참조

  curl http://localhost:3000/admin/vasp/health
  curl http://localhost:3000/admin/vasp/stuck

[02:00] 원인 파악
  → VASP API timeout? → 월렛원 상태 페이지 확인
  → Circuit Breaker OPEN? → 자동 복구 대기 (30초)
  → stuckCount 급증? → 운영팀 통보

[03:00] 30초 내 해소 불가 → 에스컬레이션
  → L2: VASP 담당자 호출
  → L3: 월렛원 기술지원 티켓

[05:00] 조치 완료 또는 에스컬레이션 완료
  → 모든 행위를 감사 로그에 기록
  → 인시던트 채널 상태 업데이트
```

**역할극 실습:** 강사가 특정 장애 시나리오를 주입하면, 수강생이 5분 행동 지침대로 진단하고 에스컬레이션한다.

---

## Step 6 — 운영 교대 인수인계 7개 지표 체크리스트

> 교대 시각에 GET /admin/dashboard를 호출하고 아래 시트를 채운다.

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

## Step 7 — 지표 간 연관성 분석

아래 상황에서 추가로 확인해야 할 지표를 연결하라.

| 이상 징후 | 추가 확인 항목 | 이유 |
|-----------|---------------|------|
| DLQ 급증 | Consumer Lag (pendingMessages) | DLQ 증가 = Consumer 처리 실패 → Consumer 크래시 동반 가능 |
| VASP 장애 | stuckCount, circuitBreakerStatus | VASP 연결 불가 → mint TX 처리 불가 → PENDING 누적 |
| Consumer Lag 급증 | VASP 응답시간 (responseTimeMs) | Consumer가 VASP 조회 중 지연 → 처리 속도 저하 |
| Reconcile 불일치 | DLQ count | 원인 A(Consumer 누락) → DLQ에서 확인 가능 |
| 배포 후 에러율 증가 | 전체 지표 | 배포 문제는 모든 파이프라인에 영향 |

**실습:** 강사가 제시한 대시보드 스냅샷에서 문제 지표와 연관 지표를 연결하고 원인을 추론한다.

---

## Step 8 — 월간 운영 건강도 리뷰

```bash
# 월간 통계 수집
curl "http://localhost:3000/admin/reconcile/history?limit=30" \
  | jq '[.[] | .mismatch_count] | add'  # 월간 총 불일치

curl "http://localhost:3000/admin/dlq/history?limit=30" \
  | jq 'length'  # 월간 DLQ 적재 건수

curl "http://localhost:3000/admin/deploy/history" \
  | jq '[.[] | select(.type == "ROLLBACK")] | length'  # 롤백 횟수
```

---

## 토론 포인트

1. Promise.all로 7개 섹션을 병렬 수집할 때, 하나가 타임아웃되면 전체 대시보드 응답이 지연된다. 이를 방지하기 위한 전략은? (힌트: Promise.allSettled + 타임아웃 래퍼)

2. 알림 중복 억제 윈도우를 5분으로 설정했다. P1 알림이 5분마다 반복되는 상황에서 담당자가 진행 중임을 팀에게 알리는 메커니즘은 어떻게 설계할 것인가?

3. 교대 인수인계 시 "7개 지표 모두 정상"이 아니면 인계자가 해소 후 인수한다고 규정했다. DLQ 1건이 적재되어 있고 원인이 분석 중이면 어떻게 처리해야 하는가?

4. systemStatus: CRITICAL → HTTP 503 응답. 로드 밸런서가 헬스체크로 이 엔드포인트를 사용한다면 어떤 문제가 발생하는가? 별도 헬스체크 엔드포인트 설계가 필요한 이유는?

---

## 완료 기준

- [ ] `GET /admin/dashboard` — 7개 섹션 단일 응답 확인 (Promise.all 병렬 수집)
- [ ] CRITICAL 상태 주입 → systemStatus: CRITICAL + HTTP 503 확인
- [ ] 모두 OK → systemStatus: OK + HTTP 200 확인
- [ ] 알림 중복 억제: 동일 알림 5분 내 1회만 발송 (Redis TTL 확인)
- [ ] 야간 온콜 첫 5분 행동 지침 역할극 완료
- [ ] 운영 교대 인수인계 시트 작성 완료 (7개 지표 전체 기입)
- [ ] 지표 간 연관성 분석 표 완성
- [ ] 토론 포인트 2개 이상 답변 준비
