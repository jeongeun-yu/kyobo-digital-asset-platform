/**
 * KeyGovernanceService 단위 테스트
 *
 * SafeTx 생명주기(propose → addSignature → execute),
 * Travel Rule 강제, 취소, 에러 클래스 검증
 */

import {
  KeyGovernanceService,
  TravelRuleRequiredError,
  PendingTxNotFoundError,
  DuplicateSignatureError,
  type SafeTxParams,
  type PendingTx,
} from '../governance/KeyGovernanceService';

// ── Mock 헬퍼 ─────────────────────────────────────────────────────────────────

function makeSafeClient(opts: { threshold?: number; verifySig?: boolean } = {}) {
  return {
    async buildSafeTx(params: SafeTxParams) { return { ...params }; },
    async calcTxHash()    { return '0xsafehash-' + Math.random().toString(16).slice(2); },
    async getThreshold()  { return opts.threshold ?? 2; },
    async verifySignature() { return opts.verifySig ?? true; },
    async execTransaction() { return '0xonchain-tx'; },
  };
}

function makeDb() {
  const rows: Record<string, unknown>[] = [];

  return {
    rows,
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      const s = sql.trim().toUpperCase();

      if (s.startsWith('INSERT INTO PENDING_TXS')) {
        // $1=id, $2=txHash, $3=params, $4=threshold, $5=proposer, $6=proposedAt
        // 'PENDING_SIGNATURES' and '[]' are SQL literals, not in params array
        const [id, txHash, paramsStr, required, proposedBy, proposedAt] = params;
        rows.push({
          id,
          tx_hash: txHash,
          params:  paramsStr,
          status:  'PENDING_SIGNATURES',
          required_signatures: required,
          collected_signatures: '[]',
          proposed_by: proposedBy,
          proposed_at: proposedAt,
          executed_tx_hash: null,
        });
        return { rows: [] };
      }

      if (s.startsWith('SELECT * FROM PENDING_TXS WHERE ID')) {
        const id = params[0] as string;
        return { rows: rows.filter(r => r['id'] === id) };
      }

      if (s.startsWith('UPDATE PENDING_TXS SET COLLECTED_SIGNATURES')) {
        const [sigs, status, id] = params;
        const row = rows.find(r => r['id'] === id);
        if (row) {
          row['collected_signatures'] = sigs;
          row['status'] = status;
        }
        return { rows: [] };
      }

      if (s.startsWith("UPDATE PENDING_TXS SET STATUS='EXECUTED'")) {
        const [txHash, id] = params;
        const row = rows.find(r => r['id'] === id);
        if (row) {
          row['status'] = 'EXECUTED';
          row['executed_tx_hash'] = txHash;
        }
        return { rows: [] };
      }

      if (s.startsWith("UPDATE PENDING_TXS SET STATUS='CANCELLED'")) {
        const [id] = params;
        const row = rows.find(r => r['id'] === id);
        if (row) row['status'] = 'CANCELLED';
        return { rows: [] };
      }

      return { rows: [] };
    },
  };
}

function makeAuditLog() {
  const logs: unknown[] = [];
  return { logs, async log(e: unknown) { logs.push(e); } };
}

function makeNotifier() {
  const events: unknown[] = [];
  return { events, async send(e: unknown) { events.push(e); } };
}

const BASE_PARAMS: SafeTxParams = {
  to:        '0xrecipient',
  value:     100_000n,   // 100,000원 (Travel Rule 임계값 미만)
  data:      '0x',
  operation: 0,
};

const HIGH_VALUE_PARAMS: SafeTxParams = {
  to:        '0xrecipient',
  value:     1_500_000n,  // 150만원 (Travel Rule 임계값 초과)
  data:      '0x',
  operation: 0,
};

const TRAVEL_RULE_DATA = {
  originatorName:  '홍길동',
  originatorVasp:  'kyobo-vasp',
  beneficiaryName: '이순신',
  beneficiaryVasp: 'other-vasp',
  amount:          1_500_000n,
  currency:        'KRW',
};

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('KeyGovernanceService.proposeTx()', () => {
  it('PendingTx 반환 — PENDING_SIGNATURES 상태', async () => {
    const svc = new KeyGovernanceService(makeSafeClient(), makeDb(), makeAuditLog(), makeNotifier());
    const tx  = await svc.proposeTx('proposer-A', BASE_PARAMS);
    expect(tx.status).toBe('PENDING_SIGNATURES');
    expect(tx.proposedBy).toBe('proposer-A');
  });

  it('requiredSignatures = safeClient.getThreshold()', async () => {
    const svc = new KeyGovernanceService(makeSafeClient({ threshold: 3 }), makeDb(), makeAuditLog(), makeNotifier());
    const tx  = await svc.proposeTx('proposer', BASE_PARAMS);
    expect(tx.requiredSignatures).toBe(3);
  });

  it('100만원 이상 + travelRuleData 없음 → TravelRuleRequiredError', async () => {
    const svc = new KeyGovernanceService(makeSafeClient(), makeDb(), makeAuditLog(), makeNotifier());
    await expect(svc.proposeTx('proposer', HIGH_VALUE_PARAMS))
      .rejects.toThrow(TravelRuleRequiredError);
  });

  it('100만원 이상 + travelRuleData 있음 → 성공', async () => {
    const svc = new KeyGovernanceService(makeSafeClient(), makeDb(), makeAuditLog(), makeNotifier());
    const tx  = await svc.proposeTx('proposer', { ...HIGH_VALUE_PARAMS, travelRuleData: TRAVEL_RULE_DATA });
    expect(tx.status).toBe('PENDING_SIGNATURES');
  });

  it('감사 로그에 TX_PROPOSED 기록', async () => {
    const audit = makeAuditLog();
    const svc   = new KeyGovernanceService(makeSafeClient(), makeDb(), audit, makeNotifier());
    await svc.proposeTx('proposer', BASE_PARAMS);
    expect(audit.logs).toHaveLength(1);
  });

  it('알림 발송 (SIGNATURE_REQUESTED)', async () => {
    const notifier = makeNotifier();
    const svc = new KeyGovernanceService(makeSafeClient(), makeDb(), makeAuditLog(), notifier);
    await svc.proposeTx('proposer', BASE_PARAMS);
    expect(notifier.events).toHaveLength(1);
  });
});

describe('KeyGovernanceService.addSignature()', () => {
  async function setupTx() {
    const db       = makeDb();
    const audit    = makeAuditLog();
    const notifier = makeNotifier();
    const svc      = new KeyGovernanceService(makeSafeClient({ threshold: 2 }), db, audit, notifier);
    const tx       = await svc.proposeTx('proposer', BASE_PARAMS);
    return { svc, db, audit, notifier, txId: tx.id };
  }

  it('첫 서명 추가 → collected: 1, ready: false', async () => {
    const { svc, txId } = await setupTx();
    const status = await svc.addSignature(txId, 'signer-A', '0xsig-a');
    expect(status.collected).toBe(1);
    expect(status.ready).toBe(false);
  });

  it('두 번째 서명으로 threshold 달성 → ready: true', async () => {
    const { svc, txId } = await setupTx();
    await svc.addSignature(txId, 'signer-A', '0xsig-a');
    const status = await svc.addSignature(txId, 'signer-B', '0xsig-b');
    expect(status.ready).toBe(true);
  });

  it('threshold 달성 시 READY_TO_EXECUTE 상태 전이', async () => {
    const { svc, db, txId } = await setupTx();
    await svc.addSignature(txId, 'signer-A', '0xsig-a');
    await svc.addSignature(txId, 'signer-B', '0xsig-b');
    const row = db.rows.find(r => r['id'] === txId);
    expect(row?.['status']).toBe('READY_TO_EXECUTE');
  });

  it('동일 signer 중복 서명 → DuplicateSignatureError', async () => {
    const { svc, txId } = await setupTx();
    await svc.addSignature(txId, 'signer-A', '0xsig-a');
    await expect(svc.addSignature(txId, 'signer-A', '0xsig-a2'))
      .rejects.toThrow(DuplicateSignatureError);
  });

  it('유효하지 않은 서명 → 에러 throw', async () => {
    const invalidClient = makeSafeClient({ verifySig: false });
    const db       = makeDb();
    const svc      = new KeyGovernanceService(invalidClient, db, makeAuditLog(), makeNotifier());
    const tx       = await svc.proposeTx('proposer', BASE_PARAMS);
    await expect(svc.addSignature(tx.id, 'signer-A', '0xinvalid'))
      .rejects.toThrow('Invalid signature');
  });

  it('존재하지 않는 txId → PendingTxNotFoundError', async () => {
    const { svc } = await setupTx();
    await expect(svc.addSignature('nonexistent', 'signer', '0xsig'))
      .rejects.toThrow(PendingTxNotFoundError);
  });
});

describe('KeyGovernanceService.executeTx()', () => {
  async function setupReadyTx() {
    const db  = makeDb();
    const svc = new KeyGovernanceService(makeSafeClient({ threshold: 2 }), db, makeAuditLog(), makeNotifier());
    const tx  = await svc.proposeTx('proposer', BASE_PARAMS);
    await svc.addSignature(tx.id, 'signer-A', '0xsig-a');
    await svc.addSignature(tx.id, 'signer-B', '0xsig-b');
    return { svc, db, txId: tx.id };
  }

  it('READY_TO_EXECUTE → onChainTxHash 반환', async () => {
    const { svc, txId } = await setupReadyTx();
    const result = await svc.executeTx(txId, 'executor');
    expect(result.onChainTxHash).toBe('0xonchain-tx');
  });

  it('실행 후 DB status = EXECUTED', async () => {
    const { svc, db, txId } = await setupReadyTx();
    await svc.executeTx(txId, 'executor');
    const row = db.rows.find(r => r['id'] === txId);
    expect(row?.['status']).toBe('EXECUTED');
  });

  it('PENDING_SIGNATURES 상태에서 execute → 에러', async () => {
    const db  = makeDb();
    const svc = new KeyGovernanceService(makeSafeClient({ threshold: 3 }), db, makeAuditLog(), makeNotifier());
    const tx  = await svc.proposeTx('proposer', BASE_PARAMS);
    await svc.addSignature(tx.id, 'signer-A', '0xsig-a');

    await expect(svc.executeTx(tx.id, 'executor')).rejects.toThrow('not ready to execute');
  });
});

describe('KeyGovernanceService.cancelTx()', () => {
  it('PENDING_SIGNATURES → CANCELLED', async () => {
    const db  = makeDb();
    const svc = new KeyGovernanceService(makeSafeClient(), db, makeAuditLog(), makeNotifier());
    const tx  = await svc.proposeTx('proposer', BASE_PARAMS);

    await svc.cancelTx(tx.id, 'canceller', 'mistake');
    const row = db.rows.find(r => r['id'] === tx.id);
    expect(row?.['status']).toBe('CANCELLED');
  });

  it('EXECUTED 상태 취소 → 에러', async () => {
    const db  = makeDb();
    const svc = new KeyGovernanceService(makeSafeClient({ threshold: 2 }), db, makeAuditLog(), makeNotifier());
    const tx  = await svc.proposeTx('proposer', BASE_PARAMS);
    await svc.addSignature(tx.id, 'signer-A', '0xsig-a');
    await svc.addSignature(tx.id, 'signer-B', '0xsig-b');
    await svc.executeTx(tx.id, 'executor');

    await expect(svc.cancelTx(tx.id, 'canceller', 'too late'))
      .rejects.toThrow('Cannot cancel already executed tx');
  });
});

describe('에러 클래스', () => {
  it('TravelRuleRequiredError.name', () => {
    expect(new TravelRuleRequiredError(1_500_000n).name).toBe('TravelRuleRequiredError');
  });

  it('PendingTxNotFoundError.name', () => {
    expect(new PendingTxNotFoundError('x').name).toBe('PendingTxNotFoundError');
  });

  it('DuplicateSignatureError.name', () => {
    expect(new DuplicateSignatureError('signer').name).toBe('DuplicateSignatureError');
  });
});
