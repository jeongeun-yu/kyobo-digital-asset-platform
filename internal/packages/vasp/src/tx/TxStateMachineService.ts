/**
 * TxStateMachineService — 비동기 TX 상태 관리
 *
 * 상태 전이도:
 *   REQUESTED ──submitMintRequest()──→ SUBMITTED
 *   SUBMITTED ──VASP TX 브로드캐스트──→ PENDING
 *   SUBMITTED ──온체인 이벤트 직접──→ MINED   (VASP가 PENDING 없이 바로 채굴 확인 시)
 *   PENDING   ──블록 채굴──────────→ MINED
 *   MINED     ──확인 임계치 도달──→ CONFIRMED
 *   CONFIRMED ──PoS 2/3+ 동의─────→ FINALIZED   ← 종단
 *   MINED     ──REORG 감지────────→ REORGED → MINED or FAILED
 *   MINED/PENDING ──REVERT──────→ FAILED
 *   MINED/PENDING ──TIMEOUT─────→ gas bump 재전송
 *
 * 3종 비정상 전이:
 *   REVERT  : 즉시 FAILED + reason 저장. 복구 없음.
 *   TIMEOUT : mempool stuck → gas bump 재전송 → PENDING 유지
 *   REORG   : MINED TX 소실(FINALIZED 전) → REORGED → 5블록 대기 → VASP 재조회 → MINED or FAILED
 *             FINALIZED 이후 REORG 불가 (PoS 절대 불변)
 *
 * MINED / CONFIRMED / FINALIZED 구분:
 *   MINED     = 블록 포함됨, REORG 가능 구간
 *   CONFIRMED = 충분한 블록 확인 → 원장 업데이트 (ConsumerGroupWorker 연계)
 *   FINALIZED = 2/3+ validator 동의 → 절대 불변 — 종단 상태 (Ethereum PoS 기준 약 12분)
 *
 * pollStaleRequests:
 *   PENDING 10분 초과 건 → VASP API 직접 조회 → 결과별 전이
 *   배치 크론으로 실행 (5분 간격 권장)
 *
 * ── Phase별 VASP 지원 범위와 TxStateMachineService 변화 ──────────────────────
 *
 * Phase 1 (현재):
 *   VaspTxClient = 월렛원 REST API 래퍼
 *   submitMint()          → 월렛원 API 호출 → TX hash 반환
 *   getStatus(txHash)     → 월렛원 API 폴링 → 10분 타임아웃 시 재조회
 *   resubmitWithGasBump() → 월렛원 API gas bump 재전송
 *   한계: VASP가 TX 상태를 추상화해서 반환 → REORG·세부 실패 이유 파악 어려움
 *
 * Phase 2 (ChainEventListener 직접 구독):
 *   VaspTxClient 유지 (월렛원 계속 사용)
 *   단, ChainEventListener가 블록체인 이벤트를 직접 구독
 *   → getStatus() 폴링 빈도 줄어듦 (이벤트 기반 전이로 부분 대체)
 *   → MINED·FINALIZED 전이가 더 빠르고 정확해짐
 *
 * Phase 3 (직접 Custody 전환):
 *   VaspTxClient 완전 교체 → 아래 3개 컴포넌트로 분리
 *   submitMint()          → NonceManager.allocate() + ISignerService.sign() + Broadcaster.broadcast()
 *   getStatus(txHash)     → ConfirmationTracker.trackPending() (블록 직접 조회)
 *   resubmitWithGasBump() → NonceManager.bumpGas() + Broadcaster.broadcast()
 *   pollStaleRequests()   → ConfirmationTracker가 대체 (루프 분리)
 *   교체 방식: VaspTxClient 인터페이스 유지 → CustodyVaspTxClient 등 신규 구현체 주입
 *              (ExternalVaspTxClient 교체, TxStateMachineService 코드 수정 없음)
 */

import { randomUUID }  from 'crypto';
import { EventEmitter } from 'events';

// ── 상태 정의 ──────────────────────────────────────────────────────────────

export type TxStatus =
  | 'REQUESTED'   // 요청 생성, VASP 전송 전
  | 'SUBMITTED'   // VASP에 전송됨, TX hash 미획득
  | 'PENDING'     // TX 전송됨, 블록 미채굴
  | 'MINED'       // 블록에 포함됨, REORG 가능 구간
  | 'CONFIRMED'   // 충분한 블록 확인 → 원장 업데이트
  | 'FINALIZED'   // PoS 2/3+ validator 동의 → 절대 불변 — 종단 상태 (약 12분)
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

// ── Observer 이벤트 타입 ────────────────────────────────────────────────────

export interface TxTransitionEvent {
  requestId: string;
  from:      TxStatus;
  to:        TxStatus;
  req:       MintRequest;
  source?:   string;  // 전이 트리거 경로 (예: 'WEBHOOK' | 'POLLING' | 'POLL_STALE')
}

// ── 의존 인터페이스 ────────────────────────────────────────────────────────

export interface TxRepository {
  save(req: MintRequest): Promise<void>;
  findById(id: string): Promise<MintRequest | null>;
  findByTxHash(txHash: string): Promise<MintRequest | null>;
  updateStatus(
    id: string,
    status: TxStatus,
    extra?: Partial<MintRequest>,
  ): Promise<void>;
  findPendingOlderThan(minutes: number): Promise<MintRequest[]>;
}

/**
 * VaspTxClient — TX 실행 위임 인터페이스
 *
 * Phase 1 구현체: ExternalVaspTxClient (월렛원 REST API 래퍼)
 *   submitMint()          → POST /v1/nft/mint
 *   getStatus()           → GET  /v1/tx/{txHash}/status (폴링)
 *   resubmitWithGasBump() → POST /v1/tx/{txHash}/resubmit
 *
 * Phase 2 구현체: ExternalVaspTxClient 유지
 *   getStatus() 보조 수단으로 ChainEventListener 직접 구독 병행
 *
 * Phase 3 구현체: Phase3VaspTxClient (내부 구현 — Broadcaster + ConfirmationTracker 위임)
 *   submitMint()          → NonceManager + ISignerService + Broadcaster
 *   getStatus()           → ConfirmationTracker 직접 RPC 조회
 *   resubmitWithGasBump() → NonceManager.bumpGas() + Broadcaster
 *   → TxStateMachineService 코드 수정 없이 구현체만 교체
 */
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

// ── 레이어 레이블 ─────────────────────────────────────────────────────────

const TX_STATUS_LAYER: Record<TxStatus, string> = {
  REQUESTED: 'VASP',
  SUBMITTED: 'VASP',
  PENDING:   'BLOCKCHAIN',
  MINED:     'BLOCKCHAIN',
  CONFIRMED: 'BLOCKCHAIN',
  FINALIZED: 'BLOCKCHAIN',
  FAILED:    'SERVICE',
  REORGED:   'BLOCKCHAIN',
};

// ── 유효 전이 규칙 ────────────────────────────────────────────────────────

export const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  REQUESTED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['PENDING',   'MINED', 'FAILED'],
  PENDING:   ['MINED',     'FAILED'],
  MINED:     ['CONFIRMED', 'REORGED', 'FAILED'],
  CONFIRMED: ['FINALIZED'],
  FINALIZED: [],   // 종단 — PoS 절대 불변
  FAILED:    [],   // 종단
  REORGED:   ['MINED', 'FAILED'],
};

// ── 서비스 ────────────────────────────────────────────────────────────────

/**
 * TxStateMachineService
 *
 * Observer 사용 예:
 *   txService.on('transition', (e: TxTransitionEvent) => {
 *     if (e.to === 'CONFIRMED') ledger.recordHolding(e.req);
 *     if (e.to === 'FAILED')    alertOps(e.req);
 *   });
 */
export class TxStateMachineService extends EventEmitter {
  private static readonly GAS_BUMP_PERCENT   = 20;
  private static readonly STALE_MINUTES      = 10;
  private static readonly REORG_WAIT_BLOCKS  = 5;

  constructor(
    private readonly repo:   TxRepository,
    private readonly vasp:   VaspTxClient,
    private readonly wallet?: WalletResolver,
  ) {
    super();
  }

  // ── REQUESTED → SUBMITTED ───────────────────────────────────────────────

  /**
   * NFT 발행 요청 생성 + VASP 전송
   *
   * 흐름:
   *   1. UUID requestId 생성 (Idempotency key)
   *   2. DB INSERT (REQUESTED)
   *   3. walletResolver.getWalletAddr(userId)
   *   4. vasp.submitMint() → txHash
   *   5. DB UPDATE (SUBMITTED, txHash)
   *
   * @returns requestId (이후 상태 조회에 사용)
   */
  async submitMintRequest(params: {
    userId:      string;
    tokenId:     bigint;
    amount:      bigint;
    walletAddr?: string;  // 제공 시 WalletResolver 호출 생략 (IssuerService가 KYC 후 전달)
  }): Promise<{ requestId: string; txHash: string }> {
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

    try {
      const walletAddr = params.walletAddr ?? await this.wallet!.getWalletAddr(userId);
      const { txHash } = await this.vasp.submitMint({
        to: walletAddr, tokenId, amount, requestId: id,
      });
      await this._transition(req, 'SUBMITTED', { txHash });
      return { requestId: id, txHash };
    } catch (err) {
      await this._transition(req, 'FAILED', { failReason: `submit failed: ${String(err)}` });
      throw err;
    }
  }

  // ── TX 콜백 핸들러 ─────────────────────────────────────────────────────

  /**
   * TX가 블록에 포함됨 → MINED 전이
   * 호출 경로: VASP Webhook, ChainEventListener Issued 이벤트, pollStaleRequests confirmed
   * PENDING 또는 SUBMITTED 상태에서만 전이 (그 외 상태는 early return)
   */
  async handleMined(requestId: string, blockNumber: number, source?: string): Promise<void> {
    const req = await this._getOrThrow(requestId);
    if (req.status !== 'PENDING' && req.status !== 'SUBMITTED') return;

    await this._transition(req, 'MINED', { blockNumber }, source);
  }

  /**
   * 충분한 블록 확인 → CONFIRMED 전이
   * ConsumerGroupWorker에서 이 메서드 호출 후 원장 업데이트
   *
   * MINED 상태에서만 전이.
   * CONFIRMED 전이 후 LedgerService.recordHolding(+1)
   */
  async handleConfirmed(requestId: string, source?: string): Promise<void> {
    const req = await this._getOrThrow(requestId);
    if (req.status !== 'MINED') return;

    await this._transition(req, 'CONFIRMED', undefined, source);
  }

  /**
   * PoS Finality 확인 → FINALIZED 전이 (종단)
   * ChainEventListener가 2/3+ validator 동의 확인 후 호출
   *
   * CONFIRMED 상태에서만 전이. FINALIZED 이후 REORG 불가.
   */
  async handleFinalized(requestId: string): Promise<void> {
    const req = await this._getOrThrow(requestId);
    if (req.status !== 'CONFIRMED') return;

    await this._transition(req, 'FINALIZED');
  }

  /**
   * REVERT 수신 → FAILED 전이 + reason 저장
   * 즉시 실패 처리, 자동 재시도 없음 (비즈니스 판단 필요)
   */
  async handleFailed(requestId: string, reason: string): Promise<void> {
    const req = await this._getOrThrow(requestId);
    if (req.status === 'FAILED') return;
    await this._transition(req, 'FAILED', { failReason: reason });
  }

  // ── TIMEOUT 처리 ──────────────────────────────────────────────────────────

  /**
   * TX가 mempool에서 일정 시간 미채굴 → gas bump 재전송
   *
   * 흐름:
   *   1. PENDING 상태 확인
   *   2. vasp.resubmitWithGasBump(txHash, 20%) → 새 txHash
   *   3. DB UPDATE (PENDING, newTxHash, retryCount++)
   *
   * 주의: 원래 TX가 나중에 채굴될 수 있음 → Idempotency로 중복 방어
   */
  async handleTimeout(requestId: string): Promise<void> {
    const req = await this._getOrThrow(requestId);
    if (req.status !== 'PENDING' || !req.txHash) return;

    const { txHash: newTxHash } = await this.vasp.resubmitWithGasBump(
      req.txHash,
      TxStateMachineService.GAS_BUMP_PERCENT,
    );
    // Gas bump: 상태 유지(PENDING), txHash·retryCount만 갱신 — 상태 전이 아님
    await this.repo.updateStatus(req.id, 'PENDING', { txHash: newTxHash, retryCount: req.retryCount + 1 });
  }

  // ── REORG 처리 ────────────────────────────────────────────────────────────

  /**
   * MINED 상태 TX가 REORG로 소실 → REORGED 전이
   *
   * 흐름:
   *   1. MINED → REORGED 전이 (FINALIZED 이전에만 REORG 가능)
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

    await this._transition(req, 'REORGED');

    await this._waitBlocks(TxStateMachineService.REORG_WAIT_BLOCKS);
    const result = await this.vasp.getStatus(req.txHash);
    const reorgedReq = { ...req, status: 'REORGED' as TxStatus };
    if (result.status === 'mined') {
      await this._transition(reorgedReq, 'MINED');
    } else {
      await this._transition(reorgedReq, 'FAILED', { failReason: 'reorg: tx not found after wait' });
    }
  }

  private async _waitBlocks(blocks: number): Promise<void> {
    await new Promise(r => setTimeout(r, blocks * 12_000)); // PoS ~12s/block
  }

  // ── Stale 폴링 ─────────────────────────────────────────────────────────

  /**
   * PENDING 10분 초과 건 → VASP API 직접 조회 → 상태 갱신
   *
   * 흐름:
   *   1. DB에서 PENDING + createdAt < now - 10분 목록 조회
   *   2. 건별 vasp.getStatus(txHash) 조회
   *   3. 결과별 전이:
   *      confirmed  → handleConfirmed()  (VASP confirmed = 충분한 블록 확인)
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

        switch (result.status) {
          case 'confirmed':
            // PENDING → MINED → CONFIRMED (직접 PENDING→CONFIRMED 전이 없음)
            await this.handleMined(req.id, result.blockNumber ?? 0, 'POLL_STALE');
            await this.handleConfirmed(req.id, 'POLL_STALE');
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

  /** 상태 전이 + Observer 이벤트 방출 */
  private async _transition(
    req:    MintRequest,
    to:     TxStatus,
    extra?: Partial<MintRequest>,
    source?: string,
  ): Promise<void> {
    const from = req.status;
    if (!VALID_TRANSITIONS[from].includes(to)) {
      throw new InvalidStatusTransitionError(from, to);
    }
    await this.repo.updateStatus(req.id, to, extra);
    const updated: MintRequest = { ...req, status: to, ...extra, updatedAt: new Date() };
    console.log(`[TxStateMachine] ${from}(${TX_STATUS_LAYER[from]}) → ${to}(${TX_STATUS_LAYER[to]})  id=${req.id.slice(0, 8)}…`);
    this.emit('transition', { requestId: req.id, from, to, req: updated, source } satisfies TxTransitionEvent);
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
