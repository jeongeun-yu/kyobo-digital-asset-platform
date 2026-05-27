# issuer-service 시나리오 데모 가이드

이 데모는 **실제 블록체인 위에서 NFT 발행 전 과정**을 눈으로 확인하는 환경이다.
외부 시스템(VASP, Java 원장, 코어뱅킹)은 스텁으로 대체하고,
PostgreSQL·Redis·Hardhat은 실제 Docker 컨테이너로 띄워 DB 상태가 실제로 변하는 것을 직접 검증할 수 있다.

두 가지 모드를 지원한다.

| 모드 | 블록체인 | 특징 |
|---|---|---|
| **Hardhat 로컬** | 로컬 컨테이너 (chainId=31337) | 즉시 채굴, 인터넷 불필요, 가스비 없음 |
| **Sepolia 테스트넷** | Ethereum Sepolia (chainId=11155111) | 실제 공개 테스트넷, 블록 ~12s, Sepolia ETH 필요 |

---

## 목차

1. [사전 설치](#1-사전-설치)
2. [프로젝트 준비](#2-프로젝트-준비)
3. [환경변수 설정 (.env)](#3-환경변수-설정-env)
4. [Hardhat 로컬 데모 실행](#4-hardhat-로컬-데모-실행)
5. [Sepolia 테스트넷 데모 실행](#5-sepolia-테스트넷-데모-실행)
6. [burst — 동시 5명 발행 테스트](#6-burst--동시-5명-발행-테스트)
7. [실패 시나리오 CLI](#7-실패-시나리오-cli)
8. [DB 직접 조회](#8-db-직접-조회)
9. [아키텍처 및 발행 흐름](#9-아키텍처-및-발행-흐름)
10. [상태 전이표](#10-상태-전이표)
11. [트러블슈팅](#11-트러블슈팅)

---

## 1. 사전 설치

### 1-1. Rancher Desktop (Docker 런타임)

Docker 컨테이너를 실행하기 위한 환경이다.  
Mac/Windows 모두 **Rancher Desktop** 설치를 권장한다 (Docker Desktop 대비 라이선스 무료).

1. https://rancherdesktop.io 에서 운영체제에 맞는 설치 파일 다운로드
2. 설치 후 실행 → 우측 하단 트레이 아이콘이 초록색이 될 때까지 대기
3. **설치 시 주의사항**
   - "Container Engine" 선택 화면에서 **`dockerd (moby)`** 선택 (기본값 `containerd` 아님)
   - 이후 설정에서 "Kubernetes 활성화"는 체크 해제해도 됨 (데모에 불필요)

설치 확인:

```powershell
docker --version
# Docker version 26.x.x 이상이면 정상
```

---

### 1-2. Node.js

```powershell
node --version
# v20 이상 필요. v18도 동작하나 v20 LTS 권장
```

없으면 https://nodejs.org 에서 LTS 버전 설치.

---

### 1-3. Git

```powershell
git --version
```

없으면 https://git-scm.com 에서 설치.

---

## 2. 프로젝트 준비

### 2-1. 저장소 클론

```powershell
git clone https://github.com/coincraft12/kyobo-digital-asset-platform.git
cd kyobo-digital-asset-platform
```

### 2-2. 의존성 설치

```powershell
# 루트에서 전체 워크스페이스 설치 (1회)
npm install
```

> `node_modules` 설치에 2~5분 소요된다.

### 2-3. Docker 이미지 빌드

두 이미지 모두 **최초 1회만 빌드하면 된다.**

```powershell
cd internal/integration

# Hardhat EVM 노드 이미지 (Hardhat 로컬 데모 전용)
npm run build:hardhat

# Java internal-ledger 이미지 (Hardhat·Sepolia 공통 — 실제 원장 서비스)
npm run build:java
```

> 완료 후 확인:
> ```powershell
> docker images | Select-String "kyobo"
> # kyobo/hardhat-node      test   ...
> # kyobo/internal-ledger   test   ...
> ```

> `build:java`는 Maven으로 Spring Boot를 빌드하므로 **3~5분** 소요된다.  
> Java 17이 없어도 되며, 빌드는 Docker 컨테이너 내부에서 진행된다.

---

## 3. 환경변수 설정 (.env)

루트의 `.env.example`을 복사해 `.env`를 만든다.

```powershell
# 프로젝트 루트에서
Copy-Item .env.example .env
```

### Hardhat 로컬 데모만 할 경우

`.env`를 수정하지 않아도 된다.  
`start.ts`가 Hardhat 컨테이너의 기본 계정(하드코딩된 테스트 키)을 사용하므로 별도 설정이 불필요하다.

---

### Sepolia 테스트넷 데모를 할 경우

아래 3가지 값을 `.env`에 채워야 한다.

```
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<YOUR_ALCHEMY_KEY>
SEPOLIA_OPERATOR_KEY=<개인키>
```

#### SEPOLIA_RPC_URL — Alchemy 무료 계정으로 발급

1. https://www.alchemy.com 에서 무료 계정 생성
2. 대시보드 → "Create new app" → Network: **Ethereum Sepolia** 선택
3. 생성된 앱의 "API Key" 복사
4. `.env`에 붙여넣기:
   ```
   SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/abc123xyz...
   ```

#### SEPOLIA_OPERATOR_KEY — Metamask에서 Sepolia 테스트 계정 생성

1. [MetaMask](https://metamask.io) 설치 후 **새 계정 생성** (기존 메인넷 계정 사용 금지)
2. 설정 → 개인키 내보내기 → 복사
3. `.env`에 붙여넣기:
   ```
   SEPOLIA_OPERATOR_KEY=0xabcdef1234...
   ```

> ⚠ 개인키는 외부 노출 금지. 이 계정에는 테스트용 Sepolia ETH만 보관할 것.

#### Sepolia ETH 받기 (가스비용 테스트 이더)

아래 faucet 중 하나에서 Sepolia ETH 수령:
- https://sepolia-faucet.pk910.de — PoW 방식, 많이 줌 (추천)
- https://faucets.chain.link/sepolia — Chainlink, 소량

OPERATOR 주소에 **0.1 ETH 이상** 있어야 MockVASP 배포 + 여러 번 mint TX를 보낼 수 있다.

잔액 확인: https://sepolia.etherscan.io/address/<OPERATOR 주소>

> `SEPOLIA_MOCK_VASP_ADDR`는 **설정하지 않아도 된다.**  
> `start-sepolia.ts`가 실행 시 MockVASP를 자동 배포하고 `.env`에 자동으로 기록한다.

---

## 4. Hardhat 로컬 데모 실행

### 4-1. 서버 기동

```powershell
cd internal/integration
npm run demo:start
```

아래와 같이 배너가 출력되면 준비 완료다.

```
╔═══════════════════════════════════════════════════════════════╗
║       issuer-service 로컬 데모 준비 완료                       ║
╠═══════════════════════════════════════════════════════════════╣
║  체인         : Hardhat 로컬 (chainId=31337)                  ║
║  WebhookServer: http://localhost:19877                        ║
║  VASPServer   : http://localhost:19876                        ║
╚═══════════════════════════════════════════════════════════════╝
```

기동 순서 (자동으로 처리됨):
1. Docker 네트워크 생성 (`kyobo-demo-net`) + 기존 컨테이너 정리
2. PostgreSQL(:15432) + Redis(:16379) + Hardhat(:8545) 컨테이너 기동
3. DB 스키마 적용 + 시드 (issuance_policies, user_wallet_mapping)
4. MockVASP 컨트랙트 배포 (Hardhat)
5. **Java internal-ledger 컨테이너 기동 (:19875)** — 실제 Spring Boot 서비스
6. VASPServer 기동 (:19876)
7. Redis Stream + Consumer Group 초기화
8. issuer-service 기동 (:19877)

### 4-2. 발행 요청 (별도 터미널)

```powershell
cd internal/integration

# 기본 (demo-user-001, steps=15000)
npm run demo:issue

# 사용자·걸음수 지정
npm run demo:issue -- demo-user-002 20000
```

### 4-3. 결과 확인

`start` 터미널에서 5초마다 DB 스냅샷이 자동 출력된다.

```
─── DB 상태 스냅샷 ─────────────────────────────────────────────
  [issuance_requests]  status=CONFIRMED    tx=0x1a2b3c…  user=demo-user-001
  [mint_requests]      status=CONFIRMED    tx=0x1a2b3c…
  [tx_mint_requests]   status=CONFIRMED    tx=0x1a2b3c…
  [user_nft_holdings]  userId=demo-user-001  tokenId=…  amount=1
  [audit_log]          actor=demo-user-001  action=ISSUANCE_CONFIRMED  chained=Y
```

### 4-4. 종료

```
Ctrl+C
```

컨테이너 자동 정리.

---

## 5. Sepolia 테스트넷 데모 실행

> 3절의 `.env` 설정이 완료되어 있어야 한다.

### 5-1. 서버 기동

```powershell
cd internal/integration
npm run demo:start-sepolia
```

기동 시 MockVASP를 Sepolia에 자동 배포한다 (30~60초 소요).

```
[4] MockVASP 컨트랙트 배포 (Sepolia)...
  [deploy] MockVASP 배포 중 (Sepolia TX 브로드캐스트)...
  [deploy] MockVASP → 0xAbCd...
  [.env] SEPOLIA_MOCK_VASP_ADDR → 0xAbCd...
```

배너 출력되면 준비 완료.

### 5-2. 발행 요청

```powershell
cd internal/integration
npm run demo:issue-sepolia
npm run demo:issue-sepolia -- demo-user-001 20000
```

> Sepolia는 블록 생성이 ~12초이므로 **NFT_ISSUED 콜백까지 20~30초** 대기 필요.

### 5-3. 종료

```
Ctrl+C
```

---

## 6. burst — 동시 5명 발행 테스트

5명의 사용자에게 동시에 웹훅을 보내 병렬 발행 파이프라인을 확인하는 시나리오다.

**서버가 기동된 상태에서** 별도 터미널로 실행:

```powershell
# Hardhat 로컬
npm run demo:scenario -- burst

# Sepolia
npm run demo:scenario-sepolia -- burst
```

정상 완료 시 `user_nft_holdings`에 5개의 row가 각각 다른 user_id로 생성된다.

```powershell
# 결과 확인
docker exec -it kyobo-demo-postgres psql -U postgres `
  -c "SELECT user_id, token_id, amount FROM user_nft_holdings ORDER BY user_id;"

# Sepolia
docker exec -it kyobo-sepolia-postgres psql -U postgres `
  -c "SELECT user_id, token_id, amount FROM user_nft_holdings ORDER BY user_id;"
```

---

## 7. 실패 시나리오 CLI

서버(`start` 또는 `start-sepolia`)가 실행 중인 상태에서 **별도 터미널**로 실행한다.

```powershell
# Hardhat
npm run demo:scenario -- <시나리오> [userId]

# Sepolia
npm run demo:scenario-sepolia -- <시나리오> [userId]
```

### 시나리오 목록

| 시나리오 | 명령 | 설명 |
|---|---|---|
| **revert** | `-- revert` | MockVASP TX on-chain revert → `issuance_requests FAILED` |
| **no-emit** | `-- no-emit` | mint 성공 + Issued 이벤트 없음 → ChainEventListener 폴백 경로 |
| **invalid-hmac** | `-- invalid-hmac` | HMAC 서명 위조 → WebhookServer 401, 파이프라인 진입 없음 |
| **unknown-user** | `-- unknown-user` | wallet mapping 없는 userId → `issuance_requests FAILED` |
| **pending** | `-- pending` | TX mempool 체류 → 30초 후 자동 복원 |
| **reorg** | `-- reorg` | 체인 롤백 시뮬레이션 |
| **poll-stale** | `-- poll-stale` | PENDING 10분 초과 강제 복구 |
| **burst** | `-- burst` | 동시 5명 발행 |
| **reset** | `-- reset` | MockVASP mode → NORMAL 복원 |

### 시나리오 상세

#### revert

```
MockVASP.setMode(REVERT) → 웹훅 전송
→ estimateGas 단계에서 revert
→ VASPServer: VASP API 500
→ TxStateMachine: REQUESTED → FAILED
→ issuance_requests.status = FAILED
```

확인:
```powershell
docker exec -it kyobo-demo-postgres psql -U postgres `
  -c "SELECT user_id, status, fail_reason FROM issuance_requests ORDER BY created_at DESC LIMIT 3;"
```

#### no-emit

```
MockVASP.setMode(NO_EMIT) → 웹훅 전송
→ mint TX 성공, Issued 이벤트 미발행
→ ChainEventListener: 이벤트 수신 없음
→ tx_mint_requests.status = SUBMITTED 유지 (CONFIRMED 전이 없음)
```

> `poll-stale` 시나리오로 수동 복구 가능.

#### invalid-hmac

```
조작된 HMAC-SHA256 서명으로 POST /webhook
→ WebhookServer: 서명 검증 실패 → HTTP 401
→ Redis Stream 적재 없음, DB 변화 없음, 온체인 TX 없음
```

#### unknown-user

```
user_wallet_mapping에 없는 userId로 웹훅 전송
→ IssuerService.getUserAccount() 실패
→ issuance_requests.status = FAILED
```

#### pending

| 환경 | 구현 방법 |
|---|---|
| Hardhat | `evm_setAutomine(false)` → TX 체류 → 30초 후 `evm_setAutomine(true)` + `evm_mine()` |
| Sepolia | nonce 블로커 TX(maxFeePerGas=1 wei) → 30초 후 replacement TX |

30초 대기 중 DB 확인:
```powershell
docker exec -it kyobo-demo-postgres psql -U postgres `
  -c "SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 3;"
```

#### reorg

| 환경 | 구현 방법 |
|---|---|
| Hardhat | `evm_snapshot` 저장 → 발행 → `evm_revert(snapshotId)` |
| Sepolia | 정상 발행 후 DB에 `status='REORGED'` 직접 주입 |

#### poll-stale

```
NO_EMIT 모드 → TX 채굴 성공 + Issued 이벤트 없음
→ DB 조작: SUBMITTED → PENDING + created_at -11분
→ POST :19870/admin/poll-stale
  → pollStaleRequests() → getTransferStatus() → MINED → CONFIRMED
→ issuance_requests CONFIRMED
```

Sepolia에서 실행 시:
```powershell
npm run demo:scenario-sepolia -- poll-stale demo-user-001
```

#### reset

비정상 종료 후 MockVASP가 REVERT/NO_EMIT 모드로 남아 있을 때 복원한다.

```powershell
npm run demo:scenario -- reset        # Hardhat
npm run demo:scenario-sepolia -- reset  # Sepolia
```

> Sepolia reset이 `AccessControl 오류`로 실패하면 `.env`의 `SEPOLIA_MOCK_VASP_ADDR`이 구버전 컨트랙트를 가리키는 것이다.  
> `npm run demo:start-sepolia`을 다시 실행하면 새 컨트랙트를 배포하고 `.env`를 자동 업데이트한다.

---

## 8. DB 직접 조회

### Hardhat 로컬 (`kyobo-demo-postgres`)

```powershell
# 발행 요청 상태
docker exec -it kyobo-demo-postgres psql -U postgres `
  -c "SELECT user_id, status, tx_hash, fail_reason FROM issuance_requests ORDER BY created_at DESC;"

# NFT 보유 현황
docker exec -it kyobo-demo-postgres psql -U postgres `
  -c "SELECT user_id, token_id, amount, on_chain_tx FROM user_nft_holdings ORDER BY user_id;"

# TX 상태 머신
docker exec -it kyobo-demo-postgres psql -U postgres `
  -c "SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 5;"

# 감사 로그 (체인 해시 검증)
docker exec -it kyobo-demo-postgres psql -U postgres `
  -c "SELECT actor, action, resource_type, checksum, prev_checksum FROM audit_log ORDER BY id;"

# Redis Stream 메시지 확인
docker exec -it kyobo-demo-redis redis-cli XRANGE kyobo:events - +
```

### Sepolia (`kyobo-sepolia-postgres`)

위와 동일한 쿼리, 컨테이너 이름만 교체:

```powershell
docker exec -it kyobo-sepolia-postgres psql -U postgres `
  -c "SELECT user_id, token_id, amount, on_chain_tx FROM user_nft_holdings ORDER BY user_id;"
```

---

## 9. 아키텍처 및 발행 흐름

```
demo:issue (CLI)
  → HTTP POST :19877 (HMAC-SHA256 서명된 ACTIVITY_ACHIEVED 웹훅)
                │
                ▼
        WebhookServer (:19877)
          → XADD kyobo:events (Redis Stream)
                │
                ▼
        ActivityProcessor (activity-consumers)
          → IssuerService.issueActivityNFT()
            ├─ Java 스텁에서 사용자 지갑 주소 조회
            ├─ KYC / AML 확인
            └─ VASPServer POST /transactions → TX 브로드캐스트
                │
                ▼
        VASPServer (:19876)
          → MockVASP.mint() TX 확정 대기
          → Issued 이벤트 emit
          → HMAC 서명 NFT_ISSUED 콜백 → :19877
                │
     ┌──────────┴───────────────┐
     ▼                          ▼
ChainEventListener          NFTIssuedProcessor (nft-consumers)
  Issued 이벤트 감지            → user_nft_holdings UPSERT
  → SUBMITTED → CONFIRMED
  → issuance_requests CONFIRMED
```

### 발행 단계별 로그

| 단계 | 로그 키워드 |
|---|---|
| 웹훅 수신 | `[WebhookPublishHandler] XADD` |
| Activity 처리 | `[ActivityProcessor] 처리 시작` |
| TX 브로드캐스트 | `[TxTransitionBridge] REQUESTED → SUBMITTED` |
| 블록 확정 | `[IssuanceConfirmHandler] Issued 이벤트 수신` |
| NFT 원장 기록 | `[PgNFTLedger] user_nft_holdings 기록 완료` |
| 최종 확정 | `[TxTransitionBridge] issuance_requests CONFIRMED` |

---

## 10. 상태 전이표

### tx_mint_requests (온체인 TX 상태 머신)

```
REQUESTED ──→ SUBMITTED ──→ PENDING ──→ MINED ──→ CONFIRMED ──→ FINALIZED
                               │           │
                               └──→ FAILED ┘     MINED ──→ REORGED ──→ MINED 또는 FAILED
```

> 데모 정상 흐름: `REQUESTED → SUBMITTED → MINED → CONFIRMED`  
> (Hardhat은 즉시 채굴이므로 PENDING 생략 가능)

### mint_requests / issuance_requests

```
SUBMITTED ──(CONFIRMED 이벤트)──→ CONFIRMED
SUBMITTED ──(FAILED 이벤트)────→ FAILED
```

---

## 11. 트러블슈팅

### Docker가 실행되지 않는다

- Rancher Desktop 트레이 아이콘이 초록색인지 확인
- `docker ps` 명령이 동작하는지 확인
- Rancher Desktop 재시작 후 재시도

### `build:hardhat` 빌드 실패

```powershell
# 캐시 제거 후 재시도
docker system prune -f
npm run build:hardhat
```

### 포트 충돌 (address already in use)

데모가 사용하는 포트: `8545, 15432, 16379, 19870, 19875, 19876, 19877`

```powershell
# 점유 프로세스 확인
netstat -ano | Select-String "<포트번호>"

# 점유 Docker 컨테이너 정리
docker ps -a
docker stop <컨테이너명>
```

### Sepolia TX 계속 실패 (VASP API 500)

원인 및 확인 순서:

1. **Sepolia ETH 잔액 부족** → faucet에서 추가 수령
2. **RPC URL 오류** → `.env`의 `SEPOLIA_RPC_URL` 확인, Alchemy 대시보드에서 키 유효성 확인
3. **MockVASP 컨트랙트 stale** → `npm run demo:start-sepolia` 재실행 (자동 재배포)

### Sepolia `reset` 명령 AccessControl 오류

`.env`의 `SEPOLIA_MOCK_VASP_ADDR`이 이전 세션 컨트랙트를 가리키는 경우다.  
`npm run demo:start-sepolia`을 다시 실행하면 새 컨트랙트를 배포하고 자동으로 수정된다.

### `user_nft_holdings`에 1개 row만 생긴다 (burst)

이전 세션의 코드를 사용 중인 경우다. 최신 코드로 업데이트 후 재시도:

```powershell
git pull
```

### DB에 아무것도 안 쌓인다

- `start` 터미널에서 에러 로그 확인
- `docker ps`로 컨테이너 3개가 모두 실행 중인지 확인
- 잠깐 기다린다 — Hardhat은 즉시, Sepolia는 최대 30초 소요

---

## 포트 정리

| 포트 | 서비스 | Hardhat | Sepolia |
|---|---|---|---|
| 8545 | Hardhat EVM RPC | ✓ | — |
| 15432 | PostgreSQL | ✓ | ✓ |
| 16379 | Redis | ✓ | ✓ |
| 19870 | Admin HTTP (`POST /admin/poll-stale`) | ✓ | ✓ |
| 19875 | Java API 스텁 | ✓ | ✓ |
| 19876 | VASPServer | ✓ | ✓ |
| 19877 | WebhookServer (issuer-service) | ✓ | ✓ |

---

## 파일 구조

```
internal/integration/local-demo/
├── start.ts              # Hardhat 데모 서버 기동
├── start-sepolia.ts      # Sepolia 데모 서버 기동
├── issue.ts              # Hardhat 발행 요청 CLI
├── issue-sepolia.ts      # Sepolia 발행 요청 CLI
├── scenario.ts           # Hardhat 실패 시나리오 CLI
├── scenario-sepolia.ts   # Sepolia 실패 시나리오 CLI
└── DEMO_GUIDE.md         # 이 파일
```
