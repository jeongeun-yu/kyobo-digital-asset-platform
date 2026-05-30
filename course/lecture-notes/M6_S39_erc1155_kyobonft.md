# M6 S39 — ERC-1155 구조 이해 + Phase 1 KyoboNFT 코드 해부

> 모듈 6 · 세션 39 · 1시간  
> 강의 50분 + 실습 10분  
> 실습 환경: [Remix IDE](https://remix.ethereum.org)

---

## [강사 배경] — 120분 수준 배경지식

> 이 섹션은 강의에서 직접 읽는 용도가 아니다. 질문에 자신있게 답하고, 맥락을 풍부하게 설명하기 위한 강사 배경지식이다.

### ERC-1155 탄생 — Enjin의 게임 아이템 문제

2018년 Enjin의 수석 블록체인 개발자 Witek Radomski가 ERC-1155를 제안했다. 배경은 게임 아이템이다.

블록체인 게임에서 ERC-721을 쓰면:
- 검(Sword) = 별도 컨트랙트
- 방패(Shield) = 별도 컨트랙트  
- 포션(Potion) = 별도 컨트랙트
- 아이템 10종 = 컨트랙트 10개

사용자가 게임 내 상점에서 아이템 5종을 한꺼번에 구매하면 트랜잭션 5번이 필요했다. Gas 비용 5배, UX도 최악.

ERC-1155는 이 문제를 "tokenId로 종류 구분 + 배치 전송"으로 해결했다. 게임 아이템 1000종을 컨트랙트 1개로 관리하고, 구매도 1번의 트랜잭션으로.

현재 채택 사례:
- Enjin 플랫폼 게임 전체
- The Sandbox 메타버스 아이템
- Gods Unchained 카드 게임
- Sorare 스포츠 NFT 카드

### 배치 전송의 원자성 — DeFi에서 왜 중요한가

`safeBatchTransferFrom`이 실패하면 전체가 롤백된다. 부분 실행이 없다.

```
예시: Alice → Bob, 3종 아이템 한 번에 전송
safeBatchTransferFrom(Alice, Bob, [id1, id2, id3], [5, 3, 1], "")

실패 시나리오:
  id1 전송 성공, id2 전송 성공, id3 Alice 잔액 부족 → 실패
  → id1, id2, id3 모두 롤백 (Alice 원상 복구)

이것이 원자성(atomicity): 전부 성공하거나 전부 실패
```

이 원자성이 DeFi에서 핵심이다. NFT 교환(스왑) 시 "내 NFT는 주고 상대 NFT는 못 받는" 상황이 발생하지 않는다. 에스크로 없이 P2P 교환이 가능한 이유.

### tokenId 충돌 가능성 분석 — KyoboNFT 비트 레이아웃

KyoboNFT는 `productCode(64비트) | eventCode(64비트)`로 tokenId를 설계했다.

**충돌 가능성 분석:**

```
tokenId = (productCode << 64) | eventCode

productCode = 0x01, eventCode = 42
→ tokenId = (1 << 64) | 42 = 18446744073709551658

productCode = 0x00 (위험!), eventCode = 42
→ tokenId = (0 << 64) | 42 = 42

만약 eventCode만으로 tokenId를 생성하면?
→ tokenId = 42
→ productCode=0인 토큰과 순수 eventCode=42인 토큰이 동일한 tokenId를 가짐 → 충돌
```

**productCode = 0을 금지해야 하는 이유:**

```solidity
// 권장: productCode 최솟값 검증
function encodeTokenId(uint64 productCode, uint64 eventCode) public pure returns (uint256) {
    require(productCode > 0, "productCode cannot be zero");  // 0 금지
    return (uint256(productCode) << 64) | uint256(eventCode);
}
```

productCode = 0이면 `(0 << 64) | eventCode = eventCode`가 된다. eventCode와 같은 범위의 값이 충돌할 수 있다. productCode를 1부터 시작하도록 강제해야 안전하다.

**최대 tokenId 공간:**

```
productCode: uint64 → 2^64 - 1 ≈ 1.8 × 10^19 종류 (productCode=0 제외)
eventCode:   uint64 → 2^64 - 1 ≈ 1.8 × 10^19 종류
tokenId 공간: 사실상 무한 (교보생명이 사용할 수 있는 상품 수 제한 없음)
```

### ERC-1155 vs ERC-721 transfer 메커니즘 차이

근본적인 설계 철학의 차이다.

**ERC-721 — 소유권 기반:**

```solidity
mapping(uint256 => address) private _owners;  // tokenId → 소유자 1명
// tokenId당 소유자가 정확히 1명. 수량 개념 없음
// ownerOf(tokenId) = 한 명의 주소

// 전송: 소유자를 바꾼다
function _transfer(address from, address to, uint256 tokenId) internal {
    _owners[tokenId] = to;  // 소유자 교체
    _balances[from] -= 1;
    _balances[to]   += 1;
}
```

**ERC-1155 — 수량 기반:**

```solidity
mapping(address => mapping(uint256 => uint256)) private _balances;
// account → (tokenId → 수량)
// 여러 명이 같은 tokenId를 보유 가능. "소유자" 개념 없음

// 전송: 수량을 옮긴다
function _safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes memory data) internal {
    _balances[from][id] -= amount;  // from 수량 감소
    _balances[to][id]   += amount;  // to 수량 증가
}
```

**핵심 차이 요약:**

```
ERC-721: 고객 A가 종신보험 NFT #1001을 소유 → ownerOf(1001) = A
ERC-1155: 고객 A가 걷기달성 NFT(tokenId=X)를 1개 보유
          고객 B도 걷기달성 NFT(tokenId=X)를 1개 보유
          → balanceOf(A, X) = 1, balanceOf(B, X) = 1
          → "소유자" 개념 없음. 수량만
```

ERC-1155에 `ownerOf`가 없는 이유가 이것이다. 같은 tokenId를 여러 명이 보유할 수 있으므로 "소유자"를 특정할 수 없다.

### ERC-1155 수신 콜백 완전 이해

ERC-721과 마찬가지로, ERC-1155도 컨트랙트에 전송할 때 수신 콜백을 요구한다.

**단건 전송 콜백:**

```solidity
interface IERC1155Receiver {
    function onERC1155Received(
        address operator,   // 전송 실행 주소
        address from,       // 이전 소유자 (mint이면 address(0))
        uint256 id,         // tokenId
        uint256 value,      // 수량
        bytes calldata data
    ) external returns (bytes4);
}

// 반환해야 하는 매직 바이트:
// bytes4(keccak256("onERC1155Received(address,address,uint256,uint256,bytes)"))
// = 0xf23a6e61
```

**배치 전송 콜백:**

```solidity
function onERC1155BatchReceived(
    address operator,
    address from,
    uint256[] calldata ids,
    uint256[] calldata values,
    bytes calldata data
) external returns (bytes4);

// 반환해야 하는 매직 바이트:
// bytes4(keccak256("onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)"))
// = 0xbc197c81
```

**반환값이 정확해야 하는 이유:**

```solidity
// OZ ERC1155 내부 구현 (단순화)
function _doSafeTransferAcceptanceCheck(...) private {
    if (to.code.length > 0) {  // to가 컨트랙트이면
        bytes4 response = IERC1155Receiver(to).onERC1155Received(...);
        if (response != IERC1155Receiver.onERC1155Received.selector) {
            revert("ERC1155: ERC1155Receiver rejected tokens");
            // 잘못된 값 반환 → revert → NFT 전송 실패
            // → 의도치 않은 NFT 잠김 방지
        }
    }
}
```

반환값이 정확한 매직 바이트(selector)가 아니면 전송 자체가 revert된다. 이것이 NFT를 처리할 수 없는 컨트랙트에 잠기는 것을 방지하는 메커니즘이다.

**KyoboNFT에서의 적용:**  
교보 시스템에서 고객 지갑은 EOA(개인 지갑)이므로 콜백 검사가 불필요하다. 그러나 향후 스마트 지갑(AA, Account Abstraction)이나 다른 컨트랙트와 상호작용 시 이 메커니즘이 중요해진다.

### KyoboNFT 설계 결정의 비즈니스 맥락

**왜 ERC-721이 아닌 ERC-1155인가:**

```
ERC-721이라면:
  걷기달성 10,000명 → 10,000개의 서로 다른 tokenId → 10,000번 mint
  → 각 고객의 NFT가 완전히 고유 → 개인 맞춤 정보 담기 좋음
  → 단점: 10,000번 트랜잭션, gas 비용 10,000배

ERC-1155를 선택한 이유:
  "걷기달성 NFT" tokenId는 하나 (예: 0x000100000001)
  이 tokenId를 고객 10,000명에게 각각 1개씩 mint
  → mintBatch 루프 1번 실행 (실제로는 청크 단위로 여러 트랜잭션이지만)
  → 같은 상품을 여러 명이 받는 "fungible 측면"이 있음
  → ERC-1155가 자연스러운 선택
```

**왜 UUPS인가:**

보험업의 특성:
- 금융감독원 규정 변경 → NFT 발행 로직 변경 필요
- 상품 코드 체계 변경 → tokenId 인코딩 변경 필요
- 버그 발견 시 수정 필요

UUPS(Universal Upgradeable Proxy Standard)를 쓰면 프록시 주소(고객이 알고 있는 컨트랙트 주소)는 유지하면서 내부 로직만 교체 가능. 고객 지갑에 저장된 NFT는 그대로, 로직만 업데이트.

```
고객 지갑: balanceOf(userAddress, tokenId) → 1
           → 이 값은 프록시 스토리지에 저장
           → 로직 컨트랙트 교체해도 스토리지 유지
           → 고객에게는 변화 없음
```

**mintBatch를 표준 ERC-1155 배치가 아닌 커스텀으로 한 이유:**

```
ERC-1155 표준 _mintBatch(address to, uint256[] ids, uint256[] amounts):
  → 단일 수신자(to)에게 여러 tokenId 발행
  → [id1, id2, id3]를 Alice 한 명에게

KyoboNFT mintBatch(address[] to, uint256[] tokenIds, uint256[] amounts):
  → 여러 수신자에게 각각 발행
  → [id1]을 [Alice, Bob, Carol, ...] 에게 각각

교보생명 요건: "걷기달성 이벤트 발생 → 해당 고객 N명에게 동일 tokenId NFT 발행"
→ N명에게 같은 tokenId를 발행하는 패턴
→ 표준 _mintBatch가 아닌 주소 배열을 루프 도는 커스텀 구현
```

---

## 강의 파트 (50분)

### 1. ERC-1155란 — 다중 토큰 표준

ERC-1155는 2018년 Enjin의 Witek Radomski가 제안한 표준이다. 하나의 컨트랙트에서 대체 가능 토큰(FT)과 대체 불가능 토큰(NFT)을 **tokenId로 구분해 동시에 관리**한다.

**왜 ERC-1155가 필요한가:**

```
ERC-20 방식: 상품마다 컨트랙트를 따로 배포
  KyoboWalkNFT.sol  (걷기달성 NFT)
  KyoboHealthNFT.sol (건강검진 NFT)
  KyoboCouponNFT.sol (쿠폰 NFT)
  → 상품이 100종이면 컨트랙트 100개

ERC-1155 방식: 컨트랙트 1개, tokenId로 구분
  KyoboNFT.sol
    tokenId=0x0001_0000...0001  → 걷기달성 NFT
    tokenId=0x0002_0000...0001  → 건강검진 NFT
    tokenId=0x0010_0000...0001  → 쿠폰 NFT
```

**배치 전송 — 핵심 장점:**

```solidity
// ERC-721: 3명에게 3종 NFT 발행 = 트랜잭션 9번
mint(userA, tokenId1);  mint(userA, tokenId2);  mint(userA, tokenId3);
mint(userB, tokenId1);  ...

// ERC-1155: 1번의 트랜잭션으로 처리
mintBatch([userA, userB, userC], [id1, id2, id3], [1, 1, 1]);
```

gas 절감: 단건 mint가 ~50K gas이면 500건 배치는 ~25M gas (1회 트랜잭션). ERC-721로 500번 각각 발행하면 트랜잭션 수수료도 500배.

**배치 전송의 원자성:**  
`safeBatchTransferFrom`이 실패하면 전체 롤백. 부분 실행 없음. A에게 주고 B에게 못 주는 상황이 발생하지 않는다.

---

### 2. ERC-1155 표준 인터페이스

```solidity
interface IERC1155 {
    // ── 조회 ────────────────────────────────────────────────────────────

    // 주소가 보유한 특정 tokenId의 수량
    function balanceOf(address account, uint256 id)
        external view returns (uint256);

    // 여러 주소·여러 tokenId 한 번에 조회
    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids)
        external view returns (uint256[] memory);

    // operator가 owner의 모든 토큰을 다룰 수 있는지 여부
    function isApprovedForAll(address account, address operator)
        external view returns (bool);

    // ── 전송 ────────────────────────────────────────────────────────────

    // 단건 전송: from → to, tokenId의 amount만큼
    function safeTransferFrom(
        address from, address to, uint256 id, uint256 amount, bytes calldata data
    ) external;

    // 배치 전송: 여러 tokenId·수량을 한 번에
    function safeBatchTransferFrom(
        address from, address to,
        uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data
    ) external;

    // ── 승인 ────────────────────────────────────────────────────────────

    // operator에게 모든 토큰 전송 권한 위임
    function setApprovalForAll(address operator, bool approved) external;

    // ── 이벤트 ──────────────────────────────────────────────────────────
    event TransferSingle(address indexed operator, address indexed from,
                         address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from,
                        address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);
}
```

**ERC-721과 가장 큰 차이:**

| | ERC-721 | ERC-1155 |
|---|---|---|
| 잔액 조회 | `balanceOf(address)` → 총 개수 | `balanceOf(address, tokenId)` → 특정 id 수량 |
| 소유자 조회 | `ownerOf(tokenId)` | 없음 (수량 기반) |
| 개별 approve | `approve(to, tokenId)` | 없음 |
| 전체 위임 | `setApprovalForAll` | `setApprovalForAll` (동일) |
| 배치 이벤트 | 없음 | `TransferBatch` |

ERC-1155는 `ownerOf`가 없다. "누가 소유"하는 개념 대신 "누가 얼마나 보유"하는 수량 개념으로 동작한다. 같은 tokenId를 여러 명이 보유할 수 있기 때문이다.

---

### 3. tokenId 설계 — KyoboNFT 비트 레이아웃

KyoboNFT의 tokenId는 단순 순번이 아니다. 비트 인코딩으로 의미를 담는다.

```
uint256 tokenId 비트 레이아웃:
┌─────────────────────────────────────────────────────────────┐
│ [255 ~ 128]  미사용 (예약)                                   │
│ [127 ~  64]  productCode : 상품 종류 (uint64)               │
│ [ 63 ~   0]  eventCode   : 세부 이벤트 번호 (uint64)        │
└─────────────────────────────────────────────────────────────┘

상품 코드 예시:
  0x01 → 걷기 달성 NFT
  0x02 → 건강검진 NFT
  0x10 → 쿠폰 NFT

tokenId 예시:
  encodeTokenId(0x01, 42)
  = (0x01 << 64) | 42
  = 0x000000000000000100000000000000_2a
  → "걷기 달성 이벤트 #42"
```

**인코딩 / 디코딩 코드:**

```solidity
uint8 public constant PRODUCT_CODE_SHIFT = 64;

function encodeTokenId(
    uint64 productCode,
    uint64 eventCode
) public pure returns (uint256) {
    require(productCode > 0, "productCode cannot be zero");  // 충돌 방지
    return (uint256(productCode) << PRODUCT_CODE_SHIFT) | uint256(eventCode);
}

function decodeTokenId(uint256 tokenId)
    public pure returns (uint64 productCode, uint64 eventCode)
{
    productCode = uint64(tokenId >> PRODUCT_CODE_SHIFT);
    eventCode   = uint64(tokenId);  // 하위 64비트 자동 마스킹
}
```

**왜 이 구조인가:**
- tokenId만 보고 상품 종류와 이벤트를 즉시 파악 가능
- 상품 코드 범위별 조회 가능 (걷기달성 전체 = productCode 0x01인 것들)
- 충돌 없는 tokenId 공간 보장
- productCode=0 금지: 0을 허용하면 순수 eventCode와 충돌 가능

---

### 4. KyoboNFT.sol 전체 해부

실제 프로덕션 코드를 줄 단위로 읽는다.

#### 4-1. 다중 상속 선언

```solidity
contract KyoboNFT is
    Initializable,            // ① 초기화 1회 보장
    ERC1155Upgradeable,       // ② ERC-1155 구현 (업그레이드 가능 버전)
    AccessControlUpgradeable, // ③ 역할 기반 접근 제어
    PausableUpgradeable,      // ④ 긴급 정지
    UUPSUpgradeable           // ⑤ 업그레이드 패턴
```

S35에서 배운 다중 상속이 여기서 실제로 적용된다. 5개 컨트랙트를 동시에 상속한다.

**Upgradeable 버전을 쓰는 이유:**  
일반 `ERC1155`는 constructor에서 초기화한다. 그런데 UUPS 프록시 패턴에서는 constructor가 프록시에서 실행되지 않는다. `ERC1155Upgradeable`은 `__ERC1155_init()`으로 초기화를 분리해 프록시와 함께 사용 가능하게 한다.

#### 4-2. 역할 상수

```solidity
bytes32 public constant MINTER_ROLE   = keccak256("MINTER_ROLE");
bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
```

S36에서 배운 AccessControl 역할 3종. `UPGRADER_ROLE`이 추가되었다 — 컨트랙트 업그레이드는 별도 역할로 분리한다.

#### 4-3. constructor와 initialize — UUPS의 핵심 차이

```solidity
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers();  // ← 구현체 직접 초기화 차단
}

function initialize(address admin) public initializer {
    __ERC1155_init("");
    __AccessControl_init();
    __Pausable_init();

    _grantRole(DEFAULT_ADMIN_ROLE, admin);
    _grantRole(MINTER_ROLE,        admin);
    _grantRole(PAUSER_ROLE,        admin);
    _grantRole(UPGRADER_ROLE,      admin);
}
```

```
일반 컨트랙트          UUPS 업그레이드 패턴
─────────────────     ──────────────────────────────────
constructor() 초기화   constructor → _disableInitializers()
                       프록시 배포 → initialize() 호출 (1회만)
```

`_disableInitializers()`는 구현체 컨트랙트에 직접 접근해서 `initialize()`를 다시 호출하는 공격을 막는다.

**`_disableInitializers()` 없으면 발생하는 공격:**

```
① 프록시(P)와 구현체(I) 배포
② 정상 사용자는 P를 통해 I에 접근 → initialize() 이미 실행됨
③ 공격자가 I에 직접 접근 → initialize(attackerAddress) 호출
   → 공격자가 구현체의 admin이 됨
④ 공격자가 _authorizeUpgrade()로 악성 구현체로 교체
   → 프록시가 악성 코드를 실행하게 됨
→ 전체 시스템 탈취 가능
```

#### 4-4. mint — 단건 발행

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

- `onlyRole(MINTER_ROLE)`: VASP 서버 주소에만 이 역할이 있다
- `whenNotPaused`: 긴급 정지 시 발행 차단
- `_mint(to, tokenId, amount, "")`: OZ 내부 구현 호출 → `TransferSingle` 이벤트 발행

#### 4-5. mintBatch — 배치 발행

```solidity
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

표준 ERC-1155의 `_mintBatch`(단일 수신자, 여러 tokenId)가 아닌 **여러 수신자에게 각각 발행**하는 방식임을 주목. Phase 1 요건(보험 이벤트 발생 시 각 사용자에게 개별 발행)에 맞춘 설계다.

**배열 길이 검증이 필수인 이유:**

```solidity
// 길이 검증 없으면:
// to = [Alice, Bob, Carol]  (3명)
// tokenIds = [id1, id2]     (2개)
// → 루프에서 tokenIds[2] 접근 시 out-of-bounds revert
// → gas 낭비 + 예측 불가능한 동작
// → require로 미리 체크하면 즉시 revert, 명확한 오류 메시지
```

gas 설계: 건당 ~50K gas × 500건 ≈ 25M. EVM block gas limit(~30M) 내에 안전하게 들어온다. 500건 초과 시 분할 필요 — 이것이 M5에서 구현한 `BulkIssueService`의 청크 분할 근거다.

#### 4-6. _update hook — Pausable 연결

```solidity
function _update(
    address from,
    address to,
    uint256[] memory ids,
    uint256[] memory values
) internal override whenNotPaused {
    super._update(from, to, ids, values);
}
```

ERC-1155의 모든 잔액 변경(mint·burn·transfer)이 `_update`를 거친다. 여기에 `whenNotPaused`를 붙여 정지 중 모든 동작을 차단한다. S36에서 배운 패턴의 실제 적용이다.

**`_update`가 mint에도 적용되는 이유:**  
OZ ERC-1155에서 `_mint`, `_burn`, `_safeTransferFrom` 모두 내부적으로 `_update`를 호출한다. 즉, pause 상태에서는 mint·burn·transfer 전부 차단됨. 별도로 각 함수에 `whenNotPaused`를 달지 않아도 된다.

#### 4-7. supportsInterface — 다중 상속 충돌 해소

```solidity
function supportsInterface(bytes4 interfaceId)
    public view
    override(ERC1155Upgradeable, AccessControlUpgradeable)
    returns (bool)
{
    return super.supportsInterface(interfaceId);
}
```

`ERC1155Upgradeable`과 `AccessControlUpgradeable` 둘 다 `supportsInterface`를 구현한다. 다중 상속 충돌 → `override(A, B)` 명시 + `super`로 MRO 위임. S35에서 배운 다중 상속 규칙이다.

**EIP-165 supportsInterface의 역할:**

```solidity
// 외부에서 "이 컨트랙트가 ERC-1155를 지원하는가?" 확인 방법
bytes4 ERC1155_INTERFACE_ID = 0xd9b67a26;
bool supported = kyoboNFT.supportsInterface(ERC1155_INTERFACE_ID);
// true → ERC-1155 지원
// OpenSea, 마켓플레이스들이 이 방식으로 토큰 종류를 자동 감지
```

#### 4-8. _authorizeUpgrade — 업그레이드 권한

```solidity
function _authorizeUpgrade(address /* newImplementation */)
    internal override onlyRole(UPGRADER_ROLE)
{
    // UPGRADER_ROLE 체크만으로 충분
}
```

UUPS 업그레이드 시 이 함수가 호출된다. `UPGRADER_ROLE`이 없으면 업그레이드 트랜잭션이 revert된다. M7에서 실제 업그레이드를 실습한다.

---

### 5. Phase 1 전체 흐름에서 KyoboNFT의 위치

```
M5 VaspAdapter.submitMint(userId, tokenId, amount)
  → VASP 서버 수신
    → KyoboNFT.mint(walletAddr, tokenId, amount)
      ↑ MINTER_ROLE 검증
      ↑ whenNotPaused 검증
      → _mint() 실행 → _balances[walletAddr][tokenId] += amount
        → emit TransferSingle(VASP, address(0), walletAddr, tokenId, amount)
          → VASP가 txHash 수신
            → M2 WebhookReceiver 콜백 수신
              → M3 TxStateMachine: SUBMITTED → MINED → CONFIRMED
                → M4 원장 업데이트
```

각 모듈이 이 흐름의 한 단계씩을 담당한다. KyoboNFT는 중심에서 온체인 상태를 기록하는 역할이다.

---

### 6. ERC-20 / ERC-721 / ERC-1155 최종 정리

| | ERC-20 | ERC-721 | ERC-1155 |
|---|---|---|---|
| 토큰 종류 | 1종 | 1종 (고유 ID) | N종 (tokenId로 구분) |
| 수량 | 분할 가능 | 항상 1개 | tokenId당 수량 |
| 잔액 조회 | `balanceOf(addr)` | `balanceOf(addr)` (개수) | `balanceOf(addr, id)` |
| 소유자 조회 | — | `ownerOf(tokenId)` | — (수량만) |
| 배치 전송 | 없음 | 없음 | `safeBatchTransferFrom` |
| 개별 approve | `approve(spender, amount)` | `approve(to, tokenId)` | 없음 |
| 전체 위임 | — | `setApprovalForAll` | `setApprovalForAll` |
| 이벤트 | `Transfer` | `Transfer` | `TransferSingle` / `TransferBatch` |
| 수신 콜백 | 없음 | `onERC721Received` | `onERC1155Received` / `onERC1155BatchReceived` |
| KyoboNFT | — | — | ✓ |

**KyoboNFT가 ERC-1155를 선택한 이유:**
1. 보험 상품 종류가 여러 개 → 컨트랙트 1개로 관리
2. 동일 이벤트를 여러 고객에게 한 번에 발행 → `mintBatch` gas 절감
3. 특정 고객의 특정 상품 보유량 조회 → `balanceOf(user, tokenId)`
4. 같은 상품을 여러 명이 보유하는 "fungible 측면" 존재 → ERC-1155 수량 모델이 자연스러움

---

## 실습 파트 (10분)

### Remix에서 KyoboNFT 핵심 함수 직접 실행

S36에서 만든 `KyoboMintController`를 ERC-1155 기반으로 업그레이드한다.  
새 파일 `KyoboNFTSimple.sol` 작성 (UUPS 없는 단순 버전, 개념 확인용):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract KyoboNFTSimple is ERC1155, AccessControl, Pausable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint8 public constant PRODUCT_CODE_SHIFT = 64;

    constructor() ERC1155("https://api.kyobo.com/nft/{id}.json") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    function encodeTokenId(uint64 productCode, uint64 eventCode)
        public pure returns (uint256)
    {
        require(productCode > 0, "productCode cannot be zero");
        return (uint256(productCode) << PRODUCT_CODE_SHIFT) | uint256(eventCode);
    }

    function decodeTokenId(uint256 tokenId)
        public pure returns (uint64 productCode, uint64 eventCode)
    {
        productCode = uint64(tokenId >> PRODUCT_CODE_SHIFT);
        eventCode   = uint64(tokenId);
    }

    function mint(address to, uint256 tokenId, uint256 amount)
        public onlyRole(MINTER_ROLE) whenNotPaused
    {
        require(amount > 0, "KyoboNFT: zero amount");
        _mint(to, tokenId, amount, "");
    }

    function mintBatch(
        address[] calldata to,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts
    ) public onlyRole(MINTER_ROLE) whenNotPaused {
        require(
            to.length == tokenIds.length && tokenIds.length == amounts.length,
            "length mismatch"
        );
        for (uint256 i = 0; i < to.length; i++) {
            _mint(to[i], tokenIds[i], amounts[i], "");
        }
    }

    function pause()   public onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() public onlyRole(PAUSER_ROLE) { _unpause(); }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC1155, AccessControl) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
```

**확인 시나리오 (5분):**

```
① encodeTokenId(1, 42) → tokenId 확인
   decodeTokenId(tokenId) → (1, 42) 역방향 확인

② encodeTokenId(0, 42) → revert: "productCode cannot be zero" 확인
   (productCode=0 충돌 방지 동작 확인)

③ mint(Account2주소, tokenId, 1)
   → TransferSingle 이벤트: from=0x0, to=Account2, id=tokenId, value=1

④ balanceOf(Account2주소, tokenId) → 1

⑤ mint(Account3주소, tokenId, 1)
   balanceOf(Account3주소, tokenId) → 1
   (ERC-721과 달리 같은 tokenId를 두 명이 보유 — ownerOf 없음)

⑥ balanceOfBatch([Account2주소, Account3주소], [tokenId, tokenId]) → [1, 1]
   (2명의 잔액을 1번 호출로 조회)
```

---

## 완료 기준

- [ ] ERC-1155가 ERC-721보다 배치 발행에서 gas가 절감되는 이유 설명 가능
- [ ] `balanceOf(addr, tokenId)` vs ERC-721 `ownerOf(tokenId)` 차이 설명 가능
- [ ] 같은 tokenId를 여러 명이 보유할 수 있는 이유 설명 가능
- [ ] `encodeTokenId(productCode, eventCode)` 비트 인코딩 원리 + productCode=0 금지 이유 설명 가능
- [ ] `mintBatch`에서 배열 길이 검증이 필요한 이유 설명 가능
- [ ] `_disableInitializers()`가 constructor에 있는 이유 + 없을 때 공격 시나리오 설명 가능
- [ ] `_update` hook에 `whenNotPaused`를 거는 이유 설명 가능
- [ ] `supportsInterface` override가 필요한 이유 설명 가능
- [ ] KyoboNFT가 ERC-721이 아닌 ERC-1155를 선택한 비즈니스 이유 설명 가능
- [ ] Phase 1 전체 흐름에서 KyoboNFT.mint()가 호출되는 위치 설명 가능

---

## 강사 노트

**반드시 짚을 것:**  
`mintBatch`의 루프 구조가 왜 `address[] calldata to`인지 — 표준 ERC-1155의 `_mintBatch`는 단일 수신자에게 여러 tokenId를 발행한다. KyoboNFT는 여러 수신자에게 각각 발행하는 요건이므로 루프로 구현했다. 이 차이를 명확히 설명할 것.

**ERC-721 ownerOf vs ERC-1155 balanceOf:**  
"ERC-1155에서 ownerOf를 쓰면 되지 않나요"라는 질문이 나올 수 있다. ERC-1155에서는 같은 tokenId를 여러 명이 보유할 수 있으므로 "소유자"를 한 명으로 특정할 수 없다. 이것이 ownerOf가 없는 근본 이유.

**배치 전송 원자성:**  
"A에게는 주고 B에게는 못 주는 상황이 없다"는 원자성을 DeFi 맥락(스왑, 에스크로)과 연결하면 중요성이 드러난다.

**productCode=0 금지:**  
강사 배경 섹션의 충돌 시나리오를 칠판에 그려줄 것. `(0 << 64) | 42 = 42`가 순수 eventCode=42와 같다는 것을 수식으로 보여주면 이해가 빠르다.

**_disableInitializers 공격 시나리오:**  
실제로 2022년 여러 업그레이드 가능 컨트랙트에서 이 취약점이 발견됐다. "왜 이 줄이 필요한가"를 공격 시나리오와 함께 설명하면 기억에 남는다.

**500건 제한 근거 연결:**  
M5 BulkIssueService의 청크 분할(500건/배치)이 여기서 나왔다. "block gas limit ~30M, 건당 ~50K gas × 500 ≈ 25M — 안전 여유 포함"을 코드와 함께 다시 설명하면 M5 코드와 연결이 된다.

**Upgradeable 버전 vs 일반 버전:**  
실습에서는 `ERC1155`(일반 버전)를 사용했다. 실제 KyoboNFT는 `ERC1155Upgradeable`이다. 차이는 M7에서 UUPS를 구현할 때 설명한다. 지금은 "Upgradeable 버전은 constructor 대신 initialize를 쓴다"는 것만 기억하게 할 것.

**S40 예고:**  
다음 모듈(M7)에서 실제 KyoboNFT.sol을 Hardhat 환경에서 완성하고 Sepolia에 배포한다. 오늘 해부한 코드가 그대로 사용된다.
