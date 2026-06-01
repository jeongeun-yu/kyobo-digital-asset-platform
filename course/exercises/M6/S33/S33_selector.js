/**
 * S33 실습 3 — 함수 선택자 직접 계산
 *
 * 강의 노트: course/lecture-notes/M6_S33_solidity_overview.md
 *
 * 실행 환경: Remix IDE 하단 터미널(콘솔)에 붙여넣기
 *   - Remix 배포 후 하단 콘솔 탭 클릭
 *   - 아래 코드 블록을 복사해서 한 줄씩 또는 전체 붙여넣기
 *   - web3 객체는 Remix 콘솔에서 자동으로 제공됨
 *
 * 검증 목표:
 *   [1] greet()                            → 0xcfae3217
 *   [2] mint(address,uint256,uint256,bytes) → 0x731133e9
 *   [3] 직접 계산한 선택자 = Remix calldata 첫 4바이트 일치 확인
 *
 * 핵심 개념:
 *   · 함수 선택자 = keccak256(함수 서명 문자열) 앞 4바이트
 *   · 함수 서명 = "함수명(타입1,타입2,...)"  — 공백 없음, uint는 uint256
 *   · calldata 구조: [4바이트 선택자] [파라미터 ABI 인코딩]
 *   · 이더스캔 TX Input Data 탭에서도 동일한 4바이트 확인 가능
 */

// ── [1] Hello.sol의 greet() 선택자 ───────────────────────────────────────
const sig1 = "greet()";
const hash1 = web3.utils.keccak256(sig1);
console.log("greet() 전체 해시:", hash1);
console.log("greet() 선택자   :", hash1.slice(0, 10));
// 예상값: 0xcfae3217

// ── [2] Hello.sol의 setGreeting(string) 선택자 ───────────────────────────
const sig2 = "setGreeting(string)";
const hash2 = web3.utils.keccak256(sig2);
console.log("\nsetGreeting(string) 선택자:", hash2.slice(0, 10));
// 예상값: 0xa4136862

// ── [3] KyoboNFT.mint() 선택자 ───────────────────────────────────────────
const sig3 = "mint(address,uint256,uint256,bytes)";
const hash3 = web3.utils.keccak256(sig3);
console.log("\nmint(address,uint256,uint256,bytes) 선택자:", hash3.slice(0, 10));
// 예상값: 0x731133e9

// ── [4] Remix calldata 확인 방법 ─────────────────────────────────────────
// Remix Deploy 탭에서 setGreeting("안녕") 호출 후
// 하단 로그 → 해당 트랜잭션 클릭 → input 필드 확인
// 첫 4바이트(0xa4136862)가 위에서 계산한 선택자와 일치해야 함

// ── [5] TODO: 아래 함수들의 선택자를 직접 계산해보세요 ───────────────────
// (1) transfer(address,uint256)     — ERC-20 이체
// (2) balanceOf(address,uint256)    — ERC-1155 잔액 조회
// (3) safeTransferFrom(address,address,uint256,uint256,bytes) — ERC-1155 이전
//
// 정답:
//   transfer(address,uint256)                              → 0xa9059cbb
//   balanceOf(address,uint256)                             → 0x00fdd58e
//   safeTransferFrom(address,address,uint256,uint256,bytes) → 0xf242432a

const todo1 = web3.utils.keccak256("transfer(address,uint256)").slice(0, 10);
const todo2 = web3.utils.keccak256("balanceOf(address,uint256)").slice(0, 10);
const todo3 = web3.utils.keccak256("safeTransferFrom(address,address,uint256,uint256,bytes)").slice(0, 10);
console.log("\n[TODO 결과]");
console.log("transfer:         ", todo1, todo1 === "0xa9059cbb" ? "✅" : "❌");
console.log("balanceOf:        ", todo2, todo2 === "0x00fdd58e" ? "✅" : "❌");
console.log("safeTransferFrom: ", todo3, todo3 === "0xf242432a" ? "✅" : "❌");
