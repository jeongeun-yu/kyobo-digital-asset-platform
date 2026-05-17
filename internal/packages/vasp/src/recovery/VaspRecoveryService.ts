/**
 * VaspRecoveryService — TX 실패·Reorg 복구 서비스
 *
 * ─ Phase 1 현황 ─
 *   ExternalVASPAdapter(월렛원)가 TX 실행을 위탁.
 *   REVERT·TIMEOUT 발생 시 이 서비스가 상태 전이 + 알림 담당.
 *   Nonce 관리는 VASP에 위임 (handleNonceConflict → vaspClient.resyncNonce).
 *
 * ─ Phase 3 변화 ─
 *   교보 직접 Custody 전환 시 NonceManager·Broadcaster·ConfirmationTracker가
 *   TX 생명주기를 직접 관리. 이 서비스의 역할:
 *     REVERT      → 즉시 FAILED (재시도 없음) ← Phase 1/3 동일
 *     TIMEOUT     → NonceManager.bumpGas() 직접 호출 (Phase 3)
 *     NONCE_TOO_LOW → NonceManager.release() + 재할당 (Phase 3)
 *     REORG       → ConfirmationTracker가 감지 → 이 서비스가 재제출 (Phase 3)
 *
 * ─ 교체 포인트 ─
 *   Phase 3 전환 시: vaspClient.resyncNonce() → NonceManager.release()
 *                    vaspClient.resubmit()    → Broadcaster.broadcast()
 */

import type { MintStatus } from '@kyobo/core-banking';
import { MintRequestNotFoundError } from '../tx/TxStateMachineService';

interface LedgerService {
  getMintRequest(id: string): Promise<{ status: string; txHash?: string; errorMsg?: string; [k: string]: unknown } | null>;
  updateMintRequest(id: string, patch: { status: MintStatus; txHash?: string; errorMsg?: string }): Promise<unknown>;
}

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
    const req = await this.ledger.getMintRequest(requestId);
    if (!req) throw new MintRequestNotFoundError(requestId);
    if ((req as { status: string }).status !== 'SUBMITTED') {
      throw new InvalidStateTransitionError((req as { status: string }).status, 'FAILED');
    }

    await this.ledger.updateMintRequest(requestId, { status: 'FAILED', txHash, errorMsg: reason });
    await this.notifier.send({ type: 'TX_FAILED', requestId, txHash, reason });

    return { requestId, action: 'FAILED', message: `TX reverted: ${reason}` };
  }

  async handleTxTimeout(requestId: string, txHash: string): Promise<RecoveryResult> {
    await this.ledger.getMintRequest(requestId); // 존재 확인
    await this.notifier.send({ type: 'TX_TIMEOUT_ALERT', requestId, txHash });

    return { requestId, action: 'POLLING', message: 'Kept SUBMITTED, polling will resolve' };
  }

  async handleNonceConflict(requestId: string): Promise<RecoveryResult> {
    await this.vaspClient.resyncNonce();
    const { txHash: newTxHash } = await this.vaspClient.resubmit(requestId);
    await this.ledger.updateMintRequest(requestId, { status: 'SUBMITTED', txHash: newTxHash });

    return { requestId, action: 'RESUBMITTED', newTxHash, message: 'Resubmitted after nonce resync' };
  }

  async handleReorg(
    requestId: string,
    originalTxHash: string,
    detectedAtBlock: number,
  ): Promise<RecoveryResult> {
    const req = await this.ledger.getMintRequest(requestId);
    if (!req) throw new MintRequestNotFoundError(requestId);
    if (req.status !== 'MINED') {
      throw new Error(`REORG only valid from MINED status, current: ${req.status}`);
    }

    await this.ledger.updateMintRequest(requestId, {
      status:   'REORGED',
      txHash:   originalTxHash,
      errorMsg: `Reorg detected at block ${detectedAtBlock}`,
    });

    try {
      const { txHash: newTxHash } = await this.retryWithBackoff(
        () => this.vaspClient.resubmit(requestId),
      );
      await this.ledger.updateMintRequest(requestId, { status: 'SUBMITTED', txHash: newTxHash });
      return { requestId, action: 'RESUBMITTED', newTxHash, message: `Resubmitted after reorg at block ${detectedAtBlock}` };
    } catch (err) {
      await this.ledger.updateMintRequest(requestId, {
        status:   'FAILED',
        errorMsg: `Resubmit failed after reorg: ${String(err)}`,
      });
      await this.notifier.send({ type: 'REORG_RESUBMIT_FAILED', requestId, originalTxHash, detectedAtBlock });
      return { requestId, action: 'FAILED', message: `Reorg recovery failed: ${String(err)}` };
    }
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

        if (lastError.constructor?.name === 'NonRetryableError') throw lastError;
        if (attempt >= policy.maxAttempts) throw lastError;

        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * policy.backoffMultiplier, policy.maxDelayMs);
      }
    }
    throw lastError;
  }
}

// ── Errors ────────────────────────────────────────────────────

export class InvalidStateTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'InvalidStateTransitionError';
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
