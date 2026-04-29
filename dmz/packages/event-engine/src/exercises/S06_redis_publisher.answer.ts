/**
 * S06 답안 — RedisStreamPublisher 기동 및 이벤트 발행
 * 강의 노트: M2_S6_redis_streams_theory.md
 */

import { RedisStreamPublisher, type StreamEvent } from '../dmz/RedisStreamPublisher';

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
  // TODO 1 답안
  const publisher = new RedisStreamPublisher(mockRedis);

  // TODO 2 답안
  await publisher.initialize();
  await publisher.initialize(); // 두 번째 호출 → BUSYGROUP 무시 확인

  // TODO 3 답안
  const event: StreamEvent = {
    streamKey:   'kyobo:events',
    eventType:   'NFT_ISSUED',
    payload:     { tokenId: '42', owner: '0xKYOBO' },
    txHash:      '0xdeadbeef001',
    blockNumber: 18500001,
    requestId:   'req-001',
  };

  const messageId = await publisher.publish(event);

  // TODO 4 답안
  console.log('[result] messageId:', messageId);
  console.log('[check] 형식 확인:', /^\d+-\d+$/.test(messageId) ? '✅ 정상' : '❌ 오류');

  // TODO 5 답안
  const burned: StreamEvent = {
    streamKey:   'kyobo:events',
    eventType:   'NFT_BURNED',
    payload:     { tokenId: '41', owner: '0x0000' },
    txHash:      '0xcafebabe001',
    blockNumber: 18500002,
    requestId:   'req-002',
  };
  const burnedId = await publisher.publish(burned);
  console.log('[result] NFT_BURNED messageId:', burnedId);
})();
