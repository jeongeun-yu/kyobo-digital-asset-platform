# 교보생명 디지털 자산 플랫폼

교보생명 행동 보상 NFT · KRW 스테이블코인 · 증권형 토큰(STO) 발행 플랫폼.

> **이 레포지토리 구성**
> - `blockchain/` · `dmz/` · `internal/` · `infrastructure/` · `tools/` → **플랫폼 코드** (스켈레톤)
> - `course/` → **강의 자료** (실습 파일 · 강의 노트) — 강사 전용

---

## 디렉토리 구조

```
kyobo-digital-asset-platform/
│
├── blockchain/                  Solidity 스마트컨트랙트 (Hardhat)
│   └── src/
│       ├── rewards/             행동 보상 NFT (KyoboNFT, NFTIssuer, ActivityOracle)
│       ├── stablecoin/          KRW 스테이블코인 (placeholder)
│       ├── securities/          증권형 토큰 STO (placeholder)
│       ├── base/                BaseToken 공통 베이스
│       ├── compliance/          컴플라이언스 구현체
│       ├── interfaces/          IToken, ICompliance 등 인터페이스
│       └── mocks/               테스트용 Mock 컨트랙트
│
├── dmz/                         Node.js 서비스 (ISMS-P DMZ 구간)
│   ├── apps/
│   │   └── issuer-service/      NFT 발행 서비스 진입점
│   └── packages/
│       ├── chain-adapters/      IBlockchainAdapter (EVM / Circle / XRPL / UTXO)
│       ├── vasp/                VASP TX 상태머신 · 거버넌스
│       ├── core-banking/        코어뱅킹 연동 · 감사 로그 · 원장
│       ├── event-engine/        Redis Streams · 웹훅 · 이벤트 처리
│       ├── compliance/          KYC · AML · ISMS-P 체크리스트
│       └── shared/              공통 타입 · 에러 · 설정
│
├── internal/                    Java Spring Boot (교보생명 내부망)
│   └── blockchain-gateway/      영구 원장 · 감사 로그 · CoreBanking 브릿지
│
├── infrastructure/              인프라 설정
│   ├── docker/                  로컬 개발 환경 (PostgreSQL + Redis)
│   ├── dmz/nginx/               DMZ Nginx 설정
│   └── monitoring/prometheus/   모니터링
│
├── tools/
│   └── event-listener/          온체인 이벤트 리스너 (개발·디버깅 도구)
│
├── course/                      ── 강의 자료 (플랫폼 코드와 분리) ──
│   ├── exercises/               실습 파일 (M2 · M3 · M4 · M5)
│   │   ├── M2/                  웹훅 · Redis Streams · At-least-once (S05~S12)
│   │   ├── M3/                  TX 상태머신 · 멀티체인 · EVM (S13~S16)
│   │   ├── M4/                  Stale 폴링 (S22)
│   │   └── M5/                  배포 실습 유틸
│   ├── lecture-notes/           모듈별 강의 노트 (M1~M10)
│   ├── curriculum/              커리큘럼 문서
│   └── research/                리서치 자료
│
└── docs/                        시스템 문서
    ├── adr/                     Architecture Decision Records
    ├── architecture/            아키텍처 다이어그램 · 기술 스택
    └── operational/             운영 런북
```

---

## 패키지 구조 (@kyobo/*)

| 패키지 | 역할 |
|---|---|
| `@kyobo/chain-adapters` | IBlockchainAdapter — EVM / Circle CCTP / XRPL / UTXO |
| `@kyobo/vasp` | TX 상태머신 · NonceManager · 키 거버넌스 · 복구 |
| `@kyobo/core-banking` | 코어뱅킹 어댑터 · 원장 · 감사 로그 · 정산 |
| `@kyobo/event-engine` | Redis Streams Consumer · 웹훅 서버 · DLQ · 이벤트 핸들러 |
| `@kyobo/compliance` | IKYCProvider · AML · ISMS-P 체크리스트 |
| `@kyobo/shared` | 공통 도메인 타입 · AppError · 설정 |

---

## 시작하기

```bash
# 의존성 설치 (전체 워크스페이스)
npm install

# 로컬 Hardhat 노드 시작
npm run node:local

# 스마트컨트랙트 배포 (행동 보상 NFT)
npm run deploy:local

# 로컬 Docker 환경 시작 (PostgreSQL + Redis)
docker-compose -f infrastructure/docker/docker-compose.yml up -d

# issuer-service 시작
cd dmz/apps/issuer-service && npx ts-node src/index.ts

# ISMS 체크리스트 실행
npm run isms:check
```

---

## 기술 스택

| 레이어 | 기술 |
|---|---|
| 스마트컨트랙트 | Solidity 0.8.24 · Hardhat · OpenZeppelin v5 |
| DMZ 서비스 | Node.js · TypeScript · Redis Streams |
| 내부망 서비스 | Java 17 · Spring Boot 3.2 · PostgreSQL |
| 인프라 | Docker · Nginx · Prometheus |
