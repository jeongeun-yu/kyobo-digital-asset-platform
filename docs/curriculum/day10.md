# Day 10 — 내부 원장 설계 + 감사 로그

**시간**: 3시간 (180분)  
**핵심 질문**: 블록체인 이벤트는 외부 진실이다. 그 진실을 내부 DB와 어떻게 동기화하고, 금융 규제 기준으로 어떻게 증명하는가?

---

## 세션 구조

| 시간 | 내용 |
|---|---|
| 00:00~00:40 | 1부: 내부 원장의 역할 — 온체인과 오프체인의 경계 |
| 00:40~01:20 | 실습 1: DB 스키마 설계 + LedgerService 구현 |
| 01:20~02:10 | 실습 2: AuditLog 서비스 구현 + 금융 규제 요건 |
| 02:10~02:50 | 실습 3: 잔액 재조정(Reconcile) 로직 |
| 02:50~03:00 | 마무리: 원장의 단일 진실 원천 |

---

## 1부: 내부 원장의 역할 (00:00~00:40)

### 1-1. 왜 내부 원장이 필요한가 (15분)

**토킹포인트:**

> "교보생명이 블록체인을 쓴다고 해서 Oracle의 DB를 버릴 수 없습니다. 고객 잔액 조회, 고객센터 문의, 내부 감사 — 모두 DB가 필요합니다. 그런데 블록체인 위에도 진실이 있습니다. 이 두 진실을 어떻게 관리할 것인가가 오늘의 주제입니다."

**온체인 vs 오프체인 진실:**

| 항목 | 온체인 (단일 진실) | 오프체인 내부 원장 (운영 편의) |
|---|---|---|
| NFT 소유권 | `ownerOf(tokenId)` | `user_nft_holdings` 테이블 |
| 트랜잭션 기록 | `Transfer` 이벤트 | `processed_events` 테이블 |
| 발행 요청 | — | `mint_requests` 테이블 (PENDING→CONFIRMED) |
| 감사 증적 | 이벤트 로그 | `audit_log` 테이블 (append-only) |

> "온체인이 단일 진실입니다. 오프체인 원장은 **항상 온체인에서 파생**됩니다. 이 방향이 절대 역전되어서는 안 됩니다."

### 1-2. DB 스키마 설계 원칙 (25분)

**핵심 테이블 4개:**

```sql
-- 1. 사용자 NFT 보유 현황 (온체인에서 파생, 캐시)
CREATE TABLE user_nft_holdings (
  id              BIGSERIAL PRIMARY KEY,
  user_id         VARCHAR(64) NOT NULL,
  token_id        BIGINT NOT NULL,
  contract_addr   VARCHAR(42) NOT NULL,
  chain_id        INT NOT NULL,
  acquired_at     TIMESTAMPTZ NOT NULL,
  released_at     TIMESTAMPTZ,           -- NULL = 현재 보유중
  on_chain_tx     VARCHAR(66) NOT NULL,  -- 취득 TX hash
  UNIQUE(token_id, contract_addr, chain_id)
);

-- 2. 처리된 온체인 이벤트 (idempotency 보장)
CREATE TABLE processed_events (
  id              BIGSERIAL PRIMARY KEY,
  tx_hash         VARCHAR(66) NOT NULL,
  log_index       INT NOT NULL,
  event_name      VARCHAR(64) NOT NULL,
  block_number    BIGINT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload         JSONB NOT NULL,
  UNIQUE(tx_hash, log_index)             -- 중복 방지 composite key
);

-- 3. 발행 요청 상태머신
CREATE TABLE mint_requests (
  id              BIGSERIAL PRIMARY KEY,
  request_id      UUID NOT NULL UNIQUE,
  user_id         VARCHAR(64) NOT NULL,
  policy_id       VARCHAR(64) NOT NULL,
  status          VARCHAR(16) NOT NULL   -- PENDING|SUBMITTED|CONFIRMED|FAILED
                  CHECK (status IN ('PENDING','SUBMITTED','CONFIRMED','FAILED')),
  tx_hash         VARCHAR(66),           -- SUBMITTED 이후 채워짐
  token_id        BIGINT,                -- CONFIRMED 이후 채워짐
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_msg       TEXT
);

-- 4. 감사 로그 (append-only, 절대 UPDATE/DELETE 금지)
CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  event_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor           VARCHAR(64) NOT NULL,  -- system | user_id | admin_id
  action          VARCHAR(64) NOT NULL,  -- MINT_REQUESTED, TX_SUBMITTED, etc.
  resource_type   VARCHAR(32) NOT NULL,
  resource_id     VARCHAR(128) NOT NULL,
  before_state    JSONB,
  after_state     JSONB NOT NULL,
  ip_address      INET,
  session_id      UUID,
  checksum        VARCHAR(64) NOT NULL   -- SHA-256(event_time||actor||action||resource_id||after_state)
);
```

> "audit_log에 UPDATE나 DELETE를 허용하는 순간 감사 로그가 아닙니다. PostgreSQL Row Security Policy로 이 테이블은 INSERT만 허용합니다."

---

## 실습 1: LedgerService 구현 (00:40~01:20)

### Step 1 — 스켈레톤 확인 (10분)

```bash
cat packages/core-banking/src/ledger/LedgerService.ts
```

**구현할 메서드:**
- `recordNftAcquired()` — Transfer 이벤트 수신 시 NFT 보유 기록
- `recordNftReleased()` — Transfer OUT 이벤트 수신 시 보유 해제
- `getMintRequestStatus()` — 발행 요청 상태 조회
- `updateMintRequest()` — 상태머신 전이

### Step 2 — 상태머신 전이 규칙 구현 (20분)

```typescript
// 허용된 전이만 통과시키는 guard
const VALID_TRANSITIONS: Record<MintStatus, MintStatus[]> = {
  PENDING:    ['SUBMITTED', 'FAILED'],
  SUBMITTED:  ['CONFIRMED', 'FAILED'],
  CONFIRMED:  [],            // 종단 상태
  FAILED:     [],            // 종단 상태
};
```

**실습 과제:**
1. `LedgerService.ts`에서 `// TODO: implement state transition guard` 찾아서 구현
2. 잘못된 전이(CONFIRMED→PENDING 등) 시도 시 `InvalidStateTransitionError` throw
3. 단위 테스트 실행: `pnpm test --filter=core-banking`

### Step 3 — 이벤트 중복 처리 방어 (10분)

```typescript
// processed_events INSERT 시 ON CONFLICT DO NOTHING
// 이미 처리된 이벤트는 조용히 skip
const result = await db.query(`
  INSERT INTO processed_events (tx_hash, log_index, event_name, block_number, payload)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (tx_hash, log_index) DO NOTHING
  RETURNING id
`, [txHash, logIndex, eventName, blockNumber, JSON.stringify(payload)]);

if (result.rows.length === 0) {
  // 이미 처리된 이벤트 — 멱등성 보장, 정상 종료
  return { skipped: true };
}
```

---

## 실습 2: AuditLog 서비스 구현 (01:20~02:10)

### Step 1 — 금융 규제 감사 요건 이해 (15분)

**토킹포인트:**

> "금융감독원 전자금융감독규정 §34: 접근 기록은 1년 이상 보존. 가상자산이용자보호법 §15: 거래 기록 5년 보존. 이 요건들이 audit_log 테이블 설계에 직접 영향을 줍니다."

**감사 추적 필수 항목:**

| 항목 | 규제 근거 | 구현 |
|---|---|---|
| 누가 (Who) | 전금법 §34 | `actor` 컬럼 |
| 언제 (When) | 가상자산법 §15 | `event_time` (microsecond precision) |
| 무엇을 (What) | 가상자산법 §15 | `action` + `resource_type` + `resource_id` |
| 변경 전후 (Before/After) | 금감원 IT감사 가이드 | `before_state`, `after_state` JSONB |
| 무결성 (Integrity) | ISMS-P 인증 기준 | `checksum` SHA-256 |

### Step 2 — AuditLogService 구현 (25분)

```bash
cat packages/core-banking/src/audit/AuditLogService.ts
```

**구현할 메서드:**
- `log()` — 단건 감사 로그 기록 + checksum 자동 생성
- `verify()` — checksum 재계산 후 DB값 비교 (무결성 검증)
- `queryByResource()` — 리소스별 감사 이력 조회

**실습 과제:**
1. `AuditLogService.ts`에서 `// TODO: generate checksum` 찾아서 구현
   - 입력: `event_time + actor + action + resource_id + JSON.stringify(after_state)`
   - 알고리즘: `crypto.createHash('sha256')`
2. `verifyIntegrity(id: number)` 구현 — DB에서 읽어 checksum 재계산 후 비교

### Step 3 — 미들웨어 연결 (20분)

```typescript
// Express 미들웨어: 모든 상태 변경 API 자동 감사 기록
export function auditMiddleware(auditLog: AuditLogService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      // TODO: res.locals에서 before/after state 추출 후 auditLog.log() 호출
      return originalJson(body);
    };
    next();
  };
}
```

---

## 실습 3: 잔액 재조정(Reconcile) (02:10~02:50)

### Step 1 — 재조정이 필요한 이유 (10분)

**토킹포인트:**

> "이벤트 파이프라인이 완벽해도 DB와 온체인이 틀어질 수 있습니다. 서버 재시작, 네트워크 순단, Reorg — 이런 상황에서도 교보생명 원장은 정확해야 합니다. Reconcile은 그 보험입니다."

**재조정 시나리오:**

```
시나리오 1: 이벤트 누락
  → 온체인: tokenId 42 → user_A 보유
  → DB: user_nft_holdings에 tokenId 42 없음
  → 재조정: DB에 INSERT + 감사 로그 RECONCILE_INSERT

시나리오 2: 데이터 불일치
  → 온체인: tokenId 42 → user_B 소유
  → DB: tokenId 42 → user_A 소유 기록
  → 재조정: DB 업데이트 + 감사 로그 RECONCILE_UPDATE + 알림
```

### Step 2 — ReconcileService 구현 (30분)

```bash
cat packages/core-banking/src/reconcile/ReconcileService.ts
```

**구현 흐름:**
1. 체인에서 현재 NFT 보유자 목록 조회 (`IChainAdapter.getTokenOwners()`)
2. DB의 `user_nft_holdings` (released_at IS NULL) 조회
3. 두 집합 비교 → 누락/불일치 탐지
4. 차이 항목 수정 + 감사 로그 기록
5. 재조정 결과 리포트 반환

**실습 과제:**
- `ReconcileService.reconcile()` 메서드에서 `// TODO` 3곳 구현
- 실행: `pnpm reconcile --dry-run` (실제 변경 없이 차이만 출력)

---

## 마무리: 원장의 단일 진실 원천 (02:50~03:00)

**핵심 3줄:**

> 1. **온체인이 진실, 오프체인은 파생이다.** DB 원장은 항상 온체인 이벤트에서 파생되어야 하며, 역방향 동기화는 설계 원칙 위반이다.
> 2. **감사 로그는 append-only다.** UPDATE/DELETE를 허용하는 순간 금융 규제 감사를 통과할 수 없다. checksum으로 무결성을 증명한다.
> 3. **Reconcile은 방어선이다.** 이벤트 파이프라인이 완벽해도 주기적 재조정으로 온체인-오프체인 일치를 보장한다.

---

## 다음 시간 예고

> "원장과 감사 로그를 갖췄습니다. 그런데 VASP가 TX를 실패시키거나 체인 Reorg가 발생하면 어떻게 됩니까? Day 11에서는 그 상황을 직접 재현하고, 원장 상태머신이 어떻게 복구하는지 구현합니다."
