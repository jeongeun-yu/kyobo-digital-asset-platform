# Day 02 — M2: DMZ 이벤트 파이프라인 전반부 (S5~S8)

**세션**: S5~S8 | **모듈**: M2 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: WebhookServer(202 패턴 + HMAC 서명 검증) + Redis Streams 이론 + CLI 실습

---

## S5: 온체인 이벤트 수신 설계 — 즉시 처리의 위험과 비동기 분리 (강의 25분 + 실습 30분)

### 강의

**Webhook 즉시 처리 위험:**
- DB 장애 시 이벤트 영구 유실
- VASP 재전송 없으면 복구 불가

**202 즉시 응답 패턴:**
- Webhook 수신 즉시 202 반환, Queue 적재는 비동기
- VASP 타임아웃 방지 (VASP는 5~30초 내 응답 없으면 타임아웃)

**Queue 중간 단계가 필수인 이유:**
1. 이벤트 내구성 보장 — Redis Streams 영구 저장
2. Consumer 독립 확장 — 처리 속도와 수신 속도 분리
3. 재처리 가능 — 실패 시 PEL에서 재수신

**202 패턴 없는 방식 vs 202+Queue 방식 비교:**
```
[기존] Webhook → DB 직접 저장 → 202
        → DB 장애 시: 저장 실패 → VASP에 500 반환 → 이벤트 유실

[202 패턴] Webhook → Queue 적재 → 즉시 202
           → DB 장애와 무관 / Consumer가 나중에 Queue에서 꺼내 처리
```

### 🔴 실습 (30분) — 수강생 직접 작성

**Step 1**: WebhookReceiver 기본 구조 생성
```typescript
// dmz/packages/event-engine/src/webhook/WebhookReceiver.ts
// TODO: POST /webhook 라우트 핸들러 구현
// 요구사항:
// 1. 요청 수신 즉시 202 반환
// 2. Queue 적재는 202 반환 후 비동기로 처리
// 3. DB 접근 없음

export class WebhookReceiver {
  constructor(
    private readonly queueService: QueueService,
  ) {}

  async receiveWebhook(req: Request, res: Response): Promise<void> {
    // TODO: 즉시 202 응답
    // TODO: 비동기로 Queue 적재
  }
}
```

**Step 2**: Queue 적재 실패 시 처리 정책을 결정하고 주석으로 설명
```typescript
// TODO: Queue 적재가 실패하면 어떻게 해야 하는가?
// 옵션 A: 로그만 남기고 무시 (이미 202 반환됨)
// 옵션 B: 인메모리 버퍼에 저장 후 재시도
// 선택한 정책과 이유를 주석으로 작성
```

### ✅ 답안

```typescript
// WebhookReceiver.ts 완성
import { Request, Response } from 'express';
import { QueueService } from './QueueService';

export class WebhookReceiver {
  constructor(private readonly queueService: QueueService) {}

  async receiveWebhook(req: Request, res: Response): Promise<void> {
    // 즉시 202 반환 — VASP 타임아웃 방지
    res.status(202).json({ received: true });

    // 비동기 Queue 적재 — 응답과 독립적으로 처리
    setImmediate(async () => {
      try {
        await this.queueService.enqueue(req.body);
      } catch (err) {
        // Queue 적재 실패: 로그 기록 (이미 202 반환됨)
        // 운영에서는 별도 fallback queue 또는 알림 필요
        console.error('[WebhookReceiver] Queue 적재 실패:', err);
      }
    });
  }
}
```

### ✅ 완료 기준
- [ ] 202 패턴 설계 이해 + 설명 가능
- [ ] WebhookReceiver 라우트 구조 완성

---

## S6: Webhook 보안 검증 — HMAC-SHA256과 타이밍 공격 방어 (강의 15분 + 실습 40분)

### 강의

**HMAC-SHA256 서명 검증:**
- VASP가 전송하는 `X-Kyobo-Signature` 헤더 검증
- 서명 없는 요청 즉시 401 거부
- rawBody Buffer로 서명 계산 (JSON 재직렬화 함정 방지)

**Timing Attack 방어:**
- `===` 비교는 일치 위치에 따라 응답 시간 차이 → 서명 유추 가능
- `crypto.timingSafeEqual()` 사용으로 상수 시간 비교 강제

### 🔴 실습 (40분)

실습 파일: `src/exercises/S06_hmac_webhook.ts`

```
TODO 구현 목록:
  [ ] TODO 1: signature 없으면 false 반환
  [ ] TODO 2: crypto.createHmac으로 expected 계산 (rawBody Buffer 사용)
  [ ] TODO 3: Buffer.from(?, 'hex') 변환
  [ ] TODO 4: 길이 다르면 false 반환
  [ ] TODO 5: crypto.timingSafeEqual 비교
```

### ✅ 완료 기준
- [ ] 서명 없는 요청 → 401
- [ ] 잘못된 서명 → 401
- [ ] 올바른 서명 → 202
- [ ] WebhookServer(S5+S6) 전체 흐름 설명 가능

---

## S7: Redis Streams 내부 구조 (강의 55분)

### 강의 (이론 전용)

**왜 Redis Streams인가 — Kafka와의 관계:**

| 항목 | Redis Streams | Kafka |
|---|---|---|
| 실습 환경 | `docker run redis` 한 줄 | ZooKeeper/KRaft + Broker 별도 설치 |
| 핵심 개념 | Consumer Group, At-least-once, PEL, ACK | 동일 |
| 처리량 | 수만 msg/초 | 수백만 msg/초 |

개념이 동일하다. Redis Streams로 배운 패턴은 Kafka에 그대로 적용된다.

| Redis Streams | Kafka |
|---|---|
| `XACK` | `commitOffset` |
| `PEL` | `__consumer_offsets` |
| `XREADGROUP` | `poll()` |
| `XADD` | `produce()` |

**Pub/Sub vs Queue vs Streams:**
```
[Pub/Sub]  구독자 없으면 메시지 소멸 → 내구성 없음
[Queue]    단일 Consumer → 수평 확장 불가
[Streams]  append-only 로그 + Consumer Group → 내구성 + 확장 모두 해결
```

**PEL(Pending Entry List)과 XACK:**
- `XREADGROUP`으로 읽으면 자동으로 PEL에 등록
- `XACK`를 보내야 PEL에서 제거 = "처리 완료" 선언
- XACK 없이 Consumer crash → PEL에 잔류 → 재시작 후 재수신 (At-least-once 보장)

**Consumer Group 메시지 분배:**
- 동일 그룹의 여러 Consumer → 메시지 자동 분배 (중복 수신 없음)
- 서로 다른 그룹 → 각 그룹이 전체 메시지를 독립적으로 수신

### ✅ 완료 기준
- [ ] Pub/Sub vs Queue vs Streams 차이 설명 가능
- [ ] PEL → XACK 흐름 설명 가능
- [ ] Redis Streams ↔ Kafka 1:1 매핑 설명 가능

---

## S8: Redis Streams CLI 실습 (강의 15분 + 실습 45분)

### 🔴 실습 (45분) — 수강생 직접 입력

**Step 1**: Redis 인스턴스 기동
```bash
docker run -d -p 6379:6379 redis:7-alpine
redis-cli ping
# PONG
```

**Step 2**: Stream에 이벤트 적재
```bash
# TODO: XADD로 NFT 발행 이벤트 3개 적재
# stream 이름: kyobo-events
# field: eventType, tokenId, to
XADD kyobo-events * eventType NFTIssued tokenId 1001 to 0xAlice
# 나머지 2개 직접 작성
```

**Step 3**: Consumer Group 생성 + 메시지 읽기
```bash
# TODO: Consumer Group 생성 (처음부터 읽기)
XGROUP CREATE kyobo-events processing-group $ MKSTREAM

# TODO: Consumer Group으로 메시지 읽기
XREADGROUP GROUP processing-group worker-1 COUNT 10 STREAMS kyobo-events >
```

**Step 4**: ACK 처리 → PEL 확인
```bash
# TODO: 첫 번째 메시지 ACK
# (Step 2에서 받은 메시지 ID 사용)
XACK kyobo-events processing-group [MESSAGE-ID]

# TODO: PEL 조회 → ACK된 메시지 사라졌는지 확인
XPENDING kyobo-events processing-group - + 10
```

**Step 5**: 미ACK 재수신 시뮬레이션
```bash
# 메시지를 읽되 ACK하지 않음 → Ctrl+C로 프로세스 종료 시뮬레이션
# 재시작 후 XAUTOCLAIM으로 재수신
XAUTOCLAIM kyobo-events processing-group worker-2 0 0-0 COUNT 10
```

**Step 6**: Consumer 2개 동시 실행 → 메시지 분배 확인
```bash
# 터미널 1: worker-A
XREADGROUP GROUP processing-group worker-A COUNT 5 BLOCK 5000 STREAMS kyobo-events >

# 터미널 2: worker-B
XREADGROUP GROUP processing-group worker-B COUNT 5 BLOCK 5000 STREAMS kyobo-events >

# 새 메시지 10개 적재 후 → 각 worker에 몇 개씩 분배되는지 확인
```

### ✅ 답안

```bash
# Step 2 완성
XADD kyobo-events * eventType NFTIssued tokenId 1001 to 0xAlice
XADD kyobo-events * eventType NFTIssued tokenId 1002 to 0xBob
XADD kyobo-events * eventType NFTBurned tokenId 1001 to 0xAlice

# Stream 내용 확인
XRANGE kyobo-events - +

# Step 3 완성 (0 = 처음부터 읽기)
XGROUP CREATE kyobo-events processing-group 0 MKSTREAM
XREADGROUP GROUP processing-group worker-1 COUNT 10 STREAMS kyobo-events >

# Step 4 — PEL에 3개 잔류 확인
XPENDING kyobo-events processing-group - + 10
# 출력: 3개 ID 목록

# ACK 후 재조회
XACK kyobo-events processing-group 1714000000000-0
XPENDING kyobo-events processing-group - + 10
# 출력: 2개 (1개 줄어듦)
```

### ✅ Day 02 완료 기준
- [ ] WebhookServer(S5+S6) 전체 흐름 — 202 즉시 응답 + HMAC 검증 설명 가능
- [ ] Redis Streams CLI 직접 조작 완료
- [ ] 미ACK 재수신 원리 확인
- [ ] Consumer 2개 → 메시지 분배 확인
