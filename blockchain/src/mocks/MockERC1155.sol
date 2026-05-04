// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * MockERC1155 — 강의 실습 전용 경량 ERC-1155
 *
 * 목적:
 *   월렛원 전용 RPC / 프로덕션 컨트랙트 없이 Sepolia에서
 *   EVMAdapter의 mintNFT / burnNFT / getBalance / queryEvents를 실습한다.
 *
 * 프로덕션과의 차이:
 *   - 접근 제어 없음 (누구나 mint / burn 가능) — 테스트넷 전용
 *   - OpenZeppelin 상속 없음 (의존성 최소화)
 *   - ABI는 EVMAdapter.ts ERC1155_ABI와 정확히 일치
 *
 * EVMAdapter ERC1155_ABI 대응:
 *   mint(address to, uint256 id, uint256 amount)
 *   mintBatch(address[] to, uint256[] ids, uint256[] amounts)
 *   burn(address from, uint256 id, uint256 amount)
 *   balanceOf(address account, uint256 id) view returns (uint256)
 */
contract MockERC1155 {

    // ── 잔액 저장소 ──────────────────────────────────────────────────────
    // account → tokenId → amount
    mapping(address => mapping(uint256 => uint256)) private _balances;

    // ── 이벤트 ───────────────────────────────────────────────────────────
    // EVMAdapter.queryEvents / subscribeEvents 실습용
    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );

    event TransferBatch(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256[] ids,
        uint256[] values
    );

    // ── mint ─────────────────────────────────────────────────────────────

    function mint(address to, uint256 id, uint256 amount) external {
        require(to != address(0), "MockERC1155: mint to zero address");
        _balances[to][id] += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
    }

    // ── mintBatch ────────────────────────────────────────────────────────
    // EVMAdapter ABI: mintBatch(address[] to, uint256[] ids, uint256[] amounts)
    // 각 인덱스별로 to[i]에게 ids[i] 토큰을 amounts[i]만큼 발행
    function mintBatch(
        address[] calldata to,
        uint256[] calldata ids,
        uint256[] calldata amounts
    ) external {
        require(
            to.length == ids.length && ids.length == amounts.length,
            "MockERC1155: array length mismatch"
        );
        for (uint256 i = 0; i < to.length; i++) {
            require(to[i] != address(0), "MockERC1155: mint to zero address");
            _balances[to[i]][ids[i]] += amounts[i];
        }
        // 배치 이벤트는 단일 주소 기준 ERC-1155와 다름 — 강의 포인트
        // 여기서는 첫 번째 수신자 기준으로 emit (실습 단순화)
        if (to.length > 0) {
            emit TransferBatch(msg.sender, address(0), to[0], ids, amounts);
        }
    }

    // ── burn ─────────────────────────────────────────────────────────────

    function burn(address from, uint256 id, uint256 amount) external {
        require(from != address(0), "MockERC1155: burn from zero address");
        require(_balances[from][id] >= amount, "MockERC1155: insufficient balance");
        _balances[from][id] -= amount;
        emit TransferSingle(msg.sender, from, address(0), id, amount);
    }

    // ── balanceOf ────────────────────────────────────────────────────────

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balances[account][id];
    }
}
