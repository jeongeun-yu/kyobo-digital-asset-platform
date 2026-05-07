# Day 09 — M5 마무리 + M6 전반부: 대량 발행 + ERC-1155 컨트랙트 (S33~S36)

**세션**: S33~S36 | **모듈**: M5~M6 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: BulkIssueService + 1000건 테스트 + KyoboNFT.sol 기반구조(OZ 4종 + tokenId 인코딩 + UUPS)

---

## S33: 대량 NFT 발행 아키텍처 — 배치 분할과 부분 실패 처리 정책 설계 (강의 55분)

### 강의 (이론 세션 — 실습 없음)

**mintBatch 가스 한도 상세 분석:**
- EVM block gas limit ≈ 30M gas
- 건당 ≈ 50K gas × 500건 ≈ 25M
- 안전 여유 포함 → **500건/배치**

**청크 분할 설계:**
- 청크 크기 결정 기준: 블록 가스 한도 대비 여유
- 청크 내 일부 실패 시 재시도 단위: 실패 건만 (전체 재시도 금지)

**병렬 vs 순차 처리 트레이드오프:**
| 방식 | 장점 | 단점 |
|---|---|---|
| 병렬 | 빠름 | VASP Rate Limit 위험 |
| 순차 | 안전 | 느림 |

**부분 실패 허용 정책 결정 기준:**
- 전체 롤백: 일관성 강하지만 성공 건도 재처리
- 부분 커밋: 효율적이나 실패 건 추적 필수

**당사 케이스에서 부분 커밋이 맞는 이유:**
- 보험 이벤트는 사용자별 독립 건
- 한 사용자 지갑 미등록이 전체 배치 실패로 이어지면 안 됨

**실패 건 추적 설계:**
- 실패 목록 구조: `{ userId, reason }[]`
- 재시도 큐 연계: 실패 건 → DLQ or 별도 재시도 큐
- 운영자 알림 시점: 배치 완료 후 요약 알림

**진행률 업데이트 패턴:**
- SSE: 서버 push, 단방향
- Polling: 클라이언트가 주기적 조회
- WebSocket: 양방향, 오버킬

### ✅ 완료 기준 (강의 이해 확인)
- [ ] 500건/배치 근거 설명 가능
- [ ] 부분 실패 정책 판단 기준 설명 가능
- [ ] 실패 건 추적 구조 설계 가능

---

## S34: BulkIssueService 구현과 1000건 부분 실패 통합 테스트 (개요 10분 + 실습 50분)

### 개요 (10분)

배치 분할 알고리즘 재확인 + 부분 실패 정책 재확인

### 🔴 실습 (50분) — 수강생 직접 작성

**Step 1**: executeBulkIssue 구현
```typescript
// internal/packages/business/src/BulkIssueService.ts
// TODO: 500개씩 청크 분할 + 부분 실패 허용

interface BulkIssueResult {
  total: number;
  succeeded: number;
  failed: { userId: string; reason: string }[];
}

async executeBulkIssue(
  userIds: string[],
  tokenId: bigint,
): Promise<BulkIssueResult> {
  const CHUNK_SIZE = 500;
  const result: BulkIssueResult = { total: userIds.length, succeeded: 0, failed: [] };

  // TODO: userIds를 CHUNK_SIZE씩 청크로 분할
  for (let i = 0; i < userIds.length; i += CHUNK_SIZE) {
    const chunk = userIds.slice(i, i + CHUNK_SIZE);
    
    // TODO: 청크 내 각 사용자에 대해 단건 발행
    for (const userId of chunk) {
      try {
        // TODO: createNftRequest(userId, tokenId, 1)
        // TODO: result.succeeded++
      } catch (err) {
        // TODO: 실패 건 result.failed에 추가 (계속 진행)
      }
    }
    
    // TODO: 진행률 업데이트 (console.log 또는 이벤트)
  }

  return result;
}
```

**Step 2**: 1000건 테스트
```typescript
it('1000건 중 300건 WalletNotFound → 700건 성공, 300건 실패', async () => {
  // 1000명 사용자 준비
  const userIds = Array.from({ length: 1000 }, (_, i) => `user-${i}`);

  // 300명은 지갑 없음 (Mock: getWalletAddress throw WalletNotFoundError)
  const noWalletUsers = new Set(userIds.slice(0, 300));
  mockWalletService.setNoWalletUsers(noWalletUsers);

  // 나머지 700명은 지갑 있음 + VASP Mock 정상 응답
  const result = await bulkIssueService.executeBulkIssue(userIds, 2001n);

  // TODO: result.succeeded === 700 확인
  // TODO: result.failed.length === 300 확인
  // TODO: 각 실패 건의 reason이 'WalletNotFoundError' 포함 확인
});
```

### ✅ 답안

```typescript
// executeBulkIssue 완성
async executeBulkIssue(userIds: string[], tokenId: bigint): Promise<BulkIssueResult> {
  const CHUNK_SIZE = 500;
  const result: BulkIssueResult = { total: userIds.length, succeeded: 0, failed: [] };

  for (let i = 0; i < userIds.length; i += CHUNK_SIZE) {
    const chunk = userIds.slice(i, i + CHUNK_SIZE);
    
    for (const userId of chunk) {
      try {
        await this.nftIssuanceService.createNftRequest(userId, tokenId, 1);
        result.succeeded++;
      } catch (err) {
        result.failed.push({
          userId,
          reason: (err as Error).message,
        });
        // 다음 사용자로 계속 진행 (부분 실패 허용)
      }
    }
    
    console.log(`[BulkIssue] 진행: ${Math.min(i + CHUNK_SIZE, userIds.length)}/${userIds.length}`);
  }

  if (result.failed.length > 0) {
    console.error(`[BulkIssue] 실패 ${result.failed.length}건:`, result.failed.slice(0, 5));
  }

  return result;
}
```

### ✅ M5 완료 기준
- [ ] 1000건 중 부분 실패 → 실패 건만 목록 반환
- [ ] 이벤트 → 요청 → VASP E2E 동작

---

## S35: ERC-1155 다중 토큰 표준과 엔터프라이즈 tokenId 설계 (강의 25분 + 실습 30분)

### 강의

**ERC-721 vs ERC-1155:**
- ERC-721: NFT 1개 = 컨트랙트 1개의 tokenId
- ERC-1155: 1개 컨트랙트에 여러 종류 토큰 관리 + mintBatch 가스 절감

**ERC-1155 선택 근거:**
- 쿠폰/보상 종류별 관리 필요
- mintBatch로 다수 사용자 동시 발행 가스 절감

**tokenId 비트 인코딩 설계:**
```
tokenId (uint256) = productCode (32비트) << 224 | eventCode (32비트) << 192 | serial (192비트)
```
→ 충돌 없는 tokenId 공간, 디코딩으로 원본 정보 복원 가능

**OpenZeppelin Upgradeable 4종 조합:**
- ERC1155Upgradeable: 다중 토큰 표준
- AccessControlUpgradeable: 역할 기반 접근 제어
- UUPSUpgradeable: 업그레이드 가능 프록시
- PausableUpgradeable: 일시 중지 기능

### 🔴 실습 (30분) — 수강생 직접 작성

**Step 1**: OZ Upgradeable 4종 import + 상속 선언
```solidity
// blockchain/contracts/KyoboNFT.sol
// TODO: 4종 import + 상속

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// TODO: import 4개

contract KyoboNFT is
  // TODO: 4종 상속 선언
{
  // TODO: 역할 상수
  bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
  bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
}
```

**Step 2**: tokenId 비트 인코딩 / 역방향 디코딩 함수
```solidity
// TODO: encodeTokenId 구현
// productCode + eventCode + serial → uint256

function encodeTokenId(
  uint32 productCode,
  uint32 eventCode,
  uint192 serial
) public pure returns (uint256) {
  // TODO: 비트 시프트로 조합
}

// TODO: decodeTokenId 구현
// uint256 → (productCode, eventCode, serial)

function decodeTokenId(uint256 tokenId)
  public pure
  returns (uint32 productCode, uint32 eventCode, uint192 serial)
{
  // TODO: 비트 마스크로 분리
}
```

**Step 3**: 단위 테스트
```typescript
// blockchain/test/KyoboNFT.test.ts
it('tokenId 인코딩·디코딩 일관성', async () => {
  const [deployer] = await ethers.getSigners();
  const nft = await upgrades.deployProxy(KyoboNFT, [deployer.address]);
  
  const productCode = 1n;
  const eventCode = 100n;
  
  // TODO: encodeTokenId 호출 → tokenId 획득
  // TODO: decodeTokenId 호출 → 원본 값 복원
  // TODO: productCode, eventCode 일치 확인
});
```

### ✅ 답안

```solidity
// KyoboNFT.sol 상속 선언
import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

contract KyoboNFT is
  ERC1155Upgradeable,
  AccessControlUpgradeable,
  UUPSUpgradeable,
  PausableUpgradeable
{
  // tokenId 인코딩
  function encodeTokenId(
    uint32 productCode,
    uint32 eventCode,
    uint192 serial
  ) public pure returns (uint256) {
    return (uint256(productCode) << 224) |
           (uint256(eventCode) << 192) |
           uint256(serial);
  }

  // tokenId 디코딩
  function decodeTokenId(uint256 tokenId)
    public pure
    returns (uint32 productCode, uint32 eventCode, uint192 serial)
  {
    productCode = uint32(tokenId >> 224);
    eventCode   = uint32(tokenId >> 192);
    serial      = uint192(tokenId);
  }
}
```

### ✅ 완료 기준
- [ ] OZ Upgradeable 4종 상속 컴파일 통과
- [ ] tokenId 인코딩·디코딩 테스트 통과

---

## S36: 업그레이드 가능한 컨트랙트 설계 — UUPS 패턴과 Storage Collision (강의 25분 + 실습 30분)

### 강의

**UUPS vs 투명 프록시:**
- 투명 프록시: 업그레이드 함수가 ProxyAdmin에 위치
- UUPS: 업그레이드 함수가 implementation에 위치 → 가스 절감
- **Storage collision 시 기존 토큰 전량 소실** → 슬롯 관리 필수

**슬롯 충돌 원리:**
```
ProxyStorage: slot 0 = implementationAddress
KyoboNFT:    slot 0 = ... (만약 변수 선언 시 충돌)
```
→ OZ Upgradeable이 `__gap` 배열로 슬롯 예약 처리

**`initializer` modifier 필요성:**
- **누락 시 누구든 owner 탈취 가능**
- 한 번만 실행 가능 → 재호출 시 revert

### 🔴 실습 (30분) — 수강생 직접 작성

**Step 1**: initialize() 구현
```solidity
// TODO: initializer modifier 적용 + 상속된 컨트랙트 초기화 체인

function initialize(address admin) public initializer {
  // TODO: __ERC1155_init("https://kyobo.io/nft/{id}.json")
  // TODO: __AccessControl_init()
  // TODO: __UUPSUpgradeable_init()
  // TODO: __Pausable_init()
  // TODO: _grantRole(DEFAULT_ADMIN_ROLE, admin)
  // TODO: _grantRole(MINTER_ROLE, admin)
  // TODO: _grantRole(PAUSER_ROLE, admin)
  // TODO: _grantRole(UPGRADER_ROLE, admin)
}
```

**Step 2**: initializer 누락 공격 테스트
```typescript
it('initializer 누락 → 타 주소에서 initialize 재호출 가능 (취약점)', async () => {
  // TODO: modifier 제거한 버전 배포
  // TODO: 공격자 주소로 initialize 재호출 → 성공 (취약)
  // TODO: modifier 복원 후 → revert 확인
});
```

**Step 3**: 업그레이드 가능 프록시 로컬 배포
```typescript
// TODO: hardhat-upgrades로 프록시 배포
const KyoboNFT = await ethers.getContractFactory('KyoboNFT');
const nft = await upgrades.deployProxy(KyoboNFT, [deployer.address], {
  initializer: 'initialize',
  kind: 'uups',
});
await nft.waitForDeployment();
console.log('프록시 주소:', await nft.getAddress());
```

### ✅ 답안

```solidity
// initialize() 완성
function initialize(address admin) public initializer {
  __ERC1155_init("https://kyobo.io/nft/{id}.json");
  __AccessControl_init();
  __UUPSUpgradeable_init();
  __Pausable_init();

  _grantRole(DEFAULT_ADMIN_ROLE, admin);
  _grantRole(MINTER_ROLE, admin);
  _grantRole(PAUSER_ROLE, admin);
  _grantRole(UPGRADER_ROLE, admin);
}

// _authorizeUpgrade — 업그레이드 권한 제한
function _authorizeUpgrade(address newImplementation)
  internal
  override
  onlyRole(UPGRADER_ROLE)
{}
```

```typescript
// 프록시 배포 + 재호출 방어 테스트
it('initialize 재호출 → revert', async () => {
  const nft = await upgrades.deployProxy(KyoboNFT, [deployer.address], { kind: 'uups' });
  
  await expect(
    nft.initialize(attacker.address)
  ).to.be.revertedWithCustomError(nft, 'InvalidInitialization');
});
```

### ✅ 완료 기준
- [ ] initialize() initializer 적용 확인
- [ ] 재호출 → revert 확인
- [ ] 로컬 프록시 배포 성공
