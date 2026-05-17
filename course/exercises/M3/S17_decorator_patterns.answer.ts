/**
 * S17 정답 — Decorator 패턴 + Circuit Breaker
 *
 * 목표:
 *   [1] LoggingAdapterDecorator — 메서드 경과 시간 측정
 *   [2] RetryAdapterDecorator   — 일시적 실패 자동 재시도
 *   [3] NON_RETRYABLE 패턴     — REVERT/잔액 부족은 즉시 throw
 *   [4] Decorator 조합          — Retry(Logging(adapter))
 *   [5] CircuitBreaker          — CLOSED → OPEN → HALF_OPEN 상태 전이
 *
 * 참조 구현:
 *   internal/packages/chain-adapters/src/decorators/LoggingAdapterDecorator.ts
 *   internal/packages/chain-adapters/src/decorators/RetryAdapterDecorator.ts
 *   internal/packages/core-banking/src/adapters/CircuitBreaker.ts
 */

import type {
  IBlockchainAdapter,
  ChainEvent,
  ContractCallParams,
  TransactionReceipt,
  MintParams,
  MintBatchParams,
  BurnParams,
} from '@kyobo/chain-adapters';
import { LoggingAdapterDecorator, RetryAdapterDecorator } from '@kyobo/chain-adapters';
import { CircuitBreaker, CircuitOpenError } from '@kyobo/core-banking';

// ── assert ───────────────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✅ ${msg}`);
}

// ── Stub 어댑터 ──────────────────────────────────────────────────────────────

const STUB_RECEIPT: TransactionReceipt = {
  txHash: '0xstub', blockNumber: 1, blockHash: '0xblock',
  status: 'success', gasUsed: 21000n, timestamp: Date.now(),
};

class ControllableAdapter implements IBlockchainAdapter {
  readonly chainId   = 'stub-1';
  readonly chainType = 'EVM' as const;

  callCount   = 0;
  failUntil   = 0;
  failMessage = 'transient rpc error';

  async isConnected():    Promise<boolean> { return true; }
  async getBlockNumber(): Promise<number>  { return 1; }

  async mintNFT(_p: MintParams): Promise<TransactionReceipt> {
    this.callCount++;
    if (this.callCount <= this.failUntil) throw new Error(this.failMessage);
    return { ...STUB_RECEIPT, txHash: `0xstub-${this.callCount}` };
  }

  async mintNFTBatch(_p: MintBatchParams): Promise<TransactionReceipt> { return STUB_RECEIPT; }
  async burnNFT(_p: BurnParams):           Promise<TransactionReceipt> { return STUB_RECEIPT; }
  async getBalance():                      Promise<bigint>             { return 1n; }
  async call(_p: ContractCallParams):            Promise<unknown>            { return null; }
  async sendTransaction(_p: ContractCallParams): Promise<TransactionReceipt> { return STUB_RECEIPT; }
  async getReceipt():    Promise<TransactionReceipt | null> { return null; }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { return () => {}; }
  async queryEvents():   Promise<ChainEvent[]> { return []; }
}

// ── [1] LoggingAdapterDecorator ───────────────────────────────────────────────

async function section1() {
  const logs: string[] = [];
  const logger = {
    info:  (msg: string) => { logs.push(`INFO:${msg}`); },
    error: (msg: string) => { logs.push(`ERROR:${msg}`); },
  };

  const inner   = new ControllableAdapter();
  const wrapped = new LoggingAdapterDecorator(inner, logger);

  await wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r1' });

  assert(logs.some(l => l.startsWith('INFO:')),             '[1] 성공 시 INFO 로그');
  assert(logs.some(l => l.toLowerCase().includes('mintnft')), '[1] 로그에 mintNFT 포함');
  assert(!logs.some(l => l.startsWith('ERROR:')),           '[1] 성공 시 ERROR 없음');

  const inner2  = new ControllableAdapter();
  inner2.failUntil = 999;
  const logs2: string[] = [];
  const wrapped2 = new LoggingAdapterDecorator(inner2, {
    info:  (msg: string) => { logs2.push(`INFO:${msg}`); },
    error: (msg: string) => { logs2.push(`ERROR:${msg}`); },
  });
  try { await wrapped2.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r2' }); } catch {}

  assert(logs2.some(l => l.startsWith('ERROR:')), '[1] 실패 시 ERROR 로그');
}

// ── [2] RetryAdapterDecorator ─────────────────────────────────────────────────

async function section2() {
  const inner = new ControllableAdapter();
  inner.failUntil = 2;

  const wrapped = new RetryAdapterDecorator(inner, {
    maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100, backoffFactor: 2,
  });

  const receipt = await wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r3' });

  assert(inner.callCount === 3,          '[2] 3번째 시도에 성공 (callCount === 3)');
  assert(receipt.status === 'success',   '[2] receipt.status === success');

  const inner2 = new ControllableAdapter();
  inner2.failUntil = 999;
  const wrapped2 = new RetryAdapterDecorator(inner2, {
    maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2,
  });

  let threw = false;
  try { await wrapped2.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r4' }); }
  catch { threw = true; }

  assert(threw,                          '[2] maxAttempts 초과 시 throw');
  assert(inner2.callCount === 2,         '[2] callCount === maxAttempts');
}

// ── [3] NON_RETRYABLE ─────────────────────────────────────────────────────────

async function section3() {
  const NON_RETRYABLE_CASES = [
    'execution reverted: ERC1155 transfer amount exceeds balance',
    'insufficient funds for gas * price + value',
    'nonce too high',
  ];

  for (const msg of NON_RETRYABLE_CASES) {
    const inner = new ControllableAdapter();
    inner.failUntil   = 999;
    inner.failMessage = msg;

    const wrapped = new RetryAdapterDecorator(inner, {
      maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2,
    });

    let threw = false;
    try { await wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r5' }); }
    catch { threw = true; }

    assert(threw && inner.callCount === 1,
      `[3] NON_RETRYABLE "${msg.slice(0, 30)}..." → callCount === 1`);
  }
}

// ── [4] Decorator 조합 — Retry(Logging(adapter)) ─────────────────────────────

async function section4() {
  const logs: string[] = [];
  const inner = new ControllableAdapter();
  inner.failUntil = 1;

  const stacked = new RetryAdapterDecorator(
    new LoggingAdapterDecorator(inner, {
      info:  (msg: string) => { logs.push(`INFO:${msg}`); },
      error: (msg: string) => { logs.push(`ERROR:${msg}`); },
    }),
    { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2 },
  );

  const receipt = await stacked.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r6' });

  assert(receipt.status === 'success',                              '[4] 최종 성공');
  assert(inner.callCount === 2,                                     '[4] callCount === 2');
  assert(logs.filter(l => l.startsWith('INFO:')).length >= 2,      '[4] INFO 최소 2건');
  assert(logs.filter(l => l.startsWith('ERROR:')).length >= 1,     '[4] ERROR 1건 (첫 시도 실패)');
}

// ── [5] CircuitBreaker — CLOSED → OPEN → HALF_OPEN ───────────────────────────

async function section5() {
  const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });

  assert(cb.getState() === 'CLOSED', '[5] 초기 상태: CLOSED');

  await cb.execute(async () => 'ok');
  assert(cb.getState() === 'CLOSED', '[5] 성공 후 CLOSED 유지');

  for (let i = 0; i < 3; i++) {
    try { await cb.execute(async () => { throw new Error('down'); }); } catch {}
  }
  assert(cb.getState() === 'OPEN',  '[5] 3회 실패 후 OPEN');
  assert(cb.getFailures() === 3,    '[5] getFailures() === 3');

  let circuitOpenThrown = false;
  try { await cb.execute(async () => 'should not run'); }
  catch (err) { circuitOpenThrown = err instanceof CircuitOpenError; }
  assert(circuitOpenThrown, '[5] OPEN → CircuitOpenError 즉시 throw');

  await new Promise(r => setTimeout(r, 120));

  const result = await cb.execute(async () => 'recovered');
  assert(cb.getState() === 'CLOSED', '[5] recoveryTime 경과 후 성공 → CLOSED');
  assert(cb.getFailures() === 0,     '[5] 복귀 후 getFailures() === 0');
  assert(result === 'recovered',     '[5] 복구된 요청 정상 반환');

  // HALF_OPEN에서 실패 → OPEN 재진입
  const cb2 = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 80 });
  for (let i = 0; i < 2; i++) {
    try { await cb2.execute(async () => { throw new Error('down'); }); } catch {}
  }
  await new Promise(r => setTimeout(r, 100));
  try { await cb2.execute(async () => { throw new Error('still down'); }); } catch {}
  assert(cb2.getState() === 'OPEN', '[5] HALF_OPEN 실패 → OPEN 재진입');
}

// ── 진입점 ───────────────────────────────────────────────────────────────────

(async () => {
  await section1();
  await section2();
  await section3();
  await section4();
  await section5();
  console.log('\nS17 완료');
})();
