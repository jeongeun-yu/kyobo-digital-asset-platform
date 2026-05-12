# Runbook: Reconcile 운영 — 스케줄링·불일치 알림·에스컬레이션 절차

**대상**: 내부망 운영자  
**관련 세션**: S54  
**관련 코드**: `internal/packages/core-banking/src/reconcile/ReconcileService.ts`

---

## 언제 사용하나

- Reconcile 스케줄러 실행 결과에서 불일치 감지 알림 수신
- 수동 Reconcile 트리거 필요 시 (Consumer 장애 복구 후 등)
- 정기 감사 시 원장 정합성 검증

---

## Reconcile 원칙

> **온체인 `balanceOf()`가 항상 진실이다.** 원장이 불일치하면 원장을 온체인 기준으로 보정한다.  
> ⚠️ **역방향 절대 금지** — 원장 값으로 온체인을 수정하는 코드를 절대 실행하지 말 것.

---

## 스케줄링 설계

| 주기 | 대상 | 비고 |
|---|---|---|
| 매시간 | 최근 1시간 발행 건 | 빠른 불일치 감지 |
| 매일 새벽 2시 | 전체 사용자 | 온체인 조회 비용 고려, 새벽 저부하 시간대 |
| 수동 트리거 | 특정 userId 또는 전체 | 장애 복구 후 사용 |

---

## Reconcile 수동 실행

```bash
# 전체 Reconcile 트리거
POST /admin/reconcile

# 특정 사용자 Reconcile
POST /admin/reconcile
Body: { "userId": "user-001" }

# 최근 실행 이력 조회
GET /admin/reconcile/history
```

---

## 불일치 유형별 원인 분석

| 불일치 유형 | 예상 원인 | 대응 |
|---|---|---|
| 원장 > 온체인 | Consumer 장애로 소각 이벤트 미처리 | Consumer 복구 후 재처리 확인 |
| 원장 < 온체인 | Consumer 장애로 발행 이벤트 미처리 | Consumer 복구 후 재처리 확인 |
| 원장 > 온체인 (Reorg) | Reorg 후 원장 미업데이트 | REORGED 전이 후 Finalized 재확인 |
| 수동 DB 조작 흔적 | 미승인 DB 직접 수정 | 즉시 보안팀 보고, 감사 로그 확인 |

---

## 불일치 알림 기준 및 에스컬레이션

| 불일치 건수 | 알림 | 조치 |
|---|---|---|
| 1~9건 | Slack #ops-alerts (P2) | 담당자 원인 분석 후 보정 |
| 10건 이상 | Slack + SMS (P1) 긴급 에스컬레이션 | L2(팀 리드) 즉시 개입 |
| 수동 DB 조작 의심 | 보안팀 즉시 통보 | 접근 로그 분석 |

---

## 보정 절차

Reconcile이 자동으로 보정 레코드를 삽입하지만, **원인 파악 전 자동 보정 결과를 운영에 반영하면 안 됨**.

```bash
# 보정 전 원인 확인
SELECT * FROM processed_events
WHERE user_id = 'user-001'
ORDER BY created_at DESC LIMIT 20;

# 온체인 잔액 직접 확인
# internal/packages/core-banking/src/reconcile/ReconcileService.ts → reconcile(userId) 참조
```

보정 후:
- [ ] 보정 레코드가 `audit_log`에 `LEDGER_RECONCILE` 액션으로 기록됐는가
- [ ] 동일 불일치가 재발하지 않는가 (2시간 후 재확인)

---

## 관련 런북

- [runbook-consumer.md](runbook-consumer.md) — Consumer 장애로 인한 불일치
- [runbook-audit-log.md](runbook-audit-log.md) — 감사 로그 무결성 연계
