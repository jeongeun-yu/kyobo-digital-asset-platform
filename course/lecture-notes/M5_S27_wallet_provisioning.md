# M5 S27 — 사용자 레이어 진입점 설계 · VASP별 지갑 프로비저닝 분기

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(VASP) 위탁 아키텍처를 기반으로 합니다.  
> **Phase 1 맥락:** 지갑 생성은 `vaspAdapter.createWallet()`을 통해 VASP에 위탁합니다. Phase 3에서 교보생명이 직접 VASP 인가를 취득한 이후에는 자체 HSM/MPC로 지갑을 생성하는 `KyoboVASPAdapter`로 교체됩니다.

> 모듈 5 · 세션 27 · 1시간  
> 실습 파일: `course/exercises/M5/S27_wallet_provisioning.ts`  
> 실행: `npm run exercise:s27`

---

## 강의 파트 (20분)

### 1. NFT를 발행하기 전에 반드시 필요한 것

M4에서 원장과 감사 로그를 완성했다. 이제 실제 비즈니스 로직이다.

사용자에게 NFT를 발행하려면 두 가지가 필요하다:

1. **누구에게 발행할 것인가**: 교보 내부 userId (예: K-20240001)
2. **어느 주소로 발행할 것인가**: 블록체인 지갑 주소 (예: 0xABCD...)

이 두 가지가 연결되지 않으면 발행 불가능하다. 이 연결이 "지갑 프로비저닝"이다.

---

### 2. 지갑 등록 방식은 두 가지로 나뉜다

Phase 1에서 사용자의 지갑 주소를 시스템에 등록하는 방식은 크게 두 가지다.

| 방식 | private key 위치 | 지갑 주소 출처 | verified 저장 |
|---|---|---|---|
| **수탁 (Custodial)** — Phase 1 기본 | VASP(VASP) 서버 | VASP API 응답 | `true` 즉시 — VASP가 소유권 보장 |
| **비수탁 (Non-Custodial)** — 선택적 지원 | 사용자 본인 | 사용자가 직접 제출 | `false` → EIP-191 서명 후 `true` (S29) |

그리고 교보 내재화(Phase 4):

| VASP 유형 | 예시 | 지갑 관리 주체 | 서버 처리 방식 |
|---|---|---|---|
| EXTERNAL 수탁 | VASP, KorbitCustody | VASP Custody 시스템 | VASP API 호출 → 지갑 주소 조회 → `verified: true` |
| KYOBO | Phase 4 내재화 | 교보 내부 HSM | 직접 생성 → DB 저장 → `verified: true` |

**수탁(Custodial) 방식 — Phase 1 현재:**
VASP(VASP)가 사용자를 위한 Custody 지갑을 생성하고 private key를 보관한다. 서버는 VASP API를 호출해 지갑 주소를 받아온다. VASP가 직접 생성한 지갑이므로 소유권이 자명하다 — 별도 서명 검증 없이 `verified: true`로 저장한다.

**비수탁(Non-Custodial) 방식 — Phase 1 선택적:**
사용자가 MetaMask 같은 자가관리 지갑을 직접 교보 시스템에 등록하는 경우다. 이때는 사용자가 해당 주소의 private key를 실제로 보유하고 있는지 증명해야 한다. 주소만 제출하는 것만으로는 소유권을 알 수 없다 — EIP-191 서명 검증이 필요하다(S29).

**KYOBO 방식**: Phase 4에서 교보가 직접 HSM(Hardware Security Module)으로 키를 관리하는 내재화 단계. Phase 1에서는 미구현이지만 코드 구조는 지금부터 준비해둔다.

---

### 3. 단일 진입점 설계 — 컨트롤러는 분기하지 않는다

만약 컨트롤러에서 VASP 유형에 따라 분기한다면:

```typescript
// ❌ 나쁜 설계 — VASP가 바뀔 때마다 컨트롤러 수정 필요
app.post('/api/wallet/provision', async (req, res) => {
  if (req.body.vaspType === 'EXTERNAL') {
    const addr = await vaspClient.getWalletAddr(req.body.userId);
    await walletMapping.save(req.body.userId, addr, 'EXTERNAL');
  } else if (req.body.vaspType === 'KYOBO') {
    const addr = await vaspClient.createWallet(req.body.userId);
    await walletMapping.save(req.body.userId, addr, 'KYOBO');
  }
  // VASP 추가할 때마다 여기를 수정해야 함
});
```

`POST /api/wallet/provision` 단일 엔드포인트 → `WalletProvisioningService.provision(userId, vaspType)`에서 내부 분기:

```
[Controller]
    POST /api/wallet/provision { userId, vaspType }
         ↓
[WalletProvisioningService.provision(userId, vaspType)]
    ├─ EXTERNAL → vaspClient.getWalletAddr(userId)
    ├─ KYOBO    → vaspClient.createWallet(userId)
    └─ 기타     → UnsupportedVaspError
         ↓
[WalletMappingService.saveMapping(userId, walletAddr, vaspType)]
```

컨트롤러는 요청을 받아서 서비스에 위임하기만 한다. VASP가 새로 추가돼도 컨트롤러는 건드리지 않는다.

---

### 4. WalletProvisioningService 역할 범위

```
WalletProvisioningService (S27)
    → 지갑 주소를 "획득"하는 역할 (VASP API 호출)
    → 최초 등록 시에만 호출됨

WalletMappingService (S28~S29)
    → 획득한 주소를 "관리"하는 역할
    → userId ↔ walletAddr 매핑 DB 조회/저장
    → 이후 모든 발행 요청에서 getWalletAddr() 사용
```

`provision()` 이후에는 `WalletMappingService.getWalletAddr(userId)`만 호출한다. 매번 VASP API를 호출하지 않는다.

---

### 5. M5 전체 의존 관계 아키텍처

S27~S29가 완성되면 아래 구조가 된다.

```
[컨트롤러]
  POST /api/wallet/provision
         │
         ▼
[WalletProvisioningService]         ← S27 실습
  ├── ExternalVaspClient (인터페이스)
  │       └── 구현체: WalletWon HTTP 클라이언트
  │            → getWalletAddr(userId): 기존 custodial 지갑 조회
  │            → createWallet(userId):  신규 지갑 생성 (Phase 4)
  │
  └── WalletMappingService           ← S28~S29 실습
            ├── WalletMappingRepository (인터페이스)
            │       └── 구현체: PgWalletMappingRepository → PostgreSQL
            ├── ExternalVaspWalletClient (인터페이스)
            └── SignatureVerifier (인터페이스)
                     └── 구현체: EthersSignatureVerifier (S29)
```

`WalletProvisioningService`는 두 가지에만 의존한다.

1. `ExternalVaspClient` — VASP API 호출 (지갑 주소 획득)
2. `WalletMappingService` — 획득한 주소를 DB에 저장·조회

S27은 이 두 의존성이 어떻게 연결되는지를 다루고, S28~S29는 `WalletMappingService` 내부를 완성한다.

---

### 6. ExternalVaspClient 인터페이스 — Phase 전환을 위한 추상화

실제 코드의 인터페이스 정의:

```typescript
interface ExternalVaspClient {
  getWalletAddr(userId: string): Promise<string>;  // 기존 custodial 지갑 조회
  createWallet(userId: string):  Promise<string>;  // 내부 신규 생성 (Phase 4)
}
```

`WalletProvisioningService`가 **인터페이스**에 의존하는 이유:

| Phase | 구현체 | 내용 |
|---|---|---|
| Phase 1 (현재) | `WalletWonAdapter` | VASP REST API 호출 |
| Phase 3 | `KyoboCustodyAdapter` | 교보 자체 HSM/MPC |

Phase 1 → Phase 3 전환 시 `WalletProvisioningService` 코드는 한 글자도 바뀌지 않는다. 생성자에 주입하는 구현체만 교체한다.

```typescript
// Phase 1 — 현재
new WalletProvisioningService(new WalletWonAdapter(apiKey), walletMapping);

// Phase 3 — 교체 후 (이 줄만 바뀜)
new WalletProvisioningService(new KyoboCustodyAdapter(hsm), walletMapping);
```

M4에서 배운 의존성 역전(DIP)이 M5에서도 동일하게 적용된다. 서비스는 "어떻게 지갑을 가져오는지"를 모르고, "지갑을 가져올 수 있다"는 계약(인터페이스)만 안다.

---

## 실습 파트 (35분)

```bash
npm run exercise:s27
```

실습 파일 한 개에 7개 섹션이 순서대로 실행된다. 각 섹션은 독립 스코프(`{}`)로 격리되어 이전 결과가 섞이지 않는다.

`ethers` + `crypto` 모듈을 사용해 실제 Ethereum 주소·키를 생성하고, DB 레이어는 PostgreSQL 쿼리 형태로 로그를 출력한다. 함수(mock)가 아니라 실제 암호화 연산 결과를 확인하는 것이 핵심이다.

---

### 구현 구조 개요

```
import { ethers }     from 'ethers';   // HD 지갑·랜덤 지갑 생성
import { createHash } from 'crypto';   // SHA-256 체크섬 (AuditLog)

makeVaspClient()    → ExternalVaspClient  (HD 파생 / createRandom)
makeWalletMapping() → WalletMappingService (SQL 로그 + in-memory store)
makeAuditLog()      → AuditLogAdapter      (SHA-256 체크섬 계산)
```

---

### VASP 클라이언트 — 실제 HD 지갑 파생

```typescript
// 테스트 니모닉 (실제 VASP는 HSM 내부에 마스터 시드 보관)
const VASP_MNEMONIC = 'test test test test test test test test test test test junk';

// depth 0 루트 노드에서 파생
const hdRoot = ethers.HDNodeWallet.fromPhrase(VASP_MNEMONIC, undefined, "m");
```

**EXTERNAL — 수탁 방식 (HD 파생)**

실제 커스터디 VASP는 HD(Hierarchical Deterministic) 지갑 구조로 운영된다.  
마스터 시드 하나로 BIP-44 경로를 따라 사용자마다 고유 지갑을 파생한다.

```
m / 44' / 60' / 0' / 0 / {index}
          ↑     ↑    ↑    ↑   ↑
        ETH  account  외부  인덱스(사용자별)
```

```typescript
const path  = `m/44'/60'/0'/0/${hdIdx++}`;
const child = hdRoot.derivePath(path);
// child.address  → 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
// child.privateKey → VASP HSM 보관, 사용자는 알 수 없음
```

> 테스트 니모닉의 첫 번째 파생 주소(`index=0`)는 Hardhat 기본 계정과 동일하다.  
> 수강생이 Hardhat을 써봤다면 `0xf39Fd6e51aad...` 주소를 알아볼 것이다.

같은 `userId`는 항상 같은 HD 인덱스에 매핑 → **재요청해도 동일 주소 반환** (멱등성 근거).

**KYOBO — HSM 신규 생성 방식**

```typescript
const wallet = ethers.Wallet.createRandom();
// wallet.address    → 0x59099f15...   (매 실행마다 다름)
// wallet.privateKey → 0xd72825...     (HSM이 보관, 출력 후 즉시 폐기)
```

콘솔에 privateKey가 출력되는 것을 보면서: "이 키가 HSM 밖으로 나온다는 게 어떤 의미인지" 강조.

---

### WalletMapping — SQL 쿼리 로그

in-memory Map으로 동작하지만 실제 PostgreSQL 쿼리 형태로 출력한다.

```
[DB] SELECT wallet_addr, vasp_type, created_at
     FROM   user_wallet_mapping
     WHERE  user_id = 'K-20240001'
     → 0 rows

[DB] INSERT INTO user_wallet_mapping
     (user_id, wallet_addr, vasp_type, verified, created_at)
     VALUES ('K-20240001', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', 'EXTERNAL', true, NOW())
```

`verified: true`가 INSERT에 포함된다 — VASP가 생성한 지갑이므로 소유권 증명 불필요.

---

### AuditLog — SHA-256 체크섬

S26에서 구현한 `AuditLogService`와 동일한 체크섬 계산 로직을 사용한다.

```typescript
const raw      = `${eventTime}${actor}${action}${resourceId}${JSON.stringify(afterState)}`;
const checksum = createHash('sha256').update(raw, 'utf8').digest('hex');
```

```
[AUDIT] action     WALLET_PROVISIONED
[AUDIT] resourceId K-20240009
[AUDIT] afterState {"walletAddress":"0xf39F...","vaspType":"EXTERNAL"}
[AUDIT] checksum   33fe7a171487f1b6a5dcc8019304c062e52895e1b4df2e407ac8162796e10900
```

같은 입력이면 항상 같은 체크섬 → 무결성 검증 가능.

---

### 실습 섹션별 흐름

| 섹션 | 내용 | 핵심 확인 포인트 |
|---|---|---|
| [1] | EXTERNAL → HD 파생 (`m/44'/60'/0'/0/0`) | 파생 경로·주소·INSERT 쿼리 |
| [2] | KYOBO → `createRandom()` | 주소·privateKey 출력, INSERT 쿼리 |
| [3] | 미지원 vaspType → `UnsupportedVaspError` | 에러 이름·메시지, `saveCalls = 0` |
| [4] | 컨트롤러 시뮬레이션 | EXTERNAL=200, 미지원=400, KYOBO=200 |
| [5] | 멱등성 — 3회 재요청 | r1·r2·r3 주소 동일, `vasp calls=1`, `saveCalls=1` |
| [6] | VASP 실패 → DB 미저장 | SELECT 후 에러, `saveCalls=0` |
| [7] | 감사 로그 — SHA-256 체크섬 | checksum 64자리, 재요청 시 미기록 |

---

### [1] EXTERNAL — HD 지갑 파생 흐름

```
provision('K-20240001', 'EXTERNAL')
  │
  ├─ getMapping('K-20240001')        → SELECT → 0 rows
  │
  ├─ vaspClient.getWalletAddr(...)
  │    └─ HD 파생 m/44'/60'/0'/0/0
  │         → 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  │
  ├─ saveMapping(userId, addr, 'EXTERNAL')
  │    └─ INSERT ... verified=true
  │
  └─ return ProvisionResult
```

---

### [5] 멱등성 — HD 파생의 결정론적 특성

`provision()`은 최초 1회만 VASP를 호출해야 한다. 동일 userId로 재요청이 오면:

| 방식 | 동작 | 문제 |
|---|---|---|
| 덮어쓰기 | 항상 VASP 재호출 → 새 주소 저장 | VASP가 매번 새 주소를 생성하면 이전 지갑과 불일치 |
| **멱등 처리** | DB에 있으면 기존 주소 반환 | **올바른 선택** |

실습 출력에서 확인할 것:
- `r1`, `r2`, `r3`의 `walletAddress` 모두 동일
- `vasp calls: 1` — HD 파생은 최초 1회만
- `saveCalls: 1` — INSERT도 1회만
- 2회·3회 요청 시 SELECT → `1 row` 로그만 찍힘

---

### [6] VASP 실패 시 안전성

`vaspClient.getWalletAddr()`가 실패하면:

```
SELECT → 0 rows
VASP API 호출 실패 → 예외 throw
                   → saveMapping() 미실행
                   → INSERT 없음 (일관된 상태)
```

**VASP 성공 + DB 실패** 케이스: 재시도 시 `getWalletAddr()`를 다시 호출해도 HD 파생은 결정론적이므로 동일 주소를 반환한다. 실질적 문제 없음.

> HD 파생이 아니라 매번 새 주소를 생성하는 VASP라면 이 가정이 깨진다 — 계약서에서 반드시 확인해야 한다.

---

### [7] 감사 로그 — S26 AuditLogService 연결

`AuditLogAdapter`를 optional로 주입한다. 미주입 시 `?.record()` optional chaining으로 무시.

주목할 동작:
- 최초 `provision()` → `WALLET_PROVISIONED` + SHA-256 체크섬 기록
- 재요청(멱등) → early return → 감사 로그 **미기록** (`entries.length` 여전히 1)
- 같은 입력이면 체크섬도 항상 동일 → S26의 `verifyIntegrity()` 검증 가능

---

### WalletProvisioningService 최종 구현

```typescript
export class WalletProvisioningService {
  constructor(
    private readonly vaspClient:    ExternalVaspClient,
    private readonly walletMapping: WalletMappingService,
    private readonly auditLog?:     AuditLogAdapter,
  ) {}

  async provision(userId: string, vaspType: VaspType | string): Promise<ProvisionResult> {
    const existing = await this.walletMapping.getMapping(userId);
    if (existing) {
      return { userId, walletAddress: existing.walletAddr, vaspType: existing.vaspType, provisionedAt: existing.createdAt };
    }

    let walletAddress: string;

    if (vaspType === 'EXTERNAL') {
      walletAddress = await this.vaspClient.getWalletAddr(userId);
    } else if (vaspType === 'KYOBO') {
      walletAddress = await this.vaspClient.createWallet(userId);
    } else {
      throw new UnsupportedVaspError(vaspType);
    }

    await this.walletMapping.saveMapping(userId, walletAddress, vaspType as VaspType);
    await this.auditLog?.record({
      actor: 'system', action: 'WALLET_PROVISIONED',
      resourceType: 'USER', resourceId: userId,
      afterState: { walletAddress, vaspType },
    });

    return { userId, walletAddress, vaspType: vaspType as VaspType, provisionedAt: new Date() };
  }
}
```

---

### 컨트롤러 라우트 참고

```typescript
app.post('/api/wallet/provision', async (req, res) => {
  try {
    const { userId, vaspType } = req.body;
    const result = await walletProvisioningService.provision(userId, vaspType);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof UnsupportedVaspError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});
```

---

## 완료 기준

- [ ] [1] HD 파생 경로(`m/44'/60'/0'/0/0`)와 주소 확인, INSERT 쿼리에 `verified=true`
- [ ] [2] KYOBO `createRandom()` — 주소·privateKey 출력 확인
- [ ] [3] 미지원 vaspType → `UnsupportedVaspError`, `saveCalls = 0`
- [ ] [4] 컨트롤러 시뮬레이션 → EXTERNAL=200 / 미지원=400
- [ ] [5] 멱등성 → r1·r2·r3 주소 동일, `vasp calls = 1`, `saveCalls = 1`
- [ ] [6] VASP 실패 → SELECT 후 에러, `saveCalls = 0`
- [ ] [7] 감사 로그 → SHA-256 체크섬 64자리, 재요청 시 `entries.length` 여전히 1
