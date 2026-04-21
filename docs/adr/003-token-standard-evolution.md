# ADR 003 — Token Standard 진화 전략

**날짜**: 2026-04-21  
**상태**: 확정  
**결정자**: CoinCraft (Sharon Kim)

## 맥락

교보생명 디지털 자산 플랫폼은 3단계 토큰 진화를 예정한다.

| Phase | 토큰 | 표준 | 규제 |
|---|---|---|---|
| 1 | 행동 보상 NFT | ERC-721 | 없음 (쿠폰 성격) |
| 2 | KRW 스테이블코인 | ERC-20 | 전자금융업/VASP |
| 3 | STO | ERC-1400 | 금융위원회 토큰증권 가이드라인 |

## 결정

**`BaseToken` 추상 컨트랙트를 공통 기반으로 사용한다.**  
RBAC(역할 기반 접근), Pause, Compliance 훅이 모든 단계에서 동일하게 적용된다.

```
BaseToken (RBAC + Pause + Compliance 훅)
├── KyoboNFT        (ERC-721)    ← Phase 1
├── KRWStablecoin   (ERC-20)     ← Phase 2
└── SecurityToken   (ERC-1400)   ← Phase 3
```

## Compliance 훅 전략

`ICompliance` 인터페이스를 통해 컨트랙트와 규제 로직을 분리한다.

- Phase 1: `PermissiveCompliance` — 모두 허용 (NFT 쿠폰)
- Phase 2: `KYCCompliance` — 실명 확인된 계정만 허용
- Phase 3: `InvestorCompliance` — 투자자 등록 + 보유 한도 + 락업 검증

**컴플라이언스 변경 = 컨트랙트 재배포 없이 `compliance` 주소 업데이트만으로 완료.**

## ERC-1400 도입 시점 (Phase 3)

- 금융위원회 토큰증권 발행·유통 규율체계 정식 시행 후
- Partition 구조: 보통주/우선주/채권 등 금융상품별 분리
- 한국예탁결제원 연동 포인트 설계 필요 (CoinCraft 주도)
