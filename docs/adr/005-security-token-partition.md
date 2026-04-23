# ADR-005: SecurityToken 파티션 구조

**상태**: 확정  
**날짜**: 2026-04-23  
**결정자**: Sharon (CTO)

---

## 맥락

교보생명 보험 상품 연계 STO는 상품 종류(보통 보험 / 우선 보험)에 따라 보유 한도, 배당율, 락업 기간이 상이하다. 단일 토큰 컨트랙트로 이를 처리하려면 내부적으로 서브-유닛 구분이 필요하다.

## 결정

ERC-1400 파티션(Partition) 구조를 채택한다.

- `PARTITION_CLASS_A = keccak256("INSURANCE_CLASS_A")` — 일반 보험 연계 STO
- `PARTITION_CLASS_B = keccak256("INSURANCE_CLASS_B")` — 우선 보험 연계 STO

파티션별 독립 잔액(`_partitionBalances[partition][holder]`)을 관리하며, 전송·발행·소각은 항상 파티션을 명시한다.

## 이유

| 대안 | 기각 이유 |
|---|---|
| 파티션 없는 단일 ERC-20 | 상품 종류 구분 불가, Phase 3 규제 요건 미충족 |
| 파티션별 별도 컨트랙트 배포 | 관리 복잡도↑, 공통 RBAC/compliance 중복 |
| ERC-1155 멀티토큰 | Security Token 표준 비준수, 컨트롤러 강제 이전 구현 난이도↑ |

## 결과

- `InvestorCompliance.setActivePartition(partition)` 패턴으로 컨텍스트 전달 필요
- 파티션 추가는 `_registerPartition()` 호출 — ISSUER_ROLE 필요 (교보 준법 담당 승인)
- 배당 분배는 파티션별 스냅샷 기준 (`IDividendDistributor.distributeDividend(partition, ...)`)
