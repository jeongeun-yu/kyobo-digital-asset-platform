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

import { randomUUID } from 'crypto';

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

// ────────────────────────────────────────────────────────────────────────
// 커스텀 에러 (완성 제공 — 변경하지 말 것)
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
// 실습 1: VALID_TRANSITIONS 맵을 완성하라
//
// 전이 다이어그램:
//   REQUESTED → SUBMITTED → MINED → FINALIZED → CONFIRMED (종단)
//                  ↓          ↓ ↗ (복귀)
//               FAILED    REORGED → MINED / FAILED
//
// 힌트:
//   · 종단 상태(CONFIRMED, FAILED)는 빈 배열 []
//   · SUBMITTED → PENDING 없음 (M3 TxStateMachine과 다름!)
//   · REORGED 이후 MINED 복귀 가능, CONFIRMED 직접 불가
// ────────────────────────────────────────────────────────────────────────

export class LedgerService {
  // TODO: 아래 VALID_TRANSITIONS의 각 상태에 허용되는 다음 상태 배열을 채우세요.
  private static readonly VALID_TRANSITIONS: Record<MintStatus, MintStatus[]> = {
    REQUESTED: [], // TODO: ['SUBMITTED', 'FAILED']
    SUBMITTED: [], // TODO: ['MINED', 'FAILED']
    MINED:     [], // TODO: ['FINALIZED', 'REORGED', 'FAILED']
    FINALIZED: [], // TODO: ['CONFIRMED']
    CONFIRMED: [], // 종단 — 원장 업데이트 완료
    FAILED:    [], // 종단 — 재발행하려면 새 요청 필요
    REORGED:   [], // TODO: ['MINED', 'FAILED']
  };

  private mintRequests = new Map<string, MintRequest>();
  private processedEvents: Array<{ txHash: string; logIndex: number; id: number }> = [];
  private holdings = new Map<string, bigint[]>(); // userId → tokenIds
  private eventSeq = 0;

  // ── createMintRequest (완성 제공) ────────────────────────────────────

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
    return { ...req };
  }

  // ── getMintRequest (완성 제공) ───────────────────────────────────────

  async getMintRequest(requestId: string): Promise<MintRequest | null> {
    const req = this.mintRequests.get(requestId);
    return req ? { ...req } : null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 실습 2: updateMintRequest를 구현하라
  //
  // 순서대로 구현:
  //   1. this.mintRequests.get(requestId) — 없으면 MintRequestNotFoundError throw
  //   2. VALID_TRANSITIONS[current.status]에서 허용 목록 조회
  //      → patch.status가 허용 목록에 없으면 InvalidStateTransitionError throw
  //   3. 필드 유효성 가드:
  //      → patch.status === 'SUBMITTED' && !patch.txHash → Error('txHash is required...')
  //      → patch.status === 'CONFIRMED' && patch.tokenId === undefined → Error('tokenId is required...')
  //   4. 업데이트 객체 생성 (COALESCE: patch 값이 있으면 사용, 없으면 current 값 유지)
  //   5. this.mintRequests.set(requestId, updated)
  //   6. { ...updated } (복사본) 반환
  // ────────────────────────────────────────────────────────────────────────

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
    return undefined as never;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 실습 3: recordProcessedEvent를 구현하라
  //
  // UNIQUE 제약: (txHash, logIndex) 중복 → { skipped: true }
  //
  // 1. this.processedEvents.some()으로 중복 확인
  // 2. 중복이면 { skipped: true } 반환
  // 3. 신규이면: id = ++this.eventSeq, push, { skipped: false, id } 반환
  // ────────────────────────────────────────────────────────────────────────

  async recordProcessedEvent(
    txHash: string,
    logIndex: number,
    eventName: string,
    blockNumber: bigint,
    payload: unknown,
  ): Promise<ProcessedEventResult> {
    return undefined as never;
  }

  // ── addHolding (완성 제공) ───────────────────────────────────────────

  async addHolding(userId: string, tokenId: bigint, _policyId: string): Promise<void> {
    const tokens = this.holdings.get(userId) ?? [];
    if (tokens.includes(tokenId)) return;
    this.holdings.set(userId, [...tokens, tokenId]);
  }

  async getHoldings(userId: string): Promise<bigint[]> {
    return this.holdings.get(userId) ?? [];
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 4: handleNFTIssued를 구현하라
//
// 핵심 원칙: recordProcessedEvent를 반드시 첫 번째로 호출해야 한다 (선점 효과)
//
// 1. ledger.recordProcessedEvent() 호출 — skipped이면 { processed: false } 반환
// 2. 신규 이벤트만 비즈니스 로직 실행:
//    - ledger.updateMintRequest(requestId, { status: 'CONFIRMED', tokenId, txHash })
//    - ledger.addHolding(userId, tokenId, policyId)
// 3. { processed: true } 반환
// ────────────────────────────────────────────────────────────────────────

export async function handleNFTIssued(
  ledger: LedgerService,
  event: { txHash: string; logIndex: number; blockNumber: bigint; tokenId: bigint; userId: string; policyId: string; requestId: string },
): Promise<{ processed: boolean }> {
  return undefined as never;
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

  const failedReq = await ledger.createMintRequest('user-fail', 'WALK');
  await ledger.updateMintRequest(failedReq.requestId, { status: 'FAILED', errorMsg: 'REVERT' });

  await expectRejects(
    'FAILED → CONFIRMED',
    ledger.updateMintRequest(failedReq.requestId, { status: 'CONFIRMED', tokenId: 1n }),
    'InvalidStateTransitionError',
  );

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

  const result2 = await handleNFTIssued(ledger2, evt);
  check('재처리: processed = false (skipped)', result2.processed === false);

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
  console.log('  2. 종단 상태(CONFIRMED, FAILED): [] → 어떤 전이도 차단');
  console.log('  3. 필드 유효성 가드: 상태 전이 가드와 독립 — 좀비 레코드 방지');
  console.log('  4. recordProcessedEvent가 이벤트 핸들러의 첫 번째 줄이어야 하는 이유: 선점 효과');
  console.log('  5. TxStateMachineService(M3)와 LedgerService(M4)가 각자 독립적으로 가드를 가져야 하는 이유: 두 레이어가 직렬로 작동하므로');
})();
