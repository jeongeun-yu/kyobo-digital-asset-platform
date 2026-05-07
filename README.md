# KYOBO Digital Assets System

교보생명 행동 보상 NFT · KRW 스테이블코인 · 증권형 토큰(STO) 발행 플랫폼 — 강의 실습 레포지토리.

> **실습 환경**: Windows 10/11 · PowerShell · Node.js 20 · Docker 없음

> **TypeScript 사전 준비**: 본 프로젝트에서 사용하는 최소한의 TypeScript 문법 정리 → [kyobo-ts-prep](https://github.com/coincraft12/kyobo-ts-prep)

---

## 목차

1. [전제 조건](#1-전제-조건)
2. [클론 및 초기 설정](#2-클론-및-초기-설정)
3. [의존성 설치 및 전체 빌드](#3-의존성-설치-및-전체-빌드)
4. [테스트](#4-테스트)
5. [실습 진행 방법](#5-실습-진행-방법)
6. [스마트컨트랙트 컴파일](#6-스마트컨트랙트-컴파일)
7. [프로젝트 구조](#7-프로젝트-구조)
8. [강의 노트](#8-강의-노트)
9. [트러블슈팅](#9-트러블슈팅)

---

## 1. 전제 조건

### 1-1. 설치 확인

PowerShell에서 아래 명령 실행 — 세 줄 모두 버전 번호가 출력되면 [2. 클론 및 초기 설정](#2-클론-및-초기-설정)으로 이동.

```powershell
node -v        # v20.x.x 이상
npm -v         # 10.x.x 이상
git --version  # git version 2.x.x
```

---

### 1-2. Node.js 설치

1. [https://nodejs.org](https://nodejs.org) 접속
2. **LTS** 버튼 클릭 → `.msi` 설치 파일 다운로드
3. 설치 마법사 실행 — 모든 옵션 기본값으로 Next → Finish
4. PowerShell **닫고 새로 열기** (환경변수 반영)
5. 설치 확인:

```powershell
node -v   # v20.x.x
npm -v    # 10.x.x
```

> npm은 Node.js 설치 시 함께 포함. 별도 설치 불필요.

---

### 1-3. Git 설치

1. [https://git-scm.com/download/win](https://git-scm.com/download/win) 접속 → 자동 다운로드 시작
2. 설치 마법사 실행 — 아래 두 항목 확인, 나머지는 기본값 유지:
   - **Adjusting your PATH environment** → `Git from the command line and also from 3rd-party software` 선택
   - **Configuring the line ending conversions** → `Checkout Windows-style, commit Unix-style line endings` 선택
3. PowerShell **닫고 새로 열기**
4. 설치 확인:

```powershell
git --version   # git version 2.x.x.windows.x
```

**최초 1회 — 사용자 정보 등록**

```powershell
git config --global user.name "홍길동"
git config --global user.email "hong@example.com"
```

---

### 1-4. VS Code 설치 (선택 — 강의 중 사용)

1. [https://code.visualstudio.com](https://code.visualstudio.com) 접속 → Download for Windows
2. 설치 완료 후 권장 확장 일괄 설치:

```powershell
code --install-extension dbaeumer.vscode-eslint
code --install-extension esbenp.prettier-vscode
code --install-extension juanblanco.solidity
```

---

### 최종 확인

```powershell
node -v; npm -v; git --version
```

세 줄 모두 버전 번호 출력 → 준비 완료.

---

## 2. 클론 및 초기 설정

```powershell
# 레포지토리 클론
git clone <레포지토리-URL>
cd kyobo-digital-asset-platform

# 환경 변수 파일 복사
Copy-Item .env.example .env
```

`.env`는 강사 안내에 따라 필요한 항목만 입력.  
M2 실습은 Mock 환경 사용 — `.env` 없이도 동작.

---

## 3. 의존성 설치 및 전체 빌드

```powershell
# 전체 npm 워크스페이스 의존성 설치 (루트에서 1회만)
npm install

# TypeScript 빌드 + Solidity 컴파일 (전체)
npm run build:all
```

`build:all` 내부 동작:
1. 각 패키지의 `npm run build` 실행 (`--if-present` — 빌드 스크립트 없는 패키지 스킵)
2. `blockchain/` Solidity 컴파일 (`npx hardhat compile`)

빌드 결과:
- TypeScript → `dist/` (패키지별)
- Solidity → `blockchain/artifacts/` · `blockchain/typechain-types/`

---

## 4. 테스트

> **모든 테스트 명령은 프로젝트 루트(`kyobo-digital-asset-platform/`)에서 실행.**

테스트는 두 종류로 구분된다.

| 종류 | 위치 | 명령 | 목적 |
|---|---|---|---|
| **소스 단위 테스트** | `dmz/packages/*/src/__tests__/` | `npm test` | 스켈레톤 코드 동작 검증 |
| **실습 채점 테스트** | `course/exercises/__tests__/` | `npm run test:exercises` | 실습 파일 채점 |

---

### 4-1. 소스 단위 테스트

스켈레톤 패키지 6개 각각의 동작을 검증하는 단위 테스트.  
실습과 무관하게 처음부터 전부 통과 상태.

#### 전체 실행

```powershell
npm test
```

#### 패키지별 개별 실행

```powershell
npm test --workspace=dmz/packages/chain-adapters
npm test --workspace=dmz/packages/compliance
npm test --workspace=dmz/packages/core-banking
npm test --workspace=dmz/packages/shared
npm test --workspace=dmz/packages/vasp
npm test --workspace=dmz/packages/event-engine
```

#### 패키지별 테스트 현황

| 패키지 | 테스트 파일 | TC 수 | 주요 커버리지 |
|---|---|---|---|
| `chain-adapters` | 4개 | 46 | EVMAdapter · RetryDecorator · LoggingDecorator · ChainAdapterFactory |
| `compliance` | 4개 | 54 | LockupPolicy · InvestorRegistry · PermissiveCompliance · ISMSChecklist |
| `core-banking` | 4개 | 49 | LedgerService · CircuitBreaker · ReconcileService · AuditLogService |
| `shared` | 2개 | 24 | AppError · 도메인 타입 |
| `vasp` | 5개 | 86 | TxStateMachine · KeyGovernance · VaspRecovery · TxAttempt · Whitelist |
| `event-engine` | 5개 | 49 | WebhookServer · RedisStream · ConsumerGroup · DLQ · E2E |
| **합계** | **24개** | **308** | |

#### 특정 테스트 파일만 실행

```powershell
# RetryAdapterDecorator 테스트만
npm test --workspace=dmz/packages/chain-adapters -- --testPathPattern RetryAdapterDecorator

# TxStateMachineService 테스트만
npm test --workspace=dmz/packages/vasp -- --testPathPattern TxStateMachine

# CircuitBreaker 테스트만
npm test --workspace=dmz/packages/core-banking -- --testPathPattern CircuitBreaker
```

---

### 4-2. 실습 채점 테스트

`course/exercises/` 실습 파일을 채점하는 테스트.  
**처음에는 전부 실패** — 실습 파일의 TODO를 완성하면 통과된다.

#### 전체 채점

```powershell
npm run test:exercises
```

#### 특정 세션만 채점

```powershell
npm run test:exercises -- S05
npm run test:exercises -- S07
npm run test:exercises -- S11
npm run test:exercises -- S13
npm run test:exercises -- S14
npm run test:exercises -- S15
npm run test:exercises -- S16
npm run test:exercises -- S17
npm run test:exercises -- S22
```

#### 실습 채점 테스트 현황

| 세션 | 테스트 파일 | TC 수 | 검증 항목 |
|---|---|---|---|
| S05 | `S05_make_sig.test.ts` | 6 | HMAC-SHA256 서명 생성 |
| S07 | `S07_redis_stream.test.ts` | 5 | Redis Streams 발행·소비 |
| S11 | `S11_dlq.test.ts` | 5 | Dead Letter Queue 이동 |
| S12 | `S12_e2e.test.ts` | 5 | 이벤트 파이프라인 E2E |
| S13 | `S13_tx_statemachine.test.ts` | 28 | TX 상태 전이 전체 흐름 |
| S14 | `S14_multichain_adapter.test.ts` | 21 | IBlockchainAdapter Strategy 패턴 |
| S15 | `S15_evm_lab.test.ts` | 14 | EVMAdapter mintNFT() 구현 |
| S16 | `S16_idempotency.test.ts` | 11 | requestId 멱등성 처리 |
| S17 | `S17_decorator_patterns.test.ts` | 21 | Retry · Logging 데코레이터 패턴 |
| S22 | `S22_pollstale_lab.test.ts` | 13 | Stale TX 폴링 복구 |
| **합계** | **10개** | **129** | |

#### 채점 결과 예시

```
PASS  course/exercises/__tests__/S13_tx_statemachine.test.ts
  TxStateMachine 실습
    ✓ REQUESTED → SUBMITTED 전이 (3ms)
    ✓ SUBMITTED → MINED 전이 (1ms)
    ✓ MINED → FINALIZED → CONFIRMED 순차 전이 (2ms)
    ...
Tests: 28 passed, 28 total
```

---

### 4-3. 전체 일괄 실행

소스 단위 테스트 + 실습 채점 테스트 동시 실행:

```powershell
npm test && npm run test:exercises
```

---

## 5. 실습 진행 방법

### 실습 파일 위치

```
course/exercises/
├── M2/          웹훅 · Redis Streams · 멱등성 · DLQ (S05~S12)
├── M3/          TX 상태머신 · 멀티체인 · EVM (S13~S22)
└── __tests__/   실습 채점 테스트
```

### 파일 명명 규칙

| 파일 | 역할 |
|---|---|
| `S##_이름.ts` | 실습 파일 — **코드 작성 위치** |
| `S##_이름.answer.ts` | 정답 파일 — 막힐 때만 참고 |

### 실습 실행

실습 파일은 `dmz/packages/event-engine` 폴더에서 실행.  
`import`가 `@kyobo/event-engine` 패키지를 참조하므로 **해당 폴더 외에서는 동작하지 않음.**

```powershell
cd dmz\packages\event-engine

# S06 HMAC 서명 검증 실습
npx ts-node ..\..\..\..\course\exercises\M2\S06_hmac_webhook.ts

# S09 At-least-once 실습
npx ts-node ..\..\..\..\course\exercises\M2\S09_atleastonce.ts
```

### 실습 → 채점 사이클

```powershell
# 1. 실습 파일 열기
code course\exercises\M2\S09_atleastonce.ts

# 2. TODO 블록 구현

# 3. 특정 세션만 채점
cd dmz\packages\event-engine
npx jest --config jest.exercises.config.json --testPathPattern S09

# 4. 전체 채점
npm run test:exercises
```

### 모듈별 실습 순서

#### M2 — 이벤트 파이프라인

| 세션 | 파일 | 주제 | 채점 테스트 |
|---|---|---|---|
| S05 | `M2/S05_webhook.ts` | WebhookServer 기동 | — |
| S05 | `M2/S05_make_sig.ts` | HMAC 서명 생성 | — |
| S06 | `M2/S06_hmac_webhook.ts` | HMAC 검증 구현 | `S06_hmac_webhook.test.ts` |
| S07 | `M2/S07_redis_stream.ts` | Redis Streams 전체 흐름 | — |
| S09 | `M2/S09_atleastonce.ts` | At-least-once + 멱등성 | `atleastonce.test.ts` |
| S10 | `M2/S10_handle_with_retry.ts` | 재시도 핸들러 구현 | `handle_with_retry.test.ts` |
| S11 | `M2/S11_dlq.ts` | DLQ 이동 + 운영 절차 | — |
| S12 | `M2/S12_e2e.ts` | 전체 파이프라인 E2E | — |

#### M3 — TX 상태머신 · 멀티체인

| 세션 | 파일 | 주제 |
|---|---|---|
| S13 | `M3/S13_tx_statemachine.ts` | TxStatus 전이 구현 |
| S14 | `M3/S14_multichain_adapter.ts` | IBlockchainAdapter Strategy 패턴 |
| S15 | `M3/S15_evm_lab.ts` | EVMAdapter mintNFT() 구현 |
| S16 | `M3/S16_idempotency.ts` | requestId 기반 Idempotency |
| S22 | `M3/S22_pollstale_lab.ts` | Stale TX 복구 |

참고 구현체: `dmz/packages/event-engine/src/` · `dmz/packages/vasp/src/`

---

## 6. 스마트컨트랙트 컴파일

```powershell
# 컴파일 (artifacts + typechain-types 생성)
cd blockchain
npx hardhat compile

# 로컬 Hardhat 노드 실행
npx hardhat node

# 별도 PowerShell 탭 — 행동 보상 NFT 배포
npx hardhat run scripts\deploy\deploy-rewards.ts --network localhost

# STO 증권형 토큰 배포
npx hardhat run scripts\deploy\deploy-securities.ts --network localhost
```

루트 단축 명령:

```powershell
npm run node:local       # 로컬 노드 시작
npm run deploy:local     # 행동 보상 NFT 배포
npm run deploy:securities  # STO 배포
```

---

## 7. 프로젝트 구조

```
kyobo-digital-asset-platform/
│
├── blockchain/                  Solidity 스마트컨트랙트 (Hardhat)
│   └── src/
│       ├── rewards/             행동 보상 NFT (KyoboNFT)
│       ├── stablecoin/          KRW 스테이블코인
│       ├── securities/          증권형 토큰 STO
│       ├── base/                BaseToken 공통 베이스
│       ├── compliance/          PermissiveCompliance · InvestorCompliance
│       ├── interfaces/          IToken · ICompliance · ISecurityToken 등
│       └── mocks/               테스트용 Mock 컨트랙트
│
├── dmz/                         Node.js 서비스 (ISMS-P DMZ 구간)
│   ├── apps/
│   │   └── issuer-service/      NFT 발행 서비스 진입점
│   └── packages/
│       ├── @kyobo/chain-adapters   IBlockchainAdapter (EVM / Circle / XRPL / UTXO)
│       ├── @kyobo/vasp             TX 상태머신 · NonceManager · 키 거버넌스
│       ├── @kyobo/core-banking     코어뱅킹 연동 · 원장 · 감사 로그
│       ├── @kyobo/event-engine     Redis Streams · 웹훅 · DLQ · 이벤트 처리
│       ├── @kyobo/compliance       KYC · AML · ISMS-P
│       └── @kyobo/shared           공통 도메인 타입 · AppError · 설정
│
├── internal/
│   └── blockchain-gateway/      Java Spring Boot — 영구 원장 · CoreBanking 브릿지
│
├── infrastructure/
│   ├── docker/                  docker-compose (PostgreSQL + Redis)
│   ├── dmz/nginx/               DMZ Nginx 설정
│   └── monitoring/prometheus/   모니터링
│
├── tools/
│   └── event-listener/          온체인 이벤트 리스너 (개발 도구)
│
├── course/                      ── 강의 자료 ──
│   ├── exercises/               실습 파일 (M2 · M3 · M5)
│   │   ├── M2/                  S05~S12 실습 + answer
│   │   ├── M3/                  S13~S22 실습 + answer
│   │   └── __tests__/           실습 채점 테스트 (Jest)
│   ├── lecture-notes/           모듈별 강의 노트 (Markdown)
│   └── curriculum/              커리큘럼 문서 (day01~day13)
│
└── docs/
    ├── adr/                     Architecture Decision Records (ADR 001~007)
    ├── architecture/            아키텍처 다이어그램 · 기술 스택
    └── operational/             운영 런북
```

---

## 8. 강의 노트

위치: `course/lecture-notes/`

| 파일 | 내용 |
|---|---|
| `precourse-prep-guide_1.md` | 사전 준비 가이드 |
| `typescript-warmup-handout.md` | TypeScript 워밍업 핸드아웃 |
| `M1_architecture_setup.md` | 전체 아키텍처 · 개발 환경 구성 |
| `M2_S5_webhook_202_pattern.md` | WebhookServer · 202 비동기 패턴 |
| `M2_S6_hmac_queue_service.md` | HMAC-SHA256 서명 검증 |
| `M2_S7_redis_streams_theory.md` | Redis Streams 이론 · XADD/XREAD |
| `M2_S8_redis_streams_cli.md` | Redis CLI 직접 조작 |
| `M2_S9_atleastonce_design.md` | At-least-once · 멱등성 설계 |
| `M2_S10_event_consumer_impl.md` | ConsumerGroupWorker 구현 |
| `M2_S11_dlq_design.md` | Dead Letter Queue 설계 |
| `M2_S12_finalized_e2e.md` | M2 전체 파이프라인 E2E |
| `M2_S51_dlq_ops.md` | DLQ 운영 절차 |
| `M2_S52_consumer_runbook.md` | Consumer 운영 런북 |
| `M3_S13_tx_statemachine.md` | TX 상태머신 설계 |
| `M3_S14_multichain_adapter.md` | 멀티체인 어댑터 패턴 |
| `M3_S15_evm_implementation.md` | EVM 트랜잭션 직접 구현 |
| `M3_S16_idempotency.md` | Idempotency 심화 |
| `M3_S17_retry_backoff.md` | 재시도 · 지수 백오프 |
| `M3_S18_tx_revert.md` | TX 리버트 처리 |
| `M3_S19_timeout_reorg.md` | 타임아웃 · 체인 재편성 |
| `M3_S20_timeout_reorg_handler.md` | 타임아웃 · 재편성 핸들러 구현 |
| `M3_S21_dual_channel.md` | 듀얼 채널 설계 |
| `M3_S22_pollstale_integration.md` | Stale TX 통합 복구 |
| `M3_S53_vasp_sla_ops.md` | VASP SLA 운영 |
| `M4_S23_ledger_data_model.md` | 원장 데이터 모델 |
| `M4_S24_state_transition_guard.md` | 상태 전이 가드 |
| `M4_S25_reconcile_service.md` | 정산 서비스 |
| `M4_S26_audit_log_sha256.md` | 감사 로그 SHA-256 |
| `M4_S54_reconcile_ops.md` | 정산 운영 절차 |
| `M4_S55_auditlog_retention_ops.md` | 감사 로그 보존 운영 |
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
| `M6_S37_access_control_roles.md` | 접근 제어 역할 설계 |
| `M6_S38_lifecycle_burn_pause_upgrade.md` | 라이프사이클 · Burn · Pause · 업그레이드 |
| `M6_S39_deployment_etherscan.md` | 배포 · Etherscan 검증 |
| `M6_S40_storage_layout_upgrade.md` | 스토리지 레이아웃 업그레이드 |
| `M6_S56_deploy_rollback_ops.md` | 배포 롤백 운영 |
| `M7_S41_reentrancy_slither.md` | 재진입 공격 · Slither 분석 |
| `M7_S42_slither_fix.md` | Slither 지적 사항 수정 |
| `M7_S43_upgrade_operation.md` | 업그레이드 운영 |
| `M7_S44_security_review.md` | 보안 리뷰 |
| `M8_S45_admin_api.md` | 관리자 API |
| `M8_S46_gnosis_safe.md` | Gnosis Safe 멀티시그 |
| `M8_S47_eip712_safetx.md` | EIP-712 SafeTx 서명 |
| `M8_S48_multisig_impl.md` | 멀티시그 구현 |
| `M8_S49_travel_rule.md` | 트래블 룰 |
| `M8_S50_fault_injection.md` | 장애 주입 테스트 |
| `M8_S57_upgrade_governance_ops.md` | 업그레이드 거버넌스 운영 |
| `M8_S58_monitoring_dashboard_ops.md` | 모니터링 대시보드 운영 |
| `Phase3_S1_two_layer_tx_model.md` | 2레이어 TX 모델 |
| `Phase3_S2_broadcaster_outbox.md` | Broadcaster Outbox 패턴 |
| `Phase3_S3_custody_security.md` | Custody 보안 설계 |
| `Phase3_S4_eip1559_rpc_nonce.md` | EIP-1559 · RPC · Nonce 관리 |

---

## 9. 트러블슈팅

### `npm install` 실패

```powershell
npm cache clean --force
npm install
```

### `npx ts-node` 실행 시 "Cannot find module '@kyobo/event-engine'"

실습 파일은 `dmz/packages/event-engine` 폴더에서만 실행 가능.

```powershell
cd dmz\packages\event-engine
npx ts-node ..\..\..\..\course\exercises\M2\S09_atleastonce.ts
```

### `npx hardhat compile` 실패 — "Function mcopy not found"

`blockchain/hardhat.config.ts`에 `evmVersion: 'cancun'` 설정 필요. 이미 포함되어 있으므로 Node.js 버전 확인 — Node.js 20 LTS 사용 권장.

### PowerShell 스크립트 실행 정책 오류

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### `jest` 명령을 찾을 수 없음

루트 `npm install` 완료 후 `node_modules/.bin/jest` 생성됨. `npx jest` 또는 패키지 폴더에서 `npm test` 사용.
