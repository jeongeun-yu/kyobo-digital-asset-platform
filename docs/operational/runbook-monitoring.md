# Runbook: 전체 모니터링 대시보드 — Phase 1 운영 통합 뷰

**대상**: 운영팀 전체, 온콜 담당자  
**관련 세션**: S58  
**관련 코드**: `internal/apps/issuer-service/AdminController.ts`

---

## 통합 대시보드

```bash
# Phase 1 전체 지표 단일 조회
GET /admin/dashboard
```

응답 구조:
```json
{
  "issuance": {
    "pending": 3,
    "confirmed": 1520,
    "failed": 2,
    "stuck_30min": 0
  },
  "queue": {
    "lag": 5,
    "dlq_count": 0,
    "processing_rate": 48
  },
  "vasp": {
    "available": true,
    "p99_ms": 850,
    "circuit_breaker": "CLOSED"
  },
  "reconcile": {
    "last_run": "2026-05-08T02:00:00Z",
    "mismatch_count": 0
  },
  "audit": {
    "integrity": "ok",
    "last_verified": "2026-05-08T02:00:00Z"
  }
}
```

---

## 핵심 지표 및 임계값

### P1 — 즉시 대응 (15분 내)

| 지표 | 임계값 | 런북 |
|---|---|---|
| DLQ 급증 | 10건 이상 | [runbook-dlq.md](runbook-dlq.md) |
| VASP 장애 | Circuit Breaker OPEN | [runbook-vasp-sla.md](runbook-vasp-sla.md) |
| Reconcile 불일치 | 10건 이상 | [runbook-reconcile.md](runbook-reconcile.md) |
| 감사 로그 무결성 | integrity ≠ ok | [runbook-audit-log.md](runbook-audit-log.md) |

### P2 — 1시간 내 대응

| 지표 | 임계값 | 런북 |
|---|---|---|
| Consumer Lag | 100건 이상 | [runbook-consumer.md](runbook-consumer.md) |
| TX Stuck | 5건 이상 (30분 초과) | [runbook-vasp-sla.md](runbook-vasp-sla.md) |
| 에러율 | 1% 이상 | [runbook-deploy.md](runbook-deploy.md) |
| 헬스체크 이상 | status ≠ ok | [runbook-deploy.md](runbook-deploy.md) |

### P3 — 일간 리포트 (오전 업무 시작 전)

| 지표 | 확인 내용 |
|---|---|
| 전일 발행 건수 | 정상 범위 여부 |
| VASP 가용성 | SLA 대비 |
| Reconcile 결과 | 불일치 건 없음 |
| DLQ 잔량 | 0 목표 |

---

## 임계값 설정 파일

환경변수 기반 임계값 관리 (`infrastructure/.env.production`):

```env
ALERT_DLQ_CRITICAL=10
ALERT_DLQ_WARNING=1
ALERT_LAG_CRITICAL=100
ALERT_LAG_WARNING=10
ALERT_STUCK_TX_CRITICAL=5
ALERT_STUCK_TX_WARNING=1
ALERT_RECONCILE_CRITICAL=10
ALERT_RECONCILE_WARNING=1
ALERT_ERROR_RATE_CRITICAL=0.01
ALERT_P99_CRITICAL_MS=5000
```

---

## 운영 교대 체크리스트

### 인수 시 확인 (10분)

```bash
GET /admin/dashboard
```

- [ ] 통합 대시보드 전체 지표 정상
- [ ] DLQ 잔량 0
- [ ] Consumer Lag < 10
- [ ] Reconcile 최근 1시간 내 정상 실행
- [ ] 진행 중인 컨트랙트 업그레이드 제안 있는지 확인

### 인계 시 기록

- 인계 시점 대시보드 스냅샷 (화면 캡처 또는 API 응답 저장)
- 진행 중인 이슈 목록
- 처리 중인 DLQ 건이 있으면 상세 내용 전달

---

## 야간 장애 대응 체계

| 단계 | 조건 | 대응자 |
|---|---|---|
| 자동 알림 | 임계값 초과 | Slack 자동 발송 |
| L1 | P2 알림 | 온콜 담당자 (30분 내 확인) |
| L2 | P1 알림 또는 L1 미해소 | 팀 리드 호출 |
| L3 | 2시간 이상 장애 지속 | 개발팀 긴급 호출 |
| L4 | 서비스 전면 장애 | 경영진 보고 |

---

## 관련 런북 전체 목록

| 런북 | 상황 |
|---|---|
| [runbook-dlq.md](runbook-dlq.md) | DLQ 메시지 처리 |
| [runbook-consumer.md](runbook-consumer.md) | Consumer 장애 |
| [runbook-vasp-sla.md](runbook-vasp-sla.md) | VASP 장애·TX Stuck |
| [runbook-reconcile.md](runbook-reconcile.md) | 원장 불일치 |
| [runbook-audit-log.md](runbook-audit-log.md) | 감사 로그·감독원 조회 |
| [runbook-deploy.md](runbook-deploy.md) | 배포·롤백 |
| [runbook-contract-upgrade.md](runbook-contract-upgrade.md) | 컨트랙트 업그레이드 |
| [runbook-monitoring.md](runbook-monitoring.md) | 이 문서 — 통합 모니터링 |
| [runbook-tx-recovery.md](runbook-tx-recovery.md) | TX REORG·TIMEOUT 복구 |
| [runbook-contract-pause.md](runbook-contract-pause.md) | 컨트랙트 긴급 Pause/Unpause |
| [runbook-bulk-issue.md](runbook-bulk-issue.md) | 벌크 발행 부분 실패 재처리 |
