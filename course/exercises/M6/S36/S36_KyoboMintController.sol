// SPDX-License-Identifier: MIT
// ============================================================
// S36 실습 A — KyoboMintController.sol
//
// 강의 노트: course/lecture-notes/M6_S36_openzeppelin_access_control.md
//
// 실행 환경: Remix IDE (https://remix.ethereum.org)
//   · Remix가 @openzeppelin import를 자동으로 GitHub에서 fetch함
//   · OZ v5 기준 (에러 형태: custom error)
//
// 확인 포인트:
//   [1] Account1 → grantRole(MINTER_ROLE, Account2주소)
//   [2] Account2 → mint(Account3, 1, 100) → NFTMinted 이벤트, mintCount = 1
//   [3] Account1 → pause() → paused() = true
//   [4] Account2 → mint(Account3, 1, 50) → EnforcedPause() custom error revert
//   [5] Account1 → unpause() → Account2 mint 다시 성공
//   [6] Account3(역할 없음) → mint(...) → AccessControlUnauthorizedAccount custom error
//
// 핵심 개념:
//   · AccessControl: 역할 기반 접근 제어 (MINTER_ROLE, PAUSER_ROLE)
//   · Pausable: Circuit Breaker 패턴 — whenNotPaused modifier
//   · _grantRole: constructor에서 초기 역할 강제 부여 (권한 검사 없음)
//   · grantRole: 운영 중 역할 부여 (adminRole 검사 있음)
//   · v5 custom error: EnforcedPause(), AccessControlUnauthorizedAccount(account, neededRole)
// ============================================================
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract KyoboMintController is AccessControl, Pausable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public mintCount;

    event NFTMinted(address indexed to, uint256 indexed tokenId, uint256 amount);

    constructor() {
        // _grantRole: constructor에서만 사용. 권한 검사 없이 강제 부여.
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE,        msg.sender);
        _grantRole(PAUSER_ROLE,        msg.sender);
    }

    function mint(address to, uint256 tokenId, uint256 amount)
        public
        onlyRole(MINTER_ROLE)
        whenNotPaused
    {
        mintCount++;
        emit NFTMinted(to, tokenId, amount);
    }

    function pause()   public onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() public onlyRole(PAUSER_ROLE) { _unpause(); }
}

// ============================================================
// 심화 TODO:
//   · AUDITOR_ROLE 추가: 감사 전용 함수 getMintCount() → onlyRole(AUDITOR_ROLE)
//   · revokeRole(MINTER_ROLE, msg.sender) 후 mint() 시도 → 실패 확인
//   · grantRole(DEFAULT_ADMIN_ROLE, Account2) 후
//     revokeRole(DEFAULT_ADMIN_ROLE, Account1) → Account1 권한 회수
//     (반드시 Account2가 먼저 받은 후 Account1을 revoke할 것)
// ============================================================
