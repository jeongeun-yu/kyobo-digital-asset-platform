// SPDX-License-Identifier: MIT
// ============================================================
// S35 실습 1 — SimpleToken.sol  (상속 + 인터페이스 구현)
//
// 강의 노트: course/lecture-notes/M6_S35_inheritance_interface_library.md
//
// 실행 환경: Remix IDE
//   1. S35_ISimpleToken.sol 먼저 생성
//   2. 이 파일 생성 → Compile
//   3. Deploy & Run → SimpleToken 선택 → Deploy
//
// 확인 포인트:
//   [1] mint(Account2, 500) → 정상 (Account1이 owner)
//   [2] balanceOf(Account2) → 500
//   [3] Account2 → transfer(Account3, 200) → Transfer 이벤트, Account2 잔액 300
//   [4] 배포 주소 복사 → "At Address" 입력창에 붙여넣기
//       컨트랙트 타입을 ISimpleToken으로 변경 → Deploy
//       → balanceOf / transfer만 표시됨 (mint 없음) ← 인터페이스 ABI 제한 확인
//
// 핵심 개념:
//   · is BaseOwnable, ISimpleToken  → 다중 상속 (왼→오른쪽 MRO)
//   · override                       → 인터페이스 함수 구현 시 필수
//   · At Address                     → 이미 배포된 컨트랙트를 다른 ABI로 바라보기
// ============================================================
pragma solidity ^0.8.20;

import "./S35_ISimpleToken.sol";

contract BaseOwnable {
    address public owner;

    constructor() { owner = msg.sender; }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }
}

contract SimpleToken is BaseOwnable, ISimpleToken {
    mapping(address => uint256) private _bal;

    function mint(address to, uint256 amt) public onlyOwner {
        _bal[to] += amt;
    }

    function balanceOf(address who) external view override returns (uint256) {
        return _bal[who];
    }

    function transfer(address to, uint256 amt) external override returns (bool) {
        require(_bal[msg.sender] >= amt, "Insufficient");
        _bal[msg.sender] -= amt;
        _bal[to] += amt;
        emit Transfer(msg.sender, to, amt);
        return true;
    }
}

// ============================================================
// 심화 TODO:
//   · BaseOwnable에 transferOwnership(address newOwner) 추가
//   · ISimpleToken에 approve / transferFrom 추가 → SimpleToken에서 구현
//   · abstract contract로 BaseToken을 만들고 mint를 abstract로 선언
// ============================================================
