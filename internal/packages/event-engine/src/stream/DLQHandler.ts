/**
 * DLQHandler — Dead Letter Queue 처리
 *
 * M2 S11 핵심 개념:
 *   3회 실패 메시지 → Dead Letter Stream 이동
 *   운영자 알림 → 수동 확인 → 수동 재큐잉 절차
 *
 * DLQ 설계 원칙:
 *   - DLQ에 빠진 메시지 = 자동 처리 불가 → 반드시 사람이 확인
 *   - 재큐잉: DLQ 스트림 조회 → 원인 파악 → 수동 XADD to kyobo:events
 *   - 같은 메시지가 DLQ에 2회 이상 → 비즈니스 로직 버그 가능성, 즉시 알림
 *
 * DLQ 스트림 키: "kyobo:events:dlq"
 */

import { logger } from '../infra/logger';

export interface DLQItem {
  messageId: string;    // 원본 Redis messageId
  streamKey: string;    // 원본 스트림 키
  groupName: string;    // Consumer Group 이름
  event:     Record<string, string>;  // 원본 이벤트 필드
  reason:    string;    // 실패 원인
  failedAt:  Date;
}

export interface DLQRedisClient {
  xadd(key: string, fields: Record<string, string>): Promise<string>;
  xrange(key: string, start: string, end: string, count?: number): Promise<Array<{
    id: string;
    fields: Record<string, string>;
  }>>;
  xdel(key: string, ...ids: string[]): Promise<number>;
}

export interface DLQNotifier {
  sendAlert(message: string): Promise<void>;
}

/**
 * DLQHandler
 *
 * ConsumerGroupWorker에서 MAX_RETRIES 초과 시 move() 호출.
 * 운영자는 listPending() 으로 DLQ 항목 확인 후 requeueMessage() 로 재처리.
 */
export class DLQHandler {
  private readonly dlqStreamKey: string;

  constructor(
    private readonly redis:    DLQRedisClient,
    private readonly notifier: DLQNotifier,
    sourceStreamKey = 'kyobo:events',
  ) {
    this.dlqStreamKey = `${sourceStreamKey}:dlq`;
  }

  /**
   * 실패 메시지 → DLQ 스트림 이동 + 운영 알림
   *
   * @param item 실패 메시지 정보
   * @returns DLQ messageId
   */
  async move(item: DLQItem): Promise<string> {
    const dlqMessageId = await this.redis.xadd(this.dlqStreamKey, {
      ...item.event,
      _originalMessageId: item.messageId,
      _originalStream:    item.streamKey,
      _groupName:         item.groupName,
      _reason:            item.reason,
      _failedAt:          item.failedAt.toISOString(),
    });

    // 운영 알림 (비동기 — 알림 실패가 DLQ 이동을 차단하면 안 됨)
    this.notifier.sendAlert(
      `[DLQ] 메시지 처리 실패\n` +
      `- 원본 ID: ${item.messageId}\n` +
      `- 이벤트: ${item.event['eventType'] ?? 'unknown'}\n` +
      `- 원인: ${item.reason}\n` +
      `- DLQ ID: ${dlqMessageId}`
    ).catch(err => logger.error('DLQ alert failed', { error: (err as Error).message }));

    return dlqMessageId;
  }

  /**
   * DLQ 대기 항목 조회
   * @param count 최대 조회 건수 (기본 100)
   */
  async listPending(count = 100): Promise<DLQItem[]> {
    const entries = await this.redis.xrange(this.dlqStreamKey, '-', '+', count);

    return entries.map(entry => ({
      messageId: entry.id,  // DLQ 스트림 entry ID — requeueMessage 조회에 사용
      streamKey: entry.fields['_originalStream']    ?? '',
      groupName: entry.fields['_groupName']         ?? '',
      event:     entry.fields,
      reason:    entry.fields['_reason']            ?? '',
      failedAt:  new Date(entry.fields['_failedAt'] ?? Date.now()),
    }));
  }

  /**
   * DLQ 메시지 재큐잉 — 원본 스트림에 다시 발행
   *
   * 운영 절차:
   *   1. listPending()으로 항목 확인
   *   2. 원인 파악 (코드 버그 수정 또는 데이터 정정)
   *   3. requeueMessage()로 재처리 요청
   *   4. DLQ 항목 삭제
   *
   * @param dlqMessageId DLQ 스트림의 messageId
   * @param targetStreamKey 재발행할 스트림 (기본: 원본 스트림)
   */
  async requeueMessage(
    dlqMessageId: string,
    targetStreamKey?: string,
  ): Promise<{ newMessageId: string }> {
    const [entry] = await this.redis.xrange(
      this.dlqStreamKey,
      dlqMessageId,
      dlqMessageId,
      1,
    );

    if (!entry) throw new DLQMessageNotFoundError(dlqMessageId);

    const targetKey = targetStreamKey ?? entry.fields['_originalStream'] ?? 'kyobo:events';

    // DLQ 메타 필드 제거 후 원본 이벤트 필드만 재발행
    const requeueFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.fields)) {
      if (!k.startsWith('_')) requeueFields[k] = v;
    }
    requeueFields['_requeuedFrom']     = dlqMessageId;
    requeueFields['_requeuedAt']       = new Date().toISOString();

    const newMessageId = await this.redis.xadd(targetKey, requeueFields);

    // DLQ에서 제거
    await this.redis.xdel(this.dlqStreamKey, dlqMessageId);

    return { newMessageId };
  }
}

export class DLQMessageNotFoundError extends Error {
  constructor(id: string) {
    super(`DLQ message not found: ${id}`);
    this.name = 'DLQMessageNotFoundError';
  }
}
