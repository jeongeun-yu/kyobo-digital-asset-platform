/**
 * IdempotencyGuard / InMemoryIdempotencyStore / RedisIdempotencyStore 단위 테스트
 */

import {
  IdempotencyGuard,
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
} from '../webhook/IdempotencyGuard';

// ── InMemoryIdempotencyStore ────────────────────────────────────────────────

describe('InMemoryIdempotencyStore', () => {
  it('최초 tryMark → true 반환', async () => {
    const store = new InMemoryIdempotencyStore();
    expect(await store.tryMark('key-1', 60)).toBe(true);
  });

  it('동일 키 재시도 → false 반환 (중복)', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.tryMark('key-1', 60);
    expect(await store.tryMark('key-1', 60)).toBe(false);
  });

  it('unmark 후 동일 키 → true 반환 (재처리 가능)', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.tryMark('key-1', 60);
    await store.unmark('key-1');
    expect(await store.tryMark('key-1', 60)).toBe(true);
  });

  it('TTL 만료된 키 → true 반환 (재처리 허용)', async () => {
    const store = new InMemoryIdempotencyStore();
    // TTL=0 → 즉시 만료
    await store.tryMark('key-exp', 0);
    // 1ms 후 재시도 — 만료 처리
    await new Promise(r => setTimeout(r, 5));
    expect(await store.tryMark('key-exp', 60)).toBe(true);
  });
});

// ── IdempotencyGuard ────────────────────────────────────────────────────────

describe('IdempotencyGuard', () => {
  it('최초 run → fn 실행 후 true 반환', async () => {
    const guard = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const fn    = jest.fn().mockResolvedValue(undefined);
    const result = await guard.run('key-1', fn);
    expect(result).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('중복 run → fn 미실행 + false 반환', async () => {
    const guard = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const fn    = jest.fn().mockResolvedValue(undefined);
    await guard.run('key-1', fn);
    const result = await guard.run('key-1', fn);
    expect(result).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fn() throw → unmark 후 에러 re-throw', async () => {
    const store = new InMemoryIdempotencyStore();
    const guard = new IdempotencyGuard(store);
    const fn    = jest.fn().mockRejectedValue(new Error('처리 실패'));

    await expect(guard.run('key-fail', fn)).rejects.toThrow('처리 실패');
    // unmark 됐으므로 재시도 가능 → true
    expect(await store.tryMark('key-fail', 60)).toBe(true);
  });

  it('fn() throw 후 재시도 → fn 다시 실행됨', async () => {
    const guard = new IdempotencyGuard(new InMemoryIdempotencyStore());
    const fn    = jest.fn()
      .mockRejectedValueOnce(new Error('일시 오류'))
      .mockResolvedValue(undefined);

    await expect(guard.run('key-retry', fn)).rejects.toThrow();
    const result = await guard.run('key-retry', fn); // 재시도
    expect(result).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── RedisIdempotencyStore ───────────────────────────────────────────────────

describe('RedisIdempotencyStore', () => {
  function makeRedis(setResult: string | null = 'OK') {
    return {
      set:  jest.fn().mockResolvedValue(setResult),
      del:  jest.fn().mockResolvedValue(1),
    };
  }

  it('Redis SET 결과 OK → true 반환 (최초 선점)', async () => {
    const store = new RedisIdempotencyStore(makeRedis('OK'));
    expect(await store.tryMark('key-1', 60)).toBe(true);
  });

  it('Redis SET 결과 null → false 반환 (중복)', async () => {
    const store = new RedisIdempotencyStore(makeRedis(null));
    expect(await store.tryMark('key-1', 60)).toBe(false);
  });

  it('tryMark 시 NX·EX 플래그로 SET 호출', async () => {
    const redis = makeRedis('OK');
    const store = new RedisIdempotencyStore(redis);
    await store.tryMark('my-key', 300);
    expect(redis.set).toHaveBeenCalledWith('my-key', '1', 'NX', 'EX', 300);
  });

  it('unmark → Redis DEL 호출', async () => {
    const redis = makeRedis();
    const store = new RedisIdempotencyStore(redis);
    await store.unmark('key-1');
    expect(redis.del).toHaveBeenCalledWith('key-1');
  });
});
