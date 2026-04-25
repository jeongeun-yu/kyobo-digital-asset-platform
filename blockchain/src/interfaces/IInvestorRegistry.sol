// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IInvestorRegistry
 * @notice Phase 3 STO — 투자자 등록 및 전송 적격성 온체인 관리 인터페이스.
 *
 * 역할:
 *   - 적격 투자자 등록·취소 (REGISTRAR_ROLE)
 *   - 파티션별 보유 한도 관리
 *   - 락업 정책 적용 (STO 발행 후 의무 보유 기간)
 *   - InvestorCompliance가 이 인터페이스를 통해 전송 가능 여부를 판단
 *
 * 한국 규제 맥락:
 *   - 금융위 토큰증권 가이드라인: 전문투자자 + 일반투자자 구분
 *   - 일반투자자: 연간 누적 투자 한도 있음 (예: 1인당 1천만원)
 *   - 전문투자자: 한도 없음 (별도 등록 필요)
 *   - 예탁결제원 연동: 실제 구현 시 KDEP API와 동기화
 *
 * 오프체인 ↔ 온체인 역할 분리:
 *   - 오프체인(InvestorRegistryService.ts): KYC 검증, 실제 투자자 정보 관리
 *   - 온체인(이 인터페이스 구현체): 주소 단위 적격성·한도만 기록
 *   → 개인정보는 온체인에 올리지 않는다
 */
interface IInvestorRegistry {

    // ─── 투자자 등급 ─────────────────────────────────────────────────────

    enum InvestorType {
        NONE,           // 미등록
        RETAIL,         // 일반투자자 — 한도 있음
        PROFESSIONAL    // 전문투자자 — 한도 없음 (금융위 기준)
    }

    // ─── 구조체 ──────────────────────────────────────────────────────────

    struct InvestorInfo {
        InvestorType investorType;
        uint256      registeredAt;
        uint256      expiresAt;      // 0이면 만료 없음
    }

    struct PartitionLimit {
        uint256 maxHolding;      // 최대 보유 한도 (단위: 토큰 최소 단위)
        uint256 currentHolding;  // 현재 보유량 (전송 시 업데이트)
        uint256 lockedUntil;     // 락업 해제 타임스탬프 (0이면 없음)
    }

    // ─── 이벤트 ──────────────────────────────────────────────────────────

    event InvestorRegistered(address indexed investor, InvestorType investorType);
    event InvestorRevoked(address indexed investor, bytes32 reason);
    event HoldingUpdated(address indexed investor, bytes32 indexed partition, uint256 newHolding);
    event LockupSet(address indexed investor, bytes32 indexed partition, uint256 lockedUntil);

    // ─── 조회 ────────────────────────────────────────────────────────────

    /**
     * @notice 투자자 등록 여부 및 유효성 확인
     */
    function isRegistered(address investor) external view returns (bool);

    /**
     * @notice 투자자 정보 조회
     */
    function getInvestorInfo(address investor) external view returns (InvestorInfo memory);

    /**
     * @notice 파티션별 보유 한도·현재량·락업 조회
     */
    function getPartitionLimit(
        address investor,
        bytes32 partition
    ) external view returns (PartitionLimit memory);

    /**
     * @notice 전송 수용 가능 여부 확인
     * @return allowed  허용 여부
     * @return reason   거부 사유 코드 (0x00 = 허용, 0x54 = 미등록, 0x55 = 한도초과, 0x56 = 락업)
     */
    function canAcceptTransfer(
        address investor,
        bytes32 partition,
        uint256 amount
    ) external view returns (bool allowed, bytes32 reason);

    // ─── 등록 / 취소 (REGISTRAR_ROLE) ───────────────────────────────────

    /**
     * @notice 투자자 등록
     * @param investor      투자자 지갑 주소
     * @param investorType  RETAIL / PROFESSIONAL
     * @param maxHolding    파티션별 최대 보유 한도 (일반투자자용, PROFESSIONAL은 무시)
     * @param partitions    적용 파티션 목록
     * @param expiresAt     등록 만료 시각 (0이면 무기한)
     */
    function register(
        address          investor,
        InvestorType     investorType,
        uint256          maxHolding,
        bytes32[] calldata partitions,
        uint256          expiresAt
    ) external;

    /**
     * @notice 투자자 등록 취소 (규제 조치·AML 등)
     */
    function revoke(address investor, bytes32 reason) external;

    // ─── 보유량 업데이트 (TOKEN_CONTRACT만 호출) ─────────────────────────

    /**
     * @notice 전송 후 보유량 업데이트 — SecurityToken이 내부적으로 호출
     *         일반투자자 한도 추적용
     */
    function updateHolding(
        address investor,
        bytes32 partition,
        uint256 amount,
        bool    isIncrease
    ) external;

    // ─── 락업 설정 (ISSUER_ROLE) ─────────────────────────────────────────

    /**
     * @notice STO 발행 시 의무 보유 락업 설정
     *         예: 발행 후 1년간 전송 불가
     */
    function setLockup(
        address investor,
        bytes32 partition,
        uint256 lockedUntil
    ) external;
}
