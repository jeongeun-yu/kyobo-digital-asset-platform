import type { LedgerService, MintStatus } from '@kyobo/core-banking';

export type FailureReason = 'REVERT' | 'OUT_OF_GAS' | 'NONCE_TOO_LOW' | 'TIMEOUT' | 'NETWORK_ERROR';

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: FailureReason[];
  nonRetryableErrors: FailureReason[];
}

export interface RecoveryResult {
  requestId: string;
  action: 'FAILED' | 'RESUBMITTED' | 'POLLING';
  newTxHash?: string;
  message: string;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  retryableErrors: ['OUT_OF_GAS', 'NONCE_TOO_LOW', 'NETWORK_ERROR'],
  nonRetryableErrors: ['REVERT'],
};

/**
 * VaspRecoveryService — TX 실패·Reorg 복구
 *
 * TX 실패 유형별 대응 전략:
 *   REVERT        → 즉시 FAILED (재시도 없음)
 *   OUT_OF_GAS    → gasLimit * 1.2로 재시도
 *   NONCE_TOO_LOW → nonce 재동기화 후 재시도
 *   TIMEOUT       → SUBMITTED 유지, 폴링 대기
 *   REORG         → MINED → REORGED 전이, 새 TX로 재제출 (FINALIZED 이전에만 가능)
 */
export class VaspRecoveryService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly vaspClient: VaspClient,
    private readonly notifier: Notifier,
    private readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  async handleTxRevert(requestId: string, txHash: string, reason: string): Promise<RecoveryResult> {
    // TODO:
    // 1. ledger.getMintRequest(requestId) — 없으면 MintRequestNotFoundError
    // 2. status !== 'SUBMITTED' 이면 InvalidStateTransitionError
    // 3. ledger.updateMintRequest(requestId, { status: 'FAILED', txHash, errorMsg: reason })
    // 4. notifier.send({ type: 'TX_FAILED', requestId, txHash, reason })
    // return { requestId, action: 'FAILED', message: `TX reverted: ${reason}` }
    throw new Error('Not implemented');
  }

  async handleTxTimeout(requestId: string, txHash: string): Promise<RecoveryResult> {
    // TODO:
    // TIMEOUT은 즉시 실패가 아님 — SUBMITTED 유지하고 폴링 대기
    // 1. ledger.getMintRequest(requestId)
    // 2. 운영팀 알림만 발송 (상태 변경 없음)
    // 3. notifier.send({ type: 'TX_TIMEOUT_ALERT', requestId, txHash })
    // return { requestId, action: 'POLLING', message: 'Kept SUBMITTED, polling will resolve' }
    throw new Error('Not implemented');
  }

  async handleNonceConflict(requestId: string): Promise<RecoveryResult> {
    // TODO:
    // 1. vaspClient.resyncNonce() — 최신 nonce 재동기화
    // 2. 원래 TX 데이터로 재제출 (새 nonce, 새 gasPrice)
    // 3. ledger.updateMintRequest(requestId, { status: 'SUBMITTED', txHash: newTxHash })
    // return { requestId, action: 'RESUBMITTED', newTxHash, message: 'Resubmitted after nonce resync' }
    throw new Error('Not implemented');
  }

  async handleReorg(
    requestId: string,
    originalTxHash: string,
    detectedAtBlock: number,
  ): Promise<RecoveryResult> {
    // TODO:
    // 1. ledger.getMintRequest(requestId)
    // 2. status가 'MINED'가 아니면 throw (REORG는 MINED 구간에서만 발생, FINALIZED 이후 불가)
    // 3. ledger.updateMintRequest(requestId, { status: 'REORGED', errorMsg: `Reorg at block ${detectedAtBlock}` })
    // 4. auditLog 기록: REORG_DETECTED
    // 5. retryWithBackoff(() => vaspClient.resubmit(requestId), this.retryPolicy)
    //    성공 → ledger.updateMintRequest(requestId, { status: 'SUBMITTED', txHash: newTxHash })
    //    실패 3회 → ledger.updateMintRequest(requestId, { status: 'FAILED' }) + 운영팀 알림
    // return { requestId, action: 'RESUBMITTED', newTxHash, message: '...' }
    throw new Error('Not implemented');
  }

  // ── 유틸리티 ─────────────────────────────────────────────────

  async retryWithBackoff<T>(
    fn: () => Promise<T>,
    policy: RetryPolicy = this.retryPolicy,
  ): Promise<T> {
    let lastError: Error | undefined;
    let delay = policy.initialDelayMs;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // TODO: err가 NonRetryableError인지 확인 — 맞으면 즉시 throw
        // TODO: 마지막 시도였으면 throw lastError
        // TODO: delay 만큼 sleep 후 delay = min(delay * backoffMultiplier, maxDelayMs)
        throw new Error('Not implemented — complete the retry loop');
      }
    }
    throw lastError;
  }
}

// ── Interfaces ────────────────────────────────────────────────

interface VaspClient {
  resyncNonce(): Promise<void>;
  resubmit(requestId: string): Promise<{ txHash: string }>;
}

interface Notifier {
  send(event: { type: string; [key: string]: unknown }): Promise<void>;
}
