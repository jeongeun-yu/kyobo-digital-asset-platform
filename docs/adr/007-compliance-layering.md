# ADR-007: 컴플라이언스 레이어 교체 전략

**상태**: 확정  
**날짜**: 2026-04-23  
**결정자**: EJ Kim

---

## 맥락

Phase 1(NFT) → Phase 2(스테이블코인) → Phase 3(STO)로 진행하면서 컴플라이언스 강도가 달라진다. 컨트랙트 재배포 없이 규제 강도를 교체할 수 있는 구조가 필요하다.

## 결정

`BaseToken.updateCompliance(address)` 패턴으로 컴플라이언스 구현체를 런타임에 교체한다.

| Phase | 컴플라이언스 구현체 | 검증 내용 |
|---|---|---|
| 1 (NFT) | `PermissiveCompliance` | 항상 허용 (오프체인 KYC만) |
| 2 (KRW) | `PermissiveCompliance` or `KYCCompliance`(추가 예정) | KYC ENHANCED 이상 |
| 3 (STO) | `InvestorCompliance` | 등록·한도·락업 검증 |

## 이유

| 대안 | 기각 이유 |
|---|---|
| 컴플라이언스 로직을 컨트랙트에 직접 내장 | Phase 전환마다 컨트랙트 재배포 필요 → 투자자 보유량 마이그레이션 부담 |
| 오프체인 게이트키퍼만 사용 | 스마트컨트랙트 직접 호출 시 컴플라이언스 우회 가능 |
| 별도 프록시 패턴(UUPS/Transparent) | 업그레이드 키 관리 복잡, 교보 내부 보안 정책 검토 필요 |

## 결과

- `ICompliance` 인터페이스 3개 메서드(`canTransfer`, `transferred`, `isVerified`)는 고정 — 구현체 자유 교체
- `updateCompliance()`는 `DEFAULT_ADMIN_ROLE`만 호출 가능 (교보생명 운영 담당)
- 교체 후 반드시 온체인 이벤트(`ComplianceUpdated`) 발생 → ISMS-P 감사 추적
- `InvestorCompliance.setActivePartition()` 호출 시 reentrancy 위험 없음 (view 패턴 확인 필요 — Phase 3 구현 시 검토)
