// SPDX-License-Identifier: MIT
// ============================================================
// S34 실습 B — StoragePacking.sol  (심화)
//
// 강의 노트: course/lecture-notes/M6_S34_solidity_types_functions.md
//
// 실행 환경: Remix IDE
//   1. Unpacked, Packed 각각 배포
//   2. Remix terminal에서 transaction cost(배포 gas) 비교
//
// 확인 포인트:
//   · Unpacked 배포 gas vs Packed 배포 gas → Packed가 더 저렴
//   · Solidity Compiler → Compilation Details → Storage Layout 탭 확인
//     Unpacked: slot 0(uint128 a), slot 1(uint256 b), slot 2(uint128 c), slot 3(uint256 d) → 4 슬롯
//     Packed:   slot 0(uint128 a + uint128 c 패킹),   slot 1(uint256 b), slot 2(uint256 d) → 3 슬롯
//
// 핵심 개념:
//   · storage 슬롯 = 32바이트 단위
//   · 작은 타입을 연속 선언하면 같은 슬롯에 패킹 → SLOAD/SSTORE 횟수 감소
//   · uint256은 항상 슬롯 전체를 혼자 차지 → 패킹 불가
// ============================================================
pragma solidity ^0.8.20;

// 비효율 — 슬롯 4개 사용
// uint128(16바이트) + uint256(32바이트) 사이에 패킹 불가 → 각자 별도 슬롯
contract Unpacked {
    uint128 public a;   // slot 0 (나머지 16바이트 낭비)
    uint256 public b;   // slot 1 (256비트 전체)
    uint128 public c;   // slot 2 (나머지 16바이트 낭비)
    uint256 public d;   // slot 3 (256비트 전체)
}

// 효율 — 슬롯 3개 사용
// uint128 두 개를 연속 선언 → 같은 슬롯 0에 패킹(16+16=32바이트)
contract Packed {
    uint128 public a;   // slot 0 앞 16바이트
    uint128 public c;   // slot 0 뒤 16바이트 (a와 패킹)
    uint256 public b;   // slot 1 (256비트 전체)
    uint256 public d;   // slot 2 (256비트 전체)
}

// ============================================================
// 심화 TODO:
//   · 아래 구조체도 슬롯 레이아웃을 직접 계산해보기
//       struct UserInfo {
//           address owner;    // 20바이트
//           uint96  balance;  // 12바이트 → owner와 같은 슬롯에 패킹 가능
//           uint256 timestamp;
//       }
//   · getStorageAt(address, slot) RPC로 raw slot 값 직접 읽어보기
// ============================================================
