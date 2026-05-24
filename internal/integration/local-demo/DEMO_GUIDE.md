# 로컬 데모 가이드 — issuer-service 풀 파이프라인

## 개요

이 데모는 **실제 블록체인(Hardhat 로컬 노드)** 위에서 NFT 발행 전 과정을 단계별 로그와 함께 눈으로 확인하는 환경이다.

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
│  └──────────────┬─────────────────────────────────┬─────────────────┘ │
│                 │                                 │                    │
│        ┌────────┴──────────┐           ┌──────────┴────────────┐      │
│        │ TxStateMachine    │           │  ChainEventListener   │      │
│        │ TxTransitionBridge│◀──────────│  (RPC 폴링)           │      │
│        └────────┬──────────┘  Issued   └──────────┬────────────┘      │
│                 │             이벤트               │                    │
└─────────────────┼───────────────────────────────────────────────────────┘
                  │
     ┌────────────┼──────────────────────────────────────────┐
     │            ▼                                          │
     │  ┌──────────────────┐    HTTP POST    ┌────────────┐  │
     │  │  ExternalVASP    │───────────────▶│ VASPServer │  │
     │  │  Adapter         │   :19876       │   :19876   │  │
     │  └──────────────────┘                └─────┬──────┘  │
     │                                            │          │
     │  ┌──────────────────┐    HTTP GET          │          │
     │  │ KyoboCoreBanking │───────────────▶ Java Stub      │
     │  │ Adapter          │   :19875       │   :19875  │  │
     │  └──────────────────┘                └──────┬────┘  │
     │                                             │        │
     └──────────────────────────── PostgreSQL ◀───┘        │
                                      :15432                │
                                   ┌──────────────┐         │
                                   │ Hardhat RPC  │◀────────┘
                                   │   :8545      │  TX 브로드캐스트
                                   └──────┬───────┘
                                          │ NFT_ISSUED 콜백
                                          ▼
                                    WebhookServer :19877
```

---

## 컴포넌트 구성

### 실제 인프라 (Docker)

| 컨테이너 | 이미지 | 포트 | 역할 |
|---|---|---|---|
| `kyobo-demo-hardhat` | `kyobo/hardhat-node:test` | 8545 | 로컬 EVM 블록체인 |
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
     │     └─ Hardhat TX 브로드캐스트 → txHash 반환
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
  → Hardhat TX 채굴 대기 (tx.wait(1))
  → MockVASP.issueActivityNFT() 실행 → Issued 이벤트 emit
  → HMAC 서명 NFT_ISSUED 콜백 → WebhookServer :19877
  → WebhookPublishHandler → XADD kyobo:events  eventType=NFT_ISSUED
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

| 상태 | 레이어 | 의미 |
|---|---|---|
| `SUBMITTED` | core-banking | TX 제출 직후 초기 상태 |
| `MINED` | 블록체인 | 블록 포함 확인 |
| `CONFIRMED` | core-banking | 원장 반영 완료 |
| `FAILED` | core-banking | TX 실패 |

---

### issuance_requests — IssuerService (발행 요청 전체 생명주기)

가장 간소화된 상태. 비즈니스 레이어가 보는 최종 결과만 추적한다.

```
SUBMITTED ──CONFIRMED 이벤트────→ CONFIRMED  ← 종단
SUBMITTED ──FAILED 이벤트───────→ FAILED     ← 종단
```

| 상태 | 레이어 | 의미 |
|---|---|---|
| `SUBMITTED` | 비즈니스 | NFT 발행 요청 제출 완료, 온체인 확정 대기 |
| `CONFIRMED` | 비즈니스 | 온체인 확정 완료 — 발행 성공 종단 |
| `FAILED` | 비즈니스 | TX REVERT 또는 제출 실패 — 발행 실패 종단 |

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

기동 시 콘솔에 아래 정보가 출력된다.

```
=== kyobo issuer-service Sepolia 데모 시작 ===

  네트워크     : Sepolia (chainId=11155111)
  RPC          : https://eth-sepolia.g.alchemy.com/v2/…
  MockVASP     : 0x176ac5B7bf773841812D3fc7c2888ba29F7dC2Ae
  OPERATOR     : 0x91ffcbB6f6dC947C01d402eA5703b9D27e8aA363
  TOKEN_ID     : 1716123456789  (실행마다 고유 — 이전 잔액 충돌 방지)
```

> Sepolia는 고정 컨트랙트를 재사용하므로, 이전 실행에서 발행된 tokenId와 충돌하지 않도록
> 매 실행마다 `Date.now()` 기반 고유 TOKEN_ID를 사용한다.

### 발행 요청 (별도 터미널)

```bash
# 기본 (demo-user-001, steps=15000)
npm run demo:issue-sepolia

# 커스텀
npm run demo:issue-sepolia -- demo-user-001 20000
```

### 예상 로그 흐름

```
[issue-sepolia] 202 Accepted — 파이프라인 처리 중

# ~즉시
[WebhookPublishHandler] XADD → kyobo:events  eventType=ACTIVITY_ACHIEVED
[ActivityProcessor] 처리 시작  userId=demo-user-001
[java-stub] GET /users/demo-user-001 → 0x91ffcbB6…
[TxTransitionBridge] 전이 이벤트  REQUESTED → SUBMITTED  txHash=0x…

# ~12s 후 (Sepolia 블록 확정)
[VASPServer] NFT_ISSUED 콜백 전송 완료 (requestId=…)
[NFTIssuedProcessor] NFT_ISSUED 수신  to=0x91ffcbB6…  tokenId=…
[PgNFTLedger] user_nft_holdings 기록 완료

# 체인 이벤트 수신 후
[IssuanceConfirmHandler] Issued 이벤트 수신  txHash=0x…
[TxTransitionBridge] 전이 이벤트  SUBMITTED → MINED
[TxTransitionBridge] 전이 이벤트  MINED → CONFIRMED
[TxTransitionBridge] ✓ issuance_requests CONFIRMED 저장 완료
[java-stub] audit_log 저장  actor=demo-user-001  action=MINT  checksum=3f8a21b4…
```

### DB 직접 조회

```bash
# 전체 발행 상태
docker exec -it kyobo-sepolia-postgres psql -U postgres \
  -c "SELECT user_id, status, tx_hash FROM issuance_requests ORDER BY created_at DESC;"

# NFT 보유 현황
docker exec -it kyobo-sepolia-postgres psql -U postgres \
  -c "SELECT user_id, token_id, amount, on_chain_tx FROM user_nft_holdings;"

# 감사 로그
docker exec -it kyobo-sepolia-postgres psql -U postgres \
  -c "SELECT actor, action, resource_type, checksum, prev_checksum FROM audit_log ORDER BY id;"

# Redis Stream 메시지 확인
docker exec -it kyobo-sepolia-redis redis-cli XRANGE kyobo:events - +
```

### Sepolia Etherscan 확인

TX 해시로 실제 온체인 상태를 확인할 수 있다.

```
https://sepolia.etherscan.io/tx/<txHash>
https://sepolia.etherscan.io/address/<SEPOLIA_MOCK_VASP_ADDR>
```

### 종료

```bash
Ctrl+C  # PostgreSQL·Redis 컨테이너 자동 정리
```

---

## 포트 정리

### Hardhat 로컬 데모

| 포트 | 서비스 |
|---|---|
| 8545 | Hardhat RPC (EVM 로컬 노드) |
| 15432 | PostgreSQL |
| 16379 | Redis |
| 19875 | Java API 스텁 (internal-ledger 역할) |
| 19876 | VASPServer (외부 VASP 역할) |
| 19877 | WebhookServer (issuer-service 진입점) |

### Sepolia 데모

| 포트 | 서비스 |
|---|---|
| 15432 | PostgreSQL |
| 16379 | Redis |
| 19875 | Java API 스텁 (internal-ledger 역할) |
| 19876 | VASPServer (외부 VASP 역할, Sepolia RPC 연결) |
| 19877 | WebhookServer (issuer-service 진입점) |

---

## 스텁 vs 실제 운영 차이

| 항목 | Hardhat 데모 | Sepolia 데모 | 실제 운영 |
|---|---|---|---|
| VASP | VASPServer (MockVASP) | VASPServer (MockVASP on Sepolia) | 월렛원 외부 API |
| 코어뱅킹 | Java API 스텁 (로컬 HTTP) | Java API 스텁 (로컬 HTTP) | Java internal-ledger (:8080) |
| 블록체인 | Hardhat 로컬 (31337) | Ethereum Sepolia (11155111) | Ethereum Mainnet |
| MockVASP | 실행마다 새 배포 | 고정 주소 재사용 | 실제 VASP 컨트랙트 |
| audit_log | 스텁이 직접 PG에 쓰기 | 스텁이 직접 PG에 쓰기 | Java internal-ledger가 Oracle DB에 기록 |
| user_nft_holdings | 스텁 + Node.js 각각 UPSERT | 스텁 + Node.js 각각 UPSERT | Java 원장 단일 기록 |

---

## 핵심 코드 경로

```
internal/
├── integration/
│   └── local-demo/
│       ├── start.ts              # Hardhat 데모 — 인프라 기동 + Java 스텁 + DB 폴러
│       ├── issue.ts              # Hardhat 데모 — 발행 요청 CLI
│       ├── start-sepolia.ts      # Sepolia 데모 — 루트 .env 로드, Hardhat 없음
│       └── issue-sepolia.ts      # Sepolia 데모 — 발행 요청 CLI
├── apps/issuer-service/src/
│   ├── index.ts                  # 실제 서비스 진입점 (수정 없이 그대로 실행)
│   ├── handlers/
│   │   └── IssuanceConfirmHandler.ts  # 온체인 Issued → 상태 전이
│   ├── services/
│   │   └── TxTransitionBridge.ts     # TxStatus → MintStatus·IssuanceStatus 동기화
│   └── infra/
│       └── PgNFTLedgerService.ts     # user_nft_holdings 직접 기록
└── packages/
    ├── event-engine/src/
    │   ├── webhook/WebhookPublishHandler.ts  # Webhook → Redis Stream
    │   ├── processors/ActivityProcessor.ts  # ACTIVITY_ACHIEVED 처리
    │   └── processors/NFTIssuedProcessor.ts # NFT_ISSUED → creditNFT
    └── chain-adapters/src/evm/
        └── EVMAdapter.ts             # 체인 이벤트 구독 (Hardhat·Sepolia 공용)
```
