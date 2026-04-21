# Day 03 — 온체인 이벤트를 오프체인으로 잡는 법

**시간**: 3시간 (180분)  
**핵심 질문**: 블록체인은 push가 없다. 그러면 Core Banking은 NFT 발행 완료를 어떻게 아는가?

---

## 세션 구조

| 시간 | 내용 |
|---|---|
| 00:00~00:25 | 1부: 폴링 vs 이벤트 구독 — 왜 선택이 중요한가 |
| 00:25~00:55 | 2부: 이벤트 구조 해부 — ABI, Log, indexed |
| 00:55~01:50 | 실습 1: 로컬 노드 배포 + 이벤트 실시간 수신 |
| 01:50~02:20 | 3부: ChainEventListener 내부 구조 |
| 02:20~02:55 | 실습 2: Missed Event 복구 시나리오 |
| 02:55~03:00 | 마무리 |

---

## 1부: 폴링 vs 이벤트 구독 (00:00~00:25)

### 1-1. 폴링의 문제 (15분)

**토킹포인트:**

> "가장 단순한 방법은 폴링입니다. 1초마다 '발행됐어?' 물어보는 거죠. 근데 금융 시스템에서 이게 왜 문제인지 생각해보겠습니다."

**폴링 방식:**
```
1초마다:
  블록체인에 "새 이벤트 있어?" 요청
  → 없으면 무시
  → 있으면 처리

문제 1: 블록이 2초마다 생성되면 이벤트를 최대 2초 늦게 발견
문제 2: 이벤트 없을 때도 1초마다 RPC 호출 → 노드 부하
문제 3: 서비스 재시작 시 폴링 중단 구간의 이벤트 누락
문제 4: 많은 컨트랙트를 감시하면 폴링 수가 선형 증가
```

**이벤트 구독 방식:**
```
WebSocket 연결 유지
  → 이벤트 발생 시 즉시 push
  → 없을 때는 아무 비용 없음
  → 재시작 시 queryEvents()로 missed event 복구
```

### 1-2. 이벤트 드리븐이 금융 시스템에서 중요한 이유 (10분)

**토킹포인트:**

> "NFT가 발행됐는데 Core Banking이 5초 후에 알면 어떤 문제가 생길까요? 고객은 앱에서 NFT를 받았는데 포인트 시스템엔 반영이 안 된 상태가 5초간 존재합니다. 이걸 '데이터 불일치'라고 합니다. 금융에서 데이터 불일치는 곧 민원입니다."

---

## 2부: 이벤트 구조 해부 (00:25~00:55)

### 2-1. Solidity 이벤트가 블록체인에 기록되는 방식 (20분)

**토킹포인트:**

> "`KyoboNFT.sol`에서 `emit Issued(to, tokenId, activityId)` 를 실행하면 블록체인에 Log가 기록됩니다. 이 Log의 구조를 이해해야 나중에 정확히 파싱할 수 있습니다."

```bash
cat packages/contracts/src/phase1/KyoboNFT.sol
# Issued 이벤트 찾기:
# event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason);
```

**Log의 구조:**
```
Topics[0]: keccak256("Issued(address,uint256,bytes32)")  ← 이벤트 시그니처
Topics[1]: to 주소  ← indexed 파라미터 (검색 가능)
Topics[2]: tokenId  ← indexed 파라미터 (검색 가능)
Data:      reason   ← non-indexed (검색 불가, 데이터만 저장)
```

**`indexed`가 중요한 이유:**
```typescript
// indexed면 특정 주소로 필터링 가능
contract.queryFilter(
  contract.filters.Issued(userAddress)  // ← 특정 수신자만 조회
)

// non-indexed면 전체 스캔 필요
```

### 2-2. ABI의 역할 (10분)

**토킹포인트:**

> "ABI(Application Binary Interface)는 컨트랙트와 통신하기 위한 '설명서'입니다. 이 함수는 어떤 파라미터를 받고, 이 이벤트는 어떤 필드를 가지는지 기술합니다. ethers.js가 ABI를 기반으로 raw 바이트를 사람이 읽을 수 있는 형태로 변환합니다."

```typescript
// ABI 없으면:
Log { data: "0x000000000000000000000000..." }  // 해독 불가

// ABI 있으면:
{ to: "0xabc...", tokenId: 1n, reason: "0x..." }  // 파싱 완료
```

---

## 실습 1: 로컬 노드 배포 + 이벤트 실시간 수신 (00:55~01:50)

### Step 1 — 컨트랙트 배포 (15분)

터미널 1 (노드 구동):
```bash
docker compose -f infrastructure/docker/docker-compose.yml up hardhat-node
```

터미널 2 (배포):
```bash
cd packages/contracts
npm install
npx hardhat run scripts/deploy/deploy-phase1.ts --network localhost
```

출력 예시:
```
ActivityOracle: 0x5FbDB2315678afecb367f032d93F642f64180aa3
KyoboNFT:      0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
NFTIssuer:     0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
ISSUER_ROLE granted to NFTIssuer
→ .env에 위 주소 기록 후 issuer-service 재시작
```

`.env`에 기록:
```
NFT_CONTRACT_ADDR=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
NFT_ISSUER_ADDR=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
```

### Step 2 — 이벤트 리스너 작성 + 실행 (20분)

터미널 3 (수강자가 직접 작성):
```typescript
// scripts/listen-events.ts
import { EVMAdapter } from '../packages/chain-adapters/src/evm/EVMAdapter';
import * as dotenv from 'dotenv';
dotenv.config();

// ABI는 배포 후 생성된 artifacts에서 가져옴
const ABI = [
  "event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason)"
];

async function main() {
  const adapter = new EVMAdapter({
    rpcUrl:  'http://localhost:8545',
    chainId: '31337',
  });

  const currentBlock = await adapter.getBlockNumber();
  console.log('현재 블록:', currentBlock, '— 이벤트 리스닝 시작');

  const unsubscribe = await adapter.subscribeEvents(
    process.env.NFT_CONTRACT_ADDR!,
    ABI,
    ['Issued'],
    currentBlock,
    async (event) => {
      console.log('\n[이벤트 수신!]');
      console.log('  txHash:     ', event.txHash);
      console.log('  blockNumber:', event.blockNumber);
      console.log('  수신자:     ', event.args.to);
      console.log('  tokenId:    ', event.args.tokenId);
      console.log('  발행 시각:  ', new Date().toISOString());
    },
  );

  // 60초 후 구독 해제
  setTimeout(() => { unsubscribe(); process.exit(0); }, 60000);
}

main();
```

```bash
npx ts-node scripts/listen-events.ts
# → "현재 블록: 5 — 이벤트 리스닝 시작"
# → 대기 중...
```

### Step 3 — NFT 발행 트랜잭션 실행 (15분)

터미널 4 (발행):
```typescript
// scripts/test-issue.ts
import { ethers } from 'hardhat';

async function main() {
  const [deployer, oracleSigner] = await ethers.getSigners();

  const dataType  = ethers.keccak256(ethers.toUtf8Bytes('ACTIVITY'));
  const value     = 10000n;
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  const hash = ethers.solidityPackedKeccak256(
    ['bytes32', 'uint256', 'uint256'],
    [dataType, value, timestamp],
  );
  const signature = await oracleSigner.signMessage(ethers.getBytes(hash));

  const issuer = await ethers.getContractAt(
    'NFTIssuer', process.env.NFT_ISSUER_ADDR!
  );

  console.log('NFT 발행 중...');
  const tx = await issuer.issueActivityNFT(
    deployer.address,
    ethers.keccak256(ethers.toUtf8Bytes(`activity-${Date.now()}`)),
    { dataType, value, timestamp, signature },
  );

  await tx.wait();
  console.log('발행 완료! txHash:', tx.hash);
}

main();
```

```bash
npx hardhat run scripts/test-issue.ts --network localhost
```

**터미널 3에서 이벤트 출력 확인:**
```
[이벤트 수신!]
  txHash:      0x...
  blockNumber: 6
  수신자:      0xf39Fd6e51...
  tokenId:     0n
  발행 시각:   2026-04-21T...
```

---

## 3부: ChainEventListener 내부 구조 (01:50~02:20)

### 3-1. Missed Event 복구 로직 (20분)

**토킹포인트:**

> "실제 운영 환경에서 issuer-service가 재시작될 수 있습니다. 재시작 중에 NFT가 발행됐다면? 이벤트를 놓치면 Core Banking에 알림이 안 가고, 고객은 NFT를 받았는데 포인트 시스템엔 없는 상태가 됩니다."

```bash
cat packages/event-engine/src/listener/ChainEventListener.ts
```

핵심 로직 설명:
```typescript
async start(): Promise<void> {
  const fromBlock  = await this.stateStore.getLastProcessedBlock();  // DB에서 조회
  const curBlock   = await this.adapter.getBlockNumber();

  // 재시작 구간의 이벤트 먼저 처리
  if (fromBlock < curBlock) {
    await this._recoverMissedEvents(fromBlock, curBlock);  // ← 여기
  }

  // 그 이후 실시간 구독
  await this.adapter.subscribeEvents(...);
}
```

> "`stateStore`가 중요합니다. 마지막으로 처리한 블록 번호를 DB에 저장합니다. 재시작 시 이 번호부터 스캔합니다. 메모리에 저장하면 재시작 시 사라지기 때문에 반드시 영속 저장소여야 합니다."

### 3-2. 청크 스캔 (10분)

```typescript
private async _recoverMissedEvents(from: number, to: number): Promise<void> {
  const CHUNK = 1000;  // 한 번에 1000블록씩
  // ...
  while (start < to) {
    const end = Math.min(start + CHUNK, to);
    // ...
  }
}
```

**왜 청크를 나누는가:**
> "한 번에 100만 블록을 요청하면 노드가 응답하지 않습니다. 노드마다 최대 블록 범위 제한이 있습니다. 1,000블록씩 나눠 요청합니다."

---

## 실습 2: Missed Event 복구 시나리오 (02:20~02:55)

### Step 1 — 리스너 종료 (5분)
터미널 3 종료 (Ctrl+C)

### Step 2 — 리스너 꺼진 상태에서 NFT 3개 발행 (10분)
```bash
# 3번 실행
npx hardhat run scripts/test-issue.ts --network localhost
npx hardhat run scripts/test-issue.ts --network localhost
npx hardhat run scripts/test-issue.ts --network localhost
```

### Step 3 — Missed Event 복구 스크립트 작성 (20분)

```typescript
// scripts/recover-events.ts
import { EVMAdapter } from '../packages/chain-adapters/src/evm/EVMAdapter';

const ABI = [
  "event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason)"
];

async function main() {
  const adapter = new EVMAdapter({
    rpcUrl:  'http://localhost:8545',
    chainId: '31337',
  });

  const lastProcessedBlock = 5;  // 리스너를 껐던 블록 (실습에서 직접 확인)
  const currentBlock       = await adapter.getBlockNumber();

  console.log(`블록 ${lastProcessedBlock} ~ ${currentBlock} 스캔 중...`);

  const missed = await adapter.queryEvents(
    process.env.NFT_CONTRACT_ADDR!,
    ABI,
    'Issued',
    lastProcessedBlock,
    currentBlock,
  );

  console.log(`놓친 이벤트 ${missed.length}개 발견:`);
  missed.forEach((event, i) => {
    console.log(`  [${i + 1}] txHash: ${event.txHash}, tokenId: ${event.args.tokenId}`);
  });
}

main();
```

**예상 출력:**
```
블록 5 ~ 9 스캔 중...
놓친 이벤트 3개 발견:
  [1] txHash: 0x..., tokenId: 1n
  [2] txHash: 0x..., tokenId: 2n
  [3] txHash: 0x..., tokenId: 3n
```

---

## 마무리 (02:55~03:00)

**오늘의 핵심 3줄:**
1. 블록체인은 push가 없다 — WebSocket 구독으로 실시간 수신, queryEvents로 복구
2. 이벤트 `indexed` 필드는 검색 가능한 키, non-indexed는 데이터만
3. 마지막 처리 블록을 DB에 저장하지 않으면 재시작 시 이벤트 유실

**Day 04 예고:**  
이벤트를 잡았다. Core Banking에 전달할 때 HMAC 서명, 멱등성, 재시도를 직접 구현한다.

---

## 참조 파일

- `packages/contracts/src/phase1/KyoboNFT.sol` (Issued 이벤트)
- `packages/chain-adapters/src/evm/EVMAdapter.ts`
- `packages/event-engine/src/listener/ChainEventListener.ts`
- `docs/adr/004-event-driven-architecture.md`
