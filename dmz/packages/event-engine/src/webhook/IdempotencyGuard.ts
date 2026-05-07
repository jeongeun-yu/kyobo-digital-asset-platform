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
 *
 * ## Race Condition 방지 설계
 *
 * 기존 exists() → fn() → mark() 패턴은 TOCTOU(Time-Of-Check-Time-Of-Use) 문제가 있다.
 * exists()와 mark() 사이에 다른 비동기 호출이 끼어들면 두 코루틴 모두 exists()=false를
 * 받아 fn()을 중복 실행할 수 있다.
 *
 * 해결책: tryMark() — check와 mark를 하나의 원자적 연산으로 통합.
 *   - Redis: SET key NX EX (단일 명령어, 원자적)
 *   - DB: INSERT + unique constraint (중복 시 예외)
 *   - InMemory: Map.get/set은 동기 연산이므로 await 없이 원자적
 *
 * ── 교육생 안내 ──────────────────────────────────────────────────────────────
 * 역할: 참고용 구현체 — 수정하지 말 것
 * 실습: course/exercises/M2/S09_atleastonce.ts  ← IdempotencyGuard 연동 직접 구현
 *       course/exercises/M3/S16_idempotency.ts  ← requestId Idempotency 심화
 */
export interface IdempotencyStore {
  /**
   * 원자적 check-and-mark.
   * @returns true = 이 호출이 최초로 키를 선점함 (처리 진행)
   *          false = 이미 선점됨 (중복 → 스킵)
   */
  tryMark(key: string, ttlSeconds: number): Promise<boolean>;

  /**
   * fn() 실패 시 마킹 해제 — 다음 실행이 재처리할 수 있도록
   */
  unmark(key: string): Promise<void>;
}

export class IdempotencyGuard {
  constructor(
    private readonly store: IdempotencyStore,
    private readonly ttlSeconds: number = 86400 * 7,  // 7일 보관
  ) {}

  /**
   * 원자적으로 선점 후 fn 실행. fn 실패 시 선점 해제.
   * @returns true = 새로 처리됨 / false = 중복 → 스킵
   */
  async run(key: string, fn: () => Promise<void>): Promise<boolean> {
    // exists() → fn() → mark() 대신 tryMark() → fn() 으로 Race Condition 제거
    const claimed = await this.store.tryMark(key, this.ttlSeconds);
    if (!claimed) return false;  // 이미 처리 중이거나 완료된 키

    try {
      await fn();
      return true;
    } catch (err) {
      // fn() 실패 시 선점 해제 → RetryHandler 또는 재시작 시 재처리 가능
      await this.store.unmark(key);
      throw err;
    }
  }
}

/**
 * InMemoryIdempotencyStore — 개발·테스트용
 * 프로덕션에서는 RedisIdempotencyStore 또는 DBIdempotencyStore로 교체.
 *
 * Node.js는 단일 스레드이지만 async 경계(await)에서 다른 코루틴이 실행될 수 있다.
 * tryMark() 내부에 await가 없으므로 Map 조작은 동기적·원자적으로 처리된다.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, number>();

  async tryMark(key: string, ttlSeconds: number): Promise<boolean> {
    // await 없음 — Map.get / Map.set은 동기 연산 → 이 블록 전체가 원자적
    const exp = this.store.get(key);
    if (exp !== undefined && Date.now() <= exp) return false;  // 유효한 키 존재 → 중복
    this.store.set(key, Date.now() + ttlSeconds * 1000);
    return true;
  }

  async unmark(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * RedisIdempotencyStore — 프로덕션용 (참고 구현)
 *
 * SET key 1 NX EX ttl — 단일 Redis 명령어, 서버 수준 원자적 연산.
 * 다중 인스턴스(수평 확장) 환경에서도 Race Condition 없음.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: {
    set(key: string, value: string, mode: 'NX', flag: 'EX', ttl: number): Promise<string | null>;
    del(key: string): Promise<number>;
  }) {}

  async tryMark(key: string, ttlSeconds: number): Promise<boolean> {
    // SET key 1 NX EX ttlSeconds — 키가 없을 때만 SET, 없으면 null 반환
    const result = await this.redis.set(key, '1', 'NX', 'EX', ttlSeconds);
    return result === 'OK';  // OK = 최초 선점 성공 / null = 이미 존재 (중복)
  }

  async unmark(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
