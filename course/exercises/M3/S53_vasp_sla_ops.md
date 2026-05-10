# S53 운영 실습 — VASP SLA 운영 · 월렛원 장애 에스컬레이션과 TX Stuck 모니터링

강의 노트: `M3_S53_vasp_sla_ops.md`
소요 시간: 25분

---

## 목표

- TX Stuck 모니터링 엔드포인트로 현재 장애 상태를 빠르게 파악한다
- VASP 헬스체크 결과를 기반으로 에스컬레이션 레벨을 판정한다
- L1~L4 에스컬레이션 절차를 시나리오별로 직접 수행한다
- SLA 위반 기록을 남기는 방법을 이해한다

---

## 사전 조건

`VASPMonitorService`가 `/admin/vasp/stuck`, `/admin/vasp/health`에 연결되어 있어야 한다.

---

## Step 1 — TX Stuck 모니터링 (10분)

### 1-1. 기본 조회 (30분 임계값)

```bash
# 전체 조회 (기본 30분 임계값)
curl http://localhost:3000/admin/vasp/stuck
```

예상 응답 (정상):

```json
{
  "count": 0,
  "items": []
}
```

예상 응답 (Stuck 발생 시):

```json
{
  "count": 3,
  "items": [
    {
      "id": "abc-123",
      "requestId": "req-xyz",
      "txHash": "0xabc...",
      "status": "PENDING",
      "pendingMinutes": 47.3,
      "userId": "user-001",
      "tokenId": "1001",
      "amount": "1"
    }
  ]
}
```

### 1-2. 임계값 조정

```bash
# 15분 이상 Stuck TX 조회
curl "http://localhost:3000/admin/vasp/stuck?threshold=15"

# 60분 이상만 조회 (더 심각한 건만)
curl "http://localhost:3000/admin/vasp/stuck?threshold=60"
```

### 1-3. Stuck 건수별 심각도 판정

조회 결과에서 아래 기준으로 에스컬레이션 레벨을 판정한다:

```
count = 0       → 정상 (L1 자동 대응 완료)
count = 1~3     → VASP 일시 지연 또는 개별 TX 문제 (L1 관찰)
count = 4~9     → 5분 대기 후 L2 전환 검토
count = 10~29   → P2 — 담당자 개입 필요 (L2)
count >= 30     → P1 — 즉시 에스컬레이션 (L3 이상)
```

완료 기준:
```
[ ] GET /admin/vasp/stuck — count + items 포함 응답 확인
[ ] threshold 파라미터 동작 확인 (15분, 60분)
[ ] Stuck TX 중 SUBMITTED 건수와 PENDING 건수 구분 확인
```

---

## Step 2 — VASP 헬스체크 (8분)

```bash
# VASP 가용성 + 응답시간 + CB 상태 통합 조회
curl http://localhost:3000/admin/vasp/health
```

정상 응답 (HTTP 200):

```json
{
  "available": true,
  "responseTimeMs": 234,
  "checkedAt": "2026-05-04T01:30:00.000Z",
  "stuckCount": 0,
  "circuitBreakerStatus": "CLOSED"
}
```

장애 시 응답 (HTTP 503):

```json
{
  "available": false,
  "responseTimeMs": null,
  "checkedAt": "2026-05-04T01:30:00.000Z",
  "stuckCount": 14,
  "circuitBreakerStatus": "OPEN"
}
```

### 헬스체크 결과 해석

| 필드 | 정상 | 이상 | 조치 |
|------|------|------|------|
| `available` | true | false | L2 즉시 이동, VASP 연결 확인 |
| `responseTimeMs` | < SLA p99 | > SLA p99 × 2 | L2 이동, VASP 지연 원인 확인 |
| `stuckCount` | 0 | 10+ | L2, 30+ 이면 L3 |
| `circuitBreakerStatus` | CLOSED | OPEN | 월렛원 장애 가능성 — L3 검토 |

VASP 연결 실패 확인:

```bash
# VASP 서버를 일시 중단했을 때
curl http://localhost:3000/admin/vasp/health
# → HTTP 503 + available: false 확인
```

완료 기준:
```
[ ] GET /admin/vasp/health — available, responseTimeMs, stuckCount, circuitBreakerStatus 포함 확인
[ ] VASP 연결 실패 시 HTTP 503 + available: false 확인
[ ] circuitBreakerStatus: OPEN 시 L3 에스컬레이션 검토 트리거 확인
```

---

## Step 3 — 에스컬레이션 레벨 판정 실습 (7분)

아래 3가지 시나리오에 대해 에스컬레이션 레벨을 판정하고 조치를 수행한다.

### 시나리오 A: Stuck 3건, CB CLOSED, 응답시간 정상

```bash
curl http://localhost:3000/admin/vasp/health
# → available: true, responseTimeMs: 400, stuckCount: 3, circuitBreakerStatus: CLOSED
```

판정: **L1** — RetryHandler 자동 대응 중, 5분 관찰

조치:
```bash
# 5분 후 재확인
curl http://localhost:3000/admin/vasp/stuck
# → count 감소 추세이면 L1 유지
```

---

### 시나리오 B: Stuck 15건, CB OPEN, 응답시간 없음

```bash
curl http://localhost:3000/admin/vasp/health
# → available: false, responseTimeMs: null, stuckCount: 15, circuitBreakerStatus: OPEN
```

판정: **L2 → L3** — 담당자 개입 + 월렛원 기술지원 접수 검토

조치:
```bash
# 1. Stuck TX 상세 확인
curl "http://localhost:3000/admin/vasp/stuck?threshold=30"

# 2. Stuck TX 중 txHash 있는 건 vs 없는 건 분류
#    txHash 있음 → 전송은 됐으나 채굴 대기 (mempool 상태)
#    txHash 없음 → 전송 자체 실패 (VASP에 도달 못 함)

# 3. 월렛원 상태 페이지 확인 (예: status.walletone.kr)

# 4. 30분 후에도 미해소 → L3 (월렛원 장애 티켓 접수)
```

워크시트 채우기:
```
[에스컬레이션 판정]
  available              : false
  responseTimeMs         : null
  stuckCount             : 15
  circuitBreakerStatus   : OPEN

  현재 레벨: L2
  L2 조치:
    □ 월렛원 상태 페이지 확인
    □ 5분 후 Stuck 건수 재확인
    □ 감소하지 않으면 → L3 티켓 접수
```

---

### 시나리오 C: Stuck 35건, CB OPEN, 2시간 지속

```bash
# 2시간 전 장애 감지, 현재도 미해소
curl http://localhost:3000/admin/vasp/health
# → available: false, stuckCount: 35, circuitBreakerStatus: OPEN
```

판정: **L4** — 경영진 보고 + 대체 VASP 전환 검토

조치:
```bash
# 1. 영향 건수 집계
curl "http://localhost:3000/admin/vasp/stuck?threshold=0"
# → 전체 PENDING/SUBMITTED 건수 파악

# 2. SLA 위반 기록 시작 (자동 또는 수동)
curl -X POST http://localhost:3000/admin/vasp/incidents \
  -H "Content-Type: application/json" \
  -d '{"detectedBy": "kim@kyobo.com"}'

# 3. 에스컬레이션 기록
curl -X POST http://localhost:3000/admin/vasp/incidents/<id>/escalate \
  -H "Content-Type: application/json" \
  -d '{
    "toLevel": "L4",
    "operator": "kim@kyobo.com",
    "note": "2시간 미해소, 월렛원 복구 예상 시간 미제시. 경영진 보고 + 대체 VASP 검토",
    "walletoneTicketId": "WO-2026-0504-001"
  }'
```

완료 기준:
```
[ ] 시나리오 A → L1 판정 및 5분 관찰 절차 수행
[ ] 시나리오 B → L2 판정 및 조치 명령 실행
[ ] 시나리오 C → L4 판정 및 인시던트 생성 API 호출
[ ] Stuck 건수 임계값(10건=P2, 30건=P1)별 알림 발송 확인
```

---

## Step 4 — SLA 위반 기록 및 리포트 (추가)

```bash
# SLA 위반 이력 조회 (월별)
curl "http://localhost:3000/admin/vasp/sla-report?from=2026-05-01&to=2026-05-31"
```

예상 응답:

```json
{
  "period": { "from": "2026-05-01", "to": "2026-05-31" },
  "availabilityPct": "99.850",
  "avgResponseMs": 312,
  "p99ResponseMs": 2840,
  "downtimeChecks": 4,
  "slaBreached": true
}
```

`slaBreached: true`이면 → 월렛원에 페널티 청구 프로세스 시작.

---

## 복구 후 확인 절차

장애가 해소됐다고 월렛원에서 통보받으면:

```bash
# 1. VASP 정상 복구 확인
curl http://localhost:3000/admin/vasp/health
# → available: true, circuitBreakerStatus: CLOSED 확인

# 2. Stuck TX 건수 0으로 수렴 확인
curl http://localhost:3000/admin/vasp/stuck
# → count: 0

# 3. pollStaleRequests가 Stuck TX를 자동 처리했는지 확인
#    (로그 또는 mint_requests 테이블 상태 변화 확인)

# 4. 인시던트 종료
curl -X POST http://localhost:3000/admin/vasp/incidents/<id>/resolve \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "kim@kyobo.com",
    "note": "월렛원 정상 복구 확인. Stuck TX 35건 pollStaleRequests 자동 처리 완료."
  }'
```

---

## 토론 포인트

1. SLA p99 응답시간이 5초인데 우리 `retryConfig.timeoutMs`가 10초라면 적절한가? 더 적절한 값은?
2. Circuit Breaker가 OPEN 상태인데 실제 월렛원은 정상인 경우, 어떻게 확인하고 어떻게 해소하는가?
3. Stuck TX 중 `txHash`가 없는 건과 있는 건의 복구 방법은 어떻게 다른가?
4. L4 단계에서 "대체 VASP 전환"을 결정했을 때, `IVASPAdapter` 교체 외에 어떤 운영 절차가 필요한가?
5. `pollStaleRequests`가 자동으로 Stuck TX를 처리하는 원리는 무엇인가? (S22 복습)

---

## 운영 체크리스트 — VASP 장애 알림 수신 시

```
□ /admin/vasp/health 조회 → available / responseTimeMs / CB 상태 파악
□ /admin/vasp/stuck 조회 → Stuck 건수·최장 대기 시간 파악

□ L1 — 자동 대응 확인 (5분 대기)
    RetryHandler 재시도 중인지 로그 확인
    5분 내 Stuck 건수 감소 추세 → 관찰 계속

□ L2 — 담당자 개입 (Stuck 5분 이상 지속)
    월렛원 상태 페이지 확인
    responseTimeMs 이상 여부 (/admin/vasp/health)
    CB OPEN이면 → 월렛원 장애 가능성

□ L3 — 월렛원 기술지원 접수 (30분 미해소)
    장애 티켓 접수 + SLA 위반 기록 시작
    CB 수동 리셋 검토 (/admin/vasp/circuitbreaker/reset)

□ L4 — 경영진 보고 (2시간 미해소)
    영향 고객 수 + 미처리 건수 집계
    대체 VASP 전환 법적·계약 검토 시작

□ 복구 후
    Stuck 건수 0 확인
    복구된 TX → pollStaleRequests가 자동 처리하는지 확인
    SLA 위반 기록 → 페널티 청구 여부 검토
```

---

## 에스컬레이션 레벨 판단 카드

```
L1 → L2 전환 기준 (5분 대기 후 판단):
  □ Stuck 건수가 감소하지 않음
  □ responseTimeMs > SLA p99 × 2 이상
  □ circuitBreakerStatus = OPEN
  □ available = false

L2 → L3 전환 기준 (L2 조치 후 30분 경과):
  □ L2 조치 후 30분 경과, 미해소
  □ Stuck 건수 10건 이상
  □ 월렛원 상태 페이지에 장애 공지 없음
  □ SLA RTO 절반 경과

L3 → L4 전환 기준 (L3 접수 후 2시간 경과):
  □ 월렛원 기술지원 접수 후 2시간 경과, 미해소
  □ Stuck 건수 30건 이상
  □ 월렛원 복구 예상 시간 미제시
  □ SLA RTO 초과 확정
```
