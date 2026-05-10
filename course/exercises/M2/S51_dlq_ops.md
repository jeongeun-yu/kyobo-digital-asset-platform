# S51 운영 실습 — DLQ 운영 절차 · 재큐잉 판단 기준과 드랍 정책

강의 노트: `M2_S51_dlq_ops.md`
소요 시간: 30분

---

## 목표

- DLQ 조회 API를 사용해 실제 운영자처럼 메시지 원인을 분석한다
- requeue / drop 판단 기준을 직접 적용한다
- 감사 로그에 드랍 근거가 남는지 확인한다

---

## 사전 조건

`DLQAdminService`, `DLQHandler`, `AuditLogService`가 `/admin` 라우터에 연결되어 있어야 한다.

```bash
# 서버 실행 확인
curl http://localhost:3000/admin/dlq/pending
```

---

## Step 1 — DLQ 현황 조회 (5분)

```bash
# 전체 목록 조회
curl http://localhost:3000/admin/dlq/pending

# 특정 이벤트 타입만 필터
curl "http://localhost:3000/admin/dlq/pending?eventType=NFT_MINTED"
```

예상 결과:

```json
[
  {
    "dlqId": "1714320000000-0",
    "eventType": "NFT_MINTED",
    "reason": "VASP timeout after 30s",
    "failedAt": "2026-05-04T01:23:45.000Z",
    "txHash": "0xabc123..."
  }
]
```

조회 후 아래 항목을 DLQ 메시지 분석 워크시트에 채운다:

```
DLQ ID    : _______________________
이벤트 타입: _______________________
reason    : _______________________
txHash    : ( ) 있음  ( ) 없음
```

완료 기준:
```
[ ] /admin/dlq/pending 응답에 dlqId, eventType, reason, failedAt 포함 확인
[ ] eventType 필터가 동작하는지 확인
```

---

## Step 2 — requeue vs drop 판단 (8분)

Step 1에서 조회한 메시지를 아래 판단 카드에 적용한다.

### REQUEUE 판단 카드

```
다음을 모두 확인하라:

① processed_events에 같은 txHash가 없다           Y / N
② 실패 원인이 해소됐다 (장애 복구 / 코드 배포)    Y / N
③ requeue하면 성공할 것이라는 근거가 있다         Y / N

셋 다 Y → requeue 가능
하나라도 N → drop 검토 또는 원인 해소 후 재판단
```

### DROP 판단 카드

```
다음 중 하나라도 해당하면 drop 가능:

① processed_events에 같은 txHash가 이미 있다      Y / N
② 파싱 불가 메시지 (원본 데이터 자체 손상)        Y / N
③ TTL 초과 — 처리해도 비즈니스 효과 없음          Y / N
④ 테스트/장애주입 데이터가 운영에 유입됨          Y / N

drop 전 필수:
□ 감사 로그에 이유 기록 (API가 자동 처리)
□ 2차 확인자 서명
```

---

## Step 3 — 수동 재큐잉 실행 (8분)

VASP 장애 복구가 확인된 상황을 가정한다. requeue 조건 ①②③ 모두 Y인 경우.

```bash
curl -X POST http://localhost:3000/admin/dlq/requeue \
  -H "Content-Type: application/json" \
  -d '{
    "dlqId": "<Step 1에서 조회한 dlqId>",
    "operator": "kim@kyobo.com",
    "reason": "VASP 장애 복구 확인 후 재처리"
  }'
```

예상 결과:

```json
{
  "newMessageId": "1714320001000-0"
}
```

검증:

```bash
# DLQ 건수가 1 감소했는지 확인
curl http://localhost:3000/admin/dlq/pending

# 감사 로그에 DLQ_REQUEUE 기록 확인 (감사 로그 API 있으면)
curl "http://localhost:3000/admin/audit?action=DLQ_REQUEUE"
```

### 이미 원장에 반영된 txHash → 에러 응답 확인

```bash
# processed_events에 이미 존재하는 txHash를 가진 DLQ 메시지로 requeue 시도
curl -X POST http://localhost:3000/admin/dlq/requeue \
  -H "Content-Type: application/json" \
  -d '{
    "dlqId": "<txHash가 이미 처리된 메시지의 dlqId>",
    "operator": "kim@kyobo.com",
    "reason": "테스트"
  }'
```

예상 에러 응답:

```json
{
  "error": "이미 원장에 반영된 이벤트입니다. requeue 대신 drop을 사용하세요. txHash: 0x..."
}
```

완료 기준:
```
[ ] requeue 후 DLQ 건수 1 감소 확인
[ ] 이미 원장에 반영된 txHash → 에러 응답 확인
[ ] 감사 로그에 operator 필드 포함 확인
```

---

## Step 4 — 드랍 실행 (감사 로그 필수) (9분)

파싱 불가 메시지 또는 processed_events에 이미 존재하는 메시지에 대해 드랍을 실행한다.

```bash
curl -X DELETE http://localhost:3000/admin/dlq/drop \
  -H "Content-Type: application/json" \
  -d '{
    "dlqId": "<drop 대상 dlqId>",
    "operator": "kim@kyobo.com",
    "reason": "이미 원장에 반영됨 (processed_events 확인)"
  }'
```

예상 결과: HTTP 200, 빈 응답 또는 `{ "ok": true }`

드랍 후 감사 로그 확인:

```bash
# 드랍 근거(원본 페이로드 포함)가 감사 로그에 남아있는지 확인
curl "http://localhost:3000/admin/audit?action=DLQ_DROP"
```

감사 로그에 아래 항목이 포함되어야 한다:

```json
{
  "action": "DLQ_DROP",
  "resourceId": "<dlqId>",
  "operator": "kim@kyobo.com",
  "afterState": {
    "reason": "이미 원장에 반영됨 (processed_events 확인)",
    "originalEvent": { ... },
    "originalReason": "VASP timeout after 30s",
    "failedAt": "2026-05-04T01:23:45.000Z"
  }
}
```

완료 기준:
```
[ ] drop 후 DLQ 건수 1 감소 확인
[ ] 감사 로그에 원본 페이로드(originalEvent) 기록 확인
[ ] 감사 로그에 drop 이유(reason) 기록 확인
```

---

## Step 5 — requeue 후 사후 확인 (5분 대기)

Step 3에서 requeue한 메시지가 Consumer에 의해 정상 처리됐는지 확인한다.

```bash
# 5분 후 DLQ 재조회 — 동일 메시지가 재진입하면 원인 파악 불충분
curl http://localhost:3000/admin/dlq/pending

# Consumer Lag 확인 (S52 ConsumerMonitorService가 있으면)
curl http://localhost:3000/admin/queue/stats
```

판정:
```
DLQ 재진입 없음      → Consumer가 정상 처리 ✅
동일 메시지 DLQ 재진입 → 원인 파악 불충분, 에스컬레이션 ⚠️
```

---

## 토론 포인트

1. `_reason`에 "timeout"이 있으면 무조건 requeue해도 되는가? 어떤 추가 조건이 필요한가?
2. drop이 "되돌릴 수 없는" 이유는 무엇인가? 감사 로그가 왜 필수인가?
3. requeue 전 원인 해소 확인 없이 requeue했을 때 발생하는 최악의 시나리오는?
4. DLQ 20건 이상 적재 시 개별 requeue/drop 대신 어떤 절차를 취해야 하는가?

---

## 운영 체크리스트 — DLQ 알림 수신 시

```
□ /admin/dlq/pending 조회 → 건수·이벤트 타입·원인 파악
□ _reason 분석
    ├── timeout/connection → 외부 장애 여부 확인 (/admin/vasp/health)
    ├── parse error → 발신 시스템 포맷 오류
    └── business rule → 코드 버그 또는 데이터 이상
□ txHash 있으면 → processed_events 조회 → 이미 처리됐으면 drop
□ 원인 미해소 → requeue 금지. 원인 해소 후 requeue
□ drop 시 반드시 감사 로그에 이유 기록 (2인 확인 권장)
□ requeue 후 Consumer 처리 결과 5분 내 확인
    ├── 처리 완료 → 정상 ✅
    └── 또 DLQ → 즉시 에스컬레이션 (원인 파악 불충분)
```
