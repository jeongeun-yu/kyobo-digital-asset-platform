import { DLQHandler, DLQMessageNotFoundError } from '../stream/DLQHandler';

// ── Mock 헬퍼 ──────────────────────────────────────────────────────────────
function makeDLQRedis() {
  // 키별로 스토어를 분리 — requeueMessage()가 원본 스트림에 XADD해도 DLQ 조회에 영향 없음
  const storeByKey = new Map<string, Array<{ id: string; fields: Record<string, string> }>>();

  function storeFor(key: string) {
    if (!storeByKey.has(key)) storeByKey.set(key, []);
    return storeByKey.get(key)!;
  }

  return {
    // store: 테스트 검증용 — 전체 키 flat 합산 (삽입 순서 유지)
    get store() { return [...storeByKey.values()].flat(); },
    async xadd(key: string, fields: Record<string, string>): Promise<string> {
      const s = storeFor(key);
      const id = `${Date.now()}-${s.length}`;
      s.push({ id, fields });
      return id;
    },
    async xrange(key: string, start: string, end: string, count?: number) {
      const s = storeFor(key);
      if (start !== '-' && start === end) return s.filter(i => i.id === start);
      return s.slice(0, count ?? s.length);
    },
    async xdel(key: string, ...ids: string[]): Promise<number> {
      const s = storeFor(key);
      let removed = 0;
      for (const id of ids) {
        const idx = s.findIndex(i => i.id === id);
        if (idx !== -1) { s.splice(idx, 1); removed++; }
      }
      return removed;
    },
  };
}

function makeNotifier() {
  const alerts: string[] = [];
  return {
    alerts,
    async sendAlert(msg: string) { alerts.push(msg); },
  };
}

const BASE_ITEM = {
  messageId: '1714000000000-0',
  streamKey: 'kyobo:events',
  groupName: 'issuer-consumers',
  event:     { eventType: 'NFT_BURNED', payload: '{}', requestId: 'req-dlq-001' },
  reason:    'max retries (3) exceeded',
  failedAt:  new Date('2024-04-25T10:00:00Z'),
};

// ── 채점 테스트 ────────────────────────────────────────────────────────────
describe('DLQHandler', () => {
  describe('move()', () => {
    it('DLQ 스트림에 XADD한다', async () => {
      const redis = makeDLQRedis();
      const dlq = new DLQHandler(redis, makeNotifier());
      await dlq.move(BASE_ITEM);
      expect(redis.store).toHaveLength(1);
    });

    it('원본 이벤트 필드를 포함한다', async () => {
      const redis = makeDLQRedis();
      const dlq = new DLQHandler(redis, makeNotifier());
      await dlq.move(BASE_ITEM);
      expect(redis.store[0]!.fields['eventType']).toBe('NFT_BURNED');
      expect(redis.store[0]!.fields['requestId']).toBe('req-dlq-001');
    });

    it('메타 필드 _originalMessageId, _reason, _failedAt을 포함한다', async () => {
      const redis = makeDLQRedis();
      const dlq = new DLQHandler(redis, makeNotifier());
      await dlq.move(BASE_ITEM);
      const fields = redis.store[0]!.fields;
      expect(fields['_originalMessageId']).toBe('1714000000000-0');
      expect(fields['_reason']).toBe('max retries (3) exceeded');
      expect(fields['_failedAt']).toBeTruthy();
    });

    it('알림을 전송한다 (비동기 — 알림 실패가 move를 차단하면 안 됨)', async () => {
      const redis = makeDLQRedis();
      const notifier = makeNotifier();
      const dlq = new DLQHandler(redis, notifier);
      await dlq.move(BASE_ITEM);
      await new Promise(r => setTimeout(r, 10));  // 비동기 alert 대기
      expect(notifier.alerts.length).toBeGreaterThanOrEqual(1);
    });

    it('알림 서비스가 throw해도 move() 자체는 성공한다', async () => {
      const redis = makeDLQRedis();
      const dlq = new DLQHandler(redis, { async sendAlert() { throw new Error('Slack down'); } });
      await expect(dlq.move(BASE_ITEM)).resolves.toBeTruthy();
    });
  });

  describe('listPending()', () => {
    it('move() 후 listPending()에 1개 항목이 있다', async () => {
      const redis = makeDLQRedis();
      const dlq = new DLQHandler(redis, makeNotifier());
      await dlq.move(BASE_ITEM);
      const items = await dlq.listPending();
      expect(items).toHaveLength(1);
    });

    it('반환 항목에 reason, failedAt, messageId가 포함된다', async () => {
      const redis = makeDLQRedis();
      const dlq = new DLQHandler(redis, makeNotifier());
      await dlq.move(BASE_ITEM);
      const [item] = await dlq.listPending();
      expect(item!.reason).toBe('max retries (3) exceeded');
      expect(item!.messageId).toBe(redis.store[0]!.id); // DLQ 스트림 entry ID
      expect(item!.failedAt).toBeInstanceOf(Date);
    });
  });

  describe('requeueMessage()', () => {
    it('원본 스트림에 재발행하고 DLQ에서 제거한다', async () => {
      const redis = makeDLQRedis();
      const dlq = new DLQHandler(redis, makeNotifier());
      await dlq.move(BASE_ITEM);
      const [item] = await dlq.listPending();
      const dlqId = redis.store[0]!.id;

      const { newMessageId } = await dlq.requeueMessage(dlqId);

      expect(newMessageId).toBeTruthy();
      // DLQ에서 제거됨
      const remaining = await dlq.listPending();
      expect(remaining).toHaveLength(0);
    });

    it('재발행된 필드에 _로 시작하는 DLQ 메타 필드가 없다', async () => {
      const redis = makeDLQRedis();
      const dlq = new DLQHandler(redis, makeNotifier());
      await dlq.move(BASE_ITEM);
      const dlqId = redis.store[0]!.id;
      await dlq.requeueMessage(dlqId);

      // store에 새 항목(재큐잉된 것) 확인 — _originalMessageId 없어야 함
      const requeuedEntry = redis.store[redis.store.length - 1]!;
      const metaKeys = Object.keys(requeuedEntry.fields).filter(k => k.startsWith('_') && k !== '_requeuedFrom' && k !== '_requeuedAt');
      expect(metaKeys).toHaveLength(0);
    });

    it('존재하지 않는 dlqMessageId → DLQMessageNotFoundError', async () => {
      const redis = makeDLQRedis();
      const dlq = new DLQHandler(redis, makeNotifier());
      await expect(dlq.requeueMessage('9999999999999-0'))
        .rejects.toThrow(DLQMessageNotFoundError);
    });
  });
});
