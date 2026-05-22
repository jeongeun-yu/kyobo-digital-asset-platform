/**
 * IoRedisAdapter — ioredis → event-engine 인터페이스 어댑터
 *
 * RedisConsumerClient + DLQRedisClient 두 인터페이스를 모두 구현.
 * ConsumerGroupWorker / DLQHandler 에 주입하여 사용한다.
 *
 * ── 교육생 안내 ──────────────────────────────────────────────────────────────
 * 역할: 참고용 구현체 — 수정하지 말 것
 * 관련 모듈: M5 S30 (IoRedisAdapter · ioredis → event-engine 어댑터)
 */

import type Redis from 'ioredis';
import type { RedisConsumerClient, StreamMessage } from '@kyobo/event-engine';
import type { DLQRedisClient } from '@kyobo/event-engine';

function parseFields(raw: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i];
    const val = raw[i + 1];
    if (key !== undefined && val !== undefined) out[key] = val;
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRedis = any;

export class IoRedisAdapter implements RedisConsumerClient, DLQRedisClient {
  constructor(private readonly r: Redis) {}

  // ── RedisConsumerClient ───────────────────────────────────────────────────

  async xreadgroup(
    group: string,
    consumer: string,
    streams: Array<{ key: string; id: string }>,
    count: number,
    blockMs: number,
  ): Promise<Array<{ key: string; messages: StreamMessage[] }>> {
    const raw = await (this.r as AnyRedis).xreadgroup(
      'GROUP', group, consumer,
      'COUNT', String(count),
      'BLOCK', String(blockMs),
      'STREAMS',
      ...streams.map(s => s.key),
      ...streams.map(s => s.id),
    ) as Array<[string, Array<[string, string[]]>]> | null;

    if (!raw) return [];
    return raw.map(([key, msgs]) => ({
      key,
      messages: msgs.map(([id, fields]) => ({ id, fields: parseFields(fields) })),
    }));
  }

  async xack(key: string, group: string, ...ids: string[]): Promise<number> {
    return this.r.xack(key, group, ...ids);
  }

  async xautoclaim(
    key: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    startId: string,
    count: number,
  ): Promise<{ nextId: string; messages: StreamMessage[] }> {
    const [nextId, msgs] = await (this.r as AnyRedis).xautoclaim(
      key, group, consumer, String(minIdleMs), startId, 'COUNT', String(count),
    ) as [string, Array<[string, string[]]>];

    return {
      nextId,
      messages: msgs.map(([id, fields]) => ({ id, fields: parseFields(fields) })),
    };
  }

  // ── DLQRedisClient ────────────────────────────────────────────────────────

  async xadd(key: string, fields: Record<string, string>): Promise<string> {
    const flat = Object.entries(fields).flat();
    return (this.r as AnyRedis).xadd(key, '*', ...flat) as Promise<string>;
  }

  async xrange(
    key: string,
    start: string,
    end: string,
    count?: number,
  ): Promise<Array<{ id: string; fields: Record<string, string> }>> {
    const args = count != null
      ? [key, start, end, 'COUNT', String(count)]
      : [key, start, end];
    const raw = await (this.r as AnyRedis).xrange(...args) as Array<[string, string[]]>;
    return raw.map(([id, fields]) => ({ id, fields: parseFields(fields) }));
  }

  async xdel(key: string, ...ids: string[]): Promise<number> {
    return this.r.xdel(key, ...ids);
  }
}
