# ADR-006: 투자자 레지스트리 온체인 vs 오프체인

**상태**: 확정  
**날짜**: 2026-04-23  
**결정자**: Sharon (CTO)

---

## 맥락

STO 투자자 등록·한도·락업 정보를 어디에 저장할지 결정해야 한다. 규제상 컨트랙트 전송 시 검증이 필요하므로, 최소한 검증 로직은 온체인에 있어야 한다.

## 결정

**온체인 IInvestorRegistry 컨트랙트 + 오프체인 InvestorRegistryService 이중 구조**를 채택한다.

- 온체인(`IInvestorRegistry.sol`): 등록 여부, 보유량, 락업 — 전송 검증의 신뢰 기준
- 오프체인(`InvestorRegistryService.ts`): KYC 확인, 발행 전 사전 검증, DB 캐시

## 이유

순수 온체인:
- 모든 KYC 데이터 온체인 기록 → 개인정보 보호법 위반 위험 (해시만 저장 가능)
- 가스 비용 과다 (투자자 수백~수천명 예상)

순수 오프체인:
- 전송 시 실시간 컨트랙트 검증 불가 — 우회 가능성
- ERC-1400 표준 미준수

이중 구조:
- 온체인: 최소 상태(등록 여부, 보유량, 락업 타임스탬프)만 저장
- 오프체인: KYC 레벨·개인정보는 교보 내부 DB (암호화)
- 신뢰 기준은 온체인이므로 규제 요건 충족

## 결과

- `InvestorCompliance.canTransfer()` → `IInvestorRegistry.canAcceptTransfer()` 호출 경로
- 투자자 수가 증가하면 오프체인 캐시(Redis) 레이어 추가 고려
- `InvestorType.PROFESSIONAL`은 `maxHolding = 0`(한도 없음)으로 설정 — 전문투자자 규정 준수
