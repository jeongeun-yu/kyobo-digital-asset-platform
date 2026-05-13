/**
 * Broadcaster — TX 전송 전담 서비스 (Phase 3: 직접 Custody 전환 시 활성화)
 *
 * ─ Broadcaster vs ConfirmationTracker 분리 원칙 ─
 *
 * Broadcaster        짧은 타임스케일 (초 단위)
 *   관심사: "TX가 mempool에 들어갔는가"
 *   동작: RPC 전송 → 즉각 재시도 (수 초)
 *   실패 처리: 전송 실패 → 수 초 이내 재시도 → 최종 실패 시 FAILED
 *
 * ConfirmationTracker   긴 타임스케일 (분~시간 단위)
 *   관심사: "TX가 최종 확정됐는가"
 *   동작: 블록 포함 확인 → REORG 감지 → FINALIZED 확인
 *   실패 처리: REORG → REORGED 전이 → 재확인
 *
 * Phase 1 현황:
 *   TxStateMachineService 단일 서비스 + pollStaleRequests가
 *   두 역할을 동시에 수행. TX 수가 적어 타임스케일 분리 불필요.
 *
 * Phase 3 필요성:
 *   TX 수 증가 시 Broadcaster(빠른 루프)와 Tracker(느린 루프)가
 *   같은 루프에서 실행되면 서로 간섭. 타임스케일이 다른 두 루프는 분리.
 *
 * Custody Track Session 6 참조: Broadcaster와 Confirmation Tracker 분리
 */

import type { TxAttempt, TxAttemptRepository } from './TxAttempt.js';

// ── 의존 인터페이스 ───────────────────────────────────────────────────────────

export interface RpcProvider {
  sendRawTransaction(signedTx: string): Promise<string>;  // txHash 반환
  getTransactionCount(address: string): Promise<number>;  // Nonce 조회
}

// ── Broadcaster ───────────────────────────────────────────────────────────────

/**
 * Phase 3: TX 서명 → RPC 전송 → mempool 확인 전담
 *
 * 핵심 동작:
 *   1. A1_SIGNED 상태 Attempt 조회
 *   2. RPC.sendRawTransaction() 호출
 *   3. 성공 → A2_SENT_TO_RPC 전이
 *   4. 실패 → 지수 백오프 재시도 (최대 3회, 수 초 단위)
 *   5. 최종 실패 → FAILED 전이 + 상위 레이어 알림
 *
 * 실행 주기: 수 초 간격 (Broadcaster는 빠른 루프)
 */
export class Broadcaster {
  constructor(
    private readonly attemptRepo: TxAttemptRepository,
    private readonly rpc: RpcProvider,
  ) {}

  // Phase 3: 구현
  async broadcastPending(): Promise<{ sent: number; failed: number }> {
    throw new Error('Phase 3 — Broadcaster.broadcastPending 구현 필요');
  }

  // Phase 3: 단건 전송 + 즉각 재시도
  async broadcast(attempt: TxAttempt): Promise<void> {
    throw new Error('Phase 3 — Broadcaster.broadcast 구현 필요');
  }
}
