# M9 S48 — 미니프로젝트 설계 발표

> 모듈 9 · 세션 48 · 60분 (발표 + 피드백)
> 강의 형태: 발표 중심 / 강사 피드백 + 실현 가능성 검토

---

## 세션 개요

이 세션은 수강생이 직접 설계한 미니프로젝트를 발표하고 강사 피드백을 받는 세션이다. 코딩보다 **설계의 타당성**을 검토하는 것이 핵심이다. S49(다음 세션)에서 실제로 구현할 수 있는 범위를 이 세션에서 확정한다.

**수강생이 선택할 수 있는 세 가지 주제:**

| 주제 | 난이도 | 핵심 개념 |
|------|--------|-----------|
| A. NFT 전송 제한 (SoulBound) | ★★☆ | _update 훅 override, ERC-5192 |
| B. Merkle-drop 발행 | ★★★ | Merkle Tree, MerkleProof.verify() |
| C. 감사 로그 온체인 앵커 | ★★☆ | keccak256 해시 앵커, event 기록 |

---

# [강사 배경]

> 이 섹션은 수강생에게 공개하지 않는다. 강사가 내부적으로 숙지해야 할 기술 깊이와 피드백 판단 기준이 담겨 있다. 50분 수업을 자신 있게 소화하려면 120분 수준의 배경지식이 필요하다.

---

## 배경 1 — Phase 1 시스템 전체 맥락 재점검

수강생이 새 기능을 설계할 때, 강사는 **기존 시스템과의 충돌 여부**를 즉각 판단할 수 있어야 한다.

### KyoboNFT.sol 핵심 구조 재정리

```
KyoboNFT (UUPS Proxy)
├── ERC-1155Upgradeable      ← 다중 토큰 표준
├── AccessControlUpgradeable ← MINTER_ROLE / PAUSER_ROLE / UPGRADER_ROLE
├── PausableUpgradeable      ← 긴급 정지
└── UUPSUpgradeable          ← 업그레이드 패턴

tokenId = (productCode << 64) | eventCode
  productCode : uint64 (상품 종류 — 0x01 걷기, 0x02 건강검진, ...)
  eventCode   : uint64 (세부 이벤트 번호 또는 쿠폰 시퀀스)

_update() 훅:
  현재: whenNotPaused 체크만 수행
  → 전송 제한 기능은 여기에 추가 로직을 삽입하면 된다
```

### NFTIssuer.sol 핵심 구조 재정리

```
NFTIssuer (일반 컨트랙트)
├── AccessControl            ← OPERATOR_ROLE
├── ReentrancyGuard          ← nonReentrant
├── issued[requestId] 매핑   ← Idempotency key
└── MAX_BATCH_SIZE = 500     ← 가스 한도 기준

발행 경로:
  오프체인 서버 → NFTIssuer.issueNFT() / issueBatch()
                → KyoboNFT.mint() / mintBatch()
                → Issued 이벤트 emit
```

**강사가 즉시 판단해야 하는 것:** 수강생이 새 기능을 추가할 때 어느 컨트랙트에 손을 대는지, 그리고 UUPS 스토리지 레이아웃을 건드리는지 여부.

---

## 배경 2 — 주제 A: NFT 전송 제한 (SoulBound Token) 기술 깊이

### 2-1. SBT의 배경 — Vitalik의 2022년 논문

2022년 5월, Vitalik Buterin, E. Glen Weyl, Puja Ohlhaver 세 명이 "Decentralized Society: Finding Web3's Soul"이라는 논문을 발표했다. 핵심 주장은 다음과 같다:

> "Web3의 진정한 가치는 금융 자산의 이전이 아니라 **개인의 정체성·역량·귀속**을 표현하는 데 있다."

이 맥락에서 SBT(SoulBound Token)는 특정 개인(지갑 = Soul)에 귀속되어 **양도 불가능**한 NFT다.

**교보생명 맥락에서 SBT가 왜 의미 있는가:**

보험 NFT는 개인 귀속 자산이다. 보험 계약자가 자신의 NFT를 타인에게 팔거나 이전하면 다음 문제가 생긴다:
- 보험 사기: 보험 혜택을 타인이 수령
- 규제 위반: 개인 금융 상품의 무단 양도
- 데이터 불일치: 오프체인 DB의 가입자 기록과 온체인 보유자가 달라짐

따라서 **보험 상품 관련 NFT(productCode = 0x01, 0x02 등)는 전송 금지**하고, 쿠폰성 NFT(productCode = 0x10 등)는 일부 허용하는 구조가 비즈니스 요구사항에 부합한다.

### 2-2. ERC-5192 표준

ERC-5192는 "Minimal Soulbound NFT Interface"다. ERC-721 위에 최소한의 인터페이스를 추가한다.

```solidity
// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.0;

interface IERC5192 {
    /// @notice 토큰이 잠겨 있을 때 발생 (전송 불가 상태)
    event Locked(uint256 tokenId);
    
    /// @notice 토큰이 잠금 해제될 때 발생 (전송 가능 상태)
    event Unlocked(uint256 tokenId);

    /// @notice 토큰이 전송 잠금 상태인지 반환
    function locked(uint256 tokenId) external view returns (bool);
}
```

ERC-5192는 ERC-721 기반이지만, **ERC-1155에서 동일 개념을 적용**하는 방법을 강사는 알고 있어야 한다. ERC-1155에는 단일 토큰 ID를 대량 발행하는 구조이므로, tokenId 단위 잠금보다 **productCode 단위 잠금**이 더 실용적이다.

### 2-3. ERC-1155에서 전송 제한 구현 — _update 훅

OpenZeppelin ERC-1155Upgradeable는 내부 전송을 `_update()` 함수 하나로 처리한다. 현재 KyoboNFT.sol의 `_update`는 pausable 체크만 한다:

```solidity
// 현재 KyoboNFT._update (M8까지의 구현)
function _update(
    address from,
    address to,
    uint256[] memory ids,
    uint256[] memory values
) internal override whenNotPaused {
    super._update(from, to, ids, values);
}
```

`from == address(0)`: 민팅
`to == address(0)`: 소각
`from != address(0) && to != address(0)`: **일반 전송 (이것만 막으면 된다)**

```solidity
// 확장된 _update — 전송 제한 포함
function _update(
    address from,
    address to,
    uint256[] memory ids,
    uint256[] memory values
) internal override whenNotPaused {
    // 민팅(from=0)과 소각(to=0)은 항상 허용
    if (from != address(0) && to != address(0)) {
        for (uint256 i = 0; i < ids.length; i++) {
            uint64 productCode = uint64(ids[i] >> PRODUCT_CODE_SHIFT);
            require(
                !isTransferRestricted[productCode],
                "KyoboNFT: token is soulbound"
            );
        }
    }
    super._update(from, to, ids, values);
}
```

### 2-4. 두 가지 설계 패턴 비교

강사는 수강생 발표에서 두 가지 패턴이 나올 수 있음을 알고 있어야 한다:

**패턴 1: KyoboNFT 직접 수정 (인라인 방식)**
- 장점: 단순, 컨트랙트 하나만 관리
- 단점: UUPS 업그레이드 대상이므로 스토리지 레이아웃 주의 필요. 새 mapping 추가 시 반드시 끝에 추가해야 함.

**패턴 2: 별도 TransferRestriction 컨트랙트 (외부 검증 방식)**
- 장점: KyoboNFT를 건드리지 않아 안전
- 단점: 외부 컨트랙트 호출 = 가스 증가 + 추가 배포 필요. `_update`는 internal이므로 외부에서 직접 호출 불가 → KyoboNFT에 훅 포인트를 노출해야 해 결국 KyoboNFT 수정 필요.

**강사 권장 방향:** 패턴 1을 선택하되, 스토리지 레이아웃 규칙(새 변수는 끝에만 추가)을 철저히 따르도록 안내.

### 2-5. 완전한 구현 예시 — TransferRestrictedKyoboNFT

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// KyoboNFTV2 — 전송 제한 기능 추가 (UUPS reinitializer)
// 기존 KyoboNFT 스토리지 레이아웃 변경 없음
// 새 변수 isTransferRestricted는 기존 변수 이후에 추가

contract KyoboNFTV2 is KyoboNFT {

    // [주의] 새 스토리지 변수는 반드시 기존 변수 이후에 선언
    // productCode → 전송 제한 여부
    mapping(uint64 => bool) public isTransferRestricted;

    event TransferRestrictionSet(uint64 indexed productCode, bool restricted);

    /// @notice V2 초기화 — deployProxy가 아닌 upgradeToAndCall()로 호출
    function initializeV2() public reinitializer(2) {
        // 보험 상품 코드(0x01, 0x02)는 기본적으로 전송 제한
        isTransferRestricted[0x01] = true; // 걷기 달성 NFT
        isTransferRestricted[0x02] = true; // 건강검진 NFT
        // 쿠폰(0x10)은 자유 전송 허용 — 초기화 불필요 (false가 기본값)
    }

    /// @notice productCode 단위로 전송 제한 설정/해제
    /// @dev PAUSER_ROLE 재사용 (별도 역할 추가 없이 운영 편의성 확보)
    function setTransferRestriction(
        uint64 productCode,
        bool restricted
    ) external onlyRole(PAUSER_ROLE) {
        isTransferRestricted[productCode] = restricted;
        emit TransferRestrictionSet(productCode, restricted);
    }

    /// @notice 전송 제한 적용 — 민팅/소각은 항상 허용
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override whenNotPaused {
        // from == address(0): 민팅 → 항상 허용
        // to == address(0):   소각 → 항상 허용
        // 그 외: 일반 전송 → productCode 체크
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; i++) {
                uint64 productCode = uint64(ids[i] >> PRODUCT_CODE_SHIFT);
                require(
                    !isTransferRestricted[productCode],
                    "KyoboNFTV2: token is soulbound"
                );
            }
        }
        super._update(from, to, ids, values);
    }
}
```

**테스트 시나리오 (강사가 확인해야 할 것):**
1. productCode=0x01 NFT를 A→B로 safeTransferFrom() → 실패 (SoulBound)
2. productCode=0x10 쿠폰을 A→B로 safeTransferFrom() → 성공
3. MINTER_ROLE이 mint() → 성공 (민팅은 제한 없음)
4. MINTER_ROLE이 burn() → 성공 (소각은 제한 없음)
5. setTransferRestriction(0x01, false) 후 전송 → 성공 (제한 해제)

---

## 배경 3 — 주제 B: Merkle-drop 발행 기술 깊이

### 3-1. Merkle Tree 원리

Merkle Tree는 **대량의 데이터를 단 하나의 해시(Merkle Root)로 요약**하는 자료구조다.

```
리프 노드 (각 수령인 정보):
  leaf_0 = keccak256(abi.encodePacked(addr_0, tokenId_0, amount_0))
  leaf_1 = keccak256(abi.encodePacked(addr_1, tokenId_1, amount_1))
  leaf_2 = keccak256(abi.encodePacked(addr_2, tokenId_2, amount_2))
  leaf_3 = keccak256(abi.encodePacked(addr_3, tokenId_3, amount_3))

중간 노드:
  node_01 = keccak256(abi.encodePacked(sort(leaf_0, leaf_1)))
  node_23 = keccak256(abi.encodePacked(sort(leaf_2, leaf_3)))

루트:
  root = keccak256(abi.encodePacked(sort(node_01, node_23)))
```

**왜 sort(a, b)를 사용하는가?** 정렬을 하면 트리 구성 순서와 무관하게 동일한 루트가 나온다. 트리 생성 시 입력 순서가 달라도 검증이 일관성을 가진다.

### 3-2. Merkle Proof — "내가 리프에 포함됨을 증명"

특정 주소 addr_0가 에어드랍 대상임을 증명하려면, **루트까지 올라가는 경로의 해시들(Proof)**만 제출하면 된다:

```
addr_0의 Proof: [leaf_1, node_23]

컨트랙트 검증:
  step1 = keccak256(sort(leaf_0, proof[0]=leaf_1)) = node_01
  step2 = keccak256(sort(node_01, proof[1]=node_23)) = root
  computed_root == stored_root ? → 유효한 수령인
```

10만 명의 에어드랍 리스트를 컨트랙트에 올리면 엄청난 가스가 필요하다. Merkle Root 단 하나만 저장하면, 각 수령인이 자신의 Proof를 들고 직접 청구(claim)할 수 있다.

### 3-3. OpenZeppelin MerkleProof.verify()

```solidity
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

// 검증 예시
bytes32 leaf = keccak256(abi.encodePacked(msg.sender, tokenId, amount));
bool valid = MerkleProof.verify(proof, merkleRoot, leaf);
require(valid, "MerkleDrop: invalid proof");
```

`MerkleProof.verify(proof, root, leaf)`:
- proof: bytes32[] — 경로 해시 배열
- root: bytes32 — 컨트랙트에 저장된 Merkle Root
- leaf: bytes32 — 청구자가 주장하는 자신의 리프 해시
- 반환: bool

### 3-4. 오프체인 Merkle Tree 생성 (merkletreejs)

오프체인에서 트리를 만들고, 각 수령인에게 Proof를 배포하는 스크립트:

```javascript
const { MerkleTree } = require('merkletreejs');
const keccak256 = require('keccak256');
const { ethers } = require('ethers');

// 수령인 목록 (예: DB에서 가져온 데이터)
const recipients = [
    { address: '0xAAA...', tokenId: 1001, amount: 1 },
    { address: '0xBBB...', tokenId: 1001, amount: 1 },
    { address: '0xCCC...', tokenId: 1002, amount: 2 },
    // ... 수만 명
];

// 각 수령인의 리프 해시 생성
// 주의: abi.encodePacked 동일 동작 — ethers.solidityPackedKeccak256 사용
const leaves = recipients.map(r =>
    Buffer.from(
        ethers.solidityPackedKeccak256(
            ['address', 'uint256', 'uint256'],
            [r.address, r.tokenId, r.amount]
        ).slice(2),
        'hex'
    )
);

// Merkle Tree 생성 (sorted: true로 정렬 적용)
const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
const root = tree.getHexRoot();

console.log('Merkle Root:', root);
// → 이 값을 컨트랙트에 배포 시 입력

// 특정 주소의 Proof 생성 (개인별로 배포)
const leaf = Buffer.from(
    ethers.solidityPackedKeccak256(
        ['address', 'uint256', 'uint256'],
        ['0xAAA...', 1001, 1]
    ).slice(2),
    'hex'
);
const proof = tree.getHexProof(leaf);
console.log('Proof for 0xAAA:', proof);
// → 이 배열을 수령인에게 전달 (API / 이메일 / QR 등)
```

### 3-5. 중복 청구 방지

```solidity
// 리프 해시 기준으로 claimed 매핑 관리
mapping(bytes32 => bool) public claimed;

function claim(
    uint256 tokenId,
    uint256 amount,
    bytes32[] calldata proof
) external {
    bytes32 leaf = keccak256(abi.encodePacked(msg.sender, tokenId, amount));
    
    // 중복 청구 방지 — claimed[leaf] 체크
    require(!claimed[leaf], "MerkleDrop: already claimed");
    
    // Merkle Proof 검증
    require(
        MerkleProof.verify(proof, merkleRoot, leaf),
        "MerkleDrop: invalid proof"
    );
    
    claimed[leaf] = true;
    kyoboNFT.mint(msg.sender, tokenId, amount);
    
    emit Claimed(msg.sender, tokenId, amount);
}
```

**왜 msg.sender를 리프에 포함하는가?**
proof를 가로채더라도 다른 주소로 청구할 수 없다. leaf = hash(addr, tokenId, amount)에서 addr이 msg.sender로 고정되어 있으므로, A의 proof를 B가 제출하면 B가 계산한 leaf(B's addr, ...)가 A의 proof와 매칭되지 않는다.

### 3-6. 완전한 구현 예시 — KyoboMerkleDrop

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./KyoboNFT.sol";

/**
 * @title KyoboMerkleDrop
 * @notice Merkle Tree 기반 NFT 에어드랍 컨트랙트
 *
 * 흐름:
 *   1. 관리자가 merkleRoot를 설정하여 배포
 *   2. 수령인이 오프체인에서 받은 proof를 가지고 claim() 호출
 *   3. 컨트랙트가 proof를 검증하고 NFT 발행
 *
 * KyoboNFT와의 연계:
 *   이 컨트랙트에 MINTER_ROLE을 부여하면 KyoboNFT.mint()를 직접 호출 가능.
 *   NFTIssuer를 거치지 않으므로 Issued 이벤트는 발행되지 않는다.
 *   필요 시 자체 Claimed 이벤트를 구독하여 오프체인 추적.
 */
contract KyoboMerkleDrop is AccessControl {
    KyoboNFT public immutable nft;
    bytes32  public merkleRoot;
    
    // 에어드랍 종료 시각 (0이면 무제한)
    uint256 public expiresAt;
    
    // 중복 청구 방지 — leaf 해시 기준
    mapping(bytes32 => bool) public claimed;

    event Claimed(
        address indexed claimant,
        uint256 indexed tokenId,
        uint256 amount
    );
    event MerkleRootUpdated(bytes32 indexed oldRoot, bytes32 indexed newRoot);

    constructor(
        address nft_,
        bytes32 merkleRoot_,
        uint256 expiresAt_
    ) {
        nft        = KyoboNFT(nft_);
        merkleRoot = merkleRoot_;
        expiresAt  = expiresAt_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /**
     * @notice NFT 청구 — Merkle Proof 검증 후 발행
     * @param tokenId KyoboNFT.encodeTokenId()로 생성한 ID
     * @param amount  수령 수량
     * @param proof   오프체인에서 받은 Merkle Proof
     */
    function claim(
        uint256 tokenId,
        uint256 amount,
        bytes32[] calldata proof
    ) external {
        // 1. 만료 체크
        require(
            expiresAt == 0 || block.timestamp <= expiresAt,
            "MerkleDrop: expired"
        );

        // 2. leaf 계산 — msg.sender 포함으로 proof 가로채기 방지
        bytes32 leaf = keccak256(
            abi.encodePacked(msg.sender, tokenId, amount)
        );

        // 3. 중복 청구 방지 (CEI 패턴 — 상태 변경 먼저)
        require(!claimed[leaf], "MerkleDrop: already claimed");
        claimed[leaf] = true;

        // 4. Merkle Proof 검증
        require(
            MerkleProof.verify(proof, merkleRoot, leaf),
            "MerkleDrop: invalid proof"
        );

        // 5. NFT 발행 (이 컨트랙트에 MINTER_ROLE 필요)
        nft.mint(msg.sender, tokenId, amount);

        emit Claimed(msg.sender, tokenId, amount);
    }

    /// @notice Merkle Root 업데이트 — 에어드랍 라운드 교체 시
    function updateMerkleRoot(bytes32 newRoot)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        emit MerkleRootUpdated(merkleRoot, newRoot);
        merkleRoot = newRoot;
    }

    /// @notice 에어드랍 만료 시각 연장
    function extendExpiry(uint256 newExpiresAt)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(newExpiresAt > expiresAt, "MerkleDrop: must extend");
        expiresAt = newExpiresAt;
    }
}
```

**배포 후 설정 순서 (강사가 알고 있어야 할 것):**

```bash
# 1. KyoboMerkleDrop 배포
const drop = await deployContract("KyoboMerkleDrop", [
    nft.address,
    merkleRoot,
    Math.floor(Date.now() / 1000) + 86400 * 30  // 30일 후 만료
]);

# 2. KyoboNFT에 MINTER_ROLE 부여
await nft.grantRole(MINTER_ROLE, drop.address);

# 3. 수령인들에게 proof 배포 (API 또는 프론트엔드)
# proof = tree.getHexProof(leaf)
```

**테스트 시나리오:**
1. 정상 proof로 claim() → NFT 발행 성공
2. 동일 proof로 두 번 claim() → "already claimed" revert
3. 타인의 proof를 사용 → "invalid proof" revert (leaf에 msg.sender 포함)
4. 만료 후 claim() → "expired" revert

---

## 배경 4 — 주제 C: 감사 로그 온체인 앵커 기술 깊이

### 4-1. 온체인 앵커 패턴의 핵심 아이디어

온체인에 모든 로그를 저장하면 비용이 폭발한다. 그러나 **무결성 증명**만 필요하다면 해시만 저장해도 충분하다.

```
오프체인 DB 로그 (예: 매 시간 배치):
  [2026-05-27 10:00] 가입자 0xAAA에게 tokenId=1001 발행 (requestId=abc123)
  [2026-05-27 10:01] 가입자 0xBBB에게 tokenId=1002 발행 (requestId=def456)
  ...

↓ SHA-256 해시 (또는 keccak256)

앵커 해시: 0x7a3b2c1d...

↓ 온체인 기록

AuditAnchor.recordAnchor(
    anchorId = keccak256("2026-05-27-10:00"),
    contentHash = 0x7a3b2c1d...,
    description = "발행 로그 배치 #4872"
)
```

이후 누군가 "2026년 5월 27일 10시에 해당 발행 기록이 위조됐다"고 주장하면:
1. 오프체인 DB에서 원본 로그 파일 제출
2. 로그 파일의 SHA-256 계산
3. 온체인에 기록된 anchorHash와 비교
4. 일치하면 → 위조 없음 증명 완료

### 4-2. event vs storage — 비용 비교

| 방식 | 가스 비용 | 영구성 | 쿼리 가능 |
|------|-----------|--------|-----------|
| storage 기록 (mapping) | 20,000 gas/슬롯 | 영구 | onchain 쿼리 가능 |
| event emit | 375 gas + 8 gas/byte | 영구 (단, 프루닝 주의) | 오프체인 로그 필터링 |

**권장 방식:** storage와 event를 함께 사용
- storage: 가장 최근 앵커 해시 또는 앵커 개수 (최소한만 저장)
- event: 전체 앵커 내역 (오프체인 인덱서가 구독)

이유: event만 쓰면 "특정 시점에 어떤 해시가 기록됐는지"를 온체인에서 직접 조회할 수 없다. storage에 mapping을 두면 컨트랙트 콜로 조회 가능하다.

### 4-3. Notarization과의 차이

강사가 받을 수 있는 질문: "이게 공증(Notarization)이랑 뭐가 다른가요?"

| | 전통 공증 | 온체인 앵커 |
|---|---|---|
| 신뢰 주체 | 공증인 (사람) | 블록체인 (코드·합의) |
| 비용 | 건당 수만 원 | 트랜잭션 가스비 |
| 속도 | 수일 | 수 초 |
| 24/7 가용 | 불가 | 가능 |
| 법적 효력 | 법정 증거 | 기술적 증거 (법적 지위 진화 중) |

한국은 아직 온체인 앵커를 독자적 법적 증거로 완전히 인정하지 않는다. 그러나 **기존 공증과 병행**하면 위조 가능성을 사실상 제로로 만들 수 있다.

### 4-4. 완전한 구현 예시 — AuditAnchor

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title AuditAnchor
 * @notice 오프체인 감사 로그의 해시를 온체인에 앵커링하는 컨트랙트
 *
 * 교보생명 활용 시나리오:
 *   - NFT 발행 배치 처리 후 해당 배치 로그의 해시를 기록
 *   - 규제 감사 시 로그 파일과 앵커 해시 비교로 무결성 증명
 *   - 시간당 / 일당 / 이벤트 단위 배치 선택 가능
 */
contract AuditAnchor is AccessControl {
    bytes32 public constant ANCHOR_ROLE = keccak256("ANCHOR_ROLE");

    struct AnchorRecord {
        bytes32 contentHash;   // 오프체인 로그의 keccak256 / SHA-256
        uint256 timestamp;     // block.timestamp (Unix)
        uint256 blockNumber;   // 해당 블록 번호
        string  description;   // 사람이 읽을 수 있는 설명
    }

    // anchorId → 앵커 기록
    // anchorId 예: keccak256("batch-2026-05-27-10:00")
    mapping(bytes32 => AnchorRecord) public anchors;

    // 전체 앵커 ID 목록 (순서 추적용)
    bytes32[] public anchorIds;

    event AnchorRecorded(
        bytes32 indexed anchorId,
        bytes32 indexed contentHash,
        uint256 timestamp,
        string  description
    );

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ANCHOR_ROLE, msg.sender);
    }

    /**
     * @notice 오프체인 로그 해시를 온체인에 기록
     * @param anchorId    앵커 고유 ID (오프체인에서 생성 — 배치 식별자)
     * @param contentHash 로그 파일의 해시값 (keccak256 또는 SHA-256 hex → bytes32)
     * @param description 사람이 읽을 수 있는 설명 (감사자용)
     */
    function recordAnchor(
        bytes32 anchorId,
        bytes32 contentHash,
        string calldata description
    ) external onlyRole(ANCHOR_ROLE) {
        // 중복 앵커 방지
        require(
            anchors[anchorId].timestamp == 0,
            "AuditAnchor: anchor already exists"
        );
        require(contentHash != bytes32(0), "AuditAnchor: empty hash");

        anchors[anchorId] = AnchorRecord({
            contentHash : contentHash,
            timestamp   : block.timestamp,
            blockNumber : block.number,
            description : description
        });
        anchorIds.push(anchorId);

        emit AnchorRecorded(anchorId, contentHash, block.timestamp, description);
    }

    /**
     * @notice 특정 앵커의 콘텐츠 해시 검증
     * @param anchorId    검증할 앵커 ID
     * @param contentHash 검증할 해시 (제출된 로그 파일의 해시)
     * @return bool 일치 여부
     */
    function verify(
        bytes32 anchorId,
        bytes32 contentHash
    ) external view returns (bool) {
        AnchorRecord storage record = anchors[anchorId];
        require(record.timestamp != 0, "AuditAnchor: anchor not found");
        return record.contentHash == contentHash;
    }

    /// @notice 전체 앵커 수
    function anchorCount() external view returns (uint256) {
        return anchorIds.length;
    }
}
```

**오프체인 앵커링 스크립트 (TypeScript):**

```typescript
import { ethers } from 'ethers';
import * as crypto from 'crypto';
import * as fs from 'fs';

interface AnchorService {
    anchorLogFile(
        logFilePath: string,
        batchId: string,
        description: string
    ): Promise<string>; // 트랜잭션 해시 반환
}

class AuditAnchorService implements AnchorService {
    constructor(
        private contract: ethers.Contract,
        private signer: ethers.Signer
    ) {}

    async anchorLogFile(
        logFilePath: string,
        batchId: string,
        description: string
    ): Promise<string> {
        // 1. 로그 파일 읽기
        const logContent = fs.readFileSync(logFilePath);
        
        // 2. SHA-256 해시 계산 (Node.js crypto)
        const sha256Hex = crypto
            .createHash('sha256')
            .update(logContent)
            .digest('hex');
        
        // 3. bytes32로 변환 (0x prefix 추가)
        const contentHash = '0x' + sha256Hex;
        
        // 4. anchorId 생성 (batchId의 keccak256)
        const anchorId = ethers.keccak256(ethers.toUtf8Bytes(batchId));
        
        // 5. 온체인 기록
        const tx = await this.contract.recordAnchor(
            anchorId,
            contentHash,
            description
        );
        const receipt = await tx.wait();
        
        console.log(`Anchored: ${batchId}`);
        console.log(`  Content Hash: ${contentHash}`);
        console.log(`  TX: ${receipt.hash}`);
        console.log(`  Block: ${receipt.blockNumber}`);
        
        return receipt.hash;
    }

    async verifyLogFile(
        logFilePath: string,
        batchId: string
    ): Promise<boolean> {
        const logContent = fs.readFileSync(logFilePath);
        const sha256Hex = crypto
            .createHash('sha256')
            .update(logContent)
            .digest('hex');
        const contentHash = '0x' + sha256Hex;
        const anchorId = ethers.keccak256(ethers.toUtf8Bytes(batchId));
        
        return await this.contract.verify(anchorId, contentHash);
    }
}
```

**테스트 시나리오:**
1. 로그 파일 A의 해시로 앵커 기록 → 성공
2. 같은 anchorId로 두 번 기록 → "already exists" revert
3. 원본 파일로 verify() → true
4. 파일 1바이트 변조 후 verify() → false (위변조 탐지)

---

## 배경 5 — 설계 발표 평가 기준 (강사용 내부 체크리스트)

강사는 발표를 들으면서 아래 4가지 차원을 머릿속에서 동시에 평가해야 한다.

### 5-1. 실현 가능성 — S49 1시간 안에 구현 가능한가?

| 판단 기준 | 가능 | 불가 |
|-----------|------|------|
| 컨트랙트 신규 함수 수 | 3개 이하 | 5개 초과 |
| 새 의존성 라이브러리 | OpenZeppelin 범위 내 | 커스텀 암호화 등 |
| 오프체인 연동 | 이미 구축된 ethers.js 사용 | 새 인프라 필요 |
| 테스트 시나리오 수 | 4개 이하 | 10개 초과 |

**범위가 너무 넓은 경우 핵심 1개로 좁히는 방법:**
- "전체 구현 중 제일 핵심인 함수 하나만 고른다면?"
- "오프체인 부분은 제외하고 컨트랙트 레이어만 구현한다면?"
- "배포와 청구까지 다 하려면 3시간인데, claim() 함수 하나만 구현하면 45분이다."

### 5-2. 보안 고려 — 취약점을 인식하고 방어했는가?

**각 주제별 강사가 반드시 확인해야 할 보안 포인트:**

주제 A (전송 제한):
- [ ] 민팅과 소각을 전송 제한에서 제외했는가? (from==0, to==0 체크)
- [ ] 역할 접근 제어: setTransferRestriction()에 적절한 역할을 걸었는가?
- [ ] 업그레이드 후 기존 isTransferRestricted 매핑이 리셋되지 않는가?

주제 B (Merkle-drop):
- [ ] msg.sender를 leaf에 포함시켰는가? (proof 가로채기 방지)
- [ ] claimed 매핑을 mint() 이전에 설정했는가? (CEI 패턴 / 재진입 방지)
- [ ] merkleRoot를 누가 업데이트할 수 있는가? (무단 root 교체 방지)
- [ ] 만료 시각을 설정했는가? (미청구 에어드랍 정리)

주제 C (감사 로그 앵커):
- [ ] 동일 anchorId 중복 기록 방지를 구현했는가?
- [ ] contentHash가 빈 값(bytes32(0))인 경우 revert 처리했는가?
- [ ] ANCHOR_ROLE을 적절한 주소에만 부여했는가?

### 5-3. Phase 1 통합 — 기존 컨트랙트와 연결점이 있는가?

| 주제 | 연결 방식 | 강사 확인 포인트 |
|------|-----------|-----------------|
| A (전송 제한) | KyoboNFT 직접 수정 (V2) | 스토리지 레이아웃 충돌 여부 |
| B (Merkle-drop) | 별도 컨트랙트 → KyoboNFT.mint() | MINTER_ROLE 부여 방식 |
| C (감사 로그) | 독립 컨트랙트 + 오프체인 서비스 | 기존 NFTIssuer 이벤트 파이프라인과 연계 |

### 5-4. 테스트 계획 — 공격 시나리오가 포함됐는가?

수강생이 "정상 케이스만" 테스트 계획을 제시하면 반드시 공격 시나리오 1개를 추가하도록 요청한다.

**공격 시나리오 추가 질문:**
- "만약 누군가 같은 proof를 두 번 사용한다면 어떻게 되나요?"
- "민팅 권한이 없는 주소가 claim()을 부를 수 있나요?"
- "관리자가 갑자기 merkleRoot를 바꾼다면 기존 미청구자는 어떻게 되나요?"

---

## 배경 6 — 피드백 시 자주 나오는 실수 패턴

### 패턴 1: 범위 과다 — 1시간에 불가능한 설계

**증상:** 발표 슬라이드에 컨트랙트 3개 + 오프체인 서비스 2개 + 프론트엔드 연동까지 포함

**강사 대응:**
> "설계가 완전한 시스템 구조를 잘 이해하고 있네요. 근데 S49는 1시간이에요. 핵심 컨트랙트 1개의 핵심 함수 2개만 구현한다면 어떤 걸 선택하시겠어요?"

### 패턴 2: 보안 고려 없음 — 접근 제어 누락

**증상:** setTransferRestriction()에 아무 modifier도 없음. 누구나 호출 가능.

**강사 대응:**
> "이 함수를 누구나 부를 수 있으면 어떤 일이 일어나나요? 공격자가 isTransferRestricted[0x01] = false로 바꾸면?"

### 패턴 3: 테스트가 정상 케이스만

**증상:** "mint 잘 되는지 테스트합니다" — 공격 시나리오 없음

**강사 대응:**
> "정상 케이스는 이미 잘 설계됐어요. 하나만 더 생각해보죠. 악의적인 사용자가 이 시스템을 망가뜨리려 한다면 어디를 공격할까요?"

### 패턴 4: EVM 한계 미인식

자주 나오는 오해들:

| 오해 | 실제 |
|------|------|
| "외부 API를 컨트랙트에서 호출할게요" | EVM은 외부 HTTP API 호출 불가. Oracle 패턴 필요. |
| "루프로 10만 건 처리할게요" | block gas limit 초과. 500건씩 청크 필요. |
| "문자열로 데이터 처리할게요" | Solidity 문자열은 bytes로 처리, 비교 불가 (bytes32 사용 권장) |
| "난수를 컨트랙트에서 생성할게요" | blockhash는 조작 가능. VRF 등 외부 난수 소스 필요. |

---

# [강의/진행]

---

## 60분 진행 계획

```
00:00 ~ 05:00  세션 오리엔테이션 (5분)
05:00 ~ 45:00  발표 세션 (40분)
               → 3인 발표 기준: 팀당 12~13분
               → 2인 발표 기준: 팀당 18~20분
               ※ 팀 수에 따라 조정 (아래 상세 계획 참조)
45:00 ~ 55:00  강사 종합 피드백 + 구현 범위 확정 (10분)
55:00 ~ 60:00  S49 준비 안내 (5분)
```

---

## 00:00 ~ 05:00 — 세션 오리엔테이션

**강사 발화 예시:**

> "오늘은 코드를 쓰는 날이 아니라 **설계를 검증하는 날**입니다. 좋은 설계는 구현보다 어렵습니다. 오늘 발표에서 세 가지만 확인합니다."
>
> 첫째, 이게 S49 1시간 안에 구현 가능한가.
> 둘째, 보안 취약점을 어떻게 방어하는가.
> 셋째, 기존 KyoboNFT / NFTIssuer와 어떻게 연결되는가.
>
> "완벽하지 않아도 됩니다. 오늘 피드백을 받아서 S49 시작 전에 범위를 확정하는 게 목표입니다."

**칠판 / 슬라이드에 미리 적어두기:**

```
발표 항목:
  1. 주제 선택 이유 (1분)
  2. 아키텍처 다이어그램 (2분)
  3. 컨트랙트 인터페이스 (3분)
  4. 보안 고려사항 (2분)
  5. 테스트 계획 (2분)
  
  ※ 10분 발표 + 2~3분 Q&A
```

---

## 05:00 ~ 45:00 — 발표 세션

### 발표 순서 진행 방법

**강사 진행 팁:**
- 타이머를 화면에 표시하거나, 10분 경과 시 조용히 신호
- 발표 중 강사는 노트에 피드백 키워드만 메모 (발표 중 끊지 않는 것이 원칙)
- 발표 종료 후 2~3분 Q&A 바로 진행

### 발표당 진행 흐름 (12분 기준)

**[0:00 ~ 1:00] 주제 선택 이유**

> 수강생: "NFT 전송 제한을 선택했습니다. 보험 NFT가 개인에게 귀속되어야 한다는 비즈니스 요구사항에서 출발했습니다."

강사 내심 체크: 비즈니스 맥락을 이해하고 주제를 선택했는가?

---

**[1:00 ~ 3:00] 아키텍처 다이어그램**

수강생이 제시하는 다이어그램 예시:

```
[주제 A — NFT 전송 제한]

  기존 구조:
  MINTER_ROLE ──→ KyoboNFT.mint()
  누구나      ──→ KyoboNFT.safeTransferFrom()  ← 문제: 전송 제한 없음

  변경 구조:
  MINTER_ROLE ──→ KyoboNFTV2.mint()           ← 그대로 허용
  누구나      ──→ KyoboNFTV2.safeTransferFrom()
                    ↓ _update() 훅
                    productCode 체크
                    isTransferRestricted[productCode] == true
                    → REVERT "soulbound"
```

```
[주제 B — Merkle-drop]

  오프체인:
  수령인 DB (1만명) ──→ [merkletreejs] ──→ Merkle Root
                                       ──→ proof 배열 (각 수령인별)

  온체인:
  관리자 ──→ KyoboMerkleDrop.deploy(root)
               ↓ KyoboNFT에 MINTER_ROLE 부여
  수령인 ──→ KyoboMerkleDrop.claim(tokenId, amount, proof)
               ↓ verify(proof, root, leaf)
               ↓ KyoboNFT.mint(msg.sender, tokenId, amount)
```

```
[주제 C — 감사 로그 앵커]

  오프체인:
  NFTIssuer 발행 배치 완료
    ↓
  로그 파일 생성 (JSON)
    ↓
  SHA-256 해시 계산
    ↓
  AuditAnchorService.anchorLogFile()

  온체인:
  AuditAnchor.recordAnchor(anchorId, contentHash, description)
    → AnchorRecorded 이벤트 emit
    → anchors[anchorId] storage 저장

  감사 시:
  감사자 → 로그 파일 제출 → SHA-256 재계산 → AuditAnchor.verify()
```

강사 내심 체크: 컨트랙트 경계(무엇이 온체인, 무엇이 오프체인)를 명확히 이해하는가?

---

**[3:00 ~ 6:00] 컨트랙트 인터페이스**

수강생이 제시하는 인터페이스 예시:

```solidity
// 주제 A
contract KyoboNFTV2 is KyoboNFT {
    mapping(uint64 => bool) public isTransferRestricted;
    
    function initializeV2() public reinitializer(2);
    function setTransferRestriction(uint64 productCode, bool restricted) external onlyRole(PAUSER_ROLE);
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override;
}
```

```solidity
// 주제 B
contract KyoboMerkleDrop {
    bytes32 public merkleRoot;
    mapping(bytes32 => bool) public claimed;
    
    function claim(uint256 tokenId, uint256 amount, bytes32[] calldata proof) external;
    function updateMerkleRoot(bytes32 newRoot) external onlyRole(DEFAULT_ADMIN_ROLE);
}
```

```solidity
// 주제 C
contract AuditAnchor {
    mapping(bytes32 => AnchorRecord) public anchors;
    
    function recordAnchor(bytes32 anchorId, bytes32 contentHash, string calldata description) external onlyRole(ANCHOR_ROLE);
    function verify(bytes32 anchorId, bytes32 contentHash) external view returns (bool);
}
```

강사 내심 체크:
- 함수 시그니처가 실제 구현 가능한 수준인가?
- 역할(Role) 설계가 있는가?
- 이벤트 설계가 있는가?

---

**[6:00 ~ 8:00] 보안 고려사항**

수강생이 제시해야 할 내용 (없으면 강사가 질문으로 유도):

```
주제 A:
  ✓ 민팅/소각은 전송 제한 예외 처리 (_update에서 from==0/to==0 체크)
  ✓ setTransferRestriction에 PAUSER_ROLE 적용 (무단 변경 방지)
  ✓ 스토리지 레이아웃: 새 변수는 기존 변수 이후에 추가

주제 B:
  ✓ leaf에 msg.sender 포함 (proof 가로채기 방지)
  ✓ CEI 패턴: claimed[leaf] = true를 mint() 이전에 설정
  ✓ 만료 시각 설정 (미청구 에어드랍 무제한 방치 방지)

주제 C:
  ✓ 중복 앵커 방지 (같은 anchorId 두 번 기록 불가)
  ✓ 빈 해시(bytes32(0)) 거부
  ✓ ANCHOR_ROLE 접근 제어
```

강사 내심 체크: 보안 고려사항이 1개 이상 명시적으로 언급됐는가? (완료 기준)

---

**[8:00 ~ 10:00] 테스트 계획**

수강생이 제시해야 할 내용:

```
주제 A 테스트:
  정상: productCode=0x01 NFT 민팅 → 성공
  정상: productCode=0x10 쿠폰 전송 → 성공 (제한 없음)
  공격: productCode=0x01 NFT 전송 시도 → revert "soulbound"
  공격: 권한 없는 주소가 setTransferRestriction() → revert

주제 B 테스트:
  정상: 유효한 proof로 claim() → NFT 발행
  공격: 동일 proof로 두 번 claim() → revert "already claimed"
  공격: 타인의 proof 사용 → revert "invalid proof"
  정상: 만료 전 claim() → 성공 / 만료 후 → revert

주제 C 테스트:
  정상: 로그 파일 앵커 기록 → AnchorRecorded 이벤트
  정상: 원본 파일로 verify() → true
  공격: 파일 변조 후 verify() → false
  공격: 동일 anchorId 두 번 기록 → revert
```

강사 내심 체크: 공격 시나리오(공격 케이스)가 최소 1개 포함됐는가? (완료 기준)

---

**[10:00 ~ 12:00] Q&A**

강사 표준 질문 목록 (주제별로 1~2개 선택):

**주제 A 질문:**
- "KyoboNFTV2로 업그레이드할 때 기존 NFT 보유자에게 어떤 영향이 있나요?"
- "setTransferRestriction을 MINTER_ROLE 대신 PAUSER_ROLE에 넣은 이유가 있나요?"

**주제 B 질문:**
- "merkleRoot를 관리자가 중간에 바꾸면 기존 미청구자는 어떻게 되나요?"
- "오프체인 proof를 어떤 방법으로 수령인에게 전달할 계획인가요?"

**주제 C 질문:**
- "앵커를 event만으로 기록하지 않고 storage에도 저장하는 이유가 뭔가요?"
- "SHA-256 해시와 keccak256 중 어떤 걸 쓸 건가요? 이유는?"

---

## 45:00 ~ 55:00 — 강사 종합 피드백 + 구현 범위 확정

### 피드백 구조 (각 팀당 2~3분)

**피드백 프레임 (Keep / Change / Focus):**

```
Keep  : 잘 된 부분 — 구체적으로 언급
Change: 수정 또는 보완이 필요한 부분 — 이유와 함께
Focus : S49에서 반드시 구현해야 할 핵심 1~2개
```

**강사 피드백 예시 (주제 A):**

> "Keep: 민팅과 소각을 전송 제한 예외로 처리한 것, 정확합니다. productCode 단위로 제한을 설정한 것도 실용적인 선택이에요.
>
> Change: setTransferRestriction에 이벤트를 추가하면 좋겠어요. 누가 언제 제한을 바꿨는지 트래킹이 안 되면 감사할 때 문제가 됩니다.
>
> Focus: S49에서는 _update 훅 구현 + 테스트 케이스 3개(민팅 허용, 전송 차단, 쿠폰 전송 허용)에 집중하세요. initializeV2와 setTransferRestriction은 시간이 남으면 추가."

### 구현 범위 확정 템플릿

강사가 칠판 / 슬라이드에 작성하면서 팀과 함께 확정:

```
팀명 / 주제: _______________

S49 Must (반드시 구현):
  □ 컨트랙트명: _______________
  □ 핵심 함수 1: _______________
  □ 핵심 함수 2: _______________
  □ 테스트 케이스 3개: _______________

S49 Optional (시간 있으면):
  □ _______________

제외 (이번 범위 밖):
  □ _______________
```

---

## 55:00 ~ 60:00 — S49 준비 안내

**강사 발화:**

> "S49에서 실제로 코딩합니다. 오늘 확정한 범위만 구현합니다. 시작 전에 세 가지를 준비해주세요."

**수강생 S49 준비 체크리스트:**

```
□ 1. 개발 환경 확인
     hardhat compile 통과 상태인지 확인
     (KyoboNFT.sol / NFTIssuer.sol 현재 상태 보존)

□ 2. 구현할 컨트랙트 파일 생성
     blockchain/src/rewards/KyoboNFTV2.sol     (주제 A)
     blockchain/src/drops/KyoboMerkleDrop.sol  (주제 B)
     blockchain/src/audit/AuditAnchor.sol      (주제 C)

□ 3. 테스트 파일 스켈레톤 생성
     test/KyoboNFTV2.test.ts     (주제 A)
     test/KyoboMerkleDrop.test.ts (주제 B)
     test/AuditAnchor.test.ts    (주제 C)
```

---

## 발표 슬라이드 템플릿 (마크다운 — 수강생 배포용)

```markdown
# 미니프로젝트 설계 발표
## [팀명] — [주제 A/B/C: 제목]

---

## 1. 주제 선택 이유
- 비즈니스 문제: _______________
- 기술적 해결책: _______________
- Phase 1 연관성: _______________

---

## 2. 아키텍처 다이어그램

```
[여기에 ASCII 또는 이미지 다이어그램]

온체인:
  [컨트랙트 A] → [컨트랙트 B]

오프체인:
  [서비스] → [컨트랙트 A]
```

---

## 3. 컨트랙트 인터페이스

```solidity
// 컨트랙트명: _______________
// 상속: _______________

// 상태 변수
mapping(???) public ???;

// 이벤트
event ???(???);

// 함수 (역할 명시)
function ???(???) external onlyRole(???);
function ???(???) external view returns (???);
```

---

## 4. 보안 고려사항

| 위협 | 방어 방법 |
|------|-----------|
| ___ | ___ |
| ___ | ___ |
| ___ | ___ |

---

## 5. 테스트 계획

| 케이스 | 시나리오 | 예상 결과 |
|--------|----------|-----------|
| 정상 1 | ___ | 성공 |
| 정상 2 | ___ | 성공 |
| 공격 1 | ___ | revert |
| 공격 2 | ___ | revert |

---

## 6. S49 구현 범위 (Must / Optional)

Must:
- [ ] _______________
- [ ] _______________

Optional:
- [ ] _______________
```

---

## 설계서 작성 가이드라인 (수강생 배포용)

### 좋은 설계서의 조건

**1. 컨트랙트 경계가 명확하다**

```
나쁜 예: "사용자가 NFT를 받는다"
좋은 예: "사용자(EOA)가 KyoboMerkleDrop.claim()을 호출하면,
          컨트랙트가 MerkleProof.verify()로 검증 후,
          KyoboNFT.mint()를 통해 msg.sender에게 발행한다"
```

**2. 역할(Role)이 명시된다**

```
나쁜 예: "관리자가 설정을 바꾼다"
좋은 예: "DEFAULT_ADMIN_ROLE을 보유한 주소만 updateMerkleRoot()를 호출할 수 있다"
```

**3. 실패 경로가 설계된다**

```
나쁜 예: "검증에 실패하면 에러가 난다"
좋은 예: "Merkle Proof가 유효하지 않으면 'invalid proof'로 revert된다.
          이미 청구한 주소는 'already claimed'로 revert된다."
```

**4. 이벤트가 설계된다**

```
나쁜 예: (이벤트 설계 없음)
좋은 예: "claim() 성공 시 Claimed(msg.sender, tokenId, amount) 이벤트를 emit한다.
          오프체인 인덱서가 이 이벤트를 구독하여 발행 현황을 추적한다."
```

---

## 강사 피드백 체크리스트 (세션 운영용)

발표 중 강사가 항목별로 체크 (팀당 1장):

```
팀: ____________  주제: A / B / C

[ ] 실현 가능성
    [ ] S49 1시간 내 구현 가능한 범위인가?
    [ ] 컨트랙트 신규 함수가 5개 이하인가?
    [ ] 기존 OpenZeppelin 라이브러리만 사용하는가?

[ ] 보안 고려사항 (완료 기준: 1개 이상)
    [ ] 접근 제어(Role)가 적용됐는가?
    [ ] 입력 검증이 있는가? (require 조건들)
    [ ] 재진입 또는 중복 실행 방어가 있는가?
    주제 A: [ ] 민팅/소각 예외 처리
    주제 B: [ ] leaf에 msg.sender 포함 / CEI 패턴
    주제 C: [ ] 중복 앵커 방지

[ ] Phase 1 통합
    [ ] KyoboNFT / NFTIssuer와 연결점이 명시됐는가?
    [ ] UUPS 스토리지 레이아웃 고려가 있는가? (주제 A)
    [ ] MINTER_ROLE 부여 방식이 설명됐는가? (주제 B)

[ ] 테스트 계획 (완료 기준: 공격 케이스 1개 이상)
    [ ] 정상 케이스가 2개 이상 있는가?
    [ ] 공격 시나리오가 1개 이상 있는가?
    [ ] 예상 결과(revert 메시지 포함)가 명시됐는가?

[ ] 발표 완료 기준 최종 확인
    [ ] 설계 발표 완료 (Y / N)
    [ ] 구현 범위 확정 (Y / N)
    [ ] 보안 고려사항 1개 이상 포함 (Y / N)

피드백 메모:
Keep  : _______________
Change: _______________
Focus : _______________
```

---

## 세션 완료 기준

| 기준 | 확인 방법 |
|------|-----------|
| 설계 발표 완료 | 전원 발표 + Q&A 진행 |
| 구현 범위 확정 | 강사와 함께 Must 목록 작성 완료 |
| 보안 고려사항 1개 이상 포함 | 피드백 체크리스트 해당 항목 체크 |

---

## 참고 — Phase 1 컨트랙트 핵심 상수

수강생 발표 중 강사가 즉시 참조할 수 있도록:

```solidity
// KyoboNFT
bytes32 public constant MINTER_ROLE   = keccak256("MINTER_ROLE");
bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
uint8   public constant PRODUCT_CODE_SHIFT = 64;

// tokenId 인코딩
// productCode(상위 64비트) | eventCode(하위 64비트)
function encodeTokenId(uint64 productCode, uint64 eventCode) returns (uint256)
// (uint256(productCode) << 64) | uint256(eventCode)

// NFTIssuer
bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
uint256 public constant MAX_BATCH_SIZE = 500;
mapping(bytes32 => bool) public issued; // Idempotency key

// _update 훅 — 민팅/소각/전송 구분
// from == address(0): 민팅
// to   == address(0): 소각
// 둘 다 non-zero: 일반 전송
```
