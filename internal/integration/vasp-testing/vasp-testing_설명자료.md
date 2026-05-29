# vasp-testing/ 강의 자료

> 이 폴더는 **통합 테스트 전용 VASP 인프라**다.  
> 운영 코드(`packages/vasp/`)가 외부 VASP에 의존하는 것처럼, 통합 테스트는 이 폴더의 구현체에 의존한다.

---

## 1. 왜 이 폴더가 필요한가

통합 테스트는 두 가지 환경에서 실행된다.

| 환경 | 사용 어댑터 | VASP 역할 |
|---|---|---|
| Anvil (로컬 하드햇) | `AnvilVASPAdapter` | 체인 제어 가능 (mining freeze·revert) |
| Sepolia (테스트넷) | `SepoliaVASPAdapter` | 실제 네트워크, 체인 제어 불가 |

두 환경 모두 **외부 VASP REST API를 흉내 내는 HTTP 서버**(`VASPServer`)가 필요하다.  
운영에서는 실제 외부 VASP 서버가 이 역할을 하지만, 테스트에서는 직접 띄운다.

---

## 2. 파일 구성

```
vasp-testing/
├── VASPServer.ts          ← 외부 VASP HTTP 서버 (핵심)
├── ChainVASPAdapterBase.ts ← Anvil·Sepolia 공통 베이스
├── AnvilVASPAdapter.ts    ← Anvil 전용 (체인 제어 RPC 추가)
├── SepoliaVASPAdapter.ts  ← Sepolia 전용 (추가 메서드 없음)
├── mocks.ts               ← 단위 테스트용 인메모리 구현체
└── MockVASP.abi.json      ← MockVASP 컨트랙트 ABI
```

---

## 3. MockVASP 컨트랙트 — 테스트용 스마트 컨트랙트

### 3-1. 역할

`MockVASP.sol`은 실제 운영 컨트랙트(`NFTIssuer` + `KyoboNFT`)를 하나로 합친 테스트 전용 ERC-1155 컨트랙트다.  
외부 VASP 없이 로컬 Anvil 노드에서 전체 `issuer-service` 파이프라인을 검증하기 위해 존재한다.

```
운영: IssuerService → ExternalVASPAdapter → [외부 VASP 서버] → KyoboNFT 컨트랙트
테스트: IssuerService → ExternalVASPAdapter → VASPServer → MockVASP 컨트랙트
```

### 3-2. 구조

```solidity
contract MockVASP is ERC1155, AccessControl, ReentrancyGuard {

    enum MintMode { NORMAL, REVERT, NO_EMIT }
    MintMode public mode;

    event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason);

    // 운영 NFTIssuer와 동일한 시그니처 — ChainEventListener가 구독
    function issueActivityNFT(address to, uint256 tokenId, uint256 amount, bytes32 reason)
        external nonReentrant onlyRole(OPERATOR_ROLE);

    // VaspTxClientAdapter.submitMint() 호환 별칭
    function mint(address to, uint256 tokenId, uint256 amount, bytes32 reason)
        external nonReentrant onlyRole(OPERATOR_ROLE);

    // 시나리오 전환 — OPERATOR_ROLE 필요
    function setMode(MintMode _mode) external onlyRole(OPERATOR_ROLE);
}
```

### 3-3. 핵심 설계 포인트

**`Issued` 이벤트 시그니처가 운영 컨트랙트와 동일하다**

```solidity
event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason);
```

`ChainEventListener`는 이벤트 이름(`Issued`)과 ABI로 이벤트를 구독한다.  
MockVASP가 동일한 시그니처를 쓰기 때문에 `ChainEventListener` 코드는 한 줄도 바꾸지 않고 테스트할 수 있다.

**AccessControl — OPERATOR_ROLE 분리**

| 역할 | 보유자 | 할 수 있는 일 |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | deployer | OPERATOR_ROLE 부여·회수 |
| `OPERATOR_ROLE` | operator (VASPServer 서명 키) | `issueActivityNFT` · `mint` · `setMode` |

`VASPServer`는 `OPERATOR_KEY`로 TX를 서명해서 `issueActivityNFT`를 호출한다.  
`controlVasp`(DEPLOYER_KEY)는 `setMode`로 시나리오를 전환한다.  
두 역할을 분리해야 nonce 충돌이 없다.

**`_doMint` — 세 가지 모드 분기**

```solidity
function _doMint(address to, uint256 tokenId, uint256 amount, bytes32 reason) private {
    if (mode == MintMode.REVERT) {
        revert(revertReason);           // REVERT: eth_estimateGas 단계에서 실패
    }
    _mint(to, tokenId, amount, "");     // ERC-1155 민팅
    if (mode == MintMode.NORMAL) {
        emit Issued(to, tokenId, reason); // NORMAL: 이벤트 발행
    }
    // NO_EMIT: 민팅 성공, 이벤트 없음
}
```

`REVERT` 모드는 `eth_estimateGas` 단계에서 revert되기 때문에 TX 자체가 전송되지 않는다.  
`VASPServer`의 `_handleSubmit`이 `try-catch`에 걸려 즉시 500을 반환한다.

### 3-4. MockVASP 세 가지 모드 요약

| 모드 | `_doMint` 동작 | 결과 | 검증 시나리오 |
|---|---|---|---|
| `NORMAL` | `_mint` + `emit Issued` | TX 성공 + 이벤트 발행 | `[1] NORMAL` |
| `REVERT` | `revert(revertReason)` | TX 실패 (estimateGas 단계) | `[2] REVERT` |
| `NO_EMIT` | `_mint` (이벤트 없음) | TX 성공, 이벤트 없음 | `[3] NO_EMIT` · `[poll-1]` |

### 3-5. PENDING · REORG 시나리오와의 관계

PENDING과 REORG는 **컨트랙트 코드가 아니라 Anvil RPC로 제어**한다.

| 시나리오 | 제어 방법 | MockVASP 모드 |
|---|---|---|
| `[4] PENDING` | `evm_setAutomine(false)` → TX 채굴 중단 | `NORMAL` |
| `[5] REORG` | `evm_snapshot` / `evm_revert` → 체인 롤백 | `NORMAL` |

MockVASP는 `NORMAL` 모드로 두고, Anvil이 블록 생성을 제어한다.

---

## 4. VASPServer — 외부 VASP 시뮬레이터

### 3-1. 역할

`VASPServer`는 실제 외부 VASP가 제공하는 REST API를 Node.js `http` 모듈로 구현한 테스트 전용 HTTP 서버다.

운영 흐름:
```
IssuerService → ExternalVASPAdapter → [외부 VASP 서버] → WebhookServer
```

테스트 흐름:
```
IssuerService → ExternalVASPAdapter → [VASPServer] → WebhookServer
```

ExternalVASPAdapter 입장에서는 URL만 다를 뿐 완전히 동일하게 동작한다.

### 3-2. 엔드포인트

| 메서드 | 경로 | 역할 |
|---|---|---|
| POST | `/transactions` | TX 서명·브로드캐스트 |
| GET | `/transfers/:txHash` | TX 상태 조회 |
| POST | `/admin/mode` | MockVASP 컨트랙트 모드 전환 |
| GET | `/admin/mode` | 현재 모드 조회 |
| GET | `/aml/screen/:addr` | AML 스크리닝 (항상 `clear`) |

### 3-3. 핵심 설계 포인트

**NonceManager**

```typescript
this.signer = new NonceManager(new ethers.Wallet(config.signerKey, this.provider));
```

VASPServer는 TX를 직접 서명해서 체인에 올린다.  
여러 TX를 연속으로 보낼 때 nonce 충돌을 막기 위해 ethers v6의 `NonceManager`로 지갑을 감싼다.  
`NonceManager`는 내부적으로 nonce를 추적하며 자동 증가시킨다.

**주의**: `evm_revert`(REORG 시뮬레이션)를 호출하면 체인의 nonce는 롤백되지만 NonceManager의 내부 카운터는 그대로 남는다. 그래서 테스트 `beforeEach`에서 `vaspServer.resetNonce()`를 반드시 호출해야 한다.

```typescript
resetNonce(): void {
  if (this.signer instanceof NonceManager) {
    (this.signer as NonceManager).reset(); // 체인에서 실제 nonce 재조회
  }
}
```

**즉시 202 반환 + 비동기 콜백 패턴**

```typescript
// 1. TX 브로드캐스트 → 즉시 202 반환
this.txStatuses.set(tx.hash, 'pending');
res.writeHead(202).end(JSON.stringify({ txHash: tx.hash }));

// 2. 비동기로 확정 대기 → 콜백 전송
this._waitAndNotify(tx, requestId, tokenId, to).catch(...);
```

실제 VASP도 동일한 패턴이다. TX 확정은 시간이 걸리므로 즉시 `txHash`를 반환하고, 확정 후 콜백으로 알린다. IssuerService는 콜백을 기다리거나 pollStale로 폴링한다.

**HMAC-SHA256 서명 콜백**

```typescript
const body = JSON.stringify({ eventType, requestId, timestamp, data });
const sig  = crypto.createHmac('sha256', this.cfg.callbackSecret).update(body).digest('hex');
// 헤더: 'x-kyobo-signature': sig
```

WebhookServer는 이 시그니처를 검증한다. 운영에서 실제 외부 VASP가 동일한 방식으로 서명한다.

**MockVASP 컨트랙트 모드 — `txStatuses` 맵**

```typescript
private readonly txStatuses = new Map<string, 'pending' | 'completed' | 'failed'>();
```

`GET /transfers/:txHash` 폴링 요청에 응답하기 위한 서버 내부 상태 저장소.  
TX를 브로드캐스트하면 `pending`으로 등록하고, 확정 후 `completed` 또는 `failed`로 갱신한다.

### 3-4. MockVASP 컨트랙트 3가지 모드

`POST /admin/mode { "mode": "REVERT" }` 로 런타임에 모드를 바꿀 수 있다.

| 모드 | 동작 | 테스트 시나리오 |
|---|---|---|
| `NORMAL` | `issueActivityNFT` 정상 실행, `Issued` 이벤트 발행 | 정상 발행 |
| `REVERT` | `eth_estimateGas` 단계에서 revert | IssuerService FAILED 처리 검증 |
| `NO_EMIT` | 민팅은 성공하되 `Issued` 이벤트 없음 | ChainEventListener 폴백 검증 |

REVERT 모드에서는 `_handleSubmit`이 `try-catch`에 걸려 즉시 500을 반환한다.  
NO_EMIT 모드에서는 `_waitAndNotify`가 영수증을 받지만 `Issued` 이벤트를 찾지 못해 콜백을 보내지 않는다.

---

## 5. ChainVASPAdapterBase — 공통 베이스

### 4-1. 역할

`AnvilVASPAdapter`와 `SepoliaVASPAdapter`의 공통 로직을 담는 추상 클래스.  
`IVASPAdapter` 인터페이스를 구현하며, MockVASP 컨트랙트 제어 메서드를 제공한다.

### 4-2. 구조

```typescript
export abstract class ChainVASPAdapterBase implements IVASPAdapter {
  protected readonly provider:  ethers.JsonRpcProvider;
  protected readonly signer:    ethers.Wallet;
  protected readonly mockVasp:  ethers.Contract;   // MockVASP 컨트랙트 인스턴스

  // IVASPAdapter 구현
  async submitTransaction(params): Promise<VASPTransactionReceipt> { ... }
  async screenAddress(addr): Promise<{ flagged: boolean }> { return { flagged: false }; }
  async getTransferStatus(txHash): Promise<TransferResult> { ... }

  // MockVASP 시나리오 제어
  async setMode(mode: MintMode): Promise<void> { ... }
  async getMode(): Promise<MintMode> { ... }
}
```

**VASPServer vs ChainVASPAdapterBase 비교**

두 클래스 모두 MockVASP 컨트랙트를 호출하지만 역할이 다르다.

| | VASPServer | ChainVASPAdapterBase |
|---|---|---|
| 사용자 | ExternalVASPAdapter (HTTP 경유) | 통합 테스트 코드 직접 |
| 목적 | 외부 VASP REST API 시뮬레이션 | 테스트에서 체인 직접 제어 |
| nonce 관리 | NonceManager 사용 | 일반 Wallet (단발성 TX) |

---

## 6. AnvilVASPAdapter — 로컬 체인 제어

Anvil 전용 RPC를 추가한 확장 클래스다.

```typescript
export class AnvilVASPAdapter extends ChainVASPAdapterBase {
  async freezeMining(): Promise<void>            // evm_setAutomine([false])
  async resumeMining(): Promise<void>            // evm_setAutomine([true])
  async mineBlock(count = 1): Promise<void>      // hardhat_mine([hex])
  async snapshot(): Promise<string>              // evm_snapshot
  async revertToSnapshot(id: string): Promise<void> // evm_revert
}
```

**각 메서드와 시나리오 대응**

| 메서드 | 시나리오 | 동작 |
|---|---|---|
| `freezeMining()` | PENDING | TX가 mempool에 체류, 블록 안 생성 |
| `resumeMining()` | PENDING → 해소 | 자동 채굴 재개 |
| `mineBlock(N)` | PENDING 중 특정 블록 생성 | N개 블록만 수동 생성 |
| `snapshot()` | REORG 준비 | 현재 체인 상태 저장 → snapshotId 반환 |
| `revertToSnapshot(id)` | REORG 실행 | 스냅샷 시점으로 롤백, 이후 TX·블록 전부 소멸 |

**`evm_mine` vs `hardhat_mine` 주의사항**

```typescript
// ❌ 잘못된 예: evm_mine(3)은 3을 timestamp로 해석
await this.provider.send('evm_mine', [3]);

// ✅ 올바른 예: hardhat_mine에 hex 형식으로 개수를 전달
await this.provider.send('hardhat_mine', [`0x${count.toString(16)}`]);
```

---

## 7. SepoliaVASPAdapter — 테스트넷 전용

```typescript
export class SepoliaVASPAdapter extends ChainVASPAdapterBase {
  // 추가 메서드 없음
}
```

Sepolia는 `evm_snapshot`, `evm_revert`, `evm_setAutomine` 등 체인 제어 RPC를 지원하지 않는다.  
REORG 시나리오는 Sepolia에서 DB 상태 직접 주입으로 대체한다(`scenario-sepolia.ts`의 `reorg` 케이스).

---

## 8. mocks.ts — 단위 테스트용 인메모리 구현체

통합 테스트가 아닌 **단위 테스트**에서 DB·VASP 없이 실행할 수 있게 해주는 인메모리 구현체 모음이다.

| 클래스 | 대체하는 것 | 용도 |
|---|---|---|
| `InMemoryLedger` | PostgreSQL + LedgerService | 상태 전이 규칙 검증 |
| `MockVaspClient` | ExternalVASPAdapter | 가짜 txHash 생성 |
| `InMemoryTxRepository` | PgTxRepository | Map 기반 TxRepository |
| `MockWalletResolver` | PgWalletRepository | userId → 가짜 지갑 주소 |

**InMemoryLedger 상태 전이 규칙**

```typescript
const LEDGER_VALID: Record<string, string[]> = {
  REQUESTED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['PENDING', 'MINED', 'FAILED'],
  PENDING:   ['MINED', 'FAILED'],
  MINED:     ['CONFIRMED', 'REORGED', 'FAILED'],
  CONFIRMED: ['FINALIZED'],
  FINALIZED: [],
  FAILED:    [],
  REORGED:   ['MINED', 'SUBMITTED', 'FAILED'],
};
```

허용되지 않는 전이를 시도하면 `InvalidStateTransitionError`를 던진다.  
이 규칙이 곧 운영 DB의 상태 전이 제약이다.

---

## 9. 전체 흐름 요약

```
[통합 테스트]
  beforeAll:
    ① AnvilVASPAdapter 생성 (로컬 체인 연결)
    ② VASPServer 시작 (포트 19877)
    ③ WebhookServer 시작 (포트 19878)
    ④ start-anvil.ts (IssuerService + TxTransitionBridge + EventEngine) 시작

  it('[1] NORMAL'):
    ① HTTP POST /webhook → IssuerService → ExternalVASPAdapter → VASPServer POST /transactions
    ② VASPServer: issueActivityNFT() 호출 → 202 즉시 반환
    ③ VASPServer: TX 확정 후 → WebhookServer POST (HMAC 서명)
    ④ TxTransitionBridge: SUBMITTED→MINED→CONFIRMED→FINALIZED 전이
    ⑤ 테스트: issuance_requests.status === 'COMPLETED' 검증

  it('[2] REVERT'):
    ① vaspServer.setMode('REVERT') (또는 POST /admin/mode)
    ② 동일 흐름 → VASPServer 500 반환 → IssuerService FAILED 처리

  it('[4] PENDING'):
    ① vaspAdapter.freezeMining() → 블록 생성 중단
    ② TX 제출 → mempool 체류 → SUBMITTED 상태 유지
    ③ vaspAdapter.mineBlock(1) → TX 확정 → 정상 완료

  it('[5] REORG'):
    ① snapshotId = vaspAdapter.snapshot()
    ② 정상 발행 → SUBMITTED 전이 후
    ③ vaspAdapter.revertToSnapshot(snapshotId) → 체인 롤백
    ④ TxTransitionBridge: REORGED 처리 → 재발행 또는 FAILED
```

---

## 10. 핵심 설계 원칙 요약

1. **어댑터 패턴** — `IVASPAdapter` 인터페이스 하나로 Anvil·Sepolia·운영(ExternalVASP)을 동일하게 교체 가능
2. **추상 클래스 + 확장** — 공통 로직은 `ChainVASPAdapterBase`, 네트워크별 차이는 서브클래스에서만 추가
3. **테스트 격리** — `VASPServer`가 외부 VASP를 완전 대체하여 네트워크 없이도 E2E 검증 가능
4. **비동기 패턴** — 즉시 응답 + 비동기 콜백으로 실제 VASP 동작을 정확히 재현
5. **시나리오 제어** — NORMAL·REVERT·NO_EMIT 3가지 모드 + freezeMining/revert로 모든 엣지 케이스 커버
