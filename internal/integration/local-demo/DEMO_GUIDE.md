# 로컬 데모 가이드 — issuer-service 풀 파이프라인

## 개요

이 데모는 **실제 블록체인(Hardhat 로컬 노드 또는 Ethereum Sepolia 테스트넷)** 위에서 NFT 발행 전 과정을 단계별 로그와 함께 눈으로 확인하는 환경이다.

외부 시스템(VASP, Java 원장, 코어뱅킹)을 스텁으로 대체하되, PostgreSQL·Redis·Hardhat은 **실제 Docker 컨테이너**로 띄워 DB 상태가 실제로 변하는 것을 직접 검증할 수 있다.

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          demo:issue (CLI)                               │
│                     HMAC 서명 ACTIVITY_ACHIEVED 웹훅                     │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTP POST :19877
                                 ▼
┌────────────────────── issuer-service (index.ts) ───────────────────────┐
│                                                                         │
│  ┌─────────────────┐    XADD     ┌──────────────────────────────────┐  │
│  │  WebhookServer  │────────────▶│  Redis Stream (kyobo:events)     │  │
│  │    :19877       │             └──────────────┬───────────────────┘  │
│  └────────┬────────┘                            │ XREADGROUP           │
│           │ VASP_TX_FAILED                      ▼                      │
│           │ (직접 처리)          ┌───────────────────────────────────┐  │
│           │                     │   ConsumerGroupPool               │  │
│           │                     │  ┌──────────────────────────────┐ │  │
│           │                     │  │ activity-consumers           │ │  │
│           │                     │  │  ActivityProcessor           │ │  │
│           │                     │  │  → issueActivityNFT()        │ │  │
│           │                     │  └──────────────────────────────┘ │  │
│           │                     │  ┌──────────────────────────────┐ │  │
│           │                     │  │ nft-consumers                │ │  │
│           │                     │  │  NFTIssuedProcessor          │ │  │
│           │                     │  │  → creditNFT()               │ │  │
│           │                     │  └──────────────────────────────┘ │  │
│           │                     └───────────────────────────────────┘  │
│           │                                                             │
│  ┌────────┴──────────────────────────────────────────────────────────┐ │
│  │                     IssuerService                                 │ │
│  │  getUserAccount() → KYC 확인 → AML 스크리닝 → submitTransaction()  │ │
│  └──────────────┬─────────────────────────────┬─────────────────────┘ │
│                 │                             │                        │
│        ┌────────┴──────────┐       ┌──────────┴────────────┐          │
│        │ TxStateMachine    │       │  ChainEventListener   │          │
│        │ TxTransitionBridge│◀──────│  (RPC 폴링)           │          │
│        └────────┬──────────┘ Issued└──────────┬────────────┘          │
│                 │            이벤트             │                       │
│  ┌──────────────┴──────────────────────────────────────────────────┐  │
│  │  Admin HTTP Server :19870  (데모/테스트 전용 — ADMIN_PORT 설정 시) │  │
│  │  POST /admin/poll-stale → txStateMachine.pollStaleRequests()    │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                  │
     ┌────────────┼────────────────────────────────────────────────┐
     │            ▼                                                │
     │  ┌──────────────────┐    HTTP POST    ┌────────────────┐    │
     │  │  ExternalVASP    │───────────────▶│  VASPServer    │    │
     │  │  Adapter         │   :19876       │    :19876      │    │
     │  └──────────────────┘                └──────┬─────────┘    │
     │                                             │              │
     │  ┌──────────────────┐    HTTP              │              │
     │  │ KyoboCoreBanking │──────────────▶  Java Stub :19875   │
     │  │ Adapter          │                       │              │
     │  └──────────────────┘                       │              │
     │                                             ▼              │
     └──────────────────────────────── PostgreSQL :15432 ◀────────┘
```

---

## 컴포넌트 구성

### 실제 인프라 (Docker)

| 컨테이너 | 이미지 | 포트 | 역할 |
|---|---|---|---|
| `kyobo-demo-hardhat` | `kyobo/hardhat-node:test` | 8545 | 로컬 EVM 블록체인 (Hardhat 데모만) |
| `kyobo-demo-postgres` | `postgres:16-alpine` | 15432 | 모든 DB 테이블 |
| `kyobo-demo-redis` | `redis:7-alpine` | 16379 | Redis Streams |

### 스텁 서버 (start.ts 내 직접 기동)

| 서버 | 포트 | 역할 | 실제 DB 쓰기 |
|---|---|---|---|
| **VASPServer** | 19876 | TX 서명·브로드캐스트·NFT_ISSUED 콜백 | — |
| **Java API 스텁** | 19875 | getUserAccount·audit-log·nft-holdings | `audit_log`, `user_nft_holdings` |

### 실제 서비스

| 서비스 | 포트 | 설명 |
|---|---|---|
| **issuer-service** | 19877 | `apps/issuer-service/src/index.ts` 그대로 실행 |
| **Admin HTTP** | 19870 | `POST /admin/poll-stale` — 데모/테스트 전용 |

---

## 전체 발행 흐름 (단계별)

### 1단계 — 웹훅 수신 · Redis Stream 적재

```
demo:issue
  → HTTP POST localhost:19877  (HMAC-SHA256 서명)
  → WebhookServer 서명 검증
  → WebhookPublishHandler.createHandler()
  → XADD kyobo:events  eventType=ACTIVITY_ACHIEVED
```

**로그:**
```
[WebhookPublishHandler] XADD → kyobo:events  eventType=ACTIVITY_ACHIEVED  msgId=…
```

---

### 2단계 — ActivityProcessor · NFT 발행 요청

```
ConsumerGroupPool (activity-consumers)
  → XREADGROUP
  → ActivityProcessor.process()
  → IssuerService.issueActivityNFT()
     ├─ KyoboCoreBankingAdapter.getUserAccount()  →  Java 스텁 GET /users/{userId}
     ├─ KYC 상태 확인 (isActive=true, kycLevel=BASIC)
     ├─ ExternalVASPAdapter.screenAddress()       →  VASPServer GET /aml/screen/{addr}
     ├─ ExternalVASPAdapter.submitTransaction()   →  VASPServer POST /transactions
     │     └─ Hardhat/Sepolia TX 브로드캐스트 → txHash 반환
     ├─ issuance_requests INSERT  status=SUBMITTED
     ├─ mint_requests INSERT      status=SUBMITTED
     └─ tx_mint_requests INSERT   status=SUBMITTED
```

**로그:**
```
[ActivityProcessor] 처리 시작  userId=…  eventType=WALK_GOAL_MET
[ActivityProcessor] issueActivityNFT 호출
  [java-stub] GET /users/demo-user-001 → OPERATOR_ADDR
[TxTransitionBridge] 전이 이벤트  REQUESTED → SUBMITTED  txHash=0x…
[ActivityProcessor] issueActivityNFT 완료
```

**DB:**
```
issuance_requests  status=SUBMITTED
mint_requests      status=SUBMITTED
tx_mint_requests   status=SUBMITTED
```

---

### 3단계 — VASPServer TX 확정 · NFT_ISSUED 콜백

```
VASPServer (비동기)
  → TX 채굴 대기 (tx.wait(1)) — Hardhat: ~즉시, Sepolia: ~12s
  → MockVASP.issueActivityNFT() 실행 → Issued 이벤트 emit
  → HMAC 서명 NFT_ISSUED 콜백 → WebhookServer :19877
  → WebhookPublishHandler → XADD kyobo:events  eventType=NFT_ISSUED
  → VASPServer.txStatuses.set(txHash, 'completed')  ← pollStaleRequests 복구 경로에서 사용
```

**로그:**
```
[VASPServer] NFT_ISSUED 콜백 전송 완료 (requestId=…)
[WebhookPublishHandler] XADD → kyobo:events  eventType=NFT_ISSUED  msgId=…
```

---

### 4단계 — NFTIssuedProcessor · user_nft_holdings 기록

```
ConsumerGroupPool (nft-consumers)
  → XREADGROUP
  → NFTIssuedProcessor.process()
  → PgNFTLedgerService.creditNFT()
     └─ user_nft_holdings UPSERT  (Node.js 운영 추적)
```

**로그:**
```
[NFTIssuedProcessor] NFT_ISSUED 수신  to=0x70997970…  tokenId=1001
[NFTIssuedProcessor] creditNFT 호출
[PgNFTLedger] user_nft_holdings 기록 완료  userId=demo-user-001  tokenId=1001
```

---

### 5단계 — ChainEventListener · 상태 전이

```
ChainEventListener (ethers contract.on 실시간 구독)
  → Issued 이벤트 감지
  → IssuanceConfirmHandler.handle()
     ├─ txRepo.findByTxHash()  →  tx_mint_requests 조회
     ├─ TxStateMachineService.handleMined()
     │     └─ tx_mint_requests  SUBMITTED → MINED
     │     └─ TxTransitionBridge 'transition' 이벤트 emit
     │           └─ mint_requests  SUBMITTED → MINED
     └─ TxStateMachineService.handleConfirmed()
           └─ tx_mint_requests  MINED → CONFIRMED
           └─ TxTransitionBridge 'transition' 이벤트 emit
                 ├─ mint_requests       MINED → CONFIRMED
                 └─ issuance_requests   SUBMITTED → CONFIRMED
```

**로그:**
```
[IssuanceConfirmHandler] Issued 이벤트 수신  txHash=0x…  block=3
[IssuanceConfirmHandler] tx_mint_requests 조회  status=SUBMITTED
[IssuanceConfirmHandler] handleMined() 호출 → SUBMITTED → MINED
[TxTransitionBridge] 전이 이벤트  SUBMITTED → MINED
[IssuanceConfirmHandler] handleConfirmed() 호출 → MINED → CONFIRMED
[TxTransitionBridge] 전이 이벤트  MINED → CONFIRMED
[TxTransitionBridge] issuance_requests SUBMITTED → CONFIRMED
[TxTransitionBridge] ✓ issuance_requests CONFIRMED 저장 완료
```

---

### 6단계 — Java 원장 기록 (audit_log · user_nft_holdings)

```
KyoboCoreBankingAdapter
  ├─ recordNftHolding()  →  Java 스텁 POST /users/{userId}/nft-holdings
  │      └─ user_nft_holdings UPSERT  (Java 원장 역할)
  └─ recordAuditLog()    →  Java 스텁 POST /api/internal/audit-log
         └─ audit_log INSERT  (SHA-256 체크섬 체이닝)
```

**로그:**
```
  [java-stub] user_nft_holdings 저장  userId=demo-user-001  tokenId=1001
  [java-stub] audit_log 저장  actor=demo-user-001  action=MINT  checksum=3f8a21b4…
```

---

## 상태 전이표

### tx_mint_requests — TxStateMachineService (온체인 TX 상태 머신)

가장 세밀한 상태를 추적한다. `VALID_TRANSITIONS` 규칙 외 전이는 `InvalidStatusTransitionError`로 거부된다.

```
REQUESTED ──submitMintRequest()──→ SUBMITTED
SUBMITTED ──VASP TX 브로드캐스트──→ PENDING
PENDING   ──블록 채굴────────────→ MINED
MINED     ──확인 임계치 도달────→ CONFIRMED
CONFIRMED ──PoS 2/3+ validator──→ FINALIZED  ← 종단 (절대 불변)

REQUESTED / SUBMITTED ──submit 실패──→ FAILED   ← 종단
PENDING   / MINED     ──REVERT──────→ FAILED
PENDING               ──TIMEOUT─────→ (gas bump, 상태 유지)
MINED                 ──REORG───────→ REORGED → MINED 또는 FAILED

PENDING (10분 초과) ──pollStaleRequests()──→ getTransferStatus() → MINED → CONFIRMED
```

| 상태 | 레이어 | 의미 | 다음 가능 상태 |
|---|---|---|---|
| `REQUESTED` | VASP | 요청 생성, VASP 전송 전 | SUBMITTED, FAILED |
| `SUBMITTED` | VASP | VASP에 전달됨, TX hash 미획득 | PENDING, MINED, FAILED |
| `PENDING` | 블록체인 | TX 브로드캐스트됨, 블록 미채굴 | MINED, FAILED |
| `MINED` | 블록체인 | 블록 포함됨, REORG 가능 구간 | CONFIRMED, REORGED, FAILED |
| `CONFIRMED` | 블록체인 | 충분한 블록 확인 → 원장 업데이트 트리거 | FINALIZED |
| `FINALIZED` | 블록체인 | PoS 2/3+ 동의 → 종단 (약 12분, Ethereum PoS) | — |
| `FAILED` | 서비스 | REVERT 또는 최종 실패 → 종단 | — |
| `REORGED` | 블록체인 | MINED 구간 REORG로 TX 소실, 재처리 대기 | MINED, FAILED |

> 데모 정상 흐름: `REQUESTED → SUBMITTED → MINED → CONFIRMED`
> (Hardhat은 즉시 채굴이므로 PENDING 생략 가능)

---

### mint_requests — TxTransitionBridge (core-banking 관점)

`tx_mint_requests`의 상태 전이 이벤트를 수신해 동기화한다.

```
SUBMITTED ──MINED 이벤트────→ MINED
MINED     ──CONFIRMED 이벤트→ CONFIRMED
SUBMITTED / MINED ──FAILED──→ FAILED
```

---

### issuance_requests — IssuerService (발행 요청 전체 생명주기)

가장 간소화된 상태. 비즈니스 레이어가 보는 최종 결과만 추적한다.

```
SUBMITTED ──CONFIRMED 이벤트────→ CONFIRMED  ← 종단
SUBMITTED ──FAILED 이벤트───────→ FAILED     ← 종단
```

> `issuance_requests`는 MINED·PENDING 상태를 거치지 않는다.
> `tx_mint_requests`가 CONFIRMED 또는 FAILED에 도달할 때 `TxTransitionBridge`가 한 번에 전이시킨다.

---

## DB 테이블 최종 상태

| 테이블 | 기록 주체 | 내용 |
|---|---|---|
| `issuance_requests` | IssuerService | 발행 요청 전체 생명주기 (SUBMITTED → CONFIRMED) |
| `mint_requests` | LedgerService | 민트 요청 상태 (core-banking 관점) |
| `tx_mint_requests` | TxRepository | 온체인 TX 상태 머신 |
| `user_nft_holdings` | PgNFTLedgerService (Node.js) + Java 스텁 | NFT 보유 현황 — 두 경로가 동일 row에 UPSERT |
| `audit_log` | Java 스텁 | SHA-256 체인 해시로 변조 감지 가능한 감사 장부 |

---

## 실행 방법 — Hardhat 로컬 데모

### 사전 조건

```bash
# Hardhat 이미지 빌드 (최초 1회)
cd internal/integration
npm run build:hardhat
```

### 서버 기동

```bash
cd internal/integration
npm run demo:start
```

### 발행 요청 (별도 터미널)

```bash
# 기본 (demo-user-001, steps=15000)
npm run demo:issue

# 커스텀
npm run demo:issue -- demo-user-001 20000
```

### DB 직접 조회

```bash
# 전체 발행 상태
docker exec -it kyobo-demo-postgres psql -U postgres \
  -c "SELECT user_id, status, tx_hash FROM issuance_requests ORDER BY created_at DESC;"

# NFT 보유 현황
docker exec -it kyobo-demo-postgres psql -U postgres \
  -c "SELECT user_id, token_id, amount, on_chain_tx FROM user_nft_holdings;"

# 감사 로그 (체인 검증)
docker exec -it kyobo-demo-postgres psql -U postgres \
  -c "SELECT actor, action, resource_type, checksum, prev_checksum FROM audit_log ORDER BY id;"

# Redis Stream 메시지 확인
docker exec -it kyobo-demo-redis redis-cli XRANGE kyobo:events - +
```

### 종료

```bash
Ctrl+C  # 컨테이너 자동 정리
```

---

## 실행 방법 — Sepolia 테스트넷 데모

Hardhat 데모와 동일한 파이프라인을 실제 Ethereum Sepolia 테스트넷 위에서 실행한다.
MockVASP 컨트랙트는 Sepolia에 미리 배포된 고정 주소를 사용하며, Hardhat 컨테이너는 띄우지 않는다.

### 차이점 (Hardhat 대비)

| 항목 | Hardhat 로컬 | Sepolia 테스트넷 |
|---|---|---|
| 블록체인 | Hardhat 컨테이너 (chainId=31337) | Sepolia 공개 테스트넷 (chainId=11155111) |
| MockVASP | 실행 시 새로 배포 | 고정 주소 (`SEPOLIA_MOCK_VASP_ADDR`) |
| 블록 확정 | ~즉시 (로컬 채굴) | ~12s / 블록 |
| TX 확정까지 | 1~2초 | 20~30초 |
| Sepolia ETH | 불필요 | OPERATOR 계정에 필요 (faucet) |
| 환경변수 | 코드 내 하드코딩 | 루트 `.env` |

### 사전 조건

1. 루트 `.env`에 아래 값이 채워져 있어야 한다.

```
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<KEY>
SEPOLIA_MOCK_VASP_ADDR=0x...   # 배포된 MockVASP 컨트랙트 주소
SEPOLIA_OPERATOR_KEY=0x...     # Sepolia ETH 보유 계정 개인키
```

2. OPERATOR 계정에 Sepolia ETH가 있어야 TX 가스비를 낼 수 있다.
   - Faucet: https://sepolia-faucet.pk910.de/

3. `SEPOLIA_MOCK_VASP_ADDR`가 비어 있으면 먼저 MockVASP를 Sepolia에 배포한다.

```bash
cd blockchain
npx hardhat run scripts/deploy.ts --network sepolia
# 출력된 주소를 루트 .env의 SEPOLIA_MOCK_VASP_ADDR에 기입
```

### 서버 기동

```bash
cd internal/integration
npm run demo:start-sepolia
```

### 발행 요청 (별도 터미널)

```bash
npm run demo:issue-sepolia
npm run demo:issue-sepolia -- demo-user-001 20000
```

### Sepolia Etherscan 확인

```
https://sepolia.etherscan.io/tx/<txHash>
https://sepolia.etherscan.io/address/<SEPOLIA_MOCK_VASP_ADDR>
```

### 종료

```bash
Ctrl+C  # PostgreSQL·Redis 컨테이너 자동 정리
```

---

## 실패 시나리오 CLI — scenario.ts / scenario-sepolia.ts

`start.ts` 또는 `start-sepolia.ts`가 실행 중인 상태에서 별도 터미널로 실행한다.

```bash
# Hardhat 로컬
npm run demo:scenario -- <scenario> [userId]

# Sepolia 테스트넷
npm run demo:scenario-sepolia -- <scenario> [userId]
```

### 시나리오 목록

| 시나리오 | 명령 | 설명 |
|---|---|---|
| **revert** | `-- revert` | MockVASP TX on-chain revert → `issuance_requests FAILED` |
| **no-emit** | `-- no-emit` | mint 성공 + Issued 이벤트 없음 → `tx_mint_requests SUBMITTED` 유지 |
| **invalid-hmac** | `-- invalid-hmac` | HMAC 서명 위조 → WebhookServer 401, 파이프라인 진입 없음 |
| **unknown-user** | `-- unknown-user` | wallet mapping 없는 userId → `issuance_requests FAILED` |
| **pending** | `-- pending` | TX mempool 체류 → 30초 후 자동 복원 (Hardhat: automine, Sepolia: nonce 블로커) |
| **reorg** | `-- reorg` | 체인 롤백 시뮬 (Hardhat: evm_revert, Sepolia: DB 상태 주입) |
| **poll-stale** | `-- poll-stale` | NO_EMIT → PENDING 10분 초과 조작 → `pollStaleRequests()` → CONFIRMED |
| **reset** | `-- reset` | MockVASP mode → NORMAL 복원 (비정상 종료 후 수동 복구) |

### 시나리오별 상세

#### revert — TX on-chain 실패

```
MockVASP.setMode(REVERT) → 웹훅 전송 → estimateGas 단계에서 revert
→ VASPServer: VASP API 500 응답
→ TxStateMachine: REQUESTED → FAILED
→ issuance_requests.status = FAILED
```

**확인:**
```bash
docker exec -it kyobo-demo-postgres psql -U postgres \
  -c "SELECT user_id, status, fail_reason FROM issuance_requests ORDER BY created_at DESC LIMIT 3;"
```

---

#### no-emit — Issued 이벤트 없음

```
MockVASP.setMode(NO_EMIT) → 웹훅 전송 → mint 성공, Issued 이벤트 미발행
→ VASPServer: NFT_ISSUED 콜백 없음 (txStatuses='completed' 기록만 됨)
→ ChainEventListener: Issued 이벤트 수신 없음 → CONFIRMED 전이 없음
→ tx_mint_requests.status = SUBMITTED 유지
```

> ChainEventListener 폴백이나 `poll-stale` 시나리오로 수동 복구 가능

---

#### invalid-hmac — HMAC 서명 위조

```
조작된 HMAC-SHA256 서명으로 POST /webhook
→ WebhookServer: 서명 검증 실패 → HTTP 401
→ Redis Stream 적재 없음, DB 변화 없음, 온체인 TX 없음
```

---

#### unknown-user — 미등록 사용자

```
user_wallet_mapping에 없는 userId로 웹훅 전송
→ IssuerService.getUserAccount() 실패
→ issuance_requests.status = FAILED
```

---

#### pending — TX mempool 체류

| 환경 | 구현 방법 |
|---|---|
| Hardhat | `evm_setAutomine(false)` → TX 체류 → 30초 후 `evm_setAutomine(true)` + `evm_mine()` |
| Sepolia | nonce 블로커 TX(maxFeePerGas=1 wei)로 같은 nonce를 점유 → 30초 후 replacement TX |

> Alchemy/Sepolia는 `maxFeePerGas < baseFee` TX를 거부하므로 적절히 높은 replacement fee 필요

```bash
# 30초 대기 중 DB 상태 확인
docker exec -it kyobo-demo-postgres psql -U postgres \
  -c "SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3;"
```

---

#### reorg — 체인 롤백

| 환경 | 구현 방법 |
|---|---|
| Hardhat | `evm_snapshot` 저장 → 발행 → `evm_revert(snapshotId)` |
| Sepolia | 정상 발행 → SUBMITTED 후 → DB에 `status='REORGED'` 직접 주입 |

> Sepolia는 실제 reorg 통제 불가 → DB 상태 주입으로 상태머신 동작만 검증

---

#### poll-stale — PENDING 10분 초과 강제 복구

pollStaleRequests 복구 경로를 실제로 실행해보는 시나리오다.

```
NO_EMIT 모드 → 웹훅 전송 → TX 채굴 성공 + Issued 이벤트 없음
→ tx_mint_requests: SUBMITTED (txStatuses='completed' 기록됨)
→ DB 조작: SUBMITTED → PENDING + created_at -11분
→ POST :19870/admin/poll-stale
  → txStateMachine.pollStaleRequests()
    → findPendingOlderThan(10) → PENDING 10분 초과 건 발견
    → ExternalVASPAdapter.getTransferStatus(txHash)
      → GET VASPServer /transfers/:txHash → 'completed'
    → handleMined() → PENDING → MINED
    → handleConfirmed() → MINED → CONFIRMED
→ TxTransitionBridge → issuance_requests CONFIRMED
```

**Sepolia 추가 조건:** `POSTGRES_URL` 환경변수 필요

```bash
# Sepolia poll-stale 실행 예
POSTGRES_URL="postgresql://postgres:demo@localhost:15432/postgres" \
  npm run demo:scenario-sepolia -- poll-stale demo-user-001
```

**확인:**
```bash
docker exec -it kyobo-demo-postgres psql -U postgres \
  -c "SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3;"
docker exec -it kyobo-demo-postgres psql -U postgres \
  -c "SELECT user_id, status FROM issuance_requests ORDER BY created_at DESC LIMIT 3;"
```

---

#### reset — 모드 복원

비정상 종료 후 MockVASP가 REVERT나 NO_EMIT 모드로 남아 있을 때 NORMAL로 복원한다.

```bash
npm run demo:scenario -- reset
npm run demo:scenario-sepolia -- reset
```

---

## 포트 정리

### Hardhat 로컬 데모

| 포트 | 서비스 |
|---|---|
| 8545 | Hardhat RPC (EVM 로컬 노드) |
| 15432 | PostgreSQL |
| 16379 | Redis |
| 19870 | Admin HTTP (`POST /admin/poll-stale`) |
| 19875 | Java API 스텁 (internal-ledger 역할) |
| 19876 | VASPServer (외부 VASP 역할) |
| 19877 | WebhookServer (issuer-service 진입점) |

### Sepolia 데모

| 포트 | 서비스 |
|---|---|
| 15432 | PostgreSQL |
| 16379 | Redis |
| 19870 | Admin HTTP (`POST /admin/poll-stale`) |
| 19875 | Java API 스텁 (internal-ledger 역할) |
| 19876 | VASPServer (외부 VASP 역할, Sepolia RPC 연결) |
| 19877 | WebhookServer (issuer-service 진입점) |

---

## Hardhat vs Sepolia 시나리오 구현 차이

| 시나리오 | Hardhat | Sepolia | 이유 |
|---|---|---|---|
| **pending** | `evm_setAutomine(false/true)` | nonce 블로커 TX | Hardhat RPC 확장 명령 Sepolia 불가 |
| **reorg** | `evm_snapshot` + `evm_revert` | DB 상태 직접 주입 | Sepolia 실제 reorg 통제 불가 |
| **poll-stale** | 2초 대기 후 DB 조작 | `provider.waitForTransaction()` 후 DB 조작 | Sepolia는 블록 채굴 ~12s — 조기 폴 방지 |
| 나머지 | 동일 | 동일 | — |

---

## 스텁 vs 실제 운영 차이

| 항목 | Hardhat 데모 | Sepolia 데모 | 실제 운영 |
|---|---|---|---|
| VASP | VASPServer (MockVASP) | VASPServer (MockVASP on Sepolia) | 월렛원 외부 API |
| 코어뱅킹 | Java API 스텁 (로컬 HTTP) | Java API 스텁 (로컬 HTTP) | Java internal-ledger (:8080) |
| 블록체인 | Hardhat 로컬 (31337) | Ethereum Sepolia (11155111) | Ethereum Mainnet |
| MockVASP | 실행마다 새 배포 | 고정 주소 재사용 | 실제 VASP 컨트랙트 |
| Admin HTTP | `:19870` (ADMIN_PORT) | `:19870` (ADMIN_PORT) | 비활성화 (ADMIN_PORT 미설정) |
| audit_log | 스텁이 직접 PG에 쓰기 | 스텁이 직접 PG에 쓰기 | Java internal-ledger가 Oracle DB에 기록 |
| user_nft_holdings | 스텁 + Node.js 각각 UPSERT | 스텁 + Node.js 각각 UPSERT | Java 원장 단일 기록 |

---

## 핵심 코드 경로

```
internal/
├── integration/
│   └── local-demo/
│       ├── start.ts              # Hardhat 데모 — 인프라 기동 + Java 스텁 + DB 폴러
│       ├── start-sepolia.ts      # Sepolia 데모 — 루트 .env 로드, Hardhat 없음
│       ├── issue.ts              # Hardhat 발행 요청 CLI
│       ├── issue-sepolia.ts      # Sepolia 발행 요청 CLI
│       ├── scenario.ts           # Hardhat 실패 시나리오 CLI (8개)
│       ├── scenario-sepolia.ts   # Sepolia 실패 시나리오 CLI (8개)
│       └── DEMO_GUIDE.md         # 이 파일
├── apps/issuer-service/src/
│   ├── index.ts                  # 실제 서비스 진입점 (ADMIN_PORT 설정 시 admin HTTP 활성화)
│   ├── handlers/
│   │   └── IssuanceConfirmHandler.ts  # 온체인 Issued → 상태 전이
│   ├── services/
│   │   └── TxTransitionBridge.ts     # TxStatus → MintStatus·IssuanceStatus 동기화
│   └── infra/
│       └── PgNFTLedgerService.ts     # user_nft_holdings 직접 기록
└── packages/
    ├── vasp/src/tx/
    │   └── TxStateMachineService.ts  # TX 상태 머신 + pollStaleRequests()
    ├── event-engine/src/
    │   ├── webhook/WebhookPublishHandler.ts  # Webhook → Redis Stream
    │   ├── processors/ActivityProcessor.ts  # ACTIVITY_ACHIEVED 처리
    │   └── processors/NFTIssuedProcessor.ts # NFT_ISSUED → creditNFT
    └── chain-adapters/src/evm/
        └── EVMAdapter.ts             # 체인 이벤트 구독 (Hardhat·Sepolia 공용)
```
