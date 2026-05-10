/**
 * S50 실습 — 장애 주입 기반 복원력 검증: VASP 중단·Reorg·Consumer 크래시
 *
 * 강의 노트: M8_S50_fault_injection.md
 *
 * 실행 방법 (루트에서): npm run exercise:s50
 *
 * 목표:
 *   [1] 정상 E2E: 이벤트 → 조건 판단 → 발행 → 원장 업데이트
 *   [2] 장애 주입 1: VASP 3회 실패 → 지수 백오프 재시도 → 4회 성공
 *   [3] 장애 주입 1b: VASP 5회 전부 실패 → FAILED + DLQ 이동
 *   [4] 장애 주입 2: Reorg 시뮬레이션 → 원장 REORGED → 재확인 후 CONFIRMED
 *   [5] 장애 주입 3: Consumer 크래시 후 재시작 → 중복 없이 재처리
 *   [6] 2-of-3 서명 방어: 1-of-3 대형 TX → 실행 불가 / 2-of-3 → 성공
 */

import { ethers } from 'ethers';
import { randomUUID } from 'crypto';

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

export type MintStatus =
  | 'PENDING' | 'SUBMITTED' | 'MINED' | 'FINALIZED' | 'CONFIRMED'
  | 'FAILED' | 'REORGED';

export interface MintRequest {
  id: string;
  userId: string;
  tokenId: bigint;
  amount: bigint;
  activityId: string;
  status: MintStatus;
  vaspTxId?: string;
  onChainTxHash?: string;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DLQItem {
  id: string;
  mintRequestId: string;
  reason: string;
  createdAt: Date;
}

// ─── 인메모리 원장 (LedgerService 시뮬레이션) ─────────────────────────────────

export class MockLedgerService {
  private store = new Map<string, MintRequest>();

  async createMintRequest(params: {
    userId: string; tokenId: bigint; amount: bigint; activityId: string;
  }): Promise<MintRequest> {
    const req: MintRequest = {
      id: randomUUID(), ...params, status: 'PENDING',
      retryCount: 0, createdAt: new Date(), updatedAt: new Date(),
    };
    this.store.set(req.id, { ...req });
    return req;
  }

  async updateStatus(
    id: string,
    status: MintStatus,
    extra: Partial<MintRequest> = {},
  ): Promise<MintRequest> {
    const req = this.store.get(id);
    if (!req) throw new Error(`MintRequest not found: ${id}`);
    const updated = { ...req, ...extra, status, updatedAt: new Date() };
    this.store.set(id, updated);
    return updated;
  }

  async get(id: string): Promise<MintRequest | null> {
    return this.store.get(id) ?? null;
  }

  // 멱등성: 이미 CONFIRMED인 경우 중복 처리 무시 (ON CONFLICT DO NOTHING 시뮬레이션)
  async confirmIfNotAlready(id: string, txHash: string): Promise<boolean> {
    const req = this.store.get(id);
    if (!req) throw new Error(`MintRequest not found: ${id}`);
    if (req.status === 'CONFIRMED') return false; // 이미 처리됨 → 무시
    await this.updateStatus(id, 'CONFIRMED', { onChainTxHash: txHash });
    return true;
  }
}

// ─── DLQ (Dead Letter Queue) ──────────────────────────────────────────────────

export class MockDLQService {
  private queue: DLQItem[] = [];

  async push(mintRequestId: string, reason: string): Promise<void> {
    this.queue.push({ id: randomUUID(), mintRequestId, reason, createdAt: new Date() });
  }

  async get(mintRequestId: string): Promise<DLQItem | null> {
    return this.queue.find(i => i.mintRequestId === mintRequestId) ?? null;
  }

  count(): number { return this.queue.length; }
}

// ─── VASP API 클라이언트 (장애 주입 지원) ─────────────────────────────────────

export class MockVaspApiClient {
  private callCount = 0;
  private failUntil: number;           // 이 호출 번호까지 실패
  public readonly calls: number[] = []; // 호출 타임스탬프 기록

  constructor(failUntil = 0) {
    this.failUntil = failUntil;
  }

  async mint(params: { to: string; tokenId: bigint; amount: bigint; requestId: string }): Promise<{ txId: string }> {
    this.callCount++;
    this.calls.push(Date.now());

    if (this.callCount <= this.failUntil) {
      throw new Error(`VASP_UNAVAILABLE: Connection refused (attempt ${this.callCount})`);
    }
    return { txId: `vasp-tx-${params.requestId.slice(0, 8)}` };
  }

  getCallCount(): number { return this.callCount; }
}

// ─── 지수 백오프 RetryHandler ─────────────────────────────────────────────────

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number; // 테스트에서 0으로 설정 (실제: 1000)
  onRetry?: (attempt: number, err: Error) => void;
}

export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const baseDelay = opts.baseDelayMs ?? 1000;
  let lastErr: Error = new Error('Unknown');

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      if (attempt > opts.maxRetries) break;
      opts.onRetry?.(attempt, lastErr);
      if (baseDelay > 0) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastErr;
}

// ─── IssuerService (지수 백오프 + DLQ) ────────────────────────────────────────

export class MockIssuerService {
  constructor(
    private readonly vaspApi: MockVaspApiClient,
    private readonly ledger: MockLedgerService,
    private readonly dlq: MockDLQService,
    private readonly baseDelayMs = 0, // 테스트: 0ms
  ) {}

  async issueSingleWithRetry(params: {
    to: string; tokenId: bigint; amount: bigint; requestId: string; maxRetries: number;
  }): Promise<{ success: boolean; txId?: string }> {
    try {
      const result = await withExponentialBackoff(
        () => this.vaspApi.mint({
          to: params.to, tokenId: params.tokenId,
          amount: params.amount, requestId: params.requestId,
        }),
        {
          maxRetries: params.maxRetries,
          baseDelayMs: this.baseDelayMs,
          onRetry: (attempt, err) => {
            console.log(`    [Retry ${attempt}] ${err.message}`);
          },
        },
      );

      await this.ledger.updateStatus(params.requestId, 'SUBMITTED', { vaspTxId: result.txId });
      return { success: true, txId: result.txId };
    } catch (err) {
      await this.ledger.updateStatus(params.requestId, 'FAILED');
      await this.dlq.push(params.requestId, (err as Error).message);
      return { success: false };
    }
  }
}

// ─── Gnosis Safe 2-of-3 시뮬레이션 (S48에서 구현한 축약판) ─────────────────────

export class SimpleSafe {
  private readonly owners: string[];
  private readonly threshold: number;

  constructor(owners: string[], threshold: number) {
    this.owners    = owners;
    this.threshold = threshold;
  }

  execTransaction(
    signatures: Array<{ signer: string; sig: string }>,
  ): { txHash: string } {
    const validSigners = signatures.filter(s =>
      this.owners.includes(s.signer) && s.sig.length > 0,
    ).length;

    if (validSigners < this.threshold) {
      throw new Error(`GS020: Got ${validSigners}, required ${this.threshold}`);
    }
    return { txHash: `0x${randomUUID().replace(/-/g, '')}` };
  }
}

// ─── Redis Streams Consumer 크래시 시뮬레이션 ─────────────────────────────────

export class MockRedisStream {
  private messages: Array<{ id: string; eventId: string; acked: boolean }> = [];
  private pendingEntryList: Set<string> = new Set(); // 처리 중 미ACK 메시지

  publish(eventId: string): string {
    const msgId = randomUUID();
    this.messages.push({ id: msgId, eventId, acked: false });
    return msgId;
  }

  // Consumer가 메시지를 받아서 처리 시작 (ACK 전 상태 → PEL)
  receive(n = 1): Array<{ id: string; eventId: string }> {
    const pending = this.messages.filter(m => !m.acked && !this.pendingEntryList.has(m.id));
    const batch   = pending.slice(0, n);
    batch.forEach(m => this.pendingEntryList.add(m.id));
    return batch;
  }

  ack(msgId: string): void {
    const msg = this.messages.find(m => m.id === msgId);
    if (msg) { msg.acked = true; this.pendingEntryList.delete(msgId); }
  }

  // XAUTOCLAIM: 미ACK 메시지 재할당 (Consumer 크래시 후 복구)
  xautoclaim(): Array<{ id: string; eventId: string }> {
    return [...this.pendingEntryList].map(id => {
      const msg = this.messages.find(m => m.id === id)!;
      return { id: msg.id, eventId: msg.eventId };
    });
  }

  pendingCount(): number { return this.pendingEntryList.size; }
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

async function expectError(
  label: string, fn: () => Promise<unknown>,
  errorCheck?: (err: Error) => boolean,
): Promise<void> {
  try {
    await fn();
    check(`${label} → 에러 발생해야 함`, false);
  } catch (err) {
    check(label, errorCheck ? errorCheck(err as Error) : true);
  }
}

// ─── 실습 진입점 ──────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S50: 장애 주입 기반 복원력 검증 ===\n');

  // ── [1] 정상 E2E ────────────────────────────────────────────────────
  console.log('[검증 1] 정상 E2E: 이벤트 → 조건 판단 → 발행 → 원장 업데이트');

  const ledger1  = new MockLedgerService();
  const vaspOk   = new MockVaspApiClient(0); // 실패 없음
  const dlq1     = new MockDLQService();
  const issuer1  = new MockIssuerService(vaspOk, ledger1, dlq1);

  // [1] 앱 이벤트 수신 → 조건 판단 (보행 10,001보 달성 → 조건 충족)
  const event = { userId: 'user-001', eventType: 'WALKING_CHALLENGE', steps: 10_001 };
  const conditionMet = event.steps >= 10_000;
  check('조건 판단: 10,001보 >= 10,000보 충족', conditionMet);

  // [2] 발행 요청 생성
  const req1 = await ledger1.createMintRequest({
    userId: 'user-001', tokenId: 1001n, amount: 1n, activityId: 'act-001',
  });
  check('원장 상태: PENDING', req1.status === 'PENDING');

  // [3] VASP API 호출 → 발행
  const issueResult = await issuer1.issueSingleWithRetry({
    to: '0xWallet001', tokenId: req1.tokenId, amount: req1.amount,
    requestId: req1.id, maxRetries: 5,
  });
  check('발행 성공', issueResult.success);

  // [4] 온체인 확인 → CONFIRMED
  await ledger1.updateStatus(req1.id, 'MINED');
  await ledger1.updateStatus(req1.id, 'FINALIZED');
  const confirmed1 = await ledger1.updateStatus(req1.id, 'CONFIRMED', { onChainTxHash: '0xTxHash001' });
  check('원장 최종 상태: CONFIRMED', confirmed1.status === 'CONFIRMED');
  check('온체인 TX 해시 기록', confirmed1.onChainTxHash === '0xTxHash001');
  check('DLQ 적재 없음', dlq1.count() === 0);

  // ── [2] 장애 주입 1: VASP 3회 실패 → 4회 성공 ──────────────────────
  console.log('\n[검증 2] 장애 주입 1 — VASP 3회 실패 → 지수 백오프 → 4회 성공');

  const ledger2  = new MockLedgerService();
  const vasp3f   = new MockVaspApiClient(3); // 3회 실패
  const dlq2     = new MockDLQService();
  const issuer2  = new MockIssuerService(vasp3f, ledger2, dlq2, 0);

  const req2 = await ledger2.createMintRequest({
    userId: 'user-002', tokenId: 1002n, amount: 1n, activityId: 'act-002',
  });

  const result2 = await issuer2.issueSingleWithRetry({
    to: '0xWallet002', tokenId: req2.tokenId, amount: req2.amount,
    requestId: req2.id, maxRetries: 5,
  });

  check('3회 실패 후 성공: result.success = true', result2.success);
  check('총 호출 횟수: 4 (3회 실패 + 1회 성공)', vasp3f.getCallCount() === 4);
  check('DLQ 적재 없음 (성공)', dlq2.count() === 0);

  const req2Final = await ledger2.get(req2.id);
  check('원장 상태: SUBMITTED (복구 성공)', req2Final?.status === 'SUBMITTED');

  // ── [3] 장애 주입 1b: VASP 5회 전부 실패 → FAILED + DLQ ───────────
  console.log('\n[검증 3] 장애 주입 1b — VASP 5회 전부 실패 → FAILED + DLQ');

  const ledger3 = new MockLedgerService();
  const vaspAll = new MockVaspApiClient(99); // 항상 실패
  const dlq3    = new MockDLQService();
  const issuer3 = new MockIssuerService(vaspAll, ledger3, dlq3, 0);

  const req3 = await ledger3.createMintRequest({
    userId: 'user-003', tokenId: 1003n, amount: 1n, activityId: 'act-003',
  });

  const result3 = await issuer3.issueSingleWithRetry({
    to: '0xWallet003', tokenId: req3.tokenId, amount: req3.amount,
    requestId: req3.id, maxRetries: 5,
  });

  check('5회 전부 실패: result.success = false', !result3.success);
  check('총 호출 횟수: 6 (maxRetries+1)', vaspAll.getCallCount() === 6);

  const req3Final = await ledger3.get(req3.id);
  check('원장 상태: FAILED',      req3Final?.status === 'FAILED');

  const dlqItem3 = await dlq3.get(req3.id);
  check('DLQ 적재됨',             dlqItem3 !== null);
  check('DLQ reason 포함',        dlqItem3?.reason.includes('VASP_UNAVAILABLE') ?? false);

  // ── [4] 장애 주입 2: Reorg 시뮬레이션 ──────────────────────────────
  console.log('\n[검증 4] 장애 주입 2 — 블록 Reorg: CONFIRMED → REORGED → 재확인 → CONFIRMED');

  const ledger4 = new MockLedgerService();

  // NFT 발행 완료 → CONFIRMED 상태
  const req4 = await ledger4.createMintRequest({
    userId: 'user-004', tokenId: 1004n, amount: 1n, activityId: 'act-004',
  });
  await ledger4.updateStatus(req4.id, 'SUBMITTED', { vaspTxId: 'vasp-tx-004' });
  await ledger4.updateStatus(req4.id, 'MINED');
  await ledger4.updateStatus(req4.id, 'FINALIZED');
  await ledger4.updateStatus(req4.id, 'CONFIRMED', { onChainTxHash: '0xOriginalTxHash' });

  const beforeReorg = await ledger4.get(req4.id);
  check('Reorg 전 상태: CONFIRMED', beforeReorg?.status === 'CONFIRMED');

  // [Reorg 발생] FINALIZED 이전이면 REORGED 가능 — 여기서는 MINED 단계로 롤백 시뮬레이션
  // (실제: DMZ Consumer가 REORG 이벤트 수신 후 상태 전이)
  await ledger4.updateStatus(req4.id, 'REORGED');

  const reorged = await ledger4.get(req4.id);
  check('Reorg 후 상태: REORGED', reorged?.status === 'REORGED');
  check('이전 onChainTxHash 유지', reorged?.onChainTxHash === '0xOriginalTxHash');

  // [재채굴] 새 블록에서 TX 재확인 → 새 TX 해시로 CONFIRMED
  await ledger4.updateStatus(req4.id, 'MINED');
  await ledger4.updateStatus(req4.id, 'FINALIZED');
  await ledger4.updateStatus(req4.id, 'CONFIRMED', { onChainTxHash: '0xNewTxHash789' });

  const reconfirmed = await ledger4.get(req4.id);
  check('재확인 후 상태: CONFIRMED', reconfirmed?.status === 'CONFIRMED');
  check('새 TX 해시로 업데이트', reconfirmed?.onChainTxHash === '0xNewTxHash789');

  // ── [5] 장애 주입 3: Consumer 크래시 → 재시작 → 중복 없음 ──────────
  console.log('\n[검증 5] 장애 주입 3 — Consumer 크래시 후 재시작: 중복 없이 재처리');

  const stream5  = new MockRedisStream();
  const ledger5  = new MockLedgerService();
  const processed5 = new Map<string, number>(); // eventId → 처리 횟수

  // Redis Stream에 메시지 2개 투입
  const msgId_100 = stream5.publish('evt-100');
  const msgId_101 = stream5.publish('evt-101');

  // Consumer 1: evt-100 메시지 수신 → 처리 중 크래시 (ACK 전)
  const [msg100] = stream5.receive(1);
  check('Consumer 1: evt-100 수신', msg100.eventId === 'evt-100');
  check('PEL 크기: 1 (미ACK)', stream5.pendingCount() === 1);

  // 크래시 시뮬레이션: ACK 없이 종료 → PEL에 남음

  // Consumer 2 재시작: XAUTOCLAIM으로 미ACK 메시지 재할당
  const reclaimed = stream5.xautoclaim();
  check('XAUTOCLAIM: 미ACK 메시지 1개 재할당', reclaimed.length === 1);
  check('재할당 메시지: evt-100', reclaimed[0]?.eventId === 'evt-100');

  // evt-100 재처리 + 멱등성 확인 (ON CONFLICT DO NOTHING)
  const req5_100 = await ledger5.createMintRequest({
    userId: 'evt-100-user', tokenId: 5100n, amount: 1n, activityId: 'evt-100',
  });

  // 첫 번째 처리
  const first = await ledger5.confirmIfNotAlready(req5_100.id, '0xTx100a');
  processed5.set('evt-100', (processed5.get('evt-100') ?? 0) + (first ? 1 : 0));

  // 두 번째 처리 시도 (크래시 후 재처리) → 이미 CONFIRMED → 무시
  const second = await ledger5.confirmIfNotAlready(req5_100.id, '0xTx100b');
  processed5.set('evt-100', (processed5.get('evt-100') ?? 0) + (second ? 1 : 0));

  check('evt-100: 2번 처리됐지만 원장은 1회만 업데이트', processed5.get('evt-100') === 1);

  // ACK 처리
  stream5.ack(reclaimed[0].id);
  check('evt-100 ACK 후 PEL 크기: 0', stream5.pendingCount() === 0);

  // evt-101 정상 처리
  const [msg101] = stream5.receive(1);
  check('evt-101 수신', msg101.eventId === 'evt-101');
  stream5.ack(msg101.id);

  const req5_101 = await ledger5.createMintRequest({
    userId: 'evt-101-user', tokenId: 5101n, amount: 1n, activityId: 'evt-101',
  });
  const confirmed101 = await ledger5.confirmIfNotAlready(req5_101.id, '0xTx101');
  check('evt-101 정상 처리: 1회 업데이트', confirmed101 === true);

  // ── [6] 2-of-3 서명 방어: 대형 TX 1-of-3 → 불가 / 2-of-3 → 성공 ──
  console.log('\n[검증 6] Gnosis Safe 2-of-3 서명 방어 — 대형 TX');

  const signers = ['0xSignerA', '0xSignerB', '0xSignerC'];
  const safe    = new SimpleSafe(signers, 2);

  // 1-of-3만으로 대형 TX 실행 시도 → GS020
  try {
    safe.execTransaction([{ signer: '0xSignerA', sig: '0xsig_a' }]);
    check('1-of-3 → 실행 불가', false);
  } catch (err) {
    check('1-of-3 → GS020 revert', (err as Error).message.includes('GS020'));
  }

  // 서명 없이 시도
  try {
    safe.execTransaction([]);
    check('0-of-3 → 실행 불가', false);
  } catch (err) {
    check('0-of-3 → GS020 revert', (err as Error).message.includes('GS020'));
  }

  // 2-of-3 서명 후 대형 TX 실행 → 성공
  const execResult = safe.execTransaction([
    { signer: '0xSignerA', sig: '0xsig_a' },
    { signer: '0xSignerB', sig: '0xsig_b' },
  ]);
  check('2-of-3 서명 → execTransaction 성공', /^0x/.test(execResult.txHash));

  // ─── 정리 ───────────────────────────────────────────────────────────────
  console.log('\n=== S50 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. 장애 주입: "올바른 결과"가 아닌 "올바른 실패"를 검증 — 예측 가능한 실패 설계');
  console.log('  2. 지수 백오프: 재시도 폭탄 방지 (1초→2초→4초→8초) — VASP 회복 기회 제공');
  console.log('  3. DLQ: maxRetries 초과 → FAILED + DLQ 이동 → 운영팀 수동 재처리');
  console.log('  4. Reorg: MINED 구간에서만 REORGED 전이 가능 — FINALIZED 이후 Reorg 불가 (PoS 보장)');
  console.log('  5. Consumer 멱등성: ON CONFLICT DO NOTHING → 크래시 후 재처리해도 원장 1건');
  console.log('  6. Circuit Breaker: OPEN 상태 → 모든 VASP 호출 즉시 실패 (폭탄 방지)');
})();
