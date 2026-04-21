// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "../interfaces/IToken.sol";
import "../interfaces/ICompliance.sol";

/**
 * @title BaseToken
 * @notice 모든 교보 토큰의 공통 기반.
 *         역할 기반 접근 제어(RBAC) + 일시정지 + 컴플라이언스 훅 내장.
 *         Phase 1 NFT, Phase 2 스테이블코인, Phase 3 STO 모두 이 베이스를 상속한다.
 */
abstract contract BaseToken is IToken, AccessControl, Pausable {
    bytes32 public constant ISSUER_ROLE   = keccak256("ISSUER_ROLE");
    bytes32 public constant REVOKER_ROLE  = keccak256("REVOKER_ROLE");
    bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    ICompliance public compliance;
    address private _issuer;

    constructor(address issuer_, address compliance_) {
        _issuer = issuer_;
        compliance = ICompliance(compliance_);

        _grantRole(DEFAULT_ADMIN_ROLE, issuer_);
        _grantRole(ISSUER_ROLE, issuer_);
        _grantRole(PAUSER_ROLE, issuer_);
    }

    function issuer() external view override returns (address) {
        return _issuer;
    }

    function pause() external override onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external override onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function updateCompliance(address newCompliance) external onlyRole(DEFAULT_ADMIN_ROLE) {
        compliance = ICompliance(newCompliance);
    }

    function _checkCompliance(address from, address to, uint256 amount) internal view {
        require(compliance.canTransfer(from, to, amount), "BaseToken: compliance check failed");
    }
}
