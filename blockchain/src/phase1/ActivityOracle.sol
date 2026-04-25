// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "../interfaces/IOracle.sol";

/**
 * @title ActivityOracle
 * @notice Phase 1 오라클 — 교보 백엔드 서버가 서명한 활동 데이터를 온체인에 기록.
 *         Phase 2에서는 KRW/USD 환율 오라클로 교체, Phase 3에서는 자산 가치 오라클 추가.
 *         IOracle 인터페이스를 구현하므로 NFTIssuer는 오라클 구현체를 몰라도 된다.
 *
 * 신뢰 모델: 교보 백엔드 서버 키가 ORACLE_ROLE을 보유.
 *            Phase 2+에서 Chainlink 등 탈중앙 오라클로 교체 가능 (인터페이스 동일).
 */
contract ActivityOracle is IOracle, AccessControl {
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    mapping(bytes32 => OracleData) private _latestData;

    /// @notice 오라클 서명 검증에 사용할 공개키
    address public trustedSigner;

    constructor(address signer_) {
        trustedSigner = signer_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, signer_);
    }

    function update(OracleData calldata data) external onlyRole(ORACLE_ROLE) {
        require(verify(data), "ActivityOracle: invalid signature");
        _latestData[data.dataType] = data;
        emit DataUpdated(data.dataType, data.value, data.timestamp);
    }

    function getLatestData(bytes32 dataType) external view override returns (OracleData memory) {
        return _latestData[dataType];
    }

    /**
     * @notice 서명 검증 — 교보 백엔드 서버 키로 서명된 데이터만 허용.
     *         Phase 2+에서 Chainlink 검증 로직으로 교체 시 이 함수만 수정.
     */
    function verify(OracleData calldata data) public view override returns (bool) {
        bytes32 hash = keccak256(abi.encodePacked(
            data.dataType, data.value, data.timestamp
        ));
        bytes32 ethHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32", hash
        ));
        (uint8 v, bytes32 r, bytes32 s) = _splitSignature(data.signature);
        address recovered = ecrecover(ethHash, v, r, s);
        return recovered == trustedSigner;
    }

    function _splitSignature(bytes memory sig)
        internal pure returns (uint8 v, bytes32 r, bytes32 s)
    {
        require(sig.length == 65, "ActivityOracle: invalid signature length");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }
}
