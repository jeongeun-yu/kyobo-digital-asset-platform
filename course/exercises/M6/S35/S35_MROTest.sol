// SPDX-License-Identifier: MIT
// ============================================================
// S35 실습 2 — MROTest.sol  (다이아몬드 상속 · super 호출 순서)
//
// 강의 노트: course/lecture-notes/M6_S35_inheritance_interface_library.md
//
// 실행 환경: Remix IDE
//   1. D 배포
//   2. D.ping() 호출 → Remix Logs 탭 확인
//
// 확인 포인트:
//   D.ping() 호출 후 Logs 순서:
//   "D.ping - before super"
//   "C.ping - before super"   ← is B, C 에서 C가 먼저 (오른쪽부터)
//   "B.ping - before super"
//   "A.ping"                  ← A는 단 한 번만 실행 (C3 MRO 보장)
//   "B.ping - after super"
//   "C.ping - after super"
//   "D.ping - after super"
//
// 핵심 개념:
//   · MRO(Method Resolution Order): D → C → B → A
//     "is B, C"에서 뒤에 쓴 C가 MRO 우선순위 높음
//   · super.ping() → MRO상 다음 컨트랙트의 ping() 호출
//   · A.ping()은 중복 실행 없음 → C3 선형화가 다이아몬드 중복 호출 방지
// ============================================================
pragma solidity ^0.8.20;

contract A {
    event Log(string msg);

    function ping() public virtual {
        emit Log("A.ping");
    }
}

contract B is A {
    function ping() public virtual override {
        emit Log("B.ping - before super");
        super.ping();   // MRO상 다음: A
        emit Log("B.ping - after super");
    }
}

contract C is A {
    function ping() public virtual override {
        emit Log("C.ping - before super");
        super.ping();   // MRO상 다음: B (D에서 is B, C 이므로)
        emit Log("C.ping - after super");
    }
}

// MRO: D → C → B → A
// "is B, C": 뒤에 선언된 C가 super 체인에서 먼저 호출됨
contract D is B, C {
    function ping() public override(B, C) {
        emit Log("D.ping - before super");
        super.ping();   // C.ping() 호출 → C의 super → B → A
        emit Log("D.ping - after super");
    }
}

// ============================================================
// 심화 TODO:
//   · is C, B (순서 뒤집기) → MRO가 D→B→C→A로 바뀌는지 확인
//   · E is D, A 추가 → MRO 직접 예측 후 확인
// ============================================================
