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

import "../base/BaseToken.sol";

contract KRWStablecoin is BaseToken {
    // TODO Phase 2
    constructor(address issuer_, address compliance_)
        BaseToken(issuer_, compliance_) {}

    function tokenType() external pure override returns (TokenType) {
        return TokenType.STABLECOIN;
    }
}
