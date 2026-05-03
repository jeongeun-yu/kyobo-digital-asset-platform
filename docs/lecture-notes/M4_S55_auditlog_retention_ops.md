# M4 S55 — 감사 로그 보관 운영 · 규제 요건과 Hot/Warm/Cold 아키텍처

> 모듈 4 · 세션 55 · 1시간 `운영`
> 전제: S26에서 AuditLogService(SHA-256 체인) 구현 완료
> 스켈레톤: `dmz/packages/ledger/src/admin/AuditLogAdminService.ts`

> ⚠️ **운영 세션** — S26에서 SHA-256 체인 방식으로 감사 로그를 기록하고 무결성을 검증하는 방법을 배웠다. 이번 세션은 **그 감사 로그를 5년간 어떻게 보관하는가**, **감독원 조회 요청이 왔을 때 어떻게 대응하는가**다. 기술보다 규정과 절차가 핵심이다.

---

## 강의 파트 (30분)

### 1. 규제 보관 요건 (10분)

감사 로그는 그냥 오래 보관하면 되는 것이 아니다. 규정마다 요건이 다르고, 요건을 충족하지 못하면 과태료다.

**관련 법령과 보관 기간:**

| 규정 | 조항 | 요건 |
|------|------|------|
| 전자금융감독규정 | §34 | 접근·처리 기록 1년 이상 보존 |
| 가상자산이용자보호법 | §15 | 거래 기록 **5년 보존** |
| ISMS-P | 2.9.4 | 로그 무결성 보호 + 접근 제어 |
| 특정금융정보법(FIU) | §5 | 금융거래 정보 5년 보존 |

**5년 보존이 핵심 기준이다.**

```
2026년 1월 1일에 기록된 감사 로그
  → 2031년 1월 1일까지 보관 의무
  → 2031년 1월 2일부터 삭제 가능 (단, 삭제 기록 별도 보관)
```

**보관 매체 요건:**

```
권장: WORM(Write Once Read Many) 스토리지
  → AWS S3 Object Lock (Compliance Mode)
  → 보관 기간 내 덮어쓰기·삭제 불가 (루트 계정도 불가)

최소 요건: 변경 이력이 추적 가능한 스토리지
  → S26 SHA-256 체인이 이 역할
  → 추가로 백업 사본 별도 보관 권장
```

**접근 제어 — 감사 로그는 별도 권한:**

```
일반 운영자 권한:
  → DB 조회, 알림 수신, API 호출 가능
  → 감사 로그 직접 접근 불가

감사 로그 접근 권한 (별도 역할):
  → AUDIT_READER: 조회만
  → AUDIT_EXPORTER: 추출·제출
  → AUDIT_ADMIN: 이관·삭제 (2인 승인 필요)

이유: 감사 로그를 볼 수 있는 사람이 감사 대상이기도 하면 이해충돌
```

**감독원 조회 요청 시 제출 형식:**

```
요청 형식: CSV 또는 JSON (요청서에 명시)
필수 포함:
  - 해당 기간 감사 로그 전체
  - 각 레코드의 checksum
  - 전체 추출 범위 checksum (무결성 증명)
  - S26 verifyChainIntegrity() 결과

제출 채널: 암호화된 파일 (AES-256) + 비밀번호 별도 전달
```

checksum을 함께 제출하는 이유: 감독원이 독립적으로 무결성을 검증할 수 있어야 한다. "우리 시스템에서 확인하면 됩니다"는 안 된다.

---

### 2. Hot/Warm/Cold 아키텍처 (10분)

5년치 데이터를 PostgreSQL에 전부 넣으면:

```
연간 거래 100만 건 × 5년 = 500만 레코드
레코드당 평균 2KB → 10GB
  → PostgreSQL이 버티긴 하지만 조회 속도 저하
  → 인덱스 크기 급증
  → 비용: 고성능 DB 스토리지 5년치
```

계층형 아키텍처로 비용과 응답시간을 분리:

```
┌─────────────────────────────────────────────────────────────┐
│  Hot/Warm/Cold 계층 설계                                      │
│                                                              │
│  HOT (최근 1년) — PostgreSQL                                 │
│    접근 빈도: 높음 (일일 운영 조회, 인시던트 대응)            │
│    응답시간: 밀리초 단위                                      │
│    비용: 높음 (고성능 DB 스토리지)                            │
│    삭제 정책: 1년 경과 → Warm으로 이관                       │
│                                                              │
│  WARM (1~3년) — S3 Parquet 또는 NAS 압축 아카이브            │
│    접근 빈도: 낮음 (감독원 조회, 연간 감사)                   │
│    응답시간: 수 분 이내                                       │
│    비용: 중간 (오브젝트 스토리지)                             │
│    이관 시: gzip 압축 → S3 업로드 → 원본 DB 삭제             │
│                                                              │
│  COLD (3~5년) — 오프라인 스토리지 또는 S3 Glacier           │
│    접근 빈도: 매우 낮음 (법적 분쟁, 장기 감사)               │
│    응답시간: 수 시간~수 일                                    │
│    비용: 낮음 (장기 보관 전용)                                │
│    이관 시: Warm → Cold 추가 압축 + 오프사이트 백업          │
└─────────────────────────────────────────────────────────────┘
```

**이관 트리거:**

```
연간 이관 (1월 1일 새벽 2시):
  Hot → Warm: 2년 이전 데이터
    예) 2026년 1월 1일 → 2024년 이전 데이터 Warm 이관

  Warm → Cold: 3년 이전 데이터 (3년째 1월 1일에)

만료 삭제 (5년 경과):
  삭제 전 무결성 검증 필수 (verifyChainIntegrity 실행)
  검증 실패 시 삭제 중단 → 담당자 보고
  삭제 후 삭제 기록 별도 보관 (언제, 어떤 기간, 누가 승인)
  삭제 기록 자체는 10년 보관 (삭제 행위 자체도 추적 가능해야)
```

**이관 순서 — 반드시 지켜야 함:**

```
1. 이관 대상 데이터 식별
2. verifyChainIntegrity(대상 기간) → 무결성 확인
   ↳ 실패 시 즉시 중단, 감사팀 보고
3. 대상 데이터 압축 + Warm/Cold 스토리지 이관
4. 이관 완료 확인 (파일 크기, checksum 일치)
5. 원본 DB 삭제
6. 이관 완료 감사 로그 기록 (삭제 행위도 기록)
```

원본을 먼저 삭제하고 이관하면 데이터 손실 위험. 반드시 이관 확인 후 삭제.

---

### 3. 감독원 조회 대응 절차 (10분)

금융감독원에서 "2025년 3월 1일~3월 31일 사이 userId=user-001의 모든 거래 감사 로그를 제출하라"는 요청이 왔다.

**대응 절차:**

```
[Step 1] 요청 수신 확인 (담당자 + 준법감시팀)
  - 요청 기간: ____~ ____
  - 요청 대상: userId 또는 전체
  - 요청 형식: CSV / JSON / PDF
  - 제출 기한: ____
  → 이 접수 행위 자체도 감사 로그에 기록

[Step 2] 접근 권한 확인
  - AUDIT_EXPORTER 역할 보유자만 추출 가능
  - 2인 승인 필요 (AUDIT_ADMIN)

[Step 3] 추출 실행
  - GET /admin/audit/export?from=2025-03-01&to=2025-03-31&userId=user-001
  - 응답: CSV + JSON
  - 추출 범위 checksum 자동 계산

[Step 4] 무결성 검증
  - 추출된 레코드 전체에 verifyChainIntegrity() 적용
  - 모든 레코드 유효 → 제출 가능
  - 불일치 발견 → 제출 중단, 감사팀 보고

[Step 5] 제출
  - AES-256 암호화 후 전달
  - checksum 파일 별도 동봉
  - 제출 행위 감사 로그 기록

⚠️ 추출 범위 밖 데이터 절대 포함 금지
   → 과도한 정보 제공은 개인정보 침해
   → userId 필터 정확히 적용 확인
```

**이 과정 자체도 감사 로그에 기록:**

```typescript
// 감독원 조회 대응 시작 기록
await auditLog.log({
  actor: 'compliance-lee@kyobo.com',
  action: 'REGULATORY_INQUIRY_RECEIVED',
  resourceId: 'FSS-2026-001',   // 요청 번호
  afterState: {
    from: '2025-03-01',
    to: '2025-03-31',
    userId: 'user-001',
    requestedBy: '금융감독원',
    dueDate: '2026-05-10',
  },
});

// 추출 완료 기록
await auditLog.log({
  actor: 'compliance-lee@kyobo.com',
  action: 'REGULATORY_INQUIRY_EXPORTED',
  resourceId: 'FSS-2026-001',
  afterState: {
    recordCount: 142,
    exportedAt: new Date().toISOString(),
    checksum: '8f3c2a...',
    format: 'CSV',
  },
});
```

---

## 실습 파트 (25분)

### 실습 1 — 감사 로그 추출 API 구현 (10분)

```typescript
// dmz/packages/ledger/src/admin/AuditLogAdminService.ts

export class AuditLogAdminService {
  constructor(
    private readonly db: Database,
    private readonly auditLog: AuditLogService,  // S26 구현체
    private readonly storage: StorageAdapter,    // S3 또는 로컬 스토리지
  ) {}

  async exportLogs(params: {
    from: Date;
    to: Date;
    userId?: string;
    format: 'CSV' | 'JSON';
    requestedBy: string;
    inquiryId: string;
  }): Promise<{ filePath: string; checksum: string; recordCount: number }> {

    // 1. 추출 시작 감사 로그 기록
    await this.auditLog.log({
      actor: params.requestedBy,
      action: 'AUDIT_EXPORT_STARTED',
      resourceId: params.inquiryId,
      afterState: {
        from: params.from.toISOString(),
        to: params.to.toISOString(),
        userId: params.userId ?? 'ALL',
        format: params.format,
      },
    });

    // 2. 대상 레코드 조회
    const query = `
      SELECT id, event_time, actor, action, resource_type, resource_id,
             before_state, after_state, ip_address, session_id, checksum
      FROM audit_log
      WHERE event_time >= $1 AND event_time <= $2
      ${params.userId ? `AND resource_id = '${params.userId}'` : ''}
      ORDER BY id ASC
    `;
    const rows = await this.db.query(query, [params.from, params.to]);
    const records = rows.rows;

    // 3. 추출 범위 체인 무결성 검증
    const integrityResult = await this.auditLog.verifyChainIntegrityInRange(
      params.from,
      params.to,
    );
    if (!integrityResult.valid) {
      throw new Error(
        `체인 무결성 검증 실패. firstInvalidId=${integrityResult.firstInvalidId}. 제출 중단.`,
      );
    }

    // 4. 형식 변환
    let content: string;
    if (params.format === 'CSV') {
      const header = 'id,event_time,actor,action,resource_type,resource_id,checksum\n';
      const body = records.map(r =>
        `${r.id},${r.event_time},${r.actor},${r.action},${r.resource_type},${r.resource_id},${r.checksum}`
      ).join('\n');
      content = header + body;
    } else {
      content = JSON.stringify(records, null, 2);
    }

    // 5. 추출 범위 전체 checksum 계산
    const extractChecksum = createHash('sha256')
      .update(content, 'utf8')
      .digest('hex');

    // 6. 파일 저장
    const fileName = `audit_export_${params.inquiryId}_${Date.now()}.${params.format.toLowerCase()}`;
    const filePath = await this.storage.save(fileName, Buffer.from(content));

    // 7. 완료 감사 로그 기록
    await this.auditLog.log({
      actor: params.requestedBy,
      action: 'AUDIT_EXPORT_COMPLETED',
      resourceId: params.inquiryId,
      afterState: {
        recordCount: records.length,
        filePath,
        checksum: extractChecksum,
        format: params.format,
        integrityVerified: true,
      },
    });

    return {
      filePath,
      checksum: extractChecksum,
      recordCount: records.length,
    };
  }
}
```

라우터 등록:

```typescript
// admin/router.ts

router.get('/admin/audit/export', async (req, res) => {
  const { from, to, userId, format = 'JSON', requestedBy, inquiryId } = req.query;

  if (!from || !to || !requestedBy || !inquiryId) {
    return res.status(400).json({
      error: 'from, to, requestedBy, inquiryId 필수',
    });
  }

  const result = await auditLogAdmin.exportLogs({
    from:        new Date(from as string),
    to:          new Date(to as string),
    userId:      userId as string | undefined,
    format:      format as 'CSV' | 'JSON',
    requestedBy: requestedBy as string,
    inquiryId:   inquiryId as string,
  });

  res.json({
    filePath:    result.filePath,
    checksum:    result.checksum,
    recordCount: result.recordCount,
    message:     '추출 완료. checksum을 감독원에 함께 제출하세요.',
  });
});
```

테스트:

```bash
# 감독원 조회 대응 추출
curl "http://localhost:3000/admin/audit/export\
?from=2025-03-01&to=2025-03-31\
&userId=user-001\
&format=CSV\
&requestedBy=compliance-lee@kyobo.com\
&inquiryId=FSS-2026-001"

# 기대 응답
{
  "filePath": "/exports/audit_export_FSS-2026-001_1746268800000.csv",
  "checksum": "8f3c2a7d...",
  "recordCount": 142,
  "message": "추출 완료. checksum을 감독원에 함께 제출하세요."
}
```

---

### 실습 2 — Warm 이관 구현 스텁 (8분)

```typescript
// AuditLogAdminService.ts 추가

async archiveToWarm(year: number, approvedBy: string): Promise<{
  archivedCount: number;
  archivePath: string;
  integrityVerified: boolean;
}> {
  const from = new Date(`${year}-01-01T00:00:00Z`);
  const to   = new Date(`${year + 1}-01-01T00:00:00Z`);

  // 1. 이관 전 무결성 검증
  const integrityResult = await this.auditLog.verifyChainIntegrityInRange(from, to);
  if (!integrityResult.valid) {
    throw new Error(
      `[archiveToWarm] 무결성 검증 실패. year=${year}, firstInvalidId=${integrityResult.firstInvalidId}. 이관 중단.`,
    );
  }

  // 2. 대상 데이터 조회
  const rows = await this.db.query(
    `SELECT * FROM audit_log
     WHERE event_time >= $1 AND event_time < $2
     ORDER BY id ASC`,
    [from, to],
  );
  const records = rows.rows;

  // 3. 압축 + 스토리지 이관
  const content = JSON.stringify(records);
  const compressed = await gzip(Buffer.from(content, 'utf8'));
  const archivePath = `audit_archive/${year}/audit_log_${year}.json.gz`;
  await this.storage.saveToWarm(archivePath, compressed);

  // 4. 이관 확인 (스토리지에서 파일 크기 확인)
  const stored = await this.storage.getMetadata(archivePath);
  if (!stored) {
    throw new Error(`[archiveToWarm] 이관 파일 확인 실패. 원본 삭제 중단.`);
  }

  // 5. 이관 확인 후 원본 DB 삭제
  await this.db.query(
    `DELETE FROM audit_log WHERE event_time >= $1 AND event_time < $2`,
    [from, to],
  );

  // 6. 이관 완료 감사 로그 기록 (Hot 영역에 남음)
  await this.auditLog.log({
    actor: approvedBy,
    action: 'AUDIT_ARCHIVE_TO_WARM',
    resourceId: `year-${year}`,
    afterState: {
      year,
      archivedCount: records.length,
      archivePath,
      integrityVerified: true,
      deletedFromHot: true,
    },
  });

  return {
    archivedCount: records.length,
    archivePath,
    integrityVerified: true,
  };
}
```

---

### 실습 3 — 체인 무결성 검증 엔드포인트 (7분)

```typescript
// S26 verifyChainIntegrity()에 기간 범위 지원 추가

// AuditLogService에 추가 (S26 확장)
async verifyChainIntegrityInRange(
  from: Date,
  to: Date,
): Promise<{ valid: boolean; firstInvalidId?: number; checkedCount: number }> {
  const rows = await this.db.query(
    `SELECT * FROM audit_log
     WHERE event_time >= $1 AND event_time <= $2
     ORDER BY id ASC`,
    [from, to],
  );

  if (rows.rows.length === 0) {
    return { valid: true, checkedCount: 0 };
  }

  // 범위 시작 이전 마지막 checksum 조회 (체인 연결)
  const prevRow = await this.db.query(
    `SELECT checksum FROM audit_log
     WHERE event_time < $1
     ORDER BY id DESC LIMIT 1`,
    [from],
  );
  let prevChecksum = prevRow.rows.length > 0 ? prevRow.rows[0].checksum as string : '';

  for (const row of rows.rows) {
    const expected = await this.generateChainedChecksum(
      prevChecksum,
      new Date(row.event_time as string),
      row.actor as string,
      row.action as string,
      row.resource_id as string,
      row.after_state,
    );

    if (expected !== row.checksum) {
      return { valid: false, firstInvalidId: row.id as number, checkedCount: rows.rows.length };
    }
    prevChecksum = row.checksum as string;
  }

  return { valid: true, checkedCount: rows.rows.length };
}
```

```typescript
// router.ts

router.get('/admin/audit/integrity-check', async (req, res) => {
  const { from, to } = req.query;

  let result: { valid: boolean; firstInvalidId?: number; checkedCount: number };

  if (from && to) {
    // 기간별 검증
    result = await auditLog.verifyChainIntegrityInRange(
      new Date(from as string),
      new Date(to as string),
    );
  } else {
    // 전체 검증
    const full = await auditLog.verifyChainIntegrity();
    result = { ...full, checkedCount: -1 };  // 전체 건수 별도 조회 필요
  }

  res.json({
    valid:          result.valid,
    firstInvalidId: result.firstInvalidId ?? null,
    checkedCount:   result.checkedCount,
    message: result.valid
      ? '체인 무결성 정상. 모든 레코드 유효.'
      : `⚠️ 무결성 훼손 감지! id=${result.firstInvalidId}에서 불일치.`,
  });
});
```

테스트:

```bash
# 전체 검증
curl http://localhost:3000/admin/audit/integrity-check

# 기간별 검증 (감독원 제출 전 검증)
curl "http://localhost:3000/admin/audit/integrity-check\
?from=2025-03-01&to=2025-03-31"

# 정상 응답
{ "valid": true, "firstInvalidId": null, "checkedCount": 142, "message": "체인 무결성 정상..." }

# 훼손 시 응답
{ "valid": false, "firstInvalidId": 5047, "checkedCount": 142, "message": "⚠️ 무결성 훼손 감지! id=5047..." }
```

---

## 완료 기준

- [ ] `GET /admin/audit/export` — CSV + JSON 양식 모두 지원, checksum 포함 응답
- [ ] 추출 전 verifyChainIntegrityInRange() 실행 → 실패 시 추출 중단 확인
- [ ] 추출 시작·완료 모두 감사 로그에 기록 확인
- [ ] `archiveToWarm()` — 무결성 검증 → 압축 이관 → 원본 삭제 순서 확인
- [ ] 이관 확인 전 원본 삭제 코드 없음 확인 (순서 오류 방지)
- [ ] `GET /admin/audit/integrity-check` — 전체 및 기간별 검증, firstInvalidId 반환 확인

---

### 운영 체크리스트 — 감독원 조회 요청 수신 시

```
□ 요청 내용 파악
    ├── 기간: ____~ ____
    ├── 대상: userId 또는 전체
    ├── 형식: CSV / JSON
    └── 제출 기한: ____

□ 접수 행위 즉시 감사 로그 기록 (REGULATORY_INQUIRY_RECEIVED)
□ AUDIT_EXPORTER 권한 확인 (준법감시팀 확인)
□ 2인 승인 획득

□ GET /admin/audit/integrity-check?from=&to= → valid: true 확인
    → valid: false → 즉시 제출 중단, 감사팀·법무팀 보고

□ GET /admin/audit/export → filePath + checksum 확인
□ 추출 범위 밖 데이터 미포함 확인 (userId 필터 정확성)
□ AES-256 암호화 후 제출 + checksum 별도 동봉
□ 제출 완료 감사 로그 기록 (REGULATORY_INQUIRY_EXPORTED)
```

---

## 워크시트

### 감독원 조회 대응 절차 시트

> 조회 요청 수신 시 이 시트를 순서대로 채운다.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
감독원 감사 로그 조회 대응 시트
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[요청 정보]
  수신 시각    : ____________________
  조회 기관    : ____________________
  요청 번호    : ____________________
  대상 기간    : __________  ~  __________
  대상 사용자  : ( ) 특정 userId: ________  ( ) 전체
  요청 형식    : ( ) CSV  ( ) JSON  ( ) PDF
  제출 기한    : ____________________

[접근 권한 확인]
  추출 담당자  : ____________________
  AUDIT_EXPORTER 권한 보유: ( ) 예  ( ) 아니오
  2인 승인
    승인자 1   : ____________________
    승인자 2   : ____________________

[무결성 검증]
  GET /admin/audit/integrity-check?from=&to= 결과:
    valid      : ( ) true  ( ) false
    checkedCount: ____ 건
  결과 false → 즉시 중단: ( ) 중단 완료
             → 감사팀·법무팀 보고: ( ) 완료

[추출 실행]
  실행 시각    : ____________________
  recordCount  : ____ 건
  checksum     : ____________________
  filePath     : ____________________

[제출 확인]
  추출 범위 외 데이터 미포함: ( ) 확인 완료
  AES-256 암호화 완료: ( ) 완료
  checksum 파일 별도 동봉: ( ) 완료
  제출 시각: ____________________

[감사 로그 기록 확인]
  접수 기록 (REGULATORY_INQUIRY_RECEIVED): ( ) 완료
  추출 완료 기록 (REGULATORY_INQUIRY_EXPORTED): ( ) 완료
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### 보관 이관 체크리스트 (연간 1월 실행)

```
┌──────────────────────────────────────────────────────────┐
│  Hot → Warm 이관 체크리스트 (매년 1월 실행)               │
│                                                           │
│  사전 준비:                                               │
│  □ 이관 대상 연도 확인 (2년 이전)                         │
│  □ 담당자 2인 지정 (AUDIT_ADMIN 권한)                    │
│  □ Warm 스토리지 용량 확인 (여유 공간)                    │
│                                                           │
│  실행 순서 (순서 변경 금지):                              │
│  □ [1] GET /admin/audit/integrity-check → valid: true    │
│  □ [2] archiveToWarm(year) 실행                          │
│  □ [3] Warm 스토리지 파일 존재 확인                       │
│  □ [4] 파일 크기·checksum 검증                           │
│  □ [5] 원본 DB 삭제 (archiveToWarm 내부에서 자동)        │
│  □ [6] 이관 완료 감사 로그 기록 확인                      │
│                                                           │
│  ⚠️ [1] valid: false → 즉시 중단, 이관 불가              │
│  ⚠️ [3] 파일 확인 전 삭제 절대 금지                       │
└──────────────────────────────────────────────────────────┘
```

---

### 무결성 훼손 대응 카드

```
┌──────────────────────────────────────────────────────────┐
│  integrity-check → valid: false 발견 시                   │
│                                                           │
│  즉각 행동:                                               │
│  □ 제출 중단 (감독원 조회 중이면 즉시 중단)              │
│  □ 이관 중단 (archiveToWarm 중이면 즉시 중단)            │
│  □ firstInvalidId 기록: ____________________              │
│                                                           │
│  원인 분석:                                               │
│  □ id=firstInvalidId 레코드 DB 직접 조회                  │
│  □ 이전 레코드 (id-1) checksum 확인                       │
│  □ DB 접근 로그에서 해당 기간 DELETE/UPDATE 이력 확인     │
│                                                           │
│  훼손 유형:                                               │
│  ( ) 레코드 DELETE → 해당 id 빠짐                         │
│  ( ) afterState 수정 → 해당 id checksum 불일치            │
│  ( ) 가짜 삽입 → 기존 체인과 prevChecksum 불일치          │
│                                                           │
│  에스컬레이션:                                            │
│  □ 감사팀 즉시 보고                                       │
│  □ 법무팀 보고                                            │
│  □ 보안팀 보고 (내부 침해 가능성)                         │
│  □ 경영진 보고 (규제 위험)                                │
└──────────────────────────────────────────────────────────┘
```

---

## 자동화 확장 — AuditLogAdminService

> 위 워크시트의 디지털 버전. 추출·검증·이관을 통합하는 서비스.

### TypeScript 서비스 클래스 구현

```typescript
// dmz/packages/ledger/src/admin/AuditLogAdminService.ts (전체)

export class AuditLogAdminService {
  constructor(
    private readonly db: Database,
    private readonly auditLog: AuditLogService,
    private readonly storage: StorageAdapter,
    private readonly notifier: NotifierAdapter,
  ) {}

  // 정기 무결성 검증 — cron으로 매일 새벽 실행
  async runDailyIntegrityCheck(): Promise<void> {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400 * 1000);

    const result = await this.auditLog.verifyChainIntegrityInRange(yesterday, today);

    if (!result.valid) {
      await this.notifier.sendAlert({
        title: '⚠️ 감사 로그 무결성 훼손 감지!',
        severity: 'P1',
        body: [
          `firstInvalidId: ${result.firstInvalidId}`,
          `검사 기간: ${yesterday.toISOString()} ~ ${today.toISOString()}`,
          `즉각 대응 필요: 감사팀, 보안팀, 법무팀`,
          `확인: GET /admin/audit/integrity-check`,
        ].join('\n'),
      });

      // 무결성 훼손 자체도 감사 로그에 기록
      await this.auditLog.log({
        actor: 'integrity-checker',
        action: 'AUDIT_INTEGRITY_VIOLATION_DETECTED',
        resourceId: String(result.firstInvalidId),
        afterState: { firstInvalidId: result.firstInvalidId, period: 'daily-check' },
      });
    }
  }

  // 이관 자동화 스케줄러 — 매년 1월 1일 새벽 2시
  async runAnnualArchive(approvedBy: string): Promise<void> {
    const targetYear = new Date().getFullYear() - 2;  // 2년 전 데이터 이관

    try {
      const result = await this.archiveToWarm(targetYear, approvedBy);
      await this.notifier.sendAlert({
        title: `감사 로그 연간 이관 완료 (${targetYear}년)`,
        severity: 'P3',
        body: `이관 건수: ${result.archivedCount}, 경로: ${result.archivePath}`,
      });
    } catch (err) {
      await this.notifier.sendAlert({
        title: `⚠️ 감사 로그 연간 이관 실패 (${targetYear}년)`,
        severity: 'P1',
        body: String(err),
      });
    }
  }
}
```

### cron 등록

```typescript
// 매일 새벽 1시 무결성 검증
cron.schedule('0 1 * * *', async () => {
  await auditLogAdmin.runDailyIntegrityCheck();
}, { timezone: 'Asia/Seoul' });

// 매년 1월 1일 새벽 2시 이관
cron.schedule('0 2 1 1 *', async () => {
  await auditLogAdmin.runAnnualArchive('system-auto-archive');
}, { timezone: 'Asia/Seoul' });
```

### 아날로그↔디지털 대응 요약 테이블

| 아날로그 (워크시트) | 디지털 (API/서비스) | 자동화 여부 |
|---|---|---|
| 무결성 검증 (조회 전) | `GET /admin/audit/integrity-check` | 운영자 실행 |
| 추출 실행 | `GET /admin/audit/export` | 운영자 실행 |
| checksum 동봉 | API 응답에 `checksum` 자동 포함 | ✅ 자동 |
| 접수·완료 감사 기록 | `auditLog.log()` 자동 삽입 | ✅ 자동 |
| 연간 이관 실행 | `runAnnualArchive()` | ✅ cron 자동 |
| 이관 전 무결성 검증 | `archiveToWarm()` 내부 자동 실행 | ✅ 자동 |
| 일일 무결성 점검 | `runDailyIntegrityCheck()` cron | ✅ 자동 |
| 훼손 시 에스컬레이션 | P1 알림 자동 발송 | ✅ 자동 |
