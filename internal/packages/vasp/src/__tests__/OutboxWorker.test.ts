/**
 * OutboxWorker 단위 테스트
 *
 * 커버리지 목표:
 *   - SQL 구조: BEGIN/COMMIT/ROLLBACK 순서, SKIP LOCKED, PROCESSING 클레임, LIMIT, RETURNING
 *   - 정상 흐름: 빈 배치, 단일, 복수 (전체 성공 / 전체 실패 / 혼합)
 *   - 4가지 이벤트 타입 핸들러 라우팅
 *   - 지수 백오프 전 구간: attempt 0→1(2s), 1→2(4s), 2→3(8s), 3→4(16s), 4→DEAD(32s)
 *   - DEAD 경계 (MAX_ATTEMPTS = 5)
 *   - 핸들러 없음 → no-op PROCESSED
 *   - 핸들러 격리: 한 이벤트 실패가 다음 이벤트 처리를 막지 않음
 *   - claim 트랜잭션 실패 → ROLLBACK + 에러 전파
 *   - payload 정확히 핸들러에 전달, 핸들러 정확히 1회 호출
 */

import { OutboxWorker, type OutboxEventType } from '../outbox/OutboxWorker';

// ── 타입 ──────────────────────────────────────────────────────────────────────

type ClaimedRow = {
  id:            string;
  type:          OutboxEventType;
  payload:       Record<string, unknown>;
  attempt_count: number;
};

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<ClaimedRow> = {}): ClaimedRow {
  return {
    id:            'evt-001',
    type:          'VASP_SUBMIT_MINT',
    payload:       { requestId: 'req-001' },
    attempt_count: 0,
    ...overrides,
  };
}

/**
 * db.query mock — 호출 순서:
 *   [0] BEGIN         → []
 *   [1] claim UPDATE  → claimedRows
 *   [2] COMMIT        → []
 *   [3..N] 이벤트별 UPDATE → []
 */
function makeDb(claimedRows: ClaimedRow[]) {
  const query = jest.fn()
    .mockResolvedValueOnce([])           // BEGIN
    .mockResolvedValueOnce(claimedRows)  // claim
    .mockResolvedValueOnce([]);          // COMMIT

  claimedRows.forEach(() => query.mockResolvedValueOnce([]));

  return { query };
}

/** claim UPDATE 이후 각 이벤트 UPDATE 파라미터 */
function updateParamsAt(db: { query: jest.Mock }, eventIndex: number): unknown[] {
  return db.query.mock.calls[3 + eventIndex][1] as unknown[];
}

// ── 1. SQL 구조 검증 ──────────────────────────────────────────────────────────

describe('OutboxWorker — SQL 구조', () => {
  it('BEGIN → claim → COMMIT 순서로 호출됨', async () => {
    const db     = makeDb([]);
    const worker = new OutboxWorker(db);
    await worker.processPending();

    const sqls = db.query.mock.calls.map((c: unknown[][]) => String(c[0]).trim());
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[2]).toBe('COMMIT');
  });

  it('claim SQL에 FOR UPDATE SKIP LOCKED 포함', async () => {
    const db     = makeDb([]);
    const worker = new OutboxWorker(db);
    await worker.processPending();

    const claimSql = String(db.query.mock.calls[1][0]);
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it("claim SQL이 status = 'PROCESSING'으로 UPDATE", async () => {
    const db     = makeDb([]);
    const worker = new OutboxWorker(db);
    await worker.processPending();

    const claimSql = String(db.query.mock.calls[1][0]);
    expect(claimSql).toContain("status = 'PROCESSING'");
  });

  it('claim SQL에 RETURNING 포함 (id, type, payload, attempt_count)', async () => {
    const db     = makeDb([]);
    const worker = new OutboxWorker(db);
    await worker.processPending();

    const claimSql = String(db.query.mock.calls[1][0]);
    expect(claimSql).toContain('RETURNING');
  });

  it('claim SQL LIMIT 파라미터 = 10 (BATCH_SIZE)', async () => {
    const db     = makeDb([]);
    const worker = new OutboxWorker(db);
    await worker.processPending();

    const claimParams = db.query.mock.calls[1][1] as unknown[];
    expect(claimParams[0]).toBe(10);
  });

  it('claim SQL에 next_retry_at <= NOW() 조건 포함', async () => {
    const db     = makeDb([]);
    const worker = new OutboxWorker(db);
    await worker.processPending();

    const claimSql = String(db.query.mock.calls[1][0]);
    expect(claimSql).toContain('next_retry_at');
  });

  it("성공 UPDATE SQL이 status = 'PROCESSED' + processed_at = NOW() 포함", async () => {
    const row    = makeRow();
    const db     = makeDb([row]);
    const worker = new OutboxWorker(db, { VASP_SUBMIT_MINT: jest.fn().mockResolvedValue(undefined) });
    await worker.processPending();

    const successSql = String(db.query.mock.calls[3][0]);
    expect(successSql).toContain("status = 'PROCESSED'");
    expect(successSql).toContain('processed_at');
  });

  it("실패 UPDATE SQL이 지수 백오프 INTERVAL 포함", async () => {
    const row    = makeRow();
    const db     = makeDb([row]);
    const worker = new OutboxWorker(db, { VASP_SUBMIT_MINT: jest.fn().mockRejectedValue(new Error('x')) });
    await worker.processPending();

    const failSql = String(db.query.mock.calls[3][0]);
    expect(failSql).toContain("INTERVAL '1 second'");
  });
});

// ── 2. 정상 흐름 ─────────────────────────────────────────────────────────────

describe('OutboxWorker — 정상 흐름', () => {
  it('PENDING 이벤트 없으면 { processed: 0, failed: 0 }', async () => {
    const db     = makeDb([]);
    const worker = new OutboxWorker(db);
    expect(await worker.processPending()).toEqual({ processed: 0, failed: 0 });
  });

  it('단일 이벤트 성공 → { processed: 1, failed: 0 }', async () => {
    const row    = makeRow();
    const db     = makeDb([row]);
    const worker = new OutboxWorker(db, { VASP_SUBMIT_MINT: jest.fn().mockResolvedValue(undefined) });
    expect(await worker.processPending()).toEqual({ processed: 1, failed: 0 });
  });

  it('복수 이벤트 전체 성공 → processed = 이벤트 수', async () => {
    const rows = [
      makeRow({ id: 'evt-001' }),
      makeRow({ id: 'evt-002' }),
      makeRow({ id: 'evt-003' }),
    ];
    const db     = makeDb(rows);
    const worker = new OutboxWorker(db, { VASP_SUBMIT_MINT: jest.fn().mockResolvedValue(undefined) });
    expect(await worker.processPending()).toEqual({ processed: 3, failed: 0 });
  });

  it('복수 이벤트 전체 실패 → failed = 이벤트 수', async () => {
    const rows = [
      makeRow({ id: 'evt-001' }),
      makeRow({ id: 'evt-002' }),
    ];
    const db     = makeDb(rows);
    const worker = new OutboxWorker(db, { VASP_SUBMIT_MINT: jest.fn().mockRejectedValue(new Error('fail')) });
    expect(await worker.processPending()).toEqual({ processed: 0, failed: 2 });
  });

  it('혼합 배치 — 성공 2건 + 실패 1건', async () => {
    const rows = [
      makeRow({ id: 'evt-001' }),
      makeRow({ id: 'evt-002' }),
      makeRow({ id: 'evt-003' }),
    ];
    const db      = makeDb(rows);
    const handler = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('third fails'));
    const worker = new OutboxWorker(db, { VASP_SUBMIT_MINT: handler });

    const result = await worker.processPending();
    expect(result).toEqual({ processed: 2, failed: 1 });
  });
});

// ── 3. 핸들러 라우팅 — 4가지 이벤트 타입 ─────────────────────────────────────

describe('OutboxWorker — 이벤트 타입 라우팅', () => {
  const allTypes: OutboxEventType[] = [
    'VASP_SUBMIT_MINT',
    'VASP_SUBMIT_BURN',
    'LEDGER_UPDATE_HOLDING',
    'AUDIT_LOG_EMIT',
  ];

  for (const type of allTypes) {
    it(`${type} → 해당 핸들러만 호출됨`, async () => {
      const payload = { requestId: `req-${type}`, extra: 123 };
      const row     = makeRow({ type, payload });
      const db      = makeDb([row]);

      const handlers = Object.fromEntries(
        allTypes.map(t => [t, jest.fn().mockResolvedValue(undefined)]),
      ) as Record<OutboxEventType, jest.Mock>;

      const worker = new OutboxWorker(db, handlers);
      await worker.processPending();

      expect(handlers[type]).toHaveBeenCalledTimes(1);
      expect(handlers[type]).toHaveBeenCalledWith(payload);

      // 다른 타입 핸들러는 호출 안 됨
      for (const other of allTypes.filter(t => t !== type)) {
        expect(handlers[other]).not.toHaveBeenCalled();
      }
    });
  }

  it('핸들러 미등록 타입 → 핸들러 없이 PROCESSED (no-op)', async () => {
    const row    = makeRow({ type: 'AUDIT_LOG_EMIT' });
    const db     = makeDb([row]);
    const worker = new OutboxWorker(db, {}); // 핸들러 비어 있음

    const result = await worker.processPending();
    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(db.query.mock.calls[3][0]).toContain("status = 'PROCESSED'");
  });

  it('일부 타입만 핸들러 등록 — 미등록 타입은 no-op, 등록 타입은 핸들러 호출', async () => {
    const rows = [
      makeRow({ id: 'evt-mint',   type: 'VASP_SUBMIT_MINT' }),
      makeRow({ id: 'evt-audit',  type: 'AUDIT_LOG_EMIT' }),
    ];
    const db      = makeDb(rows);
    const mintH   = jest.fn().mockResolvedValue(undefined);
    const worker  = new OutboxWorker(db, { VASP_SUBMIT_MINT: mintH });

    const result = await worker.processPending();
    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(mintH).toHaveBeenCalledTimes(1);
  });
});

// ── 4. 지수 백오프 전 구간 ───────────────────────────────────────────────────

describe('OutboxWorker — 지수 백오프 (2^nextAttempt 초)', () => {
  const cases = [
    { attempt_count: 0, expectedAttempt: 1, expectedBackoff: 2,  expectedStatus: 'PENDING' },
    { attempt_count: 1, expectedAttempt: 2, expectedBackoff: 4,  expectedStatus: 'PENDING' },
    { attempt_count: 2, expectedAttempt: 3, expectedBackoff: 8,  expectedStatus: 'PENDING' },
    { attempt_count: 3, expectedAttempt: 4, expectedBackoff: 16, expectedStatus: 'PENDING' },
    { attempt_count: 4, expectedAttempt: 5, expectedBackoff: 32, expectedStatus: 'DEAD'    },
  ];

  for (const { attempt_count, expectedAttempt, expectedBackoff, expectedStatus } of cases) {
    it(`attempt_count=${attempt_count} 실패 → status=${expectedStatus}, attempt_count=${expectedAttempt}, backoff=${expectedBackoff}s`, async () => {
      const row    = makeRow({ attempt_count });
      const db     = makeDb([row]);
      const worker = new OutboxWorker(db, { VASP_SUBMIT_MINT: jest.fn().mockRejectedValue(new Error('err')) });

      await worker.processPending();

      const params = updateParamsAt(db, 0);
      expect(params).toContain(expectedStatus);
      expect(params).toContain(expectedAttempt);
      expect(params).toContain(expectedBackoff);
      expect(params).toContain(row.id);
    });
  }

  it('DEAD 경계: attempt_count=3 → 아직 PENDING (MAX_ATTEMPTS=5 미만)', async () => {
    const row    = makeRow({ attempt_count: 3 });
    const db     = makeDb([row]);
    const worker = new OutboxWorker(db, { VASP_SUBMIT_MINT: jest.fn().mockRejectedValue(new Error('err')) });
    await worker.processPending();

    const params = updateParamsAt(db, 0);
    expect(params).toContain('PENDING');
    expect(params).not.toContain('DEAD');
  });
});

// ── 5. payload 전달 정확성 ───────────────────────────────────────────────────

describe('OutboxWorker — payload 전달', () => {
  it('handler에 payload 객체 그대로 전달 (참조 동일)', async () => {
    const payload = { requestId: 'req-complex', amount: 1000n, nested: { a: 1 } };
    const row     = makeRow({ payload: payload as unknown as Record<string, unknown> });
    const db      = makeDb([row]);
    const handler = jest.fn().mockResolvedValue(undefined);
    const worker  = new OutboxWorker(db, { VASP_SUBMIT_MINT: handler });

    await worker.processPending();

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('handler가 정확히 1회만 호출됨', async () => {
    const row     = makeRow();
    const db      = makeDb([row]);
    const handler = jest.fn().mockResolvedValue(undefined);
    const worker  = new OutboxWorker(db, { VASP_SUBMIT_MINT: handler });

    await worker.processPending();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('복수 이벤트 — 각 payload가 해당 handler에 개별 전달', async () => {
    const payload1 = { requestId: 'req-A' };
    const payload2 = { requestId: 'req-B' };
    const rows = [
      makeRow({ id: 'evt-001', payload: payload1 }),
      makeRow({ id: 'evt-002', payload: payload2 }),
    ];
    const db      = makeDb(rows);
    const handler = jest.fn().mockResolvedValue(undefined);
    const worker  = new OutboxWorker(db, { VASP_SUBMIT_MINT: handler });

    await worker.processPending();

    expect(handler).toHaveBeenNthCalledWith(1, payload1);
    expect(handler).toHaveBeenNthCalledWith(2, payload2);
  });
});

// ── 6. 핸들러 격리 ──────────────────────────────────────────────────────────

describe('OutboxWorker — 핸들러 격리', () => {
  it('첫 번째 이벤트 실패해도 두 번째 이벤트 계속 처리됨', async () => {
    const rows = [
      makeRow({ id: 'evt-001' }),
      makeRow({ id: 'evt-002' }),
    ];
    const db      = makeDb(rows);
    const handler = jest.fn()
      .mockRejectedValueOnce(new Error('first fails'))
      .mockResolvedValueOnce(undefined);
    const worker  = new OutboxWorker(db, { VASP_SUBMIT_MINT: handler });

    const result = await worker.processPending();

    expect(result).toEqual({ processed: 1, failed: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('중간 이벤트 실패해도 나머지 처리 계속됨', async () => {
    const rows = [
      makeRow({ id: 'evt-001' }),
      makeRow({ id: 'evt-002' }),
      makeRow({ id: 'evt-003' }),
    ];
    const db      = makeDb(rows);
    const handler = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('middle fails'))
      .mockResolvedValueOnce(undefined);
    const worker  = new OutboxWorker(db, { VASP_SUBMIT_MINT: handler });

    const result = await worker.processPending();

    expect(result).toEqual({ processed: 2, failed: 1 });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('실패 이벤트의 UPDATE id가 해당 이벤트 id로 정확히 지정됨', async () => {
    const rows = [
      makeRow({ id: 'evt-success' }),
      makeRow({ id: 'evt-fail' }),
    ];
    const db      = makeDb(rows);
    const handler = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fail'));
    const worker  = new OutboxWorker(db, { VASP_SUBMIT_MINT: handler });

    await worker.processPending();

    // 3번: evt-success PROCESSED
    expect(db.query.mock.calls[3][1]).toContain('evt-success');
    // 4번: evt-fail retry
    expect(db.query.mock.calls[4][1]).toContain('evt-fail');
  });
});

// ── 7. 트랜잭션 안전성 ──────────────────────────────────────────────────────

describe('OutboxWorker — 트랜잭션 안전성', () => {
  it('claim 실패 시 ROLLBACK 호출', async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('DB timeout'))
        .mockResolvedValueOnce([]),
    };
    const worker = new OutboxWorker(db);

    await expect(worker.processPending()).rejects.toThrow('DB timeout');

    const sqls = db.query.mock.calls.map((c: unknown[][]) => String(c[0]).trim());
    expect(sqls).toContain('ROLLBACK');
  });

  it('claim 실패 에러가 호출부로 전파됨', async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockResolvedValueOnce([]),
    };
    const worker = new OutboxWorker(db);

    await expect(worker.processPending()).rejects.toThrow('connection lost');
  });

  it('정상 처리 시 ROLLBACK 호출 없음', async () => {
    const db     = makeDb([makeRow()]);
    const worker = new OutboxWorker(db, { VASP_SUBMIT_MINT: jest.fn().mockResolvedValue(undefined) });

    await worker.processPending();

    const sqls = db.query.mock.calls.map((c: unknown[][]) => String(c[0]).trim());
    expect(sqls).not.toContain('ROLLBACK');
  });

  it('핸들러 실패는 트랜잭션 밖에서 처리 — claim 트랜잭션은 이미 COMMIT됨', async () => {
    const row     = makeRow();
    const db      = makeDb([row]);
    const handler = jest.fn().mockRejectedValue(new Error('handler err'));
    const worker  = new OutboxWorker(db, { VASP_SUBMIT_MINT: handler });

    // 에러가 전파되지 않고 failed 카운트로 처리됨
    await expect(worker.processPending()).resolves.toEqual({ processed: 0, failed: 1 });

    const sqls = db.query.mock.calls.map((c: unknown[][]) => String(c[0]).trim());
    expect(sqls).toContain('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
  });
});

