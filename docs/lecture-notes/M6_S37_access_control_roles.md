# M6 S37 — 온체인 역할 기반 접근 제어와 발행 권한 체계

> 모듈 6 · 세션 37 · 1시간  
> 스켈레톤: `blockchain/src/phase1/KyoboNFT.sol` → `mint()`, `mintBatch()`

---

## 강의 파트 (20분)

### 1. 왜 온체인 접근 제어가 필요한가

"서버에서 권한 체크를 하면 되지 않나? 굳이 컨트랙트에서 할 필요가 있나?"

오프체인 권한 체크만 있는 경우의 위험:

```
시나리오:
  issuer-service 서버가 해킹됨
  공격자가 서버 코드를 수정해서 권한 체크를 우회
  KyoboNFT.mint()를 직접 호출 (서버 지갑 private key 탈취)
```

컨트랙트에 MINTER_ROLE 체크가 있다면:

```
공격자가 컨트랙트에 직접 mint() 호출
→ onlyRole(MINTER_ROLE) 체크
→ 공격자 주소는 MINTER_ROLE 없음
→ revert → 발행 불가
```

**온체인 접근 제어는 "서버가 해킹됐을 때"의 마지막 방어선이다.**

---

### 2. 역할 설계 — 최소 권한 원칙

```solidity
bytes32 public constant MINTER_ROLE   = keccak256("MINTER_ROLE");
bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
```

| 역할 | 허용 함수 | 보유 주체 | 이유 |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | grantRole, revokeRole | 교보 운영자 멀티시그 (M8) | 역할 부여 권한은 가장 안전하게 |
| `MINTER_ROLE` | mint, mintBatch, burn | VASP 운영 서버 지갑 | 발행은 서버만 |
| `PAUSER_ROLE` | pause, unpause | Admin | 긴급 정지 |
| `UPGRADER_ROLE` | upgradeToAndCall | Admin | 컨트랙트 업그레이드 |

**VASP 서버 지갑 = MINTER_ROLE의 의미**: issuer-service 서버가 사용하는 private key의 주소만 mint 가능. 사용자가 직접 자기 지갑으로 mint 호출 → revert.

---

### 3. `mint()` 구현 — 두 개의 modifier

```solidity
function mint(
    address to,
    uint256 tokenId,
    uint256 amount
) external onlyRole(MINTER_ROLE) whenNotPaused {
    require(amount > 0, "KyoboNFT: zero amount");
    _mint(to, tokenId, amount, "");
}
```

`onlyRole(MINTER_ROLE)`: MINTER_ROLE 없는 주소 → `AccessControlUnauthorizedAccount` revert

`whenNotPaused`: Pause 상태 → `EnforcedPause` revert

`require(amount > 0)`: 0개 발행 시도 방어

각 체크의 우선순위: MINTER_ROLE 체크가 먼저다. 권한 없는 주소가 Pause 상태인지 아닌지를 알 필요가 없다.

---

### 4. `mintBatch()` — 표준 ERC-1155와의 차이점

ERC-1155 표준의 `mintBatch`는 **1명의 to에게 여러 tokenId를 발행**한다:

```solidity
// 표준 ERC-1155: 1명에게 여러 종류
_mintBatch(to, [tokenId1, tokenId2, tokenId3], [1, 1, 1], "");
```

KyoboNFT의 `mintBatch`는 **여러 명에게 각각 발행**한다:

```solidity
// KyoboNFT: 여러 명에게 각각 1개씩
function mintBatch(
    address[] calldata to,
    uint256[] calldata tokenIds,
    uint256[] calldata amounts
) external onlyRole(MINTER_ROLE) whenNotPaused {
    require(
        to.length == tokenIds.length && tokenIds.length == amounts.length,
        "KyoboNFT: length mismatch"
    );
    for (uint256 i = 0; i < to.length; i++) {
        _mint(to[i], tokenIds[i], amounts[i], "");
    }
}
```

M5 `BulkIssueService`에서 500명씩 청크로 보내는 것이 이 함수 하나로 처리된다.

---

### 5. TX Nonce 관리 — 순차 처리의 이유

서버에서 mintBatch TX를 순차 제출할 때:

```
TX #1 (nonce=10): mintBatch chunk 0 (500명)
TX #2 (nonce=11): mintBatch chunk 1 (500명)
TX #3 (nonce=12): mintBatch chunk 2 (500명)
```

**Stuck TX 시나리오**: TX #1이 낮은 가스비로 mempool에서 대기 중 → TX #2, #3은 nonce=10이 처리되기 전까지 블록에 못 들어감 → 전체 배치 지연.

**Replace-by-Fee (RBF)**: 동일 nonce로 가스비를 1.2배 높여 재전송하면 기존 TX를 대체한다. M3 S20의 gas bump 패턴과 동일하다.

---

## 실습 파트 (35분)

### `mint()` TODO 채우기

```solidity
function mint(
    address to,
    uint256 tokenId,
    uint256 amount
) external onlyRole(MINTER_ROLE) whenNotPaused {
    // TODO: amount > 0 체크
    require(amount > 0, "KyoboNFT: zero amount");
    // TODO: _mint 호출
    _mint(to, tokenId, amount, "");
}
```

### `mintBatch()` TODO 채우기

```solidity
function mintBatch(
    address[] calldata to,
    uint256[] calldata tokenIds,
    uint256[] calldata amounts
) external onlyRole(MINTER_ROLE) whenNotPaused {
    // TODO: 배열 길이 동일성 검증
    require(
        to.length == tokenIds.length && tokenIds.length == amounts.length,
        "KyoboNFT: length mismatch"
    );
    // TODO: 루프로 각 주소에 mint
    for (uint256 i = 0; i < to.length; i++) {
        _mint(to[i], tokenIds[i], amounts[i], "");
    }
}
```

### 권한 테스트

```solidity
function test_mint_noMinterRole_reverts() public {
    address unauthorized = address(0xBEEF);
    vm.prank(unauthorized);
    vm.expectRevert();  // AccessControlUnauthorizedAccount
    nft.mint(address(this), nft.encodeTokenId(1, 1), 1);
}

function test_mintBatch_arrayLengthMismatch_reverts() public {
    address[] memory tos = new address[](2);
    uint256[] memory ids = new uint256[](1);  // 길이 불일치
    uint256[] memory amts = new uint256[](2);

    vm.expectRevert("KyoboNFT: length mismatch");
    nft.mintBatch(tos, ids, amts);
}
```

### mintBatch 500건 가스 측정

```solidity
function test_mintBatch_500_gasUsage() public {
    address[] memory tos = new address[](500);
    uint256[] memory ids = new uint256[](500);
    uint256[] memory amts = new uint256[](500);

    for (uint256 i = 0; i < 500; i++) {
        tos[i] = address(uint160(i + 1));
        ids[i] = nft.encodeTokenId(1, i);
        amts[i] = 1;
    }

    vm.startSnapshotGas("mintBatch_500");
    nft.mintBatch(tos, ids, amts);
    uint256 gasUsed = vm.stopSnapshotGas("mintBatch_500");

    console.log("mintBatch 500건 가스:", gasUsed);
    // 25,000,000 gas 이내여야 함 (block gas limit 30M의 83%)
    assertLt(gasUsed, 25_000_000);
}
```

---

## 완료 기준

- [ ] MINTER_ROLE 없는 주소 mint → revert
- [ ] mintBatch 500건 가스 측정 완료
- [ ] 배열 길이 불일치 → revert
- [ ] 역할 체계 설명 가능 (각 역할 보유 주체 포함)
