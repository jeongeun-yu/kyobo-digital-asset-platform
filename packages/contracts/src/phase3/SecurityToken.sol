// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// =============================================================================
// Phase 3 STUB — STO (Security Token Offering)
// =============================================================================
// 구현 시점: 금융위원회 토큰증권 가이드라인 정식 적용 후
//            (현행 기준: 2024년 토큰증권 발행·유통 규율체계 정비안)
//
// 설계 방향 (변경 금지):
//   - ERC-1400 (Security Token Standard) 기반
//   - Partition 구조: 보통주/우선주/채권 등 금융상품 종류별 파티션
//   - ICompliance 훅 필수 — 모든 전송에 투자자 등록 + 보유 한도 + 락업 검증
//   - 결제: KRWStablecoin (Phase 2) 또는 외부 VASP 연동
//   - 담보 자산 참조: IOracle → 자산 가치 실시간 검증
//   - 투자자 보고: 온체인 배당 분배 + Transfer Restriction 이력 감사
//
// 규제 연동:
//   - 한국예탁결제원 연동 포인트: transferWithData() 콜백
//   - 금융보안원 ISMS-P: 접근 로그 전량 이벤트 기록
// =============================================================================

import "../base/BaseToken.sol";

contract SecurityToken is BaseToken {
    // TODO Phase 3
    constructor(address issuer_, address compliance_)
        BaseToken(issuer_, compliance_) {}

    function tokenType() external pure override returns (TokenType) {
        return TokenType.SECURITY_TOKEN;
    }
}
