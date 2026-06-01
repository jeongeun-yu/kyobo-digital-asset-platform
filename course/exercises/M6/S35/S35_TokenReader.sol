// SPDX-License-Identifier: MIT
// ============================================================
// S35 실습 3 — TokenReader.sol  (interface로 배포된 컨트랙트 연결)
//
// 강의 노트: course/lecture-notes/M6_S35_inheritance_interface_library.md
//
// 실행 환경: Remix IDE
//   전제: S35_SimpleToken.sol(SimpleToken)이 이미 배포된 상태
//
//   1. SimpleToken 배포 주소 복사
//   2. TokenReader 생성자 인자로 위 주소 입력 → Deploy
//   3. readBalance(Account2) 호출
//
// 확인 포인트:
//   · readBalance(Account2) → 이전 실습에서 남은 300 반환 (실습 1에서 200 transfer 후)
//   · TokenReader는 SimpleToken의 코드를 전혀 알지 못함
//     → ISimpleToken ABI(4바이트 selector)만으로 외부 컨트랙트 호출
//   · Remix Logs: [call] STATICCALL → view 함수이므로 트랜잭션 불필요
//
// 핵심 개념:
//   · interface 캐스팅: ISimpleToken(address) → 해당 주소를 인터페이스로 바라봄
//   · STATICCALL: view/pure 외부 호출 → 상태 변경 불가, gas 절약
//   · 실제 OZ, DEX, 지갑이 다른 컨트랙트를 부르는 방식과 동일
// ============================================================
pragma solidity ^0.8.20;

interface ISimpleToken {
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 amt) external returns (bool);
}

contract TokenReader {
    ISimpleToken public token;

    constructor(address tokenAddress) {
        token = ISimpleToken(tokenAddress);
    }

    // STATICCALL로 외부 컨트랙트의 balanceOf 호출 (view)
    function readBalance(address who) public view returns (uint256) {
        return token.balanceOf(who);
    }

    // 실제 전송 — 트랜잭션 필요 (CALL)
    // 주의: TokenReader가 msg.sender → SimpleToken에서 transfer 실행 시
    //        _bal[TokenReader주소]에서 차감됨
    function sendToken(address to, uint256 amt) public returns (bool) {
        return token.transfer(to, amt);
    }
}

// ============================================================
// 심화 TODO:
//   · try/catch로 외부 호출 실패 처리 추가
//       try token.balanceOf(who) returns (uint256 bal) { return bal; }
//       catch { return 0; }
//   · 여러 토큰 주소를 배열로 받아 각 잔액을 한 번에 조회하는 함수 작성
// ============================================================
