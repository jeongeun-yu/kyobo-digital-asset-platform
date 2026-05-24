/**
 * ConfirmationTracker — 온체인 TX 확정 추적 서비스 (Phase 3: 직접 Custody 전환 시 활성화)
 *
 * ─ 역할 ─
 *   Broadcaster가 TX를 mempool에 넣으면, ConfirmationTracker가 최종 확정까지 추적.
 *   타임스케일: 분~시간 단위 (블록 생성 12초, Finality ~12분)
 *
 * ─ 주요 시나리오 ─
 *
 *   정상: A3_SEEN_IN_MEMPOOL → A4_INCLUDED → A5_CONFIRMED → A6_FINALIZED
 *
 *   TIMEOUT (mempool stuck):
 *     A3_SEEN_IN_MEMPOOL 30분 초과 → NonceManager.bumpGas() 호출
 *     → 동일 Nonce, gasPrice 1.2배, 새 Attempt 생성 (REPLACED)
 *
 *   REORG:
 *     A4_INCLUDED TX가 REORG로 소실 → REORGED 전이
 *     → 5블록 대기 → RPC 재조회 → INCLUDED or DROPPED
 *
 *   RPC 불일치:
 *     두 RPC 응답이 다름 → RPC_INCONSISTENT 전이 → 수동 확인
 *
 * Phase 1 현황:
 *   TxStateMachineService.pollStaleRequests()가 이 역할을 수행.
 *   30분 폴링으로 단순 구현. VASP API 조회로 온체인 상태 파악.
 *
 * Phase 3 필요성:
 *   직접 RPC 연결 시 블록 이벤트 구독 → 즉각 상태 감지
 *   REORG 감지를 위한 블록 해시 비교 로직 필요
 *   RPC 다중화(quorum) 필요
 *
 */

import type { TxAttempt, TxAttemptRepository } from './TxAttempt.js';

// ── 의존 인터페이스 ───────────────────────────────────────────────────────────

export interface BlockchainRpc {
  getTransactionReceipt(txHash: string): Promise<{
    blockNumber: number;
    blockHash:   string;
    status:      0 | 1;  // 1=success, 0=reverted
  } | null>;

  getBlockNumber(): Promise<number>;
  getFinalizedBlockNumber(): Promise<number>;
}

// ── ConfirmationTracker ───────────────────────────────────────────────────────

/**
 * Phase 3: 블록 포함 확인 → REORG 감지 → Finality 확인 전담
 *
 * 핵심 동작:
 *   1. A2_SENT_TO_RPC / A3_SEEN_IN_MEMPOOL 상태 Attempt 조회
 *   2. getTransactionReceipt() → 포함 확인 → A4_INCLUDED 전이
 *   3. 포함된 블록이 finalized 블록보다 오래됐으면 → A6_FINALIZED 전이
 *   4. REORG 감지: 이전에 포함됐던 블록이 체인에서 사라짐 → REORGED 처리
 *   5. TIMEOUT: 30분 초과 mempool 대기 → NonceManager에 gas bump 요청
 *
 * 실행 주기: 1분 간격 (Broadcaster보다 느린 루프)
 */
export class ConfirmationTracker {
  private static readonly FINALITY_BLOCKS        = 64;   // EVM Safe 기준
  private static readonly TIMEOUT_MINUTES        = 30;
  private static readonly REORG_RECHECK_BLOCKS   = 5;

  constructor(
    private readonly attemptRepo: TxAttemptRepository,
    private readonly rpc: BlockchainRpc,
  ) {}

  // Phase 3: 구현
  async trackPending(): Promise<{ updated: number }> {
    throw new Error('Phase 3 — ConfirmationTracker.trackPending 구현 필요');
  }

  // Phase 3: REORG 감지 로직
  private async _detectReorg(_attempt: TxAttempt): Promise<boolean> {
    throw new Error('Phase 3 — REORG 감지 구현 필요');
  }
}
