// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IToken.sol";
import "./IInvestorRegistry.sol";

/**
 * @title ISecurityToken
 * @notice ERC-1400 기반 증권형 토큰 인터페이스 — Phase 3 STO 핵심 표준.
 *
 * ERC-1400 핵심 개념:
 *   - Partition(파티션): 동일 컨트랙트 내 여러 토큰 클래스 (보통주/우선주/채권 등)
 *   - Controller: 규제 목적의 강제 이전 권한 (금융당국 요구 시 사용)
 *   - Document: 증권 발행 근거 문서 (투자설명서, 약관 등) 온체인 연결
 *   - TransferRestriction: 투자자 등록 + 보유 한도 + 락업 검증
 *
 * 교보생명 파티션 설계:
 *   - INSURANCE_CLASS_A: 보험상품 기반 STO 보통 등급
 *   - INSURANCE_CLASS_B: 보험상품 기반 STO 우선 등급
 *   - (추후) ANNUITY_BOND: 연금 채권형 상품
 *
 * Phase 1 → Phase 3 전환 경로:
 *   1. InvestorCompliance 배포 (IInvestorRegistry 연동)
 *   2. BaseToken.updateCompliance(InvestorCompliance 주소)
 *   3. 투자자 등록 후 STO 발행 시작
 *   → 기존 Phase 1 컨트랙트 재배포 불필요
 */
interface ISecurityToken is IToken {

    // ─── 파티션 상수 (교보 STO 클래스) ───────────────────────────────────
    // 구현체에서 bytes32 상수로 정의:
    //   bytes32 constant PARTITION_CLASS_A = keccak256("INSURANCE_CLASS_A");
    //   bytes32 constant PARTITION_CLASS_B = keccak256("INSURANCE_CLASS_B");

    // ─── ERC-1400 Transfer Status Codes ──────────────────────────────────
    // 0x50: 전송 성공
    // 0x54: 투자자 미등록
    // 0x55: 보유 한도 초과
    // 0x56: 락업 기간 중
    // 0x57: 컨트롤러에 의한 강제 차단

    // ─── 구조체 ──────────────────────────────────────────────────────────

    struct Document {
        string  uri;          // 투자설명서, 약관 등 문서 URI
        bytes32 documentHash; // 문서 내용 해시 (위변조 방지)
        uint256 updatedAt;
    }

    struct PartitionBalance {
        bytes32 partition;
        uint256 balance;
        uint256 lockedUntil; // 락업 해제 타임스탬프 (0이면 없음)
    }

    // ─── 이벤트 ──────────────────────────────────────────────────────────

    event TransferByPartition(
        bytes32 indexed partition,
        address indexed operator,
        address indexed from,
        address          to,
        uint256          value,
        bytes            data,
        bytes            operatorData
    );

    event IssuedByPartition(
        bytes32 indexed partition,
        address indexed to,
        uint256          value,
        bytes            data
    );

    event RedeemedByPartition(
        bytes32 indexed partition,
        address indexed from,
        uint256          value,
        bytes            data
    );

    event ControllerTransfer(
        address indexed controller,
        address indexed from,
        address indexed to,
        uint256          value,
        bytes            data,
        bytes            operatorData
    );

    event DocumentUpdated(bytes32 indexed name, string uri, bytes32 documentHash);

    // ─── 잔액 조회 ────────────────────────────────────────────────────────

    /**
     * @notice 특정 파티션 잔액 조회
     */
    function balanceOfByPartition(
        bytes32 partition,
        address holder
    ) external view returns (uint256);

    /**
     * @notice 투자자가 보유한 모든 파티션 목록
     */
    function partitionsOf(address holder) external view returns (bytes32[] memory);

    /**
     * @notice 전체 파티션 목록
     */
    function totalPartitions() external view returns (bytes32[] memory);

    // ─── 전송 가능 여부 사전 확인 ─────────────────────────────────────────

    /**
     * @notice 전송 가능 여부 확인 — 규제 훅 포함
     * @return statusCode ERC-1400 상태 코드 (0x50 = 성공)
     * @return reasonCode 거부 사유 코드
     * @return partition_ 실제 전송될 파티션
     */
    function canTransferByPartition(
        address from,
        address to,
        bytes32 partition,
        uint256 value,
        bytes   calldata data
    ) external view returns (bytes1 statusCode, bytes32 reasonCode, bytes32 partition_);

    // ─── 전송 ──────────────────────────────────────────────────────────

    /**
     * @notice 파티션 지정 전송 — 투자자 등록·보유 한도·락업 검증 통과 후 실행
     */
    function transferByPartition(
        bytes32        partition,
        address        to,
        uint256        value,
        bytes calldata data
    ) external returns (bytes32);

    /**
     * @notice 오퍼레이터 파티션 전송 (투자자가 위임한 제3자)
     */
    function operatorTransferByPartition(
        bytes32        partition,
        address        from,
        address        to,
        uint256        value,
        bytes calldata data,
        bytes calldata operatorData
    ) external returns (bytes32);

    // ─── 발행 / 소각 ──────────────────────────────────────────────────────

    /**
     * @notice 파티션 지정 발행 — ISSUER_ROLE만 호출 가능
     *         ICompliance.canTransfer 검증 → 투자자 등록 확인 포함
     */
    function issueByPartition(
        bytes32        partition,
        address        holder,
        uint256        value,
        bytes calldata data
    ) external;

    /**
     * @notice 파티션 지정 소각 — 만기 상환·회수 시
     */
    function redeemByPartition(
        bytes32        partition,
        uint256        value,
        bytes calldata data
    ) external;

    // ─── 컨트롤러 (규제 강제 이전) ────────────────────────────────────────

    /**
     * @notice 규제 당국 요구 시 강제 이전 — CONTROLLER_ROLE만 호출 가능
     *         법원 명령, 동결 계좌 처리, AML 조치 등에 사용
     */
    function controllerTransfer(
        address        from,
        address        to,
        uint256        value,
        bytes calldata data,
        bytes calldata operatorData
    ) external;

    /**
     * @notice 규제 목적 강제 소각
     */
    function controllerRedeem(
        address        holder,
        uint256        value,
        bytes calldata data,
        bytes calldata operatorData
    ) external;

    // ─── 오퍼레이터 ───────────────────────────────────────────────────────

    function authorizeOperator(address operator) external;
    function revokeOperator(address operator) external;
    function authorizeOperatorByPartition(bytes32 partition, address operator) external;
    function revokeOperatorByPartition(bytes32 partition, address operator) external;

    function isOperator(address operator, address holder) external view returns (bool);
    function isOperatorForPartition(bytes32 partition, address operator, address holder) external view returns (bool);

    // ─── 문서 관리 ────────────────────────────────────────────────────────

    /**
     * @notice 투자설명서·약관 등 문서 온체인 연결
     *         예탁결제원 연동 포인트: 문서 해시 기록 후 KDEP에 통보
     */
    function setDocument(bytes32 name, string calldata uri, bytes32 documentHash) external;
    function getDocument(bytes32 name) external view returns (Document memory);
}
