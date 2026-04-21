# Day 05 — 스마트컨트랙트 실행 모델 해부

**시간**: 3시간 (180분)  
**핵심 질문**: 금융사가 스마트컨트랙트를 운용하기 전에 반드시 이해해야 할 것들은 무엇인가?

---

## 세션 구조

| 시간 | 내용 |
|---|---|
| 00:00~00:40 | 1부: 배포된 코드는 수정 불가 — 이 무게를 이해하라 |
| 00:40~01:20 | 실습 1: BaseToken RBAC 구조 분석 |
| 01:20~01:55 | 2부: 전송 제어 흐름 + Compliance 훅 |
| 01:55~02:40 | 실습 2: 취약점 시나리오 분석 |
| 02:40~03:00 | 3부: Gas, Storage, Upgrade 패턴 개요 |

---

## 1부: 배포된 코드는 수정 불가 (00:00~00:40)

### 1-1. 스마트컨트랙트의 불변성이 금융에서 의미하는 것 (20분)

**토킹포인트:**

> "일반 소프트웨어는 버그를 발견하면 패치하고 재배포합니다. 스마트컨트랙트는 다릅니다. 한 번 배포하면 그 주소의 코드는 영원히 바뀌지 않습니다. 교보생명이 KyoboNFT.sol을 배포했는데 한 달 후 중요한 버그를 발견했다면?"

**세 가지 결과:**
1. **새 컨트랙트 배포**: 주소가 바뀜 → 모든 연동 시스템이 새 주소로 업데이트해야 함
2. **Proxy 패턴**: 로직만 교체, 주소 유지 → 복잡도 증가, Phase 2+에서 도입
3. **처음부터 잘 짜기**: 오늘 배우는 것

> "그래서 스마트컨트랙트 코드 리뷰는 일반 코드 리뷰와 다릅니다. '나중에 고치면 되지'가 없습니다. 오늘 실습에서 취약점을 찾아보는 이유입니다."

### 1-2. 이 프로젝트 컨트랙트 구조 전체 조망 (20분)

```bash
ls packages/contracts/src/
```

```
interfaces/
├── IToken.sol       ← 모든 토큰의 공통 계약
├── ICompliance.sol  ← 규제 준수 훅
└── IOracle.sol      ← 오프체인 데이터 브릿지

base/
└── BaseToken.sol    ← 공통 기반 (RBAC + Pause)

phase1/
├── KyoboNFT.sol     ← ERC-721 구현
├── NFTIssuer.sol    ← 발행 게이트웨이
└── ActivityOracle.sol ← 오라클

phase2/, phase3/     ← stub
```

**토킹포인트:**

> "인터페이스 → 베이스 → 구현체 구조입니다. `KyoboNFT`는 `BaseToken`을 상속하고, `BaseToken`은 `IToken`을 구현합니다. Phase 2 `KRWStablecoin`도 `BaseToken`을 상속합니다. 즉, RBAC와 Pause 기능은 모든 토큰에 공통으로 들어갑니다."

---

## 실습 1: BaseToken RBAC 구조 분석 (00:40~01:20)

### Step 1 — BaseToken.sol 정독 (20분)

```bash
cat packages/contracts/src/base/BaseToken.sol
```

4개 Role을 찾아 아래 표를 채운다:

| Role | 할 수 있는 것 | 이 키를 잃으면? | 이 키가 탈취되면? |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Role 부여/회수 | Role 관리 불가 | 공격자가 모든 Role 탈취 |
| `ISSUER_ROLE` | NFT 발행 | 발행 불가 | 무제한 발행 가능 |
| `REVOKER_ROLE` | NFT 회수 | 이상 NFT 회수 불가 | 모든 NFT 소각 가능 |
| `PAUSER_ROLE` | pause/unpause | 비상 정지 불가 | 서비스 강제 중단 가능 |

**토론:**
- `PAUSER_ROLE` 키는 누가 가져야 하는가?
  - 담당자 개인 지갑? → 담당자 퇴사 시 문제
  - 멀티시그(M-of-N)? → Phase 2+에서 도입 권장
  - 24시간 비상 연락 가능한 계정이어야 함

### Step 2 — Role 부여/회수 시뮬레이션 (20분)

```typescript
// scripts/test-rbac.ts
import { ethers } from 'hardhat';

async function main() {
  const [admin, issuer, attacker] = await ethers.getSigners();

  const nft = await ethers.getContractAt(
    'KyoboNFT', process.env.NFT_CONTRACT_ADDR!
  );

  const ISSUER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('ISSUER_ROLE'));

  // 1. issuer에게 ISSUER_ROLE 부여
  await nft.connect(admin).grantRole(ISSUER_ROLE, issuer.address);
  console.log('issuer 권한 부여됨');

  // 2. attacker가 발행 시도 (권한 없음)
  try {
    await nft.connect(attacker).issue(
      attacker.address, 'ipfs://test', 0,
      ethers.keccak256(ethers.toUtf8Bytes('fake-activity'))
    );
  } catch (err: unknown) {
    console.log('공격자 발행 차단:', (err as Error).message.slice(0, 60));
  }

  // 3. issuer가 발행 시도 (권한 있음) — NFTIssuer를 통해야 하므로 직접 호출은 불가
  // (NFTIssuer만 ISSUER_ROLE 보유 → 사용자가 직접 issue() 못 부름)
  console.log('NFTIssuer만 발행 권한 보유 — 사용자 직접 발행 차단됨');
}

main();
```

---

## 2부: 전송 제어 흐름 + Compliance 훅 (01:20~01:55)

### 2-1. KyoboNFT 전송 흐름 추적 (20분)

```bash
cat packages/contracts/src/phase1/KyoboNFT.sol
# _update() 함수 집중
```

**토킹포인트:**

> "ERC-721에서 모든 토큰 이동 — 발행, 전송, 소각 — 은 `_update()` 를 거칩니다. `KyoboNFT`는 이 함수를 override해서 `_checkCompliance()`를 끼워 넣었습니다."

```
transferFrom(A, B, tokenId)
  ↓
_update(B, tokenId, A)  ← KyoboNFT override
  ↓
_checkCompliance(A, B, tokenId)
  ↓
compliance.canTransfer(A, B, tokenId)
  ↓ (Phase 1: 항상 true / Phase 3 STO: KYC 등록 여부 확인)
super._update(B, tokenId, A)  ← ERC-721 원본 실행
```

**Phase 3 STO에서의 변화:**
```typescript
// Phase 1 Compliance
function canTransfer(address, address, uint256) external pure returns (bool) {
  return true;  // 모두 허용
}

// Phase 3 STO Compliance
function canTransfer(address from, address to, uint256) external view returns (bool) {
  return kyc.isVerified(to) &&          // 수신자 KYC 완료
         !aml.isFlagged(to) &&           // AML 블랙리스트 아님
         holdings[to] + 1 <= maxHolding; // 보유 한도 미초과
}
```

> "`KyoboNFT` 코드는 건드리지 않습니다. `compliance` 주소만 교체합니다."

### 2-2. ICompliance 인터페이스 (15분)

```bash
cat packages/contracts/src/interfaces/ICompliance.sol
```

**토킹포인트:**

> "이 인터페이스가 금융 규제 변화에 대응하는 핵심입니다. 2025년에 STO 가이드라인이 바뀌면 `STOCompliance` 계약을 새로 배포하고 `updateCompliance(newAddr)` 한 번 호출하면 됩니다. 토큰 컨트랙트 재배포 없음."

---

## 실습 2: 취약점 시나리오 분석 (01:55~02:40)

각 취약 코드를 보여주고, 이 프로젝트에서 어떻게 막혀 있는지 찾는다.

### 케이스 1 — 권한 없는 발행 (10분)

**취약 코드:**
```solidity
function issue(address to) public {  // 누구나 호출 가능
    _safeMint(to, _nextTokenId++);
}
```

**이 프로젝트에서의 방어:**
```solidity
function issue(...) external onlyRole(ISSUER_ROLE) whenNotPaused {
```
→ `ISSUER_ROLE`이 없으면 revert. NFTIssuer 계약만 이 Role 보유.

### 케이스 2 — Reentrancy 공격 (15분)

**취약 코드:**
```solidity
function withdraw(uint amount) public {
    payable(msg.sender).call{value: amount}("");  // 외부 호출 → 콜백 가능
    balances[msg.sender] -= amount;               // 상태 변경 나중
}
```

**공격 시나리오:**
```
1. 공격자 컨트랙트가 withdraw() 호출
2. ETH 수신 시 자동으로 withdraw() 재호출 (콜백)
3. balances 감소 전에 또 출금 가능
4. 잔액보다 많이 출금
```

**이 프로젝트에서의 방어:**
```solidity
contract NFTIssuer is AccessControl, ReentrancyGuard {
  function issueActivityNFT(...) external nonReentrant {
    issued[activityId] = true;  // 상태 먼저 변경
    nft.issue(...);             // 외부 호출 나중
  }
}
```

### 케이스 3 — 중복 발행 (15분)

**취약 코드:**
```solidity
function issueActivityNFT(bytes32 activityId, ...) external {
    // activityId 중복 체크 없음
    nft.issue(to, ...);
}
```

**이 프로젝트에서의 방어:**
```solidity
require(!issued[activityId], "NFTIssuer: already issued");
issued[activityId] = true;
```

**온체인 + 오프체인 이중 방어:**
- 온체인: `issued` mapping
- 오프체인: `IdempotencyGuard`

---

## 3부: Gas, Storage, Upgrade 패턴 개요 (02:40~03:00)

### 3-1. Gas와 Storage의 비용 (10분)

**토킹포인트:**

> "스마트컨트랙트 실행은 공짜가 아닙니다. 연산과 저장에 Gas 비용이 발생합니다. `tokenMeta` mapping에 데이터를 저장할 때마다 비용이 듭니다. 운영 비용 추정을 위해 Gas 소비량을 알아야 합니다."

```
Storage (영구 저장) >> Memory (함수 실행 중) >> Stack
비용:  비쌈          보통                     저렴
```

### 3-2. Upgrade 패턴 예고 (10분)

**토킹포인트:**

> "Phase 2에서 KyoboNFT에 기능을 추가해야 한다면? 새 컨트랙트를 배포하면 주소가 바뀝니다. 모든 연동 시스템을 업데이트해야 합니다. 이를 피하는 방법이 Proxy 패턴입니다. `ERC-1967 Transparent Proxy` 또는 `UUPS`를 Phase 2에서 도입합니다."

---

## 마무리

**오늘의 핵심 3줄:**
1. 배포된 컨트랙트는 수정 불가 — 처음부터 RBAC, Pause, Compliance 훅이 설계되어 있어야 한다
2. 컨트랙트 취약점은 재배포로 고칠 수 없다 — 코드 리뷰가 배포 전 마지막 방어선
3. Compliance는 교체 가능 — 규제 변화 대응이 재배포 없이 가능한 설계

**Day 06 예고:**  
실제로 오라클 서명을 생성하고 NFT 발행 트랜잭션을 실행한다. 전체 발행 흐름을 단계별로 추적한다.

---

## 참조 파일

- `packages/contracts/src/base/BaseToken.sol`
- `packages/contracts/src/phase1/KyoboNFT.sol`
- `packages/contracts/src/phase1/NFTIssuer.sol`
- `packages/contracts/src/interfaces/ICompliance.sol`
- `docs/adr/003-token-standard-evolution.md`
