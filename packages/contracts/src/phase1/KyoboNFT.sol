// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "../base/BaseToken.sol";

/**
 * @title KyoboNFT
 * @notice Phase 1 — 행동 보상 NFT.
 *         걷기 달성 등 오프체인 이벤트가 오라클을 통해 검증되면 발행된다.
 *         NFTIssuer가 이 컨트랙트의 ISSUER_ROLE을 보유하며, 사용자가 직접 호출하지 않는다.
 *
 * Phase 2/3 확장 경로:
 *   - 동일한 BaseToken 상속 → KRWStablecoin, SecurityToken도 같은 RBAC/pause 구조
 *   - compliance 주소 교체만으로 KYC/AML 강도 조절 가능 (STO 규제 대응)
 */
contract KyoboNFT is ERC721URIStorage, BaseToken {
    TokenType private constant _TOKEN_TYPE = TokenType.NFT;

    uint256 private _nextTokenId;

    /// @notice 발행 근거 타입 — 온체인 감사 추적용
    enum RewardType { ACTIVITY, COUPON, MEMBERSHIP, RESERVED }

    struct TokenMeta {
        RewardType rewardType;
        uint256    issuedAt;
        bytes32    activityId;  // 오프체인 활동 ID (해시)
    }

    mapping(uint256 => TokenMeta) public tokenMeta;

    constructor(
        address issuer_,
        address compliance_
    )
        ERC721("KyoboDigitalAsset", "KYBO")
        BaseToken(issuer_, compliance_)
    {}

    function tokenType() external pure override returns (TokenType) {
        return _TOKEN_TYPE;
    }

    /**
     * @notice NFT 발행 — NFTIssuer만 호출 (ISSUER_ROLE)
     * @param to         수령인
     * @param uri        메타데이터 URI (IPFS 또는 교보 서버)
     * @param rewardType 보상 종류
     * @param activityId 오프체인 활동 ID
     */
    function issue(
        address to,
        string calldata uri,
        RewardType rewardType,
        bytes32 activityId
    ) external onlyRole(ISSUER_ROLE) whenNotPaused returns (uint256 tokenId) {
        _checkCompliance(address(0), to, 0);

        tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);

        tokenMeta[tokenId] = TokenMeta({
            rewardType: rewardType,
            issuedAt:   block.timestamp,
            activityId: activityId
        });

        emit Issued(to, tokenId, activityId);
    }

    /**
     * @notice NFT 회수 — 규제 또는 오류 대응 (REVOKER_ROLE)
     */
    function revoke(uint256 tokenId, bytes32 reason) external onlyRole(REVOKER_ROLE) {
        address owner = ownerOf(tokenId);
        _burn(tokenId);
        emit Revoked(owner, tokenId, reason);
    }

    /**
     * @notice 전송 전 컴플라이언스 검증
     *         Phase 1: 기본 허용 (Phase 3 STO에서 투자자 등록 검증으로 교체)
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override whenNotPaused returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            _checkCompliance(from, to, tokenId);
        }
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721URIStorage, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
