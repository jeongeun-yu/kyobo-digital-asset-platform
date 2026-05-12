# Runbook: DLQ 운영 — 재큐잉 판단 기준과 드랍 정책

**대상**: Consumer Group 운영자 (내부망)  
**관련 세션**: S51  
**관련 코드**: `internal/packages/event-engine/`

---

## 언제 사용하나

- DLQ(Dead Letter Queue)에 메시지가 적재됐다는 알림 수신 시
- Consumer 장애 복구 후 DLQ 잔여 메시지 처리 시
- 정기 점검 (일 1회 DLQ 잔량 확인)

---

## DLQ 메시지 조회

```bash
# 전체 DLQ 목록 조회
GET /admin/queue/dlq

# 원인별 필터
GET /admin/queue/dlq?reason=PARSE_ERROR
GET /admin/queue/dlq?reason=PROCESSING_FAILED
```

Redis CLI 직접 조회:
```bash
redis-cli XRANGE dlq:nft-events - + COUNT 50
```

---

## 판단 기준 — 재큐잉 vs 드랍

| 조건 | 판단 | 이유 |
|---|---|---|
| 파싱 불가 메시지 (JSON 깨짐) | **드랍** | 재처리해도 동일 실패 |
| 이미 원장에 반영된 이벤트 | **드랍** | 멱등성 체크에서 스킵됨 — 재큐잉 불필요 |
| TTL 초과 이벤트 (72시간+) | **드랍** | Finalized 블록 범위 초과 |
| VASP 일시 장애 중 실패 | **재큐잉** | VASP 복구 후 정상 처리 가능 |
| DB 일시 장애 중 실패 | **재큐잉** | 멱등성 보장되므로 안전 |
| 원인 불명 (첫 발생) | **재큐잉 1회** | 1회 재처리 후 재실패 시 드랍 전환 |

> ⚠️ **무조건 재큐잉 금지** — 원인 파악 없는 일괄 재큐잉은 Consumer 폭주로 이어질 수 있음.

---

## 재큐잉 절차

```bash
# 특정 메시지 재큐잉
POST /admin/queue/dlq/requeueue
Body: { "messageId": "1718000000000-0" }

# Redis CLI 직접 재적재
redis-cli XADD nft-events:stream '*' \
  eventType NFTIssued \
  txHash 0xabc... \
  logIndex 0
```

재큐잉 전 확인:
- [ ] VASP / DB 장애가 해소됐는가
- [ ] 원장에 이미 반영된 이벤트가 아닌가 (`processed_events` 테이블 조회)
- [ ] 동일 메시지가 이미 재큐잉 이력이 있는가

---

## 드랍 절차

```bash
# 특정 메시지 드랍 (감사 로그 자동 기록)
DELETE /admin/queue/dlq/:messageId
Body: { "reason": "ALREADY_PROCESSED" }
```

> 드랍 시 감사 로그(`audit_log`)에 `DLQ_DROP` 액션으로 자동 기록됨. 드랍 사유 필수 입력.

---

## 알림 설계

| 조건 | 알림 수준 | 채널 |
|---|---|---|
| DLQ 1건 적재 | P2 | Slack #ops-alerts |
| DLQ 10건+ 적재 | P1 | Slack + 담당자 SMS |
| 동일 이벤트 3회 연속 DLQ 재적재 | P1 | 에스컬레이션 |

---

## 에스컬레이션

1. DLQ 적재 → 원인 분석 → 재큐잉 또는 드랍 판단
2. 원인 불명이거나 10건 이상이면 → L2(팀 리드) 알림
3. VASP 연동 오류로 인한 대량 DLQ → [runbook-vasp-sla.md](runbook-vasp-sla.md) 참조
