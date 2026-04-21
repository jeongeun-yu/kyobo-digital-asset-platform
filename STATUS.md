# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | Phase 1 스켈레톤 초기 설계 완료 |
| 교육 시작 | 4/27 (웅진씽크빅) |
| 계약 | 미확정 — 이종건 계약서 일정 확인 필요 |

## 마지막 작업 (2026-04-21)
- **전체 아키텍처 스켈레톤 설계**: 5개 추상화 레이어 (Chain/Token/VASP/Compliance/CoreBanking)
- **Phase 1 구현체**: KyoboNFT, NFTIssuer, ActivityOracle, EVMAdapter, ChainEventListener, WebhookServer, RetryHandler, IdempotencyGuard, ExternalVASPAdapter
- **Phase 2/3/4 stub**: KRWStablecoin, SecurityToken, KyoboVASPAdapter, XRPLAdapter
- **ADR 4개 작성**: Chain Abstraction / VASP External-First / Token Standard 진화 / Event-Driven
- **인프라**: DMZ Nginx 설정, docker-compose, hardhat 설정, 배포 스크립트

## 다음 작업
- [ ] 교보DTS와 Core Banking API 스펙 협의 (연동 방식 A/B 결정)
- [ ] 이종건 계약서 일정 확인
- [ ] 교육 커리큘럼 재편 (9일 × 3h, 스켈레톤 기반 실습 흐름)
- [ ] PermissiveCompliance 컨트랙트 작성 (Phase 1 배포 완성)
- [ ] VASP 파트너사 선정 기준 교보DTS 제시
