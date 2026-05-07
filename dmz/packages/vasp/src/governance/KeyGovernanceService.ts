/**
 * KeyGovernanceService — Gnosis Safe 기반 다중 서명 키 거버넌스
 *
 * M8 S46~S49 핵심 개념:
 *   커리큘럼에서 "MultisigService"로 언급되는 서비스가 이 파일임.
 *   (스켈레톤에서는 키 거버넌스 전체 책임을 담당하므로 KeyGovernanceService로 명명)
 *
 * SafeTx 생명주기 (S47~S48):
 *   proposeTx()     — SafeTx 해시 계산 + DB 저장
 *   addSignature()  — 오프체인 EIP-712 서명 수집
 *   executeTx()     — threshold 확인 → Safe.execTransaction 온체인 실행
 *
 * Travel Rule (S49):
 *   checkTravelRule() — 100만원 이상 NFT 전송 시 TravelRuleRequiredError
 *   SafeTxParams.travelRuleData 필드에 정보 첨부
 *
 * 의존 방향:
 *   KeyGovernanceService → GnosisSafeClient (온체인 실행)
 *                        → AuditLogService (모든 거버넌스 행위 감사 로그)
 *
 * ── 교육생 안내 ──────────────────────────────────────────────────────────────
 * 역할: 참고용 구현체 — 수정하지 말 것
 * 실습: M8 S46~S49 (Gnosis Safe 멀티시그 · Travel Rule) — 별도 실습 파일 없음
 *       이 파일을 읽고 SafeTx 생명주기(propose → addSignature → execute)를 이해할 것
 */

import { randomUUID } from 'crypto';

export type PendingTxStatus =
  | 'PENDING_SIGNATURES'
  | 'READY_TO_EXECUTE'
  | 'EXECUTED'
  | 'CANCELLED';

export interface SafeTxParams {
  to: string;
  value: bigint;
  data: string;           // ABI-encoded call data
  operation: 0 | 1;       // 0=CALL, 1=DELEGATECALL
  travelRuleData?: TravelRuleData;
}

export interface TravelRuleData {
  originatorName: string;
  originatorVasp: string;
  beneficiaryName: string;
  beneficiaryVasp: string;
  amount: bigint;
  currency: string;
}

export interface PendingTx {
  id: string;             // UUID
  txHash: string;         // EIP-712 Safe TX hash
  params: SafeTxParams;
  status: PendingTxStatus;
  requiredSignatures: number;
  collectedSignatures: SignatureEntry[];
  proposedBy: string;
  proposedAt: Date;
  executedTxHash?: string;
}

export interface SignatureEntry {
  signer: string;
  signature: string;
  signedAt: Date;
}

export interface SignatureStatus {
  collected: number;
  required: number;
  ready: boolean;
}

/**
 * KeyGovernanceService — Gnosis Safe 멀티시그 관리
 *
 * Phase 1 키 구조 (2-of-3):
 *   서명자 A: 교보생명 운영키 (AWS KMS)
 *   서명자 B: VASP 운영키 (VASP HSM)
 *   서명자 C: 교보생명 Cold Key (오프라인 HSM, 비상용)
 *
 * Travel Rule 적용:
 *   100만원(1,000,000 KRW) 이상 이체 시 travelRuleData 필수 (특금법 §8의4)
 */
export class KeyGovernanceService {
  private static readonly TRAVEL_RULE_THRESHOLD = BigInt(1_000_000);

  constructor(
    private readonly safeClient: GnosisSafeClient,
    private readonly db: DatabaseClient,
    private readonly auditLog: AuditLogClient,
    private readonly notifier: Notifier,
  ) {}

  async proposeTx(proposer: string, params: SafeTxParams): Promise<PendingTx> {
    if (params.value >= KeyGovernanceService.TRAVEL_RULE_THRESHOLD) {
      if (!params.travelRuleData) throw new TravelRuleRequiredError(params.value);
    }

    const safeTx    = await this.safeClient.buildSafeTx(params);
    const txHash    = await this.safeClient.calcTxHash(safeTx);
    const threshold = await this.safeClient.getThreshold();
    const id        = randomUUID();
    const now       = new Date();

    const pendingTx: PendingTx = {
      id,
      txHash,
      params,
      status:               'PENDING_SIGNATURES',
      requiredSignatures:   threshold,
      collectedSignatures:  [],
      proposedBy:           proposer,
      proposedAt:           now,
    };

    await this.db.query(
      `INSERT INTO pending_txs
         (id, tx_hash, params, status, required_signatures, collected_signatures, proposed_by, proposed_at)
       VALUES ($1,$2,$3,'PENDING_SIGNATURES',$4,'[]',$5,$6)`,
      [id, txHash, JSON.stringify(params), threshold, proposer, now.toISOString()],
    );

    await this.auditLog.log({ actor: proposer, action: 'TX_PROPOSED', resourceId: id, afterState: pendingTx });
    await this.notifier.send({ type: 'SIGNATURE_REQUESTED', txId: id, proposer, requiredSignatures: threshold });

    return pendingTx;
  }

  async addSignature(txId: string, signer: string, signature: string): Promise<SignatureStatus> {
    const tx = await this._getTxOrThrow(txId);

    if (tx.status !== 'PENDING_SIGNATURES') {
      throw new Error(`Cannot add signature to tx in status: ${tx.status}`);
    }
    if (tx.collectedSignatures.some(s => s.signer === signer)) {
      throw new DuplicateSignatureError(signer);
    }

    const valid = await this.safeClient.verifySignature(tx.txHash, signer, signature);
    if (!valid) throw new Error(`Invalid signature from signer: ${signer}`);

    const entry: SignatureEntry = { signer, signature, signedAt: new Date() };
    tx.collectedSignatures.push(entry);

    const ready = tx.collectedSignatures.length >= tx.requiredSignatures;
    const newStatus = ready ? 'READY_TO_EXECUTE' : 'PENDING_SIGNATURES';

    await this.db.query(
      `UPDATE pending_txs SET collected_signatures=$1, status=$2 WHERE id=$3`,
      [JSON.stringify(tx.collectedSignatures), newStatus, txId],
    );

    await this.auditLog.log({ actor: signer, action: 'SIGNATURE_ADDED', resourceId: txId, afterState: { signer, status: newStatus } });

    if (ready) {
      await this.notifier.send({ type: 'TX_READY_TO_EXECUTE', txId });
    }

    return { collected: tx.collectedSignatures.length, required: tx.requiredSignatures, ready };
  }

  async executeTx(txId: string, executor: string): Promise<{ onChainTxHash: string }> {
    const tx = await this._getTxOrThrow(txId);

    if (tx.status !== 'READY_TO_EXECUTE') {
      throw new Error(`TX not ready to execute, current status: ${tx.status}`);
    }

    const onChainTxHash = await this.safeClient.execTransaction(tx.params, tx.collectedSignatures);

    await this.db.query(
      `UPDATE pending_txs SET status='EXECUTED', executed_tx_hash=$1 WHERE id=$2`,
      [onChainTxHash, txId],
    );

    await this.auditLog.log({ actor: executor, action: 'TX_EXECUTED', resourceId: txId, afterState: { onChainTxHash } });

    return { onChainTxHash };
  }

  async getSigningStatus(txId: string): Promise<SignatureStatus> {
    const tx = await this._getTxOrThrow(txId);
    const collected = tx.collectedSignatures.length;
    const required  = tx.requiredSignatures;
    return { collected, required, ready: collected >= required };
  }

  async cancelTx(txId: string, cancelledBy: string, reason: string): Promise<void> {
    const tx = await this._getTxOrThrow(txId);

    if (tx.status === 'EXECUTED') {
      throw new Error(`Cannot cancel already executed tx: ${txId}`);
    }

    await this.db.query(
      `UPDATE pending_txs SET status='CANCELLED' WHERE id=$1`,
      [txId],
    );

    await this.auditLog.log({ actor: cancelledBy, action: 'TX_CANCELLED', resourceId: txId, afterState: { reason } });
  }

  private async _getTxOrThrow(txId: string): Promise<PendingTx> {
    const { rows } = await this.db.query(
      'SELECT * FROM pending_txs WHERE id=$1',
      [txId],
    );
    if (rows.length === 0) throw new PendingTxNotFoundError(txId);
    const r = rows[0]!;
    return {
      id:                  r['id'] as string,
      txHash:              r['tx_hash'] as string,
      params:              JSON.parse(r['params'] as string) as SafeTxParams,
      status:              r['status'] as PendingTxStatus,
      requiredSignatures:  r['required_signatures'] as number,
      collectedSignatures: JSON.parse(r['collected_signatures'] as string) as SignatureEntry[],
      proposedBy:          r['proposed_by'] as string,
      proposedAt:          new Date(r['proposed_at'] as string),
      executedTxHash:      r['executed_tx_hash'] as string | undefined,
    };
  }
}

// ── Errors ────────────────────────────────────────────────────

export class TravelRuleRequiredError extends Error {
  constructor(amount: bigint) {
    super(`Travel Rule data required for amount ${amount} (≥1,000,000 KRW)`);
    this.name = 'TravelRuleRequiredError';
  }
}

export class PendingTxNotFoundError extends Error {
  constructor(txId: string) {
    super(`PendingTx not found: ${txId}`);
    this.name = 'PendingTxNotFoundError';
  }
}

export class DuplicateSignatureError extends Error {
  constructor(signer: string) {
    super(`Signer ${signer} has already signed this transaction`);
    this.name = 'DuplicateSignatureError';
  }
}

// ── Interfaces ────────────────────────────────────────────────

interface GnosisSafeClient {
  buildSafeTx(params: SafeTxParams): Promise<unknown>;
  calcTxHash(safeTx: unknown): Promise<string>;
  getThreshold(): Promise<number>;
  verifySignature(txHash: string, signer: string, sig: string): Promise<boolean>;
  execTransaction(params: SafeTxParams, signatures: SignatureEntry[]): Promise<string>;
}

interface DatabaseClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface AuditLogClient {
  log(entry: {
    actor: string;
    action: string;
    resourceType?: string;
    resourceId: string;
    beforeState?: unknown;
    afterState: unknown;
  }): Promise<void>;
}

interface Notifier {
  send(event: { type: string; [key: string]: unknown }): Promise<void>;
}
