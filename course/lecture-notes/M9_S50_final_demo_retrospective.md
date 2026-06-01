# M9 S50 — Sepolia 최종 배포 + 데모 발표 + Phase 1 전체 회고

> 모듈 9 · 세션 50 · 전체 과정 마지막 세션  
> 실습 20분 + 발표 40분  
> 대상: 교보생명 디지털 자산 플랫폼 개발팀

---

## 목차

1. [강사 배경] Phase 1 전체 아키텍처 회고
2. [강사 배경] 운영 투입 체크리스트 (실무 관점 전체)
3. [강사 배경] Phase 2 방향 — 기술 깊이 있는 배경지식
4. [강사 배경] 이 과정에서 배운 핵심 교훈 10가지
5. [강사 배경] 블록체인 개발자 커리어 패스
6. [강의/진행] 분 단위 진행 계획 (60분)
7. [강의/진행] 실습 — 미니프로젝트 Sepolia 최종 배포
8. [강의/진행] 최종 데모 발표 가이드
9. [강의/진행] Phase 1 전체 회고 강의
10. [강의/진행] Phase 2 방향 소개
11. [강의/진행] 최종 완성 조건 체크리스트

---

# [강사 배경] Phase 1 전체 아키텍처 회고

## 전체 시스템 흐름 — 텍스트 다이어그램

M1부터 M9까지 구현한 모든 컴포넌트가 실제로 어떻게 연결되는지 한 눈에 파악해야 한다. 이 다이어그램을 강사가 완전히 내재화하고 있어야 학생 질문에 막힘 없이 답할 수 있다.

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          Phase 1 전체 시스템 — 교보생명 디지털 자산 플랫폼              │
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │                              EXTERNAL (외부망)                               │   │
│  │                                                                              │   │
│  │   [교보 앱 / 코어뱅킹]                                                        │   │
│  │       │ HTTP POST /events (걷기달성, 건강검진, 만기완료...)                    │   │
│  │       │ Webhook 발행 (202 Accepted 패턴)                                     │   │
│  │       ▼                                                                      │   │
│  │   [DMZ — Nginx 리버스 프록시]                                                 │   │
│  │       │ HMAC-SHA256 서명 검증 → 통과 시 내부망 전달                           │   │
│  └───────┼──────────────────────────────────────────────────────────────────────┘   │
│          │                                                                          │
│  ┌───────┼──────────────────────────────────────────────────────────────────────┐   │
│  │       │                        INTERNAL (내부망)                             │   │
│  │       ▼                                                                      │   │
│  │   [EventEngine — QueueService]   ←── M2 핵심 (Redis Streams)                 │   │
│  │       │ Consumer Group: event-consumer-group                                 │   │
│  │       │ At-Least-Once 보장 + XACK                                            │   │
│  │       │ DLQ: 3회 실패 시 dead-letter-queue 이동                              │   │
│  │       ▼                                                                      │   │
│  │   [EventConditionService]        ←── M5: 조건 판단 전략 패턴                  │   │
│  │       │ IConditionStrategy 구현체 선택 (걷기/건강검진/만기)                    │   │
│  │       │ KYC 레벨 검증 + 중복 발행 방지 (Idempotency Key)                     │   │
│  │       ▼                                                                      │   │
│  │   [IssuerService]                ←── M5: 발행 서비스 (단건/벌크)              │   │
│  │       │ 단건: issueNFT(userId, tokenId, amount)                              │   │
│  │       │ 벌크: bulkIssue(recipients[]) — BatchProcessor 큐 방식               │   │
│  │       ▼                                                                      │   │
│  │   [TxStateMachineService]        ←── M3: TX 상태머신                         │   │
│  │       │ PENDING → SUBMITTED → MINED → CONFIRMED → FINALIZED                 │   │
│  │       │ REVERT / TIMEOUT / REORG 복구 경로                                   │   │
│  │       ▼                                                                      │   │
│  │   [IBlockchainAdapter]           ←── M3: 멀티체인 어댑터 인터페이스            │   │
│  │       │ EvmAdapter (현재) / XrplAdapter (Phase 2)                            │   │
│  │       │ submitTx() → txHash 반환                                             │   │
│  │       │ pollStatus(txHash) → TX 상태 조회                                    │   │
│  │       ▼                                                                      │   │
│  │   [VASP API — 월렛원]            ←── Phase 1: 외부 VASP 위탁                  │   │
│  │       │ NFT mint TX 서명 + 브로드캐스트                                       │   │
│  │       │ Travel Rule 이행 (특금법 §8의4)                                       │   │
│  │       │ TravelRuleData 포함 발행 요청                                         │   │
│  │       ▼                                                                      │   │
│  │   [Ethereum Sepolia / Mainnet]   ←── M6~M7: 스마트컨트랙트                   │   │
│  │       │ KyoboNFT (ERC-1155, UUPS Proxy)                                     │   │
│  │       │ NFTIssuer (MINTER_ROLE 보유)                                         │   │
│  │       │ ActivityOracle (서명 검증)                                            │   │
│  │       │ PermissiveCompliance (Phase 1 컴플라이언스)                          │   │
│  │       │                                                                      │   │
│  │   [내부 원장 + 감사 로그]         ←── M4: 신뢰 기록                            │   │
│  │       │ PgNFTLedgerService — PostgreSQL 원장                                 │   │
│  │       │ AuditLogService — SHA-256 체인 해시                                  │   │
│  │       │ ReconcileService — 온체인 vs 오프체인 잔액 검증                        │   │
│  │       │                                                                      │   │
│  │   [거버넌스 레이어]               ←── M9: Gnosis Safe + Travel Rule           │   │
│  │       │ Gnosis Safe 2-of-3 멀티시그                                          │   │
│  │       │ EIP-712 구조화 서명                                                  │   │
│  │       │ UPGRADER_ROLE: 멀티시그 필수                                          │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │                        보안 레이어 (전체 적용)   ←── M8                      │    │
│  │   Slither 정적 분석 + Reentrancy Guard + 감사 리포트 + 권한 분리              │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## 각 모듈이 해결한 핵심 문제

| 모듈 | 해결한 핵심 문제 |
|------|----------------|
| **M1** | "어디서 시작하는가" — EVM 아키텍처 프리뷰 + Hardhat/TypeScript 개발환경 구축 |
| **M2** | "외부 이벤트를 잃지 않고 받는 방법" — 202 패턴 + Redis Streams + Consumer Group + DLQ |
| **M3** | "블록체인 TX가 실패해도 시스템이 안전한가" — Idempotency + REVERT/TIMEOUT/REORG 3종 복구 |
| **M4** | "발행 기록을 신뢰할 수 있는가" — PostgreSQL 원장 + SHA-256 감사 해시 체인 |
| **M5** | "비즈니스 규칙을 코드로 어떻게 표현하는가" — 지갑 매핑 + 조건 판단 전략 + 벌크 발행 |
| **M6** | "스마트컨트랙트를 어떻게 설계하는가" — ERC-20/721/1155 표준 + OZ + UUPS 패턴 |
| **M7** | "KyoboNFT를 실제 테스트넷에 올리는 방법" — ERC-1155 구현 + Sepolia 배포 + Etherscan 검증 |
| **M8** | "컨트랙트가 공격에 안전한가" — Reentrancy 방어 + Slither 정적 분석 + 감사 리포트 |
| **M9** | "누가 업그레이드를 승인하는가" — Gnosis Safe 멀티시그 + Travel Rule 컴플라이언스 |

---

# [강사 배경] 운영 투입 체크리스트 (실무 관점)

Phase 1 시스템을 실제 교보생명 운영 환경에 투입하기 전 점검해야 할 항목들이다. 이 체크리스트는 강사가 직접 경험한 금융 시스템 운영 기준으로 작성되었으며, 학생들에게 "우리가 만든 코드가 운영 레디인지 판단하는 기준"으로 제시할 수 있다.

### 보안 (Security)

```
[ ] 1. 스마트컨트랙트 외부 감사 완료
       - Trail of Bits, Certik, Hacken 등 공인 감사 업체
       - Critical/High 취약점 전부 수정 후 재감사
       - 감사 리포트 금융당국 제출 가능 상태

[ ] 2. 개인키 관리 체계
       - DEPLOYER_PRIVATE_KEY: 배포 전용 EOA, 운영 후 즉시 폐기 또는 오프라인 보관
       - MINTER_ROLE 키: AWS KMS 또는 HashiCorp Vault — 서버 메모리에 평문 없음
       - UPGRADER_ROLE: Gnosis Safe 2-of-3 필수 (단일 HOT KEY 보유 절대 금지)
       - 키 로테이션 주기: 6개월 (금융보안원 권고)

[ ] 3. .env 파일 관리
       - .gitignore 확인 — private key가 git 이력에 없는지 전체 커밋 스캔
       - git log --all -S "PRIVATE_KEY" -- 로 이력 검색
       - 운영 환경: AWS Secrets Manager / Vault — .env 파일 없음

[ ] 4. Slither 정적 분석 결과
       - slither . --exclude-dependencies 실행
       - High/Medium 전부 수정 또는 false positive 문서화
       - CI/CD 파이프라인에 Slither 포함

[ ] 5. Reentrancy 방어
       - ReentrancyGuard 상속 또는 CEI 패턴 준수
       - 외부 컨트랙트 호출 전 상태 변경 완료 (Checks-Effects-Interactions)
       - 감사 리포트에 reentrancy 분석 항목 명시

[ ] 6. 접근 제어 검증
       - MINTER_ROLE: NFTIssuer 컨트랙트만 보유 (서버 계정 직접 보유 금지)
       - PAUSER_ROLE: 비상 대응 담당자만
       - UPGRADER_ROLE: Gnosis Safe 주소만 (EOA 단독 보유 불가)
       - DEFAULT_ADMIN_ROLE: 배포 직후 다중 서명 주소로 이전
```

### 거버넌스 (Governance)

```
[ ] 7. Gnosis Safe 설정 확인
       - 네트워크: Mainnet (테스트넷 Safe와 혼용 금지)
       - Threshold: 2-of-3 이상
       - 서명자 3인의 하드웨어 지갑(Ledger/Trezor) 사용 권고
       - Safe 주소가 UPGRADER_ROLE 보유 확인

[ ] 8. 업그레이드 절차 문서화
       - ProposeTx (EIP-712 구조화 서명) → 서명자 2인 승인 → 실행 순서 문서
       - 업그레이드 전 Storage Layout 검증: npx hardhat check
       - 업그레이드 후 기능 검증 테스트 스크립트
       - 롤백 계획: 이전 구현체 주소 기록 + upgradeToAndCall 재실행 절차

[ ] 9. 권한 분리 (Separation of Duties)
       - 개발팀: 코드 작성 + 테스트 → 서명 권한 없음
       - IT 운영팀: 서명자 B — 운영 승인
       - 준법감시팀: 서명자 C — 컴플라이언스 확인
       - 외부 감사: 감사 결과 확인

[ ] 10. 비상 절차 (Emergency)
        - Pause 권한 보유자와 연락처 24/7 대기
        - 컨트랙트 일시정지 → VASP 연락 → 코어뱅킹 알림 순서 명문화
        - 재개 시 멀티시그 unpause TX 절차
```

### 모니터링 (Monitoring)

```
[ ] 11. 온체인 이벤트 모니터링
        - NFTMinted, Paused, RoleGranted, Upgraded 이벤트 실시간 알람
        - Etherscan 알림 설정 + 내부 이벤트 인덱서 (The Graph 또는 자체 구현)
        - 비정상 mint 대량 발행 감지: 분당 mint 건수 임계값 설정

[ ] 12. 오프체인 모니터링
        - Redis Streams 큐 깊이 (Consumer Lag) 알람: > 100건 이상 시 경고
        - DLQ 잔류 이벤트 실시간 알람 (0건 유지가 목표)
        - TxStateMachine PENDING 장기 체류: 5분 이상 → 경고
        - TIMEOUT/REORG 발생률 트래킹

[ ] 13. 원장 정합성 모니터링
        - ReconcileService 일일 실행: 온체인 balanceOf vs PostgreSQL 원장 비교
        - SHA-256 감사 해시 체인 무결성 검증
        - 불일치 발생 시 자동 알람 + 수동 조사 프로세스

[ ] 14. 인프라 모니터링
        - VASP API 응답 시간 + 오류율 (SLA: 99.9%, p99 < 3초)
        - Redis Streams 메모리 사용량
        - PostgreSQL 복제 지연 + 디스크 사용량
        - 배포 계정 Sepolia/Mainnet ETH 잔액 (gas 소진 방지)
```

### 장애 대응 (Incident Response)

```
[ ] 15. 런북 (Runbook) 준비
        - S51: DLQ 처리 런북 (M2에서 작성)
        - S52: Consumer 재시작 런북
        - S53: VASP SLA 위반 대응
        - S54: ReconcileService 불일치 대응
        - S55: 감사 로그 보관 절차
        - S57: 업그레이드 거버넌스 런북
        - S58: 모니터링 대시보드 운영

[ ] 16. 장애 시뮬레이션 완료 확인
        - VASP API 다운 → Retry + DLQ 동작 확인
        - Redis Streams 재시작 → Consumer Group 재연결 확인
        - Reorg 발생 → REORG 상태 전이 + 재제출 확인
        - Consumer 크래시 → XPENDING 재처리 확인

[ ] 17. 복구 시간 목표 (RTO/RPO)
        - RTO (Recovery Time Objective): 발행 기능 2시간 이내 복구
        - RPO (Recovery Point Objective): 마지막 성공 발행 이후 데이터 손실 없음
        - 정기 DR 훈련: 분기 1회
```

### 규제 준수 (Compliance)

```
[ ] 18. 특금법 Travel Rule 이행 확인
        - 100만원 이상 NFT 발행 시 TravelRuleData 생성·전달 로직 동작 확인
        - VASP(월렛원) 수신 확인 + 수신 VASP 검증 절차
        - KoFIU 보고 체계 구축

[ ] 19. AML/KYC 연동
        - 사용자 KYC 레벨 검증 (BASIC/ENHANCED/PREMIUM)
        - 고위험 사용자 차단 로직 동작 확인
        - 정기 KYC 재검증 주기 설정

[ ] 20. 데이터 보관 의무
        - 감사 로그 보관: 5년 이상 (특금법 §8의3)
        - 거래 이력 PostgreSQL 백업: 암호화 + 외부 저장소
        - 개인정보(수신인 정보) 보관 기간: PIPA 준수
```

---

# [강사 배경] Phase 2 방향 — 기술 깊이 있는 배경지식

## 스테이블코인 설계

### 1. KRW 스테이블코인 — 규제 환경

교보생명이 KRW 스테이블코인을 발행하려면 다음 규제 장벽을 먼저 넘어야 한다.

**특정금융정보법 (특금법)**
- 스테이블코인 발행은 가상자산 발행 행위 → VASP 신고 필수
- 교보생명은 현재 VASP가 아님 (월렛원에 위탁). 직접 발행 시 VASP 신고 필요
- 금융위원회 가이드라인(2023): 법정화폐 연동 스테이블코인은 전자금융거래법상 선불전자지급수단으로도 해석 가능 → 이중 규제 리스크

**전자금융거래법 (전자금융법)**
- 선불전자지급수단 발행업: 금융위원회 허가 필요
- 교보생명은 보험사 → 전자금융업 겸업 제한
- 금융위 혁신금융서비스 (핀테크 샌드박스): 특례 인정 신청 가능

**금융위 샌드박스 접근법**
- 혁신금융서비스 지정 신청: 테스트 기간(최대 4년) 동안 규제 특례 허용
- 실제 사례: 카카오뱅크, 토스, 두나무 모두 샌드박스 통해 서비스 출시
- 교보생명 KRW 스테이블코인 경로: 샌드박스 신청 → 제한적 서비스 → 정식 인가

### 2. 담보 모델 3종 비교

강사는 세 모델의 구조적 차이와 실패 사례를 명확히 이해해야 한다.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                         스테이블코인 담보 모델 비교                             │
├──────────────────┬────────────────────┬────────────────────┬──────────────────┤
│                  │  법정화폐 담보      │  암호화폐 담보      │  알고리즘        │
│                  │  (Fiat-backed)     │  (Crypto-backed)   │  (Algorithmic)   │
├──────────────────┼────────────────────┼────────────────────┼──────────────────┤
│ 대표 사례        │  USDC, USDT        │  DAI (MakerDAO)    │  UST (Terra)     │
│ 담보             │  은행 계좌 USD      │  ETH/WBTC 150%+   │  알고리즘 조절   │
│ 페그 안정성      │  높음              │  중간 (청산 리스크)│  매우 낮음       │
│ 중앙화           │  높음 (발행사)     │  낮음 (DAO)        │  낮음 (프로토콜) │
│ 규제 친화도      │  높음              │  중간              │  낮음            │
│ 교보 적합성      │  ◎ (최적)          │  △ (복잡)          │  ✗ (금지)        │
├──────────────────┼────────────────────┼────────────────────┼──────────────────┤
│ 실패/리스크      │  Circle 계좌 동결  │  담보 급락 → 청산  │  UST 2022년 붕괴 │
│                  │  (2023년 SVB 사태) │  → 부채담보 연쇄   │  → $40B 증발     │
└──────────────────┴────────────────────┴────────────────────┴──────────────────┘
```

**UST 붕괴 사례 심층 분석 (강사 배경지식)**

2022년 5월 LUNA/UST 생태계 붕괴는 알고리즘 스테이블코인의 근본적 취약성을 드러냈다.

구조:
- UST 1개 = LUNA 1달러어치 소각으로 발행
- UST 페그 이탈 시 → UST 소각 → LUNA 발행 (인플레이션)
- LUNA 가격 하락 → UST 신뢰 하락 → 더 많은 LUNA 필요 → 사망 나선 (Death Spiral)

교훈: 알고리즘 담보는 신뢰에 의존한다. 신뢰 상실 순간 수학적으로 복구 불가능하다.

**교보생명 KRW 스테이블코인 설계 권고**

```
법정화폐 담보 방식 (USDC 모델)
├── 원화 입금: 교보생명 수탁 계좌 → 입금 확인
├── 온체인 발행: ReconcileService 검증 후 KRWStablecoin.mint()
├── 담보 비율: 1:1 (1원 = 1 KKRW)
├── 감사: 분기 1회 외부 감사 (Proof of Reserves)
└── 상환: KRWStablecoin.burn() → Core Banking 출금
```

### 3. KRWStablecoin 컨트랙트 — Phase 1 코드와의 연결

`blockchain/src/stablecoin/KRWStablecoin.sol`은 이미 Phase 2 설계가 STUB으로 구현되어 있다.

핵심 설계 포인트:
- `decimals() = 0`: 1 토큰 = 1원. 소수점 없음 (원화 최소 단위)
- `TRAVEL_RULE_THRESHOLD = 1_000_000`: 100만원 이상 이체 시 TravelRuleData 필수
- `mint(to, amount, depositTxRef)`: `depositTxRef`가 Core Banking 입금 참조 → 이중 발행 방지 key
- `_checkCompliance()`: 이체 시 KYC 레벨 + Travel Rule 동시 검증

Phase 2에서 추가해야 할 것들:
```solidity
// 1. 이중 발행 방지 (depositTxRef → mint 매핑)
mapping(bytes32 => bool) private _processedDeposits;

// 2. 발행 한도 (일일 최대 발행량 제한)
uint256 public dailyMintLimit;
mapping(uint256 => uint256) private _dailyMinted; // day => amount

// 3. Proof of Reserves 오라클 연동
IReservesOracle public reservesOracle;
// 온체인 발행량이 오라클 보고 준비금 초과 시 mint 차단
```

---

## XRPL 멀티체인

### 1. XRPL의 특성과 EVM과의 차이

XRP Ledger(XRPL)는 2012년에 Ripple Labs가 출시한 독자적인 블록체인이다. EVM과 근본적으로 다른 설계를 가지고 있다.

**합의 메커니즘 차이**

```
EVM (Ethereum):
  PoS (Proof of Stake)
  → 검증자가 32 ETH 스테이킹
  → 블록 생성 ~12초
  → Finality: ~15분 (경제적 finality)

XRPL:
  RPCA (Ripple Protocol Consensus Algorithm)
  → UNL (Unique Node List) — 신뢰하는 검증자 목록
  → 라운드 기반 합의 (3~5초)
  → Finality: 즉각적 (수학적 finality)
  → 채굴 없음, 에너지 소비 극소
```

**수수료 구조**

```
EVM Sepolia: gas price × gas limit
  → 복잡한 컨트랙트 호출: $0.1~$50
  → 네트워크 혼잡 시 급등 (EIP-1559 완화)

XRPL:
  고정 기본 수수료: 0.00001 XRP (~$0.000006)
  → 실용적으로 무료에 가까움
  → 국경 간 결제에 최적
```

**토큰 표준 차이**

```
EVM: ERC-20 (스마트컨트랙트 코드)
XRPL: Trust Lines (네이티브 기능)
  → 스마트컨트랙트 없이 토큰 발행 가능
  → Issued Currencies: 발행자(Issuer) + 보유자(Holder) + Trust Line
  → NFT: XLS-20 표준 (2022년 도입)
```

**EVM 사이드체인 — XRPL EVM**

2023년 XRPL EVM Sidechain이 출시되었다. 이것은 EVM을 XRPL 위에 얹는 방식이다.

```
XRPL EVM Sidechain:
  → EVM 호환: Solidity 코드 그대로 사용 가능
  → XRPL과 브리지로 연결 (XRP ↔ EVM chain 이동)
  → 낮은 수수료 + EVM 도구 체인 (Hardhat, MetaMask)
  → Phase 2에서 검토 대상
```

### 2. IBlockchainAdapter 패턴 확장

M3에서 설계한 `IBlockchainAdapter`가 멀티체인 확장의 핵심이다.

```typescript
// M3에서 설계한 인터페이스 (blockchain/src/interfaces/IBlockchainAdapter.ts)
interface IBlockchainAdapter {
  submitTx(request: TxRequest): Promise<TxSubmitResult>;
  pollStatus(txHash: string): Promise<TxStatus>;
  estimateGas(request: TxRequest): Promise<bigint>;
  getBlockNumber(): Promise<number>;
}

// Phase 2: XRPL 네이티브 어댑터
class XrplAdapter implements IBlockchainAdapter {
  // XRPL의 Trust Line 기반 NFT 발행
  async submitTx(request: TxRequest): Promise<TxSubmitResult> {
    // NFT Mint Transaction (XLS-20)
    const tx = {
      TransactionType: 'NFTokenMint',
      Account: this.issuerAddress,
      URI: toHex(request.metadata.uri),  // 메타데이터 URI
      Flags: 8,  // tfTransferable
      TransferFee: 0,
      TokenTaxon: request.tokenId,
    };
    const prepared = await this.client.autofill(tx);
    const signed = this.wallet.sign(prepared);
    const result = await this.client.submitAndWait(signed.tx_blob);
    return { txHash: result.result.hash, ... };
  }

  // XRPL의 확정된 ledger 조회
  async pollStatus(txHash: string): Promise<TxStatus> {
    const tx = await this.client.request({
      command: 'tx',
      transaction: txHash,
      binary: false,
    });
    // XRPL은 ledger에 포함 즉시 finalized
    if (tx.result.validated) return TxStatus.FINALIZED;
    return TxStatus.PENDING;
  }
}
```

**멀티체인 라우팅 전략**

```typescript
// IssuerService에서 체인 선택 전략
class IssuerService {
  constructor(
    private readonly adapters: Map<ChainType, IBlockchainAdapter>
    // 'ethereum' → EvmAdapter(Sepolia/Mainnet)
    // 'xrpl'    → XrplAdapter
    // 'xrpl-evm' → EvmAdapter(XRPL EVM Sidechain)
  ) {}

  async issueNFT(request: IssueRequest): Promise<void> {
    // 정책에 따라 체인 선택
    const chain = this.selectChain(request);
    const adapter = this.adapters.get(chain);
    await adapter.submitTx(request);
  }

  private selectChain(request: IssueRequest): ChainType {
    // 예: 소액 쿠폰 → XRPL (수수료 최소화)
    //     대용량 STO → Ethereum (생태계 신뢰도)
    if (request.tokenValue < 10_000) return 'xrpl';
    return 'ethereum';
  }
}
```

### 3. 크로스체인 브리지 리스크

멀티체인 전략의 최대 리스크는 브리지다. 2021~2023년 사이 브리지 해킹 피해액: **$2.5B+**

주요 사례:
- Ronin Bridge (Axie Infinity): $620M 탈취 (2022년 3월)
- Wormhole: $320M (2022년 2월)
- Harmony Horizon: $100M (2022년 6월)

해킹 패턴:
```
1. 멀티시그 키 탈취 (Ronin: 9개 중 5개 탈취)
2. 스마트컨트랙트 검증 로직 우회
3. 오라클 조작 (가격 조작으로 브리지 속임)
```

교보생명 대응:
- Phase 2에서 브리지 사용 시 감사된 브리지만 (Chainlink CCIP, Wormhole v2 감사 완료)
- 브리지를 통한 자산 이동 한도 설정 (일일 최대 금액)
- 브리지 이상 징후 24/7 모니터링

---

## MPC 거버넌스 진화

### 1. Gnosis Safe에서 MPC로 — 왜 전환하는가

Gnosis Safe 2-of-3는 훌륭한 거버넌스 도구다. 그러나 기관 수탁(Custody) 규모에서는 한계가 있다.

**Gnosis Safe의 한계**

```
1. 온체인 TX가 필요
   → 모든 서명 수집 + 실행이 블록체인 TX
   → 가스 비용 + 블록 대기 시간
   → 대용량 실시간 발행에 부적합

2. 키 관리 복잡성
   → 서명자 A가 키 분실 시 → 3-of-3로 키 변경 필요
   → 키 변경 자체가 멀티시그 TX 필요

3. 프라이버시
   → 모든 서명 행위가 온체인에 기록
   → 서명자 주소 공개

4. 모바일/HSM 연동
   → Gnosis Safe는 EVM 컨트랙트 → EVM 서명(EOA) 필요
   → 기관용 HSM과 직접 연동 어려움
```

**MPC (Multi-Party Computation) — Threshold Signature**

MPC는 오프체인에서 키 조각(key share)을 분산 보관하고, 서명 시에만 일시적으로 조각을 합쳐 서명을 생성하는 기술이다. 실제 완전한 키는 어떤 단일 장소에도 존재하지 않는다.

```
Gnosis Safe 2-of-3 구조:
  서명자 A: 완전한 키 보관 (Private Key A)
  서명자 B: 완전한 키 보관 (Private Key B)
  서명자 C: 완전한 키 보관 (Private Key C)
  → A, B, C 모두 단독으로 서명 가능 (단 컨트랙트가 2개 요구)
  → 키 탈취 = 위험

MPC Threshold Signature (2-of-3):
  서명자 A: 키 조각 a (완전한 키 아님)
  서명자 B: 키 조각 b (완전한 키 아님)
  서명자 C: 키 조각 c (완전한 키 아님)
  → 조각 하나만으로는 어떤 서명도 생성 불가
  → 2개 조각이 수학적 연산(TSS 프로토콜)으로 서명 생성
  → 완전한 키는 어디에도 존재하지 않음
```

### 2. MPC 솔루션 비교

| 솔루션 | 방식 | 강점 | 약점 | 교보 적합성 |
|--------|------|------|------|------------|
| **Fireblocks** | MPC-CMP | 기관용 UI, 정책 엔진 | 높은 비용 | ◎ (Phase 3 권고) |
| **Curv** (PayPal 인수) | MPC | 강력한 API | 독립 서비스 종료 | △ |
| **ZenGo** | MPC | 소비자용 UX | 기관용 부적합 | ✗ |
| **Coinbase Prime** | MPC + Custody | 미국 규제 준수 | 국내 규제 미적용 | △ |
| **자체 구현 TSS** | ECDSA-TSS | 완전 통제 | 개발 비용 극대 | △ (장기) |

### 3. Fireblocks 아키텍처 (Phase 3 권고 경로)

교보생명이 Phase 3에서 자체 VASP 인가를 취득한다고 가정할 때 Fireblocks 도입 시나리오:

```
현재 (Phase 1):
  IssuerService → VASP API (월렛원) → 블록체인
  키: 월렛원이 보관

Phase 3 Fireblocks:
  IssuerService → Fireblocks API → 블록체인
  키: MPC 조각
    - 조각 1: Fireblocks 서버 (HSM)
    - 조각 2: 교보생명 서버 (co-signer)
    - 조각 3: 교보생명 오프라인 (recovery)

교보생명이 얻는 것:
  - 완전한 자산 주권 (키 조각 보유)
  - 정책 엔진: TX 금액 한도, 주소 화이트리스트, 다중 승인
  - 감사 추적: 모든 서명 행위 기록
  - SOC2 Type II 인증 인프라
```

**IBlockchainAdapter 코드 변경 최소화**

```typescript
// Phase 1 → Phase 3 전환 시 변경되는 부분
// EvmAdapter의 서명 로직만 교체, 나머지 상위 레이어 불변

// Phase 1 (VASP API 위탁):
class EvmAdapter implements IBlockchainAdapter {
  async submitTx(request: TxRequest) {
    const result = await this.vaspClient.mintNFT(request);
    return { txHash: result.txHash };
  }
}

// Phase 3 (Fireblocks MPC):
class FireblocksEvmAdapter implements IBlockchainAdapter {
  async submitTx(request: TxRequest) {
    const tx = await this.buildTx(request);
    // Fireblocks API로 서명 요청 (MPC 내부에서 처리)
    const result = await this.fireblocksSDK.createTransaction({
      assetId: 'ETH_TEST5',  // Sepolia
      operation: TransactionOperation.CONTRACT_CALL,
      source: { type: PeerType.VAULT_ACCOUNT, id: this.vaultId },
      destination: { type: PeerType.ONE_TIME_ADDRESS, oneTimeAddress: { address: request.to } },
      extraParameters: { contractCallData: tx.data },
    });
    return { txHash: result.txHash };
  }
}
// → IssuerService, TxStateMachine, 상위 레이어: 전혀 변경 없음
// → IBlockchainAdapter 패턴 설계 효과
```

---

# [강사 배경] 이 과정에서 배운 핵심 교훈 10가지

Phase 1 코드베이스와 직접 연결해 설명할 수 있어야 한다.

**교훈 1: "비동기를 동기처럼 다루려 하지 말라"**
> M2에서 배운 202 패턴의 핵심이다. 코어뱅킹이 NFT 발행 결과를 즉시(200 OK) 받으려 한다면, VASP API 장애 시 전체 요청이 블로킹된다. 202 + Redis Streams + 폴링 패턴은 발행 시스템의 복잡성을 숨기면서 코어뱅킹에 간단한 인터페이스를 제공한다. 금융 시스템에서 비동기는 선택이 아니다.

**교훈 2: "멱등성(Idempotency)은 처음부터 설계해야 한다"**
> M3 S16의 핵심. `idempotencyKey = SHA-256(userId + eventId + tokenId)`를 처음부터 설계하지 않으면, 나중에 Consumer 재시작 시 중복 발행이 발생하고, 이를 수정하려면 전체 아키텍처를 바꿔야 한다. 멱등성은 "혹시 모르니"가 아니라 "반드시 필요한" 설계다.

**교훈 3: "상태머신 없이 복잡한 상태를 관리하지 말라"**
> M3 TxStateMachine. PENDING, SUBMITTED, MINED, CONFIRMED, FINALIZED, REVERT, TIMEOUT, REORG 각각의 상태와 전이 규칙을 명시적으로 모델링하지 않으면, 코드는 if-else 지옥이 된다. 상태머신은 허용된 전이만 컴파일 타임에 강제할 수 있다.

**교훈 4: "오프체인 신뢰는 온체인 검증으로 보완한다"**
> M4 ReconcileService. PostgreSQL 원장이 아무리 정확해도, 실제 블록체인 `balanceOf()`와 불일치할 수 있다. 일일 재조정(reconciliation)은 두 시스템 간 신뢰를 수학적으로 검증하는 유일한 방법이다.

**교훈 5: "감사 로그는 변경 불가능해야 한다"**
> M4 SHA-256 해시 체인. 각 감사 로그 항목이 이전 항목의 해시를 포함하면, 중간 기록 삭제 또는 변조가 즉시 감지된다. 금융 감사에서 로그 무결성은 법적 요건이다. 블록체인이 "변경 불가능한 원장"인 것처럼, 오프체인 감사 로그도 같은 원칙을 적용해야 한다.

**교훈 6: "인터페이스로 의존성을 역전시켜라"**
> M3 IBlockchainAdapter. IssuerService는 EvmAdapter를 직접 참조하지 않는다. 인터페이스에만 의존한다. 덕분에 Phase 2에서 XRPL 어댑터를 추가할 때 IssuerService 코드는 한 줄도 바꾸지 않는다. 의존성 역전 원칙(DIP)은 블록체인처럼 빠르게 변하는 환경에서 특히 중요하다.

**교훈 7: "스마트컨트랙트는 배포 순간 완성이 아니다"**
> M6~M7 UUPS Proxy. 비즈니스 규칙은 변한다. 컨트랙트를 한 번 배포하고 끝이라고 생각하면, 버그 수정도 기능 추가도 불가능하다. UUPS Proxy 패턴은 "로직은 바꿀 수 있고, 상태(Storage)는 보존된다"는 개념을 제공한다. 단, Storage Collision을 이해하고 있어야 업그레이드가 안전하다.

**교훈 8: "단일 키는 단일 실패 지점이다"**
> M9 Gnosis Safe. UPGRADER_ROLE을 서버의 HOT KEY가 가지고 있다면, 서버 하나가 해킹되면 전체 시스템이 무너진다. 2-of-3 멀티시그는 "혼자 결정할 수 없는 구조"를 만든다. 권한 분리는 코드가 아니라 사람과 조직의 문제다.

**교훈 9: "규제는 기술 이후에 온다 — 미리 설계하라"**
> M9 Travel Rule. 특금법 Travel Rule은 이미 시행 중이다. 이를 무시하고 시스템을 설계하면, 나중에 전체 발행 플로우를 다시 짜야 한다. TravelRuleData를 처음부터 `IssueRequest`에 포함시킨 것은 "규제를 아키텍처에 내재화"한 것이다.

**교훈 10: "테스트는 코드다. 테스트없는 코드는 없다"**
> Phase 1 전체에서 1,162개 TC. 금융 시스템에서 "테스트했다"는 말은 "자동화된 테스트 스위트가 green이다"를 의미한다. 매 커밋마다 실행되는 CI/CD 파이프라인에 테스트가 포함되어야 한다. 테스트 없는 코드는 블랙박스다.

---

# [강사 배경] 블록체인 개발자 커리어 패스

이 과정을 마친 수강생들이 어디로 갈 수 있는지 실질적인 경로를 제시한다.

## 경로 1: 스마트컨트랙트 개발자 (Solidity)

**필요 역량:**
- Solidity 고급: 가스 최적화, 어셈블리, 스토리지 레이아웃
- OZ 라이브러리 심층 이해
- 보안 감사 경험

**이 과정에서 얻은 기반:**
- ERC-20/721/1155 구현 (M6~M7)
- UUPS Proxy 패턴 (M6)
- Slither 정적 분석 (M8)
- 멀티시그 EIP-712 서명 (M9)

**다음 학습:**
- Foundry (Hardhat 대안, 가스 프로파일링)
- Yul / Assembly (가스 최적화)
- DeFi 프로토콜 코드 읽기: Uniswap V3, Aave V3, Compound
- CTF: Ethernaut, Damn Vulnerable DeFi

**커리어 목적지:**
- DeFi 프로토콜 코어 팀 (Uniswap, Aave, Compound)
- NFT 플랫폼 (OpenSea, Blur)
- 게임 파이 (Axie, Gods Unchained)
- 보안 감사 회사 (Trail of Bits, Certik, OpenZeppelin)

**시장 현황 (2026년 기준):**
- 연봉: $120K~$300K (글로벌 원격)
- 국내: 대형 거래소, 블록체인 스타트업 $80K~$150K

## 경로 2: 블록체인 백엔드 개발자 (Node.js + ethers.js)

**이 과정에서 얻은 기반:**
- ethers.js + TypeScript (전 과정)
- Redis Streams Consumer (M2)
- TxStateMachine (M3)
- IBlockchainAdapter 멀티체인 패턴 (M3)
- PostgreSQL 원장 (M4)

**이 경로의 강점:**
- 기존 백엔드 개발 경험과 결합 가능
- 블록체인보다 인프라/시스템에 가까움
- 금융권 취업 시 가장 현실적인 경로

**다음 학습:**
- The Graph (인덱서): 온체인 이벤트 → GraphQL API
- IPFS / Filecoin (분산 스토리지)
- Layer 2 (Arbitrum, Optimism) RPC 차이점
- MEV (Maximal Extractable Value) 기초

**커리어 목적지:**
- 금융권 블록체인 팀 (은행, 보험, 증권사)
- 가상자산 거래소 (업비트, 빗썸)
- NFT 마켓플레이스 백엔드
- 블록체인 인프라 (Alchemy, Infura 유사 서비스)

## 경로 3: 보안 감사자 (Smart Contract Auditor)

**필요 역량:**
- Solidity 고급 + 취약점 패턴 암기
- Foundry Fuzzing (invariant testing)
- 감사 리포트 작성 능력 (영어)
- 여러 DeFi 해킹 사례 분석

**이 과정에서 얻은 기반:**
- Reentrancy, Access Control 취약점 (M8)
- Slither 정적 분석 도구 (M8)
- 감사 리포트 포맷 (M8)

**시장 현황:**
- 독립 감사자: $10K~$100K / 프로젝트
- 정규직 감사자: $150K~$400K (Trail of Bits, OpenZeppelin)
- Code4rena, Sherlock 플랫폼: 경쟁 감사 (선착순 취약점 발견 → 보상)

## 경로 4: DeFi 프로토콜 개발

**이 경로는 스마트컨트랙트 경로의 확장이다.**

추가로 필요한 것:
- AMM 수학 (Uniswap V2: x*y=k, V3: concentrated liquidity)
- 대출 프로토콜 청산 메커니즘
- 플래시론 (Flash Loan) 설계
- 오라클 조작 방어 (Chainlink TWAP)

## 관련 자격증 및 학습 경로

```
현재 이용 가능한 공식 인증:
  1. Ethereum Developer Certification (EF)
     - ethereum.org/developers 학습 경로 완료 후 시험
     - 무료 온라인

  2. Certified Blockchain Professional (CBP)
     - EC-Council
     - 기업 교육 과정 포함

  3. ConsenSys Academy
     - Solidity 집중 과정 + NFT/DeFi 특화
     - 유료 ($500~$2,000)

학습 경로 권고 순서 (이 과정 이후):
  1. CryptoZombies (Solidity 기초 강화, 무료)
  2. Ethernaut (보안 문제 풀기, 무료)
  3. Buildspace (실전 프로젝트 빌드, 무료)
  4. Damn Vulnerable DeFi (고급 보안, 무료)
  5. Foundry 마스터 (테스트 도구, 공식 문서)
  6. 실제 오픈소스 컨트랙트 기여 (GitHub)
  7. Code4rena 참가 (감사 경로 선택 시)
```

---

# [강의/진행] 분 단위 진행 계획 (60분)

```
┌─────┬────────────────────────────────────────────────────────────────────┐
│ 시간 │ 내용                                                               │
├─────┼────────────────────────────────────────────────────────────────────┤
│ 0~3  │ 오프닝 — "마지막 세션입니다. M1부터 M9까지 9주간 함께 완성했습니다."  │
│      │ 오늘 진행 순서 안내: 배포(20분) → 발표(40분)                        │
├─────┼────────────────────────────────────────────────────────────────────┤
│ 3~5  │ 배포 체크리스트 확인 (화면 공유)                                    │
│      │ - .env 설정 확인                                                   │
│      │ - Sepolia ETH 잔액 확인                                            │
│      │ - 팀별 미니프로젝트 주제 재확인 (A/B/C)                             │
├─────┼────────────────────────────────────────────────────────────────────┤
│ 5~20 │ [실습] Sepolia 최종 배포 (각 팀 자체 진행)                          │
│      │ - 강사: 화면 공유로 주제 A(KRW 스테이블코인) 라이브 시연            │
│      │ - 학생: 자신의 주제로 병행 배포                                     │
│      │ - Etherscan verify까지 완료 목표                                   │
├─────┼────────────────────────────────────────────────────────────────────┤
│ 20~25│ 발표 준비 시간 (5분)                                                │
│      │ - 발표 구조 슬라이드 배포 (또는 화면 공유)                          │
│      │ - Etherscan 열기, 시연 순서 확인                                   │
├─────┼────────────────────────────────────────────────────────────────────┤
│ 25~55│ [발표] 팀별 최종 데모 발표 (팀당 ~8~10분)                           │
│      │ 3~4팀 × 8~10분                                                    │
│      │ 각 발표 후 Q&A 2분                                                 │
├─────┼────────────────────────────────────────────────────────────────────┤
│ 55~58│ Phase 1 회고 요약 (강사)                                            │
│      │ - M1~M9 핵심 교훈 10가지 중 3가지 강조                             │
│      │ - 운영 투입 체크리스트 1페이지 배포                                 │
├─────┼────────────────────────────────────────────────────────────────────┤
│ 58~60│ Phase 2 방향 30초 소개 + 수료 선언                                 │
│      │ "Phase 1 완성. 이 코드가 실제 운영에 투입될 때 여러분이 책임자입니다" │
└─────┴────────────────────────────────────────────────────────────────────┘
```

---

# [강의/진행] 실습 — 미니프로젝트 Sepolia 최종 배포

## 배포 전 공통 체크리스트 (강사 화면 공유)

```bash
# 1. 테스트 전부 통과 확인
cd blockchain
npx hardhat test
# → XX passing 확인 (failing 있으면 배포 중단)

# 2. 컴파일 확인
npx hardhat compile

# 3. .env 확인
cat .env
# DEPLOYER_PRIVATE_KEY=0x...
# SEPOLIA_RPC_URL=https://rpc.sepolia.org (또는 Alchemy)
# ETHERSCAN_API_KEY=...

# 4. Sepolia ETH 잔액 확인 (0.05 ETH 이상 필요)
# → https://sepoliafaucet.com 에서 추가 발급 가능
```

## 주제 A: KRW 스테이블코인 배포 스크립트

주제 A는 KRWStablecoin + 관련 인프라를 배포한다. `blockchain/src/stablecoin/KRWStablecoin.sol`이 기반이다.

```typescript
// scripts/deploy/mini-project-a-stablecoin.ts
/**
 * 미니프로젝트 A — KRW 스테이블코인 Sepolia 배포
 *
 * 배포 컨트랙트:
 *   1. PermissiveCompliance  — Phase 1 컴플라이언스 (모든 이체 허용)
 *   2. KRWStablecoin         — KyoboKRW (KKRW) ERC-20 토큰
 *   3. mint 테스트           — 초기 발행 100만 KKRW
 *
 * 실행:
 *   npx hardhat run scripts/deploy/mini-project-a-stablecoin.ts --network sepolia
 */

import { ethers } from 'hardhat';

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) throw new Error('No signer configured — .env DEPLOYER_PRIVATE_KEY 확인');

  console.log('='.repeat(60));
  console.log('미니프로젝트 A — KRW 스테이블코인 배포');
  console.log('='.repeat(60));
  console.log('배포 계정:', deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('잔액:', ethers.formatEther(balance), 'ETH');
  if (balance < ethers.parseEther('0.02')) {
    throw new Error('잔액 부족 — Sepolia faucet에서 충전 필요');
  }

  // Step 1: PermissiveCompliance 배포
  // Phase 1 컴플라이언스: 모든 이체 허용 (KYC 검증 없음)
  // Phase 2에서 StrictKYCCompliance로 교체
  console.log('\n[1/3] PermissiveCompliance 배포 중...');
  const Compliance = await ethers.getContractFactory('PermissiveCompliance');
  const compliance = await Compliance.deploy();
  await compliance.waitForDeployment();
  const complianceAddr = await compliance.getAddress();
  console.log('  PermissiveCompliance:', complianceAddr);

  // Step 2: KRWStablecoin 배포
  // constructor(issuer_, compliance_)
  // issuer_ = 배포자 주소 (교보생명 발행 주체)
  // compliance_ = PermissiveCompliance 주소
  console.log('\n[2/3] KRWStablecoin 배포 중...');
  const Stablecoin = await ethers.getContractFactory('KRWStablecoin');
  const stablecoin = await Stablecoin.deploy(
    deployer.address,   // issuer: 교보생명 발행 주체
    complianceAddr,     // compliance: Phase 1 허용 컴플라이언스
  );
  await stablecoin.waitForDeployment();
  const stablecoinAddr = await stablecoin.getAddress();
  console.log('  KRWStablecoin (KKRW):', stablecoinAddr);

  // MINTER_ROLE 부여 확인
  // BaseToken에서 MINTER_ROLE = keccak256("MINTER_ROLE")
  const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('MINTER_ROLE'));
  const hasMinterRole = await (stablecoin as any).hasRole(MINTER_ROLE, deployer.address);
  console.log('  배포자 MINTER_ROLE 보유:', hasMinterRole);

  // Step 3: 초기 테스트 발행
  // depositTxRef: Core Banking 입금 참조 (실제 운영 시 DB 트랜잭션 ID)
  const testRecipient = deployer.address;
  const testAmount = 1_000_000n;           // 100만 KKRW (=100만원)
  const depositTxRef = ethers.keccak256(   // 테스트용 참조
    ethers.toUtf8Bytes('TEST_DEPOSIT_001')
  );

  console.log('\n[3/3] 초기 발행 테스트...');
  console.log('  수령인:', testRecipient);
  console.log('  발행량:', testAmount.toString(), 'KKRW');

  const mintTx = await (stablecoin as any).mint(
    testRecipient,
    testAmount,
    depositTxRef,
  );
  await mintTx.wait();
  console.log('  mint TX:', mintTx.hash);

  // 잔액 확인
  const balance2 = await (stablecoin as any).balanceOf(testRecipient);
  console.log('  발행 후 잔액:', balance2.toString(), 'KKRW');

  // 결과 출력
  console.log('\n' + '='.repeat(60));
  console.log('배포 완료 — 주소를 기록하세요');
  console.log('='.repeat(60));
  console.log(`PERMISSIVE_COMPLIANCE_ADDR=${complianceAddr}`);
  console.log(`KRW_STABLECOIN_ADDR=${stablecoinAddr}`);
  console.log('');
  console.log('Etherscan 확인:');
  console.log(`  https://sepolia.etherscan.io/address/${stablecoinAddr}`);
  console.log(`  https://sepolia.etherscan.io/tx/${mintTx.hash}`);
}

main().catch(err => {
  console.error('배포 실패:', err.message);
  process.exit(1);
});
```

**Etherscan Verify (배포 후 즉시 실행):**

```bash
# KRWStablecoin verify
npx hardhat verify --network sepolia \
  <KRW_STABLECOIN_ADDR> \
  <DEPLOYER_ADDRESS> \
  <PERMISSIVE_COMPLIANCE_ADDR>

# PermissiveCompliance verify (constructor 인자 없음)
npx hardhat verify --network sepolia <PERMISSIVE_COMPLIANCE_ADDR>
```

---

## 주제 B: KyoboNFT + NFTIssuer UUPS 배포 (표준 주제)

주제 B는 `blockchain/scripts/deploy/deploy-rewards.ts`를 사용한다. 이미 완성된 스크립트이므로 실행만 하면 된다.

```bash
# 실행
npx hardhat run scripts/deploy/deploy-rewards.ts --network sepolia
```

출력 예시:
```
Deploying with: 0xYourAddress...
ActivityOracle: 0xABCD1234...
PermissiveCompliance: 0xEFGH5678...
KyoboNFT (proxy): 0xIJKL9012...
NFTIssuer: 0xMNOP3456...
MINTER_ROLE granted to NFTIssuer

── 배포 완료 ────────────────────────────────────────
KYOBO_NFT_PROXY_ADDR=0xIJKL9012...
NFT_ISSUER_ADDR=0xMNOP3456...
ORACLE_ADDR=0xABCD1234...
PERMISSIVE_COMPLIANCE_ADDR=0xEFGH5678...
```

**UUPS Proxy Verify 주의사항:**

```bash
# UUPS Proxy는 일반 verify와 다름
# 프록시 주소 verify — 구현체 자동 감지
npx hardhat verify --network sepolia <PROXY_ADDRESS>

# 또는 @openzeppelin/hardhat-upgrades 플러그인 사용
npx hardhat run scripts/verify-proxy.ts --network sepolia

# verify-proxy.ts 내용:
# import { upgrades } from 'hardhat';
# await upgrades.admin.getInstance().verify(<PROXY_ADDRESS>);
```

---

## 주제 C: SecurityToken (STO) 배포

주제 C는 Phase 3 프리뷰다. `blockchain/scripts/deploy/deploy-securities.ts` 기반이지만, **규제 승인 체크포인트를 우회**해서 테스트넷에 배포한다.

```typescript
// scripts/deploy/mini-project-c-sto.ts
/**
 * 미니프로젝트 C — 토큰증권(STO) Sepolia 배포
 *
 * 주의: 실제 금융위 가이드라인 적용 전 테스트넷 전용
 *
 * 배포 순서:
 *   1. InvestorRegistry   (투자자 등록부)
 *   2. InvestorCompliance (투자자 컴플라이언스)
 *   3. SecurityToken      (ERC-1400 기반 토큰증권)
 *   4. 역할 부여 + 초기 투자자 등록
 *   5. 소량 발행 테스트
 */

import { ethers } from 'hardhat';

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) throw new Error('No signer');

  console.log('='.repeat(60));
  console.log('미니프로젝트 C — 토큰증권(STO) Sepolia 배포');
  console.log('[테스트넷 전용 — 실운영 시 금융위 승인 필수]');
  console.log('='.repeat(60));
  console.log('배포 계정:', deployer.address);

  // 테스트넷이므로 규제 체크 우회 (환경변수 설정 없이 진행)
  process.env.PHASE3_REGULATORY_APPROVED = 'true';

  // Step 1: InvestorRegistry
  console.log('\n[1/5] InvestorRegistry 배포...');
  const Registry = await ethers.getContractFactory('InvestorRegistry');
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log('  InvestorRegistry:', registryAddr);

  // Step 2: InvestorCompliance
  console.log('\n[2/5] InvestorCompliance 배포...');
  const Compliance = await ethers.getContractFactory('InvestorCompliance');
  const compliance = await Compliance.deploy(registryAddr);
  await compliance.waitForDeployment();
  const complianceAddr = await compliance.getAddress();
  console.log('  InvestorCompliance:', complianceAddr);

  // Step 3: SecurityToken
  console.log('\n[3/5] SecurityToken 배포...');
  const Token = await ethers.getContractFactory('SecurityToken');
  const token = await Token.deploy(
    deployer.address,   // issuer (교보생명)
    complianceAddr,
    registryAddr,
  );
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log('  SecurityToken:', tokenAddr);

  // Step 4: 역할 부여
  console.log('\n[4/5] 역할 설정...');
  const CONTROLLER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('CONTROLLER_ROLE'));
  const REGISTRAR_ROLE  = ethers.keccak256(ethers.toUtf8Bytes('REGISTRAR_ROLE'));

  await (token as any).grantRole(CONTROLLER_ROLE, deployer.address);
  console.log('  CONTROLLER_ROLE → 배포자 (준법감시 담당)');

  await (registry as any).grantRole(REGISTRAR_ROLE, deployer.address);
  console.log('  REGISTRAR_ROLE  → 배포자 (투자자 등록 담당)');

  // 투자자 등록 테스트
  // InvestorType.PROFESSIONAL = 2 (전문투자자)
  const testInvestor = deployer.address;
  await (registry as any).register(testInvestor, 2);
  console.log('  테스트 투자자 등록:', testInvestor);

  // Step 5: STO 발행 테스트
  console.log('\n[5/5] STO 발행 테스트...');
  // partition: 발행 단위 (예: 교보생명 채권 시리즈 A)
  const PARTITION_A = ethers.keccak256(ethers.toUtf8Bytes('KYOBO_BOND_SERIES_A'));
  const testAmount = ethers.parseUnits('1000', 0);   // 1,000 토큰 (최소 단위)

  await (token as any).issueByPartition(PARTITION_A, testInvestor, testAmount, '0x');
  console.log('  발행 완료: 1,000 토큰 → PARTITION_A');

  const partitionBalance = await (token as any).balanceOfByPartition(PARTITION_A, testInvestor);
  console.log('  파티션 잔액:', partitionBalance.toString());

  // 결과 출력
  console.log('\n' + '='.repeat(60));
  console.log('배포 완료');
  console.log('='.repeat(60));
  console.log(`INVESTOR_REGISTRY_ADDR=${registryAddr}`);
  console.log(`INVESTOR_COMPLIANCE_ADDR=${complianceAddr}`);
  console.log(`SECURITY_TOKEN_ADDR=${tokenAddr}`);
  console.log('');
  console.log('Etherscan:');
  console.log(`  https://sepolia.etherscan.io/address/${tokenAddr}`);
  console.log('\n다음 단계:');
  console.log('  1. SecurityToken.setDocument() — 투자설명서 IPFS CID 등록');
  console.log('  2. InvestorRegistry.setPartitionLimit() — 보유 한도 설정');
  console.log('  3. 투자자 이체 테스트: transferByPartition()');
}

main().catch(err => {
  console.error('배포 실패:', err.message);
  process.exit(1);
});
```

**실행:**
```bash
npx hardhat run scripts/deploy/mini-project-c-sto.ts --network sepolia
```

---

# [강의/진행] 최종 데모 발표 가이드

## 발표 구조 (8~10분 기준 타임라인)

```
┌───────┬──────────────────────────────────────────────────────────────────────┐
│ 시간   │ 내용                                                                 │
├───────┼──────────────────────────────────────────────────────────────────────┤
│ 0:00  │ 프로젝트 소개                                                         │
│       │ - "저희 팀은 주제 [A/B/C]를 선택했습니다."                             │
│       │ - 이 컨트랙트가 해결하는 비즈니스 문제 1문장                            │
│       │ - 배포된 컨트랙트 주소 Etherscan 링크 화면 공유                         │
├───────┼──────────────────────────────────────────────────────────────────────┤
│ 1:30  │ 아키텍처 설명 (30초)                                                  │
│       │ - 어떤 컨트랙트들이 배포되었는가                                       │
│       │ - 컨트랙트 간 의존성 (그림 또는 구두 설명)                              │
├───────┼──────────────────────────────────────────────────────────────────────┤
│ 2:00  │ Etherscan 라이브 시연                                                 │
│       │ (아래 시연 항목 목록 참조)                                             │
├───────┼──────────────────────────────────────────────────────────────────────┤
│ 6:00  │ 보안 고려사항 설명                                                    │
│       │ - 이 컨트랙트에서 가장 중요한 보안 설계 2가지                           │
│       │ - 어떤 공격을 방어하는가                                               │
├───────┼──────────────────────────────────────────────────────────────────────┤
│ 7:30  │ 운영 투입 시 남은 과제                                                 │
│       │ - "실제 운영에 투입하려면 무엇이 더 필요한가"                           │
│       │ - 2~3가지 (외부 감사, 규제 승인, 모니터링 등)                          │
├───────┼──────────────────────────────────────────────────────────────────────┤
│ 8:30  │ Q&A                                                                  │
└───────┴──────────────────────────────────────────────────────────────────────┘
```

## Etherscan에서 시연할 항목 목록

### 주제 A (KRW 스테이블코인) Etherscan 시연

```
1. Contract 탭 → Contract Source Code (Verified)
   → "코드가 공개적으로 검증되었습니다. 누구나 확인 가능합니다."

2. Contract → Read Contract
   a. name()       → "KyoboKRW"
   b. symbol()     → "KKRW"
   c. decimals()   → 0  (1토큰 = 1원)
   d. totalSupply() → 1000000 (초기 발행량)
   e. balanceOf(<DEPLOYER_ADDRESS>) → 1000000

3. Events 탭
   a. Minted 이벤트 확인
      → to: 발행 수령인
      → amount: 1000000
      → depositTxRef: 코어뱅킹 참조 해시

4. Contract → Write Contract (라이브 시연)
   a. mint() 호출
      - MetaMask 연결
      - to: 다른 주소
      - amount: 1000
      - depositTxRef: 0x00...01
      → TX 제출 → MetaMask 서명 → 확인
   b. 잔액 재조회: balanceOf() → 변화 확인

5. 보안 시연:
   a. Write Contract → mint() — 다른 MetaMask 계정(MINTER_ROLE 없는 계정)으로 시도
      → AccessControl 오류: "AccessControl: account is missing role"
      → "MINTER_ROLE이 없으면 발행 불가"
```

### 주제 B (KyoboNFT) Etherscan 시연

```
1. Contract → Read Contract
   a. uri(tokenId) → 메타데이터 URI
   b. balanceOf(address, tokenId) → NFT 잔액 조회
   c. hasRole(MINTER_ROLE, NFTIssuer주소) → true

2. Contract → Write Contract
   a. mint() — NFTIssuer 통해 발행 (또는 직접 mint 시연)
   b. 발행 후 balanceOf 변화 확인

3. Events
   a. TransferSingle 이벤트 — mint 시 발생
      → operator, from(0x0 = 발행), to, id, value

4. UUPS Proxy 구조 설명:
   Etherscan → "This contract is a proxy"
   → Implementation 주소 확인
   → "로직은 여기, 상태(데이터)는 프록시에 있습니다"

5. 보안 시연:
   upgradeToAndCall() 시도 → UPGRADER_ROLE 없으면 차단
   → "업그레이드는 Gnosis Safe 2-of-3만 가능"
```

### 주제 C (SecurityToken) Etherscan 시연

```
1. Contract → Read Contract
   a. balanceOfByPartition(partition, address)
      → 파티션별 잔액 ("KYOBO_BOND_SERIES_A" keccak256 해시)
   b. isControllable() → true (규제 기관 강제 이전 가능)

2. 파티션 개념 설명:
   "ERC-20은 단일 잔액, SecurityToken은 파티션별 잔액"
   "SERIES_A, SERIES_B 등 발행 단위 분리 가능"

3. CONTROLLER_ROLE 시연:
   controllerTransfer() — 규제 기관 요청 시 강제 이전
   "AML 위반 시 금융감독원 요청으로 자산 동결 가능"

4. 투자자 등록 확인:
   InvestorRegistry.isRegistered(address) → true/false
   "등록되지 않은 투자자는 STO 구매 불가"
```

## 예상 질문과 답변 가이드

**Q1: "Etherscan에 소스코드가 공개되면 해킹당하지 않나요?"**

> 오히려 반대다. 소스코드 공개(verify)는 신뢰의 표시다. 블록체인에서 "보안"은 비밀성이 아니라 "수학적 불변성"에 기반한다. 코드가 공개되어 있어도 MINTER_ROLE 없이는 mint()를 호출할 수 없다. 이것은 수학적으로 보장된다. 오히려 코드가 비공개이면 사용자가 컨트랙트 동작을 신뢰할 수 없다.

**Q2: "Sepolia 배포와 Mainnet 배포의 차이는 무엇인가요?"**

> 기술적으로는 동일하다. `--network sepolia` 대신 `--network mainnet`으로 바꾸면 된다. 그러나 Mainnet은 실제 돈이 걸린다. 가스 비용 = 실제 ETH. 컨트랙트 버그 = 실제 자산 피해. 그래서 Mainnet 배포 전에 Sepolia에서 충분히 테스트하고, 외부 보안 감사를 완료해야 한다.

**Q3: "UUPS Proxy를 왜 쓰나요? 그냥 컨트랙트 새로 배포하면 안 되나요?"**

> 새로 배포하면 주소가 바뀐다. 모든 사용자 지갑에서 새 주소로 NFT가 이동하지 않는다. 기존 주소로 발행된 NFT는 여전히 구 컨트랙트에 있다. UUPS Proxy는 주소를 유지하면서 로직만 교체한다. 금융 서비스에서 주소 변경은 운영 중단에 가까운 사건이다.

**Q4: "Travel Rule은 왜 컨트랙트 레벨이 아니라 백엔드 레벨에서 처리하나요?"**

> Travel Rule은 신원 정보(이름, 주민번호 등)를 포함한다. 이 정보는 블록체인 온체인에 올리면 안 된다 — 영원히 공개된다. PIPA(개인정보보호법) 위반이다. 그래서 오프체인(백엔드)에서 TravelRuleData를 처리하고, 온체인에는 TX 해시만 기록한다.

**Q5: "Gnosis Safe 없이도 배포할 수 있는데, 왜 복잡하게 2-of-3를 쓰나요?"**

> 금융감독원 IT 감리 기준과 ISMS 인증에서 "중요 변경의 권한 분리"를 요구한다. 단일 개인이 시스템 전체를 변경할 수 있으면 내부 통제 실패다. 2-of-3는 기술적 요구사항이자 규제 준수 요건이다.

---

# [강의/진행] Phase 1 전체 회고 강의

## 강의 포인트 (발표 후 5분 회고)

### M1~M9 연결 고리 — 한 문장씩

강사가 칠판(또는 화면)에 순서대로 쓰면서 설명한다.

```
M1: "우리는 EVM 위에 금융 시스템을 얹기로 했다."
        ↓
M2: "외부 이벤트를 잃지 않고 받기 위해 202 + Redis Streams를 썼다."
        ↓
M3: "블록체인 TX는 언제든 실패할 수 있으므로 상태머신으로 복구를 설계했다."
        ↓
M4: "온체인 발행 결과를 PostgreSQL 원장에 이중 기록하고 SHA-256으로 무결성을 보장했다."
        ↓
M5: "비즈니스 규칙(걷기달성, 건강검진, 만기완료)을 전략 패턴으로 분리했다."
        ↓
M6: "ERC-1155 + UUPS Proxy로 업그레이드 가능한 NFT 컨트랙트를 설계했다."
        ↓
M7: "KyoboNFT를 Sepolia에 배포하고 Etherscan에서 검증했다."
        ↓
M8: "Slither + Reentrancy 방어로 공격 표면을 줄이고 감사 리포트를 작성했다."
        ↓
M9: "Gnosis Safe 2-of-3로 단일 키 위험을 제거하고 Travel Rule로 규제를 준수했다."
        ↓
S50: "이 모든 것이 연결된 하나의 시스템입니다."
```

### 핵심 교훈 3가지 (회고 시간에 강조)

**교훈 A: 비동기가 기본이다**
> 블록체인 시스템에서 "즉각 응답"은 환상이다. 202 패턴, Redis Streams, 상태머신 — 모든 설계가 "나중에 처리된다"는 전제 위에 있다. 이 사실을 받아들이는 순간, 아키텍처가 단순해진다.

**교훈 B: 인터페이스가 시스템의 수명을 결정한다**
> IBlockchainAdapter 하나가 Phase 1 VASP 위탁 → Phase 3 자체 MPC를 가능하게 한다. 인터페이스를 잘 설계하면 구현체가 바뀌어도 상위 레이어는 불변이다. 오늘 쓴 IssuerService 코드는 5년 후에도 살아있을 것이다.

**교훈 C: 규제는 요구사항이다**
> TravelRuleData, MINTER_ROLE, ReconcileService — 이것들은 "좋아서" 만든 것이 아니다. 특금법, 금융보안원 가이드라인, ISMS 인증 요건이다. 규제를 아키텍처에 내재화하면 나중에 덧붙이는 비용이 없다.

---

# [강의/진행] Phase 2 방향 소개

## 강의 슬라이드 (30~60초 소개)

학생들에게 "이 과정 이후의 세계"를 보여주는 것이 목적이다. 깊이 설명할 시간은 없으므로, 세 가지 방향의 이름과 핵심 개념만 전달한다.

```
Phase 2 — 3가지 방향

1. KRW 스테이블코인
   KRWStablecoin.sol은 이미 STUB으로 있습니다.
   교보생명 원화 수탁 계좌 ↔ 온체인 1:1 보장.
   규제 승인(샌드박스) 후 구현 시작.

2. XRPL 멀티체인
   IBlockchainAdapter에 XrplAdapter를 추가합니다.
   IssuerService 코드는 한 줄도 안 바뀝니다.
   국경 간 보험금 지급에 활용 가능.

3. MPC 거버넌스
   Gnosis Safe 2-of-3 → Fireblocks MPC.
   완전한 키는 어디에도 존재하지 않습니다.
   Phase 3 자체 VASP 인가 후 도입.
```

---

# [강의/진행] 최종 완성 조건 체크리스트

수강생이 이 세션 종료 시 확인해야 할 전체 체크리스트다. 강사는 이 항목들을 발표 시작 전 배포하거나 화면에 표시해 학생들이 스스로 체크할 수 있게 한다.

## Phase 1 — 미니프로젝트 완성 기준

### Sepolia 배포
```
[ ] 선택한 주제 컨트랙트가 Sepolia에 배포되어 있다
[ ] 배포 TX 해시를 Etherscan에서 확인할 수 있다
[ ] 컨트랙트 소스코드가 Etherscan에서 Verified 상태다
[ ] 배포된 컨트랙트 주소를 팀원 모두가 알고 있다
```

### 기능 동작 확인
```
[ ] Etherscan Read Contract에서 기본 상태 조회 가능
[ ] Write Contract에서 핵심 기능 1회 이상 실행했다
[ ] 이벤트(Event) 발생이 Etherscan Events 탭에서 확인된다
[ ] 권한 없는 계정이 보호된 함수 호출 시 revert 확인했다
```

### 보안 고려사항
```
[ ] Slither 정적 분석을 실행하고 High/Medium 결과를 검토했다
[ ] Reentrancy 가능한 함수가 있다면 ReentrancyGuard 또는 CEI 적용했다
[ ] 배포 계정 개인키가 .gitignore에 포함되어 git에 노출되지 않는다
[ ] UPGRADER_ROLE이 단일 EOA가 아닌 Safe 주소에 부여되어 있다 (해당 주제)
```

### 발표 준비
```
[ ] 5분 내 발표 흐름을 팀원 모두가 숙지하고 있다
[ ] Etherscan 시연 순서를 사전에 리허설했다
[ ] 예상 질문 5가지에 대한 답변을 준비했다
[ ] 배포 주소를 발표 자료(슬라이드 또는 공유 문서)에 기재했다
```

## Phase 1 전체 — 학습 완성 기준

### M1~M3 이벤트 파이프라인
```
[ ] 202 Accepted 패턴이 왜 필요한지 설명할 수 있다
[ ] Redis Streams Consumer Group의 At-Least-Once 보장 원리를 설명할 수 있다
[ ] DLQ가 무엇이고 언제 사용하는지 설명할 수 있다
[ ] TX 상태머신의 8가지 상태와 전이 조건을 그릴 수 있다
[ ] REVERT, TIMEOUT, REORG 각각의 복구 전략을 설명할 수 있다
[ ] IBlockchainAdapter 패턴이 왜 멀티체인 확장에 유리한지 설명할 수 있다
```

### M4~M5 신뢰 시스템
```
[ ] PostgreSQL 원장과 블록체인 원장이 어떻게 이중으로 관리되는지 설명할 수 있다
[ ] SHA-256 감사 해시 체인이 변조를 어떻게 감지하는지 설명할 수 있다
[ ] ReconcileService가 하는 일과 불일치 발생 시 대응을 설명할 수 있다
[ ] 멱등성 키(Idempotency Key)가 중복 발행을 어떻게 방지하는지 설명할 수 있다
[ ] 전략 패턴이 조건 판단 로직 확장에 왜 유리한지 설명할 수 있다
[ ] 벌크 발행(BulkIssuer) 아키텍처와 단건 발행의 차이를 설명할 수 있다
```

### M6~M7 스마트컨트랙트
```
[ ] ERC-20, ERC-721, ERC-1155의 차이를 실제 use case와 연결해 설명할 수 있다
[ ] UUPS Proxy 패턴에서 Storage Collision이 왜 위험한지 설명할 수 있다
[ ] tokenId 비트 레이아웃 설계 (productCode | eventCode)를 설명할 수 있다
[ ] OpenZeppelin AccessControl의 RBAC 구조를 설명할 수 있다
[ ] Sepolia 배포 절차 (compile → deploy → verify)를 직접 실행할 수 있다
[ ] Etherscan에서 컨트랙트 상태를 조회하고 함수를 호출할 수 있다
```

### M8 보안
```
[ ] Reentrancy 공격 패턴과 방어 방법(ReentrancyGuard, CEI)을 설명할 수 있다
[ ] Slither를 실행하고 출력 결과를 해석할 수 있다
[ ] 스마트컨트랙트 감사 리포트의 구성 요소를 설명할 수 있다
[ ] 관리자 키 단일 보관의 위험성과 대안을 설명할 수 있다
```

### M9 거버넌스 + 규제
```
[ ] Gnosis Safe 2-of-3 구조와 왜 HOT KEY보다 안전한지 설명할 수 있다
[ ] EIP-712 구조화 서명이 일반 서명과 다른 점을 설명할 수 있다
[ ] Travel Rule 의무 대상과 TravelRuleData 구성 요소를 설명할 수 있다
[ ] Phase 1에서 교보생명과 VASP(월렛원)의 Travel Rule 책임 분담을 설명할 수 있다
[ ] Phase 2 방향 3가지 (스테이블코인, XRPL, MPC)를 한 문장씩 설명할 수 있다
```

### 운영 관점
```
[ ] 운영 투입 전 점검해야 할 체크리스트 5개 이상 나열할 수 있다
[ ] DLQ 이벤트 발생 시 무엇을 해야 하는지 설명할 수 있다 (S51 런북)
[ ] 컨트랙트 업그레이드 절차 (ProposeTx → 서명 수집 → 실행)를 설명할 수 있다
[ ] 온체인 vs 오프체인 잔액 불일치 발생 시 조사 절차를 설명할 수 있다
```

---

## 강사 마무리 발언 가이드

> "9주 전, M1에서 우리는 '교보생명이 왜 블록체인을 써야 하는가'라는 질문으로 시작했습니다. 오늘 여러분이 배포한 컨트랙트는 그 질문에 대한 코드로 된 답변입니다."
>
> "Redis Streams가 이벤트를 잃지 않고, TxStateMachine이 블록체인 장애를 복구하며, SHA-256 해시 체인이 감사 로그 무결성을 보장하고, Gnosis Safe가 단일 키 위험을 제거합니다. 이 모든 것이 함께 동작할 때 비로소 금융 시스템이라 부를 수 있습니다."
>
> "Phase 1은 완성입니다. Phase 2는 여러분이 현업에서 계속 만들어 나갈 것입니다. 오늘 배운 IBlockchainAdapter 패턴은 XRPL 어댑터를 추가할 때, TxStateMachine은 크로스체인 브리지 TX를 처리할 때, ReconcileService는 멀티체인 잔액을 검증할 때 그대로 살아있습니다."
>
> "이 코드의 책임자는 이제 여러분입니다. 감사합니다."

---

*작성 기준: Phase 1 전체 커리큘럼 M1~M9 / 2026-05-27*  
*대상: 교보생명 디지털 자산 플랫폼 개발팀 / 웅진씽크빅 강의 프로그램*
