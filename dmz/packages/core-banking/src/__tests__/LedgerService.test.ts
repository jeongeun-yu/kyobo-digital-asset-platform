/**
 * LedgerService 단위 테스트
 *
 * MintRequest CRUD, 상태 전이 guard, Idempotency(이벤트 중복 방지), 에러 클래스 검증
 */

import {
  LedgerService,
  MintRequestNotFoundError,
  InvalidStateTransitionError,
  type MintRequest,
  type MintStatus,
} from '../ledger/LedgerService';

// ── In-Memory DB Mock ────────────────────────────────────────────────────────

function makeDb() {
  const rows: Record<string, unknown>[] = [];
  const eventRows: Record<string, unknown>[] = [];

  return {
    rows,
    eventRows,
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      const s = sql.trim().toUpperCase();

      if (s.startsWith('INSERT INTO MINT_REQUESTS')) {
        const [id, userId, policyId, , createdAt] = params as string[];
        rows.push({ id, user_id: userId, policy_id: policyId, status: 'PENDING', tx_hash: null, token_id: null, error_msg: null, created_at: createdAt, updated_at: createdAt });
        return { rows: [{ id }] };
      }

      if (s.startsWith('SELECT * FROM MINT_REQUESTS')) {
        const id = params[0] as string;
        return { rows: rows.filter(r => r['id'] === id) };
      }

      if (s.startsWith('UPDATE MINT_REQUESTS')) {
        const [status, txHash, tokenId, errorMsg, updatedAt, id] = params as unknown[];
        const row = rows.find(r => r['id'] === id);
        if (row) {
          row['status']     = status;
          row['tx_hash']    = txHash;
          row['token_id']   = tokenId;
          row['error_msg']  = errorMsg;
          row['updated_at'] = updatedAt;
        }
        return { rows: [] };
      }

      if (s.startsWith('INSERT INTO PROCESSED_EVENTS')) {
        const [txHash, logIndex] = params as [string, number];
        const exists = eventRows.some(r => r['tx_hash'] === txHash && r['log_index'] === logIndex);
        if (exists) return { rows: [] };   // ON CONFLICT DO NOTHING
        const id = eventRows.length + 1;
        eventRows.push({ id, tx_hash: txHash, log_index: logIndex });
        return { rows: [{ id }] };
      }

      return { rows: [] };
    },
  };
}

function makeAuditLog() {
  const logs: unknown[] = [];
  return { logs, async log(entry: unknown) { logs.push(entry); } };
}

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('LedgerService.createMintRequest()', () => {
  it('PENDING 상태의 MintRequest 반환', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    const req = await svc.createMintRequest('u-001', 'policy-A');
    expect(req.status).toBe('PENDING');
    expect(req.userId).toBe('u-001');
    expect(req.policyId).toBe('policy-A');
  });

  it('UUID 형식의 id 부여', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    const req = await svc.createMintRequest('u-001', 'policy-A');
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('감사 로그에 MINT_REQUESTED 기록', async () => {
    const db  = makeDb();
    const audit = makeAuditLog();
    const svc = new LedgerService(db, audit);
    await svc.createMintRequest('u-001', 'policy-A');
    expect(audit.logs).toHaveLength(1);
  });
});

describe('LedgerService.getMintRequest()', () => {
  it('존재하는 requestId → MintRequest 반환', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    const created = await svc.createMintRequest('u-001', 'policy-A');
    const found   = await svc.getMintRequest(created.id);
    expect(found?.id).toBe(created.id);
  });

  it('존재하지 않는 requestId → null', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    expect(await svc.getMintRequest('non-existent-id')).toBeNull();
  });
});

describe('LedgerService.updateMintRequest() — 상태 전이', () => {
  it('PENDING → SUBMITTED 허용', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    const req  = await svc.createMintRequest('u-001', 'policy-A');
    const updated = await svc.updateMintRequest(req.id, { status: 'SUBMITTED', txHash: '0xtx' });
    expect(updated.status).toBe('SUBMITTED');
    expect(updated.txHash).toBe('0xtx');
  });

  it('PENDING → FAILED 허용', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    const req = await svc.createMintRequest('u-001', 'policy-A');
    const updated = await svc.updateMintRequest(req.id, { status: 'FAILED', errorMsg: 'submit failed' });
    expect(updated.status).toBe('FAILED');
  });

  it('PENDING → CONFIRMED 불허 → InvalidStateTransitionError', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    const req = await svc.createMintRequest('u-001', 'policy-A');
    await expect(svc.updateMintRequest(req.id, { status: 'CONFIRMED' }))
      .rejects.toThrow(InvalidStateTransitionError);
  });

  it('CONFIRMED 상태에서 추가 전이 불허', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    const req = await svc.createMintRequest('u-001', 'policy-A');

    // PENDING → SUBMITTED → MINED → FINALIZED → CONFIRMED
    await svc.updateMintRequest(req.id, { status: 'SUBMITTED', txHash: '0xtx' });
    await svc.updateMintRequest(req.id, { status: 'MINED' });
    await svc.updateMintRequest(req.id, { status: 'FINALIZED' });
    await svc.updateMintRequest(req.id, { status: 'CONFIRMED' });

    await expect(svc.updateMintRequest(req.id, { status: 'FAILED' }))
      .rejects.toThrow(InvalidStateTransitionError);
  });

  it('존재하지 않는 requestId → MintRequestNotFoundError', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    await expect(svc.updateMintRequest('bad-id', { status: 'FAILED' }))
      .rejects.toThrow(MintRequestNotFoundError);
  });

  it('업데이트 후 감사 로그 추가 기록', async () => {
    const db  = makeDb();
    const audit = makeAuditLog();
    const svc = new LedgerService(db, audit);
    const req = await svc.createMintRequest('u-001', 'policy-A');
    await svc.updateMintRequest(req.id, { status: 'SUBMITTED', txHash: '0xtx' });
    expect(audit.logs).toHaveLength(2);
  });
});

describe('LedgerService.recordProcessedEvent() — 이벤트 Idempotency', () => {
  it('처음 처리 → skipped: false, id 포함', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    const result = await svc.recordProcessedEvent('0xtx', 0, 'Transfer', 100n, {});
    expect(result.skipped).toBe(false);
    expect(result.id).toBeDefined();
  });

  it('동일 txHash + logIndex 재처리 → skipped: true', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    await svc.recordProcessedEvent('0xtx', 0, 'Transfer', 100n, {});
    const dup = await svc.recordProcessedEvent('0xtx', 0, 'Transfer', 100n, {});
    expect(dup.skipped).toBe(true);
  });

  it('같은 txHash, 다른 logIndex → skipped: false', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    await svc.recordProcessedEvent('0xtx', 0, 'Transfer', 100n, {});
    const second = await svc.recordProcessedEvent('0xtx', 1, 'Transfer', 100n, {});
    expect(second.skipped).toBe(false);
  });
});

describe('LedgerService.updateMintRequest() — tokenId 브랜치', () => {
  it('tokenId 포함 업데이트 → BigInt 변환 후 반환', async () => {
    const db  = makeDb();
    const svc = new LedgerService(db, makeAuditLog());
    const req = await svc.createMintRequest('u-001', 'policy-A');

    await svc.updateMintRequest(req.id, { status: 'SUBMITTED', txHash: '0xtx' });
    await svc.updateMintRequest(req.id, { status: 'MINED' });
    await svc.updateMintRequest(req.id, { status: 'FINALIZED' });
    const updated = await svc.updateMintRequest(req.id, { status: 'CONFIRMED', tokenId: 42n });

    expect(updated.tokenId).toBe(42n);
    // DB에도 정상 저장 확인
    const found = await svc.getMintRequest(req.id);
    expect(found?.tokenId).toBe(42n);
  });
});

describe('에러 클래스', () => {
  it('MintRequestNotFoundError.name', () => {
    expect(new MintRequestNotFoundError('x').name).toBe('MintRequestNotFoundError');
  });

  it('InvalidStateTransitionError.name', () => {
    expect(new InvalidStateTransitionError('PENDING', 'CONFIRMED').name).toBe('InvalidStateTransitionError');
  });

  it('InvalidStateTransitionError 메시지에 from/to 포함', () => {
    const err = new InvalidStateTransitionError('PENDING', 'CONFIRMED');
    expect(err.message).toContain('PENDING');
    expect(err.message).toContain('CONFIRMED');
  });
});
