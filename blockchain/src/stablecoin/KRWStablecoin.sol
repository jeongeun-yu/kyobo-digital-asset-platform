// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// =============================================================================
// Phase 2 STUB — KRW 원화 스테이블코인
// =============================================================================
// 구현 시점: 교보생명 전자금융업 또는 VASP 라이선스 확보 후
//
// 설계 방향 (변경 금지):
//   - BaseToken 상속 유지 → RBAC/pause/compliance 구조 동일
//   - ERC-20 기반, 발행(mint)/소각(burn) 권한 = 인가된 VASP만
//   - 담보: 교보생명 원화 수탁 계좌 ↔ 온체인 발행량 1:1 보장
//   - IOracle을 통해 KRW/USD 환율 참조 (price stability 모니터링)
//   - Travel Rule 준수: 이체 시 송수신자 정보 KYC 레지스트리 연동
//
// Phase 3 STO와의 관계:
//   - STO 매수 결제 수단으로 이 스테이블코인 사용
//   - 동일한 ICompliance 훅 → 투자자 등록 여부 자동 검증
// =============================================================================

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../base/BaseToken.sol";

// =============================================================================
// Phase 2 STUB — KRW 원화 스테이블코인
// =============================================================================
// 구현 시점: 교보생명 전자금융업 또는 VASP 라이선스 확보 후
//
// 핵심 설계:
//   - ERC-20 기반 (fungible — 1 KRW = 1 토큰 최소 단위)
//   - mint: 교보생명 원화 입금 확인 후 → KyoboVASP(또는 ExternalVASP)가 호출
//   - burn: 원화 출금 요청 시 → 잔액 소각 + Core Banking 출금 처리
//   - 담보: 교보생명 원화 수탁 계좌 ↔ 온체인 발행량 1:1 보장 (ReconcileService 검증)
//   - Travel Rule: 이체 시 TravelRuleData를 VASP에 전달 (특금법 준수)
//
// Phase 3 STO와의 관계:
//   - STO 매수 결제 수단으로 이 스테이블코인 사용
//   - SecurityToken.issueByPartition() 호출 전 KRWStablecoin.transferFrom() 먼저
//   - 동일한 ICompliance 훅 → 투자자 등록 여부 자동 검증
//
// ICompliance 연동:
//   - Phase 2에서는 KYC ENHANCED(2) 레벨 이상 계정만 이체 허용
//   - Travel Rule 대상(100만원 이상)은 TravelRuleData 필수
// =============================================================================

contract KRWStablecoin is ERC20, BaseToken {

    // 소수점 자리 없음 — 1 토큰 = 1 원
    uint8 private constant _DECIMALS = 0;

    // VASP 인가를 받은 주체만 mint/burn 가능
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    // Travel Rule 임계값 (원 단위) — 특금법: 100만원 이상 이체 시 정보 제공 의무
    uint256 public constant TRAVEL_RULE_THRESHOLD = 1_000_000;

    event Minted(address indexed to, uint256 amount, bytes32 depositTxRef);
    event Burned(address indexed from, uint256 amount, bytes32 withdrawTxRef);

    constructor(address issuer_, address compliance_)
        ERC20("KyoboKRW", "KKRW")
        BaseToken(issuer_, compliance_)
    {}

    function decimals() public pure override returns (uint8) {
        return _DECIMALS;
    }

    function tokenType() external pure override returns (TokenType) {
        return TokenType.STABLECOIN;
    }

    /**
     * @notice 원화 입금 확인 후 스테이블코인 발행
     * @param to            수령인 (교보생명 사용자 지갑)
     * @param amount        발행량 (원 단위)
     * @param depositTxRef  Core Banking 입금 트랜잭션 참조 (감사 추적)
     *
     * Phase 2:
     *   - depositTxRef 중복 발행 방지 (idempotency)
     *   - ReconcileService와 연동해 실계좌 잔액 검증
     */
    function mint(
        address to,
        uint256 amount,
        bytes32 depositTxRef
    ) external onlyRole(MINTER_ROLE) whenNotPaused {
        _checkCompliance(address(0), to, amount);
        _mint(to, amount);
        emit Minted(to, amount, depositTxRef);
    }

    /**
     * @notice 원화 출금 시 스테이블코인 소각
     * @param from          소각 대상 (교보생명 사용자 지갑)
     * @param amount        소각량 (원 단위)
     * @param withdrawTxRef Core Banking 출금 트랜잭션 참조
     *
     * Phase 2:
     *   - Core Banking 출금 처리 완료 후 소각 (순서 보장 필요)
     *   - 출금 실패 시 rollback 로직
     */
    function burn(
        address from,
        uint256 amount,
        bytes32 withdrawTxRef
    ) external onlyRole(BURNER_ROLE) whenNotPaused {
        _burn(from, amount);
        emit Burned(from, amount, withdrawTxRef);
    }

    /**
     * @notice 전송 전 컴플라이언스 검증 — Travel Rule 포함
     *         Phase 2: KYC ENHANCED 이상 + Travel Rule 임계값 이상 시 VASP 정보 제공
     */
    function transfer(address to, uint256 amount) public override whenNotPaused returns (bool) {
        _checkCompliance(msg.sender, to, amount);
        return super.transfer(to, amount);
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public override whenNotPaused returns (bool) {
        _checkCompliance(from, to, amount);
        return super.transferFrom(from, to, amount);
    }
}
