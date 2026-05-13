# Runbook: 벌크 발행 부분 실패 재처리 — 대량 이벤트 배포 실패 건 복구

**대상**: 운영팀, 이벤트 담당자  
**관련 세션**: S33–S34  
**관련 코드**: `internal/apps/issuer-service/src/services/BulkIssueService.ts`

---

## 벌크 발행 구조

- 500건/배치 청크 처리
- **부분 실패 허용 정책**: 배치 내 일부 실패해도 나머지는 계속 진행
- 실패 건은 개별 에러와 함께 결과에 포함됨

---

## 벌크 발행 결과 확인

```bash
# 벌크 발행 작업 상태 조회
GET /admin/bulk-issue/:jobId

# 응답 예시
{
  "jobId": "bulk-2026-05-08-001",
  "total": 1500,
  "succeeded": 1487,
  "failed": 13,
  "status": "COMPLETED_WITH_ERRORS",
  "failedItems": [
    { "userId": "user-042", "reason": "WalletNotFound" },
    { "userId": "user-107", "reason": "WalletNotFound" },
    { "userId": "user-315", "reason": "InsufficientGas" }
  ]
}
```

---

## 실패 유형별 원인 분석

| 에러 | 원인 | 조치 |
|---|---|---|
| `WalletNotFound` | 해당 사용자 지갑 미등록 | 지갑 등록 후 재처리 |
| `InsufficientGas` | 핫월렛 잔액 부족 | VASP 가스 충전 요청 후 재처리 |
| `ContractReverted` | 컨트랙트 조건 불충족 (예: 중복 tokenId) | 원인 데이터 수정 후 재처리 |
| `VaspTimeout` | VASP 응답 초과 | 자동 재처리 대상 (Circuit Breaker 해소 후) |
| `DuplicateToken` | 동일 사용자 중복 발행 시도 | 데이터 검증 후 스킵 처리 |

---

## WalletNotFound 재처리 절차 (가장 빈번)

### Step 1 — 미등록 사용자 목록 추출

```bash
# 실패 건 CSV 추출
GET /admin/bulk-issue/:jobId/failed?reason=WalletNotFound&format=csv
```

### Step 2 — 지갑 등록 확인

```bash
# 개별 사용자 지갑 등록 상태 확인
GET /admin/users/:userId/wallet
```

미등록 사용자는 지갑 등록 프로세스 안내 (고객 서비스팀 협조).

### Step 3 — 지갑 등록 완료 후 재처리

```bash
# 실패 건만 선택 재처리
POST /admin/bulk-issue/:jobId/retry
Body: { "failureReason": "WalletNotFound" }
# 또는 특정 사용자 지정
Body: { "userIds": ["user-042", "user-107"] }
```

---

## 전체 재처리 절차

```bash
# 모든 실패 건 일괄 재처리
POST /admin/bulk-issue/:jobId/retry-all

# 재처리 결과 확인
GET /admin/bulk-issue/:jobId/retry-status
```

---

## 판단 기준

| 실패 비율 | 조치 |
|---|---|
| 1% 미만 | 개별 실패 건 수동 재처리 |
| 1~5% | 원인 분석 후 일괄 재처리 |
| 5% 초과 | 작업 중단 → 원인 조사 → L2 팀 리드 보고 |
| 10% 초과 | 전체 작업 취소 → 데이터 정합성 점검 후 재실행 |

---

## 재처리 후 확인

```bash
# 최종 성공 여부 확인
GET /admin/bulk-issue/:jobId

# 발행된 토큰 확인 (샘플링)
GET /admin/issuance?jobId=bulk-2026-05-08-001&status=CONFIRMED
```

- [ ] 재처리 대상 전원 CONFIRMED 상태
- [ ] DLQ 잔량 없음
- [ ] Reconcile 불일치 없음 ([runbook-reconcile.md](runbook-reconcile.md) 참조)

---

## 에스컬레이션

| 상황 | 조치 |
|---|---|
| WalletNotFound 50건+ | 고객 서비스팀 통보 + 일괄 지갑 등록 지원 |
| InsufficientGas 지속 | VASP (월렛원) 가스 충전 요청 — SLA 내 처리 ([runbook-vasp-sla.md](runbook-vasp-sla.md)) |
| ContractReverted 다수 | 데이터 팀 긴급 검토 — tokenId 중복 여부 확인 |
| 재처리 후에도 실패 지속 | L3 개발팀 호출 |

---

## 관련 런북

- [runbook-reconcile.md](runbook-reconcile.md) — 발행 후 원장 불일치 확인
- [runbook-vasp-sla.md](runbook-vasp-sla.md) — VASP 응답 지연·SLA
- [runbook-dlq.md](runbook-dlq.md) — 벌크 발행 실패 건 DLQ 적재 시
