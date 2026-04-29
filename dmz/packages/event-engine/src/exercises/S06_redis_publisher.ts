/**
 * S06 실습 — RedisStreamPublisher 기동 및 이벤트 발행
 *
 * 강의 노트: M2_S6_redis_streams_theory.md
 *
 * 실행 방법 (dmz/packages/event-engine 폴더에서):
 *   npx ts-node src/exercises/S06_redis_publisher.ts
 *
 * 사전 조건: 없음 (Mock Redis 사용 — 실제 Docker 불필요)
 */

import { RedisStreamPublisher, type StreamEvent } from '../dmz/RedisStreamPublisher';

// ── Mock Redis 클라이언트 (실제 ioredis 없이 흐름만 확인) ──────────────
const mockRedis = {
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

(async () => {
  // TODO 1: RedisStreamPublisher 인스턴스를 생성하라 (mockRedis 주입)
  const publisher: RedisStreamPublisher = /* TODO */ null as any;

  // TODO 2: initialize()를 호출하라
  //         → [XGROUP CREATE] 로그 출력되는지 확인
  //         → 두 번 호출해도 에러 없는지 확인 (BUSYGROUP 처리)
  await /* TODO */ Promise.resolve();

  // TODO 3: 아래 이벤트를 publish()로 발행하라
  const event: StreamEvent = {
    streamKey:   'kyobo:events',
    eventType:   'NFT_ISSUED',
    payload:     { tokenId: '42', owner: '0xKYOBO' },
    txHash:      '0xdeadbeef001',
    blockNumber: 18500001,
    requestId:   'req-001',
  };

  const messageId: string = /* TODO */ '';

  // TODO 4: messageId 형식이 "{timestamp}-0" 인지 확인하라
  console.log('[result] messageId:', messageId);
  console.log('[check] 형식 확인:', /^\d+-\d+$/.test(messageId) ? '✅ 정상' : '❌ 오류');

  // TODO 5 (선택): NFT_BURNED 이벤트도 발행해보라
})();
