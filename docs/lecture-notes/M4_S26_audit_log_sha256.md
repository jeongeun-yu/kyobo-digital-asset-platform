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

> **M3~M4 전체 상태 전이의 최종 기록지가 바로 이 감사 로그다.**  
> M3 S13의 TxStateMachineService, M4 S24의 LedgerService가 상태를 바꿀 때마다 이 테이블에 INSERT한다. S26은 그 기록들이 변조되지 않았음을 SHA-256 체인으로 봉인하는 방법을 다룬다.
>
> | 세션 | 역할 | 감사 로그와의 관계 |
> |---|---|---|
> | M3 S13 | TX 상태 전이 | 전이마다 audit_log INSERT |
> | M4 S24 | 원장 상태 전이 | 전이마다 audit_log INSERT |
> | M4 S26 (여기) | 감사 로그 봉인 | SHA-256 체인으로 변조 불가능하게 만들기 |
>
> **M4 S24의 ON CONFLICT DO NOTHING과 달리, 감사 로그에는 이 패턴을 적용하지 않는다.** audit_log는 중복 INSERT 자체를 허용하지 않는 구조(prevChecksum + sequence가 항상 유일)이고, 혹시 중복이 생기면 오히려 체인 검증에서 감지되어야 한다.

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

### 2-1. DB Row Security Policy — UPDATE/DELETE 차단

애플리케이션 코드만으로는 부족하다. DB 관리자 계정이 직접 접속하면 코드를 우회할 수 있기 때문이다. PostgreSQL Row Security Policy (RLS)로 DB 레벨에서 차단한다.

```sql
-- 1. audit_log 테이블 RLS 활성화
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- 2. INSERT 전용 정책: 애플리케이션 역할은 INSERT만 허용
--    app_role: NestJS 서버가 DB 연결 시 사용하는 PostgreSQL 역할
CREATE POLICY audit_log_insert_only
  ON audit_log
  FOR INSERT
  TO app_role
  WITH CHECK (true);   -- INSERT는 항상 허용

-- 3. SELECT 정책: 읽기는 허용 (감사 로그 조회 API가 사용)
CREATE POLICY audit_log_select
  ON audit_log
  FOR SELECT
  TO app_role
  USING (true);

-- 4. UPDATE/DELETE 정책: 생성하지 않음 → 묵시적 차단
--    RLS가 활성화된 상태에서 정책 없음 = 해당 작업 금지

-- 5. 검증: app_role로 UPDATE 시도 → 오류 발생 확인
SET ROLE app_role;
UPDATE audit_log SET after_state = '{}' WHERE id = 1;
-- ERROR: new row violates row-level security policy for table "audit_log"
-- (또는 policy 없음으로 인한 차단)

RESET ROLE;
```

**DB 관리자 역할(postgres superuser)에 대한 추가 조치:**

```sql
-- 슈퍼유저는 RLS를 우회할 수 있음 (PostgreSQL 설계상)
-- 따라서 audit_log 접근 가능한 슈퍼유저 계정을 별도 감사 로그로 모니터링
-- 또는 audit_log 테이블 소유자를 별도 역할로 분리

-- audit_log 소유자를 audit_owner 역할로 변경
CREATE ROLE audit_owner NOLOGIN;
ALTER TABLE audit_log OWNER TO audit_owner;

-- app_role은 audit_owner 역할 없이 INSERT/SELECT만 부여
GRANT INSERT, SELECT ON audit_log TO app_role;
-- UPDATE, DELETE 권한은 부여하지 않음

-- 이렇게 하면 app_role 계정으로는 UPDATE/DELETE 불가
-- (슈퍼유저 직접 접근은 별도 접근 제어 정책으로 관리)
```

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

### 6. 타입 정의 — LogParams / VerifyResult

```typescript
/**
 * AuditLogService.log() 호출 시 전달하는 파라미터.
 */
export interface LogParams {
  /** 작업을 수행한 주체. 사람이면 userId, 시스템이면 'system' 또는 서비스명 */
  actor: string;

  /**
   * 발생한 이벤트 종류.
   * 예: 'MINT_REQUESTED', 'MINT_CONFIRMED', 'BURN_REQUESTED',
   *     'STATUS_UPDATED', 'RECONCILE_CORRECTION', 'LOGIN', 'LOGOUT'
   */
  action: string;

  /** 이벤트 대상 리소스 유형. 예: 'MintRequest', 'NFT', 'User' */
  resourceType?: string;

  /** 이벤트 대상 리소스 식별자. 예: mintRequest ID, tokenId */
  resourceId: string;

  /** 변경 전 상태 스냅샷 (없으면 null). 최초 생성 이벤트는 생략 가능 */
  beforeState?: unknown;

  /** 변경 후 상태 스냅샷. 반드시 포함. 감독원 제출 시 핵심 근거 */
  afterState: unknown;

  /** 요청자 IP 주소. 외부 요청 이벤트에서 기록 */
  ipAddress?: string;

  /** 세션 ID. 특정 세션의 전체 이력 추적에 사용 */
  sessionId?: string;
}

/**
 * AuditLogService.verifyIntegrity() / verifyChainIntegrity() 반환 타입.
 */
export interface VerifyResult {
  /** 검증 대상 레코드 ID */
  id: number;

  /** true: checksum 일치 (무결), false: 불일치 (변조 의심) */
  valid: boolean;

  /** DB에 저장된 checksum 값 */
  storedChecksum: string;

  /**
   * 현재 레코드 데이터로 재계산한 checksum.
   * valid=false 일 때 storedChecksum과 다름.
   */
  computedChecksum: string;
}

/**
 * 전체 체인 무결성 검증 결과.
 */
export interface ChainVerifyResult {
  valid: boolean;
  /** 최초로 체인이 끊긴 레코드 ID. valid=true 이면 undefined */
  firstInvalidId?: number;
  /** 검증한 총 레코드 수 */
  checkedCount: number;
}
```

---

### 7. AuditLogService 전체 인터페이스

```typescript
export interface IAuditLogService {
  /**
   * 새 감사 이벤트 기록. SHA-256 체인 checksum 자동 생성 후 INSERT.
   * @returns 삽입된 레코드 ID
   */
  log(params: LogParams): Promise<number>;

  /**
   * 단건 레코드 무결성 검증.
   * 이전 레코드의 checksum을 조회하여 현재 레코드 checksum을 재계산 후 비교.
   */
  verifyIntegrity(id: number): Promise<VerifyResult>;

  /**
   * 전체 체인 무결성 검증 (처음부터 끝까지 순차 검증).
   * 최초로 checksum이 깨진 위치를 반환.
   * 대용량 환경에서는 구간 검증(verifyChainRange)을 사용할 것.
   */
  verifyChainIntegrity(): Promise<ChainVerifyResult>;

  /**
   * 특정 구간 체인 무결성 검증.
   * 실운영에서 전체 스캔 대신 최근 N건 또는 특정 시간대만 검증할 때 사용.
   *
   * @param fromId  검증 시작 레코드 ID (포함)
   * @param toId    검증 종료 레코드 ID (포함)
   */
  verifyChainRange(fromId: number, toId: number): Promise<ChainVerifyResult>;

  /**
   * 특정 리소스와 관련된 감사 이벤트 조회.
   * 예: 특정 mintRequestId에 대한 전체 이력 조회.
   *
   * @param resourceId  리소스 식별자
   * @param options     페이지네이션 옵션
   */
  queryByResource(
    resourceId: string,
    options?: QueryOptions,
  ): Promise<AuditLogRow[]>;

  /**
   * 특정 행위자(actor)의 감사 이벤트 조회.
   * 예: 특정 사용자 또는 시스템이 수행한 모든 작업 이력.
   *
   * @param actor    행위자 식별자 (userId 또는 'system')
   * @param options  페이지네이션 옵션
   */
  queryByActor(
    actor: string,
    options?: QueryOptions,
  ): Promise<AuditLogRow[]>;

  /**
   * 시간 범위로 감사 이벤트 조회.
   * 감독원 검사 시 특정 날짜·시간대 이벤트를 추출할 때 사용.
   */
  queryByTimeRange(
    from: Date,
    to: Date,
    options?: QueryOptions,
  ): Promise<AuditLogRow[]>;
}

/** 조회 결과 단건 행 타입 */
export interface AuditLogRow {
  id: number;
  eventTime: Date;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  beforeState: unknown | null;
  afterState: unknown;
  ipAddress: string | null;
  sessionId: string | null;
  checksum: string;
}

/** 페이지네이션 옵션 */
export interface QueryOptions {
  limit?: number;   // 기본값 100
  offset?: number;  // 기본값 0
  orderBy?: 'asc' | 'desc';  // 기본값 'desc' (최신 순)
}
```

---

### 8. 동시성 문제 — prevChecksum Race Condition

`log()` 구현에서 가장 위험한 버그가 숨어있다.

**문제 상황:**

```
Worker A: SELECT checksum FROM audit_log ORDER BY id DESC LIMIT 1
           → prevChecksum = 'abc123' (현재 마지막 레코드)

Worker B: SELECT checksum FROM audit_log ORDER BY id DESC LIMIT 1
           → prevChecksum = 'abc123' (Worker A와 동일한 값 조회)

Worker A: generateChainedChecksum('abc123', ...) → 'def456'
           INSERT INTO audit_log (..., checksum) VALUES (..., 'def456')  → id=101

Worker B: generateChainedChecksum('abc123', ...) → 'ghi789'
           INSERT INTO audit_log (..., checksum) VALUES (..., 'ghi789')  → id=102
```

결과:
- id=101의 checksum: `SHA256('abc123' + event101_data)` = `'def456'`
- id=102의 checksum: `SHA256('abc123' + event102_data)` = `'ghi789'`  ← **버그!**

id=102는 id=101의 checksum이 아닌 id=100의 checksum(`'abc123'`)을 기반으로 계산됐다.
`verifyChainIntegrity()`에서 id=102가 즉시 불일치로 감지된다.

**해결책 1 — 트랜잭션 + SELECT FOR UPDATE**

```typescript
async log(params: LogParams): Promise<number> {
  return await this.db.transaction(async (trx) => {
    // FOR UPDATE: 이 행을 조회하는 동안 다른 트랜잭션이 같은 행을 잠금 → 직렬화
    // SKIP LOCKED: 이미 잠긴 행은 건너뜀 (deadlock 방지)
    const lastRow = await trx.query(
      `SELECT checksum FROM audit_log
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
    );

    const prevChecksum = lastRow.rows.length > 0
      ? (lastRow.rows[0].checksum as string)
      : '';

    const eventTime = new Date();
    const checksum = await this.generateChainedChecksum(
      prevChecksum,
      eventTime,
      params.actor,
      params.action,
      params.resourceId,
      params.afterState,
    );

    const result = await trx.query(
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
  });
}
```

`FOR UPDATE`가 마지막 행을 잠그는 동안 다른 Worker의 `SELECT FOR UPDATE`는 대기(blocking)한다. Worker A의 INSERT가 완료되면 Worker B가 잠금을 획득하고 갱신된 마지막 행(id=101)을 읽는다.

**해결책 2 — DB 시퀀스 + 단일 Writer**

Race Condition 자체를 없애는 방법: `log()` 호출을 단일 큐로 직렬화한다.

```typescript
import PQueue from 'p-queue';

@Injectable()
export class AuditLogService {
  // concurrency=1: 동시에 1개만 처리 → log() 직렬 실행 보장
  private readonly queue = new PQueue({ concurrency: 1 });

  async log(params: LogParams): Promise<number> {
    return this.queue.add(async () => {
      const lastRow = await this.db.query(
        'SELECT checksum FROM audit_log ORDER BY id DESC LIMIT 1',
      );
      const prevChecksum = lastRow.rows.length > 0
        ? (lastRow.rows[0].checksum as string)
        : '';

      // ... 이하 동일
    });
  }
}
```

단일 프로세스 환경에서는 간단하지만, **여러 서버(Pod)가 동시에 실행되는 환경에서는 효과 없다**. 이 경우 해결책 1(트랜잭션 + SELECT FOR UPDATE)이 필수다.

**실운영 권장**: 해결책 1 + 2를 모두 적용. Pod 수가 늘어나도 DB 트랜잭션이 안전망이 된다.

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

---

### 대용량 데이터 성능 이슈 — 구간 검증으로 해결

`verifyChainIntegrity()`는 **전체 테이블을 메모리에 올려서 순차 검증**한다. 5년치 감사 로그가 쌓이면 수천만 건이 될 수 있다. 이것을 한 번에 조회하면:

- 메모리 부족 → OOM 크래시
- DB 쿼리 시간 수십 분 → 타임아웃
- 다른 쿼리 성능 저하 → 서비스 영향

**실운영 구간 검증 패턴:**

```typescript
async verifyChainRange(
  fromId: number,
  toId: number,
): Promise<ChainVerifyResult> {
  // fromId의 이전 레코드 checksum을 seed로 사용
  const seedRow = await this.db.query(
    'SELECT checksum FROM audit_log WHERE id < $1 ORDER BY id DESC LIMIT 1',
    [fromId],
  );
  let prevChecksum = seedRow.rows.length > 0
    ? (seedRow.rows[0].checksum as string)
    : '';

  // 구간 내 레코드만 조회 (페이지 단위로 스트리밍)
  const PAGE_SIZE = 1_000;
  let checkedCount = 0;
  let cursor = fromId;

  while (cursor <= toId) {
    const rows = await this.db.query(
      `SELECT * FROM audit_log
       WHERE id >= $1 AND id <= $2
       ORDER BY id ASC
       LIMIT $3`,
      [cursor, toId, PAGE_SIZE],
    );

    if (rows.rows.length === 0) break;

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
        return {
          valid: false,
          firstInvalidId: row.id as number,
          checkedCount,
        };
      }

      prevChecksum = row.checksum as string;
      checkedCount++;
    }

    // 다음 페이지 시작점
    cursor = (rows.rows[rows.rows.length - 1].id as number) + 1;
  }

  return { valid: true, checkedCount };
}
```

**운영 스케줄 권장:**

| 검증 유형 | 대상 범위 | 주기 | 비고 |
|---|---|---|---|
| 실시간 단건 검증 | 방금 INSERT된 레코드 | 매 INSERT 후 | log() 내부에서 자동 |
| 단기 구간 검증 | 최근 24시간 레코드 | 매일 새벽 | 경량, 부하 낮음 |
| 중기 구간 검증 | 최근 1개월 | 매주 일요일 | 중간 부하 |
| 전체 검증 | 전 기간 | 분기 1회 | 감독원 검사 전 실행 |

---

### 외부 백업 전략 — S3 콜드 스토리지

SHA-256 체인은 DB 내 변조를 감지한다. 하지만 **DB 서버 자체가 손실되거나, 백업 없이 데이터가 삭제되면** 체인도 함께 사라진다. 따라서 외부 콜드 스토리지 백업이 필수다.

**아키텍처:**

```
audit_log (PostgreSQL)
    ↓ 정기 내보내기 (매일 00:00)
audit_log_export_YYYY-MM-DD.jsonl  (JSONL 형식)
    ↓ SHA-256 해시 파일 생성
audit_log_export_YYYY-MM-DD.sha256
    ↓ S3 Glacier / 네이버 클라우드 아카이브
s3://kyobo-audit-cold/YYYY/MM/DD/
    └── audit_log_export_YYYY-MM-DD.jsonl
    └── audit_log_export_YYYY-MM-DD.sha256
```

**내보내기 + S3 업로드 스크립트 예시:**

```typescript
import { createHash, createReadStream } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createWriteStream } from 'fs';
import path from 'path';

async function exportAuditLogToS3(date: Date): Promise<void> {
  const dateStr = date.toISOString().split('T')[0];  // 'YYYY-MM-DD'
  const fileName = `audit_log_export_${dateStr}.jsonl`;
  const tmpPath = path.join('/tmp', fileName);

  // 1. 해당 날짜 레코드를 JSONL 파일로 내보내기
  const rows = await db.query(
    `SELECT * FROM audit_log
     WHERE event_time >= $1 AND event_time < $2
     ORDER BY id ASC`,
    [
      new Date(`${dateStr}T00:00:00Z`),
      new Date(`${dateStr}T23:59:59.999Z`),
    ],
  );

  const writer = createWriteStream(tmpPath);
  for (const row of rows.rows) {
    writer.write(JSON.stringify(row) + '\n');
  }
  await new Promise(resolve => writer.end(resolve));

  // 2. 파일 SHA-256 해시 계산 (파일 자체의 무결성 검증용)
  const fileHash = await computeFileHash(tmpPath);

  // 3. S3 업로드
  const s3 = new S3Client({ region: 'ap-northeast-2' });

  await s3.send(new PutObjectCommand({
    Bucket: 'kyobo-audit-cold',
    Key: `${dateStr.slice(0, 4)}/${dateStr.slice(5, 7)}/${dateStr.slice(8, 10)}/${fileName}`,
    Body: require('fs').createReadStream(tmpPath),
    ContentType: 'application/x-ndjson',
    // S3 Glacier 스토리지 클래스: 90일 후 자동 이전, 5년 보존
    StorageClass: 'GLACIER_IR',
    // 서버 측 암호화
    ServerSideEncryption: 'AES256',
    Metadata: {
      'file-sha256': fileHash,
      'record-count': String(rows.rows.length),
      'export-date': dateStr,
    },
  }));

  // 4. 해시 파일도 별도 업로드 (검증 시 참조)
  await s3.send(new PutObjectCommand({
    Bucket: 'kyobo-audit-cold',
    Key: `${dateStr.slice(0, 4)}/${dateStr.slice(5, 7)}/${dateStr.slice(8, 10)}/audit_log_export_${dateStr}.sha256`,
    Body: `${fileHash}  ${fileName}\n`,
    ContentType: 'text/plain',
  }));
}

async function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
```

**백업 크론 등록:**

```typescript
// 매일 01:00 KST (UTC 16:00) — Reconcile 이후 실행
@Cron('0 16 * * *', { timeZone: 'Asia/Seoul' })
async runDailyAuditExport(): Promise<void> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  await exportAuditLogToS3(yesterday);
  this.logger.log('[AuditExport] 어제 감사 로그 S3 업로드 완료');
}
```

**S3 버킷 보존 정책 설정:**

```json
// S3 Lifecycle Policy (AWS Console 또는 IaC)
{
  "Rules": [
    {
      "ID": "audit-log-retention",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "Transitions": [
        {
          "Days": 90,
          "StorageClass": "GLACIER"
        }
      ],
      "Expiration": {
        "Days": 1825
      }
    }
  ]
}
```

90일 후 Glacier로 이전, 1825일(5년) 후 자동 삭제 → 가상자산이용자보호법 5년 보존 요건 충족.

---

### 감사 로그 조회 API 예시

감독원 검사 또는 내부 감사 시 사용하는 조회 패턴들이다.

**queryByResource — 특정 발행 요청의 전체 이력:**

```typescript
// 사용 예: mintRequest ID #12345에 대한 전체 처리 이력 조회
const history = await auditLogService.queryByResource('mint-req-12345', {
  limit: 50,
  orderBy: 'asc',  // 시간 순으로 조회 (이력 흐름 파악)
});

// 결과 예시:
// [
//   { id: 100, action: 'MINT_REQUESTED',  actor: 'user-001',    afterState: { status: 'PENDING' } },
//   { id: 120, action: 'MINT_CONFIRMED',  actor: 'system',      afterState: { status: 'CONFIRMED', txHash: '0x...' } },
//   { id: 135, action: 'NFT_TRANSFERRED', actor: 'blockchain',  afterState: { tokenId: '42', recipient: '0x...' } },
// ]

// 구현:
async queryByResource(
  resourceId: string,
  options: QueryOptions = {},
): Promise<AuditLogRow[]> {
  const { limit = 100, offset = 0, orderBy = 'desc' } = options;
  const result = await this.db.query(
    `SELECT id, event_time, actor, action, resource_type, resource_id,
            before_state, after_state, ip_address, session_id, checksum
     FROM audit_log
     WHERE resource_id = $1
     ORDER BY id ${orderBy === 'asc' ? 'ASC' : 'DESC'}
     LIMIT $2 OFFSET $3`,
    [resourceId, limit, offset],
  );
  return result.rows.map(mapRowToAuditLogRow);
}
```

**queryByActor — 특정 사용자의 전체 행위 이력:**

```typescript
// 사용 예: 사용자 user-001이 수행한 모든 작업 이력 조회
const actorHistory = await auditLogService.queryByActor('user-001', {
  limit: 100,
  orderBy: 'desc',  // 최신 순
});

// 사용 예 2: 특정 운영자 계정의 최근 행위 감사
const adminActions = await auditLogService.queryByActor('admin-ops-002', {
  limit: 200,
  orderBy: 'desc',
});

// 구현:
async queryByActor(
  actor: string,
  options: QueryOptions = {},
): Promise<AuditLogRow[]> {
  const { limit = 100, offset = 0, orderBy = 'desc' } = options;
  const result = await this.db.query(
    `SELECT id, event_time, actor, action, resource_type, resource_id,
            before_state, after_state, ip_address, session_id, checksum
     FROM audit_log
     WHERE actor = $1
     ORDER BY id ${orderBy === 'asc' ? 'ASC' : 'DESC'}
     LIMIT $2 OFFSET $3`,
    [actor, limit, offset],
  );
  return result.rows.map(mapRowToAuditLogRow);
}
```

**감독원 검사 시나리오 — 시간 범위 조회:**

```typescript
// "2025년 3월 15일 오전 10시에 무슨 일이 있었는지 보여주세요"
const inspectionResult = await auditLogService.queryByTimeRange(
  new Date('2025-03-15T01:00:00Z'),  // UTC 01:00 = KST 10:00
  new Date('2025-03-15T02:00:00Z'),  // 1시간 범위
  { limit: 500, orderBy: 'asc' },
);

// 특정 mintRequest와 결합하여 해당 시간대 해당 리소스 이벤트만 추출
const mintRequest12345Events = inspectionResult.filter(
  row => row.resourceId === 'mint-req-12345',
);
```

**REST API 예시 (Admin 전용):**

```typescript
// GET /admin/audit-logs?resourceId=mint-req-12345&limit=50&order=asc
@Get('audit-logs')
@UseGuards(AdminAuthGuard)
async getAuditLogs(
  @Query('resourceId') resourceId?: string,
  @Query('actor') actor?: string,
  @Query('from') from?: string,
  @Query('to') to?: string,
  @Query('limit') limit = 100,
  @Query('order') order: 'asc' | 'desc' = 'desc',
): Promise<AuditLogRow[]> {
  if (resourceId) {
    return this.auditLogService.queryByResource(resourceId, { limit, orderBy: order });
  }
  if (actor) {
    return this.auditLogService.queryByActor(actor, { limit, orderBy: order });
  }
  if (from && to) {
    return this.auditLogService.queryByTimeRange(
      new Date(from),
      new Date(to),
      { limit, orderBy: order },
    );
  }
  throw new BadRequestException('resourceId, actor, 또는 from/to 중 하나는 필수');
}
```

---

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

---

## Phase 3 연결 예고

> **M4에서 구축한 SHA-256 체인은 Phase 3에서 전체 원장 증명으로 확장된다.**  
> M4 S26: 개별 audit_log 레코드의 변조 불가 봉인 (단일 테이블 체인)  
> Phase 3: 감사 로그 + 원장 잔액 + 온체인 상태를 묶어 전체 시스템 무결성을 증명 (Merkle-style proof)  
>  
> M4까지는 "기록이 지워지지 않았음"을 증명한다. Phase 3에서는 "기록이 온체인 사실과 일치함"을 증명한다.

---

## M4 완료 기준

- [ ] 감사 로그 중간 삭제 → checksum 불일치 감지
- [ ] afterState 수정 → 감지
- [ ] chain integrity 검증 통과
- [ ] queryByResource / queryByActor 반환 형식 확인
- [ ] LedgerService 상태 전이 시 audit log 자동 기록 확인
- [ ] LogParams / VerifyResult 타입 정의 설명 가능
- [ ] DB Row Security Policy SQL 작성 가능
- [ ] prevChecksum Race Condition 원인 및 SELECT FOR UPDATE 해결책 설명 가능
- [ ] 대용량 환경 구간 검증(verifyChainRange) 필요성 이해
- [ ] S3 Glacier 백업 전략 및 5년 보존 설정 이해
