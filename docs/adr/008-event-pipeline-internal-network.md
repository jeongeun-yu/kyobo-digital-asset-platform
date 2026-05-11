# ADR 008 — 이벤트 파이프라인 내부망 배치

**날짜**: 2026-05-11  
**상태**: 확정  
**결정자**: 교보 내부 담당자  
**관련 ADR**: ADR 004 (Event-Driven Architecture)

## 맥락

2026-05-11 교보생명 1차 강의에서 교보 내부 보안 담당자가 아키텍처 검토 후 결정.

기존 설계에서 이벤트 파이프라인(`event-engine`, Redis Stream)은 DMZ에 배치되어 있었다.  
교보생명 보안 정책상 **DMZ에는 애플리케이션을 배치할 수 없다.**

## 결정

**모든 애플리케이션을 내부망에 배치한다. DMZ에는 리버스 프록시(Nginx)만 허용한다.**

```
[외부]
  외부 VASP / 사용자 요청

[DMZ]
  Nginx (리버스 프록시만) ← 애플리케이션 배치 금지

[내부망]
  issuer-service          ← NFT 발행 API
  chain-adapters          ← 블록체인 연결
  vasp                    ← 외부 VASP 통신
  event-engine            ← ChainEventListener, RedisStreamPublisher 등
  Redis Stream
  NFTIssuedProcessor
  DLQHandler
  Core Banking 연동
```

## 영향 범위

| 컴포넌트 | 변경 내용 |
|---|---|
| `issuer-service` | DMZ → 내부망 이관 |
| `chain-adapters` | DMZ → 내부망 이관 |
| `vasp` | DMZ → 내부망 이관 |
| `event-engine` | DMZ → 내부망 이관 |
| Redis | DMZ → 내부망 이전 |
| DMZ | 애플리케이션 전면 제거, Nginx 리버스 프록시만 잔류 |

## 미결 사항

- **블록체인 RPC 접근**: 내부망에서 외부 블록체인 노드(Sepolia 등) 접근을 위한 네트워크 정책 확인 필요
- **Nginx 라우팅 설계**: 외부 요청 → DMZ Nginx → 내부망 서비스 포워딩 규칙 설계 필요

## 결과

ADR 004의 이벤트 드리븐 원칙은 유지.  
배치 위치만 DMZ → 내부망으로 변경.  
코드 이관 및 네트워크 설계는 Phase 2 착수 시 구체화.
