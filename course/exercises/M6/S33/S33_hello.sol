// SPDX-License-Identifier: MIT
// ============================================================
// S33 실습 1 — 첫 번째 컨트랙트: Hello.sol
//
// 강의 노트: course/lecture-notes/M6_S33_solidity_overview.md
//
// 실행 환경: Remix IDE (https://remix.ethereum.org)
//   1. 파일 탐색기 → contracts/ → 새 파일 Hello.sol
//   2. 이 코드를 붙여넣기
//   3. Solidity Compiler 탭 → 0.8.20 선택 → Compile
//   4. Deploy & Run → Environment: Remix VM (Cancun) → Deploy
//
// 검증 목표:
//   [1] greet()     → 하단 로그 [call],  gas 없음
//   [2] sayHello()  → 하단 로그 [vm],   gas ~27,000
//   [3] setGreeting("안녕, 교보!") → greet() 재호출 → "안녕, 교보!" 반환
//   [4] Solidity Compiler → Compilation Details → ABI JSON 구조 확인
//
// 핵심 개념:
//   · string public greeting  → Storage (영구, SSTORE 비쌈)
//   · constructor()           → 배포 시 1회 실행
//   · view 함수               → 트랜잭션 불필요, gas 0, 즉시 반환
//   · string memory           → 참조 타입은 데이터 위치 명시 필수
//   · emit Event(...)         → Storage 아닌 로그 영역 기록 (저렴)
//   · msg.sender              → 현재 호출자 주소 (전역변수)
// ============================================================
pragma solidity ^0.8.20;

contract Hello {
    // 상태변수: 블록체인 Storage에 영구 저장
    // public → 자동으로 greeting() getter 함수 생성
    string public greeting = "Hello";

    // constructor: 배포 시 딱 1번 실행. 이후 절대 호출 불가
    constructor() {
        greeting = "Hello, Kyobo!";
    }

    // view: Storage 읽기만. 상태 변경 없음
    // → 트랜잭션 불필요, gas 없음, 즉시 반환
    // string memory: 참조 타입은 반환 시 위치 명시 필수
    function greet() public view returns (string memory) {
        return greeting;
    }

    // event: 트랜잭션 로그에 기록 (Storage보다 3~10배 저렴)
    // indexed: 이더스캔에서 who 주소로 필터 검색 가능
    event Greeted(address indexed who, string message);

    // event emit → 트랜잭션 로그 기록 → 트랜잭션 필요
    // msg.sender: 이 함수를 호출한 EOA 또는 컨트랙트 주소
    function sayHello() public {
        emit Greeted(msg.sender, greeting);
    }

    // 상태 변경 함수 → 트랜잭션 필요 → gas 소비 → Storage 쓰기(SSTORE)
    function setGreeting(string memory newGreeting) public {
        greeting = newGreeting;
    }
}

// ============================================================
// 심화 TODO (선택):
//   · setGreeting()를 누구나 호출할 수 있다. onlyOwner를 추가해보세요.
//   · address public owner 상태변수 선언
//   · constructor()에서 owner = msg.sender
//   · modifier onlyOwner { require(msg.sender == owner, "Not owner"); _; }
//   · function setGreeting(...) public onlyOwner { ... }
// ============================================================
