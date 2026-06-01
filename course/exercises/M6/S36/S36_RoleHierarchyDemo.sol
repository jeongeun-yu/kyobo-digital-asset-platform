// SPDX-License-Identifier: MIT
// ============================================================
// S36 실습 B — RoleHierarchyDemo.sol
//
// 강의 노트: course/lecture-notes/M6_S36_openzeppelin_access_control.md
//
// 실행 환경: Remix IDE
//
// 확인 포인트:
//   [1] Account1 → grantRole(ADMIN_ROLE, Account2)
//   [2] Account2(ADMIN_ROLE) → grantRole(MINTER_ROLE, Account3) → 성공
//   [3] getMinterCount() → 1
//   [4] getMinter(0)     → Account3 주소
//   [5] Account3(MINTER 보유, ADMIN 없음) → grantRole(MINTER_ROLE, Account4) → 실패
//       이유: MINTER_ROLE의 adminRole = ADMIN_ROLE → Account3는 ADMIN_ROLE 없음
//   [6] Account1(DEFAULT_ADMIN) → grantRole(MINTER_ROLE, Account4) → 실패
//       이유: MINTER_ROLE의 adminRole이 ADMIN_ROLE로 바뀌었으므로
//             DEFAULT_ADMIN은 더 이상 MINTER 관리 불가
//
// 핵심 개념:
//   · AccessControlEnumerable: getRoleMemberCount / getRoleMember 추가
//   · _setRoleAdmin(MINTER_ROLE, ADMIN_ROLE): MINTER 관리 권한을 ADMIN에게 위임
//     이 줄 없으면 DEFAULT_ADMIN만 MINTER 부여·회수 가능
//   · EnumerableSet: 내부적으로 배열 + 매핑 조합 → O(1) 추가·삭제·열거
// ============================================================
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";

contract RoleHierarchyDemo is AccessControlEnumerable {
    bytes32 public constant ADMIN_ROLE  = keccak256("ADMIN_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE,         msg.sender);

        // 핵심: MINTER_ROLE의 admin을 ADMIN_ROLE로 설정
        // 이 줄을 빠뜨리면 DEFAULT_ADMIN만 MINTER_ROLE 관리 가능
        _setRoleAdmin(MINTER_ROLE, ADMIN_ROLE);
    }

    // AccessControlEnumerable이 제공하는 추가 함수 래퍼
    function getMinterCount() public view returns (uint256) {
        return getRoleMemberCount(MINTER_ROLE);
    }

    function getMinter(uint256 index) public view returns (address) {
        return getRoleMember(MINTER_ROLE, index);
    }
}

// ============================================================
// 심화 TODO:
//   · _setRoleAdmin 줄을 주석 처리 후 재배포
//     → Account2(ADMIN_ROLE)가 grantRole(MINTER_ROLE, ...) 실패 확인
//     → DEFAULT_ADMIN(Account1)은 성공 확인 (차이 비교)
//   · PAUSER_ROLE 추가, adminRole도 ADMIN_ROLE로 설정
//   · getMinters() 헬퍼: 전체 minter 배열 반환
// ============================================================
