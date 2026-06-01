// SPDX-License-Identifier: MIT
// ============================================================
// S34 실습 A — VotingToken.sol
//
// 강의 노트: course/lecture-notes/M6_S34_solidity_types_functions.md
//
// 실행 환경: Remix IDE (https://remix.ethereum.org)
//   1. 파일 탐색기 → contracts/ → 새 파일 VotingToken.sol
//   2. 이 코드를 붙여넣기
//   3. Solidity Compiler 탭 → 0.8.20 선택 → Compile
//   4. Deploy & Run → Environment: Remix VM (Cancun) → Deploy
//
// 확인 포인트:
//   [1] mint(Account2, 100)         → Minted 이벤트, [vm] gas used 확인
//   [2] balanceOf(Account2)         → 100 반환, [call] (gas 없음)
//   [3] Account2로 전환 → vote()    → Voted 이벤트 확인
//   [4] vote() 재시도               → "Already voted" revert
//   [5] Account3(잔액 0) → vote()   → "No tokens" revert
//
// 핵심 개념:
//   · mapping(address => uint256)   → address를 key로 잔액 저장
//   · mapping(address => bool)      → 투표 여부 추적
//   · modifier                      → 함수 전처리: require 검사 재사용
//   · modifier에서 _;               → modifier 본문 실행 후 함수 본문 실행
//   · event + emit                  → 트랜잭션 로그 기록 (storage보다 저렴)
//   · pure vs view                  → calcPower는 인자만 사용(pure), balanceOf는 storage 읽음(view)
// ============================================================
pragma solidity ^0.8.20;

contract VotingToken {
    address public owner;
    uint256 public totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => bool)    private _hasVoted;

    event Minted(address indexed to, uint256 amount);
    event Voted(address indexed voter, uint256 weight);

    modifier onlyOwner()    { require(msg.sender == owner, "Not owner"); _; }
    modifier hasTokens()    { require(_balances[msg.sender] > 0, "No tokens"); _; }
    modifier notVotedYet()  { require(!_hasVoted[msg.sender], "Already voted"); _; }

    constructor() { owner = msg.sender; }

    function mint(address to, uint256 amount) public onlyOwner {
        _balances[to] += amount;
        totalSupply += amount;
        emit Minted(to, amount);
    }

    function vote() public hasTokens notVotedYet {
        _hasVoted[msg.sender] = true;
        emit Voted(msg.sender, _balances[msg.sender]);
    }

    function balanceOf(address who) public view returns (uint256) {
        return _balances[who];
    }

    // pure: storage 읽지 않음, 인자만 사용 → gas 없음
    function calcPower(uint256 bal) public pure returns (uint256) {
        return bal * 10;
    }

    function hasVoted(address who) public view returns (bool) {
        return _hasVoted[who];
    }
}

// ============================================================
// 심화 TODO:
//   · transferOwnership(address newOwner) 함수 추가
//   · mint에 상한선(maxSupply) 추가: require(totalSupply + amount <= maxSupply, ...)
//   · 투표 기간(block.number 기반) 제한 추가
//   · Custom Error로 require 교체:
//       error NotOwner(address caller);
//       error AlreadyVoted(address voter);
//       error InsufficientTokens(address voter, uint256 balance);
// ============================================================
