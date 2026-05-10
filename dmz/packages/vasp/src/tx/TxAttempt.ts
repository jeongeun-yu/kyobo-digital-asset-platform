/**
 * TxAttempt — 체인 실행 단위 (Phase 3: 직접 Custody 전환 시 활성화)
 *
 * ─ 왜 MintRequest와 분리하는가 ─
 *
 * MintRequest  = 비즈니스 단위 ("이 사용자에게 NFT 1개 발행")
 *   - 생명주기: 요청 생성 → 승인 → 완료 (비즈니스 관점)
 *   - 1개 MintRequest : N개 TxAttempt (gas bump 시 Attempt 교체)
 *
 * TxAttempt    = 체인 실행 단위 ("이 TX를 이 Nonce로 이 gasPrice로 전송")
 *   - 생명주기: TX 생성 → 전송 → 포함 → 확정 (체인 관점)
 *   - gas bump 시: 이전 Attempt가 REPLACED로 종료, 새 Attempt 생성
 *
 * Phase 1 현황:
 *   MintRequest.txHash를 직접 갱신하는 방식으로 단순 구현.
 *   VASP(월렛원)가 Nonce 관리를 담당하므로 Attempt 분리 불필요.
 *
 * Phase 3 필요성:
 *   교보 자체 VASP 운영 시 Nonce 직접 관리 → gas bump 이력 추적 필요
 *   "이 발행 요청은 총 몇 번 재전송됐나?" → Attempt 테이블로만 추적 가능
 *
 * Custody Track Session 3 참조: Withdrawal vs TxAttempt 두 레이어 분리
 *
 * ─ 상태 전이 ─
 *   A0_CREATED → A1_SIGNED → A2_SENT_TO_RPC → A3_SEEN_IN_MEMPOOL
 *     → A4_INCLUDED → A5_CONFIRMED → A6_FINALIZED  (정상)
 *     → FAILED     (시스템 오류)
 *     → DROPPED    (mempool에서 제거 — 가스 부족 등)
 *     → REPLACED   (동일 Nonce로 다른 TX 대체 — gas bump)
 *     → REVERTED   (EVM 실행 실패 — revert reason 저장)
 *     → RPC_INCONSISTENT  (RPC 응답 불일치 — 수동 확인 필요)
 */

// ── 상태 ─────────────────────────────────────────────────────────────────────

export type AttemptStatus =
  | 'A0_CREATED'          // Attempt 생성, 서명 전
  | 'A1_SIGNED'           // 서명 완료, RPC 전송 전
  | 'A2_SENT_TO_RPC'      // RPC에 전송됨
  | 'A3_SEEN_IN_MEMPOOL'  // mempool 진입 확인
  | 'A4_INCLUDED'         // 블록 포함 (= MintRequest MINED)
  | 'A5_CONFIRMED'        // 일정 블록 경과 확인
  | 'A6_FINALIZED'        // PoS 2/3+ validator 동의 (= MintRequest FINALIZED)
  | 'FAILED'              // 시스템 오류
  | 'DROPPED'             // mempool에서 제거
  | 'REPLACED'            // 동일 Nonce로 다른 TX 대체 (gas bump)
  | 'REVERTED'            // EVM REVERT
  | 'RPC_INCONSISTENT';   // RPC 응답 불일치 → 수동 확인

// ── 모델 ─────────────────────────────────────────────────────────────────────

export interface TxAttempt {
  id:            string;   // UUID
  mintRequestId: string;   // FK → MintRequest.id (1:N)
  chainId:       string;
  fromAddress:   string;
  toAddress:     string;
  nonce:         number;
  txHash?:       string;
  gasPriceGwei?: number;   // Legacy 수수료
  maxFeePerGas?: bigint;   // EIP-1559
  maxPriorityFeePerGas?: bigint;  // EIP-1559
  blockNumber?:  number;
  status:        AttemptStatus;
  revertReason?: string;
  attemptIndex:  number;   // 동일 MintRequest 내 몇 번째 시도인지 (0-based)
  createdAt:     Date;
  updatedAt:     Date;
}

// ── 유효 전이 ─────────────────────────────────────────────────────────────────

export const ATTEMPT_VALID_TRANSITIONS: Record<AttemptStatus, AttemptStatus[]> = {
  A0_CREATED:         ['A1_SIGNED',  'FAILED'],
  A1_SIGNED:          ['A2_SENT_TO_RPC', 'FAILED'],
  A2_SENT_TO_RPC:     ['A3_SEEN_IN_MEMPOOL', 'DROPPED', 'FAILED'],
  A3_SEEN_IN_MEMPOOL: ['A4_INCLUDED', 'DROPPED', 'REPLACED', 'FAILED'],
  A4_INCLUDED:        ['A5_CONFIRMED', 'REVERTED'],
  A5_CONFIRMED:       ['A6_FINALIZED', 'RPC_INCONSISTENT'],
  A6_FINALIZED:       [],              // 종단
  FAILED:             [],              // 종단
  DROPPED:            [],              // 종단 — 상위 레이어에서 새 Attempt 생성 판단
  REPLACED:           [],              // 종단 — gas bump로 교체됨
  REVERTED:           [],              // 종단
  RPC_INCONSISTENT:   [],              // 종단 — 수동 개입 필요
};

// ── 저장소 인터페이스 ─────────────────────────────────────────────────────────

export interface TxAttemptRepository {
  save(attempt: TxAttempt): Promise<void>;
  findById(id: string): Promise<TxAttempt | null>;
  findByMintRequestId(mintRequestId: string): Promise<TxAttempt[]>;
  findActiveByMintRequestId(mintRequestId: string): Promise<TxAttempt | null>;
  updateStatus(
    id: string,
    status: AttemptStatus,
    extra?: Partial<TxAttempt>,
  ): Promise<void>;
}

// ── Phase 3 구현 예정 ──────────────────────────────────────────────────────────
//
// Phase 3 — 직접 Custody 전환 시 구현:
//   1. TxAttemptService: Attempt 생성, 서명, 전송, 상태 추적
//   2. MintRequest 1:N TxAttempt 관계 — gas bump 시 신규 Attempt 생성
//   3. Nonce 관리: NonceManager와 연동 (TxAttempt.nonce 할당)
//   4. Broadcaster: A1_SIGNED → A2_SENT_TO_RPC 전이
//   5. ConfirmationTracker: A4_INCLUDED → A6_FINALIZED 전이
//   6. DB 마이그레이션: tx_attempts 테이블 (nonce UNIQUE(chainId, fromAddress, nonce))
