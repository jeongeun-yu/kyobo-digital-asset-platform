# ADR 004 — Event-Driven Architecture (온체인 ↔ 오프체인 연동)

**날짜**: 2026-04-21  
**상태**: 확정  
**결정자**: CoinCraft (Sharon Kim)

## 맥락

블록체인은 기본적으로 push 알림이 없다.  
오프체인 시스템(Core Banking, 앱 서버)이 온체인 상태 변화를 알려면  
폴링(polling) 또는 이벤트 구독(event subscription) 중 하나를 선택해야 한다.

## 결정

**이벤트 드리븐 아키텍처를 채택한다.**  
폴링은 허용하지 않는다.

```
[교보 앱] → Webhook → [issuer-service]
                              ↓
                    [NFTIssuer Contract]
                              ↓ 이벤트 발생
              [ChainEventListener] ← subscribeEvents()
                              ↓
                    [NFTIssuedHandler]
                              ↓ Webhook (retry)
                    [Core Banking]
```

## 신뢰성 보장 3원칙

**1. Missed Event 복구**  
서비스 재시작 시 DB의 마지막 처리 블록부터 `queryEvents()`로 보충 후 구독 시작.  
블록 체인 reorg 대응: 최소 12블록 확인 후 처리 (설정값).

**2. 멱등성 (Idempotency)**  
`txHash + logIndex`를 멱등성 키로 사용.  
`IdempotencyGuard`가 중복 처리를 차단.  
외부 시스템 발송 시 `requestId` 전달 → 수신측도 중복 방지.

**3. 재시도 + Dead Letter Queue**  
외부 시스템 발송 실패 시 지수 백오프 재시도 (최대 5회).  
최종 실패는 DLQ에 보관 → 알람 + 수동 재처리.

## Webhook 보안

- HMAC-SHA256 서명 검증 (수신·발송 양방향)
- TLS 1.3 전용 (DMZ Nginx 설정)
- 요청 body 크기 제한 64KB
- 내부망 IP 화이트리스트

## Phase 2+ 확장

메시지 볼륨 증가 시:
- DLQ → Kafka Dead Letter Topic
- `ChainEventListener` → 멀티 인스턴스 (파티셔닝)
- `IdempotencyStore` → Redis Cluster
