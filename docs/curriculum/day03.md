# Day 03 — 온체인 이벤트를 오프체인으로 잡는 법

**시간**: 3시간  
**핵심 질문**: 블록체인은 push가 없다. 그러면 Core Banking은 NFT 발행 완료를 어떻게 아는가?

---

## 목표

이벤트 드리븐 아키텍처를 이론이 아닌 **실제 이벤트를 눈으로 보면서** 이해한다.  
로컬 노드에서 트랜잭션을 발생시키고, `ChainEventListener`가 이를 실시간으로 잡는 과정을 직접 확인한다.

---

## 배경 개념 (15분)

폴링 vs 이벤트 구독:

```
폴링: "발행됐어?" → "아니" → "발행됐어?" → "아니" → "발행됐어?" → "응"
구독: [이벤트 발생] → "발행됐어!" (push)
```

EVM에서 이벤트 = 트랜잭션 실행 시 발생하는 Log.  
`KyoboNFT.sol`의 `emit Issued(...)` 줄이 이 Log를 만든다.

---

## 실습 시나리오

### 실습 1 — 이벤트 구조 분석 (30분)

```bash
cat packages/contracts/src/phase1/KyoboNFT.sol
```

`Issued` 이벤트의 파라미터 3개를 찾고 답한다:
1. `to` — 왜 `indexed`가 붙어 있는가? (indexed vs non-indexed 차이)
2. `tokenId` — 컨트랙트에서 이 값은 어떻게 결정되는가?
3. `reason` — `bytes32` 타입인 이유는? (`string`과의 차이)

### 실습 2 — 로컬 노드에서 이벤트 발생 → 수신 확인 (60분)

터미널 1: 로컬 노드 실행
```bash
docker compose -f infrastructure/docker/docker-compose.yml up hardhat-node
```

터미널 2: 컨트랙트 배포
```bash
cd packages/contracts
npx hardhat run scripts/deploy/deploy-phase1.ts --network localhost
# 출력된 NFT_CONTRACT_ADDR, NFT_ISSUER_ADDR를 .env에 기록
```

터미널 3: 이벤트 리스너 실행 (직접 작성)
```typescript
// scripts/listen-events.ts 파일을 직접 작성
import { EVMAdapter } from '../packages/chain-adapters/src/evm/EVMAdapter';
import KYOBO_NFT_ABI from '../packages/contracts/artifacts/src/phase1/KyoboNFT.sol/KyoboNFT.json';

const adapter = new EVMAdapter({ rpcUrl: 'http://localhost:8545', chainId: '31337' });

const unsubscribe = await adapter.subscribeEvents(
  process.env.NFT_CONTRACT_ADDR!,
  KYOBO_NFT_ABI.abi,
  ['Issued'],
  await adapter.getBlockNumber(),
  async (event) => {
    console.log('[이벤트 수신]', JSON.stringify(event, null, 2));
  },
);

console.log('이벤트 리스닝 중...');
```

터미널 4: NFT 발행 트랜잭션 실행 (Hardhat task)
```bash
npx hardhat run scripts/test-issue.ts --network localhost
```

**확인 포인트:** 터미널 3에서 이벤트가 출력되는가?

### 실습 3 — Missed Event 복구 시나리오 (40분)

1. 이벤트 리스너를 **종료**한다
2. NFT 3개를 추가 발행한다
3. 리스너를 **재시작**하고 `queryEvents()`로 놓친 이벤트를 복구한다

```typescript
// queryEvents 직접 호출
const missed = await adapter.queryEvents(
  process.env.NFT_CONTRACT_ADDR!,
  KYOBO_NFT_ABI.abi,
  'Issued',
  lastProcessedBlock,
  await adapter.getBlockNumber(),
);
console.log(`놓친 이벤트 ${missed.length}개 복구:`, missed);
```

**질문:** 서비스가 재시작될 때 `lastProcessedBlock`을 어디에 저장해야 하는가?  
메모리? DB? 왜?

---

## 참조 파일

- `packages/contracts/src/phase1/KyoboNFT.sol` (Issued 이벤트)
- `packages/chain-adapters/src/evm/EVMAdapter.ts` (subscribeEvents, queryEvents)
- `packages/event-engine/src/listener/ChainEventListener.ts`
- `docs/adr/004-event-driven-architecture.md`
