# ADR 002 — VASP External-First 전략

**날짜**: 2026-04-21  
**상태**: 확정  
**결정자**: CoinCraft (EJ Kim)

## 맥락

교보생명은 현재 가상자산사업자(VASP) 신고/인가를 보유하지 않는다.  
특금법상 VASP 없이 직접 지갑 관리·출금 처리 불가.  
그러나 장기적으로 교보생명이 VASP 인가를 취득해 내재화할 가능성이 있다.

## 결정

**Phase 1 (확정): 외부 인가 VASP 파트너 연동 (`ExternalVASPAdapter`)**  
**향후 내재화 시 (미확정): 교보생명 자체 VASP 운영 (`KyoboVASPAdapter`)**  
두 구현체는 동일한 `IVASPAdapter` 인터페이스를 구현한다.

## 교체 시나리오

교보생명이 향후 직접 VASP를 운영하게 되면:

1. `KyoboVASPAdapter` 구현 완성
2. DI 컨테이너 바인딩 변경: `ExternalVASPAdapter` → `KyoboVASPAdapter`
3. 상위 레이어(issuer-service 등) **코드 변경 없음**

## 유력 VASP 파트너 (2026-04-24 현재)

| 업체 | 상태 | 비고 |
|---|---|---|
| **월렛원 (WalletOne)** | 유력 후보 (미확정) | 교보생명 측 유선 언급 — 계약 확정 전 |

> 확정 시 이 ADR 업데이트 및 `ExternalVASPAdapter` 주석에 반영할 것.

## VASP 파트너 선정 기준 (Phase 1)

- 금융위원회 VASP 신고 완료 법인
- Travel Rule (특금법 §8의4) 시스템 구비
- HSM/MPC 기반 수탁 지갑 관리
- API SLA: 가용성 99.9% 이상
- REST API 제공 (Node.js DMZ 서비스에서 직접 호출)

## 내재화 전환 조건 (교보생명 내부 결정 사항)

- 교보생명 VASP 신고 수리
- ISMS-P 범위에 가상자산 수탁 포함
- HSM 인프라 구축 완료
- Travel Rule 자체 처리 시스템 개발
