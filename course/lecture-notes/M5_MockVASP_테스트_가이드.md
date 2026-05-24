# MockVASP 통합 테스트 가이드

> **대상**: M5 S29-S30 수강생  
> **목표**: 실제 스마트 컨트랙트를 배포하고, 8가지 시나리오(NORMAL·REVERT·NO_EMIT·PENDING·REORG + Redis Stream 멱등성·DLQ·XAUTOCLAIM)를 직접 실행하며 issuer-service 전체 파이프라인 — PostgreSQL 8개 테이블·Redis Stream·VASPServer — 이 연동되는 흐름을 확인한다.

---

## 사전 준비

```
Node.js 18 이상
Git
Docker Desktop (통합 테스트 필수)
```

```bash
# 의존성 설치
npm install
cd blockchain && npm install && cd ..
```

---

## 환경 변수 설정

루트 `.env` 파일에 아래 항목을 채운다. (`.env.example` 참고)

```bash
# Anvil 로컬 테스트는 기본값 그대로 사용 가능 (별도 설정 불필요)

# Sepolia 테스트 시 필요
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<API_KEY>
DEPLOYER_PRIVATE_KEY=<배포 계정 키>
OPERATOR_PRIVATE_KEY=<운영 계정 키>
SEPOLIA_MOCK_VASP_ADDR=<배포된 MockVASP 주소>

# Redis Stream 통합 테스트 시 필요 (미설정 시 InMemoryRedis로 자동 폴백)
REDIS_URL=rediss://:PASSWORD@your-redis.upstash.io:6380
```

> Alchemy 무료 계정: https://alchemy.com  
> Sepolia ETH 받기: https://sepolia-faucet.pk910.de/

---

## Part 1 — Anvil 로컬 테스트 (컨트랙트 단위)

Anvil은 로컬 PC에서 실행되는 가상 블록체인이다.  
블록 생성·중단, 체인 롤백 등 실서비스에서는 불가능한 시나리오를 제어할 수 있다.

### 1-1. Hardhat 노드 기동

**터미널 1**에서 실행 후 유지:

```bash
cd blockchain
npx hardhat node
```

아래와 같이 계정 목록이 출력되면 정상:

```
Account #0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (10000 ETH)
Account #1: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (10000 ETH)
...
```

### 1-2. 컨트랙트 단위 테스트

**터미널 2**에서 실행:

```bash
cd blockchain
npx hardhat test test/MockVASP.test.ts
```

**예상 출력:**

```
  MockVASP
    ✔ [1] NORMAL: issueActivityNFT → ERC-1155 mint + Issued 이벤트
    ✔ [2] REVERT: TX revert (기본 메시지)
    ✔ [2-a] REVERT: 커스텀 revert 메시지
    ✔ [3] NO_EMIT: mint 성공, Issued 이벤트 없음
    ✔ [4] OPERATOR_ROLE 없는 계정 → issueActivityNFT revert
    ✔ [4-a] OPERATOR_ROLE 없는 계정 → setMode revert
    ✔ [5] 모드 전환: NORMAL → REVERT → NO_EMIT → NORMAL
    ✔ [6] 동일 주소에 여러 번 발행 → balanceOf 누적

  8 passing
```

### 1-3. 시나리오 스크립트 테스트 (5가지)

```bash
npx hardhat run scripts/test-anvil-adapter.ts --network localhost
```

**예상 출력:**

```
[DEPLOY] MockVASP 컨트랙트 배포
  ·  컨트랙트 주소   0x5FbDB231...

[1] NORMAL — 정상 발행 + Issued 이벤트
  ·  TX 해시        0x10fda8...
  ·  블록 번호       30
  ·  이벤트 [Issued] reason  WALK_GOAL_MET
  ✔  Issued 이벤트 emit + balanceOf=1 확인

[2] REVERT — TX revert 시뮬레이션
  ✔  TX revert 확인
  ✔  커스텀 revert 메시지 확인

[3] NO_EMIT — mint 성공, Issued 이벤트 없음
  ·  Issued 이벤트 수 (0이어야 함)   0
  ✔  Issued 없음 + mint 됨 → ChainEventListener 폴백 경로 검증 가능

[4] PENDING — 블록 생성 중단 → TX 체류 → mineBlock → 확정
  ·  블록 생성 전 balanceOf   2 (변화 없음 — pending 체류 중)
  ·  블록 채굴 후 balanceOf   3 (확정됨)
  ✔  PENDING → 블록 채굴 → 확정 흐름 확인

[5] REORG — snapshot → 발행 → revertToSnapshot → 원복
  ·  발행 후 balanceOf       4
  ·  REORG 후 balanceOf     3 (← 원복)
  ✔  REORG 후 상태 원복 확인

모든 시나리오 통과 ✔
```

### 시나리오 해설

| 시나리오 | 컨트랙트 제어 | issuer-service 관점 |
|---|---|---|
| **NORMAL** | `setMode(0)` | 정상 경로. `Issued` 이벤트 → ChainEventListener → IssuanceStatus CONFIRMED |
| **REVERT** | `setMode(1)` | TX 실패. VASP가 에러 반환 → IssuanceStatus FAILED |
| **NO_EMIT** | `setMode(2)` | mint 성공, 이벤트 없음. VASP 웹훅 누락 시뮬레이션 → ChainEventListener 폴백 경로 동작 확인 |
| **PENDING** | `evm_setAutomine(false)` | 블록 생성 중단 → TX mempool 체류. 가스 범프·타임아웃 처리 검증 |
| **REORG** | `evm_snapshot` / `evm_revert` | 체인 롤백. 이미 CONFIRMED된 TX가 사라지는 상황 → DB는 CONFIRMED 유지 (Phase 2 과제) |

---

## Part 2 — 전체 통합 테스트 (issuer-service + PostgreSQL + Java)

단위 테스트는 컨트랙트만 검증한다.  
**전체 통합 테스트**는 Webhook → IssuerService → VASP → ChainEventListener → PostgreSQL 8개 테이블 → Java internal-ledger까지 **실제 파이프라인 전체**를 검증한다.

### 2-1. 통합 테스트 아키텍처

```
  교보 앱 서버
  ACTIVITY_ACHIEVED (인바운드)
        │
        ▼
   WebhookServer (:19878)
        │
        ▼
  WebhookPublishHandler
        │ XADD "kyobo:events"
        ▼
   Redis Stream
        │
   ┌────┴────────────────┐
   │ XREADGROUP          │ XREADGROUP
   ▼                     ▼
activity-consumers    nft-consumers
(ActivityProcessor)   (NFTIssuedProcessor)
   │                     │
   ▼                     ▼
IssuerService        InMemoryLedgerService
   │                 (Redis Stream 경로 검증용)
   ▼
ExternalVASPAdapter
(아웃바운드: POST /transactions)
   │
   ▼
VASPServer (:19876)          ←── 테스트 프로세스 내 실행
서명 · 브로드캐스트
   │
   ▼
MockVASP 컨트랙트
(Hardhat 로컬 노드)
   │
   ├─→ TX 확정
   │       │
   │       ▼
   │   VASPServer가 NFT_ISSUED 콜백 아웃바운드 전송
   │       │ POST http://localhost:19878
   │       │ (HMAC 서명 포함)
   │       ▼
   │   WebhookServer (:19878)  ←── 위와 동일한 서버
   │       │
   │       ▼
   │   WebhookPublishHandler → Redis Stream (nft-consumers 경유)
   │
   ▼
ChainEventListener (폴백 경로 — Issued 이벤트 폴링)
   │
   ┌──┴──┐
   ▼     ▼
IssuanceConfirm   fallback 폴링
Handler           (processed_events 기록)
(issuance_requests
 CONFIRMED 전이)
   │
   ▼
Java internal-ledger (TxTransitionBridge 경유)
   ┌──────┴──────┐
   ▼             ▼
user_nft_holdings  audit_log
```

**NFT_ISSUED는 VASPServer의 아웃바운드 콜백이다.**  
issuer-service가 먼저 VASPServer에 `POST /transactions`(아웃바운드)를 치면, VASPServer가 체인 확정 후 `POST http://localhost:19878`으로 결과를 쏴준다. WebhookServer 입장에서는 수신이지만, 이 요청의 성격은 "issuer-service 아웃바운드 호출에 대한 비동기 응답"이다.

WebhookServer에는 두 종류의 요청이 들어오지만 처리 경로는 동일하다:
- 교보 앱 서버 → `ACTIVITY_ACHIEVED` → `activity-consumers`
- VASPServer 콜백 → `NFT_ISSUED` → `nft-consumers`

두 이벤트 타입 모두 `webhookPublisher.createHandler()`로 등록되어 `WebhookServer → WebhookPublishHandler → Redis Stream` 경로를 동일하게 거친다.

**이중 확인 경로**  
① VASPServer 콜백 → WebhookServer → Redis Stream → NFTIssuedProcessor → InMemoryLedger (주 경로)  
② ChainEventListener → IssuanceConfirmHandler → issuance_requests CONFIRMED (폴백 경로)

### 2-2. 사용 DB 테이블 전체 목록

| 테이블 | 담당 서비스 | 역할 | 검증 시나리오 |
|---|---|---|---|
| `issuance_policies` | issuer-service | 이벤트 타입별 발행 정책 | 전체 (시드 데이터) |
| `issuance_requests` | issuer-service | 발행 요청 상태 추적 | [1]~[5] |
| `mint_requests` | core-banking | LedgerService 민팅 기록 | [1]~[5] |
| `tx_mint_requests` | vasp | 온체인 TX 상태 추적 | [1]~[5] |
| `user_wallet_mapping` | issuer-service | 사용자 ↔ 지갑 주소 매핑 | [1] |
| `processed_events` | core-banking | 체인 이벤트 중복 처리 방지 | [1][4][5] |
| `user_nft_holdings` | Java internal-ledger | NFT 보유 현황 (영구 원장) | [1] |
| `audit_log` | Java internal-ledger | 감사 로그 (hash chain 무결성) | [1] |

### 2-3. Docker 이미지 사전 빌드

통합 테스트는 Hardhat 노드와 Java internal-ledger를 모두 Docker 컨테이너로 실행한다.  
테스트 실행 전 두 이미지를 빌드해야 한다.

```bash
# 루트 디렉터리에서 한 번에 빌드
npm run build:hardhat-image   # kyobo/hardhat-node:test
npm run build:java-image      # kyobo/internal-ledger:test

# 또는 integration 디렉터리에서 개별 빌드
cd internal/integration
npm run build:hardhat          # Hardhat 이미지
npm run build:java             # Java 이미지
```

**빌드 확인:**

```powershell
# PowerShell
docker images | Select-String "kyobo/"

# cmd / Git Bash
docker images | findstr "kyobo/"
```

> 소스 변경 시에만 재빌드가 필요하다. 이미지가 있으면 생략 가능.
> Hardhat 이미지에는 컴파일된 컨트랙트 artifacts가 포함된다.

### 2-4. 통합 테스트 실행

```bash
cd internal
npm run test:integration -- --testPathPattern=mock-vasp
```

**예상 출력:**

```
══════════════════════════════════════════════════════════════
  [SETUP] 통합 테스트 환경 구축
══════════════════════════════════════════════════════════════

  [1/7] Hardhat 노드 컨테이너 기동...
  [1/7] Hardhat 준비 완료 → http://localhost:49152

  [2/7] MockVASP 컨트랙트 배포...
  [deploy] MockVASP → 0x5FbDB2315...
  [deploy] OPERATOR_ROLE granted to deployer

  [3/7] PostgreSQL + Java 컨테이너 시작...
  [3/7] PostgreSQL + Java 준비 완료

  [4/7] Redis 컨테이너 시작...
  [4/7] Redis 준비 완료 → redis://localhost:49184

  [5/7] VASPServer 기동...
  [VASPServer] 기동 완료 → :19876  contract=0x5FbDB2315...
  [5/7] VASPServer 준비 완료 → :19876

  [6/7] 서비스 조립...
  [7/7] 환경 구축 완료

══════════════════════════════════════════════════════════════

  PASS __tests__/issuer-service-mock-vasp.integration.test.ts
    issuer-service 통합 테스트 — VASPServer + Redis Stream + 8가지 시나리오
      ✔ [1] NORMAL — 정상 발행 → VASPServer NFT_ISSUED 콜백 → Redis Stream → ledger + CONFIRMED
      ✔ [2] REVERT — TX revert → VASPServer 500 → ExternalVASPAdapter throws → FAILED
      ✔ [3] NO_EMIT — mint 성공, Issued 이벤트 없음 → VASPServer 콜백 없음 → SUBMITTED 유지
      ✔ [4] PENDING — 블록 중단 → TX mempool 체류 → mineBlock → VASPServer 콜백 → CONFIRMED
      ✔ [5] REORG — snapshot → 발행 → revertToSnapshot → 온체인 상태 원복 확인
      ✔ [stream-2] 동일 requestId 중복 주입 → 멱등성 보장 (한 번만 처리)
      ✔ [stream-3] retryCount >= 3 → DLQ 이동 확인
      ✔ [stream-4] XAUTOCLAIM — PEL 잔류 메시지 재수신 처리

  Tests: 8 passed, 8 total
```

### 2-5. 테스트 [1] NORMAL 검증 항목 상세

NORMAL 시나리오는 8개 테이블을 전부 거치는 황금 경로(golden path)다.

```
① webhook 202 수신
② issuance_requests: REQUESTED → SUBMITTED → CONFIRMED
③ user_wallet_mapping: userId로 walletAddr 조회 (PgHybridCoreBankingAdapter)
④ processed_events: Issued 이벤트 txHash·logIndex 기록 (중복 방지)
⑤ user_nft_holdings: Java API POST → DB 기록 확인
⑥ audit_log: Java API POST → hash chain 무결성 포함 DB 기록 확인
```

**[1] 테스트 내 Java API 호출 흐름:**

```typescript
// NFT 보유 기록
POST /api/internal/users/user-mock-001/nft-holdings
{
  tokenId: 1001,
  contractAddr: "0x5FbDB231...",
  chainId: 31337,
  amount: 1,
  acquiredAt: "2025-...",
  onChainTx: "0xabc123..."
}

// 감사 로그
POST /api/internal/audit-log
{
  actor: "user-mock-001",
  action: "NFT_ISSUED",
  resourceType: "issuance_request",
  resourceId: "0xabc123...",
  beforeState: null,
  afterState: "{\"status\":\"CONFIRMED\",\"txHash\":\"0xabc123...\"}"
}
```

### 2-6. 설계 포인트: Signer 분리 (Nonce 충돌 방지)

> 이 부분은 ethers v6의 동작 방식을 이해하는 핵심 교육 포인트다.

**문제**: `vasp.setMode('NO_EMIT')` (OPERATOR_KEY, nonce 3) 직후 IssuerService가 `issueActivityNFT` 호출(동일 OPERATOR_KEY)을 시도하면 둘 다 같은 nonce를 eth_getTransactionCount에서 읽어온다.

```
NONCE_EXPIRED: Expected nonce to be 4 but got 3
```

ethers v6 JsonRpcProvider는 `eth_getTransactionCount('pending')` 결과를 블록 단위로 캐싱한다. 동일 블록 안에서 두 개의 TX가 같은 signer를 사용하면 두 번째 TX가 stale nonce를 받아 실패한다.

**해결**: 역할별로 signer를 분리한다.

```
controlVasp  ── DEPLOYER_KEY ──→ setMode / freezeMining / snapshot / revertToSnapshot
vasp         ── OPERATOR_KEY ──→ IssuerService가 issueActivityNFT 호출
```

두 signer가 독립적인 nonce 공간을 가지므로 충돌이 원천 차단된다.

**배포 시 NonceManager 사용**: `deployMockVASP()`에서 deploy TX 직후 `grantRole` TX를 연속 전송한다. 이 경우 동일 signer가 두 TX를 연속 전송하므로 `ethers.NonceManager`로 래핑해 로컬에서 nonce를 추적한다.

```typescript
const deployer = new ethers.NonceManager(new ethers.Wallet(DEPLOYER_KEY, provider));
// deploy (nonce 0) → grantRole (nonce 1) — NonceManager가 순서 보장
```

### 2-7. 설계 포인트: BigInt JSON 직렬화

ethers v6는 ERC-1155 tokenId(uint256)를 JavaScript `BigInt`로 디코딩한다.  
`JSON.stringify`는 BigInt를 직렬화하지 못하고 `TypeError`를 던진다.

PostgreSQL JSONB 컬럼에 저장하기 전 반드시 변환해야 한다:

```typescript
const safePayload = JSON.parse(
  JSON.stringify(ev.args, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
);
await ledgerService.recordProcessedEvent(ev.txHash, ev.logIndex, ev.eventName, ...safePayload);
```

### 2-8. 설계 포인트: audit_log hash chain

Java `AuditLogService`는 감사 로그를 append-only로 관리하고, 레코드마다 SHA-256 hash chain을 유지한다.

```
checksum_N = SHA-256(checksum_(N-1) + eventTime + actor + action + resourceId + afterState)
```

- 첫 레코드의 `prev_checksum`은 `"000...0"` (64자리 genesis 값)
- 레코드를 사후 수정하면 이후 모든 레코드의 checksum이 연쇄적으로 불일치 → 변조 탐지
- DB 수준에서 RLS(Row Level Security) INSERT-only 정책으로 이중 보호

schema.sql에서 `audit_log_seq` 시퀀스를 명시적으로 생성하는 이유:  
JPA 엔티티가 `@SequenceGenerator(sequenceName = "audit_log_seq")`를 지정하는데,  
`BIGSERIAL`이 자동 생성하는 `audit_log_id_seq`와 이름이 다르기 때문이다.

---

## Part 3 — Sepolia 테스트넷 테스트

실제 공개 테스트넷에 배포한다. Etherscan에서 트랜잭션을 직접 확인할 수 있다.

> **주의**: PENDING·REORG 시나리오는 Sepolia에서 지원하지 않는다.  
> Anvil 전용 RPC(`evm_setAutomine`, `evm_snapshot`)는 공개 노드에서 사용 불가.

### 3-1. MockVASP Sepolia 배포

```bash
cd blockchain
npx hardhat run scripts/deploy/deploy-mock-vasp.ts --network sepolia
```

**예상 출력:**

```
Network  : sepolia
Deployer : 0x91ffcb...
Operator : 0x91ffcb...

MockVASP deployed: 0x2e312C...

─── env (SepoliaVASPAdapter) ───
MOCK_VASP_ADDR=0x2e312C...
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/...
```

배포 완료 후 `.env`에 아래 값을 기입한다.

```bash
SEPOLIA_MOCK_VASP_ADDR=0x2e312C...   # 배포된 MockVASP 주소 (고정 — 재배포 시에만 변경)
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<API_KEY>
DEPLOYER_PRIVATE_KEY=<배포 계정 키>
OPERATOR_PRIVATE_KEY=<운영 계정 키>  # DEPLOYER와 달라야 nonce 충돌 없음
```

> DEPLOYER와 OPERATOR를 같은 키로 쓰면 `setMode` TX와 `issueActivityNFT` TX가 동일 nonce를 경쟁한다 → 반드시 분리할 것.

---

### 3-2. 컨트랙트 어댑터 스크립트 테스트 (3가지 시나리오)

서비스 없이 컨트랙트 동작만 빠르게 확인한다.

```bash
cd blockchain
npx hardhat run scripts/test-sepolia-adapter.ts --network sepolia
```

> 블록 확정에 블록당 약 12초 소요. 전체 실행 시간 약 2-3분.

**예상 출력:**

```
[INIT] Sepolia 네트워크 연결 확인
  ·  현재 블록    10901779
  ·  MockVASP   0x2e312C...
  ·  Etherscan  https://sepolia.etherscan.io/address/0x2e312C...

[1] NORMAL — 정상 발행 + Issued 이벤트
  ·  TX 해시      0x9a5d14...
  ·  Etherscan   https://sepolia.etherscan.io/tx/0x9a5d14...
  ·  블록 번호     10901780
  ✔  Issued 이벤트 emit 확인

[2] REVERT — TX revert 시뮬레이션
  ✔  TX revert 확인
  ✔  커스텀 revert 메시지 확인

[3] NO_EMIT — mint 성공, Issued 이벤트 없음
  ·  Issued 이벤트 수 (0이어야 함)   0
  ✔  Issued 없음 + mint 됨 → ChainEventListener 폴백 경로 시뮬레이션 성공

Sepolia 시나리오 전부 통과 ✔
컨트랙트: https://sepolia.etherscan.io/address/0x2e312C...
```

---

### 3-3. Sepolia 전체 통합 테스트 (PostgreSQL + Java + Redis + Sepolia)

스크립트 테스트는 컨트랙트만 검증한다.  
**Sepolia 통합 테스트**는 전체 파이프라인을 실 Sepolia 네트워크에서 검증한다.

#### 아키텍처

```
HTTP Webhook (ACTIVITY_ACHIEVED)
    │
    ▼
WebhookServer ──→ WebhookPublishHandler
                       │
                       │ XADD "kyobo:events"
                       ▼
                  Redis Stream (testcontainers)
                       │
                       │ XREADGROUP (activity-consumers)
                       ▼
               ActivityProcessor
                       │
                       ▼
                 IssuerService
                       │
              ┌────────┴────────┐
              ▼                 ▼
  IntegrationSepoliaVASP  PgHybridCoreBankingAdapter
  Adapter (OPERATOR_KEY)  (user_wallet_mapping DB 조회)
              │
              ▼
        MockVASP 컨트랙트
        (Sepolia 테스트넷 — 고정 주소)
              │
              ▼
       ChainEventListener
       (Issued 이벤트 폴링, 3초 간격)
              │
       ┌──────┴──────┐
       ▼             ▼
IssuanceConfirm  fallback 폴링
Handler          (processed_events 기록)
(issuance_requests
 CONFIRMED 전이)
              │
              ▼
   PostgreSQL + Java internal-ledger
        (testcontainers)
   ┌──────────┴──────────┐
   ▼                     ▼
user_nft_holdings     audit_log
```

> Sepolia는 VASPServer(HTTP)가 없다. `IntegrationSepoliaVASPAdapter`가 직접 체인에 TX를 전송하므로 NFT_ISSUED 콜백 경로가 없다. Redis Stream은 `ACTIVITY_ACHIEVED` 인바운드 경로와 stream-* 독립 시나리오에 사용된다.

#### mock-vasp 대비 핵심 차이

| 항목 | mock-vasp (로컬) | Sepolia 통합 테스트 |
|---|---|---|
| 블록체인 | Hardhat 컨테이너 (즉시 채굴) | Sepolia 테스트넷 (~12초/블록) |
| VASP 경로 | ExternalVASPAdapter → VASPServer(HTTP) | IntegrationSepoliaVASPAdapter (직접 체인) |
| NFT_ISSUED 콜백 | VASPServer → WebhookServer → Redis Stream | 없음 (ChainEventListener 폴백만 동작) |
| 컨트랙트 | 매 실행마다 fresh deploy | 고정 주소 (`SEPOLIA_MOCK_VASP_ADDR`) |
| TOKEN_ID | `'1001'` 고정 | `Date.now()` 동적 생성 |
| 온체인 시나리오 | 8개 (5 + stream 3) | 6개 (3 + stream 3) |
| 폴백 폴링 간격 | 300ms | 3,000ms |
| CONFIRMED 대기 | 최대 40초 | 최대 3분 |
| Redis | testcontainers | testcontainers |

**TOKEN_ID를 동적 생성하는 이유**: Sepolia의 고정 컨트랙트에는 이전 실행에서 발행된 토큰이 누적된다. 실행마다 `Date.now()` 기반의 새로운 TOKEN_ID를 쓰면 이전 잔액과 무관하게 `balanceOf` 증분(+1)을 검증할 수 있다.

#### 실행

```bash
cd internal/integration
npm run test:sepolia
```

또는

```bash
cd internal
npm run test:integration -- --testPathPattern=sepolia
```

> 실행 전 Docker Desktop이 실행 중이어야 한다. (PostgreSQL·Java·Redis 컨테이너 기동)  
> Java 이미지가 없으면 먼저 빌드: `npm run build:java`

#### 예상 출력

```
══════════════════════════════════════════════════════════════
  [SETUP] Sepolia 통합 테스트 환경 구축
══════════════════════════════════════════════════════════════

  [1/6] Sepolia RPC          https://eth-sepolia.g.alchemy.com/v2/...
  [1/6] MockVASP 주소        0x2e312C...
  [1/6] OPERATOR 주소        0x70997970...
  [1/6] TOKEN_ID (이번 실행) 1748012345678
  [1/6] Sepolia 연결 확인 (chainId 11155111)

  [2/6] Redis 컨테이너 시작...
  [2/6] Redis 준비 완료 → redis://localhost:49200

  [3/6] PostgreSQL + Java 컨테이너 시작...
  [3/6] PostgreSQL 준비 완료
  [3/6] Java 컨테이너 준비 완료 → http://localhost:49201

  [4/6] SepoliaVASPAdapter 초기화...

  [5/6] IssuerService + ChainEventListener + WebhookServer 조립...
  [6/6] 환경 구축 완료

══════════════════════════════════════════════════════════════

  PASS __tests__/issuer-service-sepolia.integration.test.ts (약 10분)
    issuer-service Sepolia 통합 테스트 — 6가지 시나리오
      ✔ [1] NORMAL — 정상 발행 → Issued 이벤트 → CONFIRMED  (~2분)
      ✔ [2] REVERT — TX revert → issuance_requests FAILED    (~1분)
      ✔ [3] NO_EMIT — mint 성공, Issued 이벤트 없음 → SUBMITTED 유지  (~2분)
      ✔ [stream-2] 동일 requestId 중복 주입 → 멱등성 보장 (한 번만 처리)  (~5초)
      ✔ [stream-3] retryCount >= 3 → DLQ 이동 확인  (~5초)
      ✔ [stream-4] XAUTOCLAIM — PEL 잔류 메시지 재수신 처리  (~5초)

  Tests: 6 passed, 6 total
```

> `[stream-*]` 시나리오는 블록체인과 무관한 순수 Redis 테스트이므로 Sepolia 블록타임과 관계없이 빠르게 완료된다.

#### 테스트 [1] NORMAL 검증 항목

```
① webhook 202 수신 (WebhookPublishHandler → Redis Stream XADD)
② ActivityProcessor가 Stream에서 읽어 IssuerService 호출
③ issuance_requests: REQUESTED → SUBMITTED → CONFIRMED
④ user_wallet_mapping: userId로 walletAddr 조회
⑤ balanceOf: 발행 전 대비 +1 증가 (Sepolia 온체인 확인)
⑥ processed_events: Issued 이벤트 txHash·logIndex 기록
⑦ user_nft_holdings: Java API → DB 기록 확인 (chainId=11155111)
⑧ audit_log: Java API → hash chain 기록 확인
```

항목 ⑤에서 실제 Sepolia TX의 `balanceOf`를 조회한다.  
이 숫자는 Etherscan에서도 동일하게 확인할 수 있다 → 실운영 환경과 동일한 검증 경로.

---

### 3-4. Etherscan에서 NFT 확인

발행된 ERC-1155 토큰을 브라우저에서 직접 확인한다.

**① 내 주소의 토큰 전송 내역**
```
https://sepolia.etherscan.io/address/<OPERATOR_ADDRESS>#tokentxns
```

**② 컨트랙트에서 직접 잔고 조회**
```
https://sepolia.etherscan.io/address/<SEPOLIA_MOCK_VASP_ADDR>#readContract
```
→ `balanceOf` 함수 → account: `<OPERATOR_ADDRESS>`, id: `<TOKEN_ID>`

> Sepolia 통합 테스트는 TOKEN_ID가 실행마다 바뀐다.  
> 콘솔 출력의 `[1/5] TOKEN_ID (이번 실행)` 값을 복사해 Etherscan에서 조회한다.

**③ OpenSea 테스트넷**
```
https://testnets.opensea.io/assets/sepolia/<SEPOLIA_MOCK_VASP_ADDR>/<TOKEN_ID>
```

> 메타데이터 URI 미설정으로 이미지·이름은 표시되지 않는다.

---

## Part 4 — Redis Stream 통합 테스트

MockVASP·issuer-service 파이프라인이 온체인 이벤트를 처리한 결과는 결국 **Redis Stream을 통해 다운스트림 서비스로 전달**된다.  
이 섹션은 Redis Stream 레이어(XADD → XREADGROUP → XACK)를 직접 검증하는 통합 테스트를 다룬다.

### 4-1. Redis Stream 아키텍처

```
ChainEventListener
    │ Issued 이벤트 감지
    ▼
RedisStreamPublisher
    │ XADD "kyobo:events"
    ▼
Redis Stream ──────────────────────────────────────────┐
    │                                                  │
    │ XREADGROUP("issuer-consumers")                   │ XAUTOCLAIM
    ▼                                                  │ (PEL 재수신)
ConsumerGroupWorker                                    │
    │ process(msg)                                     │
    ├── 성공 → XACK                                    │
    ├── 실패(<3회) → PEL 잔류 ──────────────────────────┘
    └── 실패(≥3회) → DLQHandler → XADD "kyobo:events:dlq"
```

**핵심 보장: At-least-once 처리**  
메시지를 XREADGROUP으로 읽으면 PEL(Pending Entry List)에 등록된다.  
XACK 전에 Consumer가 죽으면 PEL에 잔류 → XAUTOCLAIM으로 다른 Consumer가 재수신한다.

### 4-2. 테스트 파일 및 실행

```bash
cd internal
npm run test:integration -- --testPathPattern=stream-consumer
```

> `REDIS_URL` 미설정 시 `InMemoryRedis`로 자동 폴백 — Docker 없이도 실행 가능.

### 4-3. 4가지 시나리오

| 시나리오 | Redis 명령 흐름 | 검증 내용 |
|---|---|---|
| **[1] 정상 처리** | XADD → XREADGROUP → process → XACK | LedgerService 잔액 +1 |
| **[2] 멱등성** | XADD × 2 (동일 requestId) → XREADGROUP × 2 → XACK × 2 | creditNFT 1회만 호출 |
| **[3] DLQ** | XADD(`_retryCount:3`) → 즉시 DLQ 이동 | `kyobo:events:dlq`에 메시지 존재 |
| **[4] XAUTOCLAIM** | XADD → XREADGROUP(XACK 없음) → 500ms → XAUTOCLAIM → process | 재수신 후 잔액 +1 |

### 4-4. 시나리오 [4] XAUTOCLAIM 상세

```
① XADD "kyobo:events:integration:{ts}"
        ↓
② CRASH_CONSUMER: XREADGROUP(">") → 메시지 수신
   ⚠️ XACK 없이 중단 → PEL 잔류 (Consumer 장애 시뮬레이션)
        ↓
③ 500ms 대기 (minIdleMs=200ms 초과)
        ↓
④ NEW_CONSUMER: ConsumerGroupPool 기동 (minIdleMs=200)
   → _reclaimPending() → XAUTOCLAIM → PEL 메시지 회수
   → process() → XACK
        ↓
⑤ LedgerService.getNFTBalance('0xOWNER004', '4004') === 1 확인
```

**테스트 격리**: Consumer Group 이름에 `Date.now()`를 포함해 테스트 간 PEL 오염을 차단한다.

### 4-5. InMemoryRedis 폴백

`REDIS_URL` 미설정 또는 연결 실패 시 자동으로 `InMemoryRedis`를 사용한다.

```
[stream-consumer] REDIS_URL 미설정 또는 연결 실패 → InMemoryRedis 폴백
```

`InMemoryRedis`는 ioredis와 동일한 메서드 시그니처로 다음을 구현한다:

| 메서드 | 구현 내용 |
|---|---|
| `xadd` | 스트림에 메시지 추가, 단조 증가 ID 반환 |
| `xreadgroup` | PEL 등록 + lastId 갱신 |
| `xack` | PEL에서 메시지 제거 |
| `xautoclaim` | `minIdleMs` 초과 PEL 메시지 재수신 |
| `xrange` | 범위 스캔 (DLQ 확인용) |
| `xgroup CREATE` | Consumer Group 생성, BUSYGROUP 에러 유지 |

4가지 시나리오 모두 InMemoryRedis에서 동일하게 통과한다.  
실제 클라우드 Redis는 네트워크·직렬화·Consumer Group 경쟁 상황까지 포함한 추가 검증을 제공한다.

### 4-6. 예상 출력

**클라우드 Redis 연결 시**:
```
[stream-consumer] 실제 Redis 연결

  PASS __tests__/stream-consumer.integration.test.ts
    Redis Stream 통합 — ConsumerGroupPool E2E
      ✔ [1] NFT_ISSUED → ConsumerGroupPool 처리 → LedgerService 잔액 반영
      ✔ [2] 동일 requestId 중복 발행 → 한 번만 처리 (멱등성 보장)
      ✔ [3] 처리 3회 실패 → DLQ 이동 확인
      ✔ [4] XAUTOCLAIM — PEL 잔류 메시지 재수신 처리

  Tests: 4 passed, 4 total
```

**InMemoryRedis 폴백 시**:
```
[stream-consumer] REDIS_URL 미설정 또는 연결 실패 → InMemoryRedis 폴백

  PASS __tests__/stream-consumer.integration.test.ts
    Redis Stream 통합 — ConsumerGroupPool E2E
      ✔ [1] NFT_ISSUED → ConsumerGroupPool 처리 → LedgerService 잔액 반영
      ...

  Tests: 4 passed, 4 total
```

---

## 트랜잭션 구조 이해

NORMAL 시나리오에서 하나의 `issueActivityNFT` 호출은 **이벤트 2개**를 발생시킨다.

```
logs[0] TransferSingle (ERC-1155 표준)
  operator : 컨트랙트 호출자
  from     : 0x0000...  ← zero address = 신규 발행 (mint)
  to       : 수령 주소
  id       : tokenId (1001)
  value    : 발행 수량 (1)

logs[1] Issued (교보 비즈니스 이벤트)
  to       : 수령 주소
  tokenId  : 1001
  reason   : WALK_GOAL_MET  ← ChainEventListener 구독 대상
```

`TransferSingle`은 ERC-1155 스펙이 보장하는 표준 이벤트.  
`Issued`는 그 위에 비즈니스 컨텍스트(reason)를 얹은 issuer-service 전용 이벤트다.

---

## 환경별 비교

| 항목 | Anvil 스크립트 | mock-vasp 통합 테스트 | Sepolia 스크립트 | Sepolia 통합 테스트 | Redis Stream 통합 테스트 |
|---|---|---|---|---|---|
| 대상 | 컨트랙트 동작 | 파이프라인 전체 + DB | 온체인 TX 시각화 | 파이프라인 전체 + Sepolia | 이벤트 버스 레이어 (독립) |
| PostgreSQL | ❌ | ✅ 9개 테이블 | ❌ | ✅ 9개 테이블 | ❌ |
| Java 컨테이너 | ❌ | ✅ Docker | ❌ | ✅ Docker | ❌ |
| Redis | ❌ | ✅ testcontainers | ❌ | ✅ testcontainers | ✅ (클라우드 or InMemory) |
| VASPServer (HTTP) | ❌ | ✅ | ❌ | ❌ | ❌ |
| 블록 확정 속도 | 즉시 | 즉시 (로컬) | ~12초 | ~12초 | 해당 없음 |
| 컨트랙트 | 매번 fresh deploy | 매번 fresh deploy | 고정 주소 | 고정 주소 | 해당 없음 |
| 가스비 | 무료 | 무료 | Sepolia ETH 필요 | Sepolia ETH 필요 | 없음 |
| Etherscan 확인 | ❌ | ❌ | ✅ | ✅ | ❌ |
| NORMAL / REVERT / NO_EMIT | ✅ | ✅ | ✅ | ✅ | ❌ |
| PENDING (블록 중단) | ✅ | ✅ | ❌ | ❌ | ❌ |
| REORG (체인 롤백) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Redis Stream (멱등성·DLQ·XAUTOCLAIM) | ❌ | ✅ (stream-2~4) | ❌ | ✅ (stream-2~4) | ✅ (독립 4가지) |
| NFT_ISSUED 콜백 경로 | ❌ | ✅ VASPServer→Stream | ❌ | ❌ | ❌ |
| 오프라인 실행 | ✅ | ❌ (Docker 필요) | ❌ | ❌ (Docker 필요) | ✅ (InMemory 폴백) |
| 총 시나리오 수 | 5 (스크립트) | 8 | 3 (스크립트) | 6 | 4 |
| 강의 데모 용도 | 컨트랙트 설명 | 서비스 설계 전체 | 실운영 TX 시각화 | 실운영 유사 E2E | 이벤트 버스 신뢰성 |
