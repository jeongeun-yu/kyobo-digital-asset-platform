# M7 S42 — tx.origin 취약점과 정수 오버플로우 · HIGH 취약점 제거 원칙

> 모듈 7 · 세션 42 · 1시간  
> 스켈레톤: `blockchain/src/rewards/KyoboNFT.sol`

> 🔵 **Phase 3 전환 준비** — Phase 1에서는 월렛원이 배포한 컨트랙트를 사용하므로 당사가 직접 감사할 대상이 아니다. 이 세션은 Phase 3에서 당사가 컨트랙트를 직접 배포·운영할 때 필요한 보안 감사 역량을 미리 확보하는 목적이다.

---

## 강의 파트 (20분)

### 1. tx.origin 취약점 — Slither가 HIGH로 분류하는 이유

S41에서 tx.origin 피싱 공격을 배웠다. 실제 코드에서 어떻게 탐지하고 제거하는가?

**Slither 탐지:**

```
KyoboNFT.sol: [HIGH] tx-origin
  - 'tx.origin' used in an equality check
  - Use 'msg.sender' instead
```

**제거 방법:**

```solidity
// ❌ 제거 대상
require(tx.origin == owner, "Not owner");

// ✅ 수정
require(msg.sender == owner, "Not owner");
// 또는 onlyRole(...)로 교체
```

KyoboNFT에서 `tx.origin`을 검색해서 전량 제거한다:

```bash
grep -n "tx.origin" src/phase1/KyoboNFT.sol
# 없으면 OK, 있으면 모두 msg.sender로 교체
```

---

### 2. Integer Overflow — Solidity 0.8+에서의 상황

Solidity 0.8.0 이전에는 정수 오버플로우가 심각한 취약점이었다:

```solidity
// 0.8 이전: overflow 발생
uint8 a = 255;
a += 1;  // → 0 (overflow, 에러 없음)
```

0.8.0부터 기본으로 overflow/underflow 체크가 내장됐다:

```solidity
// 0.8+: revert 발생
uint8 a = 255;
a += 1;  // → revert: "Arithmetic over/underflow"
```

하지만 `unchecked` 블록을 사용하면 다시 위험해진다:

```solidity
// unchecked 사용 시 직접 검증 필요
function unsafeAdd(uint256 a, uint256 b) external returns (uint256) {
    unchecked {
        return a + b;  // overflow 체크 없음!
    }
}
```

KyoboNFT에서 `unchecked` 블록이 있다면 검토가 필요하다. 없으면 0.8+ 기본 보호로 충분하다.

---

### 3. ReentrancyGuard 적용

OpenZeppelin의 `ReentrancyGuard`는 재진입을 원천 차단하는 mutex(상호 배제)다.

```solidity
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

contract KyoboNFT is
    Initializable,
    ERC1155Upgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable  // 추가
{
    function initialize(address admin) public initializer {
        // ...
        __ReentrancyGuard_init();  // 초기화 추가
    }

    function burn(
        address from,
        uint256 tokenId,
        uint256 amount
    ) external onlyRole(MINTER_ROLE) nonReentrant {  // nonReentrant 추가
        _burn(from, tokenId, amount);
    }
}
```

`nonReentrant` modifier 내부 동작:

```solidity
// _status가 1이면 진행 중, 2면 완료
// 함수 시작 시 _status를 2로 설정
// 재진입 시 _status가 이미 2 → revert
// 함수 완료 시 _status를 1로 복원
```

CEI 패턴과 ReentrancyGuard를 **둘 다** 적용하는 것이 최선이다. CEI가 논리적 방어, ReentrancyGuard가 기술적 방어다.

---

### 4. Slither False Positive 식별법

Slither가 보고하는 모든 항목이 실제 취약점은 아니다. False Positive를 걸러내는 방법:

1. **코드 흐름 직접 추적**: 해당 코드 경로로 실제 공격이 가능한가?
2. **OZ 라이브러리 코드 제외**: `--exclude-dependencies` 플래그 사용
3. **의도적 패턴 무시**: `// slither-disable-next-line` 주석으로 특정 항목 무시

```bash
# OZ 라이브러리 제외
slither src/phase1/KyoboNFT.sol --exclude-dependencies

# 특정 항목만 보기
slither src/phase1/KyoboNFT.sol --detect reentrancy-eth,tx-origin
```

---

## 실습 파트 (35분)

### tx.origin 전량 탐지 및 교체

```bash
# 탐지
grep -rn "tx.origin" blockchain/src/

# 교체 (있는 경우)
# tx.origin == owner → msg.sender == owner
# tx.origin == msg.sender → 제거 (항상 true는 아님)
```

### CEI 패턴 검토 및 적용

```solidity
// KyoboNFT의 burn 함수 검토
// 현재: 외부 호출 없으므로 CEI 위반 없음
// 만약 환불 로직 추가 시 순서 확인

// 예시: 환불 포함 burn (CEI 적용)
function burnWithRefund(
    address from,
    uint256 tokenId,
    uint256 amount
) external onlyRole(MINTER_ROLE) nonReentrant {
    // 1. Check
    require(balanceOf(from, tokenId) >= amount, "Insufficient balance");

    // 2. Effects (외부 호출 전에 상태 변경)
    _burn(from, tokenId, amount);

    // 3. Interactions (상태 변경 후 외부 호출)
    uint256 refundAmount = amount * REFUND_PRICE;
    (bool success,) = from.call{value: refundAmount}("");
    require(success, "Refund failed");
}
```

### ReentrancyGuard import + 적용

```solidity
// KyoboNFT.sol에 추가
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

contract KyoboNFT is
    Initializable,
    ERC1155Upgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    function initialize(address admin) public initializer {
        // 기존 초기화 유지
        __ERC1155_init("");
        __AccessControl_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();  // 추가

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        // ...
    }
}
```

### Slither 재실행 → HIGH 0건 확인

```bash
slither src/phase1/KyoboNFT.sol --exclude-dependencies

# 목표:
# HIGH 항목: 0개
# MEDIUM 항목: 검토 후 처리
```

### 공격 방어 테스트

```solidity
function test_nonReentrant_preventsReentrancy() public {
    ReentrancyAttacker attacker = new ReentrancyAttacker(address(nft));
    nft.mint(address(attacker), tokenId, 5);

    // 재진입 공격 시도
    vm.expectRevert("ReentrancyGuard: reentrant call");
    attacker.attack(tokenId);

    // 잔액 변화 없음 (공격 실패)
    assertEq(nft.balanceOf(address(attacker), tokenId), 5);
}
```

---

## 완료 기준

- [ ] tx.origin 전량 제거
- [ ] Slither HIGH 0건
- [ ] CEI 패턴 적용 확인
- [ ] ReentrancyGuard 추가 + 테스트 통과
