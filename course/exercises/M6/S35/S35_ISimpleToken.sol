// SPDX-License-Identifier: MIT
// ============================================================
// S35 실습 1 — ISimpleToken.sol  (인터페이스)
//
// 강의 노트: course/lecture-notes/M6_S35_inheritance_interface_library.md
//
// 실행 환경: Remix IDE
//   · 이 파일은 단독으로 배포하지 않는다 (인터페이스는 배포 불가)
//   · S35_SimpleToken.sol에서 import "./ISimpleToken.sol" 로 사용
//
// 핵심 개념:
//   · interface: 함수 시그니처만 선언, 구현 없음 → 상태변수·constructor 없음
//   · 모든 함수는 암묵적으로 external
//   · 이벤트는 인터페이스에 선언 가능 → ABI에 포함
//   · "이 컨트랙트가 무엇을 할 수 있는지"의 약속 — DEX, 지갑이 이 ABI만 보고 연동
// ============================================================
pragma solidity ^0.8.20;

interface ISimpleToken {
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 amt) external returns (bool);
    event Transfer(address indexed from, address indexed to, uint256 amt);
}
