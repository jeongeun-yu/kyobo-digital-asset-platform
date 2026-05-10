# 교보생명 디지털 자산 플랫폼 — 아키텍처 개요

**설계**: CoinCraft (Sharon Kim)  
**최초 작성**: 2026-04-21  
**버전**: 1.2.0 (2026-04-24 업데이트 — 교보DTS 유선 확인, 런타임 아키텍처 반영)

---

## 현재 범위

| | 목표 | 핵심 기술 | 규제 |
|---|---|---|---|
| **Phase 1 (확정)** | 행동 보상 NFT (걷기·건강 활동) | EVM, **ERC-1155 + UUPS Proxy**, 외부 VASP | 없음 (쿠폰 성격) |
| **향후 Phase (미확정)** | 교보생명 내부 로드맵에 따름 | — | — |

> 이 과정에서 구현하는 것은 **Phase 1** 범위만 확정된 사항이다.  
> 향후 확장 방향은 교보생명이 결정하며, 스켈레톤의 인터페이스 추상화 구조(IBlockchainAdapter, IVASPAdapter 등)는 그 결정을 수용할 수 있도록 설계되어 있다.

> Phase 1 표준 변경 이유 (ADR-003 참조):
> ERC-721 → **ERC-1155**: 쿠폰 종류별 mintBatch 가스 절감.
> **UUPS Proxy**: 규제 대응 로직 업그레이드 가능.

---

## 런타임 아키텍처 (2026-04-24 확인)

```
[교보생명 내부망]
  Java Spring / WAS 기반 레거시
  Core Banking, 내부 DB, 감사 로그
        ↕ REST API (WAS 경유)
[DMZ — 이 스켈레톤의 범위]
  Node.js / TypeScript 마이크로서비스
  블록체인 인터페이스, VASP 연동, 이벤트 파이프라인
        ↕
[외부]
  VASP 파트너사 API  /  EVM 블록체인
```

- 교보DTS 레거시가 Java 기반이므로 내부망은 Java Spring 유지
- DMZ 블록체인 서비스만 Node.js — REST API로 내부 Java와 연결
- 내부망 → 외부 통신이 WAS 경유로 제한될 가능성 있음 → 네트워크 정책 추가 확인 필요

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
│  │CircleAdapter*│  │  ConsumerGroupWkr │  │TxStateMach│ │
│  └──────────────┘  │  DLQHandler       │  └───────────┘ │
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
│               blockchain/src/                             │
│  interfaces/   base/      rewards/    stablecoin* securities*│
│  IToken        BaseToken  ActivityO   KRWStbl   SecurityTk│
│  ICompliance   (non-UUPS  racle       coin       (ERC-1400)│
│  IOracle        shared)   (ERC-1155   (ERC-20)            │
│  IInvestorReg             +UUPS*)                         │
│  IDividendDist compliance/                                │
│                PermissiveC                                │
└──────────────────────────────────────────────────────────┘

* = stub (Phase 2+ 구현 예정)
```

---

## 커리큘럼 모듈 ↔ 레이어 매핑

| 모듈 | 레이어 | 핵심 파일 |
|---|---|---|
| M2 (DMZ 파이프라인) | packages/event-engine/dmz | `RedisStreamPublisher`, `ConsumerGroupWorker`, `DLQHandler` |
| M3 (VASP 추상화) | packages/vasp, chain-adapters | `TxStateMachineService`, `IBlockchainAdapter` |
| M4 (원장·감사) | packages/core-banking | `LedgerService`, `AuditLogService` |
| M5 (비즈니스 로직) | apps/issuer-service | `EventConditionService`, `WalletMappingService`, `BulkIssueService` |
| M6 (ERC-1155) | blockchain/src/rewards | `KyoboNFT.sol` (ERC-1155 + UUPS Proxy), `ActivityOracle.sol` (IOracle 구현 — 활동 데이터 기록) |
| M7 (보안 감사) | blockchain/src/rewards | Storage layout 검증 실습 — UUPS 업그레이드 패턴 |
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
