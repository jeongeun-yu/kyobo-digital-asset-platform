// SPDX-License-Identifier: MIT
// ============================================================
// S37 실습 — KyoboToken.sol  (ERC-20 직접 구현)
//
// 강의 노트: course/lecture-notes/M6_S37_erc20.md
//
// 실행 환경: Remix IDE (https://remix.ethereum.org)
//   배포 시 생성자 인자: name="KyoboToken", symbol="KBT"
//
// 확인 포인트 (5분 시나리오):
//   [1] mint(Account2, 1000)
//       → Transfer(address(0)→Account2, 1000) 이벤트 확인 (from=0 = mint 관례)
//       → totalSupply → 1000,  balanceOf(Account2) → 1000
//
//   [2] Account2 → transfer(Account3, 300)
//       → Transfer(Account2→Account3, 300) 이벤트
//       → balanceOf(Account2) → 700,  balanceOf(Account3) → 300
//
//   [3] Account2 → approve(Account1주소, 500)
//       → Approval 이벤트 확인
//       → allowance(Account2주소, Account1주소) → 500
//
//   [4] Account1 → transferFrom(Account2주소, Account3주소, 200)
//       → allowance(Account2, Account1) → 300  (500-200)
//       → balanceOf(Account2) → 500,  balanceOf(Account3) → 500
//
//   [5] Account2 → burn(100)
//       → Transfer(Account2→address(0), 100) 이벤트  (to=0 = burn 관례)
//       → totalSupply → 900
//
//   [6] Account1 → pause() → Account2 → transfer(...) → EnforcedPause() revert
//
// 핵심 개념:
//   · ERC-20 7개 함수: balanceOf / transfer / approve / transferFrom /
//                      allowance / totalSupply / (name/symbol/decimals)
//   · emit Transfer(address(0), to, amt) → mint 관례 (이더스캔 "Mint" 탭)
//   · emit Transfer(from, address(0), amt) → burn 관례
//   · _transfer 내부 함수: transfer / transferFrom 로직 공유 (중복 제거)
//   · decimals = 18: 1 KBT = 10^18 최소 단위 (ETH wei와 동일 정밀도)
//   · approve 경쟁 조건: 한도 변경 시 approve(0) 먼저 후 approve(N)
// ============================================================
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract KyoboToken is AccessControl, Pausable {
    // ── 역할 ─────────────────────────────────────────────────────────────
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ── 상태변수 ──────────────────────────────────────────────────────────
    string  public name;
    string  public symbol;
    uint8   public decimals;
    uint256 public totalSupply;

    mapping(address => uint256)                     private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    // ── 이벤트 ───────────────────────────────────────────────────────────
    // ERC-20 표준 이벤트: 이름·시그니처 변경 불가
    event Transfer(address indexed from, address indexed to,    uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ── 생성자 ───────────────────────────────────────────────────────────
    constructor(string memory _name, string memory _symbol) {
        name     = _name;
        symbol   = _symbol;
        decimals = 18;   // ETH와 동일 정밀도. 1 KBT = 1_000_000_000_000_000_000

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE,        msg.sender);
        _grantRole(PAUSER_ROLE,        msg.sender);
    }

    // ── 조회 ─────────────────────────────────────────────────────────────
    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) public view returns (uint256) {
        return _allowances[owner][spender];
    }

    // ── 발행 / 소각 ──────────────────────────────────────────────────────
    function mint(address to, uint256 amount) public onlyRole(MINTER_ROLE) whenNotPaused {
        require(to != address(0), "Mint to zero address");
        _balances[to] += amount;
        totalSupply   += amount;
        emit Transfer(address(0), to, amount);  // from=0: mint 관례
    }

    function burn(uint256 amount) public whenNotPaused {
        require(_balances[msg.sender] >= amount, "Insufficient balance");
        _balances[msg.sender] -= amount;
        totalSupply           -= amount;
        emit Transfer(msg.sender, address(0), amount);  // to=0: burn 관례
    }

    // ── 전송 ─────────────────────────────────────────────────────────────
    function transfer(address to, uint256 amount) public whenNotPaused returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        require(spender != address(0), "Approve to zero address");
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        public
        whenNotPaused
        returns (bool)
    {
        uint256 currentAllowance = _allowances[from][msg.sender];
        require(currentAllowance >= amount, "Insufficient allowance");
        _allowances[from][msg.sender] = currentAllowance - amount;
        _transfer(from, to, amount);
        return true;
    }

    // ── 내부 함수 ─────────────────────────────────────────────────────────
    // transfer / transferFrom 공통 로직 분리
    function _transfer(address from, address to, uint256 amount) internal {
        require(from != address(0), "Transfer from zero address");
        require(to   != address(0), "Transfer to zero address");
        require(_balances[from] >= amount, "Insufficient balance");
        _balances[from] -= amount;
        _balances[to]   += amount;
        emit Transfer(from, to, amount);
    }

    // ── 긴급 정지 ─────────────────────────────────────────────────────────
    function pause()   public onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() public onlyRole(PAUSER_ROLE) { _unpause(); }
}

// ============================================================
// 심화 TODO:
//   · OpenZeppelin ERC20 버전으로 교체해보기:
//       import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
//       contract KyoboTokenOZ is ERC20, AccessControl, Pausable { ... }
//     → 직접 구현 대비 얼마나 코드가 줄어드는지 비교
//
//   · approve 경쟁 조건 방어 패턴 직접 구현:
//       function safeApprove(address spender, uint256 amount) public {
//           require(amount == 0 || _allowances[msg.sender][spender] == 0,
//                   "Reset to 0 first");
//           approve(spender, amount);
//       }
//
//   · ERC-2612 Permit (오프체인 서명 approve) 개념 학습
//     → OZ ERC20Permit 참조
// ============================================================
