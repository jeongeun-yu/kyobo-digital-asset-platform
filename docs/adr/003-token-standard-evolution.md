# ADR 003 — Token Standard 진화 전략

**날짜**: 2026-04-21  
**수정**: 2026-04-23 — Phase 1 표준 ERC-721 → ERC-1155 변경 반영  
**상태**: 확정  
**결정자**: CoinCraft (Sharon Kim)

## 맥락

교보생명 디지털 자산 플랫폼은 3단계 토큰 진화를 예정한다.

| Phase | 토큰 | 표준 | 규제 |
|---|---|---|---|
| 1 | 행동 보상 NFT | **ERC-1155 + UUPS Proxy** | 없음 (쿠폰 성격) |
| 2 | KRW 스테이블코인 | ERC-20 | 전자금융업/VASP |
| 3 | STO | ERC-1400 | 금융위원회 토큰증권 가이드라인 |

> **2026-04-23 변경**: Phase 1 표준을 ERC-721 → **ERC-1155 + UUPS Proxy**로 변경.
> 변경 이유 및 대안 비교는 하단 참조.

## 결정

### Phase 1 — ERC-1155 + UUPS Proxy

ERC-721 대신 **ERC-1155**를 채택한다.

**이유:**
- 쿠폰 종류별(걷기/건강검진/캠페인) `mintBatch` 가스 절감 (~60% 절약)
- `tokenId = productCode(64비트) | eventCode(64비트)` 인코딩으로 충돌 없는 ID 공간
- 보험상품 연계 STO(Phase 3)에서 ERC-1155 멀티토큰 구조와 개념 연속성

**UUPS Proxy 추가 이유:**
- 금융 규제 변경에 따른 컴플라이언스 로직 업그레이드 필요
- Storage Collision 방지: `_authorizeUpgrade()`로 승인된 UPGRADER_ROLE만 업그레이드 가능
- 교육 측면: UUPS 패턴이 커리큘럼 M2/M3 핵심 학습 목표

**ERC-721 대비 ERC-1155 트레이드오프:**

| 항목 | ERC-721 | ERC-1155 |
|---|---|---|
| 토큰 고유성 | 완전 고유 | 종류별 수량 관리 |
| 가스 효율 | 단건 위주 | mintBatch 시 대폭 절감 |
| 전송 편의성 | 단건 | safeTransferFrom + safeBatchTransferFrom |
| OpenSea 등 NFT 마켓 | 기본 지원 | 지원 (단, 수량 개념 표시 차이) |
| 교보 쿠폰 적합성 | 보통 | **우수** (종류별 대량 발행) |

### Phase 3 — ERC-1400 (Security Token Standard)

ERC-1400 기반 `SecurityToken.sol`을 Phase 3 STO 표준으로 유지한다.
`BaseToken` (non-upgradeable) 상속 구조 — STO는 금융당국 승인 후 고정 배포.

> 주의: KyoboNFT(Phase 1)는 UUPS Proxy이지만 SecurityToken(Phase 3)은 non-upgradeable.
> 이유: STO는 법적 증권으로서 컨트랙트 불변성이 투자자 보호에 필수.

## 컴플라이언스 훅 전략

`ICompliance` 인터페이스를 통해 컨트랙트와 규제 로직을 분리한다.

- Phase 1: `PermissiveCompliance` — 모두 허용 (NFT 쿠폰)
- Phase 2: `KYCCompliance` — 실명 확인된 계정만 허용
- Phase 3: `InvestorCompliance` — 투자자 등록 + 보유 한도 + 락업 검증

**컴플라이언스 변경 = 컨트랙트 재배포 없이 `updateCompliance()` 주소 업데이트만으로 완료.**

## ERC-1400 도입 시점 (Phase 3)

- 금융위원회 토큰증권 발행·유통 규율체계 정식 시행 후
- Partition 구조: INSURANCE_CLASS_A / INSURANCE_CLASS_B
- 한국예탁결제원 연동: `KDEPAdapter.notifyIssuance()` / `notifyRedemption()`
