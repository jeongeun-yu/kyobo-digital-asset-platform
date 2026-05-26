# S53 운영 실습 — VASP SLA 운영 · 월렛원 장애 에스컬레이션과 TX Stuck 모니터링

강의 노트: `M3_S53_vasp_sla_ops.md`  
소요 시간: 25분

---

## 사전 조건

`VASPMonitorService`가 `/admin/vasp/stuck`, `/admin/vasp/health`에 연결되어 있어야 한다.

---

## Step 1 — TX Stuck 모니터링

```bash
curl http://localhost:3000/admin/vasp/stuck
curl "http://localhost:3000/admin/vasp/stuck?threshold=15"
curl "http://localhost:3000/admin/vasp/stuck?threshold=60"
```

Stuck 건수별 심각도:

```
count = 0       → 정상
count = 1~3     → L1 관찰
count = 4~9     → 5분 대기 후 L2 검토
count = 10~29   → P2 (L2)
count >= 30     → P1 즉시 에스컬레이션 (L3 이상)
```

완료 기준:
```
[ ] GET /admin/vasp/stuck — count + items 확인
[ ] threshold 파라미터 동작 확인 (15분, 60분)
[ ] SUBMITTED 건수와 PENDING 건수 구분 확인
```

---

## Step 2 — VASP 헬스체크

```bash
curl http://localhost:3000/admin/vasp/health
```

| 필드 | 정상 | 이상 | 조치 |
|------|------|------|------|
| `available` | true | false | L2 즉시, VASP 연결 확인 |
| `responseTimeMs` | < SLA p99 | > SLA p99 × 2 | L2, VASP 지연 원인 확인 |
| `stuckCount` | 0 | 10+ | L2, 30+ 이면 L3 |
| `circuitBreakerStatus` | CLOSED | OPEN | 월렛원 장애 가능성 — L3 검토 |

```bash
# VASP 연결 실패 시
curl http://localhost:3000/admin/vasp/health
# → HTTP 503 + available: false 확인
```

완료 기준:
```
[ ] GET /admin/vasp/health — available, responseTimeMs, stuckCount, circuitBreakerStatus 확인
[ ] VASP 연결 실패 시 HTTP 503 + available: false 확인
[ ] circuitBreakerStatus: OPEN → L3 에스컬레이션 검토 트리거 확인
```

---

## Step 3 — 에스컬레이션 레벨 판정

### 시나리오 A: Stuck 3건, CB CLOSED

판정: **L1** — 5분 관찰

```bash
curl http://localhost:3000/admin/vasp/stuck
```

### 시나리오 B: Stuck 15건, CB OPEN

판정: **L2 → L3**

```bash
curl "http://localhost:3000/admin/vasp/stuck?threshold=30"
# txHash 있음 → 채굴 대기 / txHash 없음 → 전송 실패
```

```
[에스컬레이션 판정]
  available            : false
  stuckCount           : 15
  circuitBreakerStatus : OPEN

  현재 레벨: L2
    □ 월렛원 상태 페이지 확인
    □ 5분 후 Stuck 건수 재확인
    □ 감소 없으면 → L3 티켓 접수
```

### 시나리오 C: Stuck 35건, CB OPEN, 2시간 지속

판정: **L4**

```bash
# 1. 영향 건수 집계
curl "http://localhost:3000/admin/vasp/stuck?threshold=0"

# 2. 인시던트 생성
curl -X POST http://localhost:3000/admin/vasp/incidents \
  -H "Content-Type: application/json" \
  -d '{"detectedBy": "kim@kyobo.com"}'

# 3. L4 에스컬레이션 기록
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
```

---

## Step 4 — SLA 위반 리포트

```bash
curl "http://localhost:3000/admin/vasp/sla-report?from=2026-05-01&to=2026-05-31"
```

`slaBreached: true` → 월렛원에 페널티 청구 프로세스 시작.

---

## 복구 후 확인

```bash
# 1. VASP 정상 복구 확인
curl http://localhost:3000/admin/vasp/health
# → available: true, circuitBreakerStatus: CLOSED

# 2. Stuck TX 건수 0 수렴 확인
curl http://localhost:3000/admin/vasp/stuck
# → count: 0

# 3. 인시던트 종료
curl -X POST http://localhost:3000/admin/vasp/incidents/<id>/resolve \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "kim@kyobo.com",
    "note": "월렛원 정상 복구 확인. Stuck TX 35건 pollStaleRequests 자동 처리 완료."
  }'
```

---

## 운영 체크리스트 — VASP 장애 알림 수신 시

```
□ /admin/vasp/health → available / responseTimeMs / CB 상태 파악
□ /admin/vasp/stuck  → Stuck 건수·최장 대기 시간 파악

□ L1 — 자동 대응 (5분 대기)
    RetryHandler 재시도 로그 확인
    5분 내 건수 감소 추세 → 관찰 계속

□ L2 — 담당자 개입 (Stuck 5분 이상 지속)
    월렛원 상태 페이지 확인
    CB OPEN이면 → 월렛원 장애 가능성

□ L3 — 월렛원 기술지원 접수 (30분 미해소)
    장애 티켓 접수 + SLA 위반 기록 시작
    CB 수동 리셋 검토 (/admin/vasp/circuitbreaker/reset)

□ L4 — 경영진 보고 (2시간 미해소)
    영향 고객 수 + 미처리 건수 집계
    대체 VASP 전환 법적·계약 검토 시작

□ 복구 후
    Stuck 건수 0 확인
    Stuck TX → pollStaleRequests 자동 처리 확인
    SLA 위반 기록 → 페널티 청구 여부 검토
```

---

## 에스컬레이션 레벨 판단 카드

```
L1 → L2 전환 기준 (5분 대기 후):
  □ Stuck 건수 감소 없음
  □ responseTimeMs > SLA p99 × 2
  □ circuitBreakerStatus = OPEN
  □ available = false

L2 → L3 전환 기준 (L2 조치 후 30분):
  □ Stuck 건수 10건 이상
  □ SLA RTO 절반 경과

L3 → L4 전환 기준 (L3 접수 후 2시간):
  □ Stuck 건수 30건 이상
  □ 월렛원 복구 예상 시간 미제시
  □ SLA RTO 초과 확정
```
