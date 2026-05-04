# M4 S23 — 온체인만으로 부족한 이유 · 내부 원장 필요성과 데이터 모델 설계

> 모듈 4 · 세션 23 · 1시간  
> 스켈레톤: `dmz/packages/core-banking/src/ledger/LedgerService.ts`

---

## 강의 파트 (25분)

### 1. 블록체인만 쓰면 안 되나? — 실무 현실

처음 블록체인 시스템을 설계하는 사람들이 거의 항상 빠지는 함정이 있다.

> "NFT 소유권은 블록체인에 다 기록돼 있으니까, 오프체인 DB는 필요 없지 않나?"

이 생각이 왜 틀렸는지 구체적으로 따져보자.

---

**문제 1: 조회 성능**

`balanceOf(userAddress)` 한 번 호출하는 데 외부 RPC 네트워크를 거쳐야 한다. 응답 시간 평균 200~500ms. 사용자 앱에서 NFT 목록 페이지를 열 때마다 이걸 호출하면 페이지 로딩 2~3초.

DB 조회는 5ms 이하. 차이가 100배다.

---

**문제 2: 비즈니스 맥락을 블록체인에 담을 수 없다**

"userId=K-20240001이 보험 계약 ID #89234 기준으로 걷기 이벤트 NFT를 받았다"는 정보를 블록체인에 넣으면 어떻게 될까?

- 개인정보(userId)가 공개 블록체인에 영구 기록된다
- 규제상 삭제 불가 → GDPR, 개인정보보호법 위반

그래서 블록체인에는 지갑 주소(0xABCD...)만 있고, "이 주소가 누구 것인가"는 오프체인 DB에만 있어야 한다.

---

**문제 3: 온체인에서는 "진행 중인 요청"을 추적할 수 없다**

TX를 VASP에 제출했다. 아직 블록에 안 실렸다. 이 시점에 온체인 상태는?

```
balanceOf(user) = 0  ← 아직 발행 안 됨
```

발행 요청이 "제출됨 / 대기 중 / 실패"인지 온체인은 모른다. 그 상태를 추적하는 곳이 오프체인 원장이다.

---

**문제 4: 동일 이벤트 중복 처리**

M2에서 배운 것처럼, Redis Streams는 at-least-once delivery다. 같은 NFTIssued 이벤트가 두 번 올 수 있다. 온체인에는 이미 발행됐는데, 두 번째 이벤트에서 또 발행 요청을 보내면?

→ 사용자가 NFT를 2개 받는다.

이걸 막는 "이미 처리한 이벤트 목록"도 오프체인 DB에 있어야 한다.

---

### 2. 오프체인 원장의 역할

오프체인 원장은 블록체인의 **캐시이자 보조 추적 장치**다.

핵심 원칙:

> **온체인이 단일 진실(source of truth). 오프체인은 온체인에서 파생된 캐시.**

- 오프체인 원장이 틀렸을 때 → 온체인 기준으로 보정 (ReconcileService, S25)
- 온체인이 틀렸을 때 → **없다.** 이미 확정된 블록이기 때문

이 원칙이 무너지면 "원장에서 보이는 NFT"와 "실제로 블록체인에 있는 NFT"가 달라지는 사고가 난다.

---

### 3. 4개 테이블이 각각 무엇을 담당하는가

**① `mint_requests` — "진행 중인 발행 요청 추적"**

사용자가 걷기 목표 달성 → NFT 발행 요청 생성 → VASP에 TX 제출 → 블록에 포함 대기 → 확정. 이 과정이 최소 수십 초, 길면 몇 분 걸린다. 그 사이 상태를 추적하는 테이블이다.

상태: `PENDING → SUBMITTED → MINED → FINALIZED → CONFIRMED / FAILED / REORGED`

**② `processed_events` — "이미 처리한 이벤트 목록"**

블록체인 이벤트(NFTIssued)를 처음 받았을 때만 처리하고, 재전달 시 무시하기 위한 테이블.

핵심은 `(tx_hash, log_index)` 복합 UNIQUE 제약이다. 왜 `tx_hash`만으로 안 되냐? 한 트랜잭션 안에 여러 이벤트가 있을 수 있다. `log_index`가 각 이벤트를 구분한다.

**③ `user_nft_holdings` — "지금 누가 뭘 가지고 있나"**

현재 보유 현황 캐시. 앱에서 "내 NFT" 목록을 보여줄 때 이 테이블을 읽는다. ReconcileService(S25)가 주기적으로 온체인과 비교한다.

**④ `audit_log` — "무슨 일이 있었나 — 변경 불가 기록"**

금융 규제 요구사항:
- 전자금융감독규정 §34: 접근 기록 1년 이상 보존
- 가상자산이용자보호법 §15: 거래 기록 5년 보존

레코드는 **한 번 삽입되면 수정/삭제 불가**다. 보정이 필요하면 새 레코드를 추가한다. S26에서 상세히 다룬다.

---

### 4. 쓰기 경로 — 각 테이블에 누가 언제 쓰는가

```
① 사용자가 걷기 목표 달성
        │
        ▼
② IssuerService → mint_requests INSERT (status=PENDING)
                 → audit_log INSERT (MINT_REQUESTED)
        │
        ▼
③ TxStateMachineService → VASP에 TX 제출
   → mint_requests UPDATE (status=SUBMITTED, txHash=0x...)
   → audit_log INSERT (STATUS_SUBMITTED)
        │
        ▼ (블록에 포함됨)
        │
        ▼
④ ConsumerGroupWorker가 NFTIssued 이벤트 수신
        │
        ├─ processed_events INSERT (tx_hash, log_index) ← 중복 방지
        │       이미 있으면 → 종료 (중복 이벤트)
        │       없으면 → 계속
        │
        ├─ mint_requests UPDATE (status=CONFIRMED, tokenId=...)
        │
        ├─ user_nft_holdings INSERT (userId, tokenId)
        │
        ├─ audit_log INSERT (STATUS_CONFIRMED)
        │
        └─ Java Gateway 호출 → 영구 금융 원장 기록
```

---

### 5. 역방향 수정 금지 — 이게 왜 "절대"인가

ReconcileService를 처음 보면 이런 생각이 든다:

> "원장이 틀렸으면 그냥 원장을 고치면 되잖아? 왜 역방향 금지야?"

원장은 **캐시**다. 캐시만 수정하면 다음 Reconcile 때 또 불일치가 잡힌다. 근본 원인이 해결된 게 아니라 증상만 숨긴 거다.

더 중요한 이유: **원장 → 온체인 수정 코드가 있으면** 감사 추적이 불가능해진다. 원장 데이터를 조작해서 임의의 NFT를 발행할 수 있는 경로가 생긴다. 이건 보안 취약점이다.

ReconcileService가 할 수 있는 건 딱 두 가지:
1. 불일치 **감지**
2. 담당자에게 **알림**

보정은 반드시 사람이 판단 후 정상 발행 프로세스(IssuerService)를 통해 새 TX로 처리한다.

---

## 실습 파트 (30분)

### 마이그레이션 작성

```sql
-- ① mint_requests
CREATE TABLE mint_requests (
  request_id   UUID PRIMARY KEY,
  user_id      VARCHAR(64)  NOT NULL,
  policy_id    VARCHAR(64)  NOT NULL,
  status       VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
  tx_hash      VARCHAR(66),
  token_id     NUMERIC,
  error_msg    TEXT,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- ② processed_events — (tx_hash, log_index) 복합 UNIQUE가 핵심
CREATE TABLE processed_events (
  id           SERIAL PRIMARY KEY,
  tx_hash      VARCHAR(66)  NOT NULL,
  log_index    INTEGER      NOT NULL,
  event_name   VARCHAR(64)  NOT NULL,
  block_number NUMERIC      NOT NULL,
  payload      JSONB,
  processed_at TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (tx_hash, log_index)           -- 이 줄이 중복 방지의 전부
);
CREATE INDEX idx_processed_events_block ON processed_events(block_number);

-- ③ user_nft_holdings
CREATE TABLE user_nft_holdings (
  id          SERIAL PRIMARY KEY,
  user_id     VARCHAR(64) NOT NULL,
  token_id    NUMERIC     NOT NULL,
  policy_id   VARCHAR(64),
  acquired_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, token_id)
);
CREATE INDEX idx_holdings_user ON user_nft_holdings(user_id);

-- ④ audit_log — INSERT-only (Row Security Policy 별도 적용)
CREATE TABLE audit_log (
  id            SERIAL PRIMARY KEY,
  event_time    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  actor         VARCHAR(128) NOT NULL,
  action        VARCHAR(64)  NOT NULL,
  resource_type VARCHAR(64)  NOT NULL,
  resource_id   VARCHAR(256) NOT NULL,
  before_state  JSONB,
  after_state   JSONB        NOT NULL,
  ip_address    INET,
  session_id    VARCHAR(128),
  checksum      VARCHAR(64)  NOT NULL
);
```

### 스켈레톤 코드와 연결

```typescript
// LedgerService.ts — 스켈레톤에 이미 있는 구조
export class LedgerService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly auditLog: AuditLogClient,
  ) {}

  async createMintRequest(userId: string, policyId: string): Promise<MintRequest> {
    const requestId = randomUUID();
    // TODO: DB INSERT into mint_requests (requestId, userId, policyId, status='PENDING')
    // TODO: auditLog.log({ actor: 'system', action: 'MINT_REQUESTED', ... })
    throw new Error('Not implemented');
  }

  async recordProcessedEvent(
    txHash: string,
    logIndex: number,
    eventName: string,
    blockNumber: bigint,
    payload: unknown,
  ): Promise<ProcessedEventResult> {
    // TODO:
    // INSERT INTO processed_events (tx_hash, log_index, ...)
    // ON CONFLICT (tx_hash, log_index) DO NOTHING   ← 이게 핵심
    // RETURNING id
    //
    // rows.length === 0 → { skipped: true }   (중복 이벤트)
    // rows.length === 1 → { skipped: false }  (신규 이벤트)
    throw new Error('Not implemented');
  }
}
```

`ON CONFLICT DO NOTHING`이 왜 중요한지 이해했으면 이 코드가 왜 이렇게 생겼는지 자연스럽게 보인다. `processed_events` 테이블의 UNIQUE 제약과 이 SQL이 한 쌍이다.

---

## 완료 기준

- [ ] 4개 테이블 마이그레이션 완성
- [ ] UNIQUE 제약 + 인덱스 설계
- [ ] "역방향 수정 금지"를 이유와 함께 설명 가능
