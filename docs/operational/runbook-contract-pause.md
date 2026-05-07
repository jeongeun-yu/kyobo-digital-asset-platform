# Runbook: 컨트랙트 긴급 Pause/Unpause — 보안 사고 즉각 대응 절차

**대상**: 운영팀 리드, 컨트랙트 담당 개발자  
**관련 세션**: S45  
**관련 코드**: `internal/apps/issuer-service/AdminController.ts`, `blockchain/src/`

---

## ⚠️ Pause 실행 전 인지 사항

- Pause 상태에서는 **신규 발행·소각·전송 전면 중단**
- 이미 진행 중인 TX는 체인에서 완료될 수 있음 (Pause는 신규 TX 차단)
- **Pause는 신속하게, Unpause는 신중하게**

---

## Pause가 필요한 상황

| 상황 | 판단 기준 |
|---|---|
| 취약점 발견 | Slither HIGH 또는 외부 제보로 악용 가능한 취약점 확인 |
| 비정상 대량 발행 | 단시간 내 예상치 못한 대량 민팅 이벤트 |
| 키 탈취 의심 | 서명자 키 분실·탈취 의심 신고 |
| VASP 보안 사고 | 월렛원 측 보안 사고 통보 수신 |
| 컨트랙트 업그레이드 준비 | 업그레이드 직전 신규 TX 차단 필요 시 |

---

## 긴급 Pause 절차

### Step 1 — 판단

P1 상황 확인 후 즉시 실행:

```bash
# 현재 컨트랙트 상태 확인
GET /admin/contract/status
# { "paused": false, "implementation": "0x...", "owner": "0x..." }
```

### Step 2 — Pause 실행

```bash
POST /admin/contract/pause
```

응답:
```json
{ "paused": true, "txHash": "0x...", "timestamp": "2026-05-08T..." }
```

### Step 3 — Pause 확인

```bash
# Pause 상태 확인
GET /admin/contract/status
# { "paused": true, ... }

# 감사 로그 기록 확인
GET /admin/audit/export?action=CONTRACT_PAUSE
```

### Step 4 — 알림

- Slack P1 채널에 Pause 사유·시각·담당자 기록
- Consumer 처리 중단 여부 확인 ([runbook-consumer.md](runbook-consumer.md))
- 사용자 영향 범위 파악 → 서비스 공지 여부 결정

---

## Unpause 전 체크리스트

**Pause 원인이 해소되었음을 반드시 확인 후 진행.**

### 취약점 패치 완료 확인

- [ ] 패치 코드 리뷰 완료 (최소 2인)
- [ ] Slither HIGH/MEDIUM 0건
- [ ] 테스트넷 검증 완료
- [ ] 컨트랙트 업그레이드가 필요한 경우 → [runbook-contract-upgrade.md](runbook-contract-upgrade.md) 절차 먼저 완료

### 키 탈취 대응 완료 확인 (해당 시)

- [ ] 탈취된 키 즉시 무효화
- [ ] Safe `swapOwner`로 서명자 교체 완료
- [ ] 새 키 안전 보관 확인

### 시스템 정상 확인

- [ ] 헬스체크 정상 (`GET /health`)
- [ ] DLQ 잔량 확인
- [ ] Consumer Lag 정상

---

## Unpause 절차

```bash
# Unpause 실행
POST /admin/contract/unpause

# 상태 확인
GET /admin/contract/status
# { "paused": false, ... }

# 감사 로그 확인
GET /admin/audit/export?action=CONTRACT_UNPAUSE
```

Unpause 후 5분간 모니터링:
- [ ] 발행 정상 재개
- [ ] DLQ 급증 없음
- [ ] 에러율 변화 없음

---

## 에스컬레이션

| 상황 | 조치 |
|---|---|
| Pause 실행 후 원인 불명확 | 즉시 L3 개발팀 긴급 호출 |
| 비정상 대량 발행 지속 | VASP (월렛원) 즉시 연락 + 법무팀 보고 |
| Unpause 후 이상 재발 | 재Pause → L4 경영진 보고 |

---

## 관련 런북

- [runbook-contract-upgrade.md](runbook-contract-upgrade.md) — 취약점 패치 업그레이드 절차
- [runbook-vasp-sla.md](runbook-vasp-sla.md) — VASP 보안 사고 에스컬레이션
- [runbook-audit-log.md](runbook-audit-log.md) — 보안 사고 감사 로그 보존
