# Day 07 — 테스트넷 배포 & 운용 모니터링

**시간**: 3시간  
**핵심 질문**: 로컬에서 동작하는 것을 실제 네트워크에 배포하면 무엇이 달라지는가?

---

## 목표

테스트넷 배포는 "실습 완료"가 아니라 **운용의 시작**이다.  
배포 후 트랜잭션을 추적하고, 이상 상황에 대응하고, 비상 정지를 실행한다.

---

## 실습 시나리오

### 실습 1 — Polygon Amoy 테스트넷 배포 (50분)

```bash
# 테스트넷 MATIC 받기 (Polygon Amoy Faucet)
# https://faucet.polygon.technology/

# .env에 테스트넷 설정
AMOY_RPC_URL=https://rpc-amoy.polygon.technology
DEPLOYER_PRIVATE_KEY=[테스트용 키]

# 배포 실행
cd packages/contracts
npx hardhat run scripts/deploy/deploy-phase1.ts --network polygon_amoy
```

출력된 컨트랙트 주소를 Polygonscan Amoy에서 확인:
- `https://amoy.polygonscan.com/address/[NFT_CONTRACT_ADDR]`
- 컨트랙트 코드가 Verify되어 있는가?
- ABI가 공개되어 있는가? (교보 내부 시스템에서 이를 어떻게 다룰 것인가?)

### 실습 2 — 테스트넷 NFT 발행 + 트랜잭션 추적 (50분)

```bash
npx hardhat run scripts/issue-nft.ts --network polygon_amoy
```

Polygonscan에서 트랜잭션을 열고 확인한다:

| 확인 항목 | 찾는 위치 | 의미 |
|---|---|---|
| Gas Used | Transaction Details | 이 발행에 얼마나 비용이 들었는가? |
| Logs | Event Logs 탭 | `Issued` 이벤트의 파라미터가 인코딩된 형태 |
| Input Data | 하단 | `issueActivityNFT` 호출 파라미터 |
| Block Confirmations | 상단 | 현재 몇 번 확인되었는가? |

**질문:** 몇 번의 block confirmation이 쌓여야 `ChainEventListener`가 이 이벤트를 최종 처리해도 안전한가?  
*(힌트: Polygon의 reorg 가능성)*

### 실습 3 — 비상 정지 (Pause) 시나리오 (40분)

> 시나리오: 오라클 서명 키 유출 의심. 즉시 모든 NFT 발행을 중단해야 한다.

```typescript
// pause 실행
const nft = await ethers.getContractAt('KyoboNFT', NFT_CONTRACT_ADDR);
await nft.pause();

// pause 상태에서 발행 시도 → revert 확인
await issuer.issueActivityNFT(to, activityId, oracleData);
// → revert: "Pausable: paused"
```

pause 후 대응 절차를 문서로 작성한다:
1. 오라클 서명 키 교체 (`updateSigner()`)
2. 새 키로 ActivityOracle 업데이트
3. `unpause()` 실행
4. 유출 기간 발행 내역 감사

---

## 참조 파일

- `packages/contracts/scripts/deploy/deploy-phase1.ts`
- `packages/contracts/src/base/BaseToken.sol` (pause/unpause)
- `packages/chain-adapters/src/evm/EVMAdapter.ts` (getReceipt)
