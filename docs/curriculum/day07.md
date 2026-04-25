# Day 07 — 테스트넷 배포 & 운용 모니터링

**시간**: 3시간 (180분)  
**핵심 질문**: 로컬에서 동작한다. 테스트넷에 배포하면 무엇이 달라지고, 운용 책임자는 무엇을 모니터링해야 하는가?

---

## 세션 구조

| 시간 | 내용 |
|---|---|
| 00:00~00:25 | 1부: 테스트넷 vs 로컬 — 무엇이 달라지는가 |
| 00:25~01:15 | 실습 1: Ethereum Sepolia 배포 + Etherscan 확인 |
| 01:15~01:45 | 2부: 운용 모니터링 — 무엇을 보아야 하는가 |
| 01:45~02:30 | 실습 2: 테스트넷 NFT 발행 + 트랜잭션 추적 |
| 02:30~03:00 | 실습 3: 비상 정지 + 복구 절차 |

---

## 1부: 테스트넷 vs 로컬 — 무엇이 달라지는가 (00:00~00:25)

### 1-1. 로컬 Hardhat의 한계 (10분)

**토킹포인트:**

> "로컬 Hardhat 노드는 개발에는 완벽하지만 실제 환경과 다른 점이 있습니다."

| 항목 | 로컬 Hardhat | Ethereum Sepolia 테스트넷 |
|---|---|---|
| 블록 생성 | 트랜잭션 즉시 | ~2초 대기 |
| 네트워크 지연 | 없음 | RPC 응답 지연 |
| Gas 가격 | 0 | 실제 gas price 적용 |
| 블록 탐색기 | 없음 | Etherscan Sepolia |
| 컨트랙트 검증 | 불가 | Etherscan 검증 가능 |
| 재시작 시 | 상태 초기화 | 영구 기록 |

### 1-2. 테스트넷 배포 전 체크리스트 (15분)

**토킹포인트:**

> "테스트넷이라도 배포 후 컨트랙트 주소는 바뀌지 않습니다. 배포 전 반드시 확인해야 할 것들이 있습니다."

**배포 전 체크리스트:**
```
□ Hardhat 로컬에서 모든 시나리오 테스트 완료
□ 배포 계정에 테스트넷 Sepolia ETH 충분히 확보
□ ORACLE_SIGNER_ADDRESS 주소 확정
□ BASE_METADATA_URI 서버 준비 (메타데이터 서버 응답 확인)
□ 배포 스크립트의 파라미터 재확인
□ 팀원과 배포 역할 분담 확인 (배포자 ≠ 오라클 서명자)
```

---

## 실습 1: Ethereum Sepolia 배포 + Etherscan 확인 (00:25~01:15)

### Step 1 — 테스트넷 ETH 확보 (10분)

```
Sepolia Faucet: https://sepoliafaucet.com/
또는: https://www.alchemy.com/faucets/ethereum-sepolia
→ 지갑 주소 입력 → 0.5 ETH 수령
```

`.env` 설정:
```bash
SEPOLIA_RPC_URL=https://rpc.sepolia.org
DEPLOYER_PRIVATE_KEY=[테스트 전용 지갑 키]
ORACLE_SIGNER_ADDRESS=[오라클 서명 계정 주소]
BASE_METADATA_URI=https://meta-test.kyobo-da.internal/nft
ETHERSCAN_API_KEY=[Etherscan API 키]
```

### Step 2 — 배포 실행 (15분)

```bash
cd blockchain
npx hardhat run scripts/deploy/deploy-phase1.ts --network sepolia
```

**예상 출력:**
```
Deploying with: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ActivityOracle: 0x5FbDB2315678afecb367f032d93F642f64180aa3
KyoboNFT:      0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
NFTIssuer:     0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
ISSUER_ROLE granted to NFTIssuer

── 배포 완료 ──────────────────────────────────
NFT_CONTRACT_ADDR=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
NFT_ISSUER_ADDR=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
ORACLE_ADDR=0x5FbDB2315678afecb367f032d93F642f64180aa3
```

### Step 3 — Etherscan Sepolia 탐색 (25분)

`https://sepolia.etherscan.io/address/[NFT_CONTRACT_ADDR]`

확인 항목별 설명:

**[Contract 탭]**
> "소스 코드가 표시되지 않는다면 컨트랙트가 Verify되지 않은 것입니다. Verify하면 누구나 소스 코드를 확인할 수 있습니다."

```bash
npx hardhat verify --network sepolia [NFT_CONTRACT_ADDR] [deployer] [complianceAddr]
```

**[Events 탭]**
> "이 컨트랙트에서 발생한 모든 이벤트가 기록됩니다. Issued, Revoked, RoleGranted... 이것이 온체인 감사 로그입니다. 누구도 삭제할 수 없습니다."

**[Read Contract 탭]**
> "배포된 컨트랙트의 상태를 직접 조회할 수 있습니다. `paused()` 상태, `issuer()` 주소를 여기서 확인합니다."

---

## 2부: 운용 모니터링 — 무엇을 보아야 하는가 (01:15~01:45)

### 2-1. 운용 책임자가 매일 확인해야 할 것들 (20분)

**토킹포인트:**

> "NFT 발행 서비스가 운영되면 매일 아침 확인해야 할 지표들이 있습니다. 이것들을 놓치면 고객 피해로 이어집니다."

**일일 모니터링 체크리스트:**

```
□ issuer-service 프로세스 정상 실행 중
□ EVMAdapter.isConnected() = true (노드 연결 확인)
□ 마지막 처리 블록이 현재 블록과 차이 없음 (이벤트 지연 없음)
□ DLQ 쌓인 이벤트 없음
□ 오라클 서명 키 만료 여부 확인
□ KyoboNFT.paused() = false (서비스 정상)
□ 당일 발행 건수 Core Banking과 일치 여부
```

**이상 징후별 대응:**

| 이상 징후 | 원인 추정 | 즉시 조치 |
|---|---|---|
| isConnected() = false | 노드 다운 또는 DMZ 방화벽 | 노드 상태 확인, DMZ Nginx 로그 확인 |
| 처리 블록 지연 급증 | 이벤트 처리 병목 | 이벤트 핸들러 에러 로그 확인 |
| DLQ 누적 | Core Banking 다운 | Core Banking 팀 연락, DLQ 보존 |
| 발행 건수 불일치 | 이벤트 누락 또는 중복 | lastProcessedBlock 확인, DB 조회 |
| paused() = true | 비상 정지 실행됨 | 원인 파악 후 unpause 여부 결정 |

### 2-2. Gas 비용 모니터링 (10분)

**토킹포인트:**

> "EVM 호환 체인에서 NFT 발행 1건당 Gas 비용을 측정해 봅시다. 프로덕션 체인이 결정되면 이 수치를 바탕으로 월간 Gas 예산을 산정해야 합니다. 운영 예산에 Gas 비용이 반드시 포함되어야 합니다."

```typescript
// 배포 스크립트에서 Gas 측정
const receipt = await tx.wait();
console.log('gasUsed:', receipt.gasUsed.toString());
console.log('gasPrice:', receipt.gasPrice?.toString(), 'wei');
const cost = receipt.gasUsed * (receipt.gasPrice ?? 0n);
console.log('cost:', ethers.formatEther(cost), 'ETH');
```

---

## 실습 2: 테스트넷 NFT 발행 + 트랜잭션 추적 (01:45~02:30)

### Step 1 — 테스트넷 발행 (20분)

```bash
npx hardhat run scripts/issue-nft-full.ts --network sepolia
```

**출력 예시:**
```
=== NFT 발행 전체 흐름 ===
[1단계] 오라클 데이터 준비
  value (보): 10000
[2단계] 오라클 서명 생성
  서명자: 0x...
[3단계] NFTIssuer.issueActivityNFT() 호출
  트랜잭션 전송: 0xabcd...
  블록 확인: 12345678
  Gas 사용량: 185432
[4단계] 발행 결과 확인
  tokenId: 0
  발행 시각: 2026-04-21T...
```

### Step 2 — Etherscan에서 트랜잭션 분석 (25분)

`https://sepolia.etherscan.io/tx/[txHash]`

분석 항목:

**Transaction Details:**
- Status: `Success` — 성공 여부
- Gas Used: `185,432` / Gas Limit: `250,000`
  - Gas Limit을 너무 낮게 설정하면 Out of Gas로 실패
  - 실패해도 Gas는 소모됨

**Event Logs:**
- Topic 0: `Issued(address,uint256,bytes32)` 이벤트 시그니처 해시
- Topic 1 (indexed): 수신자 주소 (패딩 포함)
- Topic 2 (indexed): tokenId
- Data: reason (activityId)

> "이 로그를 `ChainEventListener`가 구독합니다. ethers.js의 ABI 파서가 raw hex를 사람이 읽을 수 있는 형태로 변환합니다."

---

## 실습 3: 비상 정지 + 복구 절차 (02:30~03:00)

**시나리오:**
> "오전 9시, 오라클 서명 키가 유출됐다는 신고가 들어왔다. 즉시 조치가 필요하다."

### Step 1 — 즉시 Pause (5분)
```typescript
const nft = await ethers.getContractAt('KyoboNFT', process.env.NFT_CONTRACT_ADDR!);
const tx  = await nft.pause();
await tx.wait();
console.log('컨트랙트 일시 정지 완료');
console.log('Etherscan에서 pause 이벤트 확인:', tx.hash);
```

### Step 2 — 피해 범위 파악 (10분)
```typescript
// pause 이전 블록부터 유출 의심 시점까지의 Issued 이벤트 조회
const adapter = new EVMAdapter({ rpcUrl: process.env.SEPOLIA_RPC_URL!, chainId: '11155111' });
const suspiciousEvents = await adapter.queryEvents(
  process.env.NFT_CONTRACT_ADDR!,
  ABI,
  'Issued',
  suspectFromBlock,
  suspectToBlock,
);

console.log('조사 대상 발행 건수:', suspiciousEvents.length);
suspiciousEvents.forEach(e => {
  console.log('  to:', e.args.to, '| activityId:', e.args.reason);
});
```

### Step 3 — 키 교체 + Unpause (10분)
```typescript
// ActivityOracle에 새 서명 계정 설정
const oracle  = await ethers.getContractAt('ActivityOracle', process.env.ORACLE_ADDR!);
const newKey  = ethers.Wallet.createRandom();
const ORACLE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('ORACLE_ROLE'));

await oracle.revokeRole(ORACLE_ROLE, compromisedSignerAddress);
await oracle.grantRole(ORACLE_ROLE, newKey.address);
console.log('오라클 키 교체 완료. 새 주소:', newKey.address);

await nft.unpause();
console.log('서비스 재개');
```

### Step 4 — 사후 정리 (5분)
비상 대응 보고서 작성:
- 유출 감지 시각 ~ 조치 완료 시각
- 피해 추정 발행 건수
- 조치 내용 (pause, 키 교체, unpause)
- 재발 방지 방안 (키 관리 프로세스 개선)

---

## 마무리

**오늘의 핵심 3줄:**
1. 테스트넷 배포 후 Etherscan이 공개 감사 로그가 된다
2. 운용 책임자는 매일 7개 항목을 확인해야 한다
3. 비상 정지는 30초 안에 실행 가능해야 한다 — PAUSER_ROLE 소유자가 항상 대기 가능해야 한다

**Day 08 예고:**  
ISMS-P 체크리스트 직접 실행. 스마트컨트랙트 취약점을 실제 운용 관점에서 다시 본다.

---

## 참조 파일

- `blockchain/scripts/deploy/deploy-phase1.ts`
- `blockchain/src/base/BaseToken.sol`
- `dmz/packages/chain-adapters/src/evm/EVMAdapter.ts`
- `.env.example`
