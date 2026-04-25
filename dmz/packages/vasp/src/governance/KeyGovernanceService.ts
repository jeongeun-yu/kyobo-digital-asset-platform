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
    // Travel Rule 검증
    if (params.value >= KeyGovernanceService.TRAVEL_RULE_THRESHOLD) {
      if (!params.travelRuleData) {
        throw new TravelRuleRequiredError(params.value);
      }
    }

    // TODO:
    // 1. safeClient.buildSafeTx(params) → EIP-712 SafeTx struct 생성
    // 2. safeClient.calcTxHash(safeTx) → txHash 계산
    // 3. threshold = await safeClient.getThreshold()
    // 4. DB INSERT INTO pending_txs:
    //    (id=UUID, tx_hash, params=JSON, status='PENDING_SIGNATURES',
    //     required_signatures=threshold, collected_signatures='[]',
    //     proposed_by=proposer, proposed_at=NOW())
    // 5. auditLog.log({ actor: proposer, action: 'TX_PROPOSED', resourceId: id, afterState: pendingTx })
    // 6. notifier.send({ type: 'SIGNATURE_REQUESTED', txId: id, proposer, requiredSignatures: threshold })
    // return pendingTx
    throw new Error('Not implemented');
  }

  async addSignature(
    txId: string,
    signer: string,
    signature: string,
  ): Promise<SignatureStatus> {
    // TODO:
    // 1. DB에서 pending_txs WHERE id = txId 조회
    //    없으면 PendingTxNotFoundError
    //    status !== 'PENDING_SIGNATURES' 이면 throw
    // 2. 이미 이 signer가 서명했으면 DuplicateSignatureError
    // 3. safeClient.verifySignature(txHash, signer, signature) — 서명 검증
    // 4. collected_signatures에 { signer, signature, signedAt: NOW() } 추가
    // 5. DB UPDATE
    // 6. auditLog.log({ action: 'SIGNATURE_ADDED', ... })
    // 7. collected >= required 이면 status → 'READY_TO_EXECUTE' + notifier.send(TX_READY_TO_EXECUTE)
    // return { collected, required, ready }
    throw new Error('Not implemented');
  }

  async executeTx(txId: string, executor: string): Promise<{ onChainTxHash: string }> {
    // TODO:
    // 1. pending_txs 조회 — status !== 'READY_TO_EXECUTE' 이면 throw NotReadyError
    // 2. safeClient.execTransaction(params, collectedSignatures)
    // 3. status → 'EXECUTED', executed_tx_hash = onChainTxHash
    // 4. auditLog.log({ action: 'TX_EXECUTED', actor: executor, ... })
    // 5. return { onChainTxHash }
    throw new Error('Not implemented');
  }

  async getSigningStatus(txId: string): Promise<SignatureStatus> {
    // TODO: pending_txs 조회 → { collected, required, ready } 반환
    throw new Error('Not implemented');
  }

  async cancelTx(txId: string, cancelledBy: string, reason: string): Promise<void> {
    // TODO:
    // 1. pending_txs 조회 — status가 EXECUTED면 throw AlreadyExecutedError
    // 2. status → 'CANCELLED'
    // 3. auditLog.log({ action: 'TX_CANCELLED', actor: cancelledBy, afterState: { reason } })
    throw new Error('Not implemented');
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
