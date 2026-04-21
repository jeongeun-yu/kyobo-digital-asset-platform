# Day 06 — NFT 컨트랙트 실제 발행 실습

**시간**: 3시간 (180분)  
**핵심 질문**: 교보생명 고객이 걷기 목표를 달성했다. 온체인에서 정확히 무슨 일이 일어나는가?

---

## 세션 구조

| 시간 | 내용 |
|---|---|
| 00:00~00:30 | 1부: 발행 흐름 전체 조망 |
| 00:30~01:00 | 실습 1: NFTIssuer 코드 리딩 + 흐름 추적 |
| 01:00~01:50 | 실습 2: 오라클 서명 생성 + 실제 발행 실행 |
| 01:50~02:20 | 2부: IssuerService 레이어 — 오프체인 검증 흐름 |
| 02:20~02:55 | 실습 3: 예외 시나리오 처리 |
| 02:55~03:00 | 마무리 |

---

## 1부: 발행 흐름 전체 조망 (00:00~00:30)

### 1-1. 두 가지 발행 경로 (15분)

**토킹포인트:**

> "NFT 발행에는 두 가지 경로가 있습니다. 온체인 경로와 오프체인 검증 후 온체인 경로입니다. 이 프로젝트는 두 번째 방식을 씁니다."

**경로 A — 온체인 자동화:**
```
고객이 직접 컨트랙트 호출 → 컨트랙트가 오라클 검증 → NFT 발행
장점: 완전히 탈중앙화
단점: 교보 앱 서버와 연동 없음, gas를 고객이 부담
```

**경로 B — 오프체인 게이트웨이 (이 프로젝트):**
```
교보 앱 서버 → Webhook → issuer-service
  → KYC 확인 (Core Banking)
  → AML 스크리닝 (VASP)
  → NFTIssuer.issueActivityNFT() 호출 (오라클 서명 포함)
    → ActivityOracle 서명 검증
    → KyboNFT.issue()
    → Issued 이벤트 발생
  → ChainEventListener 수신
  → Core Banking 알림
```

> "교보생명이 발행 게이트웨이를 통제합니다. KYC 미완료 사용자, AML 블랙리스트 주소는 컨트랙트에 도달하기 전에 차단됩니다."

### 1-2. ActivityOracle의 역할 (15분)

**토킹포인트:**

> "스마트컨트랙트는 외부 데이터를 직접 읽을 수 없습니다. '이 사람이 오늘 10,000보를 걸었다'는 데이터는 교보 헬스앱 서버에 있습니다. 이걸 온체인으로 가져오는 브릿지가 Oracle입니다."

**신뢰 모델:**
```
교보 백엔드 서버 (오라클 서명 키 보유)
  → 걷기 달성 데이터를 ECDSA 서명
  → 서명 데이터를 issuer-service에 전달
  → issuer-service가 NFTIssuer 호출 시 서명 포함
  → ActivityOracle이 서명 검증 (교보 키로 서명됐는지 확인)
  → 검증 통과 시 NFT 발행
```

> "서명 검증의 핵심: 교보 키로 서명된 데이터만 유효합니다. 공격자가 가짜 걷기 데이터를 만들어도 교보 키 없이는 서명이 불가능합니다."

---

## 실습 1: NFTIssuer 코드 리딩 + 흐름 추적 (00:30~01:00)

```bash
cat packages/contracts/src/phase1/NFTIssuer.sol
```

### Step 1 — issueActivityNFT() 실행 순서 채우기 (20분)

아래 흐름도의 빈칸을 직접 채운다:

```
issueActivityNFT(to, activityId, oracleData)
  → (1) require(!issued[activityId], ...) : ___________________
  → (2) require(oracle.verify(oracleData), ...) : ___________________
  → (3) require(oracleData.value >= 1, ...) : ___________________
  → (4) issued[activityId] = true : ___________________
  → (5) string memory uri = ... : ___________________
  → (6) nft.issue(to, uri, ACTIVITY, activityId) : ___________________
         → emit Issued(to, tokenId, activityId)
```

**답 해설 (강사):**
1. 중복 발행 방지 체크
2. 오라클 서명 유효성 검증
3. 실제로 달성했는지 확인 (value >= 1)
4. 상태 먼저 변경 (reentrancy 방지)
5. 메타데이터 URI 생성
6. 실제 NFT 민팅

### Step 2 — 왜 `issued[activityId] = true`가 nft.issue() 전에 오는가 (10분)

**토킹포인트:**

> "순서를 바꿔서 nft.issue() 먼저 실행하면 어떻게 될까요? nft.issue()가 외부 컨트랙트를 호출합니다. 그 컨트랙트가 다시 issueActivityNFT()를 호출하는 공격이 가능합니다. 이를 reentrancy 공격이라 합니다. 상태를 먼저 변경하면 두 번째 호출 시 already issued로 차단됩니다."

---

## 실습 2: 오라클 서명 생성 + 실제 발행 실행 (01:00~01:50)

### Step 1 — ActivityOracle 서명 생성 이해 (20분)

```bash
cat packages/contracts/src/phase1/ActivityOracle.sol
# verify() 함수 집중
```

```solidity
function verify(OracleData calldata data) public view override returns (bool) {
    bytes32 hash = keccak256(abi.encodePacked(
        data.dataType, data.value, data.timestamp
    ));
    bytes32 ethHash = keccak256(abi.encodePacked(
        "\x19Ethereum Signed Message:\n32", hash
    ));
    (uint8 v, bytes32 r, bytes32 s) = _splitSignature(data.signature);
    address recovered = ecrecover(ethHash, v, r, s);
    return recovered == trustedSigner;
}
```

**토킹포인트:**

> "`ecrecover`는 서명에서 서명자 주소를 복원합니다. 복원된 주소가 `trustedSigner`(교보 백엔드 키)와 같으면 유효한 서명입니다. 서명 없이 발행하려면 교보 키가 필요합니다."

### Step 2 — 전체 발행 실행 (30분)

```typescript
// scripts/issue-nft-full.ts
import { ethers } from 'hardhat';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  // Hardhat 로컬 환경에서는 index 0 = admin, index 1 = oracle signer
  const [admin, oracleSigner, recipient] = await ethers.getSigners();

  console.log('=== NFT 발행 전체 흐름 ===\n');
  console.log('[1단계] 오라클 데이터 준비');
  const dataType  = ethers.keccak256(ethers.toUtf8Bytes('ACTIVITY'));
  const value     = 10000n;  // 걷기 10,000보
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  console.log('  dataType:', dataType);
  console.log('  value (보):', value.toString());
  console.log('  timestamp:', new Date(Number(timestamp) * 1000).toISOString());

  console.log('\n[2단계] 오라클 서명 생성 (교보 백엔드 서버 역할)');
  const hash = ethers.solidityPackedKeccak256(
    ['bytes32', 'uint256', 'uint256'],
    [dataType, value, timestamp],
  );
  const signature = await oracleSigner.signMessage(ethers.getBytes(hash));
  console.log('  서명자:', oracleSigner.address);
  console.log('  서명:', signature.slice(0, 20) + '...');

  console.log('\n[3단계] NFTIssuer.issueActivityNFT() 호출');
  const activityId = ethers.keccak256(
    ethers.toUtf8Bytes(`activity-walk-${Date.now()}-${recipient.address}`)
  );

  const issuer = await ethers.getContractAt(
    'NFTIssuer', process.env.NFT_ISSUER_ADDR!
  );

  const tx = await issuer.issueActivityNFT(
    recipient.address,
    activityId,
    { dataType, value, timestamp, signature },
  );

  console.log('  트랜잭션 전송:', tx.hash);
  const receipt = await tx.wait();
  console.log('  블록 확인:', receipt!.blockNumber);
  console.log('  Gas 사용량:', receipt!.gasUsed.toString());

  console.log('\n[4단계] 발행 결과 확인');
  const nft     = await ethers.getContractAt('KyoboNFT', process.env.NFT_CONTRACT_ADDR!);
  const balance = await nft.balanceOf(recipient.address);
  const tokenId = balance - 1n;  // 마지막 발행된 tokenId
  const meta    = await nft.tokenMeta(tokenId);

  console.log('  수신자 NFT 잔액:', balance.toString());
  console.log('  tokenId:', tokenId.toString());
  console.log('  rewardType:', meta.rewardType.toString(), '(0=ACTIVITY)');
  console.log('  발행 시각:', new Date(Number(meta.issuedAt) * 1000).toISOString());

  console.log('\n=== 발행 완료 ===');
}

main().catch(console.error);
```

```bash
npx hardhat run scripts/issue-nft-full.ts --network localhost
```

**전체 출력 확인 후 토론:**
- Gas 사용량이 얼마인가? 100만건 발행 시 예상 비용은?
- `activityId`에 `recipient.address`가 포함된 이유는?

---

## 2부: IssuerService 오프체인 검증 흐름 (01:50~02:20)

```bash
cat apps/issuer-service/src/services/IssuerService.ts
```

**토킹포인트:**

> "컨트랙트에 도달하기 전에 오프체인에서 두 가지 검증을 합니다. KYC와 AML입니다. 둘 다 실패하면 트랜잭션 자체를 보내지 않습니다. Gas 낭비도 없고, 블록체인에 실패 트랜잭션 기록도 남지 않습니다."

**검증 레이어별 역할:**

| 단계 | 위치 | 검증 내용 | 실패 시 |
|---|---|---|---|
| KYC | Core Banking API | 실명 확인 완료 여부 | 발행 중단, 로그 기록 |
| AML | VASP API | 블랙리스트 주소 | 발행 중단, 알람 |
| 오라클 서명 | ActivityOracle | 교보 키 서명 유효성 | revert |
| 중복 방지 | NFTIssuer mapping | activityId 재사용 | revert |
| Compliance | KyoboNFT._update | 전송 가능 여부 | revert |

---

## 실습 3: 예외 시나리오 처리 (02:20~02:55)

### 시나리오 A — 동일 activityId 재발행 시도 (10분)

```typescript
// 같은 activityId로 두 번 호출
const activityId = ethers.keccak256(ethers.toUtf8Bytes('duplicate-test'));

await issuer.issueActivityNFT(recipient.address, activityId, oracleData);
console.log('첫 번째 발행: 성공');

try {
  await issuer.issueActivityNFT(recipient.address, activityId, oracleData);
} catch (err: unknown) {
  console.log('두 번째 발행 차단:', (err as Error).message.includes('already issued'));
}
```

### 시나리오 B — 잘못된 오라클 서명 (10분)

```typescript
const fakeSignature = '0x' + 'aa'.repeat(65);
try {
  await issuer.issueActivityNFT(
    recipient.address, activityId,
    { dataType, value, timestamp, signature: fakeSignature }
  );
} catch (err: unknown) {
  console.log('서명 검증 실패:', (err as Error).message.includes('invalid oracle data'));
}
```

### 시나리오 C — Pause 상태에서 발행 시도 (15분)

```typescript
const nft = await ethers.getContractAt('KyoboNFT', process.env.NFT_CONTRACT_ADDR!);

// pause 실행
await nft.connect(admin).pause();
console.log('컨트랙트 일시정지됨');

try {
  await issuer.issueActivityNFT(recipient.address, newActivityId, oracleData);
} catch (err: unknown) {
  console.log('pause 중 발행 차단:', (err as Error).message.includes('paused'));
}

// unpause 후 재시도
await nft.connect(admin).unpause();
await issuer.issueActivityNFT(recipient.address, newActivityId, oracleData);
console.log('unpause 후 발행: 성공');
```

---

## 마무리

**오늘의 핵심 3줄:**
1. 발행은 오프체인(KYC/AML)과 온체인(오라클/중복) 이중 검증을 거친다
2. 상태 변경(issued=true)은 외부 호출(nft.issue) 전에 해야 reentrancy를 막는다
3. 예외 상황(중복, 위조 서명, pause)은 모두 코드로 검증되어 revert 된다

**Day 07 예고:**  
테스트넷에 실제 배포한다. Polygonscan에서 내가 배포한 컨트랙트를 직접 확인한다.

---

## 참조 파일

- `packages/contracts/src/phase1/NFTIssuer.sol`
- `packages/contracts/src/phase1/KyoboNFT.sol`
- `packages/contracts/src/phase1/ActivityOracle.sol`
- `apps/issuer-service/src/services/IssuerService.ts`
