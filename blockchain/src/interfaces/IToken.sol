// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IToken
 * @notice 모든 교보 디지털 자산 토큰의 공통 인터페이스.
 *         Phase 1 NFT, Phase 2 KRW 스테이블코인, Phase 3 STO 모두 이 인터페이스를 구현한다.
 *         체인·토큰 표준이 바뀌어도 상위 레이어(발행 서비스, VASP 어댑터)는 이 인터페이스만 바라본다.
 */
interface IToken {
    /// @notice 토큰 종류 식별자 — 상위 레이어에서 분기 처리에 사용
    enum TokenType { NFT, STABLECOIN, SECURITY_TOKEN }

    function tokenType() external view returns (TokenType);
    function issuer() external view returns (address);
    function pause() external;
    function unpause() external;

    event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason);
    event Revoked(address indexed from, uint256 indexed tokenId, bytes32 reason);
}
