// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// =============================================================================
// Phase 3 STUB — STO 투자자 컴플라이언스
// =============================================================================
// 구현 시점: 금융위 토큰증권 가이드라인 적용 + InvestorRegistry 배포 후
//
// 이 컨트랙트는 Phase 1 PermissiveCompliance를 교체한다.
// 교체 방법: BaseToken.updateCompliance(InvestorCompliance 주소)
//
// 검증 체계 (순서대로 실행):
//   1. 수신자 투자자 등록 여부 (IInvestorRegistry.isRegistered)
//   2. 파티션별 보유 한도 초과 여부 (IInvestorRegistry.canAcceptTransfer)
//   3. 락업 기간 중 여부 (IInvestorRegistry.getPartitionLimit.lockedUntil)
//   4. AML 블랙리스트 (오프체인 VASP 스크리닝 결과를 온체인에 반영할 경우)
// =============================================================================

import "@openzeppelin/contracts/access/AccessControl.sol";
import "../interfaces/ICompliance.sol";
import "../interfaces/IInvestorRegistry.sol";

contract InvestorCompliance is ICompliance, AccessControl {
    bytes32 public constant COMPLIANCE_ADMIN_ROLE = keccak256("COMPLIANCE_ADMIN_ROLE");

    IInvestorRegistry public investorRegistry;

    // 현재 처리 중인 파티션 컨텍스트 — SecurityToken이 호출 전 세팅
    // transferByPartition()에서 partition 정보를 Compliance 훅에 전달하기 위한 패턴
    bytes32 private _activePartition;

    event RegistryUpdated(address indexed newRegistry);

    constructor(address registry_) {
        investorRegistry = IInvestorRegistry(registry_);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(COMPLIANCE_ADMIN_ROLE, msg.sender);
    }

    /**
     * @notice 파티션 컨텍스트 설정 — SecurityToken.transferByPartition() 내부에서 호출
     *         Phase 3: SecurityToken 구현 시 실제 연동
     */
    function setActivePartition(bytes32 partition) external {
        // Phase 3: onlyRole(TOKEN_CONTRACT_ROLE) 추가 필요
        _activePartition = partition;
    }

    /**
     * @notice 전송 가능 여부 — 투자자 등록·한도·락업 검증
     *
     * Phase 3 구현 시 체크 항목:
     *   - from == address(0) (발행)인 경우 to만 검증
     *   - 전문투자자(PROFESSIONAL)는 한도 검증 스킵
     */
    function canTransfer(
        address /* from */,
        address /* to */,
        uint256 /* amount */
    ) external pure override returns (bool) {
        // Phase 3: 아래 로직 구현

        // 1. 투자자 등록 여부
        // if (!investorRegistry.isRegistered(to)) return false;

        // 2. 파티션별 수용 가능 여부 (보유 한도 + 락업)
        // (bool allowed, ) = investorRegistry.canAcceptTransfer(to, _activePartition, amount);
        // if (!allowed) return false;

        // 3. 전문투자자는 한도 검증 스킵
        // IInvestorRegistry.InvestorInfo memory info = investorRegistry.getInvestorInfo(to);
        // if (info.investorType == IInvestorRegistry.InvestorType.PROFESSIONAL) return true;

        // Phase 3 완성 전 임시 허용 (배포 후 즉시 실제 로직으로 교체)
        return true;
    }

    /**
     * @notice 전송 후 보유량 업데이트
     *
     * Phase 3 구현 시:
     *   - from(소각 아닌 경우) 보유량 감소
     *   - to 보유량 증가
     *   - 전문투자자는 업데이트 스킵
     */
    function transferred(
        address /* from */,
        address to,
        uint256 amount
    ) external override {
        // Phase 3:
        // if (from != address(0)) {
        //     investorRegistry.updateHolding(from, _activePartition, amount, false);
        // }
        // investorRegistry.updateHolding(to, _activePartition, amount, true);
    }

    /**
     * @notice KYC 등록 여부 — InvestorRegistry 조회
     */
    function isVerified(address /* account */) external pure override returns (bool) {
        // Phase 3: return investorRegistry.isRegistered(account);
        return true;
    }

    function updateRegistry(address newRegistry) external onlyRole(COMPLIANCE_ADMIN_ROLE) {
        investorRegistry = IInvestorRegistry(newRegistry);
        emit RegistryUpdated(newRegistry);
    }
}
