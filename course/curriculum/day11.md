# Day 11 — M7: 스마트컨트랙트 보안 감사 + 업그레이드 운영 (S41~S44)

**세션**: S41~S44 | **모듈**: M7 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: Slither 분석 + HIGH/MEDIUM 전량 제거 + 보안 리포트 + reinitializer 이중 호출 방지

---

## S41: 스마트컨트랙트 주요 공격 벡터와 정적 분석 방법론 (강의 25분 + 실습 30분)

### 강의

**Reentrancy:**
- 외부 호출 전 상태 미변경 → 재진입 중복 인출
- CEI 패턴: Check(권한 확인) → Effects(상태 변경) → Interactions(외부 호출)

**NFT 소각→환불 순서에서 왜 중요한가:**
- 잘못된 순서: 환불(외부 호출) → holdings 차감 → 재진입 → 환불 재호출
- 올바른 순서: holdings 차감(상태 변경) → 환불(외부 호출)

**Access Control 우회:**
- `onlyRole` 누락 함수
- public 가시성 실수
- Slither로 자동 탐지 가능

### 🔴 실습 (30분) — 수강생 직접 작성

**Step 1**: Slither 정적 분석 도구 설치
```bash
# TODO: Slither 설치
pip install slither-analyzer

# 버전 확인
slither --version
```

**Step 2**: 컨트랙트 정적 분석 실행
```bash
# TODO: KyoboNFT.sol 분석 실행
slither blockchain/contracts/KyoboNFT.sol

# 결과를 HIGH / MEDIUM / LOW / INFORMATIONAL로 분류
# (분류 결과를 표로 정리)
```

**Step 3**: HIGH 항목 공격 테스트 케이스 작성
```typescript
// blockchain/test/security/ReentrancyAttack.test.ts
// TODO: HIGH 항목 중 하나 선택 → 실제 공격 시뮬레이션

// 예: reentrancy 공격 컨트랙트 작성
// blockchain/contracts/test/AttackerContract.sol

// TODO: 공격 시나리오 실행 → revert 확인 (방어 코드가 있으면 자동 방어)
// TODO: 방어 코드 없으면 공격 성공 → 이후 세션에서 수정
```

### ✅ 답안

```bash
# Slither 실행
pip install slither-analyzer
cd blockchain
slither contracts/KyoboNFT.sol --config-file slither.config.json 2>&1 | tee slither-report.txt

# 결과 분류 예시:
# HIGH: reentrancy-eth (burn 함수에서 외부 호출 후 상태 변경)
# MEDIUM: missing-zero-check (초기화 함수에서 주소 0 체크 없음)
# LOW: ...
# INFORMATIONAL: ...
```

```solidity
// AttackerContract.sol (취약점 테스트용)
contract ReentrancyAttacker {
  KyoboNFT public target;
  uint256 public attackCount;

  constructor(address _target) {
    target = KyoboNFT(_target);
  }

  // receive 함수에서 재진입
  receive() external payable {
    if (attackCount < 3) {
      attackCount++;
      target.burn(address(this), 1001, 1);
    }
  }

  function attack() external {
    target.burn(address(this), 1001, 1);
  }
}
```

### ✅ 완료 기준
- [ ] Slither 실행 + 결과 분류 완료
- [ ] HIGH 항목 공격 테스트 케이스 작성

---

## S42: tx.origin 취약점과 정수 오버플로우 — HIGH 취약점 제거 원칙 (강의 20분 + 실습 35분)

### 강의

**tx.origin 피싱 공격:**
- 피싱 컨트랙트가 tx.origin을 악용하는 시나리오
- 원래 EOA(사용자)가 피싱 컨트랙트 호출 → 피싱 컨트랙트가 KyoboNFT 호출 → `tx.origin` == 사용자 (통과!)
- **msg.sender만 써야 하는 이유**: msg.sender는 즉각 호출자, tx.origin은 최초 호출자

**Integer overflow:**
- Solidity 0.8+ 기본 보호 (SafeMath 불필요)
- unchecked 블록 사용 시 직접 검증 필요

**Slither HIGH/MEDIUM 판별 기준:**
- HIGH: 즉각적 자산 손실 가능
- MEDIUM: 특정 조건에서 악용 가능
- False Positive: Slither가 잘못 탐지한 경우 → 주석으로 `// slither-disable-next-line`

### 🔴 실습 (35분) — 수강생 직접 작성

**Step 1**: tx.origin 사용 전량 탐지 → msg.sender로 교체
```bash
# TODO: tx.origin 사용 위치 탐지
grep -rn "tx\.origin" blockchain/contracts/

# 발견된 위치를 msg.sender로 교체
```

**Step 2**: CEI 패턴 적용
```solidity
// TODO: burn 함수에서 상태 변경을 외부 호출보다 먼저

// 잘못된 순서 (재진입 취약):
// function burn(...) {
//   외부 호출(환불) → _burn(상태 변경) -- 재진입 가능!
// }

// 올바른 순서 (CEI):
function burn(address from, uint256 tokenId, uint256 amount) external {
  // Check
  require(from == msg.sender || isApprovedForAll(from, msg.sender), "Not authorized");
  
  // Effects (상태 변경 먼저)
  _burn(from, tokenId, amount);
  
  // Interactions (외부 호출 마지막)
  // (환불 로직이 있다면 여기서)
}
```

**Step 3**: ReentrancyGuard import + 적용 → Slither 재실행
```solidity
// TODO: ReentrancyGuardUpgradeable import + 상속 추가
// TODO: burn 함수에 nonReentrant modifier 적용

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

contract KyoboNFT is
  ERC1155Upgradeable,
  AccessControlUpgradeable,
  UUPSUpgradeable,
  PausableUpgradeable,
  ReentrancyGuardUpgradeable  // TODO: 추가
{
  function burn(...) external nonReentrant { ... }
}
```

```bash
# Slither 재실행 → HIGH 0건 확인
slither blockchain/contracts/KyoboNFT.sol
# HIGH 항목: 0
```

### ✅ 답안

```solidity
// burn 함수 CEI + nonReentrant 적용
function burn(address from, uint256 tokenId, uint256 amount)
  external
  nonReentrant
  whenNotPaused
{
  // Check
  require(
    from == msg.sender || isApprovedForAll(from, msg.sender),
    "KyoboNFT: not authorized"
  );
  
  // Effects (상태 변경 먼저 — 재진입 방지)
  _burn(from, tokenId, amount);
  
  // Interactions (없음 — 환불이 있다면 여기 위치)
}
```

```bash
# tx.origin 검색 → 없음 확인
grep -rn "tx\.origin" blockchain/contracts/
# 출력 없음 = 전량 제거 완료

# Slither 재실행
slither blockchain/contracts/KyoboNFT.sol 2>&1 | grep "HIGH\|MEDIUM"
# HIGH: 0건
```

### ✅ 완료 기준
- [ ] tx.origin 전량 제거
- [ ] Slither HIGH 0건
- [ ] CEI 패턴 적용 확인

---

## S43: 중간 등급 취약점 패턴과 방어적 테스트 설계 (강의 15분 + 실습 40분)

### 강의

**MEDIUM 항목 유형 분류:**
- 재진입 경로 (HIGH 제거 후 남은 간접 경로)
- 권한 누락 (특정 함수 onlyRole 빠진 경우)
- 가시성 실수 (internal 함수가 public으로 선언된 경우)

**보안 테스트 케이스 설계 원칙:**
- 공격자 관점에서 시나리오 작성
- 정상 케이스가 아닌 비정상 입력으로 테스트

### 🔴 실습 (40분) — 수강생 직접 작성

**Step 1**: MEDIUM 항목 하나씩 수정
```bash
# TODO: Slither MEDIUM 항목 목록 확인
slither blockchain/contracts/KyoboNFT.sol --json slither-output.json

# 각 항목 수정 → 재실행 → 0건 될 때까지 반복
```

**Step 2**: 보안 테스트 파일 작성
```typescript
// blockchain/test/security/SecurityTest.test.ts
// TODO: 3가지 공격 시나리오 테스트

describe('보안 테스트', () => {
  // TODO: Reentrancy 공격 → 방어 확인
  it('재진입 공격 → nonReentrant로 방어', async () => {
    // AttackerContract 배포 → attack() 호출 → revert 확인
  });

  // TODO: Access Control 우회 → 방어 확인
  it('MINTER_ROLE 없는 주소 mintBatch → revert', async () => {
    // attacker.mintBatch(...) → revert 확인
  });

  // TODO: tx.origin 공격 → 방어 확인 (tx.origin 제거됐으므로 자동 방어)
  it('피싱 컨트랙트 경유 → msg.sender 체크로 방어', async () => {
    // 피싱 컨트랙트가 burn 호출 → from != msg.sender → revert 확인
  });
});
```

**Step 3**: 전체 테스트 실행 → 모든 공격 방어 확인
```bash
npx hardhat test blockchain/test/security/SecurityTest.test.ts
```

### ✅ 답안

```typescript
describe('보안 테스트', () => {
  it('재진입 공격 → nonReentrant로 방어', async () => {
    const AttackerFactory = await ethers.getContractFactory('ReentrancyAttacker');
    const attacker = await AttackerFactory.deploy(await nft.getAddress());

    // 공격자 주소에 토큰 mint
    await nft.connect(minter).mint(await attacker.getAddress(), 1001n, 5n, '0x');

    // 재진입 공격 시도 → ReentrancyGuard가 차단
    await expect(
      attacker.attack()
    ).to.be.revertedWithCustomError(nft, 'ReentrancyGuardReentrantCall');
  });

  it('MINTER_ROLE 없는 주소 mintBatch → revert', async () => {
    await expect(
      nft.connect(attacker).mintBatch(attacker.address, [1001n], [1n], '0x')
    ).to.be.revertedWithCustomError(nft, 'AccessControlUnauthorizedAccount');
  });

  it('피싱 컨트랙트 → msg.sender 체크로 방어', async () => {
    // from != msg.sender 이고 isApprovedForAll도 false인 경우
    await expect(
      nft.connect(phishingContract).burn(user.address, 1001n, 1n)
    ).to.be.revertedWith('KyoboNFT: not authorized');
  });
});
```

### ✅ 완료 기준
- [ ] Slither HIGH/MEDIUM 0건
- [ ] 공격 시나리오 테스트 전부 방어 확인

---

## S44: 업그레이드 시 데이터 손상 원인과 방어 패턴 (강의 15분 + 실습 40분)

### 강의

**업그레이드 거버넌스 절차:**
1. 테스트넷 검증 → 2. Gnosis Safe 제안 → 3. 2-of-3 서명 → 4. 실행
(M8 Gnosis Safe와 연계)

**보안 감사 리포트 구조:**
- 취약점 분류 (HIGH/MEDIUM/LOW)
- 적용 방어 패턴
- 잔여 LOW 항목
- 권장 사항

### 🔴 실습 (40분) — 수강생 직접 작성

**Step 1**: 슬롯 순서 변경 실험 → 값 파괴 확인 → 올바른 방법으로 재시도
```typescript
// TODO: v1에서 토큰 mint (tokenId 1001, amount 5)
// TODO: KyoboNFT_WrongUpgrade.sol 작성 (기존 변수 순서 변경)
// TODO: 업그레이드 → balanceOf 확인 → 값이 파괴됨 (다른 값)
// TODO: 올바른 방법(끝에 추가)으로 다시 시도 → 보존 확인

// 주의: 이 실험은 반드시 로컬에서만 (Sepolia 배포된 컨트랙트 건드리지 말 것)
```

**Step 2**: reinitializer(2) 테스트
```typescript
it('v2 업그레이드 후 initialize 재호출 → revert', async () => {
  // v2로 업그레이드
  const KyoboNFTV2 = await ethers.getContractFactory('KyoboNFTV2');
  await upgrades.upgradeProxy(proxyAddr, KyoboNFTV2);

  const nftV2 = await ethers.getContractAt('KyoboNFTV2', proxyAddr);

  // initialize 재호출 → revert 확인
  // TODO: nftV2.initialize(attacker.address) → revert 확인
  // TODO: nftV2.initializeV2(999n) 2회 호출 → 2번째 revert 확인
});
```

**Step 3**: M7 보안 리포트 작성
```markdown
# KyoboNFT 보안 감사 리포트

## 발견 취약점 요약
| 등급 | 항목 | 상태 |
|---|---|---|
| HIGH | Reentrancy (burn 함수) | ✅ 제거 (CEI + nonReentrant) |
| HIGH | tx.origin 사용 | ✅ 제거 (msg.sender로 교체) |
| MEDIUM | [항목명] | ✅ 제거 |

## 적용 방어 패턴
- ReentrancyGuard: burn 함수
- CEI 패턴: 모든 외부 호출 함수
- AccessControl: MINTER_ROLE, PAUSER_ROLE, UPGRADER_ROLE

## 잔여 LOW 항목
- [항목명]: False Positive — [이유]

## 권장 사항
- Gnosis Safe 2-of-3으로 업그레이드 거버넌스
- 정기 감사 (분기별)
```

### ✅ 답안

```typescript
// reinitializer 이중 호출 방지 테스트
it('reinitializer(2) 이중 호출 → revert', async () => {
  const KyoboNFTV2 = await ethers.getContractFactory('KyoboNFTV2');
  const upgraded = await upgrades.upgradeProxy(proxyAddr, KyoboNFTV2);

  // 첫 번째 initializeV2 → 성공
  await upgraded.initializeV2(1_000_000n);

  // 두 번째 initializeV2 → revert
  await expect(
    upgraded.initializeV2(999n)
  ).to.be.revertedWithCustomError(upgraded, 'InvalidInitialization');

  // v1 initialize 재호출도 revert
  await expect(
    upgraded.initialize(attacker.address)
  ).to.be.revertedWithCustomError(upgraded, 'InvalidInitialization');
});
```

### ✅ M7 완료 기준
- [ ] Slither HIGH/MEDIUM 최종 0건
- [ ] Storage layout 충돌 없음
- [ ] reinitializer 이중 호출 방지
- [ ] 보안 리포트 작성
