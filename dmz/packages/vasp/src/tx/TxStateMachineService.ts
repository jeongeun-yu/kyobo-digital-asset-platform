/**
 * TxStateMachineService — 비동기 TX 상태 관리
 *
 * M3 S13~S22 핵심 개념:
 *
 * 상태 전이도:
 *   REQUESTED ──submitMintRequest()──→ SUBMITTED
 *   SUBMITTED ──VASP 컨트랙트 호출──→ PENDING
 *   PENDING   ──블록 채굴──────────→ MINED
 *   MINED     ──PoS 2/3+ 동의─────→ FINALIZED   ← NEW (S13 업데이트)
 *   FINALIZED ──원장 업데이트────→ CONFIRMED
 *   MINED     ──REORG 감지────────→ REORGED → MINED or FAILED
 *   MINED/PENDING ──REVERT──────→ FAILED
 *   MINED/PENDING ──TIMEOUT─────→ gas bump 재전송
 *
 * 3종 비정상 전이 (S21~S22):
 *   REVERT  : 즉시 FAILED + reason 저장. 복구 없음.
 *   TIMEOUT : mempool stuck → gas bump 재전송 → PENDING 유지
 *   REORG   : MINED TX 소실(FINALIZED 전) → REORGED → 5블록 대기 → VASP 재조회 → MINED or FAILED
 *             FINALIZED 이후 REORG 불가 (PoS 절대 불변)
 *
 * MINED / FINALIZED / CONFIRMED 구분 (S13 핵심):
 *   MINED     = 블록 포함됨, REORG 가능 구간
 *   FINALIZED = 2/3+ validator 동의 → 절대 불변 (Ethereum PoS 기준 약 12분)
 *   CONFIRMED = 원장 업데이트 완료 — 종단 상태
 *   → 원장 업데이트는 FINALIZED 이후만 (M7 ConsumerGroupWorker 연계)
 *
 * pollStaleRequests (S23):
 *   PENDING 30분 초과 건 → VASP API 직접 조회 → 결과별 전이
 *   배치 크론으로 실행 (5분 간격 권장)
 */

import { randomUUID } from 'crypto';

// ── 상태 정의 ──────────────────────────────────────────────────────────────

export type TxStatus =
  | 'REQUESTED'   // 요청 생성, VASP 전송 전
  | 'SUBMITTED'   // VASP에 전송됨, TX hash 미획득
  | 'PENDING'     // TX 전송됨, 블록 미채굴
  | 'MINED'       // 블록에 포함됨, REORG 가능 구간
  | 'FINALIZED'   // PoS 2/3+ validator 동의 → 절대 불변 (약 12분)
  | 'CONFIRMED'   // 원장 업데이트 완료 — 종단 상태
  | 'FAILED'      // REVERT 또는 최종 실패 — 종단 상태
  | 'REORGED';    // MINED 구간 REORG → TX 소실, 재처리 대기

export interface MintRequest {
  id:          string;   // UUID (Idempotency key)
  userId:      string;
  tokenId:     bigint;
  amount:      bigint;
  status:      TxStatus;
  txHash?:     string;
  blockNumber?: number;
  retryCount:  number;
  gasPriceGwei?: number;
  failReason?: string;
  createdAt:   Date;
  updatedAt:   Date;
}

// ── 의존 인터페이스 ────────────────────────────────────────────────────────

export interface TxRepository {
  save(req: MintRequest): Promise<void>;
  findById(id: string): Promise<MintRequest | null>;
  updateStatus(
    id: string,
    status: TxStatus,
    extra?: Partial<MintRequest>,
  ): Promise<void>;
  findPendingOlderThan(minutes: number): Promise<MintRequest[]>;
}

export interface VaspTxClient {
  submitMint(params: {
    to:       string;
    tokenId:  bigint;
    amount:   bigint;
    requestId: string;
  }): Promise<{ txHash: string }>;

  getStatus(txHash: string): Promise<{
    status:      'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found';
    blockNumber?: number;
    revertReason?: string;
  }>;

  resubmitWithGasBump(txHash: string, gasBumpPercent: number): Promise<{ txHash: string }>;
}

export interface WalletResolver {
  getWalletAddr(userId: string): Promise<string>;
}

// ── 서비스 ────────────────────────────────────────────────────────────────

/**
 * TxStateMachineService
 *
 * M4 핵심 학습 포인트:
 *   1. 왜 상태머신이 필요한가 — sendTransaction은 즉시 확정되지 않음
 *      네트워크 지연·REVERT·REORG 모두 별도 처리 필요
 *   2. Idempotency — requestId 기반, 같은 요청 중복 전송 시 1개만 발행
 *   3. TIMEOUT/REORG 복구 전략은 비즈니스에 따라 다름 — 자동 재전송 vs 수동 확인
 */
export class TxStateMachineService {
  private static readonly GAS_BUMP_PERCENT   = 20;   // TIMEOUT 시 gas 20% 인상
  private static readonly STALE_MINUTES      = 30;   // pollStale 기준 (분)
  private static readonly REORG_WAIT_BLOCKS  = 5;    // REORG 후 재확인 대기 블록

  constructor(
    private readonly repo:   TxRepository,
    private readonly vasp:   VaspTxClient,
    private readonly wallet: WalletResolver,
  ) {}

  // ── REQUESTED → SUBMITTED ───────────────────────────────────────────────

  /**
   * @notice NFT 발행 요청 생성 + VASP 전송
   *
   * M4 S15 실습: submitMintRequest 흐름
   *   1. UUID requestId 생성 (Idempotency key)
   *   2. DB INSERT (REQUESTED)
   *   3. walletResolver.getWalletAddr(userId)
   *   4. vasp.submitMint() → txHash
   *   5. DB UPDATE (SUBMITTED, txHash)
   *
   * @returns requestId (이후 상태 조회에 사용)
   */
  async submitMintRequest(params: {
    userId:  string;
    tokenId: bigint;
    amount:  bigint;
  }): Promise<string> {
    const { userId, tokenId, amount } = params;

    const id  = randomUUID();
    const now = new Date();

    const req: MintRequest = {
      id,
      userId,
      tokenId,
      amount,
      status:     'REQUESTED',
      retryCount: 0,
      createdAt:  now,
      updatedAt:  now,
    };

    await this.repo.save(req);

    // TODO (M4 S15 실습): VASP 전송 + 상태 전이
    //   const walletAddr = await this.wallet.getWalletAddr(userId);
    //   const { txHash } = await this.vasp.submitMint({ to: walletAddr, tokenId, amount, requestId: id });
    //   await this.repo.updateStatus(id, 'SUBMITTED', { txHash });
    //   return id;

    try {
      const walletAddr  = await this.wallet.getWalletAddr(userId);
      const { txHash }  = await this.vasp.submitMint({
        to: walletAddr, tokenId, amount, requestId: id,
      });
      await this.repo.updateStatus(id, 'SUBMITTED', { txHash });
    } catch (err) {
      await this.repo.updateStatus(id, 'FAILED', {
        failReason: `submit failed: ${String(err)}`,
      });
      throw err;
    }

    return id;
  }

  // ── TX 콜백 핸들러 ─────────────────────────────────────────────────────

  /**
   * VASP Webhook: TX가 블록에 포함됨 → MINED 전이
   * Finalized 확인은 ChainEventListener가 별도 수행
   */
  async handleMined(requestId: string, blockNumber: number): Promise<void> {
    const req = await this._getOrThrow(requestId);
    if (req.status !== 'PENDING' && req.status !== 'SUBMITTED') return;

    await this.repo.updateStatus(requestId, 'MINED', { blockNumber });
  }

  /**
   * PoS Finality 확인 → FINALIZED 전이
   * ChainEventListener가 2/3+ validator 동의 확인 후 호출
   *
   * MINED 상태에서만 전이. FINALIZED 이후 REORG 불가.
   */
  async handleFinalized(requestId: string): Promise<void> {
    const req = await this._getOrThrow(requestId);
    if (req.status !== 'MINED') return;

    await this.repo.updateStatus(requestId, 'FINALIZED');
  }

  /**
   * FINALIZED 확인 후 원장 업데이트 → CONFIRMED 전이 (종단)
   * ConsumerGroupWorker에서 이 메서드 호출 후 원장 업데이트
   *
   * M7 연계: CONFIRMED 전이 후 LedgerService.recordHolding(+1)
   */
  async handleConfirmed(requestId: string): Promise<void> {
    const req = await this._getOrThrow(requestId);
    if (req.status !== 'FINALIZED') return;

    await this.repo.updateStatus(requestId, 'CONFIRMED');
  }

  /**
   * REVERT 수신 → FAILED 전이 + reason 저장
   * 즉시 실패 처리, 자동 재시도 없음 (비즈니스 판단 필요)
   */
  async handleFailed(requestId: string, reason: string): Promise<void> {
    await this.repo.updateStatus(requestId, 'FAILED', { failReason: reason });
  }

  // ── TIMEOUT 처리 (S22) ──────────────────────────────────────────────────

  /**
   * TX가 mempool에서 일정 시간 미채굴 → gas bump 재전송
   *
   * M4 S22 실습: handleTimeout 흐름
   *   1. PENDING 상태 확인
   *   2. vasp.resubmitWithGasBump(txHash, 20%) → 새 txHash
   *   3. DB UPDATE (PENDING, newTxHash, retryCount++)
   *
   * 주의: 원래 TX가 나중에 채굴될 수 있음 → Idempotency로 중복 방어
   */
  async handleTimeout(requestId: string): Promise<void> {
    const req = await this._getOrThrow(requestId);
    if (req.status !== 'PENDING' || !req.txHash) return;

    // TODO (M4 S22 실습): gas bump 재전송
    //   const { txHash: newTxHash } = await this.vasp.resubmitWithGasBump(
    //     req.txHash, TxStateMachineService.GAS_BUMP_PERCENT,
    //   );
    //   await this.repo.updateStatus(requestId, 'PENDING', {
    //     txHash: newTxHash,
    //     retryCount: req.retryCount + 1,
    //   });

    const { txHash: newTxHash } = await this.vasp.resubmitWithGasBump(
      req.txHash,
      TxStateMachineService.GAS_BUMP_PERCENT,
    );
    await this.repo.updateStatus(requestId, 'PENDING', {
      txHash:     newTxHash,
      retryCount: req.retryCount + 1,
    });
  }

  // ── REORG 처리 (S22) ───────────────────────────────────────────────────

  /**
   * MINED 상태 TX가 REORG로 소실 → REORGED 전이
   *
   * M4 S22 실습: handleReorg 흐름
   *   1. MINED → REORGED 전이  ← FINALIZED 이전에만 REORG 가능
   *   2. REORG_WAIT_BLOCKS 블록 대기 (ChainEventListener에서 호출)
   *   3. vasp.getStatus() 재조회
   *   4. 결과: mined → MINED 복귀 / not_found → FAILED
   *
   * 주의: FINALIZED 이후 REORG 불가 (PoS 절대 불변 보장)
   * 이 메서드는 5블록 대기 포함 — 동기 흐름에서 호출하지 말 것
   */
  async handleReorg(requestId: string): Promise<void> {
    const req = await this._getOrThrow(requestId);
    if (req.status !== 'MINED' || !req.txHash) return;

    await this.repo.updateStatus(requestId, 'REORGED');

    // TODO (M4 S22 실습): 5블록 대기 + VASP 재조회
    //   await this._waitBlocks(TxStateMachineService.REORG_WAIT_BLOCKS);
    //   const result = await this.vasp.getStatus(req.txHash);
    //   if (result.status === 'mined') {
    //     await this.repo.updateStatus(requestId, 'MINED');
    //   } else {
    //     await this.repo.updateStatus(requestId, 'FAILED', { failReason: 'reorg: tx not found after wait' });
    //   }

    // 주석 처리 — 실습에서 구현
  }

  // ── Stale 폴링 (S23) ───────────────────────────────────────────────────

  /**
   * PENDING 30분 초과 건 → VASP API 직접 조회 → 상태 갱신
   *
   * M4 S23 실습: pollStaleRequests 흐름
   *   1. DB에서 PENDING + createdAt < now - 30분 목록 조회
   *   2. 건별 vasp.getStatus(txHash) 조회
   *   3. 결과별 전이:
   *      confirmed  → handleFinalized()  (VASP confirmed = PoS finality 확보)
   *      failed     → handleFailed()
   *      not_found  → handleFailed('tx not found in mempool')
   *      pending    → 계속 대기 (업데이트 없음)
   *
   * 크론 스케줄: 5분 간격 권장
   */
  async pollStaleRequests(): Promise<{ processed: number }> {
    const stale = await this.repo.findPendingOlderThan(TxStateMachineService.STALE_MINUTES);
    let processed = 0;

    for (const req of stale) {
      if (!req.txHash) continue;
      try {
        const result = await this.vasp.getStatus(req.txHash);

        // TODO (M4 S23 실습): 결과별 상태 전이 로직 작성
        //   switch (result.status) {
        //     case 'confirmed': await this.handleFinalized(req.id); break;  // VASP confirmed = PoS finality
        //     case 'failed':    await this.handleFailed(req.id, result.revertReason ?? 'failed'); break;
        //     case 'not_found': await this.handleFailed(req.id, 'tx not found in mempool'); break;
        //   }

        switch (result.status) {
          case 'confirmed':
            await this.handleFinalized(req.id);
            break;
          case 'failed':
            await this.handleFailed(req.id, result.revertReason ?? 'failed');
            break;
          case 'not_found':
            await this.handleFailed(req.id, 'tx not found in mempool');
            break;
        }
        processed++;
      } catch (err) {
        console.error(`[TxStateMachine] pollStale error for ${req.id}:`, err);
      }
    }

    return { processed };
  }

  // ── 상태 조회 ─────────────────────────────────────────────────────────

  async getStatus(requestId: string): Promise<MintRequest> {
    return this._getOrThrow(requestId);
  }

  // ── 내부 유틸 ─────────────────────────────────────────────────────────

  private async _getOrThrow(id: string): Promise<MintRequest> {
    const req = await this.repo.findById(id);
    if (!req) throw new MintRequestNotFoundError(id);
    return req;
  }
}

// ── 에러 ──────────────────────────────────────────────────────────────────

export class MintRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`MintRequest not found: ${id}`);
    this.name = 'MintRequestNotFoundError';
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(from: TxStatus, to: TxStatus) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}
