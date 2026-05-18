/**
 * S48 채점 — MultisigService 구현: proposeTx → addSignature → executeTx 전체 흐름
 *
 * 채점 기준:
 *   · proposeTx → PENDING_SIGNATURES 저장 + SIGNATURE_REQUESTED 알림
 *   · addSignature 1-of-3 → PENDING_SIGNATURES 유지
 *   · addSignature 2-of-3 → READY_TO_EXECUTE + TX_READY_TO_EXECUTE 알림
 *   · 중복 서명 → DuplicateSignatureError
 *   · threshold 미달 executeTx → not ready 에러, Safe 미호출
 *   · 2-of-3 충족 executeTx → Safe.execTransaction + EXECUTED
 */

import {
  KeyGovernanceService,
  MockGnosisSafeClient,
  InMemoryDatabase,
  MockAuditLog,
  MockNotifier,
  SafeTxParams,
} from '../M8/S48_multisig_impl';

// ─── 픽스처 팩토리 ───────────────────────────────────────────────────────────

function makeService(threshold = 2) {
  const safeClient = new MockGnosisSafeClient(threshold);
  const db         = new InMemoryDatabase();
  const auditLog   = new MockAuditLog();
  const notifier   = new MockNotifier();
  return { service: new KeyGovernanceService(safeClient, db, auditLog, notifier), safeClient, db, auditLog, notifier };
}

const BASE_TX: SafeTxParams = {
  to: '0xc0de000000000000000000000000000000000001',
  value: 0n,
  data: '0x8456cb59',
  operation: 0,
};

const SIGNER_A = '0xa111a000000000000000000000000000000000a1';
const SIGNER_B = '0xb111b000000000000000000000000000000000b1';

// ─── 채점 테스트 ─────────────────────────────────────────────────────────────

describe('S48 채점 — MultisigService', () => {

  describe('TODO: proposeTx → PENDING_SIGNATURES 저장 + SIGNATURE_REQUESTED 알림', () => {
    it('status: PENDING_SIGNATURES', async () => {
      const { service } = makeService();
      const tx = await service.proposeTx('vasp-admin', BASE_TX);
      expect(tx.status).toBe('PENDING_SIGNATURES');
    });

    it('requiredSignatures: threshold(2)', async () => {
      const { service } = makeService();
      const tx = await service.proposeTx('vasp-admin', BASE_TX);
      expect(tx.requiredSignatures).toBe(2);
    });

    it('collectedSignatures: 0개', async () => {
      const { service } = makeService();
      const tx = await service.proposeTx('vasp-admin', BASE_TX);
      expect(tx.collectedSignatures).toHaveLength(0);
    });

    it('txHash: 32바이트 hex', async () => {
      const { service } = makeService();
      const tx = await service.proposeTx('vasp-admin', BASE_TX);
      expect(tx.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('감사 로그 action: TX_PROPOSED', async () => {
      const { service, auditLog } = makeService();
      await service.proposeTx('vasp-admin', BASE_TX);
      expect(auditLog.lastAction()).toBe('TX_PROPOSED');
    });

    it('알림 type: SIGNATURE_REQUESTED', async () => {
      const { service, notifier } = makeService();
      await service.proposeTx('vasp-admin', BASE_TX);
      expect(notifier.lastType()).toBe('SIGNATURE_REQUESTED');
    });
  });

  describe('TODO: addSignature 1-of-3 → PENDING_SIGNATURES 유지', () => {
    it('collected: 1, required: 2, ready: false', async () => {
      const { service } = makeService();
      const tx  = await service.proposeTx('admin', BASE_TX);
      const st  = await service.addSignature(tx.id, SIGNER_A, '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
      expect(st.collected).toBe(1);
      expect(st.required).toBe(2);
      expect(st.ready).toBe(false);
    });

    it('getSigningStatus.ready: false (실행 불가)', async () => {
      const { service } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await service.addSignature(tx.id, SIGNER_A, '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
      const status = await service.getSigningStatus(tx.id);
      expect(status.ready).toBe(false);
    });
  });

  describe('TODO: addSignature 2-of-3 → READY_TO_EXECUTE + TX_READY_TO_EXECUTE 알림', () => {
    it('collected: 2, ready: true', async () => {
      const { service } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await service.addSignature(tx.id, SIGNER_A, '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
      const st = await service.addSignature(tx.id, SIGNER_B, '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b11b');
      expect(st.collected).toBe(2);
      expect(st.ready).toBe(true);
    });

    it('DB status: READY_TO_EXECUTE', async () => {
      const { service, db } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await service.addSignature(tx.id, SIGNER_A, '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
      await service.addSignature(tx.id, SIGNER_B, '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b11b');
      expect(db.getRow(tx.id)?.status).toBe('READY_TO_EXECUTE');
    });

    it('DB collectedSignatures: 2개', async () => {
      const { service, db } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await service.addSignature(tx.id, SIGNER_A, '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
      await service.addSignature(tx.id, SIGNER_B, '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b11b');
      expect(db.getRow(tx.id)?.collectedSignatures).toHaveLength(2);
    });

    it('알림 type: TX_READY_TO_EXECUTE', async () => {
      const { service, notifier } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await service.addSignature(tx.id, SIGNER_A, '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
      await service.addSignature(tx.id, SIGNER_B, '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b11b');
      expect(notifier.lastType()).toBe('TX_READY_TO_EXECUTE');
    });
  });

  describe('TODO: 중복 서명 → DuplicateSignatureError', () => {
    it('같은 서명자가 두 번 서명 → DuplicateSignatureError', async () => {
      const { service } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await service.addSignature(tx.id, SIGNER_A, '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
      await expect(
        service.addSignature(tx.id, SIGNER_A, '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a21b'),
      ).rejects.toMatchObject({ name: 'DuplicateSignatureError' });
    });

    it('DuplicateSignatureError 는 Error 의 인스턴스', async () => {
      const { service } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await service.addSignature(tx.id, SIGNER_A, '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
      await expect(
        service.addSignature(tx.id, SIGNER_A, '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a21b'),
      ).rejects.toBeInstanceOf(Error);
    });
  });

  describe('TODO: threshold 미달 executeTx → 차단 (가스 낭비 방지)', () => {
    it('1-of-3 서명만으로 executeTx → not ready 에러', async () => {
      const { service } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await service.addSignature(tx.id, SIGNER_A, '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
      await expect(service.executeTx(tx.id, 'executor')).rejects.toThrow(/not ready/i);
    });

    it('1-of-3 차단 시 Safe.execTransaction 미호출 (가스 낭비 방지)', async () => {
      const { service, safeClient } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await service.addSignature(tx.id, SIGNER_A, '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
      try { await service.executeTx(tx.id, 'executor'); } catch { /* expected */ }
      expect(safeClient.execTransactionCallCount).toBe(0);
    });

    it('서명 0개로 executeTx → not ready 에러', async () => {
      const { service } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await expect(service.executeTx(tx.id, 'executor')).rejects.toThrow(/not ready/i);
    });

    it('서명 0개 차단 시 Safe.execTransaction 미호출', async () => {
      const { service, safeClient } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      try { await service.executeTx(tx.id, 'executor'); } catch { /* expected */ }
      expect(safeClient.execTransactionCallCount).toBe(0);
    });
  });

  describe('TODO: 2-of-3 충족 → Safe.execTransaction + EXECUTED', () => {
    async function prepareExecuted() {
      const { service, safeClient, db, auditLog } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await service.addSignature(tx.id, SIGNER_A, '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
      await service.addSignature(tx.id, SIGNER_B, '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b11b');
      const result = await service.executeTx(tx.id, 'executor');
      return { service, safeClient, db, auditLog, tx, result };
    }

    it('Safe.execTransaction 1회 호출', async () => {
      const { safeClient } = await prepareExecuted();
      expect(safeClient.execTransactionCallCount).toBe(1);
    });

    it('onChainTxHash: 0x로 시작', async () => {
      const { result } = await prepareExecuted();
      expect(result.onChainTxHash).toMatch(/^0x/);
    });

    it('감사 로그 action: TX_EXECUTED', async () => {
      const { auditLog } = await prepareExecuted();
      expect(auditLog.lastAction()).toBe('TX_EXECUTED');
    });

    it('DB status: EXECUTED', async () => {
      const { db, tx } = await prepareExecuted();
      expect(db.getRow(tx.id)?.status).toBe('EXECUTED');
    });

    it('DB executedTxHash 기록됨', async () => {
      const { db, tx, result } = await prepareExecuted();
      expect(db.getRow(tx.id)?.executedTxHash).toBe(result.onChainTxHash);
    });
  });

  describe('EXECUTED TX 취소 시도 → 에러', () => {
    it('EXECUTED TX cancelTx → already-executed 에러', async () => {
      const { service } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await service.addSignature(tx.id, SIGNER_A, '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
      await service.addSignature(tx.id, SIGNER_B, '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b11b');
      await service.executeTx(tx.id, 'executor');
      await expect(service.cancelTx(tx.id, 'admin', '취소 시도')).rejects.toThrow(/already-executed/i);
    });

    it('PENDING_SIGNATURES TX 취소 → CANCELLED', async () => {
      const { service, db } = makeService();
      const tx = await service.proposeTx('admin', BASE_TX);
      await service.cancelTx(tx.id, 'admin', '계획 변경');
      expect(db.getRow(tx.id)?.status).toBe('CANCELLED');
    });
  });

  describe('동일 TX 중복 제안 → UNIQUE 위반', () => {
    it('동일 SafeTx 두 번 제안 → UNIQUE 에러', async () => {
      const { service } = makeService();
      await service.proposeTx('admin', BASE_TX);
      await expect(service.proposeTx('admin', BASE_TX)).rejects.toThrow(/UNIQUE/i);
    });
  });
});
