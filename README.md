# KYOBO Digital Assets Platform

교보생명 디지털 자산 NFT · KRW 스테이블코인 · 증권형토큰(STO) 발행 플랫폼의 실습 학습 플랫폼.

> **학습 환경**: Windows 10/11 · PowerShell · Node.js 20 · Java 17 · Docker 필요

> **TypeScript 사전 준비**: 이 프로젝트에서 사용하는 라이브러리 TypeScript 타입 정리 → [kyobo-ts-prep](https://github.com/coincraft12/kyobo-ts-prep)

---

## 목차

1. [전제 조건](#1-전제-조건)
2. [저장소 및 환경 설정](#2-저장소-및-환경-설정)
3. [패키지 설치 및 전체 빌드](#3-패키지-설치-및-전체-빌드)
4. [테스트](#4-테스트)
5. [학습 파일 실행 가이드](#5-학습-파일-실행-가이드)
6. [스마트컨트랙트 컴파일](#6-스마트컨트랙트-컴파일)
7. [프로젝트 구조](#7-프로젝트-구조)
8. [강의 자료](#8-강의-자료)
9. [트러블슈팅](#9-트러블슈팅)
10. [Docker 개발 환경](#10-docker-개발-환경)

---

## 1. 전제 조건

### 1-1. 버전 확인

PowerShell에서 아래 명령 실행 — 모두 버전 번호가 출력되면 [2. 저장소 및 환경 설정](#2-저장소-및-환경-설정)으로 이동.

```powershell
node -v        # v20.x.x 이상
npm -v         # 10.x.x 이상
git --version  # git version 2.x.x
java -version  # openjdk 17 이상
```

---

### 1-2. Node.js 설치

1. [https://nodejs.org](https://nodejs.org) 접속
2. **LTS** 버튼 클릭 후 `.msi` 설치 파일 실행
3. 설치 완료 후 실행 시 모든 기본값으로 Next → Finish
4. PowerShell **닫고 새로 열기** (환경변수 반영)
5. 설치 확인:

```powershell
node -v   # v20.x.x
npm -v    # 10.x.x
```

> npm은 Node.js 설치 시 자동 포함. 별도 설치 불필요.

---

### 1-3. Git 설치

1. [https://git-scm.com/download/win](https://git-scm.com/download/win) 접속 후 자동 다운로드 시작
2. 설치 완료 후 실행 시 아래 두 항목 확인, 나머지는 기본값으로 진행:
   - **Adjusting your PATH environment** → `Git from the command line and also from 3rd-party software` 선택
   - **Configuring the line ending conversions** → `Checkout Windows-style, commit Unix-style line endings` 선택
3. PowerShell **닫고 새로 열기**
4. 설치 확인:

```powershell
git --version   # git version 2.x.x.windows.x
```

**처음 1회만 사용자 정보 등록**

```powershell
git config --global user.name "홍길동"
git config --global user.email "hong@example.com"
```

---

### 1-4. Java 17 설치

`internal-ledger` (Spring Boot 영구 원장 서비스) 빌드 및 테스트에 필요합니다.

1. [https://adoptium.net](https://adoptium.net) 접속 → **Temurin 17 (LTS)** 다운로드
2. `.msi` 설치 파일 실행 — **"Add to PATH"**, **"Set JAVA_HOME"** 체크박스 활성화 확인
3. PowerShell 닫고 새로 열기
4. 설치 확인:

```powershell
java -version   # openjdk version "17.x.x"
```

> Maven은 별도 설치 불필요. `internal-ledger/mvnw.cmd`가 최초 실행 시 Maven 3.9.6을 자동 다운로드합니다.

---

### 1-5. Sepolia 테스트넷 설정 (실습 시 필수)

Sepolia는 이더리움 테스트넷으로 실제 비용 없이 학습 가능합니다. 실습 시작 전 아래 3단계를 완료하세요.

#### ① Sepolia RPC URL

별도 가입 없이 아래 공용 URL을 그대로 사용합니다:

```
https://ethereum-sepolia-rpc.publicnode.com
```

#### ② MetaMask 설치 + Sepolia 테스트넷 추가

**데스크탑 (Chrome 확장)**

1. [metamask.io](https://metamask.io) → 브라우저 확장 설치
2. 지갑 새로 생성 후 시드구문을 안전하게 보관 (분실 시 복구 불가)
3. 상단 네트워크 드롭다운 → **Sepolia 테스트넷** 추가
   - 보이지 않으면 설정 → 고급 → 테스트 네트워크 표시 ON

**모바일 (iOS / Android)**

1. App Store 또는 Google Play에서 **MetaMask** 설치
2. 지갑 새로 생성 (또는 데스크탑 시드구문으로 복구)
3. 왼쪽 상단 네트워크 아이콘 탭 → 설정 → 고급 → 테스트 네트워크 표시 ON
4. 상단 네트워크 → **Sepolia** 선택

> **학습 전용 지갑 권장**: 기존 메인넷 지갑과 분리된 새 지갑을 사용하세요.

#### ③ 테스트넷 ETH 수령 (최소 0.5 ETH)

아래 faucet에서 수령:

**[https://sepolia-faucet.pk910.de](https://sepolia-faucet.pk910.de)**

지갑 주소 입력 후 채굴 시작 후 0.5 ETH 이상 쌓이면 수령 가능.

수령 후 MetaMask에서 Sepolia ETH 잔액 확인 후 0 이상이면 완료.

#### ④ .env에 입력

```powershell
# blockchain/.env
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
DEPLOYER_PRIVATE_KEY=0x학습용지갑프라이빗키
```

> **학습 전용 지갑의 프라이빗 키만 사용. 메인넷에 자산이 있는 지갑은 절대 사용 금지.**

**MetaMask 개인키 내보내기 — 데스크탑**

1. MetaMask 확장 열기
2. 오른쪽 상단 계정 메뉴 클릭 후 **계정 세부 정보**
3. **개인 키 내보내기** 클릭
4. MetaMask 비밀번호 입력 후 표시 후 복사

**MetaMask 개인키 내보내기 — 모바일**

1. 왼쪽 상단 네트워크 아이콘 탭 후 계정 선택
2. 계정 이름 옆 ⋮ 세 점 → **계정 세부 정보**
3. **개인 키 내보내기** 탭
4. MetaMask 비밀번호 입력 후 표시 후 복사

---

### 1-6. VS Code 설치 (선택 사항, 실습에 적극 권장)

1. [https://code.visualstudio.com](https://code.visualstudio.com) 접속 → Download for Windows
2. 설치 완료 후 아래 확장 설치:

```powershell
code --install-extension dbaeumer.vscode-eslint
code --install-extension esbenp.prettier-vscode
code --install-extension juanblanco.solidity
```

---

### 최종 확인

```powershell
node -v; npm -v; git --version; java -version
```

위 네 명령 모두 버전 출력 후 다음 단계로 진행.

---

## 2. 저장소 및 환경 설정

```powershell
# 프로젝트 저장소 클론
git clone https://github.com/coincraft12/kyobo-digital-asset-platform.git
cd kyobo-digital-asset-platform
```

### 환경 변수 설정

```powershell
# .env.example을 .env 복사
copy .env.example .env
```

`internal\.env`를 열어 아래 항목 입력 후 나머지는 기본값으로 진행:

```
EVM_SIGNER_KEY=0x...   # 테스트넷 전용 계정 개인키 (MetaMask에서 개인 키 내보내기)
```

> ⚠ 실제 자산이 있는 계정 개인키는 절대 입력 금지. 테스트넷 전용 계정만 사용.

온체인 실습(M6 이후)이 되면 추가 환경 변수가 필요합니다.
M2~M5 실습은 Mock 환경 사용 — `EVM_SIGNER_KEY` 없이도 진행.

---

## 3. 패키지 설치 및 전체 빌드

```powershell
# npm workspaces 패키지 설치 (최초 1회)
npm install

# 전체 빌드 (TypeScript + Solidity + Java)
npm run build:all
```

`build:all` 순서:
1. 각 워크스페이스 `npm run build` 실행 (`--if-present` 로 빌드 스크립트 없는 워크스페이스 스킵)
2. `blockchain/` Solidity 컴파일 (`npx hardhat compile`)
3. `internal/internal-ledger/` Java Spring Boot 빌드 (`mvnw.cmd package -DskipTests`)

> **최초 실행 시**: `mvnw.cmd`가 Maven 3.9.6을 자동 다운로드합니다 (약 10MB, `.mvn/wrapper/`에 캐싱).

빌드 결과:
- TypeScript → `dist/` (워크스페이스별)
- Solidity → `blockchain/artifacts/` · `blockchain/typechain-types/`
- Java → `internal/internal-ledger/target/*.jar`

### Node.js만 빌드

```powershell
npm run build
```

### Solidity만 컴파일

```powershell
npm run build:hardhat
```

### Java(internal-ledger)만 빌드

```powershell
npm run build:java
```

또는 Maven Wrapper를 직접 호출:

```powershell
internal\internal-ledger\mvnw.cmd -f internal/internal-ledger/pom.xml package -DskipTests
```

---

## 4. 테스트

> **모든 테스트 명령은 프로젝트 루트(`kyobo-digital-asset-platform/`)에서 실행.**

테스트는 세 계층으로 나뉩니다.

| 계층 | 대상 | 명령 | 비고 |
|---|---|---|---|
| **Node.js 단위 테스트** | `internal/packages/*/src/__tests__/` | `npm test` | 스켈레톤 코드 정합성 검사 |
| **학습 채점 테스트** | `course/exercises/__tests__/` | `npm run test:exercises` | 학습 파일 채점 |
| **Java 통합 테스트** | `internal/internal-ledger/src/test/` | `npm run test:java` | H2 in-memory DB 사용 |

### 전체 테스트 한 번에 실행

```powershell
npm run test:all
```

`test:all` 순서:
1. Node.js 단위 테스트 (`npm test`)
2. Java 통합 테스트 (`mvnw.cmd test`)

---

### 4-1. Node.js 단위 테스트

스켈레톤 라이브러리 6개 패키지의 정합성을 검사하는 단위 테스트.
학습과 관계없이 항상 통과해야 하는 상태.

#### 전체 실행

```powershell
npm test
```

#### 워크스페이스별 실행

```powershell
npm test --workspace=internal/packages/chain-adapters
npm test --workspace=internal/packages/compliance
npm test --workspace=internal/packages/core-banking
npm test --workspace=internal/packages/shared
npm test --workspace=internal/packages/vasp
npm test --workspace=internal/packages/event-engine
```

#### 워크스페이스별 테스트 요약

| 워크스페이스 | 테스트 파일 | TC 수 | 주요 커버리지 |
|---|---|---|---|
| `chain-adapters` | 4개 | 55 | EVMAdapter · RetryDecorator · LoggingDecorator · ChainAdapterFactory |
| `compliance` | 4개 | 54 | LockupPolicy · InvestorRegistry · PermissiveCompliance · ISMSChecklist |
| `core-banking` | 4개 | 54 | LedgerService · CircuitBreaker · ReconcileService · AuditLogService |
| `shared` | 2개 | 24 | AppError · 유틸리티 |
| `vasp` | 5개 | 92 | TxStateMachine · KeyGovernance · VaspRecovery · TxAttempt · Whitelist |
| `event-engine` | 6개 | 61 | WebhookServer · RedisStream · ConsumerGroup · DLQ · E2E · IdempotencyGuard |
| **합계** | **25개** | **340** | |

#### 특정 테스트 파일만 실행

```powershell
# RetryAdapterDecorator 테스트만
npm test --workspace=internal/packages/chain-adapters -- --testPathPattern RetryAdapterDecorator

# TxStateMachineService 테스트만
npm test --workspace=internal/packages/vasp -- --testPathPattern TxStateMachine

# CircuitBreaker 테스트만
npm test --workspace=internal/packages/core-banking -- --testPathPattern CircuitBreaker
```

---

### 4-2. 학습 채점 테스트

`course/exercises/` 학습 파일을 채점하는 테스트.
**처음에는 전부 실패** → 학습 파일의 TODO를 구현하면 통과합니다.

#### 전체 채점

```powershell
npm run test:exercises
```

#### 정답 파일로 전체 채점 (수강자용)

```powershell
npm run test:exercises:answer
```

#### 특정 세션만 채점

```powershell
npm run test:exercises -- S05
npm run test:exercises -- S13
npm run test:exercises -- S23
npm run test:exercises -- S34
npm run test:exercises -- S44
npm run test:exercises -- S50
```

#### 학습 채점 테스트 요약

| 모듈 | 테스트 파일 | TC 수 | 주요 세션 |
|---|---|---|---|
| M1 | 1개 | 12 | S04 네트워크 확인 |
| M2 | 7개 | 38 | S05~S12 웹훅 · HMAC · Redis Streams · DLQ |
| M3 | 8개 | 160 | S13~S22 TX 상태머신 · 멀티체인 · 멱등성 |
| M4 | 4개 | 78 | S23~S26 원장 · 감사 로그 |
| M5 | 7개 | 139 | S27~S34 지갑 · 발행 흐름 |
| M6 | 6개 | 110 | S35~S40 스마트컨트랙트 설계 |
| M7 | 4개 | 101 | S41~S44 보안 감사 · 업그레이드 |
| M8 | 6개 | 140 | S45~S50 멀티시그 · 거버넌스 |
| **합계** | **43개** | **778** | |

---

### 4-3. Java (internal-ledger) 테스트

`internal/internal-ledger` Spring Boot 서비스의 통합 테스트.
**H2 in-memory DB를 사용**하므로 PostgreSQL 없이 실행 가능.

#### npm 스크립트로 실행 (권장)

```powershell
npm run test:java
```

#### Maven Wrapper로 직접 실행

```powershell
internal\internal-ledger\mvnw.cmd -f internal/internal-ledger/pom.xml test
```

#### internal-ledger 빌드 + 테스트 함께

```powershell
internal\internal-ledger\mvnw.cmd -f internal/internal-ledger/pom.xml verify
```

#### 현재 테스트 목록

| 테스트 파일 | TC | 내용 |
|---|---|---|
| `BlockchainGatewayControllerTest` | 1 | `GET /api/internal/health` → 200 확인 |

> Day 10 실습에서 추가 TC 직접 구현 예정 (`recordNftHolding`, `recordAuditLog`, `checksum` 등).

---

### 4-4. 타입 검사

Jest(`npm test`)는 타입 오류를 무시하고 실행합니다.
타입 오류만 검사하려면:

```powershell
npm run typecheck
```

오류 없으면 아무 출력 없이 종료. 오류 있으면 파일명과 줄 번호가 함께 출력됩니다.

---

## 5. 학습 파일 실행 가이드

### 학습 파일 위치

```
course/exercises/
├── M1/                  네트워크 확인 실습 (S04)
├── M2/                  웹훅 · Redis Streams · 재시도 · DLQ (S05~S12)
│   └── event-listener/  온체인 이벤트 리스너 서버 실습 (S05)
├── M3/                  TX 상태머신 · 멀티체인 · EVM (S13~S22)
├── M4/                  원장 · 감사 로그 (S23~S26)
├── M5/                  지갑 · 발행 흐름 (S27~S34)
├── M6/                  스마트컨트랙트 설계 (S35~S40)
├── M7/                  보안 감사 · 업그레이드 (S41~S44)
├── M8/                  멀티시그 · 거버넌스 (S45~S50)
└── __tests__/           학습 채점 테스트 (Jest)
```

### 파일 네이밍 규칙

| 파일 | 역할 |
|---|---|
| `S##_이름.ts` | 학습 파일 — **빈칸 구현 필요** |
| `S##_이름.answer.ts` | 정답 파일 — 수업 후 이틀 뒤 공개 |

### 학습 실행

#### M1 실습 (루트에서 실행)

S04는 루트에서 직접 명령으로 실행합니다.

```powershell
# S04 TypeScript 실습 (로컬 Hardhat 노드 실행 후)
npm run exercise:s04

# S04 정답 확인
npm run exercise:s04:answer
```

#### M2 · M3 실습 (event-engine 디렉토리에서 실행)

M2·M3 학습 파일은 `internal/packages/event-engine` 디렉토리에서 실행.
`import`가 `@kyobo/event-engine` 라이브러리를 참조하므로 **해당 디렉토리 안에서만 동작.**

```powershell
cd internal\packages\event-engine

# S06 Redis Streams 실습
npx ts-node ..\..\..\..\course\exercises\M2\S06_redis_stream.ts

# S08 HMAC 검증 실습
npx ts-node ..\..\..\..\course\exercises\M2\S08_hmac_webhook.ts

# S09 At-least-once 실습
npx ts-node ..\..\..\..\course\exercises\M2\S09_atleastonce.ts
```

### 실습 및 채점 사이클

```powershell
# 1. 학습 파일 열기
code course\exercises\M2\S09_atleastonce.ts

# 2. TODO 블록 구현

# 3. 특정 세션만 채점
cd internal\packages\event-engine
npx jest --config jest.exercises.config.json --testPathPattern S09

# 4. 전체 채점
npm run test:exercises
```

---

## 6. 스마트컨트랙트 컴파일

```powershell
# 컴파일 (artifacts + typechain-types 생성)
cd blockchain
npx hardhat compile

# 로컬 Hardhat 노드 실행
npx hardhat node

# 보상 포인트 NFT 배포
npx hardhat run scripts\deploy\deploy-rewards.ts --network localhost

# STO 증권형토큰 배포
npx hardhat run scripts\deploy\deploy-securities.ts --network localhost
```

루트 단축 명령:

```powershell
npm run node:local         # 로컬 노드 시작
npm run deploy:local       # 보상 NFT 배포
npm run deploy:securities  # STO 배포
```

---

## 7. 프로젝트 구조

```
kyobo-digital-asset-platform/
│
├── blockchain/                  Solidity 스마트컨트랙트 (Hardhat)
│   └── src/
│       ├── rewards/             보상 포인트 NFT (KyoboNFT)
│       ├── stablecoin/          KRW 스테이블코인
│       ├── securities/          증권형토큰 STO
│       ├── base/                BaseToken 공통 추상화
│       ├── compliance/          PermissiveCompliance · InvestorCompliance
│       ├── interfaces/          IToken · ICompliance · ISecurityToken 등
│       └── mocks/               테스트용 Mock 컨트랙트
│
├── internal/                    내부망 서비스 전체
│   ├── apps/
│   │   └── issuer-service/      NFT 발행 서비스 코어 (Node.js)
│   ├── packages/
│   │   ├── @kyobo/chain-adapters   IBlockchainAdapter (EVM / Circle / XRPL / UTXO)
│   │   ├── @kyobo/vasp             TX 상태머신 · NonceManager · 복구시스템
│   │   ├── @kyobo/core-banking     코어뱅킹 연동 · 원장 · 감사 로그
│   │   ├── @kyobo/event-engine     Redis Streams · 웹훅 · DLQ · 이벤트 처리
│   │   ├── @kyobo/compliance       KYC · AML · ISMS-P
│   │   └── @kyobo/shared           공통 유틸리티 · AppError · 설정
│   └── internal-ledger/         Java Spring Boot 영구 원장 · CoreBanking 브릿지
│       ├── src/main/java/       Spring Boot 소스
│       ├── src/test/java/       통합 테스트 (H2 in-memory DB)
│       ├── src/test/resources/  테스트 전용 application.yml (H2 설정)
│       └── mvnw.cmd             Maven Wrapper (최초 실행 시 Maven 3.9.6 자동 다운로드)
│
├── infrastructure/
│   ├── docker/                  docker-compose (PostgreSQL + Redis)
│   ├── dmz/nginx/               DMZ Nginx 설정
│   └── monitoring/prometheus/   모니터링
│
└── course/                      강의 학습 전용 폴더
    ├── exercises/               학습 파일 (M1 ~ M8)
    │   ├── M1/                  S04 실습 + answer
    │   ├── M2/ ~ M8/            S05~S50 실습 + answer
    │   └── __tests__/           학습 채점 테스트 (Jest)
    ├── PDF/                     세션별 강의슬라이드 PDF
    ├── lecture-notes/           모듈별 강의 노트 (Markdown)
    └── curriculum/              커리큘럼 문서 (day01~day13)
```

---

## 8. 강의 자료

### 슬라이드 PDF

위치: `course/PDF/`

| 파일 | 내용 |
|---|---|
| `M1_intro.pdf` | M1 오리엔테이션 |
| `S1_prior_course_connection.pdf` | S1 사전 과정 연결 |
| `S2_architecture_detail.pdf` | S2 아키텍처 상세 |
| `S3_skeleton_dependency.pdf` | S3 스켈레톤 · 패키지 의존관계 |
| `S4_dev_env_fork.pdf` | S4 개발환경 · Mainnet Fork |
| `S5_webhook_async_new.pdf` | S5 웹훅 · 202 비동기 패턴 |
| `S6_redis_streams.pdf` | S6 Redis Streams 심화 |
| `S7_streams_cli.pdf` | S7 Redis Streams CLI 실습 |

---

### 강의 노트 (Markdown)

위치: `course/lecture-notes/`

| 파일 | 내용 |
|---|---|
| `precourse-prep-guide_1.md` | 사전 준비 가이드 |
| `typescript-warmup-handout.md` | TypeScript 워밍업 핸드아웃 |
| `M1_architecture_setup.md` | 전체 아키텍처 · 개발환경 구성 |
| `M2_S5_webhook_202_pattern.md` | WebhookServer · 202 비동기 패턴 |
| `M2_S6_redis_streams_theory.md` | Redis Streams 심화 · XADD/XREAD |
| `M2_S7_redis_streams_cli.md` | Redis Streams CLI 직접 조작 |
| `M2_S8_hmac_queue_service.md` | HMAC-SHA256 서명 검증 |
| `M2_S9_atleastonce_design.md` | At-least-once · 재시도 설계 |
| `M2_S10_event_consumer_impl.md` | ConsumerGroupWorker 구현 |
| `M2_S11_dlq_design.md` | Dead Letter Queue 설계 |
| `M2_S12_finalized_e2e.md` | M2 전체 파이프라인 E2E |
| `M3_S13_tx_statemachine.md` | TX 상태머신 설계 |
| `M3_S14_multichain_adapter.md` | 멀티체인 어댑터 패턴 |
| `M3_S15_evm_implementation.md` | EVM 온체인 직접 구현 |
| `M3_S16_idempotency.md` | Idempotency 구현 |
| `M3_S17_retry_backoff.md` | 재시도 · 지수 백오프 |
| `M3_S18_tx_revert.md` | TX 롤백 처리 |
| `M3_S19_timeout_reorg.md` | 타임아웃 · 블록 재편성 |
| `M3_S20_timeout_reorg_handler.md` | 타임아웃 · 재편성 핸들러 구현 |
| `M3_S21_dual_channel.md` | 이중 채널 설계 |
| `M3_S22_pollstale_integration.md` | Stale TX 감지 통합 |
| `M4_S23_ledger_data_model.md` | 원장 데이터 모델 |
| `M4_S24_state_transition_guard.md` | 상태 전이 가드 |
| `M4_S25_reconcile_service.md` | 정산 서비스 |
| `M4_S26_audit_log_sha256.md` | 감사 로그 SHA-256 |
| `M5_S27_wallet_provisioning.md` | 지갑 프로비저닝 |
| `M5_S28_wallet_mapping_design.md` | 지갑 매핑 설계 |
| `M5_S29_eip191_signature.md` | EIP-191 서명 |
| `M5_S30_event_condition_strategy.md` | 이벤트 조건 전략 |
| `M5_S31_condition_test_strategy.md` | 조건 테스트 전략 |
| `M5_S32_single_issue_flow.md` | 단건 발행 흐름 |
| `M5_S33_bulk_issue_architecture.md` | 대량 발행 아키텍처 |
| `M5_S34_bulk_issue_impl.md` | 대량 발행 구현 |
| `M6_S35_erc1155_tokenid_design.md` | ERC-1155 토큰 ID 설계 |
| `M6_S36_uups_proxy_pattern.md` | UUPS 프록시 패턴 |
| `M6_S37_access_control_roles.md` | 역할 기반 접근제어 |
| `M6_S38_lifecycle_burn_pause_upgrade.md` | 라이프사이클 · Burn · Pause · 업그레이드 |
| `M6_S39_deployment_etherscan.md` | 배포 · Etherscan 검증 |
| `M6_S40_storage_layout_upgrade.md` | 스토리지 레이아웃 업그레이드 |
| `M7_S41_reentrancy_slither.md` | 재진입 공격 · Slither 분석 |
| `M7_S42_slither_fix.md` | Slither 취약점 수정 |
| `M7_S43_upgrade_operation.md` | 업그레이드 운영 실습 |
| `M7_S44_security_review.md` | 보안 감사 체크리스트 |
| `M8_S45_admin_api.md` | 관리자 API |
| `M8_S46_gnosis_safe.md` | Gnosis Safe 멀티시그 |
| `M8_S47_eip712_safetx.md` | EIP-712 SafeTx 서명 |
| `M8_S48_multisig_impl.md` | 멀티시그 구현 |
| `M8_S49_travel_rule.md` | 트래블룰 |
| `M8_S50_fault_injection.md` | 장애 주입 테스트 |

---

## 9. 트러블슈팅

### `npm install` 실패

```powershell
npm cache clean --force
npm install
```

### `npx ts-node` 실행 시 "Cannot find module '@kyobo/event-engine'"

학습 파일은 `internal/packages/event-engine` 디렉토리 안에서만 실행 가능:

```powershell
cd internal\packages\event-engine
npx ts-node ..\..\..\..\course\exercises\M2\S09_atleastonce.ts
```

### `npx hardhat compile` 실패 — "Function mcopy not found"

`blockchain/hardhat.config.ts`에 `evmVersion: 'cancun'` 설정 필요. 기본 포함되어 있으므로 Node.js 버전 확인 후 Node.js 20 LTS 사용 권장.

### PowerShell 스크립트 실행 거부 오류 — `npm` · `npx` 명령이 실행되지 않음

**증상**

```
npm : 이 시스템에서는 스크립트를 실행할 수 없으므로 C:\Program Files\nodejs\npm.ps1 파일을
로드할 수 없습니다.
    + CategoryInfo : 보안 오류: (:) [], PSSecurityException
    + FullyQualifiedErrorId : UnauthorizedAccess
```

**원인**

Windows PowerShell은 기본 실행 정책(`Restricted`)으로 `.ps1` 스크립트 실행을 막습니다.

**해결**

PowerShell을 **관리자 권한**으로 열고 아래 명령 실행:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

`Y` 입력 후 확인. 이후 `npm -v` 정상 출력되면 해결.

**정책 설명**

| 정책 | 효과 |
|---|---|
| `Restricted` (Windows 기본값) | 모든 스크립트 실행 차단 |
| `RemoteSigned` (권장) | 로컬 스크립트 허용, 다운로드 스크립트는 서명 필요 |
| `Unrestricted` | 모두 허용 (권장 안 함) |

### `jest` 명령을 찾을 수 없음

루트 `npm install` 완료 후 `node_modules/.bin/jest` 생성됨. `npx jest` 또는 워크스페이스 안에서 `npm test` 사용.

### Maven 빌드 시 Java 컴파일 오류

`internal-ledger` 빌드 전 Java 17 이상이 PATH에 있는지 확인:

```powershell
java -version   # openjdk 17 이상이어야 함
```

Java가 없으면 [1-4. Java 17 설치](#1-4-java-17-설치) 참고.

### Maven 최초 빌드가 느린 경우

`mvnw.cmd`가 Maven 3.9.6 및 Spring Boot 의존성을 최초 1회 다운로드합니다. 이후 실행부터는 로컬 캐시(`~/.m2/`)를 사용해 빠르게 완료됩니다.

### internal-ledger 테스트 실패 — "Cannot connect to database"

테스트는 H2 in-memory DB를 사용하므로 PostgreSQL 연결 불필요합니다.
`src/test/resources/application.yml`이 존재하는지 확인:

```powershell
Test-Path internal\internal-ledger\src\test\resources\application.yml
# True 출력되어야 함
```

---

## 10. Docker 개발 환경

PostgreSQL · Redis · Hardhat 로컬 노드를 Docker로 띄우는 방법입니다.

### 10-1. 사전 설치

#### WSL2 설치

PowerShell을 **관리자 권한**으로 열고 실행:

```powershell
wsl --install
```

설치 완료 후 **재부팅** 필요. 재부팅하면 Ubuntu 초기 설정(계정 생성)이 자동으로 뜹니다.

#### Rancher Desktop 설치

1. [https://rancherdesktop.io](https://rancherdesktop.io) 에서 Windows용 설치 파일 다운로드
2. 설치 완료 후 실행
3. **Preferences → Container Engine → `dockerd (moby)` 선택** (기본값이 `containerd`인 경우 반드시 변경)
4. 하단 상태가 `Running`이 될 때까지 대기 (최초 실행 시 수 분 소요)

설치 확인 — 터미널을 **새로 열고** 실행:

```powershell
docker --version
docker compose version
```

### 10-2. 환경 변수 설정

`infrastructure/docker/` 디렉터리에 `.env` 파일 생성:

```powershell
@"
POSTGRES_PASSWORD=kyobo_dev_pw
REDIS_PASSWORD=kyobo_redis_pw
"@ | Out-File -FilePath infrastructure\docker\.env -Encoding utf8
```

> `.env` 파일은 `.gitignore`에 포함되어 있어 커밋되지 않습니다.

### 10-3. 컨테이너 실행

```powershell
# PostgreSQL + Redis 실행 (개발 시 최소 구성)
docker compose -f infrastructure/docker/docker-compose.yml up -d postgres redis

# 상태 확인
docker compose -f infrastructure/docker/docker-compose.yml ps

# 스키마 초기화 확인
docker exec docker-postgres-1 psql -U kyobo -d kyobo_internal -c "\dt"
```

정상이면 아래 5개 테이블이 출력됩니다:

```
 audit_log · mint_requests · outbox_events · processed_events · user_nft_holdings
```

### 10-4. 접속 정보

| 서비스 | 호스트 | 포트 |
|---|---|---|
| PostgreSQL | localhost | 5433 |
| Redis | localhost | 6380 |
| Hardhat RPC | localhost | 8545 |

### 10-5. 종료

```powershell
# 컨테이너만 종료 (데이터 유지)
docker compose -f infrastructure/docker/docker-compose.yml down

# 컨테이너 + 볼륨 삭제 (DB 초기화)
docker compose -f infrastructure/docker/docker-compose.yml down -v
```

---

### Docker 트러블슈팅

#### `docker: command not found`

Rancher Desktop 설치 후 터미널을 새로 열지 않으면 PATH가 반영되지 않습니다. 터미널을 닫고 새로 여세요.

#### `open //./pipe/docker_engine: The system cannot find the file specified`

Docker daemon이 아직 시작되지 않은 상태입니다.

- Rancher Desktop 하단 상태가 `Running`인지 확인
- Preferences → Container Engine → **`dockerd (moby)`** 로 변경되어 있는지 확인

#### `Error: UNKNOWN: unknown error, open '\\wsl$\rancher-desktop-data\etc\hosts'`

Rancher Desktop 시작 시 WSL2 배포판이 깨진 경우입니다. PowerShell 관리자 권한으로 초기화:

```powershell
wsl --unregister rancher-desktop-data
wsl --unregister rancher-desktop
```

이후 Rancher Desktop을 다시 실행하면 WSL 배포판을 새로 생성합니다.

#### `POSTGRES_PASSWORD` 변수가 빈값 — 컨테이너가 즉시 종료됨

`infrastructure/docker/.env` 파일이 없거나 `POSTGRES_PASSWORD`가 비어있는 경우입니다.
[10-2. 환경 변수 설정](#10-2-환경-변수-설정)을 따라 `.env` 파일을 생성하세요.

> **주의:** 프로젝트 루트의 `.env`는 `-f`로 compose 파일 경로를 지정할 경우 자동으로 읽히지 않습니다. `infrastructure/docker/.env`에 별도로 생성해야 합니다.

#### 테이블이 생성되지 않음 — `Did not find any relations`

`initdb.d` 스크립트는 볼륨이 처음 생성될 때만 실행됩니다. 이전에 빈 상태로 컨테이너가 뜬 적이 있으면 볼륨을 삭제하고 재시작해야 합니다:

```powershell
docker compose -f infrastructure/docker/docker-compose.yml down -v
docker compose -f infrastructure/docker/docker-compose.yml up -d postgres redis
```

#### `write .../meta.db: input/output error`

Docker 내부 스토리지 손상 — Rancher Desktop을 완전히 종료(트레이 우클릭 → Quit) 후 재시작하세요.
