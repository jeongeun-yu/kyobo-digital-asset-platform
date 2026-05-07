# M7 S43 — 중간 등급 취약점 패턴과 방어적 테스트 설계

> 모듈 7 · 세션 43 · 1시간  
> 스켈레톤: `blockchain/src/rewards/KyoboNFT.sol`

> 🔵 **Phase 3 전환 준비** — Phase 1에서는 월렛원이 배포한 컨트랙트를 사용하므로 당사가 직접 감사할 대상이 아니다. 이 세션은 Phase 3에서 당사가 컨트랙트를 직접 배포·운영할 때 필요한 보안 감사 역량을 미리 확보하는 목적이다.

---

## 강의 파트 (25분)

### 0. Slither 심각도별 처리 흐름

S41에서 Slither를 실행했다. 이번 세션에서는 MEDIUM 항목을 체계적으로 처리한다.

```
slither 실행
     │
     ├── HIGH 항목 (S41, S42에서 처리 완료)
     │       └── 전량 수정 → 재실행에서 0건 확인
     │
     ├── MEDIUM 항목 ← 이번 세션 주제
     │       │
     │       ├── 접근 제어 누락 → 권한 modifier 추가
     │       ├── 이벤트 누락 → emit 추가
     │       └── 가시성 실수 → visibility 수정
     │
     └── LOW / INFORMATIONAL
             │
             ├── 실제 취약점인지 코드 흐름 직접 추적
             ├── False Positive 판단 → // slither-disable 주석
             └── 잔여 LOW는 감사 리포트에 기록
```

---

### 1. MEDIUM 취약점 — "지금 당장은 아니지만" 위험

HIGH 취약점이 "즉각적 자산 손실"이라면, MEDIUM은 "상황에 따라 비정상 동작"이다.

**MEDIUM 유형 1: 접근 제어 누락**

```solidity
// ❌ public 함수인데 권한 체크 없음
function updateTokenURI(string memory newURI) public {
    // onlyRole(ADMIN_ROLE) 빠짐
    baseURI = newURI;
}
```

누구나 baseURI를 변경할 수 있다. NFT 메타데이터 조작 가능.

**MEDIUM 유형 2: 이벤트 누락**

```solidity
// ❌ 중요 상태 변경인데 이벤트 없음
function grantMinterRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _grantRole(MINTER_ROLE, account);
    // emit 없음 → 블록체인 로그에 기록 안 됨
}
```

역할 변경을 외부에서 추적할 방법이 없다. 감사 감사(audit)에서 "언제 누가 MINTER_ROLE을 받았는가" 확인 불가.

**MEDIUM 유형 3: 가시성(visibility) 실수**

```solidity
// ❌ internal이어야 하는데 public
function _authorizeUpgrade(address newImpl) public override {
    // onlyRole 체크가 있어도 public이면 외부에서 직접 호출 가능
}
```

---

### 1-1. 이벤트(Event)가 보안에서 중요한 이유

온체인 이벤트는 블록체인 로그에 영구 기록된다. 오프체인 모니터링 시스템이 이를 구독(subscribe)해서 실시간으로 이상 감지한다.

```
KyoboNFT.mint() 실행
     │
     └─ emit TransferSingle(operator, from, to, id, value)
                │
                ▼
         Ethereum 노드 로그에 기록
                │
                ▼
         issuer-service EventListener가 구독
                │
                ├── 발행자(operator)가 승인된 MINTER인가?
                ├── 발행량이 정상 범위인가?
                └── 비정상 감지 시 → 즉시 알람 → pause() 실행
```

이벤트가 없으면:
- 누가 언제 어떤 역할을 받았는지 온체인에 기록 없음
- 감사(audit) 시 "2025년 3월 15일 MINTER_ROLE 부여" 사실 증명 불가
- 규제 기관 제출용 로그 부재

---

### 2. 보안 테스트 설계 원칙 — 공격자 관점에서 시나리오 작성

일반 기능 테스트: "이 함수가 올바르게 작동하는가?"

보안 테스트: "이 함수가 악용될 수 있는가?"

```
질문 1: 권한 없는 주소가 이 함수를 호출하면?
질문 2: 이 함수를 반복 호출하면? (무한 루프, 상태 누적)
질문 3: 경계값에서 이 함수가 어떻게 동작하는가?
질문 4: 이 함수 실행 중 외부 호출이 있다면, 재진입 가능한가?
질문 5: 이 함수의 부작용이 다른 함수에 영향을 미치는가?
```

---

## 실습 파트 (40분)

### MEDIUM 항목 수정

```bash
# MEDIUM 항목 확인
slither src/phase1/KyoboNFT.sol --detect access-control,events-access,visibility

# 각 항목 수정
```

**접근 제어 수정 예시:**

```solidity
// 모든 상태 변경 함수에 적절한 modifier 확인
function updateMaxSupply(uint256 newMax) external onlyRole(DEFAULT_ADMIN_ROLE) {
    // ✅ DEFAULT_ADMIN_ROLE만 변경 가능
    maxSupplyPerToken = newMax;
    emit MaxSupplyUpdated(newMax);  // ✅ 이벤트 발생
}
```

### 보안 테스트 파일 작성

```solidity
// test/SecurityAttackTests.sol
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/phase1/KyoboNFT.sol";

contract SecurityAttackTests is Test {
    KyoboNFT nft;
    address admin;
    address attacker;
    address user;

    function setUp() public {
        admin   = address(0xADMIN);
        attacker = address(0xATTACK);
        user    = address(0xUSER);

        KyoboNFT impl = new KyoboNFT();
        // 프록시 배포 설정...
        nft = impl;
        nft.initialize(admin);
    }

    // ── Reentrancy 공격 ─────────────────────────────────────────

    function test_reentrancy_burn_blocked() public {
        // 공격 컨트랙트 배포
        ReentrancyAttacker attacker = new ReentrancyAttacker(address(nft));

        // MINTER_ROLE 부여 (실제 운영에서는 VASP 서버 지갑)
        vm.prank(admin);
        nft.grantRole(nft.MINTER_ROLE(), admin);

        // 공격자에게 NFT 발행
        vm.prank(admin);
        nft.mint(address(attacker), nft.encodeTokenId(1, 1), 5);

        // 재진입 공격 → ReentrancyGuard가 차단
        vm.expectRevert();
        attacker.attack(nft.encodeTokenId(1, 1));

        // 잔액 보존 (공격 실패)
        assertEq(nft.balanceOf(address(attacker), nft.encodeTokenId(1, 1)), 5);
    }

    // ── Access Control 우회 시도 ─────────────────────────────────

    function test_mint_withoutMinterRole_reverts() public {
        // MINTER_ROLE 없는 주소로 mint 시도
        vm.prank(attacker);
        vm.expectRevert();
        nft.mint(user, nft.encodeTokenId(1, 1), 1);
    }

    function test_pause_withoutPauserRole_reverts() public {
        vm.prank(attacker);
        vm.expectRevert();
        nft.pause();
    }

    function test_upgrade_withoutUpgraderRole_reverts() public {
        address fakeImpl = address(0xFAKE);
        vm.prank(attacker);
        vm.expectRevert();
        nft.upgradeToAndCall(fakeImpl, "");
    }

    function test_grantRole_withoutAdminRole_reverts() public {
        // 일반 사용자가 자신에게 MINTER_ROLE 부여 시도
        vm.prank(attacker);
        vm.expectRevert();
        nft.grantRole(nft.MINTER_ROLE(), attacker);
    }

    // ── tx.origin 공격 ───────────────────────────────────────────

    function test_txOrigin_attack_blocked() public {
        // tx.origin이 admin이어도 msg.sender가 공격 컨트랙트이면 차단됨
        TxOriginAttacker txAttacker = new TxOriginAttacker(address(nft));

        // admin이 txAttacker를 통해 간접 호출 → msg.sender = txAttacker
        vm.prank(admin);  // tx.origin = admin
        // txAttacker가 nft 함수 호출 시 msg.sender = txAttacker (MINTER_ROLE 없음)
        txAttacker.attackViaTxOrigin(nft.encodeTokenId(1, 1));
        // → AccessControlUnauthorizedAccount revert (msg.sender 체크)
    }

    // ── 경계값 테스트 ─────────────────────────────────────────────

    function test_mint_zeroAmount_reverts() public {
        vm.prank(admin);
        vm.expectRevert("KyoboNFT: zero amount");
        nft.mint(user, nft.encodeTokenId(1, 1), 0);
    }

    function test_mintBatch_emptyArrays() public {
        // 빈 배열 → 에러 없이 처리 (아무것도 발행 안 됨)
        vm.prank(admin);
        nft.mintBatch(
            new address[](0),
            new uint256[](0),
            new uint256[](0),
        );
    }
}

// ── 공격 컨트랙트들 ────────────────────────────────────────────

contract ReentrancyAttacker {
    KyoboNFT public target;
    uint256 public attackCount;
    uint256 public targetTokenId;

    constructor(address _target) {
        target = KyoboNFT(_target);
    }

    receive() external payable {
        if (attackCount < 3) {
            attackCount++;
            target.burn(address(this), targetTokenId, 1);
        }
    }

    function attack(uint256 tokenId) external {
        targetTokenId = tokenId;
        target.burn(address(this), tokenId, 1);
    }
}

contract TxOriginAttacker {
    KyoboNFT public target;

    constructor(address _target) {
        target = KyoboNFT(_target);
    }

    function attackViaTxOrigin(uint256 tokenId) external {
        // msg.sender = TxOriginAttacker (MINTER_ROLE 없음)
        // tx.origin = 호출한 EOA
        target.mint(address(this), tokenId, 1);
        // → onlyRole(MINTER_ROLE)에서 차단됨 (msg.sender 기반)
    }
}
```

### Slither 재실행 → HIGH/MEDIUM 0건 목표

```bash
slither src/phase1/KyoboNFT.sol --exclude-dependencies

# 목표:
# HIGH: 0개
# MEDIUM: 0개 (또는 의도적 False Positive만)
```

### 전체 보안 테스트 실행

```bash
npx hardhat test test/SecurityAttackTests.sol

# 예상 결과:
# ✅ Reentrancy 공격 → 차단
# ✅ MINTER_ROLE 없음 → revert
# ✅ PAUSER_ROLE 없음 → revert
# ✅ UPGRADER_ROLE 없음 → revert
# ✅ 역할 탈취 시도 → revert
# ✅ tx.origin 공격 → 차단 (msg.sender 기반 체크)
# ✅ 0개 발행 → revert
```

---

### Slither False Positive 처리 실습

모든 LOW 항목이 실제 취약점이 아닐 수 있다. 판단 기준:

```bash
# 특정 취약점 타입만 확인
slither src/phase1/KyoboNFT.sol --detect reentrancy-eth,reentrancy-no-eth

# OZ 라이브러리 경로 제외
slither src/phase1/KyoboNFT.sol --exclude-dependencies

# 특정 탐지기 무시 (코드에 주석으로)
// slither-disable-next-line reentrancy-no-eth
function someFunction() external { ... }
```

False Positive 예시: OZ ERC1155의 `_balances` 매핑 업데이트를 Slither가 "상태 변경 후 외부 호출 없음인데 이벤트 발생" 패턴으로 오탐할 수 있다. 이 경우 코드 흐름 직접 추적 후 False Positive로 기록한다.

---

## 완료 기준

- [ ] Slither HIGH/MEDIUM 최종 0건 달성
- [ ] MEDIUM 항목 각각 수정 내용 기록 (접근 제어 / 이벤트 / 가시성)
- [ ] 이벤트 누락이 감사에 미치는 영향 설명 가능
- [ ] False Positive 식별 기준과 처리 방법 설명 가능
- [ ] 보안 테스트 5가지 질문 암기 + 각 질문에 대응하는 테스트 케이스 작성
- [ ] 공격 시나리오 테스트 전부 방어 확인 (Reentrancy / Access Control / tx.origin)
- [ ] `SecurityAttackTests.sol` 전체 테스트 PASS
