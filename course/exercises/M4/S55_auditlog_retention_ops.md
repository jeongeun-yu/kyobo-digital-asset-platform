# S55 운영 실습 — 감사 로그 보관 운영 · 규제 요건과 Hot/Warm/Cold 아키텍처

강의 노트: `M4_S55_auditlog_retention_ops.md`
소요 시간: 60 분

---

## 목표

- 규제 보관 요건(5년) 기반 Hot/Warm/Cold 계층 설계 이해
- 무결성 검증 엔드포인트 사용법 숙지
- 감독원 조회 요청 수신 시 추출 및 제출 절차 실습
- archiveToWarm() 이관 순서 확인

---

## 사전 준비

```bash
# 개발 서버 기동
npm run dev

# 감사 로그 테이블이 존재하는지 확인
psql $DATABASE_URL -c "\d audit_log"
```

---

## Step 1 — 감사 로그 기록 확인

S26에서 구현한 AuditLogService가 정상 작동 중인지 기본 기록을 삽입해 확인한다.

```bash
# 감사 로그 수동 삽입 (테스트용)
curl -X POST http://localhost:3000/admin/audit/log \
  -H "Content-Type: application/json" \
  -d '{
    "actor": "ops-test@kyobo.com",
    "action": "SYSTEM_CHECK",
    "resourceId": "test-001",
    "afterState": { "note": "S55 운영 실습 시작" }
  }'
```

예상 응답:

```json
{ "id": 1, "checksum": "a3f2c1..." }
```

DB 직접 확인:

```sql
SELECT id, event_time, actor, action, resource_id, checksum
FROM audit_log
ORDER BY id DESC
LIMIT 5;
```

---

## Step 2 — 무결성 검증 엔드포인트

### 전체 체인 검증

```bash
curl http://localhost:3000/admin/audit/integrity-check
```

예상 응답 (정상):

```json
{
  "valid": true,
  "firstInvalidId": null,
  "checkedCount": 1,
  "message": "체인 무결성 정상. 모든 레코드 유효."
}
```

### 기간별 검증

```bash
# 특정 기간 검증 (감독원 제출 전 필수 실행)
curl "http://localhost:3000/admin/audit/integrity-check\
?from=2026-01-01&to=2026-05-10"
```

예상 응답:

```json
{
  "valid": true,
  "firstInvalidId": null,
  "checkedCount": 3542,
  "message": "체인 무결성 정상. 모든 레코드 유효."
}
```

훼손된 경우:

```json
{
  "valid": false,
  "firstInvalidId": 5047,
  "checkedCount": 3542,
  "message": "⚠️ 무결성 훼손 감지! id=5047에서 불일치."
}
```

---

## Step 3 — 강제 훼손 시뮬레이션

개발 환경에서 무결성 훼손이 감지되는지 직접 확인한다.

먼저 레코드를 3개 삽입한다:

```bash
for i in 1 2 3; do
  curl -s -X POST http://localhost:3000/admin/audit/log \
    -H "Content-Type: application/json" \
    -d "{
      \"actor\": \"system\",
      \"action\": \"TEST_ACTION_$i\",
      \"resourceId\": \"test-res-$i\",
      \"afterState\": { \"step\": $i }
    }"
done
```

정상 상태 확인:

```bash
curl http://localhost:3000/admin/audit/integrity-check
# → valid: true
```

중간 레코드 강제 삭제:

```sql
-- id=2 삭제 (훼손 시뮬레이션)
DELETE FROM audit_log WHERE id = 2;
```

훼손 감지 확인:

```bash
curl http://localhost:3000/admin/audit/integrity-check
# → valid: false, firstInvalidId: 3
```

복구 처리:

```
훼손 감지 후 행동:
1. 즉시 감사팀 보고
2. DB 접근 로그에서 삭제 실행 계정 확인
3. S3 백업에서 해당 레코드 복원 (verifyChainIntegrity 통과 확인 후)
4. 복원 행위를 새 audit_log INSERT로 기록
```

---

## Step 4 — 감독원 조회 대응 실습

"2026년 1월 1일~3월 31일 사이 user-001의 모든 감사 로그를 제출하라"는 요청 시뮬레이션.

### Step 4-1: 접수 기록

```bash
curl -X POST http://localhost:3000/admin/audit/log \
  -H "Content-Type: application/json" \
  -d '{
    "actor": "compliance-lee@kyobo.com",
    "action": "REGULATORY_INQUIRY_RECEIVED",
    "resourceId": "FSS-2026-001",
    "afterState": {
      "from": "2026-01-01",
      "to": "2026-03-31",
      "userId": "user-001",
      "requestedBy": "금융감독원",
      "dueDate": "2026-05-17"
    }
  }'
```

### Step 4-2: 추출 전 무결성 검증

```bash
curl "http://localhost:3000/admin/audit/integrity-check\
?from=2026-01-01&to=2026-03-31"
# valid: true 확인 → 추출 진행
# valid: false → 즉시 중단, 감사팀·법무팀 보고
```

### Step 4-3: 추출 실행

```bash
# CSV 형식 추출
curl "http://localhost:3000/admin/audit/export\
?from=2026-01-01T00:00:00Z\
&to=2026-03-31T23:59:59Z\
&userId=user-001\
&format=CSV\
&requestedBy=compliance-lee@kyobo.com\
&inquiryId=FSS-2026-001"
```

예상 응답:

```json
{
  "filePath": "/exports/audit_export_FSS-2026-001_1746268800000.csv",
  "checksum": "8f3c2a7d...",
  "recordCount": 142,
  "message": "추출 완료. checksum을 감독원에 함께 제출하세요."
}
```

### Step 4-4: 추출 완료 기록

```bash
curl -X POST http://localhost:3000/admin/audit/log \
  -H "Content-Type: application/json" \
  -d '{
    "actor": "compliance-lee@kyobo.com",
    "action": "REGULATORY_INQUIRY_EXPORTED",
    "resourceId": "FSS-2026-001",
    "afterState": {
      "recordCount": 142,
      "format": "CSV",
      "checksum": "8f3c2a7d...",
      "exportedAt": "2026-05-10T10:00:00Z",
      "integrityVerified": true
    }
  }'
```

---

## Step 5 — Hot/Warm 이관 실습 (개발 환경)

실제 이관 전 순서를 반드시 확인한다: **무결성 검증 → 이관 → 이관 확인 → 원본 삭제**

```bash
# 2023년 데이터 Warm 이관 (개발 환경 시뮬레이션)
curl -X POST http://localhost:3000/admin/audit/archive \
  -H "Content-Type: application/json" \
  -d '{
    "year": 2023,
    "approvedBy": "ops-admin@kyobo.com"
  }'
```

예상 응답:

```json
{
  "archivedCount": 153204,
  "archivePath": "audit_archive/2023/audit_log_2023.json.gz",
  "integrityVerified": true,
  "message": "2023년 감사 로그 Warm 이관 완료"
}
```

이관 실패 시 (무결성 검증 실패):

```json
{
  "error": "[archiveToWarm] 무결성 검증 실패. year=2023, firstInvalidId=50472. 이관 중단."
}
```

이관 실패 시: 원본 DB는 그대로 유지 → 원인 분석 후 복구 후 재시도

---

## Step 6 — DB Row Security Policy 검증

애플리케이션 계층이 아닌 DB 레벨에서 UPDATE/DELETE가 차단되는지 확인한다.

```sql
-- RLS 활성화 확인
SELECT relname, relrowsecurity
FROM pg_class
WHERE relname = 'audit_log';
-- relrowsecurity = true 여야 정상

-- 정책 목록 확인
SELECT policyname, cmd, roles
FROM pg_policies
WHERE tablename = 'audit_log';
-- audit_log_insert_only (INSERT)
-- audit_log_select (SELECT)
-- UPDATE/DELETE 정책 없어야 정상
```

app_role로 UPDATE 시도 확인:

```sql
SET ROLE app_role;
UPDATE audit_log SET after_state = '{}' WHERE id = 1;
-- ERROR: permission denied (또는 policy violation)
RESET ROLE;
```

---

## Step 7 — 정기 무결성 검증 cron 등록 확인

```typescript
// src/admin/AuditLogAdminService.ts의 cron 확인
import cron from 'node-cron';

// 매일 새벽 1시 KST — 전날 레코드 무결성 검증
cron.schedule('0 1 * * *', async () => {
  await auditLogAdmin.runDailyIntegrityCheck();
}, { timezone: 'Asia/Seoul' });

// 매년 1월 1일 새벽 2시 KST — 2년 전 데이터 Warm 이관
cron.schedule('0 2 1 1 *', async () => {
  await auditLogAdmin.runAnnualArchive('system-auto-archive');
}, { timezone: 'Asia/Seoul' });
```

예상 로그 (새벽 1시 실행):

```
[AuditAdmin] 일일 무결성 검증 시작
[AuditAdmin] 검증 완료: valid=true, checkedCount=842
```

무결성 훼손 감지 시:

```
[AuditAdmin] ⚠️ 무결성 훼손 감지! firstInvalidId=5047
[AuditAdmin] P1 알림 발송: 감사팀, 보안팀, 법무팀
```

---

## Step 8 — S3 백업 전략 확인 (개발 환경 스킵 가능)

운영 환경에서만 실행 가능. 개발에서는 LocalStack 또는 MinIO 사용 권장.

```bash
# 어제 날짜 감사 로그 S3 백업 수동 실행
curl -X POST http://localhost:3000/admin/audit/backup-s3 \
  -H "Content-Type: application/json" \
  -d '{ "date": "2026-05-09" }'
```

S3 버킷 구조 확인:

```
s3://kyobo-audit-cold/
└── 2026/
    └── 05/
        └── 09/
            ├── audit_log_export_2026-05-09.jsonl     (레코드)
            └── audit_log_export_2026-05-09.sha256    (파일 해시)
```

보존 정책:

- 0~90일: S3 Standard (빠른 접근)
- 90일~5년: S3 Glacier IR (저비용 장기 보관)
- 5년 경과: 자동 삭제 (가상자산이용자보호법 §15 요건 충족)
- 삭제 기록 자체는 10년 보관

---

## 토론 포인트

1. **Hot/Warm/Cold 3계층을 쓰는 이유는?**
   - Hot(PostgreSQL): 밀리초 응답, 일일 운영 조회용
   - Warm(S3 Parquet): 연간 감사·감독원 조회용 (수 분 이내)
   - Cold(S3 Glacier): 법적 보관 의무 이행, 거의 접근 안 함
   - 하나의 DB에 5년치 데이터 → 비용 폭증 + 성능 저하

2. **이관 순서가 왜 중요한가? (이관 확인 전 삭제 금지)**
   - 이관 직후 S3 파일이 정상인지 확인하지 않고 삭제하면 데이터 영구 소실
   - 복구 불가능한 규제 위반 → 과태료 + 영업 정지 위험

3. **checksum을 감독원에 함께 제출하는 이유는?**
   - 감독원이 독립적으로 무결성을 검증할 수 있어야 함
   - "우리 시스템에서 확인하면 됩니다"는 인정되지 않음
   - SHA-256 체인 + 파일 해시 = 수학적 증명

---

## 운영 체크리스트 — 감독원 조회 요청 수신 시

```
□ 요청 내용 파악
    ├── 기간: ________  ~  ________
    ├── 대상: userId 또는 전체
    ├── 형식: CSV / JSON
    └── 제출 기한: ________

□ REGULATORY_INQUIRY_RECEIVED 감사 로그 기록 (즉시)
□ AUDIT_EXPORTER 권한 확인 + 2인 승인

□ GET /admin/audit/integrity-check?from=&to= → valid: true 확인
    → false → 즉시 제출 중단, 감사팀·법무팀 보고

□ GET /admin/audit/export → filePath + checksum 확인
□ 추출 범위 밖 데이터 미포함 확인 (userId 필터 정확성)
□ AES-256 암호화 후 제출 + checksum 파일 별도 동봉
□ REGULATORY_INQUIRY_EXPORTED 감사 로그 기록 (제출 후)
```

---

## 보관 이관 체크리스트 (연간 1월 실행)

```
사전 준비:
□ 이관 대상 연도 확인 (2년 이전 데이터)
□ 담당자 2인 지정 (AUDIT_ADMIN 권한)
□ Warm 스토리지 용량 확인

실행 순서 (순서 변경 금지):
□ [1] GET /admin/audit/integrity-check → valid: true 확인
□ [2] archiveToWarm(year) 실행
□ [3] Warm 스토리지 파일 존재 확인 (크기·checksum 일치)
□ [4] 원본 DB 삭제 (archiveToWarm 내부 자동 처리)
□ [5] 이관 완료 감사 로그 기록 확인

⚠️ [1] valid: false → 즉시 중단, 이관 불가
⚠️ [3] 파일 확인 전 삭제 절대 금지
```

---

## 무결성 훼손 대응 카드

```
integrity-check → valid: false 발견 시:

즉각 행동:
□ 제출/이관 중단
□ firstInvalidId 기록: ____________________

원인 분석:
□ id=firstInvalidId 레코드 직접 조회
□ 이전 레코드(id-1) checksum 확인
□ DB 접근 로그에서 해당 기간 DELETE/UPDATE 이력

훼손 유형:
( ) 레코드 DELETE → 해당 id 빠짐
( ) afterState 수정 → checksum 불일치
( ) 가짜 삽입 → prevChecksum 불일치

에스컬레이션:
□ 감사팀 즉시 보고
□ 법무팀 보고
□ 보안팀 보고 (내부 침해 가능성)
□ 경영진 보고 (규제 위험)
```
