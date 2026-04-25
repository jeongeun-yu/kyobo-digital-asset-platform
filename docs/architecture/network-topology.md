# 네트워크 토폴로지

**확정일**: 2026-04-25  
**근거**: 교보생명 교보DTS 유선 협의 반영

## 3-Zone 아키텍처

```
[인터넷 / 외부]
  - 이더리움 메인넷 피어
  - 월렛원(WalletOne) VASP REST API
        ↓
[방화벽 1] — 허용: P2P 포트(30303), HTTPS(443)
        ↓
[DMZ]
  ┌─────────────────────────────────────┐
  │ Nginx 리버스 프록시                  │
  │   :8545 → Private Ethereum Node     │
  │   :8546 → WebSocket (이벤트 구독)   │
  │   :443  → issuer-service Webhook    │
  │                                     │
  │ Private Ethereum Node (geth/besu)   │
  │   외부 피어와 동기화                 │
  └─────────────────────────────────────┘
        ↓
[방화벽 2] — 허용: 내부망 IP만 (10.0.0.0/8)
        ↓
[교보 내부망]
  ┌─────────────────────────────────────────────────────┐
  │ issuer-service (Node.js)          포트: 3000        │
  │   ← DMZ Nginx webhook (inbound)                     │
  │   → DMZ Nginx :8545 (outbound, EVM RPC)             │
  │   → DMZ Nginx :443  (outbound, VASP proxy)          │
  │   → blockchain-gateway :8080 (outbound, REST)       │
  │                                                     │
  │ blockchain-gateway (Java Spring Boot) 포트: 8080    │
  │   ← issuer-service REST (inbound)                   │
  │   → Core Banking WAS :? (outbound, 교보 레거시)     │
  │   → Oracle DB / PostgreSQL                          │
  │                                                     │
  │ Core Banking WAS (Java, 교보 기존 시스템)            │
  │   고객 정보, 보험 계약, 포인트                       │
  │                                                     │
  │ Oracle DB (교보 내부 표준) / PostgreSQL (개발용)     │
  └─────────────────────────────────────────────────────┘
```

## 포트 정책

| 서비스 | 포트 | 허용 출처 | 비고 |
|--------|------|-----------|------|
| issuer-service | 3000 | DMZ Nginx (webhook), 내부망 only | Node.js |
| blockchain-gateway | 8080 | 내부망 only (issuer-service) | Java |
| Core Banking WAS | TBD | 내부망 only | 교보 기존 |
| Ethereum RPC | 8545 | 내부망 IP only (via DMZ Nginx) | |
| Ethereum WS | 8546 | 내부망 IP only (via DMZ Nginx) | |

## Phase별 변화

| Phase | 변화 내용 |
|-------|-----------|
| Phase 1 | 현재 구조 — 외부 VASP(월렛원), Ethereum Mainnet |
| Phase 2 | KRW 스테이블코인 추가 — ReconcileService 가동, Circle ARC 검토 |
| Phase 3 | XRPL 브릿지 추가, 보안토큰(STO) — XRPLAdapter 활성화 |
| Phase 4 | 교보 자체 VASP 라이센스 — KyoboVASPAdapter로 교체 (1줄 변경) |
