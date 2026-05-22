# M5 S28 — 온체인 식별자와 내부 사용자 ID의 매핑 설계

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(VASP) 위탁 아키텍처를 기반으로 합니다.  
> **Phase 1 맥락:** 지갑 주소는 VASP이 생성·관리합니다. 교보 시스템은 `userId ↔ walletAddr` 매핑만 내부 DB에 보관합니다. Phase 3에서는 자체 HSM이 주소를 파생합니다.

> 모듈 5 · 세션 28 · 1시간  
> 스켈레톤: `internal/apps/issuer-service/src/services/WalletMappingService.ts`

---

## 강의 파트 (25분)

### 1. 두 개의 식별자 공간이 공존한다

교보생명 시스템에는 두 세계가 있다.

```
교보 내부 세계:
  userId = "K-20240001"  (LDAP/SSO 기반 임직원·고객 ID)
  
블록체인 세계:
  walletAddr = "0xABCD...1234"  (ECDSA 공개키의 keccak256 해시)
```

이 두 식별자는 서로 아무 관계가 없다. NFT를 "K-20240001에게 발행"하려면 "0xABCD...1234" 주소를 알아야 한다. 이 연결이 없으면 발행 자체가 불가능하다.

`user_wallet_mapping` 테이블이 이 연결을 담당한다.

---

### 2. 왜 userId를 블록체인에 직접 저장하면 안 되는가

"userID를 컨트랙트에 저장해두면 매핑 테이블이 필요 없지 않나?"라는 생각이 들 수 있다.

**이유 1: 개인정보 보호법 위반**

"K-20240001"이라는 ID를 통해 교보생명 고객임을 알 수 있다. 공개 블록체인에 이것이 영구 저장되면 삭제가 불가능하다. GDPR과 개인정보보호법은 개인정보 삭제권을 보장하는데, 블록체인에 올라간 데이터는 삭제할 수 없다.

**이유 2: 지갑 교체 불가**

사용자가 지갑을 잃어버리거나 교체해야 할 때, 블록체인에 저장된 userId는 이미 특정 지갑 주소와 묶여 있다. 오프체인 매핑 테이블은 언제든 UPDATE가 가능하다.

**이유 3: 체인 전환 유연성**

EVM → XRPL로 체인이 바뀌면 지갑 주소 형식 자체가 달라진다. 매핑 테이블만 업데이트하면 비즈니스 로직은 건드리지 않아도 된다.

---

### 3. 1:1 vs 1:N 설계 결정

| 구조 | 장점 | 단점 | 당사 선택 |
|---|---|---|---|
| 1:1 (userId → 1개 walletAddr) | 단순, 추적 용이, 발행 대상 명확 | 지갑 교체 이력 없음 | Phase 1 기본 |
| 1:N (userId → 여러 walletAddr) | 다중 지갑, 디바이스별 분리 | 발행 대상 주소 선택 로직 복잡 | Phase 2+ |

Phase 1에서는 userId당 하나의 walletAddr만 허용한다. `UNIQUE (user_id)` 제약으로 DB 레벨에서 강제한다.

---

### 4. user_wallet_mapping 테이블 설계

```sql
CREATE TABLE user_wallet_mapping (
  id          SERIAL PRIMARY KEY,
  user_id     VARCHAR(64)  NOT NULL UNIQUE,  -- UNIQUE: userId당 1개 지갑만 허용
  wallet_addr VARCHAR(42)  NOT NULL,          -- 이더리움 주소 형식: 0x + 40자
  vasp_type   VARCHAR(16)  NOT NULL,          -- 'EXTERNAL' | 'KYOBO'
  verified    BOOLEAN      NOT NULL DEFAULT FALSE,  -- 소유권 검증 완료 여부
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  CONSTRAINT chk_vasp_type CHECK (vasp_type IN ('EXTERNAL', 'KYOBO'))
);

-- 지갑 주소로 역방향 조회 인덱스 (누가 이 지갑을 소유하는지 역조회)
CREATE INDEX idx_wallet_mapping_addr ON user_wallet_mapping(wallet_addr);
```

`verified` 컬럼은 지갑 등록 방식에 따라 초기값이 다르다.

| 등록 방식 | verified 초기값 | 이유 |
|---|---|---|
| VASP 수탁 (VASP, KYOBO) | `true` 즉시 | VASP가 지갑을 직접 생성 → 소유권 자명 |
| 비수탁 (사용자 자가관리) | `false` | 주소만 제출 — 소유권 미검증 상태 |

비수탁 지갑은 EIP-191 서명 검증(S29) 성공 후 `verified=true`로 업데이트된다.

`verified=false`인 지갑으로는 NFT 발행을 진행하면 안 된다.

---

### 5. 지갑 주소 등록 흐름 비교

**수탁 방식 (VASP EXTERNAL — Phase 1 기본)**

```
사용자 가입 완료
    │
    ▼
서버: VASP API 호출 → 지갑 자동 생성 (또는 기존 지갑 조회)
    │
    ▼
walletAddr 응답 → DB 저장, verified=true
(VASP가 private key 보관 + 지갑 생성 주체 → 소유권 자명, 별도 서명 불필요)
```

**비수탁 방식 (사용자 자가관리 — MetaMask 등)**

```
앱 로그인
    │
    ▼
사용자: 자신의 지갑 주소(0xABCD...) 서버에 제출
    │
    ▼
서버: nonce 생성 + 클라이언트 전달
    │
    ▼
사용자: eth_sign(userId:nonce 메시지) → signature 서버 전송
    │
    ▼
서버: ecrecover(메시지, signature) → 복원 주소 확인
    │
    ▼
복원 주소 == walletAddr → DB 저장, verified=true
```

비수탁 방식에서 서명이 필요한 이유는 S29에서 자세히 다룬다.

**KYOBO 방식 (Phase 4 내재화)**

```
사용자 가입 완료
    │
    ▼
서버: 내부 HSM/MPC로 지갑 직접 생성
    │
    ▼
walletAddr 생성 → DB 저장, verified=true
(교보가 직접 키 생성 주체 → 소유권 자명)
```

---

### 6. `getWalletAddr()` — 발행 요청마다 호출되는 메서드

```typescript
async getWalletAddr(userId: string): Promise<string> {
  // DB에서 매핑 조회
  const existing = await this.repo.findByUserId(userId);
  
  if (!existing) {
    // 매핑 없음 → 명시적 예외 (자동 생성 금지)
    throw new WalletNotFoundError(userId);
  }
  
  if (!existing.verified) {
    // 소유권 미검증 지갑으로는 발행 불가
    throw new WalletNotVerifiedError(userId);
  }
  
  return existing.walletAddr;
}
```

"매핑 없으면 자동으로 VASP에서 가져오면 되지 않나?" — 안 된다. 자동 생성은 운영자가 모르는 사이에 새 지갑이 생긴다는 뜻이다. 지갑 생성은 명시적 프로비저닝 프로세스(`WalletProvisioningService.provision()`)를 통해서만 해야 한다.

---

### 7. WalletMappingService 전체 공개 API

실제 코드에 있는 네 개의 공개 메서드:

```typescript
// 1. userId → walletAddr 조회 (NFT 발행 전 매번 호출)
async getWalletAddr(userId: string): Promise<string>

// 2. EIP-191 서명 검증 → verified=true 저장 (S29 실습)
async verifyOwnership(params: { userId, walletAddr, signature, nonce }): Promise<boolean>

// 3. 서명 검증용 일회성 nonce 생성 (GET /wallet/nonce)
generateNonce(userId: string): string

// 4. 원시 WalletMapping 객체 반환 (verified 상태 포함)
async getMapping(userId: string): Promise<WalletMapping | null>
```

각 메서드의 호출 시점:

| 메서드 | 호출 시점 |
|---|---|
| `getWalletAddr()` | NFT 발행 직전 — 발행 대상 주소 확인 |
| `generateNonce()` | `GET /wallet/nonce` — 서명 전 nonce 발급 |
| `verifyOwnership()` | `POST /wallet/verify` — 서명 제출 + 검증 |
| `getMapping()` | 프로비저닝 중복 체크, 관리자 조회 등 |

`getWalletAddr()`는 단순 조회처럼 보이지만 내부에서 "DB에 없으면 VASP 자동 프로비저닝 → 저장"까지 처리한다. `WalletProvisioningService`에서 명시적으로 `provision()`을 호출하지 않아도, `getWalletAddr()`가 lazy 프로비저닝 역할을 한다.

---

### 8. verified 상태 전이 — 등록 방식별 비교

```
수탁 방식 (VASP EXTERNAL / KYOBO):
  provision() 완료
       │
       ▼  verified = true  (즉시)
          ← VASP 또는 교보가 지갑을 직접 생성한 주체
          ← 소유권이 자명 → 별도 서명 검증 불필요
          ← NFT 발행 즉시 가능

비수탁 방식 (사용자 자가관리 — MetaMask 등):
  사용자가 지갑 주소 제출
       │
       ▼  verified = false  (DB 저장)
          ← 주소는 알지만 소유권 미검증
          ← 이 상태로 NFT 발행 불가
       │
  verifyOwnership() 성공  (S29 — EIP-191 서명 검증)
       │
       ▼  verified = true  (DB 업데이트)
          ← 사용자가 private key를 실제 보유함이 수학적으로 증명됨
          ← 이제 NFT 발행 가능
```

`verified` 컬럼이 있는 이유: 비수탁 지갑의 경우 주소 제출과 소유권 증명이 분리된 2단계 흐름이기 때문이다. 수탁 지갑은 VASP가 생성 주체이므로 1단계로 끝난다.

---

### 9. Repository 패턴 — M4 DatabaseClient와 같은 원칙

M4 `AuditLogService`는 `DatabaseClient` 인터페이스에 의존했다. S28의 `WalletMappingService`도 동일한 원칙:

```
M4:
  AuditLogService → DatabaseClient (인터페이스)
                         └── 실제 구현: PostgreSQL 클라이언트

M5:
  WalletMappingService → WalletMappingRepository (인터페이스)
                              ├── 실제 구현: PgWalletMappingRepository  ← 실습 과제
                              └── 테스트 구현: makeInMemoryWalletRepo()  ← 실습 과제
```

실제 코드의 인터페이스:

```typescript
export interface WalletMappingRepository {
  findByUserId(userId: string):         Promise<WalletMapping | null>;
  save(mapping: WalletMapping):         Promise<void>;
  findByWalletAddr(walletAddr: string): Promise<WalletMapping | null>;
}
```

서비스 코드에 SQL이 없다. `findByUserId()`, `save()` 같은 의미 있는 메서드만 호출한다. SQL은 Repository 구현체 안에만 있다.

이 패턴의 이점:
- 단위 테스트 시 In-Memory 구현체로 DB 없이 빠르게 실행
- PostgreSQL → 다른 DB 교체 시 서비스 코드 무변경
- 실습에서 `PgWalletMappingRepository` 구현 과제가 이 인터페이스를 기반으로 한다

---

## 실습 파트 (30분)

### 마이그레이션 작성

```sql
-- user_wallet_mapping 테이블 생성
CREATE TABLE user_wallet_mapping (
  id          SERIAL PRIMARY KEY,
  user_id     VARCHAR(64)  NOT NULL UNIQUE,
  wallet_addr VARCHAR(42)  NOT NULL,
  vasp_type   VARCHAR(16)  NOT NULL,
  verified    BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  CONSTRAINT chk_vasp_type CHECK (vasp_type IN ('EXTERNAL', 'KYOBO'))
);
CREATE INDEX idx_wallet_mapping_addr ON user_wallet_mapping(wallet_addr);
```

### WalletNotFoundError 에러 클래스

```typescript
export class WalletNotFoundError extends Error {
  constructor(userId: string) {
    super(`Wallet not found for user: ${userId}`);
    this.name = 'WalletNotFoundError';
  }
}

export class WalletNotVerifiedError extends Error {
  constructor(userId: string) {
    super(`Wallet not verified for user: ${userId}. Run wallet verification first.`);
    this.name = 'WalletNotVerifiedError';
  }
}
```

### VASP vs 코다 등록 흐름 시퀀스 다이어그램 작성 과제

강의를 보며 아래 시퀀스 다이어그램의 각 단계를 직접 채워보세요:

```
VASP 방식:
사용자  →  앱  →  서버(IssuerService)  →  DB
  │         │              │               │
  ├─로그인─▶│              │               │
  │         ├─walletAddr──▶│               │
  │         │          [?]                 │
  │         │◀─nonce───────┤               │
  ├─서명───▶│              │               │
  │         ├─signature───▶│               │
  │         │          [?]                 │
  │         │◀─200 OK──────┤               │

코다 방식:
서버(IssuerService)  →  VASP Custody API  →  DB
         │                      │               │
         ├─가입 완료 트리거       │               │
         ├─createWallet(userId)─▶│               │
         │◀─walletAddr──────────┤               │
         ├─saveMapping()────────────────────────▶│
```

---

### 7. WalletMappingRepository — 인터페이스와 구현 분리

> **[실습 과제]** 인터페이스()는 실제 코드에 있다.  구현체는 없다 — 아래를 직접 작성한다.

서비스 코드가 직접 SQL을 쓰지 않는다. M4 패턴과 동일하게 Repository 인터페이스로 의존성을 역전한다.

```typescript
// 인터페이스 — 서비스가 의존하는 계약
export interface WalletMappingRepository {
  findByUserId(userId: string):       Promise<WalletMapping | null>;
  save(mapping: WalletMapping):       Promise<void>;
  findByWalletAddr(walletAddr: string): Promise<WalletMapping | null>;
}
```

**PostgreSQL 구현체:**

```typescript
export class PgWalletMappingRepository implements WalletMappingRepository {
  constructor(private readonly db: DbClient) {}

  async findByUserId(userId: string): Promise<WalletMapping | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM user_wallet_mapping WHERE user_id = $1',
      [userId],
    );
    if (rows.length === 0) return null;
    return this._toModel(rows[0]!);
  }

  async save(mapping: WalletMapping): Promise<void> {
    // UPSERT — 이미 있으면 wallet_addr, vasp_type, verified 갱신
    await this.db.query(
      `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id)
       DO UPDATE SET wallet_addr = $2, vasp_type = $3, verified = $4`,
      [
        mapping.userId,
        mapping.walletAddr,
        mapping.vaspType,
        mapping.verified,
        mapping.createdAt.toISOString(),
      ],
    );
  }

  async findByWalletAddr(walletAddr: string): Promise<WalletMapping | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM user_wallet_mapping WHERE wallet_addr = $1',
      [walletAddr.toLowerCase()],
    );
    if (rows.length === 0) return null;
    return this._toModel(rows[0]!);
  }

  private _toModel(row: Record<string, unknown>): WalletMapping {
    return {
      userId:    row['user_id']    as string,
      walletAddr: row['wallet_addr'] as string,
      vaspType:  row['vasp_type']  as VaspType,
      verified:  row['verified']   as boolean,
      createdAt: new Date(row['created_at'] as string),
    };
  }
}
```

`ON CONFLICT (user_id) DO UPDATE` — 지갑 교체 시나리오를 처리한다. INSERT를 시도하다 `user_id` 충돌이 나면 `wallet_addr`와 `verified`를 최신 값으로 갱신한다. 별도 UPDATE 쿼리 없이 한 번의 SQL로 처리된다.

---

### 8. In-Memory 구현 — 테스트용 Mock

> **[실습 과제]** 단위 테스트용 In-Memory 구현체. 실제 코드에 없으므로 직접 작성한다.

실제 DB 없이 단위 테스트를 돌리려면 In-Memory 구현체를 만든다.

```typescript
export function makeInMemoryWalletRepo(): WalletMappingRepository & { store: Map<string, WalletMapping> } {
  const store = new Map<string, WalletMapping>();

  return {
    store,
    async findByUserId(userId) {
      return store.get(userId) ?? null;
    },
    async save(mapping) {
      // lowercase 정규화 — DB와 동일한 동작 보장
      store.set(mapping.userId, { ...mapping, walletAddr: mapping.walletAddr.toLowerCase() });
    },
    async findByWalletAddr(walletAddr) {
      const lower = walletAddr.toLowerCase();
      for (const m of store.values()) {
        if (m.walletAddr === lower) return m;
      }
      return null;
    },
  };
}
```

테스트에서 사용:

```typescript
describe('WalletMappingService', () => {
  it('미등록 userId → WalletNotFoundError', async () => {
    const repo = makeInMemoryWalletRepo();
    const svc  = new WalletMappingService(repo, mockVasp, mockVerifier);

    await expect(svc.getWalletAddr('unknown-user')).rejects.toThrow(WalletNotFoundError);
  });

  it('save() 후 findByUserId() → 동일 주소 반환', async () => {
    const repo = makeInMemoryWalletRepo();
    await repo.save({
      userId: 'user1', walletAddr: '0xABCD', vaspType: 'EXTERNAL',
      verified: true, createdAt: new Date(),
    });

    const result = await repo.findByUserId('user1');
    expect(result?.walletAddr).toBe('0xabcd');  // lowercase 정규화 확인
  });

  it('지갑 교체 → 최신 주소만 남음 (UPSERT)', async () => {
    const repo = makeInMemoryWalletRepo();
    await repo.save({ userId: 'user1', walletAddr: '0xOLD', vaspType: 'EXTERNAL', verified: true, createdAt: new Date() });
    await repo.save({ userId: 'user1', walletAddr: '0xNEW', vaspType: 'EXTERNAL', verified: true, createdAt: new Date() });

    const result = await repo.findByUserId('user1');
    expect(result?.walletAddr).toBe('0xnew');
    expect(repo.store.size).toBe(1);  // 행이 2개가 되면 안 됨
  });
});
```

---

### 9. saveMapping() vs repo.save() — 네이밍 혼동 주의

강의 다이어그램에서 `saveMapping()`이라고 표기했지만 실제 서비스 코드에서는 `repo.save(mapping)`을 직접 호출한다. `WalletMappingService`가 외부에 제공하는 메서드는 없고, `WalletProvisioningService`가 `WalletMappingService`의 내부 `repo`를 통해 저장한다.

```
WalletProvisioningService.provision()
  └─ this.walletMapping.saveMapping() ← 다이어그램 표기
       └─ repo.save(mapping)          ← 실제 코드
            └─ SQL UPSERT              ← DB 실행
```

외부에서 보이는 인터페이스(`saveMapping`)와 내부 구현(`repo.save`)을 구분하는 것이 서비스 레이어의 역할이다.

---

## 완료 기준

- [ ] user_wallet_mapping 마이그레이션 완성
- [ ] WalletNotFoundError, WalletNotVerifiedError 정의
- [ ] getWalletAddr() 미등록 userId → WalletNotFoundError
- [ ] getWalletAddr() verified=false → WalletNotVerifiedError
- [ ] PgWalletMappingRepository.save() UPSERT 구현 확인
- [ ] makeInMemoryWalletRepo() 테스트 통과 — 교체, 정규화, 중복 방지
- [ ] 등록 흐름 시퀀스 다이어그램 완성
