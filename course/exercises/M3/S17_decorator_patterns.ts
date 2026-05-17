/**
 * S17 실습 — Decorator 패턴 + Circuit Breaker
 * 실행: npm run exercise:s17
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

// ── Stub 어댑터 ──────────────────────────────────────────────────────────────

const CONTRACT_ADDR = '0x4b0897b0513fdc7c541b6d9d7e929c4e5364d2db';
const USER_ADDR     = '0xa11ce00000000000000000000000000000000001';

const STUB_RECEIPT: TransactionReceipt = {
  txHash: '0xaaaa0000bbbb1111cccc2222dddd3333aaaa0000bbbb1111cccc2222dddd3333',
  blockNumber: 18500000, blockHash: '0xb10c0000000000000000000000000000000000000000000000000000000b10c0',
  status: 'success', gasUsed: 21000n, timestamp: Date.now(),
};

class ControllableAdapter implements IBlockchainAdapter {
  readonly chainId   = 'ethereum-mainnet';
  readonly chainType = 'EVM' as const;

  callCount   = 0;
  failUntil   = 0;
  failMessage = 'transient rpc error';

  async isConnected():    Promise<boolean> { return true; }
  async getBlockNumber(): Promise<number>  { return 18500000; }

  async mintNFT(_p: MintParams): Promise<TransactionReceipt> {
    this.callCount++;
    if (this.callCount <= this.failUntil) throw new Error(this.failMessage);
    const t = Date.now().toString(16);
    return { ...STUB_RECEIPT, txHash: `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}` };
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
  console.log('[1] LoggingAdapterDecorator');

  // 성공 케이스
  {
    const logs: string[] = [];
    const inner   = new ControllableAdapter();
    const wrapped = new LoggingAdapterDecorator(inner, {
      info:  (msg: string) => logs.push(`INFO:${msg}`),
      error: (msg: string) => logs.push(`ERROR:${msg}`),
    });

    await wrapped.mintNFT({ contractAddr: CONTRACT_ADDR, to: USER_ADDR, tokenId: 2048n, amount: 1n, requestId: 'mint-550e8400-e29b-41d4-a716-446655440001' });

    console.log('  성공 logs :', logs);
  }

  // 실패 케이스
  {
    const logs: string[] = [];
    const inner = new ControllableAdapter();
    inner.failUntil = 999;
    const wrapped = new LoggingAdapterDecorator(inner, {
      info:  (msg: string) => logs.push(`INFO:${msg}`),
      error: (msg: string) => logs.push(`ERROR:${msg}`),
    });

    try { await wrapped.mintNFT({ contractAddr: CONTRACT_ADDR, to: USER_ADDR, tokenId: 2048n, amount: 1n, requestId: 'mint-550e8400-e29b-41d4-a716-446655440002' }); } catch {}

    console.log('  실패 logs :', logs);
  }
}

// ── [2] RetryAdapterDecorator ─────────────────────────────────────────────────

async function section2() {
  console.log('\n[2] RetryAdapterDecorator');

  // 2번 실패 후 3번째 성공
  {
    const inner = new ControllableAdapter();
    inner.failUntil = 2;

    const wrapped = new RetryAdapterDecorator(inner, {
      maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100, backoffFactor: 2,
    });

    const receipt = await wrapped.mintNFT({ contractAddr: CONTRACT_ADDR, to: USER_ADDR, tokenId: 3000n, amount: 1n, requestId: 'mint-6ba7b810-9dad-11d1-80b4-00c04fd430c8' });

    console.log('  callCount :', inner.callCount);
    console.log('  receipt   :', receipt);
  }

  // maxAttempts 초과
  {
    const inner = new ControllableAdapter();
    inner.failUntil = 999;
    const wrapped = new RetryAdapterDecorator(inner, {
      maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2,
    });

    try { await wrapped.mintNFT({ contractAddr: CONTRACT_ADDR, to: USER_ADDR, tokenId: 3000n, amount: 1n, requestId: 'mint-6ba7b811-9dad-11d1-80b4-00c04fd430c8' }); }
    catch (err) { console.log('  초과 에러 :', (err as Error).message); }

    console.log('  callCount :', inner.callCount);
  }
}

// ── [3] NON_RETRYABLE ─────────────────────────────────────────────────────────

async function section3() {
  console.log('\n[3] NON_RETRYABLE — 재시도 없이 즉시 throw');

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

    try { await wrapped.mintNFT({ contractAddr: CONTRACT_ADDR, to: USER_ADDR, tokenId: 4096n, amount: 1n, requestId: 'mint-6ba7b812-9dad-11d1-80b4-00c04fd430c8' }); }
    catch (err) { console.log(`  "${msg.slice(0, 45)}..." → callCount: ${inner.callCount}, 에러: ${(err as Error).message.slice(0, 30)}`); }
  }
}

// ── [4] Decorator 조합 — Retry(Logging(adapter)) ─────────────────────────────

async function section4() {
  console.log('\n[4] Decorator 조합 — Retry(Logging(adapter))');

  const logs: string[] = [];
  const inner = new ControllableAdapter();
  inner.failUntil = 1;

  const stacked = new RetryAdapterDecorator(
    new LoggingAdapterDecorator(inner, {
      info:  (msg: string) => logs.push(`INFO:${msg}`),
      error: (msg: string) => logs.push(`ERROR:${msg}`),
    }),
    { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2 },
  );

  const receipt = await stacked.mintNFT({ contractAddr: CONTRACT_ADDR, to: USER_ADDR, tokenId: 5000n, amount: 1n, requestId: 'mint-6ba7b813-9dad-11d1-80b4-00c04fd430c8' });

  console.log('  callCount :', inner.callCount);
  console.log('  receipt   :', receipt);
  console.log('  logs      :', logs);
}

// ── [5] CircuitBreaker — CLOSED → OPEN → HALF_OPEN ───────────────────────────

async function section5() {
  console.log('\n[5] CircuitBreaker — CLOSED → OPEN → HALF_OPEN');

  const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });

  console.log('  초기 state     :', cb.getState());

  await cb.execute(async () => 'ok');
  console.log('  성공 후 state  :', cb.getState());

  for (let i = 0; i < 3; i++) {
    try { await cb.execute(async () => { throw new Error('down'); }); } catch {}
  }
  console.log('  3회 실패 후    :', cb.getState(), '/ failures:', cb.getFailures());

  try { await cb.execute(async () => 'should not run'); }
  catch (err) { console.log('  OPEN 요청 에러 :', (err as Error).constructor.name, (err as Error).message); }

  await new Promise(r => setTimeout(r, 120));

  const result = await cb.execute(async () => 'recovered');
  console.log('  복구 후 state  :', cb.getState(), '/ failures:', cb.getFailures(), '/ result:', result);

  // HALF_OPEN → 실패 → OPEN 재진입
  const cb2 = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 80 });
  for (let i = 0; i < 2; i++) {
    try { await cb2.execute(async () => { throw new Error('down'); }); } catch {}
  }
  await new Promise(r => setTimeout(r, 100));
  try { await cb2.execute(async () => { throw new Error('still down'); }); } catch {}
  console.log('  HALF_OPEN 실패 :', cb2.getState());
}

// ── 진입점 ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S17: Decorator 패턴 + Circuit Breaker ===\n');

  await section1();
  await section2();
  await section3();
  await section4();
  await section5();

  console.log('\nS17 완료');
})();
