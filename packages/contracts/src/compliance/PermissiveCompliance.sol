// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "../interfaces/ICompliance.sol";

/**
 * @title PermissiveCompliance
 * @notice Phase 1 컴플라이언스 구현체 — 모든 전송을 허용한다.
 *
 * 사용 시점:
 *   - Phase 1 NFT (행동 보상): 규제 대상 아님, KYC만 필요
 *   - 테스트 환경: 컴플라이언스 로직 없이 컨트랙트 기능 검증 시
 *
 * Phase 3 전환 방법:
 *   BaseToken.updateCompliance(InvestorCompliance 주소)
 *   → 컨트랙트 재배포 없이 규제 강도 교체 가능
 *
 * 주의: 이 구현체를 Phase 2/3 STO에 사용하면 안 됨.
 *       Phase 2 이상은 반드시 InvestorCompliance 또는 그 이상 구현체로 교체.
 */
contract PermissiveCompliance is ICompliance, AccessControl {
    bytes32 public constant COMPLIANCE_ADMIN_ROLE = keccak256("COMPLIANCE_ADMIN_ROLE");

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(COMPLIANCE_ADMIN_ROLE, msg.sender);
    }

    /**
     * @notice 전송 항상 허용
     *         Phase 1 NFT는 규제 대상이 아니므로 전송 제한 없음.
     */
    function canTransfer(
        address /* from */,
        address /* to */,
        uint256 /* amount */
    ) external pure override returns (bool) {
        return true;
    }

    /**
     * @notice 전송 후 기록 — Phase 1은 별도 상태 추적 없음
     */
    function transferred(
        address /* from */,
        address /* to */,
        uint256 /* amount */
    ) external override {
        // no-op
    }

    /**
     * @notice KYC 검증 여부 — Phase 1은 온체인 KYC 레지스트리 없음
     *         KYC는 오프체인(IssuerService → IKYCProvider)에서 처리
     */
    function isVerified(address /* account */) external pure override returns (bool) {
        return true;
    }
}
