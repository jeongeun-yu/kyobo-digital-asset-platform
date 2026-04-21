# Day 06 — NFT 컨트랙트 실제 발행 실습

**시간**: 3시간  
**핵심 질문**: 교보생명 고객이 걷기 목표를 달성했다. 온체인에서 정확히 무슨 일이 일어나는가?

---

## 목표

NFT 발행의 전체 흐름을 코드 레벨에서 추적한다.  
`IssuerService` → `NFTIssuer` → `KyoboNFT` → 이벤트 발생.  
각 단계에서 무엇이 검증되고 무엇이 기록되는지 직접 확인한다.

---

## 실습 시나리오

### 실습 1 — NFTIssuer.sol 발행 흐름 코드 리딩 (40분)

```bash
cat packages/contracts/src/phase1/NFTIssuer.sol
```

`issueActivityNFT()` 함수를 읽고 실행 순서를 직접 그린다:

```
issueActivityNFT(to, activityId, oracleData)
  → (1) ___________________________
  → (2) ___________________________
  → (3) ___________________________
  → (4) nft.issue(to, uri, ACTIVITY, activityId)
         → (5) ___________________________
         → (6) ___________________________
         → emit Issued(to, tokenId, activityId)
```

**질문:**
- `issued[activityId] = true`가 `nft.issue()` 호출 **전**에 있어야 하는 이유는?  
  *(힌트: reentrancy)*
- `_bytes32ToString(activityId)`의 역할은? URI에 왜 포함되는가?

### 실습 2 — ActivityOracle 서명 생성 + 발행 실행 (70분)

오라클 서명을 직접 생성하고 발행을 실행한다:

```typescript
// scripts/issue-nft.ts
import { ethers } from 'hardhat';

async function main() {
  const [deployer, oracleSigner] = await ethers.getSigners();

  // 오라클 데이터 서명 (교보 백엔드 서버 역할)
  const dataType  = ethers.keccak256(ethers.toUtf8Bytes('ACTIVITY'));
  const value     = 10000n;  // 걷기 10,000보 달성
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  const hash = ethers.solidityPackedKeccak256(
    ['bytes32', 'uint256', 'uint256'],
    [dataType, value, timestamp],
  );
  const signature = await oracleSigner.signMessage(ethers.getBytes(hash));

  // NFTIssuer 호출
  const issuer = await ethers.getContractAt('NFTIssuer', process.env.NFT_ISSUER_ADDR!);
  const tx = await issuer.issueActivityNFT(
    deployer.address,
    ethers.keccak256(ethers.toUtf8Bytes('activity-2026-04-21-user-001')),
    { dataType, value, timestamp, signature },
  );

  const receipt = await tx.wait();
  console.log('발행 완료:', receipt.hash);
}

main();
```

발행 후 확인:
```typescript
// NFT 소유 확인
const nft = await ethers.getContractAt('KyoboNFT', process.env.NFT_CONTRACT_ADDR!);
const balance = await nft.balanceOf(deployer.address);
console.log('NFT 잔액:', balance.toString());  // → 1

const meta = await nft.tokenMeta(0);
console.log('발행 시각:', new Date(Number(meta.issuedAt) * 1000));
console.log('활동 ID:', meta.activityId);
```

### 실습 3 — 중복 발행 시도 + AML 차단 시나리오 (30분)

**시나리오 A — 동일 activityId 재발행:**
```typescript
// 동일 activityId로 두 번 호출 → 두 번째는 revert
await issuer.issueActivityNFT(to, activityId, oracleData);  // 성공
await issuer.issueActivityNFT(to, activityId, oracleData);  // → revert: "already issued"
```

**시나리오 B — 잘못된 오라클 서명:**
```typescript
const fakeSignature = '0x' + 'ff'.repeat(65);
// → revert: "invalid oracle data"
```

---

## 참조 파일

- `packages/contracts/src/phase1/NFTIssuer.sol`
- `packages/contracts/src/phase1/KyoboNFT.sol`
- `packages/contracts/src/phase1/ActivityOracle.sol`
- `apps/issuer-service/src/services/IssuerService.ts`
