/**
 * RedisStreamPublisher — 온체인 이벤트 → Redis Streams 발행
 *
 * M7 S37~S39 핵심 개념:
 *   1. 202 패턴: 체인 이벤트 수신 즉시 "accepted" 반환, Redis Stream에 비동기 발행
 *      → 처리 지연이 체인 구독 차단하지 않음
 *
 *   2. At-least-once 보장:
 *      - Redis XADD → messageId 반환
 *      - DB에 messageId + 상태 기록
 *      - Consumer 장애 후 재시작 시 미처리 메시지 자동 재전달 (PEL)
 *
 *   3. Consumer Group 구조:
 *      Stream: "kyobo:events"
 *      Group:  "issuer-consumers"
 *      Consumer: consumer-{N} (수평 확장)
 *
 * Redis Streams 내부 구조 (S38):
 *   messageId 형식: "{unix-ms}-{sequence}" (예: 1714000000000-0)
 *   XADD: append-only log (삭제 없음, MAXLEN으로 크기 제한)
 *   XREADGROUP: Consumer Group에서 읽기 + 소유권(PEL) 부여
 *   XACK: 처리 완료 → PEL에서 제거
 */

export interface StreamEvent {
  streamKey:  string;              // 예: "kyobo:events"
  eventType:  string;              // 예: "NFT_ISSUED", "NFT_BURNED"
  payload:    Record<string, unknown>;
  txHash:     string;
  blockNumber: number;
  requestId:  string;              // Idempotency key
}

export interface RedisStreamClient {
  xadd(key: string, fields: Record<string, string>): Promise<string>;
  xgroupCreate(key: string, group: string, id: string, mkstream: boolean): Promise<void>;
  ping(): Promise<string>;
}

/**
 * RedisStreamPublisher — ChainEventListener 이후 파이프라인 1단계
 *
 * 의존 방향:
 *   ChainEventListener → RedisStreamPublisher → Redis Streams
 *                                             ↓
 *                                    ConsumerGroupWorker
 */
export class RedisStreamPublisher {
  private readonly defaultStream = 'kyobo:events';

  constructor(
    private readonly redis: RedisStreamClient,
  ) {}

  /**
   * 스트림 + Consumer Group 초기화
   * 서비스 시작 시 한 번 호출 — 이미 존재하면 무시
   */
  async initialize(groupName = 'issuer-consumers'): Promise<void> {
    try {
      await this.redis.xgroupCreate(this.defaultStream, groupName, '$', true);
    } catch (err: unknown) {
      // BUSYGROUP = 이미 존재하는 그룹 → 정상
      if (!String(err).includes('BUSYGROUP')) throw err;
    }
  }

  /**
   * 온체인 이벤트 → Redis Streams 발행 (202 패턴)
   *
   * @returns messageId — DB에 기록하여 At-least-once 추적
   *
   * 필드 직렬화: Redis Streams는 string-string map만 지원
   *   → payload는 JSON 직렬화 후 저장
   */
  async publish(event: StreamEvent): Promise<string> {
    // TODO (M7 S38 실습): XADD 필드 구성 + 발행
    //   const messageId = await this.redis.xadd(event.streamKey ?? this.defaultStream, {
    //     eventType:   event.eventType,
    //     payload:     JSON.stringify(event.payload),
    //     txHash:      event.txHash,
    //     blockNumber: String(event.blockNumber),
    //     requestId:   event.requestId,
    //     publishedAt: String(Date.now()),
    //   });
    //   return messageId;

    const messageId = await this.redis.xadd(
      event.streamKey ?? this.defaultStream,
      {
        eventType:   event.eventType,
        payload:     JSON.stringify(event.payload),
        txHash:      event.txHash,
        blockNumber: String(event.blockNumber),
        requestId:   event.requestId,
        publishedAt: String(Date.now()),
      },
    );

    return messageId;
  }

  /** 헬스체크 */
  async ping(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }
}
