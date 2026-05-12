/**
 * ConsumerGroupWorker — Redis Streams Consumer Group 처리 워커
 *
 * M2 S9~S12 핵심 개념:
 *
 *   At-least-once 처리 보장 흐름:
 *     1. XREADGROUP → messageId + 소유권(PEL) 취득
 *     2. 비즈니스 로직 처리 (원장 업데이트, 감사 로그)
 *     3. XACK → PEL에서 제거 = "처리 완료"
 *     Consumer 장애 → 재시작 후 XAUTOCLAIM으로 미처리 메시지 재수신
 *
 *   DLQ 정책 (S11):
 *     3회 실패 → DLQHandler.move() 호출 → Dead Letter Stream
 *     수동 재큐잉: DLQ 스트림 → 다시 kyobo:events XADD
 *
 *   수평 확장:
 *     Consumer 인스턴스 N개 → 같은 그룹, 각기 다른 consumerId
 *     Redis가 메시지 분배 (라운드 로빈 아님, 먼저 XREADGROUP 호출한 쪽이 소유)
 *
 * 의존 방향:
 *   ConsumerGroupWorker → LedgerService (원장 업데이트)
 *                       → AuditLogService (감사 로그)
 *                       → DLQHandler (실패 처리)
 *
 * ── 교육생 안내 ──────────────────────────────────────────────────────────────
 * 역할: 참고용 구현체 — 수정하지 말 것
 * 실습: course/exercises/M2/S09_atleastonce.ts   ← At-least-once 직접 구현
 *       course/exercises/M2/S11_dlq.ts            ← DLQ 이동 로직 구현
 *       course/exercises/M2/S12_e2e.ts            ← 전체 파이프라인 통합
 */

import type { DLQHandler, DLQItem } from './DLQHandler';
import { logger } from '../infra/logger';

/**
 * DeferredProcessingError — 처리 보류 신호
 *
 * EventProcessor.process()에서 throw → 워커가 XACK 없이 PEL에 잔류시킴.
 * retryCount는 증가하지 않음 (실패가 아니라 "아직 처리할 수 없음").
 *
 * 사용 사례: Finalized 블록 대기 (NFTIssuedProcessor)
 */
export class DeferredProcessingError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DeferredProcessingError';
  }
}

export interface StreamMessage {
  id:     string;  // Redis messageId: "{ms}-{seq}"
  fields: Record<string, string>;
}

export interface RedisConsumerClient {
  xreadgroup(
    group: string,
    consumer: string,
    streams: Array<{ key: string; id: string }>,
    count: number,
    blockMs: number,
  ): Promise<Array<{ key: string; messages: StreamMessage[] }>>;

  xack(key: string, group: string, ...ids: string[]): Promise<number>;

  xautoclaim(
    key: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    startId: string,
    count: number,
  ): Promise<{ nextId: string; messages: StreamMessage[] }>;
}

export interface EventProcessor {
  /** 처리 가능한 eventType 목록 */
  eventTypes: string[];
  /** 실제 처리 로직 — 멱등성 보장 필수 (At-least-once 환경) */
  process(message: StreamMessage): Promise<void>;
}

/**
 * ConsumerGroupWorker
 *
 * 실행 루프:
 *   while (running) {
 *     1. reclaimPending()  — idle > minIdleMs인 미처리 메시지 재수신
 *     2. processNew()      — 새 메시지 XREADGROUP (blockMs 대기)
 *   }
 */
export class ConsumerGroupWorker {
  private running = false;
  private readonly MAX_RETRIES = 3;

  constructor(
    private readonly redis:      RedisConsumerClient,
    private readonly processors: EventProcessor[],
    private readonly dlq:        DLQHandler,
    private readonly config: {
      streamKey:    string;   // "kyobo:events"
      groupName:    string;   // "issuer-consumers"
      consumerId:   string;   // "consumer-1", "consumer-2", ...
      batchSize:    number;   // XREADGROUP COUNT
      blockMs:      number;   // XREADGROUP BLOCK — 0=무한 대기
      minIdleMs:    number;   // XAUTOCLAIM 기준 idle 시간 (기본 30_000ms)
    },
  ) {}

  async start(): Promise<void> {
    this.running = true;

    while (this.running) {
      try {
        // 1. 미처리(PEL) 메시지 재수신 — Consumer 장애 복구
        await this._reclaimPending();

        // 2. 새 메시지 처리
        await this._processNew();
      } catch (err) {
        logger.error('consumer loop error', { error: (err as Error).message });
        await this._sleep(1000);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  // ── 새 메시지 처리 ──────────────────────────────────────────────────

  private async _processNew(): Promise<void> {
    const result = await this.redis.xreadgroup(
      this.config.groupName,
      this.config.consumerId,
      [{ key: this.config.streamKey, id: '>' }],
      this.config.batchSize,
      this.config.blockMs,
    );

    for (const { messages } of result ?? []) {
      for (const msg of messages) {
        await this._handleWithRetry(msg);
      }
    }
  }

  // ── PEL 재수신 (Consumer 장애 복구) ─────────────────────────────────

  private async _reclaimPending(): Promise<void> {
    const { messages } = await this.redis.xautoclaim(
      this.config.streamKey,
      this.config.groupName,
      this.config.consumerId,
      this.config.minIdleMs,
      '0-0',
      this.config.batchSize,
    );

    for (const msg of messages) {
      await this._handleWithRetry(msg);
    }
  }

  // ── 처리 + 재시도 ────────────────────────────────────────────────────

  private async _handleWithRetry(msg: StreamMessage): Promise<void> {
    const eventType  = msg.fields['eventType'] ?? '';
    const retryCount = parseInt(msg.fields['_retryCount'] ?? '0', 10);

    if (retryCount >= this.MAX_RETRIES) {
      // 3회 초과 → DLQ
      await this.dlq.move({
        messageId: msg.id,
        streamKey: this.config.streamKey,
        groupName: this.config.groupName,
        event:     msg.fields,
        reason:    `max retries (${this.MAX_RETRIES}) exceeded`,
        failedAt:  new Date(),
      });
      await this.redis.xack(this.config.streamKey, this.config.groupName, msg.id);
      return;
    }

    const processors = this.processors.filter(p => p.eventTypes.includes(eventType));

    if (processors.length === 0) {
      // 처리자 없음 → ACK (무시)
      await this.redis.xack(this.config.streamKey, this.config.groupName, msg.id);
      return;
    }

    try {
      await Promise.all(processors.map(p => p.process(msg)));
      // 성공 → ACK
      await this.redis.xack(this.config.streamKey, this.config.groupName, msg.id);
    } catch (err) {
      if (err instanceof DeferredProcessingError) {
        // 처리 보류 — XACK 없음, retryCount 증가 없음 → PEL 잔류 → 나중에 재수신
        logger.info('message deferred', { messageId: msg.id, reason: (err as Error).message });
        return;
      }
      // 실패 → 재시도 카운터 증가 (DLQ 조건 다음 루프에서 판단)
      // NOTE: Redis Streams는 자동 재시도 없음 — PEL에 남아있다가 _reclaimPending에서 재수신
      msg.fields['_retryCount'] = String(retryCount + 1);
      logger.warn('message processing failed', { messageId: msg.id, attempt: retryCount + 1, error: (err as Error).message });
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
