/**
 * CircuitBreaker 단위 테스트
 *
 * CLOSED/OPEN/HALF_OPEN 상태 전이, CircuitOpenError, 복구 흐름 검증
 */

import { CircuitBreaker, CircuitOpenError } from '../adapters/CircuitBreaker';

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

async function failN(cb: CircuitBreaker, n: number) {
  for (let i = 0; i < n; i++) {
    await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
  }
}

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('CircuitBreaker — CLOSED 상태', () => {
  it('초기 상태는 CLOSED', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });
    expect(cb.getState()).toBe('CLOSED');
  });

  it('성공 시 결과 반환', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });
    const result = await cb.execute(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('실패 횟수가 threshold 미만이면 CLOSED 유지', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });
    await failN(cb, 2);
    expect(cb.getState()).toBe('CLOSED');
  });

  it('실패 횟수 = threshold → OPEN 전이', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });
    await failN(cb, 3);
    expect(cb.getState()).toBe('OPEN');
  });

  it('성공 후 failures 카운터 리셋', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });
    await failN(cb, 2);
    await cb.execute(async () => 'ok');
    expect(cb.getFailures()).toBe(0);
  });
});

describe('CircuitBreaker — OPEN 상태', () => {
  it('OPEN 상태에서 즉시 CircuitOpenError throw', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 5000 });
    await failN(cb, 2);

    await expect(cb.execute(async () => 'should not run'))
      .rejects.toThrow(CircuitOpenError);
  });

  it('CircuitOpenError 메시지에 retry after 포함', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeMs: 5000 });
    await failN(cb, 1);

    await expect(cb.execute(async () => 'x')).rejects.toThrow('Circuit breaker OPEN');
  });

  it('OPEN 상태에서는 fn이 호출되지 않음', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 5000 });
    await failN(cb, 2);

    let called = false;
    await cb.execute(async () => { called = true; return 'x'; }).catch(() => {});
    expect(called).toBe(false);
  });
});

describe('CircuitBreaker — HALF_OPEN 상태 및 복구', () => {
  it('recoveryTimeMs 경과 후 HALF_OPEN 전이', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 50 });
    await failN(cb, 2);
    expect(cb.getState()).toBe('OPEN');

    // 50ms 대기
    await new Promise(r => setTimeout(r, 60));

    // 다음 execute 호출에서 HALF_OPEN 전이 후 fn 실행
    await cb.execute(async () => 'recovery').catch(() => {});
    // 성공하면 CLOSED, 실패하면 OPEN — 여기서는 성공
    expect(cb.getState()).toBe('CLOSED');
  });

  it('HALF_OPEN에서 실패 → OPEN 재진입', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 50 });
    await failN(cb, 2);

    await new Promise(r => setTimeout(r, 60));

    // HALF_OPEN에서 실패
    await cb.execute(async () => { throw new Error('still down'); }).catch(() => {});
    expect(cb.getState()).toBe('OPEN');
  });

  it('HALF_OPEN에서 성공 → CLOSED 전이 + failures 리셋', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 50 });
    await failN(cb, 2);

    await new Promise(r => setTimeout(r, 60));

    await cb.execute(async () => 'ok');
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getFailures()).toBe(0);
  });
});

describe('CircuitBreaker — reset()', () => {
  it('reset() 후 CLOSED + failures = 0', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 100 });
    await failN(cb, 2);
    expect(cb.getState()).toBe('OPEN');

    cb.reset();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getFailures()).toBe(0);
  });
});

describe('CircuitOpenError', () => {
  it('name이 "CircuitOpenError"', () => {
    const err = new CircuitOpenError(3000);
    expect(err.name).toBe('CircuitOpenError');
  });

  it('Error 클래스 상속', () => {
    expect(new CircuitOpenError(1000)).toBeInstanceOf(Error);
  });
});
