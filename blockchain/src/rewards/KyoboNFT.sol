// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title KyoboNFT
 * @notice Phase 1 행동 보상 NFT — ERC-1155 다중 토큰 표준
 *
 * M2 핵심 개념 (S5~S10):
 *   - ERC-1155: 쿠폰 종류별 발행 + mintBatch 가스 절감 (ERC-721 대비 ~60% 절약)
 *   - UUPS Proxy: 비즈니스 로직 업그레이드 가능 — Storage Collision 주의
 *   - AccessControl: MINTER_ROLE / PAUSER_ROLE / UPGRADER_ROLE
 *   - tokenId 설계: productCode(상위 64비트) | eventCode(하위 64비트)
 *
 * tokenId 비트 레이아웃:
 *   [127 ~ 64] productCode: 상품 종류 (걷기달성=0x01, 건강검진=0x02, 쿠폰=0x10, ...)
 *   [ 63 ~  0] eventCode:   세부 이벤트 / 쿠폰 시퀀스 번호
 *
 *   예: 걷기 달성 이벤트 #42 → encodeTokenId(0x01, 42) → tokenId
 *
 * 업그레이드 경로 (M3 S11):
 *   KyoboNFT v1 → KyoboNFTV2 (reinitializer(2), 새 변수는 끝에만 추가)
 *   Storage layout 충돌 시 기존 보유 토큰 전량 손실 — hardhat-storage-layout 으로 검증
 *
 * @dev UUPS 패턴이므로 constructor 대신 initialize() 사용.
 *      배포: upgrades.deployProxy(KyoboNFT, [admin], { kind: 'uups' })
 */
contract KyoboNFT is
    Initializable,
    ERC1155Upgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant MINTER_ROLE   = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// tokenId 인코딩: productCode는 상위 64비트
    uint8 public constant PRODUCT_CODE_SHIFT = 64;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice 프록시 초기화 — deployProxy 시 한 번만 호출됨
     * @param admin MINTER_ROLE / PAUSER_ROLE / UPGRADER_ROLE 초기 보유자
     */
    function initialize(address admin) public initializer {
        __ERC1155_init("");
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE,        admin);
        _grantRole(PAUSER_ROLE,        admin);
        _grantRole(UPGRADER_ROLE,      admin);
    }

    // ── tokenId 인코딩 / 디코딩 ─────────────────────────────────────────

    /**
     * @notice productCode + eventCode → tokenId
     * @dev    비트 시프트: (productCode << 64) | eventCode
     *         충돌 없는 tokenId 공간 설계 — 같은 상품의 다른 이벤트도 고유 ID 보장
     *
     * @param productCode 상품 종류 (uint64 범위, 0 사용 금지)
     * @param eventCode   세부 이벤트 번호
     */
    function encodeTokenId(
        uint64 productCode,
        uint64 eventCode
    ) public pure returns (uint256) {
        // M2 S5 실습: 비트 시프트로 두 코드를 하나의 uint256에 결합
        //   return (uint256(productCode) << PRODUCT_CODE_SHIFT) | uint256(eventCode);
        return (uint256(productCode) << PRODUCT_CODE_SHIFT) | uint256(eventCode);
    }

    /**
     * @notice tokenId → (productCode, eventCode) 역방향 디코딩
     * @dev    상위 64비트 추출: tokenId >> 64, 하위 64비트: tokenId & 0xFFFFFFFFFFFFFFFF
     */
    function decodeTokenId(
        uint256 tokenId
    ) public pure returns (uint64 productCode, uint64 eventCode) {
        // M2 S5 실습: 역방향 비트 마스킹
        productCode = uint64(tokenId >> PRODUCT_CODE_SHIFT);
        eventCode   = uint64(tokenId);
    }

    // ── 발행 ────────────────────────────────────────────────────────────

    /**
     * @notice 단건 발행 — MINTER_ROLE 전용
     *
     * @param to      수령인
     * @param tokenId encodeTokenId()로 생성한 ID
     * @param amount  발행 수량 (1개 NFT라도 amount=1로 명시)
     */
    function mint(
        address to,
        uint256 tokenId,
        uint256 amount
    ) external onlyRole(MINTER_ROLE) whenNotPaused {
        // M3 S7 실습: 조건 체크 + _mint 호출
        //   require(amount > 0, "KyoboNFT: zero amount");
        //   _mint(to, tokenId, amount, "");
        require(amount > 0, "KyoboNFT: zero amount");
        _mint(to, tokenId, amount, "");
    }

    /**
     * @notice 배치 발행 — to 배열 각각에 tokenId/amount 발행
     *
     * 가스 한도 (S7 실습):
     *   EVM block gas limit ~30M. 건당 ~50K gas × 500건 ≈ 25M → 500건/배치 권장
     *   500건 초과 시 분할 필요 — executeBulkIssue() 참고 (BulkIssuerService.ts)
     *
     * @param to       수령인 주소 배열
     * @param tokenIds tokenId 배열
     * @param amounts  수량 배열
     */
    function mintBatch(
        address[] calldata to,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts
    ) external onlyRole(MINTER_ROLE) whenNotPaused {
        // M3 S7 실습: 배열 길이 검증 + 루프 _mint
        require(
            to.length == tokenIds.length && tokenIds.length == amounts.length,
            "KyoboNFT: length mismatch"
        );
        for (uint256 i = 0; i < to.length; i++) {
            _mint(to[i], tokenIds[i], amounts[i], "");
        }
    }

    // ── 소각 ────────────────────────────────────────────────────────────

    /**
     * @notice 소각 — 만료 처리 또는 운영 회수 시 사용 (MINTER_ROLE)
     */
    function burn(
        address from,
        uint256 tokenId,
        uint256 amount
    ) external onlyRole(MINTER_ROLE) {
        _burn(from, tokenId, amount);
    }

    // ── 일시정지 ────────────────────────────────────────────────────────

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ── UUPS 업그레이드 ─────────────────────────────────────────────────

    /**
     * @notice 업그레이드 승인 — UPGRADER_ROLE 전용
     *
     * Storage layout 규칙 (M3 S11):
     *   - 새 변수는 반드시 끝에만 추가 (기존 슬롯 변경 금지)
     *   - 타입 변경, 제거, 순서 변경 모두 Storage Collision → 토큰 소실
     *   - 검증: `yarn hardhat check` (hardhat-storage-layout 플러그인)
     *
     * KyoboNFTV2 예시:
     *   function initializeV2(string memory newBaseURI) public reinitializer(2) {
     *       baseURI = newBaseURI;   // 기존 변수 없음 → 끝에 추가
     *   }
     */
    function _authorizeUpgrade(address /* newImplementation */)
        internal
        override
        onlyRole(UPGRADER_ROLE)
    {
        // UPGRADER_ROLE 체크만으로 충분 — 추가 검증은 오프체인에서 수행
    }

    // ── Pause hook ──────────────────────────────────────────────────────

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override whenNotPaused {
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155Upgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
