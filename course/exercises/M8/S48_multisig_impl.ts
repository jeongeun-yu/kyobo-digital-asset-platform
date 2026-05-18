/**
 * S48 실습 — MultisigService 구현: proposeTx → addSignature → executeTx 전체 흐름
 *
 * 강의 노트: M8_S48_multisig_impl.md
 *
 * 실행 방법 (루트에서): npm run exercise:s48
 *
 * 목표:
 *   [1] proposeTx → PENDING_SIGNATURES 저장 + 서명자 알림 발송
 *   [2] addSignature: 1-of-3 → PENDING_SIGNATURES 유지
 *   [3] addSignature: 2-of-3 → READY_TO_EXECUTE + 실행 알림
 *   [4] 중복 서명 → DuplicateSignatureError
 *   [5] executeTx: threshold 미달(1-of-3) → revert (가스 낭비 방지)
 *   [6] executeTx: 2-of-3 충족 → Safe.execTransaction 호출 → EXECUTED
 *   [7] cancelTx: EXECUTED TX 취소 시도 → 에러
 */

import { ethers } from 'ethers';
import { randomUUID } from 'crypto';

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

export type PendingTxStatus = 'PENDING_SIGNATURES' | 'READY_TO_EXECUTE' | 'EXECUTED' | 'CANCELLED';

export interface SafeTxParams {
  to: string;
  value: bigint;
  data: string;
  operation: number;
  travelRuleData?: TravelRuleData | null;
}

export interface TravelRuleData {
  originatorName: string;
  originatorVasp: string;
  beneficiaryName: string;
  beneficiaryVasp: string;
  amount: bigint;
  currency: string;
}

export interface SignatureEntry {
  signer: string;
  signature: string;
  signedAt: Date;
}

export interface PendingTx {
  id: string;
  txHash: string;
  params: SafeTxParams;
  status: PendingTxStatus;
  requiredSignatures: number;
  collectedSignatures: SignatureEntry[];
  proposedBy: string;
  proposedAt: Date;
  executedTxHash?: string;
}

export interface SignatureStatus {
  collected: number;
  required: number;
  ready: boolean;
}

// ─── 커스텀 에러 ──────────────────────────────────────────────────────────────

export class TravelRuleRequiredError extends Error {
  constructor(amount: bigint) {
    super(`Travel Rule required for amount: ${amount} KRW (>= 1,000,000)`);
    this.name = 'TravelRuleRequiredError';
  }
}

export class DuplicateSignatureError extends Error {
  constructor(signer: string) {
    super(`DuplicateSignatureError: ${signer} already signed`);
    this.name = 'DuplicateSignatureError';
  }
}

export class PendingTxNotFoundError extends Error {
  constructor(txId: string) {
    super(`PendingTxNotFoundError: ${txId} not found`);
    this.name = 'PendingTxNotFoundError';
  }
}

// ─── Mock: GnosisSafeClient ───────────────────────────────────────────────────

export class MockGnosisSafeClient {
  private threshold: number;
  public execTransactionCallCount = 0;

  constructor(threshold = 2) {
    this.threshold = threshold;
  }

  async buildSafeTx(params: SafeTxParams): Promise<SafeTxParams> {
    return params; // 시뮬레이션: 파라미터 그대로 반환
  }

  async calcTxHash(params: SafeTxParams): Promise<string> {
    // 결정론적 해시 계산 시뮬레이션
    return ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify({ to: params.to, data: params.data, value: params.value.toString() })),
    );
  }

  async getThreshold(): Promise<number> {
    return this.threshold;
  }

  async verifySignature(txHash: string, signer: string, signature: string): Promise<boolean> {
    // 시뮬레이션: 서명 형식이 있으면 valid (테스트에서 조건 제어)
    try {
      const recovered = ethers.recoverAddress(txHash, signature);
      return recovered.toLowerCase() === signer.toLowerCase();
    } catch {
      // 테스트용 mock 서명은 always-valid로 처리
      return signature.startsWith('0x');
    }
  }

  async execTransaction(params: SafeTxParams, sigs: SignatureEntry[]): Promise<string> {
    this.execTransactionCallCount++;
    return `0xonchain${this.execTransactionCallCount.toString().padStart(60, '0')}`;
  }
}

// ─── Mock: InMemoryDatabase ───────────────────────────────────────────────────

export class InMemoryDatabase {
  private rows = new Map<string, PendingTx>();

  async insert(tx: PendingTx): Promise<void> {
    if ([...this.rows.values()].some(r => r.txHash === tx.txHash)) {
      throw new Error(`UNIQUE violation: tx_hash ${tx.txHash} already exists`);
    }
    this.rows.set(tx.id, { ...tx, collectedSignatures: [...tx.collectedSignatures] });
  }

  async findById(id: string): Promise<PendingTx | null> {
    const row = this.rows.get(id);
    return row ? { ...row, collectedSignatures: [...row.collectedSignatures] } : null;
  }

  async updateStatus(id: string, status: PendingTxStatus): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, status });
  }

  async updateSignatures(id: string, sigs: SignatureEntry[], status: PendingTxStatus): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, collectedSignatures: sigs, status });
  }

  async markExecuted(id: string, onChainTxHash: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, status: 'EXECUTED', executedTxHash: onChainTxHash });
  }

  getRow(id: string): PendingTx | undefined { return this.rows.get(id); }
}

// ─── Mock: AuditLogClient ─────────────────────────────────────────────────────

export class MockAuditLog {
  readonly entries: Array<{ actor: string; action: string }> = [];

  async log(entry: { actor: string; action: string; [k: string]: unknown }): Promise<void> {
    this.entries.push({ actor: entry.actor, action: entry.action });
  }

  lastAction(): string | undefined { return this.entries[this.entries.length - 1]?.action; }
}

// ─── Mock: Notifier ───────────────────────────────────────────────────────────

export class MockNotifier {
  readonly sent: Array<{ type: string; txId: string }> = [];

  async send(payload: { type: string; txId: string; [k: string]: unknown }): Promise<void> {
    this.sent.push({ type: payload.type, txId: payload.txId });
  }

  lastType(): string | undefined { return this.sent[this.sent.length - 1]?.type; }
}

// ─── KeyGovernanceService (S48 구현) ─────────────────────────────────────────

export const TRAVEL_RULE_THRESHOLD = BigInt(1_000_000);

export class KeyGovernanceService {
  constructor(
    private readonly safeClient: MockGnosisSafeClient,
    private readonly db: InMemoryDatabase,
    private readonly auditLog: MockAuditLog,
    private readonly notifier: MockNotifier,
  ) {}

  /**
   * TODO [1]: proposeTx 구현
   *
   * 요구사항:
   *   1. params.value >= TRAVEL_RULE_THRESHOLD이면 travelRuleData 필수
   *      없으면 TravelRuleRequiredError(params.value) throw
   *   2. this.safeClient.buildSafeTx(params) → safeTx
   *   3. this.safeClient.calcTxHash(safeTx) → txHash
   *   4. this.safeClient.getThreshold() → threshold
   *   5. PendingTx 객체 생성: id=randomUUID(), status='PENDING_SIGNATURES',
   *      collectedSignatures=[], proposedBy=proposer, proposedAt=new Date()
   *   6. this.db.insert(pendingTx)
   *   7. this.auditLog.log: actor=proposer, action='TX_PROPOSED'
   *   8. this.notifier.send: type='SIGNATURE_REQUESTED', txId=pendingTx.id
   *   9. pendingTx 반환
   */
  async proposeTx(proposer: string, params: SafeTxParams): Promise<PendingTx> {
    return undefined as never;
  }

  /**
   * TODO [2]: addSignature 구현
   *
   * 요구사항:
   *   1. this.db.findById(txId) → tx (없으면 PendingTxNotFoundError)
   *   2. tx.status !== 'PENDING_SIGNATURES' → 에러
   *   3. 이미 서명한 signer → DuplicateSignatureError(signer)
   *   4. this.safeClient.verifySignature(tx.txHash, signer, signature) → valid
   *      !valid → 에러
   *   5. 새 서명 추가, collected >= required이면 status → 'READY_TO_EXECUTE'
   *   6. this.db.updateSignatures(txId, newSigs, newStatus)
   *   7. this.auditLog.log: actor=signer, action='SIGNATURE_ADDED'
   *   8. ready이면 this.notifier.send: type='TX_READY_TO_EXECUTE'
   *   9. { collected, required, ready } 반환
   */
  async addSignature(txId: string, signer: string, signature: string): Promise<SignatureStatus> {
    return undefined as never;
  }

  /**
   * TODO [3]: executeTx 구현
   *
   * 요구사항:
   *   1. this.db.findById(txId) → tx (없으면 PendingTxNotFoundError)
   *   2. tx.status !== 'READY_TO_EXECUTE' → 에러 (메시지에 'not ready' 포함)
   *   3. this.safeClient.execTransaction(tx.params, tx.collectedSignatures) → onChainTxHash
   *   4. this.db.markExecuted(txId, onChainTxHash)
   *   5. this.auditLog.log: actor=executor, action='TX_EXECUTED'
   *   6. { onChainTxHash } 반환
   */
  async executeTx(txId: string, executor: string): Promise<{ onChainTxHash: string }> {
    return undefined as never;
  }

  /**
   * TODO [4]: getSigningStatus 구현 (제공됨 — 수정 불필요)
   *
   * this.db.findById(txId) → { collected, required, ready } 반환
   */
  async getSigningStatus(txId: string): Promise<SignatureStatus> {
    const tx = await this.db.findById(txId);
    if (!tx) throw new PendingTxNotFoundError(txId);
    const collected = tx.collectedSignatures.length;
    const required  = tx.requiredSignatures;
    return { collected, required, ready: collected >= required };
  }

  /**
   * TODO [5]: cancelTx 구현
   *
   * 요구사항:
   *   1. this.db.findById(txId) → tx (없으면 PendingTxNotFoundError)
   *   2. tx.status === 'EXECUTED' → 에러 (메시지: 'Cannot cancel already-executed transaction')
   *   3. this.db.updateStatus(txId, 'CANCELLED')
   *   4. this.auditLog.log: actor=cancelledBy, action='TX_CANCELLED'
   */
  async cancelTx(txId: string, cancelledBy: string, reason: string): Promise<void> {
    return undefined as never;
  }
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

async function expectError(
  label: string,
  fn: () => Promise<unknown>,
  errorCheck?: (err: Error) => boolean,
): Promise<void> {
  try {
    await fn();
    check(`${label} → 에러 발생해야 함`, false);
  } catch (err) {
    if (errorCheck) {
      check(label, errorCheck(err as Error));
    } else {
      check(label, true);
    }
  }
}

function makeService(threshold = 2): {
  service: KeyGovernanceService;
  safeClient: MockGnosisSafeClient;
  db: InMemoryDatabase;
  auditLog: MockAuditLog;
  notifier: MockNotifier;
} {
  const safeClient = new MockGnosisSafeClient(threshold);
  const db         = new InMemoryDatabase();
  const auditLog   = new MockAuditLog();
  const notifier   = new MockNotifier();
  return { service: new KeyGovernanceService(safeClient, db, auditLog, notifier), safeClient, db, auditLog, notifier };
}

const baseTxParams: SafeTxParams = {
  to: '0xc0de000000000000000000000000000000000001',
  value: 0n,
  data: '0x8456cb59',
  operation: 0,
};

// ─── 실습 진입점 ──────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S48: KeyGovernanceService — 2-of-3 MultisigService 구현 ===\n');

  // ── [1] proposeTx → PENDING_SIGNATURES + 알림 ───────────────────────
  console.log('[검증 1] proposeTx → PENDING_SIGNATURES 저장 + 서명자 알림');

  const { service: svc1, auditLog: al1, notifier: nt1 } = makeService();
  const tx1 = await svc1.proposeTx('vasp-admin', baseTxParams);

  check('status: PENDING_SIGNATURES', tx1.status === 'PENDING_SIGNATURES');
  check('requiredSignatures: 2 (threshold)', tx1.requiredSignatures === 2);
  check('collectedSignatures: 0개', tx1.collectedSignatures.length === 0);
  check('txHash: 32바이트 hex', /^0x[0-9a-f]{64}$/.test(tx1.txHash));
  check('감사 로그 action: TX_PROPOSED', al1.lastAction() === 'TX_PROPOSED');
  check('알림 type: SIGNATURE_REQUESTED', nt1.lastType() === 'SIGNATURE_REQUESTED');

  // ── [2] addSignature: 1-of-3 → PENDING_SIGNATURES 유지 ──────────────
  console.log('\n[검증 2] 서명자 A 1명 서명 → PENDING_SIGNATURES 유지');

  const { service: svc2 } = makeService();
  const tx2  = await svc2.proposeTx('admin', baseTxParams);
  const st2A = await svc2.addSignature(tx2.id, '0xa111a000000000000000000000000000000000a1', '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');

  check('collected: 1', st2A.collected === 1);
  check('required: 2',  st2A.required  === 2);
  check('ready: false', st2A.ready     === false);

  const dbRow2 = (await (() => { const db = makeService(); return db; })());
  // DB 상태 확인: 직접 service로 조회
  const sigStatus2 = await svc2.getSigningStatus(tx2.id);
  check('getSigningStatus.ready: false (실행 불가)', !sigStatus2.ready);

  // ── [3] addSignature: 2-of-3 → READY_TO_EXECUTE + 실행 알림 ────────
  console.log('\n[검증 3] 서명자 A, B 서명 → READY_TO_EXECUTE + 실행 알림');

  const { service: svc3, notifier: nt3, db: db3 } = makeService();
  const tx3 = await svc3.proposeTx('admin', baseTxParams);

  await svc3.addSignature(tx3.id, '0xa111a000000000000000000000000000000000a1', '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
  const st3B = await svc3.addSignature(tx3.id, '0xb111b000000000000000000000000000000000b1', '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b11b');

  check('collected: 2', st3B.collected === 2);
  check('ready: true',  st3B.ready     === true);
  check('알림 type: TX_READY_TO_EXECUTE', nt3.lastType() === 'TX_READY_TO_EXECUTE');

  const dbRow3 = db3.getRow(tx3.id);
  check('DB status: READY_TO_EXECUTE', dbRow3?.status === 'READY_TO_EXECUTE');
  check('DB collectedSignatures: 2개', dbRow3?.collectedSignatures.length === 2);

  // ── [4] 중복 서명 → DuplicateSignatureError ─────────────────────────
  console.log('\n[검증 4] 같은 서명자가 두 번 서명 → DuplicateSignatureError');

  const { service: svc4 } = makeService();
  const tx4 = await svc4.proposeTx('admin', baseTxParams);
  await svc4.addSignature(tx4.id, '0xa111a000000000000000000000000000000000a1', '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');

  await expectError(
    'DuplicateSignatureError 발생',
    () => svc4.addSignature(tx4.id, '0xa111a000000000000000000000000000000000a1', '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a21b'),
    err => err.name === 'DuplicateSignatureError',
  );

  // ── [5] executeTx: threshold 미달 → revert (Safe 호출 없음) ─────────
  console.log('\n[검증 5] 1-of-3 서명만으로 executeTx → revert (threshold 미달)');

  const { service: svc5, safeClient: sc5 } = makeService();
  const tx5 = await svc5.proposeTx('admin', baseTxParams);
  await svc5.addSignature(tx5.id, '0xa111a000000000000000000000000000000000a1', '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
  // 서명자 B 없음

  await expectError(
    'threshold 미달 → not ready 에러',
    () => svc5.executeTx(tx5.id, 'executor'),
    err => /not ready/i.test(err.message),
  );
  check('Safe.execTransaction 호출 안 됨 (가스 낭비 방지)', sc5.execTransactionCallCount === 0);

  // 서명 없이 바로 실행 시도
  const { service: svc5b, safeClient: sc5b } = makeService();
  const tx5b = await svc5b.proposeTx('admin', baseTxParams);
  await expectError('서명 0개 → not ready 에러', () => svc5b.executeTx(tx5b.id, 'executor'));
  check('Safe.execTransaction 호출 없음', sc5b.execTransactionCallCount === 0);

  // ── [6] executeTx: 2-of-3 → Safe.execTransaction → EXECUTED ─────────
  console.log('\n[검증 6] 2-of-3 서명 후 executeTx → Safe.execTransaction + EXECUTED');

  const { service: svc6, safeClient: sc6, db: db6, auditLog: al6 } = makeService();
  const tx6 = await svc6.proposeTx('admin', baseTxParams);
  await svc6.addSignature(tx6.id, '0xa111a000000000000000000000000000000000a1', '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11b');
  await svc6.addSignature(tx6.id, '0xb111b000000000000000000000000000000000b1', '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b11b');

  const execResult = await svc6.executeTx(tx6.id, 'executor');

  check('Safe.execTransaction 호출 1회', sc6.execTransactionCallCount === 1);
  check('onChainTxHash: 0x로 시작',    /^0x/.test(execResult.onChainTxHash));
  check('감사 로그 action: TX_EXECUTED', al6.lastAction() === 'TX_EXECUTED');

  const dbRow6 = db6.getRow(tx6.id);
  check('DB status: EXECUTED',         dbRow6?.status           === 'EXECUTED');
  check('DB executedTxHash 기록됨',    dbRow6?.executedTxHash   === execResult.onChainTxHash);

  // ── [7] cancelTx: EXECUTED TX 취소 시도 → 에러 ──────────────────────
  console.log('\n[검증 7] EXECUTED TX 취소 시도 → already-executed 에러');

  await expectError(
    'EXECUTED TX cancelTx → 에러',
    () => svc6.cancelTx(tx6.id, 'admin', '취소 시도'),
    err => /already-executed/i.test(err.message),
  );

  // 취소 가능 케이스: PENDING_SIGNATURES → CANCELLED
  const { service: svc7, db: db7 } = makeService();
  const tx7 = await svc7.proposeTx('admin', baseTxParams);
  await svc7.cancelTx(tx7.id, 'admin', '계획 변경');

  const dbRow7 = db7.getRow(tx7.id);
  check('PENDING_SIGNATURES TX 취소 → CANCELLED', dbRow7?.status === 'CANCELLED');

  // 중복 제안 방지 (tx_hash UNIQUE)
  console.log('\n[보너스] 동일 TX 중복 제안 → UNIQUE 위반');
  const { service: svcDup, db: dbDup } = makeService();
  const txDup = await svcDup.proposeTx('admin', baseTxParams);
  await expectError(
    '동일 SafeTx 두 번 제안 → UNIQUE 위반',
    () => svcDup.proposeTx('admin', baseTxParams), // 동일 파라미터
    err => /UNIQUE/i.test(err.message),
  );

  // ─── 정리 ───────────────────────────────────────────────────────────────
  console.log('\n=== S48 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. DB가 오프체인 서명 수집 대기열 — Safe 컨트랙트는 실행 시점에만 서명 검증');
  console.log('  2. 중복 서명: 서비스 레이어에서 조기 차단 → 가스 낭비 방지 + 명확한 UX');
  console.log('  3. executeTx: DB READY_TO_EXECUTE 선확인 → 온체인 TX (가스 낭비 방지)');
  console.log('  4. EXECUTED 상태는 종단 — 취소/재전이 불가 (온체인 확정 반영)');
  console.log('  5. tx_hash UNIQUE: 동일 TX 중복 제안 → DB 레벨 차단 (실수 방지)');
})();
