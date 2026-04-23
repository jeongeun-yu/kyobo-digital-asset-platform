// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IDividendDistributor
 * @notice Phase 3 STO — 배당·이자 분배 인터페이스.
 *
 * 설계 원칙:
 *   - 분배는 "스냅샷 기준" — 특정 블록의 파티션 보유자 목록 기준
 *   - 투자자가 직접 청구(claim) — push 방식 아님 (가스 절감 + 재진입 방지)
 *   - 결제 수단: KRWStablecoin (Phase 2) 또는 ETH/ERC-20
 *   - 미청구 배당은 만료 후 발행자 회수 가능
 *
 * 교보생명 활용 시나리오:
 *   - 보험상품 수익 배분 (연 1~2회)
 *   - 채권형 STO 이자 지급 (월별)
 *   - 우선주 배당
 *
 * 예탁결제원 연동:
 *   - distributeDividend() 호출 시 KDEP API에 배당 지급 통보
 *   - KDEPAdapter.notifyDividendDistribution() 호출 포인트
 */
interface IDividendDistributor {

    // ─── 구조체 ──────────────────────────────────────────────────────────

    struct Distribution {
        bytes32  partition;       // 대상 파티션
        address  paymentToken;    // 결제 토큰 주소 (address(0) = ETH)
        uint256  totalAmount;     // 총 분배 금액
        uint256  snapshotBlock;   // 잔액 기준 블록
        uint256  claimDeadline;   // 청구 마감 (이후 미청구분 회수)
        uint256  distributedAt;
        bool     finalized;       // 분배 완료 여부
    }

    // ─── 이벤트 ──────────────────────────────────────────────────────────

    event DividendDistributed(
        bytes32 indexed distributionId,
        bytes32 indexed partition,
        address         paymentToken,
        uint256         totalAmount,
        uint256         snapshotBlock
    );

    event DividendClaimed(
        bytes32 indexed distributionId,
        address indexed investor,
        uint256         amount
    );

    event DividendReclaimed(
        bytes32 indexed distributionId,
        uint256         amount
    );

    // ─── 분배 실행 (DISTRIBUTOR_ROLE) ────────────────────────────────────

    /**
     * @notice 배당 분배 등록
     * @param partition     대상 파티션 (파티션별 분배)
     * @param paymentToken  결제 토큰 (KRWStablecoin 주소 또는 address(0))
     * @param totalAmount   총 분배 금액
     * @param claimDuration 청구 가능 기간 (초 단위, 예: 90일 = 90 * 86400)
     * @return distributionId 분배 식별자
     */
    function distributeDividend(
        bytes32 partition,
        address paymentToken,
        uint256 totalAmount,
        uint256 claimDuration
    ) external returns (bytes32 distributionId);

    // ─── 청구 (투자자) ───────────────────────────────────────────────────

    /**
     * @notice 배당 청구 — 스냅샷 기준 보유량 비례 지급
     */
    function claimDividend(bytes32 distributionId) external;

    // ─── 조회 ────────────────────────────────────────────────────────────

    /**
     * @notice 청구 가능 배당액 조회
     */
    function claimableDividend(
        address  investor,
        bytes32  distributionId
    ) external view returns (uint256);

    /**
     * @notice 분배 정보 조회
     */
    function getDistribution(bytes32 distributionId) external view returns (Distribution memory);

    /**
     * @notice 투자자가 이미 청구했는지 여부
     */
    function hasClaimed(address investor, bytes32 distributionId) external view returns (bool);

    // ─── 미청구분 회수 (마감 후) ──────────────────────────────────────────

    /**
     * @notice 청구 마감 후 미청구 배당 회수 — DISTRIBUTOR_ROLE만
     */
    function reclaimUnclaimed(bytes32 distributionId) external;
}
