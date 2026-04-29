# M4 S26 — 금융 규제 대응 감사 로그 · SHA-256 체인과 불변성 보장

> 모듈 4 · 세션 26 · 1시간  
> 스켈레톤: `dmz/packages/core-banking/src/audit/AuditLogService.ts`

---

## 강의 파트 (20분)

### 1. 왜 감사 로그가 단순 로그와 다른가

일반적인 애플리케이션 로그는 지워도 된다. 디스크가 차면 rotate한다.

금융 감사 로그는 다르다:

| 규정 | 요건 |
|---|---|
| 전자금융감독규정 §34 | 접근 기록 1년 이상 보존 |
| 가상자산이용자보호법 §15 | 거래 기록 5년 보존 |
| ISMS-P | 암호 무결성 검증 요건 |

감독원 검사가 나왔다. "2025년 3월 15일 오전 10시에 NFT 발행 요청 #12345에 어떤 일이 있었는지 보여주세요." 이 질문에 즉시 답해야 한다. 답하지 못하면 과태료다.

더 중요한 것: 기록이 변조되지 않았음을 증명해야 한다. "이 기록은 원본 그대로입니다"를 어떻게 증명할까?

---

### 2. Append-only 원칙 — 수정·삭제 금지

```
INSERT  ✅  새 이벤트 기록
UPDATE  ❌  기존 레코드 수정 금지
DELETE  ❌  레코드 삭제 금지
```

보정이 필요할 때도 기존 레코드를 건드리지 않는다. 새 INSERT로 보정 사실을 기록한다:

```
id=100: action=MINT_REQUESTED,      afterState={status:'PENDING'}
id=200: action=STATUS_CONFIRMED,    afterState={status:'CONFIRMED', txHash:'0x...'}
id=300: action=RECONCILE_CORRECTION, afterState={reason:'db_restored', note:'원장 복구 후 재기록'}
```

이렇게 하면 전체 이력이 보존된다. "원래 뭐가 잘못됐는지", "언제 어떻게 고쳤는지" 모두 남는다.

DB 레벨에서도 Row Security Policy로 UPDATE/DELETE를 차단해야 한다 (INSERT-only 정책).

---

### 3. SHA-256 체인 — 삭제를 감지한다

Append-only만으로는 부족하다. DB 관리자 계정으로 접속해서 중간 레코드를 삭제하면 어떻게 될까?

```sql
DELETE FROM audit_log WHERE id = 50;
-- id가 49에서 51로 건너뜀
-- 숫자가 빠진 것을 알아채기 어려움
```

SHA-256 체인 방식은 이것을 수학적으로 감지한다.

**체인 방식 원리:**

```
checksum_1 = SHA256(seed + event1_data)
checksum_2 = SHA256(checksum_1 + event2_data)  ← 이전 checksum 포함
checksum_3 = SHA256(checksum_2 + event3_data)
```

이전 checksum이 다음 checksum의 입력으로 들어간다. 블록체인에서 이전 블록 해시가 다음 블록에 포함되는 것과 같은 원리다.

**삭제 시 효과:**

```
id=50 삭제 후 id=51의 checksum 재계산:
  expected = SHA256(checksum_49 + event51_data)  ← id=50이 빠진 체인
  stored   = SHA256(checksum_50 + event51_data)  ← 원래 저장된 값

expected ≠ stored → "id=51에서 체인 불일치 감지!"
```

id=50을 삭제한 순간 id=51의 checksum이 깨진다. 이후 모든 레코드도 연달아 깨진다.

---

### 4. 체인 방식 checksum 생성

```typescript
private async generateChainedChecksum(
  prevChecksum: string,
  eventTime: Date,
  actor: string,
  action: string,
  resourceId: string,
  afterState: unknown,
): Promise<string> {
  // 이전 checksum + 현재 이벤트 데이터를 합쳐서 해시
  const raw = [
    prevChecksum,
    eventTime.toISOString(),
    actor,
    action,
    resourceId,
    JSON.stringify(afterState),
  ].join('');

  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
```

최초 레코드(id=1)의 `prevChecksum`은 빈 문자열 `''` 또는 설정된 seed 값을 사용한다.

---

### 5. 세 가지 훼손 시나리오

**시나리오 1: 중간 레코드 DELETE**

```sql
DELETE FROM audit_log WHERE id = 50;
```

→ `verifyChainIntegrity()`에서 id=51의 prevChecksum이 맞지 않음 감지.

**시나리오 2: afterState 수정 (내용 조작)**

```sql
UPDATE audit_log SET after_state = '{"status":"CONFIRMED"}' WHERE id = 50;
```

→ id=50의 checksum 재계산 결과가 저장된 값과 다름 감지.

**시나리오 3: 중간에 가짜 레코드 삽입**

id=100과 id=101 사이에 가짜 레코드를 삽입하려 해도, id=101의 prevChecksum이 원래 id=100의 checksum을 가리키므로 체인이 끊긴다.

---

## 실습 파트 (35분)

### `log()` TODO 채우기

```typescript
async log(params: LogParams): Promise<number> {
  const eventTime = new Date();

  // TODO 1: 마지막 레코드의 checksum 조회 (체인 연결)
  const lastRow = await this.db.query(
    'SELECT checksum FROM audit_log ORDER BY id DESC LIMIT 1',
  );
  const prevChecksum = lastRow.rows.length > 0
    ? (lastRow.rows[0].checksum as string)
    : '';  // 첫 번째 레코드: 빈 문자열로 시작

  // TODO 2: 체인 방식 checksum 계산
  const checksum = await this.generateChainedChecksum(
    prevChecksum,
    eventTime,
    params.actor,
    params.action,
    params.resourceId,
    params.afterState,
  );

  // TODO 3: INSERT
  const result = await this.db.query(
    `INSERT INTO audit_log
       (event_time, actor, action, resource_type, resource_id,
        before_state, after_state, ip_address, session_id, checksum)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      eventTime,
      params.actor,
      params.action,
      params.resourceType ?? 'unknown',
      params.resourceId,
      params.beforeState ? JSON.stringify(params.beforeState) : null,
      JSON.stringify(params.afterState),
      params.ipAddress ?? null,
      params.sessionId ?? null,
      checksum,
    ],
  );

  return result.rows[0].id as number;
}
```

### `verifyIntegrity()` TODO 채우기 — 단건 검증

```typescript
async verifyIntegrity(id: number): Promise<VerifyResult> {
  const result = await this.db.query(
    'SELECT * FROM audit_log WHERE id = $1',
    [id],
  );
  if (result.rows.length === 0) throw new Error(`Audit log not found: ${id}`);

  const row = result.rows[0];
  const storedChecksum = row.checksum as string;

  // 단건 검증: 이전 checksum 조회
  const prevRow = await this.db.query(
    'SELECT checksum FROM audit_log WHERE id < $1 ORDER BY id DESC LIMIT 1',
    [id],
  );
  const prevChecksum = prevRow.rows.length > 0
    ? (prevRow.rows[0].checksum as string)
    : '';

  const computedChecksum = await this.generateChainedChecksum(
    prevChecksum,
    new Date(row.event_time as string),
    row.actor as string,
    row.action as string,
    row.resource_id as string,
    row.after_state,
  );

  return {
    id,
    valid: storedChecksum === computedChecksum,
    storedChecksum,
    computedChecksum,
  };
}
```

### 전체 체인 무결성 검증

```typescript
async verifyChainIntegrity(): Promise<{ valid: boolean; firstInvalidId?: number }> {
  const rows = await this.db.query(
    'SELECT * FROM audit_log ORDER BY id ASC',
  );

  let prevChecksum = '';  // 초기 seed

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
      return { valid: false, firstInvalidId: row.id as number };
    }
    prevChecksum = row.checksum as string;
  }

  return { valid: true };
}
```

### 무결성 훼손 테스트

```typescript
// 테스트 1: 중간 레코드 DELETE
it('중간 레코드 삭제 → verifyChainIntegrity 불일치 감지', async () => {
  // 3개 레코드 삽입
  const id1 = await auditLog.log({ actor: 'system', action: 'A', resourceId: 'r1', afterState: {} });
  const id2 = await auditLog.log({ actor: 'system', action: 'B', resourceId: 'r2', afterState: {} });
  const id3 = await auditLog.log({ actor: 'system', action: 'C', resourceId: 'r3', afterState: {} });

  // id2 강제 삭제 (DB 직접 수정 시뮬레이션)
  await db.query('DELETE FROM audit_log WHERE id = $1', [id2]);

  // 체인 검증 → id3에서 불일치 감지
  const result = await auditLog.verifyChainIntegrity();
  expect(result.valid).toBe(false);
  expect(result.firstInvalidId).toBe(id3);
});

// 테스트 2: afterState 수정
it('afterState 수정 → verifyChainIntegrity 감지', async () => {
  const id1 = await auditLog.log({ actor: 'system', action: 'A', resourceId: 'r1', afterState: { status: 'PENDING' } });

  // afterState 직접 수정
  await db.query(
    "UPDATE audit_log SET after_state = '{\"status\":\"CONFIRMED\"}' WHERE id = $1",
    [id1],
  );

  const result = await auditLog.verifyChainIntegrity();
  expect(result.valid).toBe(false);
  expect(result.firstInvalidId).toBe(id1);
});
```

---

## M4 완료 기준

- [ ] 감사 로그 중간 삭제 → checksum 불일치 감지
- [ ] afterState 수정 → 감지
- [ ] chain integrity 검증 통과
- [ ] queryByResource / queryByActor 반환 형식 확인
- [ ] LedgerService 상태 전이 시 audit log 자동 기록 확인
