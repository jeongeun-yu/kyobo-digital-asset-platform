# Operational Runbooks

Phase 1 운영 절차서. 교보생명 인수인계 후 운영팀 사용.

> **빠른 진입점**: [runbook-monitoring.md](runbook-monitoring.md) — 통합 대시보드 + 전체 런북 목록

---

## 런북 목록

| 파일 | 주제 | 관련 세션 |
|---|---|---|
| [runbook-dlq.md](runbook-dlq.md) | DLQ 재큐잉 판단 기준·드랍 정책·알림 | S51 |
| [runbook-consumer.md](runbook-consumer.md) | Consumer 장애 유형별 대응 (크래시·Lag·Redis) | S52 |
| [runbook-vasp-sla.md](runbook-vasp-sla.md) | VASP SLA·TX Stuck 모니터링·에스컬레이션 L1~L4 | S53 |
| [runbook-reconcile.md](runbook-reconcile.md) | Reconcile 스케줄링·불일치 원인 분석·보정 절차 | S54 |
| [runbook-audit-log.md](runbook-audit-log.md) | 감사 로그 5년 보관·감독원 조회 대응 절차 | S55 |
| [runbook-deploy.md](runbook-deploy.md) | 배포 체크리스트·롤백 판단 기준·Blue/Green | S56 |
| [runbook-contract-upgrade.md](runbook-contract-upgrade.md) | Gnosis Safe 2-of-3 업그레이드 전체 절차 | S57 |
| [runbook-monitoring.md](runbook-monitoring.md) | 통합 대시보드·지표 임계값·교대 체크리스트 | S58 |
| [runbook-tx-recovery.md](runbook-tx-recovery.md) | TX REORG 복구·TIMEOUT Gas Bump 재전송 | S19–S20 |
| [runbook-contract-pause.md](runbook-contract-pause.md) | 컨트랙트 긴급 Pause/Unpause 절차 | S45 |
| [runbook-bulk-issue.md](runbook-bulk-issue.md) | 벌크 발행 부분 실패 재처리·WalletNotFound 대응 | S33–S34 |

---

## 알림 우선순위 요약

| 수준 | 조건 | 대응 시간 |
|---|---|---|
| P1 | DLQ 10건+, VASP 장애, Reconcile 10건+, 감사 무결성 오류 | 즉시 (15분 내) |
| P2 | Consumer Lag 100건+, TX Stuck 5건+, 에러율 1%+ | 1시간 내 |
| P3 | 일간 통계 리포트 | 오전 업무 시작 전 |
