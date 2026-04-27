# Day 02 — M2: DMZ 이벤트 파이프라인 전반부 (S5~S8)

**세션**: S5~S8 | **모듈**: M2 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: WebhookReceiver(202 패턴) + Redis Streams CLI 실습 + HMAC 서명 검증 + QueueService

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

## S6: Redis Streams 내부 구조와 At-least-once 처리 보장 원리 (강의 55분)

### 강의 (이론 세션 — 실습 없음)

**Pub/Sub vs Queue vs Streams 비교:**
| 방식 | 영구 저장 | 재수신 | Consumer Group |
|---|---|---|---|
| Pub/Sub | ✗ | ✗ | ✗ |
| 단순 Queue | △ (소비 시 삭제) | ✗ | ✗ |
| Redis Streams | ✓ (영구) | ✓ (XACK 전까지) | ✓ |

**Stream Entry 구조:**
- ID: `timestamp-seq` 자동 생성 (예: `1714000000000-0`)
- field-value 쌍으로 데이터 저장
- `XADD stream-key * field1 value1 field2 value2`

**Consumer Group 내부 원리:**
- 그룹 등록: `XGROUP CREATE stream group-name 0`
- PEL(Pending Entry List): 읽었지만 XACK 안 된 메시지 목록
- `XREADGROUP GROUP group-name consumer-name COUNT 10 BLOCK 5000 STREAMS stream >`

**`>` 심볼 의미**: 미처리 새 메시지만 읽음. 읽으면 즉시 PEL에 등록됨

**XACK 의미**: PEL에서 해당 메시지 제거 = 처리 완료 선언  
→ XACK 전 장애 시 메시지는 PEL에 잔류 → 재시작 후 재수신 가능

**At-least-once 보장 메커니즘:**
```
XREADGROUP → PEL 등록 → 처리 → XACK → PEL 제거
                            ↑ 장애 발생
재시작 후 XAUTOCLAIM / XPENDING → PEL 재수신
```

**Consumer Group 수평 확장:**
- 같은 그룹에 여러 인스턴스 등록 → Redis가 메시지 자동 분배
- 중복 처리 없는 확장 (한 메시지는 한 Consumer에게만 할당)

### ✅ 완료 기준 (강의 이해 확인)
- [ ] PEL 개념 + XACK 전 장애 시 재처리 경로 설명 가능
- [ ] Consumer Group 분산 원리 설명 가능
- [ ] Pub/Sub 대비 Streams 선택 이유 설명 가능

---

## S7: Redis Streams CLI 실습과 At-least-once 재처리 시뮬레이션 (개요 10분 + 실습 50분)

### 개요 (10분)

XADD → PEL → XACK 흐름 재확인 / XACK 전 종료 시 재수신 경로 재확인

### 🔴 실습 (50분) — 수강생 직접 입력

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

### ✅ 완료 기준
- [ ] Streams 직접 조작 실습 완료
- [ ] 미ACK 재수신 원리 확인
- [ ] Consumer 2개 → 메시지 분배 확인

---

## S8: Webhook 보안 검증과 Consumer Group 기반 병렬 처리 (강의 15분 + 실습 40분)

### 강의

**HMAC-SHA256 서명 검증:**
- VASP가 전송하는 `X-Signature` 헤더 검증
- 서명 없는 요청은 즉시 401 거부
- 서명 계산: `HMAC-SHA256(webhookSecret, requestBody)`

**Private RPC Node 필요성:**
- 공용 RPC 장애 시 이벤트 수신 전면 중단
- 전용 노드 → 안정적 연결 보장

### 🔴 실습 (40분) — 수강생 직접 작성

**Step 1**: HMAC 서명 검증 로직 구현
```typescript
// dmz/packages/event-engine/src/webhook/WebhookReceiver.ts
// TODO: receiveWebhook에 HMAC 검증 추가

import * as crypto from 'crypto';

function verifySignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  // TODO: HMAC-SHA256으로 body 해시 계산
  // TODO: signature와 비교 (타이밍 공격 방지: crypto.timingSafeEqual 사용)
}

async receiveWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['x-signature'] as string;
  const body = JSON.stringify(req.body);

  // TODO: signature 없으면 401 반환
  // TODO: verifySignature 실패하면 401 반환
  // TODO: 검증 통과 시 202 반환 + Queue 비동기 적재
}
```

**Step 2**: QueueService — enqueue 구현
```typescript
// dmz/packages/event-engine/src/webhook/QueueService.ts
// TODO: enqueue(event) 구현
// - Redis Streams XADD 호출
// - Consumer Group 초기화 (없으면 생성)

export class QueueService {
  constructor(private readonly redis: Redis) {}

  async enqueue(event: unknown): Promise<void> {
    // TODO: XADD kyobo-events * eventData JSON.stringify(event)
  }

  async initConsumerGroup(): Promise<void> {
    // TODO: XGROUP CREATE (이미 존재하면 무시)
  }
}
```

**Step 3**: 서명 검증 테스트
```typescript
// test: 서명 없는 요청 → 401
// test: 잘못된 서명 → 401
// test: 올바른 서명 → 202
```

### ✅ 답안

```typescript
// verifySignature 완성
function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

// receiveWebhook 완성
async receiveWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['x-signature'] as string | undefined;

  if (!signature) {
    res.status(401).json({ error: 'Missing signature' });
    return;
  }

  const body = JSON.stringify(req.body);
  if (!verifySignature(body, signature, this.webhookSecret)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  res.status(202).json({ received: true });

  setImmediate(async () => {
    try {
      await this.queueService.enqueue(req.body);
    } catch (err) {
      console.error('[WebhookReceiver] enqueue 실패:', err);
    }
  });
}
```

```typescript
// QueueService.enqueue 완성
async enqueue(event: unknown): Promise<void> {
  await this.redis.xadd(
    'kyobo-events',
    '*',
    'eventData',
    JSON.stringify(event),
  );
}

async initConsumerGroup(): Promise<void> {
  try {
    await this.redis.xgroup('CREATE', 'kyobo-events', 'processing-group', '0', 'MKSTREAM');
  } catch (err: unknown) {
    if (!(err as Error).message.includes('BUSYGROUP')) throw err;
    // 이미 존재하는 그룹 → 무시
  }
}
```

### ✅ M2 전반부 완료 기준
- [ ] Webhook → 202 즉시 응답 (DB 없음)
- [ ] HMAC 서명 없는 요청 거부 (401)
- [ ] QueueService enqueue 동작
