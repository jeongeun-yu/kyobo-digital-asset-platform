# 교보생명 디지털 자산 플랫폼 — 아키텍처 개요

**설계**: CoinCraft (Sharon Kim)  
**최초 작성**: 2026-04-21  
**버전**: 1.1.0 (2026-04-23 업데이트 — ERC-1155/UUPS, IBlockchainAdapter 반영)

---

## 전체 로드맵

| Phase | 목표 | 핵심 기술 | 규제 |
|---|---|---|---|
| **1** | 행동 보상 NFT (걷기·건강 활동) | EVM, **ERC-1155 + UUPS Proxy**, 외부 VASP | 없음 (쿠폰 성격) |
| **2** | KRW 원화 스테이블코인 | ERC-20, VASP 파트너 | 전자금융업/VASP 인가 |
| **3** | STO (보험·금융상품 토큰화) | ERC-1400, 예탁결제원 연동 | 금융위 토큰증권 가이드라인 |
| **4** | 교보 자체 VASP 내재화 | HSM/MPC, Travel Rule | VASP 인가 취득 |

> Phase 1 표준 변경 이유 (ADR-003 참조):
> ERC-721 → **ERC-1155**: 쿠폰 종류별 mintBatch 가스 절감.
> **UUPS Proxy**: 규제 대응 로직 업그레이드 가능.

---

## 추상화 레이어 구조

```
┌──────────────────────────────────────────────────────────┐
│                      apps/                                │
│   issuer-service (EventCondition / WalletMapping /        │
│                   BulkIssue / IssuerService)              │
└───────────────────┬──────────────────────────────────────┘
                    │ 인터페이스만 참조
┌───────────────────▼──────────────────────────────────────┐
│                    packages/                              │
│  ┌──────────────┐  ┌───────────────────┐  ┌───────────┐ │
│  │chain-adapters│  │   event-engine    │  │   vasp    │ │
│  │IBlockchain   │  │IEventHandler      │  │IVASPAdapt │ │
│  │Adapter       │  │ChainEventListener │  │ExternalVAS│ │
│  │EVMAdapter    │  │dmz/               │  │KyoboVASP* │ │
│  │XRPLAdapter*  │  │  RedisStreamPub   │  │tx/        │ │
│  └──────────────┘  │  ConsumerGroupWkr │  │TxStateMach│ │
│                    │  DLQHandler       │  └───────────┘ │
│  ┌──────────────┐  └───────────────────┘                 │
│  │ compliance   │  ┌───────────────────┐                 │
│  │IKYCProvider  │  │   core-banking    │                 │
│  │ISMSChecklist │  │ICoreBankingAdapter│                 │
│  └──────────────┘  │KyoboCBAdapter     │                 │
│                    │KDEPAdapter        │                 │
│  ┌──────────────┐  │ReconcileService   │                 │
│  │  contracts/  │  └───────────────────┘                 │
│  │IBlockchainAd.│                                        │
│  │ ← IVASPAd.   │  M4 S16 핵심: 두 인터페이스가 VASP ↔   │
│  │   위에 삽입  │  블록체인 사이를 분리                   │
│  └──────────────┘                                        │
└───────────────────┬──────────────────────────────────────┘
                    │
┌───────────────────▼──────────────────────────────────────┐
│               contracts/                                  │
│  interfaces/   base/      phase1/     phase2*  phase3*   │
│  IToken        BaseToken  KyoboNFT    KRWStbl  SecurityTk│
│  ICompliance   (non-UUPS  (ERC-1155   (ERC-20) (ERC-1400)│
│  IOracle        shared)    +UUPS)                        │
│  IBlockchain              NFTIssuer                      │
│  Adapter                  ActivityO                      │
└──────────────────────────────────────────────────────────┘

* = stub (Phase 2+ 구현 예정)
```

---

## 커리큘럼 모듈 ↔ 레이어 매핑

| 모듈 | 레이어 | 핵심 파일 |
|---|---|---|
| M2 (ERC-1155) | contracts/phase1 | `KyoboNFT.sol` — UUPS + tokenId 인코딩 |
| M3 (보안 감사) | contracts/phase1 | `KyoboNFTV2.sol` — Storage layout 검증 |
| M4 (VASP 추상화) | packages/vasp, chain-adapters | `TxStateMachineService`, `IBlockchainAdapter` |
| M5 (비즈니스 로직) | apps/issuer-service | `EventConditionService`, `WalletMappingService`, `BulkIssueService` |
| M6 (원장·감사) | packages/core-banking | `LedgerService`, `AuditLogService` |
| M7 (DMZ 파이프라인) | packages/event-engine/dmz | `RedisStreamPublisher`, `ConsumerGroupWorker`, `DLQHandler` |
| M8 (키 거버넌스) | packages/vasp | `KeyGovernanceService` — EIP-712 SafeTx, Travel Rule |

---

## 이벤트 플로우 (Phase 1 전체)

```
1. 교보 앱 → 활동 달성 이벤트 → Webhook POST /webhook/activity
2. EventConditionService.evaluate() → eligible 판단
3. WalletMappingService.getWalletAddr(userId)
4. TxStateMachineService.submitMintRequest() → SUBMITTED
5. IBlockchainAdapter.mintNFT() → ERC-1155 mint (UUPS proxy)
6. 블록체인 → TransferSingle 이벤트
7. ChainEventListener → RedisStreamPublisher.publish() [202 패턴]
8. ConsumerGroupWorker.process() → LedgerService + AuditLogService
9. DLQHandler (3회 실패 시) → 운영 알림
10. TxStateMachineService.handleConfirmed() → CONFIRMED
```

---

## 설계 원칙

1. **인터페이스 우선**: 모든 레이어 간 통신은 인터페이스를 통한다
2. **Phase stub 선배포**: Phase 2/3 파일이 Phase 1 스켈레톤 안에 존재한다
3. **교체 가능성**: 체인(IBlockchainAdapter)·VASP(IVASPAdapter)·Compliance(ICompliance) 구현체는 DI로 교체 가능
4. **보안 우선**: Private key는 코드에 없음, DMZ 경유, HMAC 서명 필수
5. **감사 추적**: 모든 발행·전송 이벤트는 온체인 + DB 이중 기록
6. **업그레이드 가능**: KyoboNFT는 UUPS Proxy — 규제 변경 시 재배포 없이 로직 교체
