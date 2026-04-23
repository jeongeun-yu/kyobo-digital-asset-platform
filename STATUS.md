# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | **Track B 완료 — 스켈레톤 ↔ 최종 커리큘럼 정렬 완료** |
| 교육 시작 | 4/27 (웅진씽크빅) — 교보생명 50시간 확정 |
| 계약 | 공식 확인 대기 중 (웅진씽크빅/교보DTS) |

## 마지막 작업 (2026-04-23)
- **Track B**: 스켈레톤 → 최종 커리큘럼(50시간) 정렬
- **KyoboNFT.sol**: ERC-721 → ERC-1155 + UUPS Proxy + AccessControl + Pausable + tokenId 비트 인코딩 (M2)
- **NFTIssuer.sol**: ERC-1155 mint/mintBatch 호환, Idempotency requestId, 500건 배치 한도
- **IBlockchainAdapter.ts**: 신규 — 커리큘럼 명칭 통일, mintNFT/mintNFTBatch/burnNFT/getBalance 추가 (M4)
- **EVMAdapter.ts**: IBlockchainAdapter 구현 + NFT 발행·소각·잔액 메서드 추가
- **DMZ 파이프라인 3종**: RedisStreamPublisher / ConsumerGroupWorker / DLQHandler 스켈레톤 (M7)
- **deploy-phase1.ts**: UUPS upgrades.deployProxy() 방식으로 교체, .openzeppelin/ storage layout 자동 기록

## 다음 작업
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS와 Core Banking API 스펙 협의
- [ ] VASP 파트너사 선정 기준 교보DTS 제시
- [ ] InvestorRegistry.sol 구현체 작성 (Phase 3 실구현 시)
- [ ] DividendDistributor.sol 구현체 작성 (Phase 3 실구현 시)
- [ ] hardhat.config.ts에 @openzeppelin/hardhat-upgrades 플러그인 추가 확인
