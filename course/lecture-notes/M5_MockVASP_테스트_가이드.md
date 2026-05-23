# MockVASP 통합 테스트 가이드

> **대상**: M5 S29-S30 수강생  
> **목표**: 실제 스마트 컨트랙트를 배포하고, 5가지 시나리오(NORMAL·REVERT·NO_EMIT·PENDING·REORG)를 직접 실행하며 issuer-service 전체 파이프라인과 PostgreSQL 9개 테이블이 연동되는 흐름을 확인한다.

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

# Sepolia 테스트 시 아래 두 항목 필요
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<API_KEY>
DEPLOYER_PRIVATE_KEY=<your_private_key>
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
**전체 통합 테스트**는 Webhook → IssuerService → VASP → ChainEventListener → PostgreSQL 9개 테이블 → Java internal-ledger까지 **실제 파이프라인 전체**를 검증한다.

### 2-1. 통합 테스트 아키텍처

```
HTTP Webhook
    │
    ▼
WebhookServer ──→ ActivityRouter ──→ IssuerService
                                          │
                              ┌───────────┴───────────┐
                              ▼                       ▼
                    AnvilVASPAdapter          PgHybridCoreBankingAdapter
                    (OPERATOR_KEY)            (user_wallet_mapping DB 조회)
                              │
                              ▼
                      MockVASP 컨트랙트
                      (Hardhat 로컬 노드)
                              │
                              ▼
                     ChainEventListener
                     (Issued 이벤트 폴링)
                              │
                   ┌──────────┴──────────┐
                   ▼                     ▼
         IssuanceConfirmHandler    fallback 폴링
         (issuance_requests        (processed_events
          CONFIRMED 전이)           기록)
                                         │
                                         ▼
                               OutboxWorker
                               (outbox_events 처리)
                                         │
                                         ▼
                              Java internal-ledger
                              (Docker 컨테이너)
                              ┌──────────┴──────────┐
                              ▼                     ▼
                     user_nft_holdings          audit_log
```

### 2-2. 사용 DB 테이블 전체 목록

| 테이블 | 담당 서비스 | 역할 | 검증 시나리오 |
|---|---|---|---|
| `issuance_policies` | issuer-service | 이벤트 타입별 발행 정책 | 전체 (시드 데이터) |
| `issuance_requests` | issuer-service | 발행 요청 상태 추적 | [1]~[5] |
| `mint_requests` | core-banking | LedgerService 민팅 기록 | [1]~[5] |
| `tx_mint_requests` | vasp | 온체인 TX 상태 추적 | [1]~[5] |
| `user_wallet_mapping` | issuer-service | 사용자 ↔ 지갑 주소 매핑 | [1] |
| `processed_events` | core-banking | 체인 이벤트 중복 처리 방지 | [1][4][5] |
| `outbox_events` | vasp | 비동기 아웃박스 큐 | [1] |
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
  [SETUP] MockVASP 통합 테스트 환경 구축
══════════════════════════════════════════════════════════════

  [1/6] Hardhat 노드 컨테이너 기동...
  [1/6] Hardhat 컨테이너 준비 완료 → http://localhost:49152

  [2/6] MockVASP 컨트랙트 배포...
  [deploy] MockVASP → 0x5FbDB2315...
  [deploy] OPERATOR_ROLE granted to deployer

  [3/6] PostgreSQL 컨테이너 시작...
  [3/6] PostgreSQL 준비 완료

  [3b] Java internal-ledger 컨테이너 시작 (kyobo/internal-ledger:test)...
  [3b] Java 컨테이너 준비 완료 → http://localhost:49183

  ...

  PASS __tests__/issuer-service-mock-vasp.integration.test.ts
    issuer-service MockVASP 통합 테스트 — 5가지 시나리오
      ✔ [1] NORMAL — 정상 발행 → Issued 이벤트 → CONFIRMED
      ✔ [2] REVERT — TX revert → issuance_requests FAILED
      ✔ [3] NO_EMIT — mint 성공, Issued 이벤트 없음 → SUBMITTED 유지
      ✔ [4] PENDING — 블록 중단 → TX mempool 체류 → mineBlock → CONFIRMED
      ✔ [5] REORG — snapshot → 발행 → revertToSnapshot → 온체인 상태 원복 확인

  Tests: 5 passed, 5 total
```

### 2-5. 테스트 [1] NORMAL 검증 항목 상세

NORMAL 시나리오는 9개 테이블을 전부 거치는 황금 경로(golden path)다.

```
① webhook 202 수신
② issuance_requests: REQUESTED → SUBMITTED → CONFIRMED
③ user_wallet_mapping: userId로 walletAddr 조회 (PgHybridCoreBankingAdapter)
④ processed_events: Issued 이벤트 txHash·logIndex 기록 (중복 방지)
⑤ outbox_events: PENDING 삽입 → OutboxWorker → PROCESSED
⑥ user_nft_holdings: Java API POST → DB 기록 확인
⑦ audit_log: Java API POST → hash chain 무결성 포함 DB 기록 확인
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

배포 완료 후 `.env`의 `SEPOLIA_MOCK_VASP_ADDR`에 출력된 주소를 기입한다.

### 3-2. Sepolia 시나리오 테스트

```bash
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

### 3-3. Etherscan에서 NFT 확인

발행된 ERC-1155 토큰은 아래 방법으로 확인한다.

**① 내 주소의 토큰 전송 내역**
```
https://sepolia.etherscan.io/address/<YOUR_ADDRESS>#tokentxns
```

**② 컨트랙트에서 직접 잔고 조회**
```
https://sepolia.etherscan.io/address/<MOCK_VASP_ADDR>#readContract
```
→ `balanceOf` 함수 → account: `<YOUR_ADDRESS>`, id: `1001`

**③ OpenSea 테스트넷**
```
https://testnets.opensea.io/assets/sepolia/<MOCK_VASP_ADDR>/1001
```

> 메타데이터 URI 미설정으로 이미지·이름은 표시되지 않는다.

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

| 항목 | Anvil 스크립트 | 전체 통합 테스트 | Sepolia |
|---|---|---|---|
| 대상 | 컨트랙트 동작 | 파이프라인 전체 + DB | 온체인 TX 시각화 |
| PostgreSQL | ❌ | ✅ 9개 테이블 | ❌ |
| Java 컨테이너 | ❌ | ✅ Docker | ❌ |
| 블록 확정 속도 | 즉시 | 즉시 (로컬) | 약 12초 |
| 가스비 | 무료 | 무료 | Sepolia ETH 필요 |
| Etherscan | ❌ | ❌ | ✅ |
| NORMAL / REVERT / NO_EMIT | ✅ | ✅ | ✅ |
| PENDING (블록 중단) | ✅ | ✅ | ❌ |
| REORG (체인 롤백) | ✅ | ✅ | ❌ |
| 강의 데모 용도 | 컨트랙트 설명 | 서비스 설계 전체 | 실운영 유사 환경 |
