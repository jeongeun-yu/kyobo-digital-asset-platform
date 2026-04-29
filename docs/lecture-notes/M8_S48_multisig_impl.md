# M8 S48 — MultisigService 구현과 2-of-3 서명 실행 검증

> 모듈 8 · 세션 48 · 1시간  
> 스켈레톤: `dmz/packages/vasp/src/governance/KeyGovernanceService.ts`

---

## 강의 파트 (10분)

### SafeTx 생명주기 재확인

S47에서 설계한 흐름을 코드로 구현한다.

```
proposeTx  → PENDING_SIGNATURES (DB 저장, 알림)
addSignature × n → 서명 수집 (DB 업데이트)
threshold 도달 → READY_TO_EXECUTE
executeTx  → Safe.execTransaction (온체인) → EXECUTED
```

각 함수가 DB와 Safe 클라이언트를 어떻게 조율하는지 코드에서 직접 확인한다.

---

## 실습 파트 (50분)

### KeyGovernanceService 전체 구현

```typescript
// dmz/packages/vasp/src/governance/KeyGovernanceService.ts
import { randomUUID } from 'crypto';

export class KeyGovernanceService {
  private static readonly TRAVEL_RULE_THRESHOLD = BigInt(1_000_000);

  constructor(
    private readonly safeClient: GnosisSafeClient,
    private readonly db: DatabaseClient,
    private readonly auditLog: AuditLogClient,
    private readonly notifier: Notifier,
  ) {}

  // ── [1단계] TX 제안 ──────────────────────────────────────────

  async proposeTx(proposer: string, params: SafeTxParams): Promise<PendingTx> {
    // Travel Rule 검증 (S49에서 상세히 다룸)
    if (params.value >= KeyGovernanceService.TRAVEL_RULE_THRESHOLD) {
      if (!params.travelRuleData) {
        throw new TravelRuleRequiredError(params.value);
      }
    }

    // 1. SafeTx 구조체 생성 + EIP-712 해시 계산
    const safeTx = await this.safeClient.buildSafeTx(params);
    const txHash = await this.safeClient.calcTxHash(safeTx);

    // 2. threshold 조회 (Safe 컨트랙트에서)
    const threshold = await this.safeClient.getThreshold();

    // 3. DB에 저장 (PENDING_SIGNATURES 상태)
    const id = randomUUID();
    const now = new Date();

    await this.db.query(
      `INSERT INTO pending_txs
         (id, tx_hash, params, status, required_signatures,
          collected_signatures, proposed_by, proposed_at)
       VALUES ($1,$2,$3,'PENDING_SIGNATURES',$4,'[]',$5,$6)`,
      [id, txHash, JSON.stringify(params), threshold, proposer, now],
    );

    const pendingTx: PendingTx = {
      id,
      txHash,
      params,
      status: 'PENDING_SIGNATURES',
      requiredSignatures: threshold,
      collectedSignatures: [],
      proposedBy: proposer,
      proposedAt: now,
    };

    // 4. 감사 로그 + 서명자 알림
    await this.auditLog.log({
      actor: proposer,
      action: 'TX_PROPOSED',
      resourceType: 'PENDING_TX',
      resourceId: id,
      afterState: pendingTx,
    });

    await this.notifier.send({
      type: 'SIGNATURE_REQUESTED',
      txId: id,
      proposer,
      requiredSignatures: threshold,
      txHash,
    });

    return pendingTx;
  }

  // ── [2단계] 서명 수집 ────────────────────────────────────────

  async addSignature(
    txId: string,
    signer: string,
    signature: string,
  ): Promise<SignatureStatus> {
    // 1. DB에서 pending_tx 조회
    const { rows } = await this.db.query(
      `SELECT * FROM pending_txs WHERE id = $1`,
      [txId],
    );

    if (rows.length === 0) {
      throw new PendingTxNotFoundError(txId);
    }

    const row = rows[0];
    const collectedSigs: SignatureEntry[] = JSON.parse(row.collected_signatures as string);
    const status = row.status as PendingTxStatus;

    // 2. 상태 확인 — PENDING_SIGNATURES만 서명 받음
    if (status !== 'PENDING_SIGNATURES') {
      throw new Error(`Cannot add signature to tx in status: ${status}`);
    }

    // 3. 중복 서명 방지
    if (collectedSigs.some(s => s.signer === signer)) {
      throw new DuplicateSignatureError(signer);
    }

    // 4. Safe 클라이언트로 서명 검증 (EIP-712 + ecrecover)
    const valid = await this.safeClient.verifySignature(
      row.tx_hash as string,
      signer,
      signature,
    );

    if (!valid) {
      throw new Error(`Invalid signature from signer: ${signer}`);
    }

    // 5. 서명 추가
    const newSig: SignatureEntry = { signer, signature, signedAt: new Date() };
    collectedSigs.push(newSig);

    // 6. threshold 도달 여부 확인
    const required = row.required_signatures as number;
    const collected = collectedSigs.length;
    const ready = collected >= required;
    const newStatus: PendingTxStatus = ready ? 'READY_TO_EXECUTE' : 'PENDING_SIGNATURES';

    // 7. DB 업데이트
    await this.db.query(
      `UPDATE pending_txs
       SET collected_signatures = $1, status = $2
       WHERE id = $3`,
      [JSON.stringify(collectedSigs), newStatus, txId],
    );

    // 8. 감사 로그
    await this.auditLog.log({
      actor: signer,
      action: 'SIGNATURE_ADDED',
      resourceType: 'PENDING_TX',
      resourceId: txId,
      afterState: { collected, required, status: newStatus },
    });

    // 9. threshold 도달 시 실행 알림
    if (ready) {
      await this.notifier.send({
        type: 'TX_READY_TO_EXECUTE',
        txId,
        collected,
        required,
      });
    }

    return { collected, required, ready };
  }

  // ── [3단계] 온체인 실행 ──────────────────────────────────────

  async executeTx(
    txId: string,
    executor: string,
  ): Promise<{ onChainTxHash: string }> {
    // 1. DB 조회 + 상태 확인
    const { rows } = await this.db.query(
      `SELECT * FROM pending_txs WHERE id = $1`,
      [txId],
    );

    if (rows.length === 0) {
      throw new PendingTxNotFoundError(txId);
    }

    const row = rows[0];

    if (row.status !== 'READY_TO_EXECUTE') {
      throw new Error(
        `TX not ready to execute. Status: ${row.status}. ` +
        `Collected: ${JSON.parse(row.collected_signatures as string).length}, ` +
        `Required: ${row.required_signatures}`
      );
    }

    const params: SafeTxParams = JSON.parse(row.params as string);
    const collectedSigs: SignatureEntry[] = JSON.parse(row.collected_signatures as string);

    // 2. Safe 온체인 실행
    //    Safe 컨트랙트가 서명들을 재검증 → threshold 충족 확인 → 실행
    const onChainTxHash = await this.safeClient.execTransaction(params, collectedSigs);

    // 3. DB 상태 업데이트
    await this.db.query(
      `UPDATE pending_txs
       SET status = 'EXECUTED', executed_tx_hash = $1
       WHERE id = $2`,
      [onChainTxHash, txId],
    );

    // 4. 감사 로그
    await this.auditLog.log({
      actor: executor,
      action: 'TX_EXECUTED',
      resourceType: 'PENDING_TX',
      resourceId: txId,
      afterState: { onChainTxHash, status: 'EXECUTED' },
    });

    return { onChainTxHash };
  }

  // ── 상태 조회 ────────────────────────────────────────────────

  async getSigningStatus(txId: string): Promise<SignatureStatus> {
    const { rows } = await this.db.query(
      `SELECT required_signatures, collected_signatures FROM pending_txs WHERE id = $1`,
      [txId],
    );

    if (rows.length === 0) {
      throw new PendingTxNotFoundError(txId);
    }

    const row = rows[0];
    const collected = JSON.parse(row.collected_signatures as string).length;
    const required = row.required_signatures as number;

    return { collected, required, ready: collected >= required };
  }

  // ── 취소 ─────────────────────────────────────────────────────

  async cancelTx(txId: string, cancelledBy: string, reason: string): Promise<void> {
    const { rows } = await this.db.query(
      `SELECT status FROM pending_txs WHERE id = $1`,
      [txId],
    );

    if (rows.length === 0) {
      throw new PendingTxNotFoundError(txId);
    }

    if (rows[0].status === 'EXECUTED') {
      throw new Error('Cannot cancel already-executed transaction');
    }

    await this.db.query(
      `UPDATE pending_txs SET status = 'CANCELLED' WHERE id = $1`,
      [txId],
    );

    await this.auditLog.log({
      actor: cancelledBy,
      action: 'TX_CANCELLED',
      resourceType: 'PENDING_TX',
      resourceId: txId,
      afterState: { status: 'CANCELLED', reason },
    });
  }
}
```

### 2-of-3 서명 실행 검증 테스트

```typescript
// test/KeyGovernanceService.test.ts
import { KeyGovernanceService } from '../src/governance/KeyGovernanceService';

describe('KeyGovernanceService — 2-of-3 MultisigService 구현', () => {
  let service: KeyGovernanceService;
  let mockSafe: jest.Mocked<GnosisSafeClient>;
  let mockDb: MockDatabase;
  let mockAudit: jest.Mocked<AuditLogClient>;
  let mockNotifier: jest.Mocked<Notifier>;

  beforeEach(() => {
    mockSafe = {
      buildSafeTx: jest.fn().mockResolvedValue({ /* safeTx struct */ }),
      calcTxHash: jest.fn().mockResolvedValue('0xabcdef1234567890' + '0'.repeat(48)),
      getThreshold: jest.fn().mockResolvedValue(2),          // 2-of-3
      verifySignature: jest.fn().mockResolvedValue(true),
      execTransaction: jest.fn().mockResolvedValue('0xonchain123'),
    };
    mockDb = new MockDatabase();
    mockAudit = { log: jest.fn().mockResolvedValue(undefined) };
    mockNotifier = { send: jest.fn().mockResolvedValue(undefined) };

    service = new KeyGovernanceService(mockSafe, mockDb, mockAudit, mockNotifier);
  });

  // ── proposeTx ───────────────────────────────────────────────

  it('proposeTx → PENDING_SIGNATURES 상태로 저장 + 알림', async () => {
    const params: SafeTxParams = {
      to: '0xKyoboNFT',
      value: 0n,
      data: '0x8456cb59',  // pause()
      operation: 0,
    };

    const tx = await service.proposeTx('vasp-admin', params);

    expect(tx.status).toBe('PENDING_SIGNATURES');
    expect(tx.requiredSignatures).toBe(2);
    expect(tx.collectedSignatures).toHaveLength(0);
    expect(mockAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TX_PROPOSED' })
    );
    expect(mockNotifier.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SIGNATURE_REQUESTED' })
    );
  });

  // ── addSignature ────────────────────────────────────────────

  it('서명자 A 1명 서명 → PENDING_SIGNATURES 유지', async () => {
    const tx = await service.proposeTx('admin', {
      to: '0x1', value: 0n, data: '0x', operation: 0,
    });

    const status = await service.addSignature(tx.id, 'signerA', '0xsig_a');

    expect(status.collected).toBe(1);
    expect(status.required).toBe(2);
    expect(status.ready).toBe(false);
    // PENDING_SIGNATURES 유지 — 실행 불가
  });

  it('서명자 A, B 서명 → READY_TO_EXECUTE + 실행 알림', async () => {
    const tx = await service.proposeTx('admin', {
      to: '0x1', value: 0n, data: '0x', operation: 0,
    });

    await service.addSignature(tx.id, 'signerA', '0xsig_a');
    const status = await service.addSignature(tx.id, 'signerB', '0xsig_b');

    expect(status.collected).toBe(2);
    expect(status.ready).toBe(true);
    expect(mockNotifier.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TX_READY_TO_EXECUTE' })
    );
  });

  it('같은 서명자가 두 번 서명 → DuplicateSignatureError', async () => {
    const tx = await service.proposeTx('admin', {
      to: '0x1', value: 0n, data: '0x', operation: 0,
    });

    await service.addSignature(tx.id, 'signerA', '0xsig_a');

    await expect(
      service.addSignature(tx.id, 'signerA', '0xsig_a2'),
    ).rejects.toThrow('DuplicateSignatureError');
  });

  // ── executeTx ───────────────────────────────────────────────

  it('2-of-3 서명 후 executeTx → Safe.execTransaction 호출 + EXECUTED', async () => {
    const tx = await service.proposeTx('admin', {
      to: '0x1', value: 0n, data: '0x', operation: 0,
    });

    await service.addSignature(tx.id, 'signerA', '0xsig_a');
    await service.addSignature(tx.id, 'signerB', '0xsig_b');

    const result = await service.executeTx(tx.id, 'executor');

    expect(result.onChainTxHash).toBe('0xonchain123');
    expect(mockSafe.execTransaction).toHaveBeenCalledTimes(1);
    expect(mockAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TX_EXECUTED' })
    );

    // DB 상태 확인
    const dbRow = mockDb.getRow(tx.id);
    expect(dbRow.status).toBe('EXECUTED');
    expect(dbRow.executed_tx_hash).toBe('0xonchain123');
  });

  it('1-of-3 서명만으로 executeTx → revert (threshold 미달)', async () => {
    const tx = await service.proposeTx('admin', {
      to: '0x1', value: 0n, data: '0x', operation: 0,
    });

    await service.addSignature(tx.id, 'signerA', '0xsig_a');
    // signerB 서명 없음

    await expect(
      service.executeTx(tx.id, 'executor'),
    ).rejects.toThrow(/not ready/i);

    // Safe.execTransaction 호출되지 않음 (서비스 레이어에서 차단)
    expect(mockSafe.execTransaction).not.toHaveBeenCalled();
  });

  it('서명 없이 executeTx → revert', async () => {
    const tx = await service.proposeTx('admin', {
      to: '0x1', value: 0n, data: '0x', operation: 0,
    });

    // 서명 수집 없이 실행 시도
    await expect(
      service.executeTx(tx.id, 'executor'),
    ).rejects.toThrow(/not ready/i);
  });

  // ── cancelTx ────────────────────────────────────────────────

  it('EXECUTED TX 취소 시도 → 에러', async () => {
    const tx = await service.proposeTx('admin', {
      to: '0x1', value: 0n, data: '0x', operation: 0,
    });

    await service.addSignature(tx.id, 'signerA', '0xsig_a');
    await service.addSignature(tx.id, 'signerB', '0xsig_b');
    await service.executeTx(tx.id, 'executor');

    await expect(
      service.cancelTx(tx.id, 'admin', '취소 시도'),
    ).rejects.toThrow(/already-executed/i);
  });
});
```

---

## 완료 기준

- [ ] `proposeTx` → PENDING_SIGNATURES 저장 + 알림 발송
- [ ] `addSignature` → 1-of-3 서명 시 PENDING_SIGNATURES 유지
- [ ] `addSignature` → 2-of-3 서명 시 READY_TO_EXECUTE + 실행 알림
- [ ] 중복 서명 → DuplicateSignatureError
- [ ] `executeTx` → 1-of-3만으로 실행 시도 → revert (threshold 미달)
- [ ] `executeTx` → 2-of-3 서명 → Safe.execTransaction 호출 → EXECUTED
