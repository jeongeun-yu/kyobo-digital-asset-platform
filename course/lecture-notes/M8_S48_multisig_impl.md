# M8 S48 — MultisigService 구현과 2-of-3 서명 실행 검증

> **[Phase 1·2·3 공통 — 거버넌스]** Gnosis Safe 멀티시그는 Phase 전반에 걸쳐 거버넌스 수단으로 사용됩니다. Phase 3에서는 당사가 주키를 직접 보관하는 구조로 전환 가능합니다.

> 모듈 8 · 세션 48 · 1시간  
> 스켈레톤: `dmz/packages/vasp/src/governance/KeyGovernanceService.ts`

> ⚠️ **Phase 구분** — **Phase 1 해당**: 당사 보조키를 활용한 멀티시그 서명 참여 (VASP 주키 + 당사 보조키 구조). **Phase 3 해당**: 완전 자체 Custody 인가 이후 당사가 주키까지 직접 보관·서명하는 구조. Phase 1에서 당사는 서명 참여자이지 키 보관 주체가 아니다.

---

## 강의 파트 (25분)

### 1. SafeTx 생명주기 — 상태 전이 다이어그램

S47에서 설계한 흐름을 상태 전이 관점으로 정리한다.

```
                    ┌─────────────────────────────────────────────┐
                    │           SafeTx 상태 전이 (DB 관리)          │
                    └─────────────────────────────────────────────┘

                         proposeTx()
  (시작) ──────────────────────────────────► PENDING_SIGNATURES
                                                    │
                                  addSignature() ×n │  (collected < required)
                                  (반복 가능)        │
                                                    │ collected >= required
                                                    ▼
                                            READY_TO_EXECUTE
                                                    │
                                     executeTx()   │
                                                    ▼
                                               EXECUTED ◄── (종단: 온체인 확정)
                                                    
  PENDING_SIGNATURES ──── cancelTx() ────► CANCELLED ◄── (종단: 취소)
  READY_TO_EXECUTE   ────────────────────►

  [불가능한 전이]
  EXECUTED  → 어떤 상태로도 전이 불가 (실행 완료)
  CANCELLED → 어떤 상태로도 전이 불가 (취소 완료)
```

**왜 상태를 DB에서 관리하는가?**

Safe 컨트랙트는 서명 수집 상태를 온체인에 기록하지 않는다. 서명자들이 오프체인에서 각자 서명하고, 모아서 한 번에 제출한다. "현재 서명이 몇 개 모였는가"는 DB가 관리해야 한다.

```
온체인(Safe 컨트랙트):  서명 검증 + TX 실행만 담당
오프체인(DB):          서명 수집 현황 + 상태 추적 담당
```

---

### 2. KeyGovernanceService 설계 — 3가지 설계 결정

구현 전에 "왜 이렇게 설계했는가"를 이해한다.

**결정 1: 왜 서명 수를 DB에서 세는가?**

```
대안: Safe 컨트랙트에서 직접 조회
문제: Safe는 off-chain 서명(EIP-712)을 체인에 기록하지 않음
     → 체인을 조회해도 "서명이 몇 개 모였는지" 알 수 없음
     → 실행(execTransaction) 전까지 체인은 아무것도 모른다

해결: DB가 오프체인 서명 수집 대기열 역할
```

**결정 2: 왜 중복 서명을 서버에서 막는가?**

```
Safe 컨트랙트도 ecrecover로 서명자를 검증한다.
그런데 서비스 레이어에서도 중복을 검사한다.

이유:
  1. 조기 차단: 온체인 TX를 보내기 전에 서비스 레이어에서 막으면 가스 낭비 방지
  2. UX: 운영자에게 "이미 서명하셨습니다" 명확한 에러 메시지 제공
  3. 보안: 같은 서명자가 서명을 여러 번 제출해 threshold를 빠르게 채우는 시도 방지
```

**결정 3: executeTx에서 왜 Safe.execTransaction 전에 DB 상태를 확인하는가?**

```
흐름:
  1. DB에서 READY_TO_EXECUTE 확인 → 아니면 즉시 에러 (가스 낭비 없음)
  2. 서명들 DB에서 로드
  3. Safe.execTransaction 호출 (가스 소모)

이유:
  - 온체인 TX는 가스비가 발생한다
  - threshold를 충족하지 않으면 Safe가 GS020으로 revert → 가스만 낭비
  - 서비스 레이어에서 사전 차단 → 불필요한 온체인 호출 방지
```

---

### 3. DB 스키마 — pending_txs 테이블

```sql
CREATE TABLE pending_txs (
  id                   UUID PRIMARY KEY,
  tx_hash              VARCHAR(66) NOT NULL UNIQUE,  -- EIP-712 SafeTx 해시 (32바이트 hex)
  params               JSONB NOT NULL,               -- SafeTxParams (to, value, data, operation)
  status               VARCHAR(32) NOT NULL
                         DEFAULT 'PENDING_SIGNATURES'
                         CHECK (status IN (
                           'PENDING_SIGNATURES',
                           'READY_TO_EXECUTE',
                           'EXECUTED',
                           'CANCELLED'
                         )),
  required_signatures  INT NOT NULL,                 -- Safe threshold 값
  collected_signatures JSONB NOT NULL DEFAULT '[]',  -- [{signer, signature, signedAt}]
  proposed_by          VARCHAR(128) NOT NULL,
  proposed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_tx_hash     VARCHAR(66),                  -- 온체인 TX 해시 (EXECUTED 후 기록)
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- tx_hash로 빠른 조회 (중복 방지 + 조회 최적화)
CREATE UNIQUE INDEX idx_pending_txs_tx_hash ON pending_txs (tx_hash);

-- 활성 TX 목록 조회 (EXECUTED/CANCELLED 제외)
CREATE INDEX idx_pending_txs_active ON pending_txs (status)
  WHERE status IN ('PENDING_SIGNATURES', 'READY_TO_EXECUTE');
```

**`tx_hash UNIQUE` 제약이 중요한 이유:**

같은 SafeTx 내용은 항상 동일한 해시를 생성한다. 동일한 TX를 두 번 제안하면 DB UNIQUE 위반으로 즉시 차단된다. 실수로 동일한 업그레이드 TX를 두 번 제안하는 것을 방지한다.

---

### 4. 전체 호출 흐름 — Admin API → KeyGovernanceService → Safe

```
관리자 (Admin UI)
    │
    │  POST /admin/governance/propose
    │  { to, value, data, operation, travelRuleData? }
    ▼
AdminController.proposeGovernanceTx()
    │
    │  ADMIN_ROLE 확인 (requireRole 미들웨어)
    ▼
KeyGovernanceService.proposeTx()
    ├── Travel Rule 검증 (value >= 100만원이면 travelRuleData 필수)
    ├── safeClient.buildSafeTx(params) → SafeTx 구조체 생성
    ├── safeClient.calcTxHash(safeTx)  → EIP-712 해시 계산
    ├── DB INSERT pending_txs (PENDING_SIGNATURES)
    ├── auditLog.log(TX_PROPOSED)
    └── notifier.send(SIGNATURE_REQUESTED) → 서명자들에게 알림
    │
    │  (서명자 A가 알림 수신)
    │  POST /admin/governance/{txId}/sign
    │  { signer: "signerA", signature: "0x..." }
    ▼
KeyGovernanceService.addSignature()
    ├── DB 조회 + 상태 확인 (PENDING_SIGNATURES만 가능)
    ├── 중복 서명 방지
    ├── safeClient.verifySignature() → ecrecover 검증
    ├── DB UPDATE (collected_signatures 추가)
    ├── collected >= required → status = READY_TO_EXECUTE
    └── auditLog.log(SIGNATURE_ADDED)
    │
    │  (2-of-3 충족 → 실행자가 실행)
    │  POST /admin/governance/{txId}/execute
    ▼
KeyGovernanceService.executeTx()
    ├── DB 조회 + READY_TO_EXECUTE 확인
    ├── safeClient.execTransaction(params, collectedSigs) → 온체인 TX
    ├── DB UPDATE (EXECUTED + executed_tx_hash)
    └── auditLog.log(TX_EXECUTED)
```

---

## 실습 파트 (35분)

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
