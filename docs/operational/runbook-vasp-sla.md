# Runbook: VASP SLA 운영 — 월렛원 장애 에스컬레이션과 TX Stuck 모니터링

**대상**: DMZ 운영자, VASP 담당자  
**관련 세션**: S53  
**관련 코드**: `dmz/packages/vasp/src/external/ExternalVASPAdapter.ts`

---

## 언제 사용하나

- TX PENDING 30분 초과 알림 수신
- VASP API 응답 오류(5xx, 타임아웃) 반복 발생
- Circuit Breaker OPEN 상태 전환 알림
- VASP 헬스체크 이상 감지

---

## TX Stuck 모니터링

```bash
# 30분 초과 PENDING TX 목록
GET /admin/vasp/stuck

# VASP 헬스체크 (응답시간·가용성)
GET /admin/vasp/health
```

**정상 기준**:
- VASP API 응답시간 p99 < 3초
- 가용성 > 99.9% (월간 기준 다운타임 < 43분)
- PENDING 30분 초과 건 = 0

---

## 장애 에스컬레이션 절차

### L1 — 자동 재시도 (코드 처리)

Exponential Backoff: 1s → 2s → 4s → 8s (최대 5회)  
→ 5회 실패 시 TX 상태 `FAILED` 전이 + L2 알림 트리거

### L2 — 담당자 알림

**트리거 조건**:
- VASP API 연속 5회 실패
- Stuck TX 5건 이상
- VASP 헬스체크 2분 이상 비정상

**조치**:
```bash
# Circuit Breaker 상태 확인
GET /admin/vasp/circuit-breaker

# 수동으로 Stuck TX 재시도 트리거
POST /admin/vasp/retry-stuck
Body: { "requestId": "..." }
```

### L3 — 월렛원 기술지원 접수

**트리거 조건**:
- L2 조치 후 30분 이상 미해소
- VASP 전면 장애 (헬스체크 전체 실패)

월렛원 기술지원 연락처: _(계약서 참조)_  
접수 시 포함 정보:
- 발생 시각 및 지속 시간
- 영향받은 TX 건수 및 requestId 목록
- 에러 응답 로그 (최근 10건)

### L4 — 경영진 보고

**트리거 조건**:
- 장애 지속 2시간 이상
- 누적 실패 TX 100건 이상

---

## Circuit Breaker 운영

| 상태 | 의미 | 대응 |
|---|---|---|
| CLOSED | 정상 — 모든 요청 통과 | 없음 |
| OPEN | 장애 — 모든 요청 차단, 즉시 실패 반환 | L2~L3 에스컬레이션 |
| HALF_OPEN | 회복 시도 — 일부 요청 통과하여 상태 확인 | 모니터링 강화 |

```bash
# Circuit Breaker 수동 닫기 (VASP 복구 확인 후)
POST /admin/vasp/circuit-breaker/close
```

> ⚠️ **수동 닫기 전 반드시** VASP 헬스체크 정상 응답 확인 후 진행.

---

## VASP SLA 주요 항목 (월렛원 계약 기준)

| 항목 | 기준값 | 비고 |
|---|---|---|
| 가용성 | 99.9% (월간) | 계획 점검 제외 |
| TX 처리 응답시간 | p99 < 5초 | 서명·브로드캐스트 포함 |
| 장애 복구 목표 (RTO) | 4시간 | 계약서 확인 필요 |
| 데이터 복구 목표 (RPO) | 1시간 | 계약서 확인 필요 |

---

## 관련 런북

- [runbook-dlq.md](runbook-dlq.md) — VASP 장애로 인한 DLQ 적재 처리
- [runbook-consumer.md](runbook-consumer.md) — Consumer 장애 연계
