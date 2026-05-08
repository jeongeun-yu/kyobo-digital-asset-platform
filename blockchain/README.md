# blockchain — 스마트 컨트랙트

## 빠른 시작

```powershell
# blockchain/ 폴더에서 실행
cd blockchain

# 컴파일 → artifacts/ + typechain-types/ 생성
npx hardhat compile

# 테스트 실행
npx hardhat test

# 로컬 노드 기동 (별도 터미널)
npx hardhat node
```

루트에서 실행하려면:

```powershell
npm run node:local    # 로컬 노드 기동
```

---

## 컨트랙트 구조

```
src/
├── base/
│   └── BaseToken.sol           # 모든 토큰의 공통 기반 (RBAC + pause + compliance)
├── interfaces/
│   ├── IToken.sol
│   ├── ICompliance.sol
│   ├── IOracle.sol
│   ├── IInvestorRegistry.sol
│   ├── IDividendDistributor.sol
│   └── ISecurityToken.sol
├── rewards/                    # Phase 1 — 행동 보상 NFT
│   ├── KyoboNFT.sol            # ERC-1155 UUPS 업그레이드형
│   ├── NFTIssuer.sol           # 발행 게이트웨이 (오라클 검증 + Idempotency)
│   └── ActivityOracle.sol      # 오프체인 활동 데이터 오라클
├── compliance/
│   ├── PermissiveCompliance.sol # Phase 1 — 전송 항상 허용
│   └── InvestorCompliance.sol  # Phase 3 — 투자자 등록·한도·락업 검증
├── stablecoin/
│   └── KRWStablecoin.sol       # Phase 2 — 원화 스테이블코인
├── securities/
│   └── SecurityToken.sol       # Phase 3 — ERC-1400 STO (스텁)
└── mocks/
    ├── MockERC1155.sol          # Sepolia 실습용 경량 ERC-1155
    └── MockInvestorRegistry.sol # 테스트용 InvestorRegistry
```

---

## 테스트

```
test/
├── KyoboNFT.test.ts      # ERC-1155 배포·mint·pause·UUPS (16개)
├── NFTIssuer.test.ts     # 오라클 서명·발행·idempotency·배치 (12개)
└── SecurityToken.test.ts # 역할·파티션·이벤트·pause (11개)
```

```powershell
npx hardhat test
# 39 passing
```

---

## 환경 변수

| 변수 | 용도 |
|---|---|
| `MAINNET_RPC_URL` | Mainnet Fork 활성화 — 설정 시 `npx hardhat node`가 메인넷 상태로 기동 |
| `SEPOLIA_RPC_URL` | Sepolia 배포용 RPC |
| `DEPLOYER_PRIVATE_KEY` | 배포자 키 (로컬 기본값: Hardhat 0번 계정) |

`.env`는 루트(`../`)에 위치. `dotenv`가 `path.resolve(__dirname, '../.env')`로 로드.

---

## Phase 로드맵

| Phase | 컨트랙트 | 상태 |
|---|---|---|
| 1 | KyoboNFT + NFTIssuer + ActivityOracle | 완료 |
| 2 | KRWStablecoin | 스텁 |
| 3 | SecurityToken + InvestorCompliance + InvestorRegistry | 스텁 |
