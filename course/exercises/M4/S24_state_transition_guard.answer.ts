/**
 * S24 실습 — 원장 일관성 보장 · 상태 전이 가드와 멱등 이벤트 처리
 *
 * 강의 노트: M4_S24_state_transition_guard.md
 *
 * 실행 방법 (루트에서): npm run exercise:s24
 *
 * 목표:
 *   [1] VALID_TRANSITIONS 맵 — MintStatus 7개 상태 전이 규칙 정의
 *   [2] updateMintRequest — 상태 전이 가드 (InvalidStateTransitionError)
 *   [3] 필드 유효성 가드 — SUBMITTED: txHash 필수, CONFIRMED: tokenId 필수
 *   [4] recordProcessedEvent — ON CONFLICT DO NOTHING 멱등성
 *   [5] handleNFTIssued — recordProcessedEvent 첫 번째 호출 순서 검증
 *   [6] REORGED → MINED 복귀 정상 전이 확인
 */

import { createHash, randomUUID } from 'crypto';

// ────────────────────────────────────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────────────────────────────────────

export type MintStatus =
  | 'REQUESTED'
  | 'SUBMITTED'
  | 'MINED'
  | 'FINALIZED'
  | 'CONFIRMED'
  | 'REORGED'
  | 'FAILED';

export interface MintRequest {
  requestId: string;
  userId: string;
  policyId: string;
  status: MintStatus;
  txHash: string | null;
  tokenId: bigint | null;
  blockNumber: bigint | null;
  errorMsg: string | null;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProcessedEventResult {
  skipped: boolean;
  id?: number;
}

interface AuditEntry {
  actor: string;
  action: string;
  resourceId: string;
  beforeState: unknown;
  afterState: unknown;
}

// ────────────────────────────────────────────────────────────────────────
// 커스텀 에러
// ────────────────────────────────────────────────────────────────────────

export class InvalidStateTransitionError extends Error {
  constructor(from: MintStatus, to: MintStatus) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class MintRequestNotFoundError extends Error {
  constructor(requestId: string) {
    super(`MintRequest not found: ${requestId}`);
    this.name = 'MintRequestNotFoundError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 1: VALID_TRANSITIONS — MintStatus 전이 규칙
//
// 전이 다이어그램:
//   REQUESTED → SUBMITTED → MINED → CONFIRMED → FINALIZED (종단)
//                  ↓          ↓ ↗ (복귀)
//               FAILED    REORGED → MINED / FAILED
//
// M3 S13의 TxStateMachineService VALID_TRANSITIONS와 동일한 패턴이지만
// 상태 수와 의미가 다르다. 두 레이어가 독립적으로 가드를 가져야 한다.
// ────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────
// 실습 2: LedgerService — updateMintRequest 상태 전이 가드 + 필드 유효성 가드
// ────────────────────────────────────────────────────────────────────────

export class LedgerService {
  // ── VALID_TRANSITIONS: 허용된 전이만 명시 ─────────────────────────────
  private static readonly VALID_TRANSITIONS: Record<MintStatus, MintStatus[]> = {
    REQUESTED: ['SUBMITTED', 'FAILED'],
    SUBMITTED: ['MINED',     'FAILED'],
    MINED:     ['CONFIRMED', 'REORGED', 'FAILED'],
    CONFIRMED: ['FINALIZED'],
    FINALIZED: [],                              // 종단 — PoS 절대 불변
    FAILED:    [],                              // 종단 — 재발행하려면 새 요청 필요
    REORGED:   ['MINED',     'FAILED'],         // 재편 → MINED 복귀 또는 포기
  };

  private mintRequests = new Map<string, MintRequest>();
  private processedEvents: Array<{ txHash: string; logIndex: number; id: number }> = [];
  private holdings = new Map<string, bigint[]>(); // userId → tokenIds
  private auditEntries: AuditEntry[] = [];
  private eventSeq = 0;

  // ── createMintRequest ────────────────────────────────────────────────

  async createMintRequest(userId: string, policyId: string): Promise<MintRequest> {
    const requestId = randomUUID();
    const now = new Date();
    const req: MintRequest = {
      requestId, userId, policyId,
      status: 'REQUESTED',
      txHash: null, tokenId: null, blockNumber: null, errorMsg: null,
      retryCount: 0, createdAt: now, updatedAt: now,
    };
    this.mintRequests.set(requestId, req);
    this._audit('system:IssuerService', 'MINT_REQUESTED', requestId, null, { status: 'REQUESTED' });
    return { ...req };
  }

  // ── getMintRequest ───────────────────────────────────────────────────

  async getMintRequest(requestId: string): Promise<MintRequest | null> {
    const req = this.mintRequests.get(requestId);
    return req ? { ...req } : null;
  }

  // ── updateMintRequest — 상태 전이 가드 + 필드 유효성 가드 ─────────────

  async updateMintRequest(
    requestId: string,
    patch: {
      status: MintStatus;
      txHash?: string;
      tokenId?: bigint;
      blockNumber?: bigint;
      errorMsg?: string;
    },
  ): Promise<MintRequest> {
    // 1. 레코드 존재 확인
    const current = this.mintRequests.get(requestId);
    if (!current) throw new MintRequestNotFoundError(requestId);

    // 2. 상태 전이 가드 — VALID_TRANSITIONS에 없는 전이는 즉시 예외
    const allowed = LedgerService.VALID_TRANSITIONS[current.status];
    if (!allowed.includes(patch.status)) {
      throw new InvalidStateTransitionError(current.status, patch.status);
    }

    // 3. 필드 유효성 가드 — 특정 상태에 필수 필드 확인
    if (patch.status === 'SUBMITTED' && !patch.txHash) {
      throw new Error('txHash is required for SUBMITTED status');
    }
    if (patch.status === 'CONFIRMED' && patch.tokenId === undefined) {
      throw new Error('tokenId is required for CONFIRMED status');
    }

    // 4. 업데이트 — COALESCE: 기존 값 보존
    const updated: MintRequest = {
      ...current,
      status:      patch.status,
      txHash:      patch.txHash      ?? current.txHash,
      tokenId:     patch.tokenId     ?? current.tokenId,
      blockNumber: patch.blockNumber ?? current.blockNumber,
      errorMsg:    patch.errorMsg    ?? current.errorMsg,
      updatedAt:   new Date(),
    };
    this.mintRequests.set(requestId, updated);

    // 5. Audit log
    this._audit('system', `STATUS_${patch.status}`, requestId,
      { status: current.status }, { status: patch.status, ...patch });

    return { ...updated };
  }

  // ── recordProcessedEvent — ON CONFLICT DO NOTHING 멱등성 ──────────────

  async recordProcessedEvent(
    txHash: string,
    logIndex: number,
    eventName: string,
    blockNumber: bigint,
    payload: unknown,
  ): Promise<ProcessedEventResult> {
    // UNIQUE (txHash, logIndex)
    const exists = this.processedEvents.some(
      e => e.txHash === txHash && e.logIndex === logIndex,
    );
    if (exists) return { skipped: true };

    const id = ++this.eventSeq;
    this.processedEvents.push({ txHash, logIndex, id });
    return { skipped: false, id };
  }

  // ── addHolding ───────────────────────────────────────────────────────

  async addHolding(userId: string, tokenId: bigint, _policyId: string): Promise<void> {
    const tokens = this.holdings.get(userId) ?? [];
    if (tokens.includes(tokenId)) return;
    this.holdings.set(userId, [...tokens, tokenId]);
  }

  async getHoldings(userId: string): Promise<bigint[]> {
    return this.holdings.get(userId) ?? [];
  }

  getAuditEntries(): AuditEntry[] { return [...this.auditEntries]; }

  private _audit(actor: string, action: string, resourceId: string,
    beforeState: unknown, afterState: unknown) {
    this.auditEntries.push({ actor, action, resourceId, beforeState, afterState });
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 3: handleNFTIssued — recordProcessedEvent를 첫 번째 호출해야 한다
// ────────────────────────────────────────────────────────────────────────

export async function handleNFTIssued(
  ledger: LedgerService,
  event: { txHash: string; logIndex: number; blockNumber: bigint; tokenId: bigint; userId: string; policyId: string; requestId: string },
): Promise<{ processed: boolean }> {
  // 1단계: 중복 이벤트 체크 — 반드시 가장 먼저
  const evResult = await ledger.recordProcessedEvent(
    event.txHash, event.logIndex, 'NFTIssued', event.blockNumber, event,
  );
  if (evResult.skipped) {
    return { processed: false };
  }

  // 2단계: 신규 이벤트만 비즈니스 로직 실행
  await ledger.updateMintRequest(event.requestId, {
    status: 'CONFIRMED',
    tokenId: event.tokenId,
    txHash: event.txHash,
  });
  await ledger.addHolding(event.userId, event.tokenId, event.policyId);

  return { processed: true };
}

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

async function expectRejects(label: string, promise: Promise<unknown>, errorType?: string) {
  try {
    await promise;
    check(`${label} → 예외 발생해야 함`, false);
  } catch (err) {
    if (errorType) {
      const isCorrectType = err instanceof Error && err.name === errorType;
      check(`${label} → ${errorType}`, isCorrectType);
    } else {
      check(`${label} → 예외 발생`, true);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S24: 상태 전이 가드 + 멱등 이벤트 처리 ===\n');

  // ── [1] 정방향 전이 — REQUESTED → CONFIRMED 전체 경로 ────────────────
  console.log('[검증 1] 정방향 전이 — REQUESTED → CONFIRMED');

  const ledger = new LedgerService();
  const req = await ledger.createMintRequest('user-1', 'WALK-10000');

  const sub = await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xabc123' });
  check('REQUESTED → SUBMITTED 성공',  sub.status === 'SUBMITTED');
  check('txHash 설정됨',               sub.txHash === '0xabc123');

  const mined = await ledger.updateMintRequest(req.requestId, { status: 'MINED', blockNumber: 12345n });
  check('SUBMITTED → MINED 성공',      mined.status === 'MINED');

  const fin = await ledger.updateMintRequest(req.requestId, { status: 'FINALIZED' });
  check('MINED → FINALIZED 성공',      fin.status === 'FINALIZED');

  // ── [2] 역전이 차단 ──────────────────────────────────────────────────
  console.log('\n[검증 2] 역전이 차단 — InvalidStateTransitionError');

  // CONFIRMED 상태 레코드 직접 생성 (테스트용)
  const confirmedReq = await ledger.createMintRequest('user-conf', 'WALK');
  await ledger.updateMintRequest(confirmedReq.requestId, { status: 'SUBMITTED', txHash: '0xconf' });
  await ledger.updateMintRequest(confirmedReq.requestId, { status: 'MINED' });
  await ledger.updateMintRequest(confirmedReq.requestId, { status: 'FINALIZED' });
  await ledger.updateMintRequest(confirmedReq.requestId, { status: 'CONFIRMED', tokenId: 9001n, txHash: '0xconf' });

  await expectRejects(
    'CONFIRMED → SUBMITTED',
    ledger.updateMintRequest(confirmedReq.requestId, { status: 'SUBMITTED' }),
    'InvalidStateTransitionError',
  );

  // FAILED 상태 레코드
  const failedReq = await ledger.createMintRequest('user-fail', 'WALK');
  await ledger.updateMintRequest(failedReq.requestId, { status: 'FAILED', errorMsg: 'REVERT' });

  await expectRejects(
    'FAILED → CONFIRMED',
    ledger.updateMintRequest(failedReq.requestId, { status: 'CONFIRMED', tokenId: 1n }),
    'InvalidStateTransitionError',
  );

  // MINED → CONFIRMED 차단 (FINALIZED 반드시 거쳐야)
  const minedReq = await ledger.createMintRequest('user-mined', 'WALK');
  await ledger.updateMintRequest(minedReq.requestId, { status: 'SUBMITTED', txHash: '0xmined' });
  await ledger.updateMintRequest(minedReq.requestId, { status: 'MINED' });

  await expectRejects(
    'MINED → CONFIRMED (FINALIZED 건너뜀)',
    ledger.updateMintRequest(minedReq.requestId, { status: 'CONFIRMED', tokenId: 1n }),
    'InvalidStateTransitionError',
  );

  // ── [3] 필드 유효성 가드 ─────────────────────────────────────────────
  console.log('\n[검증 3] 필드 유효성 가드');

  const req2 = await ledger.createMintRequest('user-2', 'WALK-10000');

  await expectRejects(
    'SUBMITTED 전이 시 txHash 없으면 에러',
    ledger.updateMintRequest(req2.requestId, { status: 'SUBMITTED' }),
  );

  await ledger.updateMintRequest(req2.requestId, { status: 'SUBMITTED', txHash: '0xvalid' });
  await ledger.updateMintRequest(req2.requestId, { status: 'MINED' });
  await ledger.updateMintRequest(req2.requestId, { status: 'FINALIZED' });

  await expectRejects(
    'CONFIRMED 전이 시 tokenId 없으면 에러',
    ledger.updateMintRequest(req2.requestId, { status: 'CONFIRMED' }),
  );

  // ── [4] 멱등성 — 동일 (txHash, logIndex) 2회 처리 ────────────────────
  console.log('\n[검증 4] 멱등성 — recordProcessedEvent');

  const r1 = await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', 100n, {});
  const r2 = await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', 100n, {});
  const r3 = await ledger.recordProcessedEvent('0xabc', 1, 'NFTIssued', 100n, {});

  check('첫 번째 처리: skipped = false', r1.skipped === false);
  check('중복 처리: skipped = true',     r2.skipped === true);
  check('중복 처리: id 없음',            r2.id === undefined);
  check('다른 logIndex: skipped = false', r3.skipped === false);
  check('같은 txHash, 다른 logIndex → 별개 이벤트', r1.id !== r3.id);

  // ── [5] handleNFTIssued — 순서 검증 ─────────────────────────────────
  console.log('\n[검증 5] handleNFTIssued — recordProcessedEvent 첫 번째 호출 검증');

  const ledger2 = new LedgerService();
  const rq = await ledger2.createMintRequest('user-evt', 'CYCLE-5000');
  await ledger2.updateMintRequest(rq.requestId, { status: 'SUBMITTED', txHash: '0xevt' });
  await ledger2.updateMintRequest(rq.requestId, { status: 'MINED' });
  await ledger2.updateMintRequest(rq.requestId, { status: 'FINALIZED' });

  const evt = { txHash: '0xevt', logIndex: 0, blockNumber: 12500n, tokenId: 3001n, userId: 'user-evt', policyId: 'CYCLE-5000', requestId: rq.requestId };

  const result1 = await handleNFTIssued(ledger2, evt);
  check('첫 번째 처리: processed = true',  result1.processed === true);

  const finalReq = await ledger2.getMintRequest(rq.requestId);
  check('최종 status = CONFIRMED',          finalReq?.status === 'CONFIRMED');
  check('tokenId 확정됨',                   finalReq?.tokenId === 3001n);

  const holdings = await ledger2.getHoldings('user-evt');
  check('holdings 등록됨',                  holdings.length === 1);
  check('holdings tokenId 일치',            holdings[0] === 3001n);

  // 재처리 시뮬레이션
  const result2 = await handleNFTIssued(ledger2, evt);
  check('재처리: processed = false (skipped)', result2.processed === false);

  // CONFIRMED 상태인데 다시 updateMintRequest 시도 없음 확인
  const afterDup = await ledger2.getMintRequest(rq.requestId);
  check('재처리 후 상태 변화 없음: CONFIRMED 유지', afterDup?.status === 'CONFIRMED');

  // ── [6] REORGED → MINED 복귀 ─────────────────────────────────────────
  console.log('\n[검증 6] REORGED → MINED 복귀 (정상 전이)');

  const ledger3 = new LedgerService();
  const rq2 = await ledger3.createMintRequest('user-reorg', 'WALK-10000');
  await ledger3.updateMintRequest(rq2.requestId, { status: 'SUBMITTED', txHash: '0xreorg' });
  await ledger3.updateMintRequest(rq2.requestId, { status: 'MINED' });
  await ledger3.updateMintRequest(rq2.requestId, { status: 'REORGED' });

  const reorged = await ledger3.getMintRequest(rq2.requestId);
  check('REORGED 상태 확인', reorged?.status === 'REORGED');

  const restored = await ledger3.updateMintRequest(rq2.requestId, { status: 'MINED' });
  check('REORGED → MINED 복귀 성공', restored.status === 'MINED');

  await expectRejects(
    'REORGED 상태에서 CONFIRMED 직접 전이 차단',
    (async () => {
      const rq3 = await ledger3.createMintRequest('user-reorg2', 'WALK');
      await ledger3.updateMintRequest(rq3.requestId, { status: 'SUBMITTED', txHash: '0xr2' });
      await ledger3.updateMintRequest(rq3.requestId, { status: 'MINED' });
      await ledger3.updateMintRequest(rq3.requestId, { status: 'REORGED' });
      await ledger3.updateMintRequest(rq3.requestId, { status: 'CONFIRMED', tokenId: 1n });
    })(),
    'InvalidStateTransitionError',
  );

  // ── [7] MintRequestNotFoundError ─────────────────────────────────────
  console.log('\n[검증 7] MintRequestNotFoundError');

  await expectRejects(
    '존재하지 않는 requestId → MintRequestNotFoundError',
    ledger.updateMintRequest('not-exist-uuid', { status: 'SUBMITTED' }),
    'MintRequestNotFoundError',
  );

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S24 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. VALID_TRANSITIONS: 허용 전이만 명시 — 역전이/동일 상태 전이 자동 차단');
  console.log('  2. 종단 상태(FINALIZED, FAILED): [] → 어떤 전이도 차단');
  console.log('  3. 필드 유효성 가드: 상태 전이 가드와 독립 — 좀비 레코드 방지');
  console.log('  4. recordProcessedEvent가 이벤트 핸들러의 첫 번째 줄이어야 하는 이유: 선점 효과');
  console.log('  5. TxStateMachineService(M3)와 LedgerService(M4)가 각자 독립적으로 가드를 가져야 하는 이유: 두 레이어가 직렬로 작동하므로');
})();
