# M6 S38 — 컨트랙트 생명주기 관리 · 소각·일시정지·업그레이드

> 모듈 6 · 세션 38 · 1시간  
> 스켈레톤: `blockchain/src/phase1/KyoboNFT.sol` → `burn()`, `pause()`, `_authorizeUpgrade()`

> 🔵 **Phase 3 전환 준비** — Phase 1에서 스마트 컨트랙트(Solidity 코드 작성·배포·운영)는 **월렛원(VASP)이 담당**한다. 이 세션은 Phase 3에서 당사가 직접 대체할 코드를 미리 학습하는 목적이다. **오너십(Owner Role)은 당사 보유** — 코드를 월렛원이 작성하더라도 컨트랙트 소유권은 당사가 갖는다. 스켈레톤은 최종 Phase 기준으로 설계되어 있다.

---

## 강의 파트 (15분)

### 1. NFT를 지워야 하는 상황이 존재한다

NFT는 "영구 소유"처럼 보이지만, 금융 상품에서는 회수가 필요한 케이스가 있다.

```
시나리오 1: 보험 만료
  고객이 보험을 해지함 → 혜택 쿠폰 NFT 회수 필요

시나리오 2: 잘못 발행
  버그로 인해 조건 미충족 고객에게 NFT가 발행됨
  감사에서 발견 → 즉시 회수 필요

시나리오 3: 사용자 탈퇴
  서비스 탈퇴 → 개인정보 삭제 + NFT 정리
```

이런 케이스를 위해 `burn()` 함수가 필요하다.

---

### 2. burn 권한 — 왜 사용자가 아닌 MINTER_ROLE인가

일반적인 NFT에서 burn 권한은 소유자에게 있다. "내 것은 내가 소각"이 자연스럽다.

교보생명 케이스에서는 다르다:

```solidity
// 선택지 A: 소유자 소각
function burn(address from, ...) external {
    require(msg.sender == from || isApprovedForAll(from, msg.sender));
    _burn(from, tokenId, amount);
}
// 문제: 사용자가 보험 만료 전에 NFT를 자발적으로 소각하면?
//       교보 시스템에서 "쿠폰 사용 완료" vs "만료 전 소각"을 구분 못함

// 선택지 B: MINTER_ROLE 소각 (현재 구현)
function burn(address from, ...) external onlyRole(MINTER_ROLE) {
    _burn(from, tokenId, amount);
}
// 장점: 소각은 서비스 레이어(issuer-service)에서만 가능
//       소각 이유가 항상 시스템에 기록됨 (감사 로그)
```

MINTER_ROLE에 발행과 소각을 함께 부여한 이유: issuer-service가 NFT 생명주기 전체(발행 + 회수)를 관리한다. 권한을 나누면 관리 복잡도가 높아진다.

---

### 3. burn에 `whenNotPaused`가 없는 이유

```solidity
function burn(
    address from,
    uint256 tokenId,
    uint256 amount
) external onlyRole(MINTER_ROLE) {
    // whenNotPaused 없음!
    _burn(from, tokenId, amount);
}
```

Pause는 "의심스러운 상황에서 모든 토큰 활동을 즉시 차단"하기 위해 존재한다.

그런데 해킹이 의심되는 상황에서 오히려 피해 NFT를 즉시 소각해야 할 수 있다. burn이 Pause에 막히면 피해 확산을 차단할 방법이 없다.

단, 현재 `_update` hook 구현에서 burn도 `whenNotPaused`에 걸린다:

```solidity
function _update(...) internal override whenNotPaused {
    super._update(...);
}
```

`_update`는 mint, burn, transfer 모두에 호출된다. 운영 정책에 따라 burn을 Pause에서 예외 처리할 수 있다:

```solidity
function _update(address from, address to, ...) internal override {
    if (from != address(0)) {  // burn이 아닌 경우 (from=0이면 mint)
        _requireNotPaused();
    }
    super._update(from, to, ids, values);
}
```

이 세분화는 S38 실습에서 정책을 논의하며 결정한다.

---

### 4. Pause 권한 단일점 위험

```
PAUSER_ROLE = Admin 단일 키
→ Admin 키 분실 → 비상시 pause 불가
→ Admin 키 탈취 → 공격자가 시스템을 영구 정지시킬 수 있음
```

이것이 M8에서 Gnosis Safe 2-of-3 멀티시그로 Admin을 관리하는 이유다. 키 하나가 분실돼도 나머지 두 개로 복구할 수 있다.

---

### 5. `_authorizeUpgrade()` — 반드시 override해야 하는 이유

UUPS에서 업그레이드 함수가 Implementation에 있다. OZ의 `UUPSUpgradeable`은 `_authorizeUpgrade()`를 `virtual`로만 선언하고, 구현을 강제하지 않는다.

Override하지 않으면 디폴트 구현이 없어서 컴파일 에러가 나야 할 것 같지만, 일부 버전에서는 컴파일이 통과하되 실행 시 누구나 업그레이드 가능한 치명적 취약점이 생긴다.

반드시 `onlyRole(UPGRADER_ROLE)`를 포함해야 한다:

```solidity
function _authorizeUpgrade(address /* newImplementation */)
    internal
    override
    onlyRole(UPGRADER_ROLE)
{
    // 추가 검증은 오프체인(hardhat-upgrades)에서 수행
}
```

---

## 실습 파트 (40분)

### `burn()` + `pause()` + `unpause()` 확인

```solidity
// burn: MINTER_ROLE만 가능
function burn(
    address from,
    uint256 tokenId,
    uint256 amount
) external onlyRole(MINTER_ROLE) {
    _burn(from, tokenId, amount);
}

// pause: PAUSER_ROLE만 가능
function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }
```

### Pause 상태 테스트

```solidity
function test_pausedMint_reverts() public {
    nft.pause();

    vm.expectRevert();  // EnforcedPause
    nft.mint(address(this), nft.encodeTokenId(1, 1), 1);
}

function test_unpauseRestoresOperation() public {
    nft.pause();
    nft.unpause();

    // unpause 후 정상 발행
    nft.mint(address(this), nft.encodeTokenId(1, 1), 1);
    assertEq(nft.balanceOf(address(this), nft.encodeTokenId(1, 1)), 1);
}

function test_burn_reducesBalance() public {
    uint256 tokenId = nft.encodeTokenId(1, 1);
    nft.mint(address(this), tokenId, 5);

    nft.burn(address(this), tokenId, 3);

    assertEq(nft.balanceOf(address(this), tokenId), 2);
}

function test_burn_noPauserRole_reverts() public {
    address unauthorized = address(0xBEEF);
    vm.prank(unauthorized);
    vm.expectRevert();
    nft.pause();
}

function test_upgrader_noRole_reverts() public {
    address unauthorized = address(0xBEEF);
    address newImpl = address(0xNEW);
    vm.prank(unauthorized);
    vm.expectRevert();
    nft.upgradeToAndCall(newImpl, "");
}
```

### 전체 단위 테스트 실행

```bash
npx hardhat test
```

예상 결과:
```
✅ tokenId 인코딩/디코딩 (S35)
✅ initialize 재호출 → revert (S36)
✅ MINTER_ROLE 없음 → mint revert (S37)
✅ mintBatch 500건 가스 측정 (S37)
✅ Pause → mint revert (S38)
✅ Unpause → 정상 동작 (S38)
✅ burn → 잔액 감소 (S38)
✅ PAUSER_ROLE 없음 → pause revert (S38)
✅ UPGRADER_ROLE 없음 → upgrade revert (S38)
```

---

## 완료 기준

- [ ] Pause 상태 mint/burn → revert
- [ ] 전체 단위 테스트 PASS
- [ ] Pause 권한 단일점 위험 설명 가능
- [ ] _authorizeUpgrade override 이유 설명 가능
