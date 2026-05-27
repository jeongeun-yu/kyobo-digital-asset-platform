/**
 * S06 실습 — Redis Streams 전체 흐름
 *
 * 강의 노트: M2_S6_redis_streams_theory.md
 *
 * 실행 방법 (루트에서): npm run exercise:s06
 *
 * 사전 조건: 없음 (Mock Redis 사용 — 실제 Docker 불필요)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 배경
 * ──────────────────────────────────────────────────────────────────────────
 *
 * 교보생명 NFT 발행 시스템에서 블록체인 이벤트 처리 파이프라인은 다음과 같습니다:
 *
 *   [블록체인 노드]
 *       │  Transfer / Mint 이벤트 감지
 *       ▼
 *   [ChainEventListener]   ← 이벤트 구독 (WebSocket / Polling)
 *       │  202 패턴: 이벤트 수신 즉시 "accepted" 반환
 *       │  처리를 Redis Stream에 위임 → 체인 구독이 블로킹되지 않음
 *       ▼
 *   [Redis Streams: "kyobo:events"]   ← 이 실습의 핵심
 *       │  append-only 로그 — 메시지는 삭제되지 않음 (MAXLEN으로 크기만 제한)
 *       │  messageId 형식: "{unix-ms}-{sequence}"  예: "1714000000000-0"
 *       ▼
 *   [ConsumerGroupWorker]   ← Group: "issuer-consumers"
 *       │  XREADGROUP로 메시지 읽기 + PEL(Pending Entry List)에 소유권 등록
 *       │  처리 완료 → XACK → PEL에서 제거
 *       │  Consumer 장애 → 재시작 후 XAUTOCLAIM으로 PEL 메시지 재수신
 *       ▼
 *   [비즈니스 로직: 원장 업데이트, 감사 로그]
 *
 * ── At-least-once 보장이 왜 필요한가? ─────────────────────────────────────
 *
 *   NFT 발행 완료 후 "원장에 기록하지 못함" = 자산 분실 사고.
 *   Redis Streams의 PEL 구조가 이를 방지합니다:
 *
 *   1. XREADGROUP → messageId 취득 + PEL에 "처리 중" 등록
 *   2. 비즈니스 로직 실행
 *   3. 성공 → XACK → PEL 제거  ("처리 완료" 상태)
 *      실패 → XACK 없음 → PEL에 잔류 → 재시작/XAUTOCLAIM으로 재수신
 *
 *   이 구조 덕분에 Consumer가 도중에 죽어도 메시지는 유실되지 않습니다.
 *
 * ── Consumer Group 수평 확장 ────────────────────────────────────────────────
 *
 *   같은 Group에 Consumer를 여러 개 띄우면 Redis가 메시지를 분배합니다.
 *   예: consumer-1, consumer-2, consumer-3 → 각자 다른 메시지를 처리
 *   → 처리량을 수평으로 늘릴 수 있음 (Kubernetes HPA와 연계)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 이 실습에서 구현할 것
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   Part 1 — RedisStreamPublisher
 *     TODO 4: publisher.publish(event) 호출
 *             → XADD가 실행되어 messageId가 반환되는지 확인
 *
 *   Part 2 — ConsumerGroupWorker + EventProcessor
 *     TODO 1: SimpleNFTProcessor.eventTypes 구현
 *             → 어떤 이벤트 타입을 이 Processor가 처리할지 선언
 *     TODO 2: payload JSON 파싱
 *             → Redis는 string-string map만 저장하므로 payload는 JSON 직렬화됨
 *     TODO 3: 처리 결과 로그 출력
 *             → 실제 서비스에서는 원장 업데이트 / 감사 로그 호출로 교체
 *     TODO 5: ConsumerGroupWorker 인스턴스 생성
 *             → Processor, DLQ, 설정 값을 조립해서 워커를 만드는 연습
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 정상 실행 시 예상 출력 (순서대로)
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   === Part 1: RedisStreamPublisher ===
 *   [XGROUP CREATE] kyobo:events issuer-consumers $ MKSTREAM
 *   [XADD] kyobo:events { eventType: 'NFT_ISSUED', ... }
 *   [XADD] → messageId: 1714xxxxxx-0
 *   [result] messageId: 1714xxxxxx-0
 *   [check] 형식 확인: ✅ 정상
 *   [XADD] kyobo:events { eventType: 'NFT_BURNED', ... }
 *   [result] NFT_BURNED messageId: 1714xxxxxx-0
 *
 *   === Part 2: ConsumerGroupWorker ===
 *   [worker] 시작 — 3초 후 자동 종료
 *   [XREADGROUP] consumer-1 → 새 메시지 수신
 *   [SimpleNFTProcessor] NFT 처리 완료: tokenId=42, owner=0xKYOBO
 *   [XACK] 1714xxxxxx-0 → PEL 제거 ✅
 *   [worker] stop() 호출
 *   [worker] 종료 완료
 */

// ────────────────────────────────────────────────────────────────────────
// Type Definitions
// ────────────────────────────────────────────────────────────────────────
interface StreamEvent {
  streamKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  txHash: string;
  blockNumber: number;
  requestId: string;
}

interface StreamMessage {
  id: string;
  fields: Record<string, string>;
}

interface EventProcessor {
  readonly eventTypes: string[];
  process(message: StreamMessage): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────
// Part 1 — RedisStreamPublisher
// ────────────────────────────────────────────────────────────────────────

// ── Mock Redis (Publisher용) — 수정하지 않아도 됨 ────────────────────────
// 실제 ioredis 클라이언트 대신 console.log로 동작을 시각화합니다.
const publisherRedis = {
  async xadd(key: string, fields: Record<string, string>): Promise<string> {
    const messageId = `${Date.now()}-0`;
    console.log(`[XADD] ${key}`, fields);
    console.log(`[XADD] → messageId: ${messageId}`);
    return messageId;
  },
  async xgroupCreate(key: string, group: string, id: string, mkstream: boolean): Promise<void> {
    console.log(`[XGROUP CREATE] ${key} ${group} ${id}${mkstream ? ' MKSTREAM' : ''}`);
  },
  async ping(): Promise<string> {
    return 'PONG';
  },
};

// ────────────────────────────────────────────────────────────────────────
// RedisStreamPublisher Class
// ────────────────────────────────────────────────────────────────────────
class RedisStreamPublisher {
  constructor(private redis: any) {}
  
  async initialize(): Promise<void> {
    await this.redis.xgroupCreate('kyobo:events', 'issuer-consumers', '$', true).catch(() => {});
  }
  
  async publish(event: StreamEvent): Promise<string> {
    const fields: Record<string, string> = {
      eventType: event.eventType,
      payload: JSON.stringify(event.payload),
      txHash: event.txHash,
      blockNumber: String(event.blockNumber),
      requestId: event.requestId,
      publishedAt: String(Date.now()),
      _retryCount: '0',
    };
    return this.redis.xadd(event.streamKey, fields);
  }
}

// ────────────────────────────────────────────────────────────────────────
// DLQHandler Class
// ────────────────────────────────────────────────────────────────────────
class DLQHandler {
  constructor(private redis: any, private alertService: any) {}
}

// ────────────────────────────────────────────────────────────────────────
// ConsumerGroupWorker Class
// ────────────────────────────────────────────────────────────────────────
class ConsumerGroupWorker {
  private running = false;
  
  constructor(
    private redis: any,
    private processors: EventProcessor[],
    private dlq: DLQHandler,
    private config: {
      streamKey: string;
      groupName: string;
      consumerId: string;
      batchSize: number;
      blockMs: number;
      minIdleMs: number;
    },
  ) {}
  
  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      const result = await this.redis.xreadgroup(
        this.config.groupName,
        this.config.consumerId,
        [{ key: this.config.streamKey, id: '>' }],
        this.config.batchSize,
        this.config.blockMs,
      );
      
      if (result && result.length > 0) {
        for (const stream of result) {
          for (const message of stream.messages) {
            for (const processor of this.processors) {
              if (processor.eventTypes.includes(message.fields['eventType'])) {
                try {
                  await processor.process(message);
                  await this.redis.xack(this.config.streamKey, this.config.groupName, message.id);
                } catch (error) {
                  console.error('[ConsumerGroupWorker] 처리 실패:', error);
                }
              }
            }
          }
        }
      }
    }
  }
  
  stop(): void {
    this.running = false;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Part 2 — ConsumerGroupWorker
// ────────────────────────────────────────────────────────────────────────

// ── Mock DLQ — 수정하지 않아도 됨 ─────────────────────────────────────
// 3회 이상 실패한 메시지는 여기로 이동됩니다 (S11에서 상세 학습)
const mockDLQ = new DLQHandler(
  {
    async xadd(key: string, fields: Record<string, string>) {
      console.log(`[DLQ XADD] ${key}`, fields);
      return `${Date.now()}-0`;
    },
    async xrange() { return []; },
    async xdel()   { return 0; },
  },
  { async sendAlert(msg: string) { console.log('[DLQ ALERT]', msg); } },
);

// ── Mock Redis (Consumer용) — 수정하지 않아도 됨 ──────────────────────
// 실제 동작을 모방:
//   - 첫 번째 XREADGROUP 호출 → NFT_ISSUED 메시지 1개 반환
//   - 이후 호출 → 500ms 대기 후 빈 배열 반환 (블록킹 폴링 시뮬레이션)
let consumerCallCount = 0;
const consumerRedis = {
  async xreadgroup(
    group: string, consumer: string,
    streams: Array<{ key: string; id: string }>,
    count: number, blockMs: number,
  ) {
    consumerCallCount++;
    if (consumerCallCount === 1) {
      console.log(`[XREADGROUP] ${consumer} → 새 메시지 수신`);
      return [{
        key: 'kyobo:events',
        messages: [{
          id:     `${Date.now()}-0`,
          fields: {
            eventType:   'NFT_ISSUED',
            // payload는 JSON 직렬화된 문자열 — Redis Streams는 string-string map만 지원
            payload:     JSON.stringify({ tokenId: '42', owner: '0x4b594f424f000000000000000000000000000000' }),
            txHash:      '0xdeadbeef001deadbeef001deadbeef001deadbeef001deadbeef001deadbeef0',
            blockNumber: '18500001',
            requestId:   'req-001',
            publishedAt: String(Date.now()),
            _retryCount: '0',
          },
        }],
      }];
    }
    await new Promise(r => setTimeout(r, 500));
    return [];
  },
  async xack(key: string, group: string, ...ids: string[]) {
    console.log(`[XACK] ${ids.join(', ')} → PEL 제거 ✅`);
    return ids.length;
  },
  async xautoclaim(
    key: string, group: string, consumer: string,
    minIdleMs: number, startId: string, count: number,
  ) {
    // 이 실습에서는 재수신할 PEL 메시지 없음
    return { nextId: '0-0', messages: [] };
  },
};

// ── 실습 1·2·3: SimpleNFTProcessor 클래스를 완성하라 ──────────────────────
//
// EventProcessor 인터페이스 (ConsumerGroupWorker.ts 참고):
//   eventTypes: string[]         — 이 Processor가 처리하는 이벤트 타입 목록
//   process(msg): Promise<void>  — 실제 처리 로직 (멱등성 보장 필수)
//
// ConsumerGroupWorker는 XREADGROUP으로 메시지를 받은 후
// msg.fields['eventType']이 eventTypes 목록에 포함된 Processor를 찾아 process()를 호출합니다.
// process()가 정상 반환되면 XACK를 호출해 PEL에서 해당 메시지를 제거합니다.
//
// TODO 1: readonly eventTypes에 'NFT_ISSUED'를 등록하세요.
//         → 이 값이 비어 있으면 Worker가 NFT_ISSUED 메시지를 처리할 Processor를
//           찾지 못해 XACK만 하고 넘어갑니다 (SimpleNFTProcessor 호출 안 됨).
//
// TODO 2: message.fields['payload']를 JSON.parse해서 payload 객체를 꺼내세요.
//         → Redis Streams는 string만 저장하므로 publish 시 JSON.stringify한 값이
//           그대로 들어있습니다. 역직렬화해야 tokenId, owner를 꺼낼 수 있습니다.
//         힌트: JSON.parse(message.fields['payload'] ?? '{}')
//
// TODO 3: 아래 형식으로 처리 결과를 출력하세요.
//         '[SimpleNFTProcessor] NFT 처리 완료: tokenId=42, owner=0xKYOBO'
//         → 실제 서비스에서는 이 자리에 원장 업데이트(LedgerService.record())
//           또는 감사 로그 기록(AuditLogService.log())을 호출합니다.
class SimpleNFTProcessor implements EventProcessor {
  // TODO 1: readonly eventTypes = ['NFT_ISSUED'];
  readonly eventTypes: string[] = ['NFT_ISSUED'];

  async process(message: StreamMessage): Promise<void> {
    // TODO 2: const payload = JSON.parse(message.fields['payload'] ?? '{}');
    const payload = JSON.parse(message.fields['payload'] ?? '{}');
    // TODO 3: console.log(`[SimpleNFTProcessor] NFT 처리 완료: tokenId=${payload.tokenId}, owner=${payload.owner}`);
    console.log(`[SimpleNFTProcessor] NFT 처리 완료: tokenId=${payload.tokenId}, owner=${payload.owner}`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실행
// ────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== Part 1: RedisStreamPublisher ===\n');

  const publisher = new RedisStreamPublisher(publisherRedis);

  // initialize()는 XGROUP CREATE를 실행합니다.
  // 두 번째 호출 시 Redis는 'BUSYGROUP' 에러를 반환하지만
  // RedisStreamPublisher는 이를 무시합니다 — 서비스 재시작 시 안전한 이유입니다.
  await publisher.initialize();
  await publisher.initialize(); // 두 번째 호출 → BUSYGROUP 무시 확인

  const event: StreamEvent = {
    streamKey:   'kyobo:events',
    eventType:   'NFT_ISSUED',
    payload:     { tokenId: '42', owner: '0x4b594f424f000000000000000000000000000000' },
    txHash:      '0xdeadbeef001deadbeef001deadbeef001deadbeef001deadbeef001deadbeef0',
    blockNumber: 18500001,
    requestId:   'req-001',
  };

  // TODO 4: publisher.publish(event)를 호출해서 messageId를 받아오세요.
  //         publish()는 내부적으로 XADD를 실행하고 Redis가 부여한 messageId를 반환합니다.
  //         반환된 messageId는 DB에 기록해 At-least-once 추적에 사용됩니다.
  //         힌트: const messageId = await publisher.publish(event);
  //
  //         정상 실행 시:
  //           [XADD] kyobo:events { eventType: 'NFT_ISSUED', ... }
  //           [XADD] → messageId: 1714xxxxxx-0
  //           [check] 형식 확인: ✅ 정상
  const messageId = await publisher.publish(event);
  console.log('[result] messageId:', messageId);
  console.log('[check] 형식 확인:', /^\d+-\d+$/.test(messageId) ? '✅ 정상' : '❌ 오류');

  const burned: StreamEvent = {
    streamKey:   'kyobo:events',
    eventType:   'NFT_BURNED',
    payload:     { tokenId: '41', owner: '0x0000' },
    txHash:      '0xcafebabe001cafebabe001cafebabe001cafebabe001cafebabe001cafebabe0',
    blockNumber: 18500002,
    requestId:   'req-002',
  };
  const burnedId = await publisher.publish(burned);
  console.log('[result] NFT_BURNED messageId:', burnedId);

  console.log('\n=== Part 2: ConsumerGroupWorker ===\n');
  console.log('[worker] 시작 — 3초 후 자동 종료');

  // TODO 5: ConsumerGroupWorker 인스턴스를 생성하세요.
  //         생성자 인수:
  //           1. consumerRedis  — Redis 클라이언트 (XREADGROUP, XACK, XAUTOCLAIM 구현체)
  //           2. [new SimpleNFTProcessor()]  — 이벤트 타입별 처리기 배열
  //              여러 Processor를 등록하면 eventType에 맞는 것만 실행됩니다.
  //           3. mockDLQ  — 3회 실패 시 메시지를 이동시킬 DLQ 핸들러
  //           4. config 객체:
  //              streamKey:  'kyobo:events'    — 구독할 스트림 이름
  //              groupName:  'issuer-consumers' — Consumer Group 이름
  //              consumerId: 'consumer-1'       — 이 워커의 고유 ID (수평 확장 시 각자 다른 값)
  //              batchSize:  10                 — XREADGROUP COUNT (한 번에 읽을 최대 메시지 수)
  //              blockMs:    500                — XREADGROUP BLOCK (새 메시지 없으면 최대 500ms 대기)
  //              minIdleMs:  30_000             — XAUTOCLAIM 기준: 30초 이상 ACK 없는 메시지를 재수신
  //
  //         힌트:
  //           const worker = new ConsumerGroupWorker(
  //             consumerRedis, [new SimpleNFTProcessor()], mockDLQ,
  //             { streamKey: 'kyobo:events', groupName: 'issuer-consumers',
  //               consumerId: 'consumer-1', batchSize: 10, blockMs: 500, minIdleMs: 30_000 },
  //           );
  const worker = new ConsumerGroupWorker(
    consumerRedis, [new SimpleNFTProcessor()], mockDLQ,
    { streamKey: 'kyobo:events', groupName: 'issuer-consumers',
      consumerId: 'consumer-1', batchSize: 10, blockMs: 500, minIdleMs: 30_000 },
  );

  setTimeout(() => {
    console.log('[worker] stop() 호출');
    worker.stop();
  }, 3000);

  await worker.start();
  console.log('[worker] 종료 완료');
})();
