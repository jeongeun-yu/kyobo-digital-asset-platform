// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IOracle.sol";
import "./KyoboNFT.sol";

/**
 * @title NFTIssuer
 * @notice 오라클 데이터를 검증하고 KyoboNFT 발행을 실행하는 게이트웨이.
 *         사용자 또는 백엔드 서비스가 이 컨트랙트를 호출 → 오라클 검증 → NFT 발행.
 *         KyoboNFT를 직접 호출하는 경로를 차단해 발행 로직을 한 곳에 집중시킨다.
 *
 * 중복 발행 방지: activityId 기반 idempotency (오프체인 Webhook과 동일한 원리)
 */
contract NFTIssuer is AccessControl, ReentrancyGuard {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    KyoboNFT  public nft;
    IOracle   public oracle;

    /// @notice activityId → 발행 여부 (중복 방지)
    mapping(bytes32 => bool) public issued;

    string public baseMetadataURI;

    constructor(address nft_, address oracle_, string memory baseURI_) {
        nft    = KyoboNFT(nft_);
        oracle = IOracle(oracle_);
        baseMetadataURI = baseURI_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }

    /**
     * @notice 활동 달성 NFT 발행
     * @param to         수령인
     * @param activityId 오프체인 활동 고유 ID
     * @param oracleData 오라클 서명 데이터 (위변조 방지)
     */
    function issueActivityNFT(
        address to,
        bytes32 activityId,
        IOracle.OracleData calldata oracleData
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        require(!issued[activityId], "NFTIssuer: already issued");
        require(oracle.verify(oracleData), "NFTIssuer: invalid oracle data");
        require(oracleData.value >= 1, "NFTIssuer: activity not achieved");

        issued[activityId] = true;

        string memory uri = string(abi.encodePacked(
            baseMetadataURI, "/", _bytes32ToString(activityId)
        ));

        nft.issue(to, uri, KyoboNFT.RewardType.ACTIVITY, activityId);
    }

    /**
     * @notice 운영자 직접 발행 — 이벤트·캠페인 쿠폰 등
     */
    function issueCouponNFT(
        address to,
        bytes32 campaignId,
        string calldata uri
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        require(!issued[campaignId], "NFTIssuer: already issued");
        issued[campaignId] = true;
        nft.issue(to, uri, KyoboNFT.RewardType.COUPON, campaignId);
    }

    function updateOracle(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        oracle = IOracle(newOracle);
    }

    function _bytes32ToString(bytes32 b) internal pure returns (string memory) {
        bytes memory result = new bytes(64);
        bytes memory hexChars = "0123456789abcdef";
        for (uint256 i = 0; i < 32; i++) {
            result[i * 2]     = hexChars[uint8(b[i] >> 4)];
            result[i * 2 + 1] = hexChars[uint8(b[i] & 0x0f)];
        }
        return string(result);
    }
}
