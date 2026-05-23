// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * MockVASP — 테스트·강의용 가상 VASP 스마트 컨트랙트
 *
 * 목적:
 *   외부 VASP(월렛원) 없이 로컬 Anvil 노드에서 전체 issuer-service 파이프라인 검증.
 *   ExternalVASPAdapter 대신 AnvilVASPAdapter + MockVASP 조합으로 교체 가능.
 *
 * 실서비스 NFTIssuer + KyoboNFT를 하나로 통합:
 *   - issueActivityNFT() : ERC-1155 민팅 + Issued 이벤트 (NFTIssuer 동일 시그니처)
 *   - setMode()          : 시나리오 전환 (NORMAL / REVERT / NO_EMIT)
 *   - Anvil RPC로 PENDING·REORG 시뮬레이션 (컨트랙트 외부에서 제어)
 *
 * 시나리오:
 *   NORMAL   → 정상 민팅 + Issued 이벤트 → ChainEventListener 정상 경로
 *   REVERT   → revert() → TX 실패 → IssuanceStatus FAILED
 *   NO_EMIT  → 민팅 성공, Issued 이벤트 없음 → ChainEventListener 폴백 경로 검증
 *   PENDING  → Anvil evm_setAutomine(false) 로 블록 중단 → TX 체류
 *   REORG    → Anvil evm_snapshot / evm_revert 로 체인 롤백
 */
contract MockVASP is ERC1155, AccessControl, ReentrancyGuard {

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    enum MintMode {
        NORMAL,   // 정상 발행 + Issued 이벤트
        REVERT,   // revert (TX 실패 시뮬레이션)
        NO_EMIT   // 민팅 성공, Issued 이벤트 없음 (웹훅 누락 시뮬레이션)
    }

    MintMode public mode;
    string   public revertReason;

    // NFTIssuer.Issued 와 동일한 시그니처 — ChainEventListener가 구독
    event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason);

    // ── 배포 ──────────────────────────────────────────────────────────────────
    constructor(address operator) ERC1155("") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, operator);
        revertReason = "MockVASP: forced revert";
    }

    // ── 시나리오 제어 ─────────────────────────────────────────────────────────

    function setMode(MintMode _mode) external onlyRole(OPERATOR_ROLE) {
        mode = _mode;
    }

    function setRevertReason(string calldata reason) external onlyRole(OPERATOR_ROLE) {
        revertReason = reason;
    }

    // ── 발행 — NFTIssuer.issueActivityNFT 와 동일 시그니처 ────────────────────
    function issueActivityNFT(
        address  to,
        uint256  tokenId,
        uint256  amount,
        bytes32  reason
    ) external nonReentrant onlyRole(OPERATOR_ROLE) {
        _doMint(to, tokenId, amount, reason);
    }

    // ── mint() 별칭 — VaspTxClientAdapter.submitMint() 호환 ─────────────────
    function mint(
        address  to,
        uint256  tokenId,
        uint256  amount,
        bytes32  reason
    ) external nonReentrant onlyRole(OPERATOR_ROLE) {
        _doMint(to, tokenId, amount, reason);
    }

    // ── 내부 발행 로직 ────────────────────────────────────────────────────────
    function _doMint(
        address  to,
        uint256  tokenId,
        uint256  amount,
        bytes32  reason
    ) private {
        if (mode == MintMode.REVERT) {
            revert(revertReason);
        }

        _mint(to, tokenId, amount, "");

        if (mode == MintMode.NORMAL) {
            emit Issued(to, tokenId, reason);
        }
        // NO_EMIT: _mint 성공, Issued 생략 → ChainEventListener 폴백 경로 동작 검증
    }

    // ── ERC-1155 / AccessControl supportsInterface 충돌 해소 ─────────────────
    function supportsInterface(bytes4 interfaceId)
        public view override(ERC1155, AccessControl) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
