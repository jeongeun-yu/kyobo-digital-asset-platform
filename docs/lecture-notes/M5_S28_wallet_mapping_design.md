# M5 S28 — 온체인 식별자와 내부 사용자 ID의 매핑 설계

> 모듈 5 · 세션 28 · 1시간  
> 스켈레톤: `dmz/apps/issuer-service/src/services/WalletMappingService.ts`

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

`verified` 컬럼이 중요하다. EXTERNAL(월렛원) 방식에서는 사용자가 서명을 통해 지갑 소유권을 증명해야 `verified=true`가 된다(S29에서 구현). KYOBO 방식에서는 VASP가 지갑을 생성하므로 즉시 `verified=true`.

`verified=false`인 지갑으로는 NFT 발행을 진행하면 안 된다.

---

### 5. 지갑 주소 등록 흐름 비교

**월렛원 방식 (EXTERNAL — 사용자 자기관리형)**

```
앱 로그인
    │
    ▼
사용자 MetaMask(또는 월렛원 앱) 연결 → walletAddr 서버 전송
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

왜 서명이 필요한지는 S29에서 자세히 다룬다.

**코다 방식 (KYOBO — Custody 시스템)**

```
사용자 가입 완료
    │
    ▼
서버: Custody API 호출 → 지갑 자동 생성
    │
    ▼
walletAddr 응답 → DB 저장, verified=true
(VASP가 private key 보관 → 사용자 서명 불필요)
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

### 월렛원 vs 코다 등록 흐름 시퀀스 다이어그램 작성 과제

강의를 보며 아래 시퀀스 다이어그램의 각 단계를 직접 채워보세요:

```
월렛원 방식:
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

## 완료 기준

- [ ] user_wallet_mapping 마이그레이션 완성
- [ ] WalletNotFoundError 정의
- [ ] getWalletAddr() 미등록 userId → WalletNotFoundError
- [ ] 등록 흐름 시퀀스 다이어그램 완성
