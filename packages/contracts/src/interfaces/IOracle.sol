// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IOracle
 * @notice 오프체인 데이터를 온체인으로 중계하는 오라클 인터페이스.
 *         Phase 1: 걷기 달성 여부 → NFT 발행 트리거
 *         Phase 2: KRW/USD 환율 → 스테이블코인 가격 유지
 *         Phase 3: 자산 가치 → STO 담보 검증
 *         오라클 제공자(Chainlink, 자체 서버)가 바뀌어도 컨트랙트 변경 없음.
 */
interface IOracle {
    struct OracleData {
        bytes32 dataType;   // "ACTIVITY" | "FX_RATE" | "ASSET_VALUE"
        uint256 value;
        uint256 timestamp;
        bytes   signature;  // 오라클 서명 — 위변조 방지
    }

    function getLatestData(bytes32 dataType) external view returns (OracleData memory);
    function verify(OracleData calldata data) external view returns (bool);

    event DataUpdated(bytes32 indexed dataType, uint256 value, uint256 timestamp);
}
