// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IInvestorRegistry.sol";

/// 테스트 전용 — 모든 투자자를 PROFESSIONAL로 허용
contract MockInvestorRegistry is IInvestorRegistry {

    mapping(address => bool) private _registered;

    function register(
        address investor,
        InvestorType,
        uint256,
        bytes32[] calldata,
        uint256
    ) external override {
        _registered[investor] = true;
        emit InvestorRegistered(investor, InvestorType.PROFESSIONAL);
    }

    function revoke(address investor, bytes32 reason) external override {
        _registered[investor] = false;
        emit InvestorRevoked(investor, reason);
    }

    function isRegistered(address investor) external view override returns (bool) {
        return _registered[investor];
    }

    function getInvestorInfo(address investor) external view override returns (InvestorInfo memory) {
        return InvestorInfo({
            investorType: _registered[investor] ? InvestorType.PROFESSIONAL : InvestorType.NONE,
            registeredAt: 0,
            expiresAt: 0
        });
    }

    function getPartitionLimit(address, bytes32) external pure override returns (PartitionLimit memory) {
        return PartitionLimit({ maxHolding: type(uint256).max, currentHolding: 0, lockedUntil: 0 });
    }

    function canAcceptTransfer(address investor, bytes32, uint256) external view override returns (bool, bytes32) {
        return (_registered[investor], bytes32(0));
    }

    function updateHolding(address, bytes32, uint256, bool) external override {}

    function setLockup(address investor, bytes32 partition, uint256 lockedUntil) external override {
        emit LockupSet(investor, partition, lockedUntil);
    }
}
