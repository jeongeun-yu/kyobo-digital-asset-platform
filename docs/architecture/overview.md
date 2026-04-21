# 교보생명 디지털 자산 플랫폼 — 아키텍처 개요

**설계**: CoinCraft (Sharon Kim)  
**최초 작성**: 2026-04-21  
**버전**: 1.0.0

---

## 전체 로드맵

| Phase | 목표 | 핵심 기술 | 규제 |
|---|---|---|---|
| **1** | 행동 보상 NFT (걷기·건강 활동) | EVM, ERC-721, 외부 VASP | 없음 (쿠폰 성격) |
| **2** | KRW 원화 스테이블코인 | ERC-20, VASP 파트너 | 전자금융업/VASP 인가 |
| **3** | STO (보험·금융상품 토큰화) | ERC-1400, 예탁결제원 연동 | 금융위 토큰증권 가이드라인 |
| **4** | 교보 자체 VASP 내재화 | HSM/MPC, Travel Rule | VASP 인가 취득 |

---

## 추상화 레이어 구조

```
┌─────────────────────────────────────────────────────┐
│                   apps/                              │
│   issuer-service          monitoring                 │
└──────────────┬──────────────────────────────────────┘
               │ 인터페이스만 참조
┌──────────────▼──────────────────────────────────────┐
│                 packages/                            │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │chain-adapt.│  │ event-engine │  │    vasp     │ │
│  │IChainAdapt.│  │IEventHandler │  │IVASPAdapter │ │
│  │EVMAdapter  │  │ChainEvtLsnr  │  │ExternalVASP │ │
│  │XRPLAdapter*│  │WebhookServer │  │KyoboVASP*   │ │
│  └────────────┘  └──────────────┘  └─────────────┘ │
│  ┌────────────┐  ┌──────────────┐                   │
│  │compliance  │  │ core-banking │                   │
│  │IKYCProvider│  │ICoreBanking  │                   │
│  │ISMSCheck   │  │KyoboCBAdapter│                   │
│  └────────────┘  └──────────────┘                   │
└──────────────┬──────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────┐
│              contracts/                              │
│  interfaces/   base/      phase1/  phase2* phase3*  │
│  IToken        BaseToken  KyoboNFT KRWStbl STO      │
│  ICompliance              NFTIssue                  │
│  IOracle                  ActivityO                 │
└─────────────────────────────────────────────────────┘

* = stub (Phase 2+ 구현 예정)
```

---

## 네트워크 아키텍처 (DMZ)

```
[교보 내부망]          [DMZ]              [외부]
                                          
앱 서버   ──────→  Nginx (8545/8546) ──→  블록체인 노드
Core BK   ←──────  Nginx (443)            
issuer-svc  (내부 배치)                   외부 VASP API
                                          (방화벽 경유)
```

---

## 이벤트 플로우 (Phase 1)

```
1. 교보 앱 → 활동 달성 이벤트 → Webhook POST /webhook/activity
2. issuer-service → KYC 확인 + AML 스크리닝
3. issuer-service → NFTIssuer.issueActivityNFT() 트랜잭션 전송
4. 블록체인 → Issued 이벤트 발생
5. ChainEventListener → NFTIssuedHandler → Core Banking Webhook 발송
6. Core Banking → 포인트/쿠폰 상태 업데이트
```

---

## 설계 원칙

1. **인터페이스 우선**: 모든 레이어 간 통신은 인터페이스를 통한다
2. **Phase stub 선배포**: Phase 2/3 파일이 Phase 1 스켈레톤 안에 존재한다
3. **교체 가능성**: 체인·VASP·Compliance 구현체는 DI로 교체 가능
4. **보안 우선**: Private key는 코드에 없음, DMZ 경유, HMAC 서명 필수
5. **감사 추적**: 모든 발행·전송 이벤트는 온체인 + DB 이중 기록
