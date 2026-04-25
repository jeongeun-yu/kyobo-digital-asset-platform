/**
 * IdempotencyGuard — 동일 이벤트 중복 처리 방지
 *
 * 온체인 이벤트와 Webhook 양쪽에서 사용.
 * 키: txHash + logIndex (온체인) 또는 requestId (Webhook)
 *
 * 저장소: Phase 1 = Redis 또는 DB unique constraint
 *         Phase 2+: 분산 환경에서 Redis Cluster 또는 DB
 *
 * 이 가드 없이 RetryHandler를 쓰면 네트워크 오류 재시도 시 중복 발행 위험.
 */
export interface IdempotencyStore {
  exists(key: string): Promise<boolean>;
  mark(key: string, ttlSeconds: number): Promise<void>;
}

export class IdempotencyGuard {
  constructor(
    private readonly store: IdempotencyStore,
    private readonly ttlSeconds: number = 86400 * 7,  // 7일 보관
  ) {}

  /**
   * 처리 여부 확인 후 처리 함수 실행 (atomic)
   * @returns true = 새로 처리됨 / false = 이미 처리된 중복
   */
  async run(key: string, fn: () => Promise<void>): Promise<boolean> {
    if (await this.store.exists(key)) return false;
    await fn();
    await this.store.mark(key, this.ttlSeconds);
    return true;
  }
}

/**
 * InMemoryIdempotencyStore — 개발·테스트용
 * 프로덕션에서는 RedisIdempotencyStore 또는 DBIdempotencyStore로 교체
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, number>();

  async exists(key: string): Promise<boolean> {
    const exp = this.store.get(key);
    if (!exp) return false;
    if (Date.now() > exp) { this.store.delete(key); return false; }
    return true;
  }

  async mark(key: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, Date.now() + ttlSeconds * 1000);
  }
}
