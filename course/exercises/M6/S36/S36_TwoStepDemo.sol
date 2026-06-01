// SPDX-License-Identifier: MIT
// ============================================================
// S36 실습 C — TwoStepDemo.sol
//
// 강의 노트: course/lecture-notes/M6_S36_openzeppelin_access_control.md
//
// 실행 환경: Remix IDE
//
// 확인 포인트:
//   [1] Account1 → transferOwnership(Account2)
//       → pendingOwner() = Account2, owner() = 여전히 Account1
//   [2] owner() 확인 → Account1 (이전 미완료)
//   [3] Account1 → sensitiveAction() → 성공 (아직 Account1이 owner)
//   [4] Account3 → acceptOwnership() → 실패 (pendingOwner 아님)
//       → OwnableUnauthorizedAccount(Account3) custom error
//   [5] Account2 → acceptOwnership() → 성공 → owner() = Account2
//   [6] Account1 → sensitiveAction() → 실패
//       → OwnableUnauthorizedAccount(Account1) custom error
//
// 핵심 개념:
//   · Ownable.transferOwnership(): 즉시 이전 → 오타 = 영구 lock 위험
//   · Ownable2Step.transferOwnership(): pendingOwner 설정만 (이전 미완료)
//   · acceptOwnership(): pendingOwner 본인이 직접 호출해야 완료
//   · 취소 방법: 현재 owner가 transferOwnership(currentOwner) 재호출
//     → _pendingOwner가 자기 자신으로 덮어씌워짐
// ============================================================
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

contract TwoStepDemo is Ownable2Step {
    // Ownable2Step도 내부적으로 Ownable을 상속
    // Ownable 생성자에 initialOwner 전달 필수 (OZ v5)
    constructor() Ownable(msg.sender) {}

    // onlyOwner: 현재 owner(이전 완료된 주소)만 호출 가능
    function sensitiveAction() public onlyOwner {
        // owner 전용 중요 작업
    }
}

// ============================================================
// 심화 TODO:
//   · Ownable(단순 버전)과 비교:
//       import "@openzeppelin/contracts/access/Ownable.sol";
//       contract SimpleOwnable is Ownable {
//           constructor() Ownable(msg.sender) {}
//           function sensitiveAction() public onlyOwner {}
//       }
//     → transferOwnership(Account2) 호출 즉시 owner() = Account2 확인
//     → Ownable2Step과의 차이 체감
//   · 소유권 이전 취소 시나리오:
//       transferOwnership(Account2) → pendingOwner() = Account2
//       transferOwnership(Account1) → pendingOwner() = Account1 (취소 효과)
//       Account2 → acceptOwnership() → 실패 (더 이상 pendingOwner 아님)
// ============================================================
