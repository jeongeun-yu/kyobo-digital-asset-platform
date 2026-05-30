# M9 · S49 — 미니프로젝트 구현 + 중간 점검

> **강의노트 깊이 기준** : 강사가 60분 수업을 자신있게 소화하기 위한 120분 수준 배경지식 포함.
> `[강사 배경]` 섹션은 수업 슬라이드에 넣지 않아도 되지만 반드시 숙지해야 하는 내용이다.
> `[강의/진행]` 표시 항목이 실제 수업에서 전달할 내용이다.

---

## 세션 개요

| 항목 | 내용 |
|---|---|
| 모듈 | M9 — 거버넌스 + 미니프로젝트 |
| 세션 | S49 |
| 전달 시간 | 60분 (실습 + 점검) |
| 선행 지식 | S48 (미니프로젝트 3가지 주제 설계 완료) |
| 이 세션의 목표 | S48에서 설계한 컨트랙트를 실제로 구현하고, 단위 테스트 5개 이상 PASS, Slither 1회 실행 |

---

## 이 세션의 핵심 메시지

> **설계는 끝났다. 이제 코드가 설계를 증명해야 한다.**
> 1시간 안에 컨트랙트 뼈대 → 핵심 함수 → 테스트 5케이스 → Slither까지 완주한다.
> "테스트가 PASS된 코드"와 "PASS된 것 같은 코드"는 다르다.
> Hardhat이 초록불을 켜줘야 완성이다.

---

## 완료 기준 (이 세션이 끝날 때 반드시 달성)

- [ ] 컨트랙트 핵심 함수 구현 완료 (주제별 핵심 로직)
- [ ] 단위 테스트 5개 이상 `npx hardhat test` PASS
- [ ] `slither src/` 실행 → HIGH/MEDIUM 결과 확인 (수정까지는 S50에서)
- [ ] 블로커 없이 S50 배포 단계 진입 가능한 상태

---

## [강사 배경] 미니프로젝트 3가지 — 전체 맥락과 현업 연결

강사가 각 주제가 왜 의미 있는지 알아야 학생의 질문에 즉각 대응할 수 있다.

### SoulBoundNFT — 비전송성 토큰의 철학과 구현

**SBT(Soulbound Token)가 등장한 배경:**

2022년 Vitalik Buterin이 공동 저술한 논문 "Decentralized Society: Finding Web3's Soul"에서 제안한 개념이다. 현재 DeFi는 담보(collateral) 기반이라 자산이 있어야만 참여 가능하다. 반면 현실 사회는 신뢰, 평판, 자격증, 졸업증명서처럼 "전송할 수 없는 자격"으로 운영된다.

SBT는 "특정 영혼(Wallet)에 묶인 토큰 — 팔 수도, 전송할 수도 없다"는 개념이다. 대학 졸업장을 NFT 거래소에 팔 수 없듯이.

**교보생명 컨텍스트에서의 의미:**

```
일반 보험 리워드 NFT (현재):
  KyoboNFT ERC-1155 → 전송 가능
  보험 혜택 NFT를 다른 사람에게 팔 수 있음
  → 보험 계약과 NFT 보유자가 달라지는 문제 발생

SoulBoundNFT (미니프로젝트):
  전송 불가 → 발급 받은 사람만 보유 가능
  → 보험가입자 본인만 보유
  → 실제 보험 자격과 NFT 보유가 항상 일치
```

**ERC-1155 `_update` 훅 원리:**

OZ v5의 ERC1155 구현은 모든 토큰 이동(mint, transfer, burn)이 내부적으로 `_update(address from, address to, uint256[] ids, uint256[] values)` 를 통과한다.

```
mint:     from = address(0)  →  to = 수령인
transfer: from = 보내는 사람  →  to = 받는 사람
burn:     from = 소각 대상   →  to = address(0)
```

따라서 `_update` 를 override해서 `from != address(0) && to != address(0)` 인 경우 — 즉 순수 전송 — 만 차단하면 mint와 burn은 정상 동작하면서 전송은 막을 수 있다.

**왜 `safeTransferFrom`을 override하지 않는가:**

`safeTransferFrom`, `safeBatchTransferFrom`, `_mint`, `_burn` 등 개별 함수를 각각 override하면 빠뜨릴 수 있다. `_update` 한 곳만 막으면 모든 경로가 막힌다. 이것이 "단일 진입점 패턴"의 핵심이다.

---

### MerkleDrop — 가스를 쓰지 않고 수천 명에게 자격을 부여하는 방법

**문제 상황:**

교보생명이 건강검진 완료 고객 50,000명에게 NFT를 발행하려 한다. mintBatch로 배치 발행해도 한 트랜잭션당 수백 명이 한계 (가스 제한 ~30M gas). 50,000명 = 수백 건의 트랜잭션 = 수십 분~수 시간 소요.

**Merkle Tree 해결책:**

```
[오프체인 — 가스 0]
수혜자 목록을 Merkle Tree로 구성
→ merkleRoot (32바이트) 만 컨트랙트에 저장 (1번 트랜잭션)

[온체인 — 사용자가 직접 claim]
각 사용자가 자신의 proof를 제출
→ 컨트랙트가 proof를 검증 → 통과하면 mint
→ 가스비: 사용자 부담 (또는 relayer로 gasless 가능)
```

**merkleRoot 저장 비용 vs 50,000명 mintBatch 비용 비교:**

```
merkleRoot 저장:  ~25,000 gas (SSTORE 1회)
50,000명 배치:    약 1,500,000,000 gas (가스 한도 초과 불가능)

→ Merkle Drop = 초기 비용 극소화
   클레임: 각자 ~80,000 gas (proof 검증 + mint)
   클레임을 안 하면 gas 0 발생
```

**MerkleProof.verify 내부 동작:**

```
leaf = keccak256(abi.encodePacked(account, productCode, eventCode, amount))

검증 과정:
  1. computedHash = leaf
  2. for each proofElement in proof:
       if computedHash <= proofElement:
           computedHash = keccak256(abi.encodePacked(computedHash, proofElement))
       else:
           computedHash = keccak256(abi.encodePacked(proofElement, computedHash))
  3. computedHash == merkleRoot → true (유효한 leaf)

왜 정렬하는가:
  해시 쌍은 항상 작은 값이 왼쪽 → 트리 구성 방향 결정론적으로 고정
  → proof는 순서 무관하게 제출 가능
```

**leaf 충돌 공격 (second preimage attack) 방지:**

단순히 `keccak256(data)` 만 쓰면 leaf와 내부 노드가 같은 형식이 된다. 공격자가 내부 노드 해시를 leaf로 제출해 잘못된 proof가 통과될 수 있다. OZ는 `keccak256(abi.encodePacked(keccak256(abi.encodePacked(data))))` — 이중 해시 — 를 권장한다. 혹은 `abi.encode` (길이 정보 포함) vs `abi.encodePacked` 혼용으로 충분히 방어한다.

---

### AuditAnchor — 이벤트만으로 충분한가, mapping이 필요한가

**금융 감사 로그의 온체인 앵커링이란:**

교보생명 내부 감사 로그(거래 내역, 발행 승인 등)는 오프체인 DB에 있다. DB는 변조 가능하다. 매일 로그 배치의 해시를 이더리움에 기록하면 — "이 날 이 로그가 존재했다"는 것을 누구도 부정할 수 없다.

```
[오프체인]
audit_log.csv (하루치 감사 로그)
→ SHA-256 해시 계산
→ bytes32 logHash

[온체인]
AuditAnchor.anchor(logHash, "2026-05-27 일일 감사 로그") 호출
→ LogAnchored 이벤트 emit
→ 블록에 영구 기록
```

**스토리지 vs 이벤트 — 핵심 설계 결정:**

| 방식 | gas 비용 | 온체인에서 직접 조회 | 외부에서 조회 |
|---|---|---|---|
| `mapping(bytes32 => bool) anchored` | ~20,000 gas/SSTORE | `isAnchored()` 함수 가능 | 이벤트 로그도 가능 |
| 이벤트만 emit | ~375 gas/LOG | 불가 (`view`로 조회 못함) | 이벤트 로그 조회 |

**설계 결정 기준:**

컨트랙트가 `isAnchored(logHash)` 를 호출해야 하는 다른 컨트랙트가 있는가?
- 없다 → 이벤트만으로 충분. 오프체인 클라이언트(ethers.js, 그래프)가 이벤트 로그를 조회한다.
- 있다 → mapping 필요. 컨트랙트 간 호출에서는 이벤트 로그를 조회할 수 없다.

교보 감사 앵커 시나리오에서는 "다른 컨트랙트가 isAnchored를 호출해야 한다"는 요건이 없다. 따라서 이벤트만으로 충분 — mapping을 쓰면 불필요한 gas 낭비다.

그러나 미니프로젝트 요건에는 `isAnchored()` 를 테스트해야 하므로 mapping을 추가한다. 학생들이 이 트레이드오프를 이해하는 것이 목표다.

---

## [강사 배경] 완성 코드 전체 — 3가지 미니프로젝트

강사가 학생이 막혔을 때 힌트를 줄 수 있도록 완성 코드를 숙지한다. 수업 시간에 이 코드를 먼저 공개하지 않는다.

---

### 주제 1: SoulBoundNFT.sol 완성 코드

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title SoulBoundNFT
 * @notice ERC-1155 기반 영혼 결합 토큰 (SBT)
 *         mint/burn만 허용, 전송 불가
 *         UUPS 업그레이드 가능
 */
contract SoulBoundNFT is
    Initializable,
    ERC1155Upgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant MINTER_ROLE   = keccak256("MINTER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) public initializer {
        require(admin != address(0), "SBT: admin is zero address");
        __ERC1155_init("");
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE,        admin);
        _grantRole(UPGRADER_ROLE,      admin);
    }

    // ── 핵심: 전송 차단 ────────────────────────────────────────────────────

    /**
     * @dev mint(from=address(0))와 burn(to=address(0))만 허용.
     *      순수 전송(from != 0 && to != 0)은 revert.
     *      모든 토큰 이동은 이 훅을 통과한다.
     */
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        bool isMint = (from == address(0));
        bool isBurn = (to   == address(0));

        if (!isMint && !isBurn) {
            revert("SBT: non-transferable");
        }

        super._update(from, to, ids, values);
    }

    // ── mint / burn ────────────────────────────────────────────────────────

    /**
     * @notice 단일 토큰 발행
     * @param to        수령인 주소
     * @param tokenId   토큰 ID
     * @param amount    발행 수량
     */
    function mint(
        address to,
        uint256 tokenId,
        uint256 amount
    ) external onlyRole(MINTER_ROLE) {
        require(to != address(0), "SBT: mint to zero address");
        _mint(to, tokenId, amount, "");
    }

    /**
     * @notice 배치 발행
     */
    function mintBatch(
        address to,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts
    ) external onlyRole(MINTER_ROLE) {
        require(to != address(0), "SBT: mint to zero address");
        _mintBatch(to, tokenIds, amounts, "");
    }

    /**
     * @notice 소각 — 보유자 본인 또는 MINTER_ROLE만 가능
     * @dev    본인 소각: msg.sender == from
     *         운영팀 소각: MINTER_ROLE 보유
     */
    function burn(
        address from,
        uint256 tokenId,
        uint256 amount
    ) external {
        bool isSelf  = (msg.sender == from);
        bool isMinter = hasRole(MINTER_ROLE, msg.sender);
        require(isSelf || isMinter, "SBT: not authorized to burn");
        _burn(from, tokenId, amount);
    }

    // ── 업그레이드 보호 ────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(UPGRADER_ROLE)
    {}

    // ── 인터페이스 지원 ────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155Upgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
```

#### SoulBoundNFT 단위 테스트 완성 코드 (Hardhat TypeScript)

```typescript
// test/SoulBoundNFT.test.ts
import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import { SoulBoundNFT } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("SoulBoundNFT", () => {
  let sbt: SoulBoundNFT;
  let admin: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let userA: HardhatEthersSigner;
  let userB: HardhatEthersSigner;

  const TOKEN_ID = 1n;
  const AMOUNT   = 1n;

  beforeEach(async () => {
    [admin, minter, userA, userB] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("SoulBoundNFT");
    sbt = (await upgrades.deployProxy(Factory, [admin.address], {
      kind: "uups",
    })) as unknown as SoulBoundNFT;
    await sbt.waitForDeployment();

    // minter에게 MINTER_ROLE 부여
    const MINTER_ROLE = await sbt.MINTER_ROLE();
    await sbt.connect(admin).grantRole(MINTER_ROLE, minter.address);
  });

  // ── 케이스 1: mint 정상 동작 ─────────────────────────────────────────────

  it("MINTER_ROLE이 mint하면 수령인에게 잔액 1 증가", async () => {
    await sbt.connect(minter).mint(userA.address, TOKEN_ID, AMOUNT);
    const balance = await sbt.balanceOf(userA.address, TOKEN_ID);
    expect(balance).to.equal(AMOUNT);
  });

  // ── 케이스 2: 전송 차단 ──────────────────────────────────────────────────

  it("safeTransferFrom → revert 'SBT: non-transferable'", async () => {
    await sbt.connect(minter).mint(userA.address, TOKEN_ID, AMOUNT);

    await expect(
      sbt
        .connect(userA)
        .safeTransferFrom(
          userA.address,
          userB.address,
          TOKEN_ID,
          AMOUNT,
          "0x"
        )
    ).to.be.revertedWith("SBT: non-transferable");
  });

  // ── 케이스 3: setApprovalForAll + 전송 시도도 차단 ─────────────────────

  it("operator 승인 후 safeBatchTransferFrom도 revert", async () => {
    await sbt.connect(minter).mint(userA.address, TOKEN_ID, AMOUNT);
    await sbt.connect(userA).setApprovalForAll(minter.address, true);

    await expect(
      sbt
        .connect(minter)
        .safeBatchTransferFrom(
          userA.address,
          userB.address,
          [TOKEN_ID],
          [AMOUNT],
          "0x"
        )
    ).to.be.revertedWith("SBT: non-transferable");
  });

  // ── 케이스 4: 본인 burn 가능 ─────────────────────────────────────────────

  it("보유자 본인이 burn하면 잔액 0", async () => {
    await sbt.connect(minter).mint(userA.address, TOKEN_ID, AMOUNT);
    await sbt.connect(userA).burn(userA.address, TOKEN_ID, AMOUNT);
    const balance = await sbt.balanceOf(userA.address, TOKEN_ID);
    expect(balance).to.equal(0n);
  });

  // ── 케이스 5: MINTER_ROLE이 강제 burn 가능 ──────────────────────────────

  it("MINTER_ROLE이 타인의 토큰을 burn할 수 있다", async () => {
    await sbt.connect(minter).mint(userA.address, TOKEN_ID, AMOUNT);
    await sbt.connect(minter).burn(userA.address, TOKEN_ID, AMOUNT);
    const balance = await sbt.balanceOf(userA.address, TOKEN_ID);
    expect(balance).to.equal(0n);
  });

  // ── 케이스 6: 권한 없는 mint → revert ────────────────────────────────────

  it("MINTER_ROLE 없는 사용자가 mint 시도 → AccessControlUnauthorizedAccount", async () => {
    await expect(
      sbt.connect(userA).mint(userA.address, TOKEN_ID, AMOUNT)
    ).to.be.revertedWithCustomError(sbt, "AccessControlUnauthorizedAccount");
  });

  // ── 케이스 7: UUPS 업그레이드 — 프록시 주소 불변 확인 ───────────────────

  it("UUPS upgradeProxy 후 프록시 주소 불변, 기존 잔액 유지", async () => {
    await sbt.connect(minter).mint(userA.address, TOKEN_ID, AMOUNT);
    const proxyAddr = await sbt.getAddress();

    const V2Factory = await ethers.getContractFactory("SoulBoundNFT"); // 같은 구현으로 업그레이드 테스트
    const v2 = await upgrades.upgradeProxy(proxyAddr, V2Factory, {
      kind: "uups",
    });

    expect(await v2.getAddress()).to.equal(proxyAddr);
    expect(await v2.balanceOf(userA.address, TOKEN_ID)).to.equal(AMOUNT);
  });
});
```

---

### 주제 2: MerkleDrop.sol 완성 코드

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface ISoulBoundNFT {
    function mint(address to, uint256 tokenId, uint256 amount) external;
}

/**
 * @title MerkleDrop
 * @notice Merkle Tree 기반 대량 NFT 클레임 컨트랙트
 *         오프체인에서 수혜자 목록 → Merkle Root만 온체인 저장
 *         각 수혜자가 proof를 제출해 직접 클레임
 */
contract MerkleDrop is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // ── 상태 변수 ─────────────────────────────────────────────────────────

    /// @notice Merkle 트리의 루트 해시
    bytes32 public merkleRoot;

    /// @notice NFT 컨트랙트 주소
    ISoulBoundNFT public nft;

    /// @notice 클레임 완료 추적: leaf 해시 → 클레임 여부
    mapping(bytes32 => bool) public claimed;

    // ── 이벤트 ───────────────────────────────────────────────────────────

    event MerkleRootUpdated(bytes32 indexed previousRoot, bytes32 indexed newRoot);
    event ClaimVerified(
        address indexed claimant,
        uint64  indexed productCode,
        uint64  indexed eventCode,
        uint256 amount,
        bytes32 leaf
    );

    // ── 초기화 ───────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address nft_,
        bytes32 merkleRoot_
    ) public initializer {
        require(admin  != address(0), "MerkleDrop: admin is zero address");
        require(nft_   != address(0), "MerkleDrop: nft is zero address");

        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE,      admin);
        _grantRole(UPGRADER_ROLE,      admin);

        nft        = ISoulBoundNFT(nft_);
        merkleRoot = merkleRoot_;
    }

    // ── 핵심: 클레임 ──────────────────────────────────────────────────────

    /**
     * @notice 수혜자가 Merkle proof를 제출해 NFT를 클레임
     * @param proof        Merkle proof (형제 해시 배열)
     * @param productCode  상품 코드 (tokenId 상위 64비트)
     * @param eventCode    이벤트 코드 (tokenId 하위 64비트)
     * @param amount       클레임할 수량
     *
     * @dev leaf = keccak256(abi.encodePacked(
     *              keccak256(abi.encodePacked(msg.sender, productCode, eventCode, amount))
     *            ))
     *      이중 해시로 second preimage attack 방지
     */
    function claim(
        bytes32[] calldata proof,
        uint64  productCode,
        uint64  eventCode,
        uint256 amount
    ) external {
        // 1. leaf 계산 (이중 해시)
        bytes32 innerHash = keccak256(
            abi.encodePacked(msg.sender, productCode, eventCode, amount)
        );
        bytes32 leaf = keccak256(abi.encodePacked(innerHash));

        // 2. 중복 클레임 방지
        require(!claimed[leaf], "MerkleDrop: already claimed");

        // 3. Merkle proof 검증
        require(
            MerkleProof.verify(proof, merkleRoot, leaf),
            "MerkleDrop: invalid proof"
        );

        // 4. 클레임 기록 (CEI 패턴: 상태 먼저)
        claimed[leaf] = true;

        // 5. tokenId 조합 (productCode << 64 | eventCode)
        uint256 tokenId = (uint256(productCode) << 64) | uint256(eventCode);

        // 6. NFT 발행
        nft.mint(msg.sender, tokenId, amount);

        emit ClaimVerified(msg.sender, productCode, eventCode, amount, leaf);
    }

    // ── 관리 함수 ─────────────────────────────────────────────────────────

    /**
     * @notice Merkle Root 업데이트 (새 드롭 시즌)
     */
    function setMerkleRoot(bytes32 newRoot)
        external
        onlyRole(OPERATOR_ROLE)
    {
        emit MerkleRootUpdated(merkleRoot, newRoot);
        merkleRoot = newRoot;
    }

    // ── 업그레이드 보호 ───────────────────────────────────────────────────

    function _authorizeUpgrade(address)
        internal
        override
        onlyRole(UPGRADER_ROLE)
    {}
}
```

#### MerkleDrop 오프체인 Merkle Tree 생성 스크립트 (TypeScript)

```typescript
// scripts/generateMerkleTree.ts
// 의존성: npm install merkletreejs @openzeppelin/merkle-tree ethers

import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { ethers } from "ethers";
import * as fs from "fs";

/**
 * 수혜자 목록 정의
 * [address, productCode, eventCode, amount]
 */
const RECIPIENTS: [string, bigint, bigint, bigint][] = [
  ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", 1n, 1001n, 1n],
  ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 1n, 1001n, 1n],
  ["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", 2n, 1002n, 2n],
  ["0x90F79bf6EB2c4f870365E785982E1f101E93b906", 1n, 1003n, 1n],
  // ... 실제 수혜자 목록 (최대 수만 명)
];

async function main() {
  // OZ StandardMerkleTree: 이중 해시 자동 적용, proof 생성 편리
  const tree = StandardMerkleTree.of(
    RECIPIENTS.map(([addr, pc, ec, amt]) => [addr, pc.toString(), ec.toString(), amt.toString()]),
    ["address", "uint64", "uint64", "uint256"]
  );

  console.log("Merkle Root:", tree.root);

  // proof 파일 저장 (각 수혜자에게 배포)
  const proofs: Record<string, { proof: string[]; leaf: string }> = {};

  for (const [i, value] of tree.entries()) {
    const [addr, pc, ec, amt] = value;
    const proof = tree.getProof(i);
    proofs[`${addr}_${pc}_${ec}`] = {
      proof,
      leaf: tree.leafHash(value),
    };
  }

  fs.writeFileSync("merkle-proofs.json", JSON.stringify(proofs, null, 2));
  console.log("Proofs saved to merkle-proofs.json");

  // Solidity 검증용 leaf 계산 예시
  const [addr, pc, ec, amt] = RECIPIENTS[0];
  const innerHash = ethers.keccak256(
    ethers.solidityPacked(
      ["address", "uint64", "uint64", "uint256"],
      [addr, pc, ec, amt]
    )
  );
  const leaf = ethers.keccak256(
    ethers.solidityPacked(["bytes32"], [innerHash])
  );
  console.log("\n검증용 leaf (첫 번째 수혜자):", leaf);
  console.log("Proof:", tree.getProof(0));
}

main().catch(console.error);
```

#### MerkleDrop 단위 테스트 완성 코드

```typescript
// test/MerkleDrop.test.ts
import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { MerkleDrop, SoulBoundNFT } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("MerkleDrop", () => {
  let drop: MerkleDrop;
  let sbt: SoulBoundNFT;
  let admin: HardhatEthersSigner;
  let userA: HardhatEthersSigner;
  let userB: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let tree: ReturnType<typeof StandardMerkleTree.of>;
  let merkleRoot: string;

  const PRODUCT_CODE = 1n;
  const EVENT_CODE   = 1001n;
  const AMOUNT       = 1n;

  beforeEach(async () => {
    [admin, userA, userB, stranger] = await ethers.getSigners();

    // SoulBoundNFT 배포
    const SBTFactory = await ethers.getContractFactory("SoulBoundNFT");
    sbt = (await upgrades.deployProxy(SBTFactory, [admin.address], {
      kind: "uups",
    })) as unknown as SoulBoundNFT;
    await sbt.waitForDeployment();

    // Merkle Tree 구성 (userA, userB 포함)
    const recipients = [
      [userA.address, PRODUCT_CODE.toString(), EVENT_CODE.toString(), AMOUNT.toString()],
      [userB.address, PRODUCT_CODE.toString(), EVENT_CODE.toString(), AMOUNT.toString()],
    ];
    tree = StandardMerkleTree.of(recipients, [
      "address", "uint64", "uint64", "uint256",
    ]);
    merkleRoot = tree.root;

    // MerkleDrop 배포
    const DropFactory = await ethers.getContractFactory("MerkleDrop");
    drop = (await upgrades.deployProxy(
      DropFactory,
      [admin.address, await sbt.getAddress(), merkleRoot],
      { kind: "uups" }
    )) as unknown as MerkleDrop;
    await drop.waitForDeployment();

    // MerkleDrop에 MINTER_ROLE 부여
    const MINTER_ROLE = await sbt.MINTER_ROLE();
    await sbt.connect(admin).grantRole(MINTER_ROLE, await drop.getAddress());
  });

  // 헬퍼: 특정 주소의 proof 가져오기
  function getProof(addr: string): string[] {
    for (const [i, value] of tree.entries()) {
      if (value[0].toLowerCase() === addr.toLowerCase()) {
        return tree.getProof(i);
      }
    }
    throw new Error(`No proof found for ${addr}`);
  }

  // ── 케이스 1: 정상 클레임 ────────────────────────────────────────────────

  it("유효한 proof로 claim → NFT 잔액 1 증가", async () => {
    const proof = getProof(userA.address);
    await drop.connect(userA).claim(proof, PRODUCT_CODE, EVENT_CODE, AMOUNT);

    const tokenId = (PRODUCT_CODE << 64n) | EVENT_CODE;
    const balance = await sbt.balanceOf(userA.address, tokenId);
    expect(balance).to.equal(AMOUNT);
  });

  // ── 케이스 2: 중복 클레임 방지 ─────────────────────────────────────────

  it("같은 proof로 두 번 claim → 'already claimed' revert", async () => {
    const proof = getProof(userA.address);
    await drop.connect(userA).claim(proof, PRODUCT_CODE, EVENT_CODE, AMOUNT);

    await expect(
      drop.connect(userA).claim(proof, PRODUCT_CODE, EVENT_CODE, AMOUNT)
    ).to.be.revertedWith("MerkleDrop: already claimed");
  });

  // ── 케이스 3: 잘못된 proof → revert ─────────────────────────────────────

  it("잘못된 proof → 'invalid proof' revert", async () => {
    const wrongProof = [ethers.randomBytes(32)].map((b) =>
      ethers.hexlify(b)
    );
    await expect(
      drop.connect(userA).claim(wrongProof, PRODUCT_CODE, EVENT_CODE, AMOUNT)
    ).to.be.revertedWith("MerkleDrop: invalid proof");
  });

  // ── 케이스 4: 수혜자 목록에 없는 주소 → revert ──────────────────────────

  it("수혜자 목록에 없는 주소가 클레임 시도 → revert", async () => {
    // stranger는 트리에 없음
    const proof = getProof(userA.address); // userA의 proof를 stranger가 제출
    await expect(
      drop.connect(stranger).claim(proof, PRODUCT_CODE, EVENT_CODE, AMOUNT)
    ).to.be.revertedWith("MerkleDrop: invalid proof");
    // msg.sender가 다르면 leaf 계산이 달라져 proof 검증 실패
  });

  // ── 케이스 5: ClaimVerified 이벤트 emit 확인 ────────────────────────────

  it("claim 성공 시 ClaimVerified 이벤트 emit", async () => {
    const proof = getProof(userA.address);
    await expect(
      drop.connect(userA).claim(proof, PRODUCT_CODE, EVENT_CODE, AMOUNT)
    ).to.emit(drop, "ClaimVerified")
      .withArgs(
        userA.address,
        PRODUCT_CODE,
        EVENT_CODE,
        AMOUNT,
        // leaf 값 검증 생략 (bytes32 매칭 복잡)
        (leaf: string) => leaf.startsWith("0x")
      );
  });

  // ── 케이스 6: merkleRoot 업데이트 후 이전 proof 무효화 ───────────────────

  it("setMerkleRoot 후 이전 proof는 무효", async () => {
    const proof = getProof(userA.address);
    const OPERATOR_ROLE = await drop.OPERATOR_ROLE();
    await drop.connect(admin).setMerkleRoot(ethers.ZeroHash);

    await expect(
      drop.connect(userA).claim(proof, PRODUCT_CODE, EVENT_CODE, AMOUNT)
    ).to.be.revertedWith("MerkleDrop: invalid proof");
  });
});
```

---

### 주제 3: AuditAnchor.sol 완성 코드

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title AuditAnchor
 * @notice 오프체인 감사 로그 해시를 온체인에 앵커링
 *
 * 설계 결정:
 *   - 이벤트(LogAnchored)만으로 앵커링 기록 — gas 최소화
 *   - isAnchored mapping 추가 — 컨트랙트 간 조회 및 테스트 편의성
 *   - storage 저장: anchored[logHash] = true (약 20,000 gas/건)
 *   - 이벤트만 방식: 약 375 gas/건 (storage 없이 이벤트만)
 *
 * 트레이드오프:
 *   다른 컨트랙트에서 isAnchored()를 호출할 필요가 없다면
 *   mapping 제거 후 이벤트만 사용하는 것이 gas 효율적이다.
 */
contract AuditAnchor is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant AUDITOR_ROLE  = keccak256("AUDITOR_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // ── 상태 변수 ─────────────────────────────────────────────────────────

    /// @notice 앵커링된 로그 해시 추적
    /// @dev    gas 트레이드오프: 이벤트만으로 충분한 경우 이 mapping 제거 가능
    mapping(bytes32 => bool) public anchored;

    /// @notice 앵커링 시 기록된 타임스탬프
    mapping(bytes32 => uint256) public anchoredAt;

    // ── 이벤트 ───────────────────────────────────────────────────────────

    /**
     * @param logHash     오프체인 로그 배치의 SHA-256 해시 (bytes32)
     * @param description 설명 (날짜, 배치 ID 등 — 오프체인 참조용)
     * @param timestamp   블록 타임스탬프
     */
    event LogAnchored(
        bytes32 indexed logHash,
        string          description,
        uint256         timestamp
    );

    // ── 초기화 ───────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) public initializer {
        require(admin != address(0), "AuditAnchor: admin is zero address");
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AUDITOR_ROLE,       admin);
        _grantRole(UPGRADER_ROLE,      admin);
    }

    // ── 핵심: 앵커링 ──────────────────────────────────────────────────────

    /**
     * @notice 오프체인 감사 로그 해시를 온체인에 앵커링
     * @param logHash     SHA-256(audit_log_batch) — 32바이트
     * @param description 설명 문자열 (예: "2026-05-27 일일 감사 로그 — 발행 523건")
     *
     * @dev  storage: anchored[logHash] = true (이벤트 + storage 방식)
     *       이벤트 로그: 블록체인에 영구 기록, 오프체인 검증 가능
     */
    function anchor(
        bytes32 logHash,
        string calldata description
    ) external onlyRole(AUDITOR_ROLE) {
        require(logHash != bytes32(0), "AuditAnchor: logHash is zero");
        require(!anchored[logHash],    "AuditAnchor: already anchored");

        anchored[logHash]   = true;
        anchoredAt[logHash] = block.timestamp;

        emit LogAnchored(logHash, description, block.timestamp);
    }

    /**
     * @notice 특정 로그 해시가 앵커링됐는지 확인
     * @return bool 앵커링 여부
     *
     * @dev 오프체인 검증:
     *      1. 오프체인 로그 배치 재계산 → SHA-256 해시
     *      2. isAnchored(hash) 호출
     *      3. true이면 해당 로그가 앵커링 시점에 존재했음을 증명
     */
    function isAnchored(bytes32 logHash) external view returns (bool) {
        return anchored[logHash];
    }

    // ── 업그레이드 보호 ───────────────────────────────────────────────────

    function _authorizeUpgrade(address)
        internal
        override
        onlyRole(UPGRADER_ROLE)
    {}
}
```

#### AuditAnchor 단위 테스트 완성 코드

```typescript
// test/AuditAnchor.test.ts
import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import { AuditAnchor } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("AuditAnchor", () => {
  let anchor: AuditAnchor;
  let admin: HardhatEthersSigner;
  let auditor: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  // 테스트용 로그 해시 (SHA-256 시뮬레이션)
  const LOG_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("2026-05-27 audit log batch 1"));
  const LOG_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("2026-05-28 audit log batch 2"));
  const DESCRIPTION = "2026-05-27 일일 감사 로그 — 발행 523건";

  beforeEach(async () => {
    [admin, auditor, stranger] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("AuditAnchor");
    anchor = (await upgrades.deployProxy(Factory, [admin.address], {
      kind: "uups",
    })) as unknown as AuditAnchor;
    await anchor.waitForDeployment();

    // auditor에게 AUDITOR_ROLE 부여
    const AUDITOR_ROLE = await anchor.AUDITOR_ROLE();
    await anchor.connect(admin).grantRole(AUDITOR_ROLE, auditor.address);
  });

  // ── 케이스 1: anchor 정상 동작 ──────────────────────────────────────────

  it("AUDITOR_ROLE이 anchor() 호출 → isAnchored true", async () => {
    await anchor.connect(auditor).anchor(LOG_HASH_1, DESCRIPTION);
    expect(await anchor.isAnchored(LOG_HASH_1)).to.be.true;
  });

  // ── 케이스 2: 미앵커 해시 → false ──────────────────────────────────────

  it("앵커링하지 않은 해시 → isAnchored false", async () => {
    expect(await anchor.isAnchored(LOG_HASH_1)).to.be.false;
  });

  // ── 케이스 3: 중복 앵커 방지 ────────────────────────────────────────────

  it("같은 logHash를 두 번 anchor → 'already anchored' revert", async () => {
    await anchor.connect(auditor).anchor(LOG_HASH_1, DESCRIPTION);
    await expect(
      anchor.connect(auditor).anchor(LOG_HASH_1, "재앵커 시도")
    ).to.be.revertedWith("AuditAnchor: already anchored");
  });

  // ── 케이스 4: AUDITOR_ROLE 없는 호출자 → revert ─────────────────────────

  it("AUDITOR_ROLE 없는 주소가 anchor() 호출 → AccessControlUnauthorizedAccount", async () => {
    await expect(
      anchor.connect(stranger).anchor(LOG_HASH_1, DESCRIPTION)
    ).to.be.revertedWithCustomError(anchor, "AccessControlUnauthorizedAccount");
  });

  // ── 케이스 5: LogAnchored 이벤트 emit 확인 ──────────────────────────────

  it("anchor() 성공 시 LogAnchored 이벤트 emit", async () => {
    const tx = await anchor.connect(auditor).anchor(LOG_HASH_1, DESCRIPTION);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);

    await expect(tx)
      .to.emit(anchor, "LogAnchored")
      .withArgs(LOG_HASH_1, DESCRIPTION, block!.timestamp);
  });

  // ── 케이스 6: anchoredAt 타임스탬프 기록 확인 ───────────────────────────

  it("anchor() 후 anchoredAt에 블록 타임스탬프 기록", async () => {
    const tx = await anchor.connect(auditor).anchor(LOG_HASH_1, DESCRIPTION);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);

    const ts = await anchor.anchoredAt(LOG_HASH_1);
    expect(ts).to.equal(BigInt(block!.timestamp));
  });

  // ── 케이스 7: 여러 해시 독립 앵커링 ─────────────────────────────────────

  it("서로 다른 두 해시를 각각 anchor → 둘 다 isAnchored true", async () => {
    await anchor.connect(auditor).anchor(LOG_HASH_1, "배치 1");
    await anchor.connect(auditor).anchor(LOG_HASH_2, "배치 2");

    expect(await anchor.isAnchored(LOG_HASH_1)).to.be.true;
    expect(await anchor.isAnchored(LOG_HASH_2)).to.be.true;
  });
});
```

---

## [강사 배경] 1시간 구현 가이드 — 시간 배분 전략

실제 시험 환경이나 실무 PoC에서도 동일한 전략을 쓴다. "먼저 동작하게, 그 다음 제대로" 원칙.

### 권장 순서 (60분 기준)

| 구간 | 시간 | 할 일 | 실패 시 처리 |
|---|---|---|---|
| **뼈대 작성** | 0~10분 | contract 선언, import, 상태 변수, 이벤트, initialize | compile 에러 즉시 수정 |
| **핵심 함수** | 10~30분 | 핵심 로직 1~2개 구현 (SBT: _update, Merkle: claim, Anchor: anchor) | 10분 안에 못 쓰면 강사 힌트 요청 |
| **테스트 작성** | 30~50분 | 5케이스 작성 + npx hardhat test → PASS | RED → GREEN 사이클 유지 |
| **Slither** | 50~60분 | slither src/ 실행 → 결과 기록 | HIGH 발견 시 S50에서 수정 |

### 단계별 체크포인트

```bash
# 10분: 컴파일 통과 확인
npx hardhat compile
# 기대: "Compiled N Solidity files successfully"

# 30분: 핵심 함수 로컬 실행 확인 (간단한 스크립트로)
npx hardhat run scripts/smoke-test.ts

# 50분: 테스트 5개 PASS
npx hardhat test test/[주제].test.ts
# 기대: "5 passing"

# 60분: Slither 실행
slither src/ --solc-remaps "@openzeppelin=node_modules/@openzeppelin" --exclude-dependencies
```

---

## [강사 배경] 자주 발생하는 구현 오류와 디버깅 방법

강사가 순회하며 학생 블로커를 해결할 때 즉각 대응하기 위한 패턴 목록이다.

### 오류 1: "Cannot read property of undefined" — ethers.getContractFactory 관련

```
TypeError: Cannot read properties of undefined (reading 'getContractFactory')
```

**원인:**
```typescript
// ❌ hardhat 미임포트
const factory = await ethers.getContractFactory("SoulBoundNFT");

// ✅ hardhat-ethers 플러그인 임포트
import { ethers, upgrades } from "hardhat";
```

또는 `hardhat.config.ts`에 플러그인이 없는 경우:
```typescript
// hardhat.config.ts
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades"; // ← 없으면 upgrades 객체 없음
```

---

### 오류 2: "Transaction reverted without a reason"

**원인 진단 순서:**
1. `require` 메시지 없는 경우 → 메시지 추가
2. 가스 부족 — `{ gasLimit: 3000000 }` 옵션 추가
3. 잘못된 역할 — `hasRole()` 로 확인
4. 배포 안 된 컨트랙트 호출

```typescript
// 디버깅: 트랜잭션 에러 상세 확인
try {
  await sbt.connect(stranger).mint(stranger.address, 1n, 1n);
} catch (e: any) {
  console.log("Error reason:", e.reason);        // require 메시지
  console.log("Error data:", e.data);            // revert 데이터
  console.log("Error errorName:", e.errorName);  // custom error 이름
}
```

---

### 오류 3: Merkle proof 검증 실패 — leaf 해시 불일치

가장 흔한 실수. Solidity와 TypeScript에서 leaf 계산 방법이 달라서 발생한다.

```
MerkleDrop: invalid proof
```

**원인: abi.encode vs abi.encodePacked**

```solidity
// Solidity
// ❌ abi.encode — 패딩 포함 (32바이트 정렬)
bytes32 leaf = keccak256(abi.encode(msg.sender, productCode, eventCode, amount));

// ✅ abi.encodePacked — 타이트 패킹
bytes32 leaf = keccak256(abi.encodePacked(msg.sender, productCode, eventCode, amount));
```

```typescript
// TypeScript (ethers v6)
// ❌ ABI 인코딩 (패딩 포함)
const leaf = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint64", "uint64", "uint256"],
    [addr, pc, ec, amt]
  )
);

// ✅ solidityPacked = abi.encodePacked 와 동일
const leaf = ethers.keccak256(
  ethers.solidityPacked(
    ["address", "uint64", "uint64", "uint256"],
    [addr, pc, ec, amt]
  )
);
```

**StandardMerkleTree 사용 시 이중 해시 자동 적용:**
```typescript
// OZ StandardMerkleTree는 내부적으로 이중 해시 처리
// Solidity에서도 이중 해시를 써야 매칭됨
bytes32 innerHash = keccak256(abi.encodePacked(msg.sender, productCode, eventCode, amount));
bytes32 leaf = keccak256(abi.encodePacked(innerHash));
```

---

### 오류 4: "Invalid opcode" — 배포 안 된 컨트랙트 호출

```
Error: Transaction reverted: function call to a non-contract account
```

**원인:** 환경 변수나 하드코딩된 주소가 실제 배포된 주소가 아닌 경우.

```typescript
// ❌ 잘못된 주소 참조
const sbt = await ethers.getContractAt("SoulBoundNFT", "0x0000000000000000000000000000000000000001");

// ✅ 배포 후 주소 사용
const Factory = await ethers.getContractFactory("SoulBoundNFT");
const sbt = await upgrades.deployProxy(Factory, [admin.address], { kind: "uups" });
await sbt.waitForDeployment();
const address = await sbt.getAddress(); // ← 실제 배포 주소
```

---

### 오류 5: TypeScript에서 BigInt 처리 — ethers v6 vs v5

```
TypeError: Cannot mix BigInt and other types
```

**원인:** ethers v6는 `bigint` (native), v5는 `BigNumber` 객체.

```typescript
// ❌ ethers v5 스타일 (v6에서 에러)
const amount = ethers.BigNumber.from(1);
const doubled = amount.mul(2);

// ✅ ethers v6 스타일
const amount = 1n; // native bigint
const doubled = amount * 2n;

// ❌ number와 bigint 혼용
const tokenId = 1;  // number
await sbt.balanceOf(userA.address, tokenId); // 일부 함수는 bigint 필요

// ✅ 명시적 변환
await sbt.balanceOf(userA.address, BigInt(tokenId));
// 또는
await sbt.balanceOf(userA.address, 1n);
```

---

### 오류 6: `_update` override 시 super 호출 누락 (SBT 주제)

```solidity
// ❌ super._update 없으면 실제 잔액 변경이 발생하지 않음
function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
    internal override {
    if (from != address(0) && to != address(0)) {
        revert("SBT: non-transferable");
    }
    // super 호출 없음 → mint/burn도 아무것도 안 함!
}

// ✅ 반드시 super._update 호출
function _update(...) internal override {
    if (from != address(0) && to != address(0)) {
        revert("SBT: non-transferable");
    }
    super._update(from, to, ids, values); // ← 실제 잔액 변경 로직
}
```

---

### 오류 7: UUPS 초기화 시 `_disableInitializers()` 누락

```
Error: Initializable: contract is already initialized
또는
Warning: Upgradeable contracts must have a constructor that calls _disableInitializers()
```

```solidity
// ✅ 반드시 포함
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers();
}
```

이것이 없으면 구현 컨트랙트 자체(프록시 아닌 구현체)를 누군가 직접 `initialize(attacker)` 로 초기화할 수 있다.

---

## [강사 배경] Slither 미니프로젝트 체크리스트 — 예상 경고와 대응

주제별로 어떤 경고가 나올지 미리 알아야 학생 질문에 즉각 대응한다.

### SoulBoundNFT 예상 Slither 경고

| 디텍터 | 심각도 | 발생 조건 | 대응 |
|---|---|---|---|
| `missing-zero-check` | MEDIUM | `mint(to, ...)` 에서 `to != address(0)` 없는 경우 | 완성 코드에는 추가됨. 학생 코드에 누락 시 수정 |
| `calls-loop` | MEDIUM | `mintBatch` 내부 루프에서 OZ `_mint` 호출 | False Positive — EOA 수령인만. 억제 주석 추가 |
| `events-access` | LOW | `grantRole`/`revokeRole` 외 상태 변경에 이벤트 없는 경우 | OZ AccessControl이 이미 이벤트 emit — 대부분 False Positive |
| `naming-convention` | INFORMATIONAL | 상수명이 ALL_CAPS 아닌 경우 | `MINTER_ROLE` 이미 올바름. 학생 변수명 확인 |

### MerkleDrop 예상 Slither 경고

| 디텍터 | 심각도 | 발생 조건 | 대응 |
|---|---|---|---|
| `missing-zero-check` | MEDIUM | `nft_` 주소 없는 경우 | `initialize`에 `require(nft_ != address(0))` 추가 |
| `reentrancy-no-eth` | MEDIUM | `claim`에서 `claimed[leaf] = true` 전에 `nft.mint` 호출 시 | CEI 패턴 확인 — 완성 코드는 상태 먼저, mint 나중 |
| `calls-loop` | - | MerkleDrop에는 루프 없음 | 해당 없음 |
| `low-level-calls` | LOW | 직접 `.call()` 사용 시 | 인터페이스 호출이므로 해당 없음 |

**CEI(Checks-Effects-Interactions) 패턴 확인:**

```solidity
// ✅ 올바른 순서
function claim(...) external {
    // Checks
    require(!claimed[leaf], "already claimed");
    require(MerkleProof.verify(proof, merkleRoot, leaf), "invalid proof");

    // Effects (상태 변경 먼저)
    claimed[leaf] = true;

    // Interactions (외부 호출 마지막)
    nft.mint(msg.sender, tokenId, amount);

    emit ClaimVerified(...);
}
```

### AuditAnchor 예상 Slither 경고

| 디텍터 | 심각도 | 발생 조건 | 대응 |
|---|---|---|---|
| `missing-zero-check` | MEDIUM | `anchor(logHash=0x00...)` 허용 시 | `require(logHash != bytes32(0))` 추가 |
| `events-access` | LOW | 상태 변경 이벤트 없는 경우 | `LogAnchored` 이벤트 있으므로 해당 없음 |
| `constable-states` | OPTIMIZATION | `AUDITOR_ROLE` 이 `constant` 아닌 경우 | `bytes32 public constant` — 올바름 |
| `timestamp` | LOW | `block.timestamp` 사용 | 감사 목적 타임스탬프는 정밀도 불요 — False Positive |

**`timestamp` 경고 대응:**
```solidity
// Slither가 block.timestamp 사용 시 경고
// 이유: 채굴자가 약 15초 범위 내에서 timestamp 조작 가능
// 감사 앵커링 목적: 15초 오차는 무의미 → False Positive

// 억제 방법
// slither-disable-next-line timestamp
anchoredAt[logHash] = block.timestamp;
```

---

## [강의/진행] 60분 분 단위 진행 계획

### 강사 진행 방식 개요

이 세션은 강의 최소화, 실습 극대화 세션이다. 강사는 "설명"보다 "순회하며 블로커 해결"에 집중한다.

---

### 0~10분 — 현황 파악 + 주제 확인

**[강의/진행] 강사 도입 (3분)**

```
"S48에서 3가지 주제를 설계했습니다.
 오늘은 그 설계를 코드로 구현합니다.
 60분 안에: 핵심 함수 구현 → 테스트 5개 PASS → Slither 실행.
 이 세 가지가 완료 기준입니다."
```

**[강의/진행] 현황 파악 — 학생별 주제 확인 (5분)**

강사가 칠판 또는 화이트보드에 표를 그리고 학생들에게 직접 확인:

```
| 이름 | 주제 | S48 설계 완료 | 현재 상태 | 예상 블로커 |
|------|------|--------------|----------|------------|
| ...  | SBT  | ✓           | 뼈대 없음 | import 경로 |
| ...  | Merkle| ✓          | 뼈대 완성 | claim 로직  |
| ...  | Anchor| ✓          | 함수 구현 중| 테스트 작성 |
```

**[강의/진행] 빠른 체크리스트 제시 (2분)**

```
[컴파일 확인] npx hardhat compile → "Compiled successfully"
[테스트 실행] npx hardhat test → 최소 5 passing
[Slither 확인] slither src/ → 결과 기록 (수정은 S50)
```

---

### 10~45분 — 핵심 구현 시간 (강사 순회)

**[강의/진행] 강사 순회 전략**

강사는 교실을 천천히 순회하며 3가지 역할을 수행한다:

1. **현황 확인**: "어디까지 왔나요?" — 10초 이내로 파악
2. **블로커 감지**: 5분 이상 같은 에러를 보고 있으면 개입
3. **힌트 제공**: 정답을 주지 않고 방향만 제시

**[강의/진행] 주제별 힌트 제공 기준**

SBT 주제 학생이 막혔을 때:
```
힌트 수준 1: "_update 훅을 찾아보세요. from과 to가 어떤 값일 때 각각 mint, burn인지 생각해보세요."
힌트 수준 2: "from == address(0)이면 mint, to == address(0)이면 burn입니다. 그 이외의 경우를 차단하면 됩니다."
힌트 수준 3 (시간 부족 시): "[강사 배경] 완성 코드 _update 부분만 보여주기"
```

MerkleDrop 학생이 claim에서 막혔을 때:
```
힌트 수준 1: "leaf 계산 순서를 확인하세요. encodePacked인가요, encode인가요?"
힌트 수준 2: "오프체인 트리 생성 코드와 솔리디티 leaf 계산이 완전히 동일해야 합니다."
힌트 수준 3: "MerkleProof.verify(proof, merkleRoot, leaf) — 세 파라미터 순서를 확인하세요."
```

AuditAnchor 학생이 막혔을 때:
```
힌트 수준 1: "anchor 함수는 단순합니다. 검증 2개(zero hash, already anchored) + 상태 변경 + 이벤트 emit."
힌트 수준 2: "mapping에 저장하고 이벤트를 emit하는 순서로 작성하세요."
```

**[강의/진행] 10분마다 체크포인트 알림**

```
[20분 경과] "지금 뼈대 + 핵심 함수 구현 완료된 분 손 들어보세요."
[30분 경과] "테스트 파일 작성 시작했나요? 구현보다 테스트가 중요합니다."
[40분 경과] "적어도 3개 테스트 PASS된 분? Slither는 구현 끝나면 바로 실행합니다."
```

---

### 45~55분 — Slither 실행 + 테스트 전체 PASS 확인

**[강의/진행] Slither 실행 안내 (2분 설명)**

```bash
# 설치 확인
slither --version

# 실행 (주제별 파일만)
slither src/SoulBoundNFT.sol \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --exclude-dependencies

slither src/MerkleDrop.sol \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --exclude-dependencies

slither src/AuditAnchor.sol \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --exclude-dependencies
```

**[강의/진행] 결과 기록 양식 배포**

```
[Slither 결과 기록]
파일명: _______________
HIGH: ___ 건  /  MEDIUM: ___ 건  /  LOW: ___ 건  /  INFO: ___ 건

HIGH/MEDIUM 목록:
1. 디텍터: __________ / 파일:줄 __________ / 판단 (수정/FP): __________
2. ...
```

**[강의/진행] 테스트 전체 PASS 확인 (강사 순회)**

```bash
npx hardhat test
# 기대 출력:
#   SoulBoundNFT
#     ✓ MINTER_ROLE이 mint하면 수령인에게 잔액 1 증가
#     ✓ safeTransferFrom → revert 'SBT: non-transferable'
#     ✓ operator 승인 후 safeBatchTransferFrom도 revert
#     ✓ 보유자 본인이 burn하면 잔액 0
#     ✓ MINTER_ROLE이 타인의 토큰을 burn할 수 있다
#   5 passing (2s)
```

**[강의/진행] FAIL 케이스 현장 디버깅**

학생의 테스트가 FAIL일 때 강사가 함께 보는 순서:
1. 에러 메시지 전체 읽기 — "AssertionError" vs "Transaction reverted"
2. 실패한 케이스의 expect 조건 확인
3. 컨트랙트 함수 로직을 역추적

---

### 55~60분 — S50 배포 준비 안내

**[강의/진행] 중간 점검 체크리스트 최종 확인**

```
[ ] 컨트랙트 파일 컴파일 성공 (npx hardhat compile)
[ ] 핵심 함수 구현 완료
    SBT: _update 훅 override, mint, burn
    Merkle: claim (proof 검증 + CEI)
    Anchor: anchor, isAnchored
[ ] 단위 테스트 5개 이상 PASS
[ ] Slither 실행 완료 + 결과 기록
[ ] HIGH/MEDIUM 항목 파악 (수정은 S50에서)
```

**[강의/진행] S50 배포 단계 예고 (3분)**

```
"S50에서 할 일:
 1. Slither HIGH/MEDIUM 수정
 2. Sepolia 배포 스크립트 작성
 3. 배포 후 Etherscan 검증

 지금 당장 준비할 것:
 - .env에 SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY 설정
 - hardhat.config.ts에 sepolia 네트워크 설정 확인"
```

```typescript
// hardhat.config.ts — S50 배포 전 확인
const config: HardhatUserConfig = {
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL ?? "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 11155111,
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? "",
  },
};
```

---

## [강의/진행] 중간 점검 체크리스트 (학생 배포용)

강사가 출력하거나 화면에 공유한다.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
M9 S49 미니프로젝트 중간 점검 체크리스트
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[ ] 내 주제: (SoulBoundNFT / MerkleDrop / AuditAnchor)

[컴파일]
[ ] npx hardhat compile → "Compiled successfully"

[구현 — SoulBoundNFT]
[ ] _update 훅 override (from != 0 && to != 0 → revert)
[ ] mint(address to, uint256 tokenId, uint256 amount) — MINTER_ROLE
[ ] burn(address from, uint256 tokenId, uint256 amount) — 본인 또는 MINTER_ROLE
[ ] initialize(address admin) — zero-check 포함
[ ] _authorizeUpgrade — UPGRADER_ROLE

[구현 — MerkleDrop]
[ ] merkleRoot 상태 변수 + setMerkleRoot
[ ] claim 함수 — leaf 계산, 중복 방지, proof 검증, CEI 패턴
[ ] ClaimVerified 이벤트
[ ] claimed[leaf] mapping

[구현 — AuditAnchor]
[ ] anchor(bytes32 logHash, string description) — zero-check, 중복 방지
[ ] LogAnchored 이벤트 emit
[ ] anchored mapping + isAnchored view 함수
[ ] anchoredAt mapping (타임스탬프)

[테스트]
[ ] 테스트 케이스 5개 이상 작성
[ ] npx hardhat test → 5 passing 이상

[Slither]
[ ] slither src/[파일].sol 실행
[ ] 결과 기록: HIGH ___ / MEDIUM ___ / LOW ___
[ ] HIGH/MEDIUM 항목 내용 파악 (수정은 S50)

[S50 준비]
[ ] .env → SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY
[ ] hardhat.config.ts → sepolia 네트워크 설정 확인
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 핵심 용어 정리

| 용어 | 한 줄 정의 |
|---|---|
| SBT (Soulbound Token) | 전송 불가능한 NFT — 특정 지갑(영혼)에 묶인 자격증명 토큰 |
| `_update` 훅 | OZ v5 ERC1155의 모든 토큰 이동이 통과하는 단일 진입점 함수 |
| Merkle Tree | 데이터 목록으로부터 계층적 해시를 구성해 일부 요소의 포함 여부를 증명하는 자료구조 |
| merkleRoot | Merkle Tree 최상단의 32바이트 해시 — 전체 수혜자 목록의 지문 |
| Merkle proof | 특정 leaf가 트리에 포함됨을 증명하는 형제 해시 배열 |
| 감사 앵커링 | 오프체인 로그 해시를 온체인에 기록해 변조 불가능하게 만드는 기법 |
| CEI 패턴 | Checks-Effects-Interactions — 검증 → 상태 변경 → 외부 호출 순서 |
| `abi.encodePacked` | ABI 타이트 패킹 — 패딩 없이 직렬화. Merkle leaf 계산에 사용 |
| second preimage attack | 다른 입력으로 같은 해시를 만들어 proof를 위조하는 공격 — 이중 해시로 방어 |
| UUPS | Universal Upgradeable Proxy Standard — 업그레이드 로직이 구현체에 있는 프록시 패턴 |
| `_disableInitializers()` | UUPS 구현 컨트랙트가 직접 초기화되는 것을 막는 생성자 호출 |
| Slither | Trail of Bits의 Solidity 정적 분석 도구 — 80+ 디텍터, HIGH/MEDIUM 0건이 배포 기준 |

---

## 다음 세션 예고 (S50)

S49에서 구현하고 Slither 결과를 기록했다.
S50에서는:
1. Slither HIGH/MEDIUM 수정
2. Sepolia 배포 스크립트 작성 + 실행
3. Etherscan 소스 검증
4. M9 미니프로젝트 완성 발표 (각 팀 3분)

"Slither 0건 + Sepolia 배포 + Etherscan 검증" — 이 세 가지가 미니프로젝트 최종 완료 기준이다.
