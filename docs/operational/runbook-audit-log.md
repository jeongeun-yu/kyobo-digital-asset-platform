# Runbook: 감사 로그 규제 대응 — 5년 보관 운영과 감독원 조회 절차

**대상**: 컴플라이언스 담당자, 운영팀  
**관련 세션**: S55  
**관련 코드**: `dmz/packages/core-banking/src/audit/AuditLogService.ts`

---

## 규제 근거

- **전금법(전자금융거래법)** 및 **가상자산이용자보호법**: 거래 기록 5년 보관 의무
- 금융감독원 요청 시 즉시 제출 가능한 상태 유지 필수

---

## 보관 아키텍처 (Hot / Warm / Cold)

| 계층 | 기간 | 저장 방식 | 조회 속도 |
|---|---|---|---|
| Hot | 최근 1년 | 운영 DB 직접 | 즉시 |
| Warm | 1~3년 | 압축 아카이브 (S3 또는 동등) | 수 분 |
| Cold | 3~5년 | 오프라인 스토리지 (테이프 또는 암호화 아카이브) | 수 시간 |

> 보관 계층 이관은 자동 스케줄러로 처리. 수동 이관 절차는 인프라팀 참조.

---

## 감사 로그 무결성 구조

SHA-256 체인 방식:
```
checksum_n = SHA256(prev_checksum + event_time + actor + action + resourceId + afterState)
```

중간 레코드 1개 삭제 또는 수정 시 → 이후 전체 checksum 불일치 → 즉시 감지 가능

```bash
# 무결성 검증 실행
POST /admin/audit/verify

# 검증 결과 예시
{
  "valid": true,
  "checkedCount": 15420,
  "firstMismatchId": null
}
```

---

## 감독원 조회 대응 절차

### Step 1 — 조회 요청 접수

접수 정보 확인:
- [ ] 조회 기간 (from ~ to)
- [ ] 조회 대상 (전체 / 특정 사용자 / 특정 TX)
- [ ] 요청 기관 및 담당자 연락처
- [ ] 제출 기한

### Step 2 — 감사 로그 추출

```bash
# 기간 + 대상 기준 추출 (CSV)
GET /admin/audit/export?from=2025-01-01&to=2025-12-31&format=csv

# 특정 사용자 추출
GET /admin/audit/export?userId=user-001&from=2025-01-01&to=2025-12-31

# JSON 형식 (시스템 간 연동용)
GET /admin/audit/export?from=2025-01-01&to=2025-12-31&format=json
```

### Step 3 — 무결성 검증

```bash
# 추출 범위 checksum 재계산 및 원본 대조
POST /admin/audit/verify-range
Body: { "from": "2025-01-01", "to": "2025-12-31" }

# 검증 통과 시
{ "valid": true, "recordCount": 8420, "rangeChecksum": "abc123..." }
```

> 제출 전 반드시 무결성 검증 통과 확인. 미통과 시 즉시 보안팀 및 법무팀 보고.

### Step 4 — 제출

- 추출 파일 + 무결성 검증 결과를 함께 제출
- 제출 행위 자체를 `audit_log`에 `AUDIT_EXPORT` 액션으로 기록 (자동)
- 제출 사본 보관 (법무팀 지시에 따라)

---

## 보관 정책 체크리스트 (연간 점검)

- [ ] Hot 계층: 최근 1년 데이터 운영 DB에 온전히 존재
- [ ] Warm 계층: 1~3년 데이터 압축 아카이브 무결성 검증 통과
- [ ] Cold 계층: 3~5년 데이터 오프라인 스토리지 접근 가능 확인
- [ ] 5년 초과 데이터: 삭제 여부 법무팀과 사전 확인 후 처리
- [ ] 전체 무결성 검증 `POST /admin/audit/verify` 통과

---

## 관련 런북

- [runbook-reconcile.md](runbook-reconcile.md) — 원장 불일치 시 감사 로그 연계
