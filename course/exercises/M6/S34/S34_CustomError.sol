// SPDX-License-Identifier: MIT
// ============================================================
// S34 실습 C — CustomError.sol  (심화)
//
// 강의 노트: course/lecture-notes/M6_S34_solidity_types_functions.md
//
// 실행 환경: Remix IDE
//   1. StringRevert, CustomErrorRevert 각각 배포
//   2. v=0으로 각각 set(0) 호출 → Remix terminal의 execution cost 비교
//
// 확인 포인트:
//   · StringRevert.set(0)      → "Value must be greater than zero" 문자열 에러
//   · CustomErrorRevert.set(0) → ValueMustBePositive() custom error
//   · Remix terminal → execution cost: CustomErrorRevert < StringRevert
//   · 이더스캔 Logs: custom error는 4바이트 selector로 표시됨
//
// 핵심 개념:
//   · require(cond, "string") → 에러 문자열을 ABI 인코딩해 returndata에 포함
//                                → bytecode 크기 증가, gas 더 비쌈
//   · custom error + revert  → 4바이트 selector + 인자만 → 더 저렴 + 인자 포함 가능
//   · v5 OZ: onlyOwner, onlyRole 등 모두 custom error로 전환됨
// ============================================================
pragma solidity ^0.8.20;

// 구버전 패턴: string require
contract StringRevert {
    uint256 public value;

    function set(uint256 v) public {
        require(v > 0, "Value must be greater than zero");
        value = v;
    }
}

// 신버전 패턴: custom error (Solidity 0.8.4+)
error ValueMustBePositive();
error ValueTooLarge(uint256 given, uint256 max);

contract CustomErrorRevert {
    uint256 public constant MAX = 1_000_000;
    uint256 public value;

    function set(uint256 v) public {
        if (v == 0) revert ValueMustBePositive();
        if (v > MAX) revert ValueTooLarge(v, MAX);
        value = v;
    }
}

// ============================================================
// 심화 TODO:
//   · VotingToken.sol의 require를 모두 custom error로 교체해보기
//       error NotOwner(address caller);
//       error AlreadyVoted(address voter);
//   · ethers.js에서 custom error 파싱:
//       try { await contract.set(0); }
//       catch (e) { if (e.errorName === "ValueMustBePositive") ... }
// ============================================================
