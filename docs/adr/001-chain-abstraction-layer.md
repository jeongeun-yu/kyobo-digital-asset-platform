# ADR 001 — Chain Abstraction Layer

**날짜**: 2026-04-21  
**상태**: 확정  
**결정자**: CoinCraft (EJ Kim)

## 맥락

교보생명은 Phase 1에서 EVM 기반 NFT 발행을 시작하지만,  
Phase 2+ (KRW 스테이블코인, STO)에서 XRP Ledger, BFT 체인 등  
다른 체인을 병행 또는 교체 사용할 가능성이 있다.

## 결정

**모든 체인 연동은 `IBlockchainAdapter` 인터페이스를 통한다.**  
`event-engine`, `issuer-service` 등 상위 레이어는 체인을 직접 참조하지 않는다.

```
IBlockchainAdapter
├── EVMAdapter        ← Phase 1 (Ethereum/Polygon)
├── XRPLAdapter       ← Phase 2+ stub
└── UTXOAdapter       ← Phase 3+ stub
```

## 이유

- 체인 교체 시 상위 레이어 코드 변경 없음
- 멀티체인 병행 운영: 어댑터 인스턴스만 추가
- 테스트: MockChainAdapter로 체인 없이 전체 비즈니스 로직 테스트 가능

## 결과

- `EVMAdapter`는 DMZ 내부 private RPC 노드에만 연결 (public RPC 금지)
- Missed event 복구는 `queryEvents()` 인터페이스 메서드로 표준화
- 체인별 특성(UTXO vs Account, gas vs fee)은 어댑터 내부에서 처리

## 대안 검토

| 대안 | 기각 이유 |
|---|---|
| ethers.js 직접 사용 | 체인 교체 시 전체 비즈니스 로직 수정 필요 |
| 멀티체인 SDK | 교보 보안 정책상 외부 SDK 추가 승인 부담 |
