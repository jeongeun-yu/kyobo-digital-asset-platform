// SPDX-License-Identifier: MIT
// ============================================================
// S33 실습 2 — Gas 소비 실험: GasTest.sol
//
// 강의 노트: course/lecture-notes/M6_S33_solidity_overview.md
//
// 실행 환경: Remix IDE (https://remix.ethereum.org)
//   1. contracts/ → 새 파일 GasTest.sol
//   2. Compile → Deploy (Remix VM)
//   3. 각 함수 호출 후 하단 로그 [vm] gas used 값 비교
//
// 검증 목표:
//   [1] writeStorage(42)  → gas ~43,000  (SSTORE 20,000 포함)
//   [2] computeOnly(3, 5) → gas ~21,400  (기본 21,000 + ADD 3)
//   [3] writeStorage(42)  두 번째 호출 → gas ~26,000  (기존 슬롯 업데이트 2,900)
//   [4] SSTORE vs ADD 비용 차이 = 6,666배 직접 확인
//
// 핵심 개념:
//   · SSTORE (새 슬롯): 20,000 gas  — Storage 첫 쓰기
//   · SSTORE (업데이트): 2,900 gas  — 기존 슬롯 덮어쓰기
//   · ADD: 3 gas                    — 스택 연산
//   · 기본 트랜잭션: 21,000 gas     — 모든 TX 고정 비용
//   · pure 함수: Storage 접근 없음 → SSTORE 0회
// ============================================================
pragma solidity ^0.8.20;

contract GasTest {
    uint256 public storedValue;

    // [실습 1] Storage 쓰기 — SSTORE 발생
    //   첫 호출:  20,000 gas (새 슬롯)
    //   재호출:    2,900 gas (기존 슬롯 업데이트)
    function writeStorage(uint256 value) public {
        storedValue = value;
    }

    // [실습 2] 순수 계산 — SSTORE 없음
    //   스택(Stack)과 메모리만 사용 → gas 최소
    //   pure: Storage 읽기도 금지 (컴파일러가 강제)
    function computeOnly(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }

    // ============================================================
    // TODO [심화]: inefficientRead()를 완성하고 비효율적인 패턴과
    //   효율적인 패턴의 gas 차이를 비교해보세요.
    //
    // [비효율]: storedValue를 두 번 읽음
    //   function inefficientRead() public view returns (uint256) {
    //     if (storedValue > 0) {     // SLOAD #1: 2,100 gas (첫 접근)
    //         return storedValue;    // SLOAD #2: 100 gas  (재접근)
    //     }
    //     return 0;
    //   }
    //
    // [효율]: local caching — SLOAD 1번
    //   function efficientRead() public view returns (uint256) {
    //     uint256 val = storedValue; // SLOAD #1: 2,100 gas (1번만)
    //     if (val > 0) {
    //         return val;            // 스택 읽기: 3 gas
    //     }
    //     return 0;
    //   }
    //
    // 두 함수를 모두 추가하고 Remix에서 gas used를 비교하세요.
    // 예상 차이: inefficient ~4,200 gas vs efficient ~2,100 gas (view이므로 로컬 실행)
    // ============================================================
}
