# issuer-service 실행 가이드

이 가이드는 시나리오 데모와 자동화 통합 테스트를 실행하는 방법을 다룬다.  
파이프라인 설계·아키텍처 설명은 `issuer-service_강의자료.md`를 참고한다.

---

## 목차

1. [사전 준비](#1-사전-준비)
2. [환경변수 설정](#2-환경변수-설정)
3. [Part 1 — 시나리오 데모](#part-1--시나리오-데모)
4. [Part 2 — 자동화 통합 테스트](#part-2--자동화-통합-테스트)
5. [DB 직접 조회](#db-직접-조회)
6. [트러블슈팅](#트러블슈팅)
7. [파일 구조](#파일-구조)

---

## 1. 사전 준비

### Rancher Desktop (Docker 런타임)

1. https://rancherdesktop.io 에서 설치 파일 다운로드
2. 설치 후 실행 → 우측 하단 트레이 아이콘이 초록색이 될 때까지 대기
3. **"Container Engine"** 선택 화면에서 **`dockerd (moby)`** 선택 (기본값 `containerd` 아님)

```powershell
docker --version   # Docker version 26.x.x 이상
node --version     # v20 이상
git --version
```

### 저장소 클론 및 의존성 설치

```powershell
git clone https://github.com/coincraft12/kyobo-digital-asset-platform.git
cd kyobo-digital-asset-platform
npm install
cd blockchain; npm install; cd ..
```

### Docker 이미지 빌드 (최초 1회)

```powershell
cd internal/integration

npm run build:hardhat   # Hardhat EVM 노드 이미지
npm run build:java      # Java internal-ledger 이미지 (3~5분 소요)
```

```powershell
docker images | Select-String "kyobo"
# kyobo/hardhat-node      test   ...
# kyobo/internal-ledger   test   ...
```

> `build:java`는 Docker 내부에서 Maven 빌드를 실행한다. 로컬에 Java가 없어도 된다.  
> 소스 변경 시에만 재빌드 필요.

---

## 2. 환경변수 설정

루트 `.env.example`을 복사해 `.env`를 만든다.

```powershell
Copy-Item .env.example .env
```

### Hardhat 로컬 모드만 사용할 경우

`.env`를 수정하지 않아도 된다.

### Sepolia 테스트넷을 사용할 경우

아래 2가지 값만 채우면 된다.

```
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<YOUR_ALCHEMY_KEY>
SEPOLIA_OPERATOR_KEY=<개인키>
```

> `DEPLOYER_PRIVATE_KEY`는 미설정 시 `SEPOLIA_OPERATOR_KEY`와 동일 키로 자동 사용된다.

#### SEPOLIA_RPC_URL — Alchemy 무료 계정으로 발급

1. https://www.alchemy.com 에서 무료 계정 생성
2. 대시보드 → "Create new app" → Network: **Ethereum Sepolia** 선택
3. 생성된 앱의 API Key 복사 후 `.env`에 붙여넣기

#### SEPOLIA_OPERATOR_KEY — MetaMask 테스트 계정

1. [MetaMask](https://metamask.io) 설치 후 **새 계정 생성** (기존 메인넷 계정 사용 금지)
2. 설정 → 개인키 내보내기 → `.env`에 붙여넣기

> ⚠ 개인키는 외부 노출 금지. 이 계정에는 테스트용 Sepolia ETH만 보관할 것.

#### Sepolia ETH 받기

- https://sepolia-faucet.pk910.de — PoW 방식, 많이 줌 (추천)
- https://faucets.chain.link/sepolia — Chainlink, 소량

OPERATOR 주소에 **0.1 ETH 이상** 필요.

> `SEPOLIA_MOCK_VASP_ADDR`는 설정하지 않아도 된다. 실행 시 자동 배포 후 `.env`에 기록된다.

---

## Part 1 — 시나리오 데모

실제 Docker 컨테이너(PostgreSQL·Redis·Hardhat·Java)를 띄우고 NFT 발행 전 과정을 직접 확인하는 인터랙티브 환경이다.

| 모드 | 블록체인 | 특징 |
|---|---|---|
| **Hardhat 로컬** | 로컬 컨테이너 (chainId=31337) | 즉시 채굴, 인터넷 불필요, 가스비 없음 |
| **Sepolia** | Ethereum Sepolia (chainId=11155111) | 실제 공개 테스트넷, 블록 ~12s |

### 1-1. Hardhat 로컬 데모

**터미널 1 — 서버 기동:**

```powershell
cd internal/integration
npm run demo:start
```

배너가 출력되면 준비 완료:

```
╔═══════════════════════════════════════════════════════════════╗
║       issuer-service 로컬 데모 준비 완료                       ║
╠═══════════════════════════════════════════════════════════════╣
║  체인         : Hardhat 로컬 (chainId=31337)                  ║
║  WebhookServer: http://localhost:19877                        ║
║  VASPServer   : http://localhost:19876                        ║
╚═══════════════════════════════════════════════════════════════╝
```

**터미널 2 — 발행 요청:**

```powershell
cd internal/integration

# 기본 (demo-user-001, steps=15000)
npm run demo:issue

# 사용자·걸음수 지정
npm run demo:issue -- demo-user-002 20000
```

서버 터미널에서 5초마다 DB 스냅샷이 자동 출력된다.

**종료:**

```
Ctrl+C
```

컨테이너 자동 정리.

---

### 1-2. Sepolia 테스트넷 데모

```powershell
cd internal/integration
npm run demo:start-sepolia
```

기동 시 MockVASP를 Sepolia에 자동 배포한다 (30~60초 소요).

```powershell
cd internal/integration
npm run demo:issue-sepolia
npm run demo:issue-sepolia -- demo-user-001 20000
```

> Sepolia는 블록 생성이 ~12초이므로 NFT_ISSUED 콜백까지 20~30초 대기 필요.

---

### 1-3. 실패 시나리오 CLI

서버가 실행 중인 상태에서 **별도 터미널**로 실행한다.

```powershell
# Hardhat
npm run demo:scenario -- <시나리오> [userId]

# Sepolia
npm run demo:scenario-sepolia -- <시나리오> [userId]
```

| 시나리오 | 설명 | 최종 상태 |
|---|---|---|
| `revert` | MockVASP TX on-chain revert → Redis 재시도 | FAILED |
| `no-emit` | mint 성공 + Issued 이벤트 없음 | SUBMITTED 유지 |
| `invalid-hmac` | HMAC 서명 위조 → WebhookServer 401 | DB 변화 없음 |
| `unknown-user` | wallet mapping 없는 userId | FAILED |
| `pending` | TX mempool 체류 → 30초 후 자동 복원 | CONFIRMED |
| `reorg` | 체인 롤백 시뮬레이션 (DB 상태 직접 주입) | REORGED |
| `poll-stale` | PENDING 10분 초과 강제 복구 | CONFIRMED |
| `burst` | 동시 5명 발행 | 전체 CONFIRMED |
| `reset` | MockVASP mode → NORMAL 복원 | — |

---

### 1-4. 포트 정리

| 포트 | 서비스 | Hardhat | Sepolia |
|---|---|---|---|
| 8545 | Hardhat EVM RPC | ✓ | — |
| 15432 | PostgreSQL | ✓ | ✓ |
| 16379 | Redis | ✓ | ✓ |
| 19870 | Admin HTTP (`POST /admin/poll-stale`) | ✓ | ✓ |
| 19875 | Java internal-ledger | ✓ | ✓ |
| 19876 | VASPServer | ✓ | ✓ |
| 19877 | WebhookServer (issuer-service) | ✓ | ✓ |

---

## Part 2 — 자동화 통합 테스트

코드 변경 후 전체 파이프라인이 정상 동작하는지 자동으로 검증한다.

### 2-1. mock-vasp 통합 테스트 (9가지 시나리오)

```powershell
cd internal/integration
npm run test:mock-vasp
```

예상 출력:

```
  PASS __tests__/issuer-service-mock-vasp.integration.test.ts
    ✔ [1] NORMAL — 정상 발행 → VASPServer NFT_ISSUED 콜백 → Redis Stream → ledger + CONFIRMED
    ✔ [2] REVERT — TX revert → VASPServer 500 → FAILED
    ✔ [3] NO_EMIT — mint 성공, Issued 이벤트 없음 → SUBMITTED 유지
    ✔ [4] PENDING — 블록 중단 → TX 체류 → mineBlock → CONFIRMED
    ✔ [5] REORG — snapshot → 발행 → revertToSnapshot → 온체인 원복
    ✔ [stream-2] 동일 requestId 중복 주입 → 멱등성 보장
    ✔ [stream-3] retryCount >= 3 → DLQ 이동
    ✔ [stream-4] XAUTOCLAIM — PEL 잔류 메시지 재수신
    ✔ [poll-1] pollStaleRequests — SUBMITTED → PENDING 조작 → CONFIRMED
    ✔ [burst] 동시 5명 웹훅 → 전체 CONFIRMED

  Tests: 10 passed, 10 total
```

### 2-2. Sepolia 통합 테스트 (6가지 시나리오)

`.env`에 `SEPOLIA_RPC_URL`, `SEPOLIA_OPERATOR_KEY`, `SEPOLIA_MOCK_VASP_ADDR`, `DEPLOYER_PRIVATE_KEY` 설정 필요.

MockVASP 배포 (최초 1회):

```powershell
cd blockchain
npx hardhat run scripts/deploy/deploy-mock-vasp.ts --network sepolia
```

출력된 주소를 `.env`의 `SEPOLIA_MOCK_VASP_ADDR`에 기입.

테스트 실행:

```powershell
cd internal/integration
npm run test:sepolia
```

예상 출력:

```
  PASS __tests__/issuer-service-sepolia.integration.test.ts (약 10분)
    ✔ [1] NORMAL — 정상 발행 → Issued 이벤트 → CONFIRMED  (~2분)
    ✔ [2] REVERT — TX revert → issuance_requests FAILED    (~1분)
    ✔ [3] NO_EMIT — mint 성공, Issued 이벤트 없음 → SUBMITTED 유지  (~2분)
    ✔ [stream-2] 동일 requestId 중복 주입 → 멱등성 보장
    ✔ [stream-3] retryCount >= 3 → DLQ 이동
    ✔ [stream-4] XAUTOCLAIM — PEL 잔류 메시지 재수신

  Tests: 6 passed, 6 total
```

### 2-3. Etherscan에서 NFT 확인 (Sepolia)

```
# 토큰 전송 내역
https://sepolia.etherscan.io/address/<OPERATOR_ADDRESS>#tokentxns

# 컨트랙트에서 잔고 직접 조회
https://sepolia.etherscan.io/address/<SEPOLIA_MOCK_VASP_ADDR>#readContract
→ balanceOf(account, id)
```

---

## DB 직접 조회

### Hardhat 로컬 (`kyobo-demo-postgres`)

```powershell
# 발행 요청 상태
docker exec -it kyobo-demo-postgres psql -U postgres -c "SELECT user_id, status, tx_hash, fail_reason FROM issuance_requests ORDER BY created_at DESC;"

# NFT 보유 현황
docker exec -it kyobo-demo-postgres psql -U postgres -c "SELECT user_id, token_id, amount, on_chain_tx FROM user_nft_holdings ORDER BY user_id;"

# TX 상태 머신
docker exec -it kyobo-demo-postgres psql -U postgres -c "SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 5;"

# 감사 로그
docker exec -it kyobo-demo-postgres psql -U postgres -c "SELECT actor, action, resource_type, checksum, prev_checksum FROM audit_log ORDER BY id;"

# Redis Stream
docker exec -it kyobo-demo-redis redis-cli XRANGE kyobo:events - +
```

### Sepolia (`kyobo-sepolia-postgres`)

```powershell
docker exec -it kyobo-sepolia-postgres psql -U postgres -c "SELECT user_id, status, tx_hash, fail_reason FROM issuance_requests ORDER BY created_at DESC;"

docker exec -it kyobo-sepolia-postgres psql -U postgres -c "SELECT user_id, token_id, amount, on_chain_tx FROM user_nft_holdings ORDER BY user_id;"

docker exec -it kyobo-sepolia-postgres psql -U postgres -c "SELECT status, tx_hash FROM tx_mint_requests ORDER BY created_at DESC LIMIT 5;"

docker exec -it kyobo-sepolia-postgres psql -U postgres -c "SELECT actor, action, resource_type, checksum, prev_checksum FROM audit_log ORDER BY id;"

docker exec -it kyobo-sepolia-redis redis-cli XRANGE kyobo:events - +
```

---

## 트러블슈팅

### Docker가 실행되지 않는다

- Rancher Desktop 트레이 아이콘이 초록색인지 확인
- `docker ps` 명령이 동작하는지 확인
- Rancher Desktop 재시작

### `build:java` 빌드 실패

```powershell
docker system prune -f
npm run build:java
```

### 포트 충돌 (address already in use)

```powershell
netstat -ano | Select-String "<포트번호>"
docker ps -a
docker stop <컨테이너명>
```

### Sepolia TX 계속 실패

1. Sepolia ETH 잔액 부족 → faucet에서 추가 수령
2. RPC URL 오류 → `.env`의 `SEPOLIA_RPC_URL` 확인
3. MockVASP 컨트랙트 stale → `npm run demo:start-sepolia` 재실행

### Sepolia `reset` AccessControl 오류

`.env`의 `SEPOLIA_MOCK_VASP_ADDR`이 이전 세션 컨트랙트를 가리키는 경우.  
`npm run demo:start-sepolia`을 다시 실행하면 새 컨트랙트를 배포하고 자동으로 수정된다.

---

## 파일 구조

```
internal/integration/local-demo/
├── start.ts              # Hardhat 데모 서버 기동
├── start-sepolia.ts      # Sepolia 데모 서버 기동
├── issue.ts              # Hardhat 발행 요청 CLI
├── issue-sepolia.ts      # Sepolia 발행 요청 CLI
├── scenario.ts           # Hardhat 실패 시나리오 CLI
└── scenario-sepolia.ts   # Sepolia 실패 시나리오 CLI

internal/integration/__tests__/
├── issuer-service-mock-vasp.integration.test.ts   # 9가지 시나리오 (Hardhat)
└── issuer-service-sepolia.integration.test.ts     # 6가지 시나리오 (Sepolia)
```
