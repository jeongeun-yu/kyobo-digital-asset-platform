// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ICompliance
 * @notice 모든 토큰 전송·발행 전후에 호출되는 규제 준수 훅.
 *         Phase 1에서는 최소 구현(허용만), Phase 3 STO에서 KYC/AML 풀 적용.
 *         컨트랙트 로직과 규제 로직을 분리해 규제 변경 시 컨트랙트 재배포 없이 대응 가능.
 */
interface ICompliance {
    /**
     * @notice 전송 가능 여부 검증
     * @param from 송신자 (발행 시 address(0))
     * @param to   수신자
     * @param amount NFT tokenId 또는 ERC-20 수량
     * @return 허용 여부
     */
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);

    /**
     * @notice 전송 완료 후 규제 기록 업데이트
     */
    function transferred(address from, address to, uint256 amount) external;

    /**
     * @notice KYC 등록 여부
     */
    function isVerified(address account) external view returns (bool);

    event ComplianceChecked(address indexed from, address indexed to, uint256 amount, bool allowed);
    event KYCStatusUpdated(address indexed account, bool verified);
}
