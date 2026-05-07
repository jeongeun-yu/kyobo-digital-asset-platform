/**
 * S17 실습 — Decorator 패턴 + Circuit Breaker
 *
 * 강의 노트: M3_S17_retry_backoff.md
 *
 * 실행 방법:
 *   npx ts-node course/exercises/M3/S17_decorator_patterns.ts
 *
 * 목표:
 *   [1] LoggingAdapterDecorator — 메서드 경과 시간 측정 확인 (참조)
 *   [2] RetryAdapterDecorator   — 일시적 실패 자동 재시도 확인 (참조)
 *   [3] NON_RETRYABLE 패턴     — REVERT/잔액 부족은 즉시 throw 확인 (참조)
 *   [4] Decorator 조합          — TODO: Retry(Logging(adapter)) 직접 합성
 *   [5] CircuitBreaker          — TODO: CLOSED → OPEN → HALF_OPEN 흐름 직접 구성
 *
 * 참조 구현:
 *   dmz/packages/chain-adapters/src/decorators/LoggingAdapterDecorator.ts
 *   dmz/packages/chain-adapters/src/decorators/RetryAdapterDecorator.ts
 *   dmz/packages/core-banking/src/adapters/CircuitBreaker.ts
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
import {
  LoggingAdapterDecorator,
  RetryAdapterDecorator,
} from '@kyobo/chain-adapters';
import {
  CircuitBreaker,
  CircuitOpenError,
} from '@kyobo/core-banking';
import { evmConfig } from '@kyobo/shared';
import { EVMAdapter } from '@kyobo/chain-adapters';

// ── 헬퍼 ────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`  ${pass ? '✅' : '❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

async function tryCheck(label: string, fn: () => Promise<boolean>) {
  try {
    const pass = await fn();
    check(label, pass);
  } catch (e: any) {
    console.log(`  ❌ ${label} — ${e.message}`);
    process.exitCode = 1;
  }
}

// ── Stub 어댑터 ──────────────────────────────────────────────────────────────
//
// 네트워크 없이 Decorator 동작을 검증하기 위한 인메모리 어댑터.
// callCount, failUntil을 외부에서 조작해 실패 시나리오를 만든다.

const STUB_RECEIPT: TransactionReceipt = {
  txHash: '0xstub', blockNumber: 1, blockHash: '0xblock',
  status: 'success', gasUsed: 21000n, timestamp: Date.now(),
};

class ControllableAdapter implements IBlockchainAdapter {
  readonly chainId   = 'stub-1';
  readonly chainType = 'EVM' as const;

  callCount = 0;
  failUntil = 0;        // callCount < failUntil 이면 에러 throw
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
  async getBalance(): Promise<bigint> { return 1n; }
  async call(_p: ContractCallParams):            Promise<unknown>             { return null; }
  async sendTransaction(_p: ContractCallParams): Promise<TransactionReceipt>  { return STUB_RECEIPT; }
  async getReceipt(): Promise<TransactionReceipt | null> { return null; }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { return () => {}; }
  async queryEvents():   Promise<ChainEvent[]> { return []; }
}

// ════════════════════════════════════════════════════════════════════════════
// [1] LoggingAdapterDecorator — 경과 시간 측정
// ════════════════════════════════════════════════════════════════════════════

async function section1() {
  console.log('[1] LoggingAdapterDecorator — 경과 시간 측정');

  const logs: string[] = [];
  const logger = {
    info:  (msg: string) => { logs.push(`INFO:${msg}`); },
    error: (msg: string) => { logs.push(`ERROR:${msg}`); },
  };

  const inner   = new ControllableAdapter();
  const wrapped = new LoggingAdapterDecorator(inner, logger);

  await wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r1' });

  check('mintNFT 호출 후 INFO 로그 최소 1건',       logs.some(l => l.startsWith('INFO:')));
  check('로그에 mintNFT 포함',                      logs.some(l => l.toLowerCase().includes('mintnft')));
  check('inner.callCount === 1 (실제 호출 확인)',    inner.callCount === 1);
  check('에러 없으면 ERROR 로그 없음',               !logs.some(l => l.startsWith('ERROR:')));

  // 실패 케이스: ERROR 로그 발생 확인
  const inner2  = new ControllableAdapter();
  inner2.failUntil = 999;  // 항상 실패
  const logs2: string[] = [];
  const logger2 = {
    info:  (msg: string) => { logs2.push(`INFO:${msg}`); },
    error: (msg: string) => { logs2.push(`ERROR:${msg}`); },
  };
  const wrapped2 = new LoggingAdapterDecorator(inner2, logger2);

  try {
    await wrapped2.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r2' });
  } catch {}

  check('실패 시 ERROR 로그 발생',                  logs2.some(l => l.startsWith('ERROR:')));
}

// ════════════════════════════════════════════════════════════════════════════
// [2] RetryAdapterDecorator — 일시적 실패 자동 재시도
// ════════════════════════════════════════════════════════════════════════════

async function section2() {
  console.log('\n[2] RetryAdapterDecorator — 일시적 실패 자동 재시도');

  // 첫 2회 실패, 3번째 성공 → maxAttempts=3이면 통과해야 함
  const inner = new ControllableAdapter();
  inner.failUntil = 2;

  const wrapped = new RetryAdapterDecorator(inner, {
    maxAttempts:    3,
    initialDelayMs: 10,   // 테스트에서 대기 최소화
    maxDelayMs:     100,
    backoffFactor:  2,
  });

  const receipt = await wrapped.mintNFT({
    contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r3',
  });

  check('3번째 시도에 성공 (callCount === 3)',        inner.callCount === 3);
  check('최종 receipt.status === success',           receipt.status === 'success');

  // maxAttempts 초과 → 에러 throw
  const inner2 = new ControllableAdapter();
  inner2.failUntil = 999;

  const wrapped2 = new RetryAdapterDecorator(inner2, {
    maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2,
  });

  let threw = false;
  try {
    await wrapped2.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r4' });
  } catch { threw = true; }

  check('maxAttempts 초과 시 에러 throw',            threw);
  check('callCount === maxAttempts (2회 시도)',       inner2.callCount === 2);
}

// ════════════════════════════════════════════════════════════════════════════
// [3] NON_RETRYABLE — REVERT/잔액 부족은 즉시 throw
//
// "execution reverted", "insufficient funds", "nonce too high" 패턴은
// 재시도해도 소용 없는 오류 — 즉시 throw해서 DLQ로 보내야 한다.
// ════════════════════════════════════════════════════════════════════════════

async function section3() {
  console.log('\n[3] NON_RETRYABLE — 비즈니스 오류는 즉시 throw');

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
    try {
      await wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r5' });
    } catch { threw = true; }

    check(`NON_RETRYABLE "${msg.slice(0, 30)}..." → callCount === 1 (재시도 없음)`,
      threw && inner.callCount === 1);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// [4] Decorator 조합 — Retry(Logging(adapter))
//
// 데코레이터는 중첩 가능하다. 안쪽부터 바깥쪽 순으로 감싼다:
//   RetryAdapterDecorator(
//     LoggingAdapterDecorator(
//       EVMAdapter
//     )
//   )
// ════════════════════════════════════════════════════════════════════════════

async function section4() {
  console.log('\n[4] Decorator 조합 — Retry(Logging(adapter))');

  const logs: string[] = [];
  const logger = {
    info:  (msg: string) => { logs.push(`INFO:${msg}`); },
    error: (msg: string) => { logs.push(`ERROR:${msg}`); },
  };

  // 첫 번째 시도 실패, 두 번째 성공
  const inner   = new ControllableAdapter();
  inner.failUntil = 1;

  // TODO: stacked를 Retry(Logging(inner)) 형태로 직접 합성하세요.
  //   힌트: new RetryAdapterDecorator(new LoggingAdapterDecorator(inner, logger), { ... })
  const stacked: IBlockchainAdapter = null as any;  // TODO: 구현하세요

  const receipt = await stacked.mintNFT({
    contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r6',
  });

  check('조합된 스택에서 최종 성공',                  receipt.status === 'success');
  check('callCount === 2 (1회 실패 + 1회 성공)',      inner.callCount === 2);
  check('Logging이 두 번 실행됨 (INFO 최소 2건)',     logs.filter(l => l.startsWith('INFO:')).length >= 2);
  check('ERROR 로그 1건 (첫 번째 시도 실패)',         logs.filter(l => l.startsWith('ERROR:')).length >= 1);
}

// ════════════════════════════════════════════════════════════════════════════
// [5] CircuitBreaker — CLOSED → OPEN → HALF_OPEN 상태 전이
//
// 외부 서비스(Core Banking, VASP)가 연속 실패할 때
// 무한 재시도 대신 빠른 실패(fail-fast)로 전환해 리소스 낭비 방지.
// ════════════════════════════════════════════════════════════════════════════

async function section5() {
  console.log('\n[5] CircuitBreaker — 상태 전이');

  // TODO: failureThreshold=3, recoveryTimeMs=100 으로 CircuitBreaker를 직접 생성하세요.
  //   힌트: new CircuitBreaker({ failureThreshold: ..., recoveryTimeMs: ... })
  const cb: CircuitBreaker = null as any;  // TODO: 구현하세요

  // 초기 상태: CLOSED
  check('초기 상태: CLOSED',                         cb.getState() === 'CLOSED');

  // 성공 — CLOSED 유지
  await cb.execute(async () => 'ok');
  check('성공 후: CLOSED 유지',                      cb.getState() === 'CLOSED');

  // 연속 실패 3회 → OPEN 전환
  for (let i = 0; i < 3; i++) {
    try { await cb.execute(async () => { throw new Error('down'); }); } catch {}
  }
  check('3회 실패 후: OPEN',                         cb.getState() === 'OPEN');
  check('getFailures() === 3',                       cb.getFailures() === 3);

  // OPEN 상태에서 즉시 throw (CircuitOpenError)
  let circuitOpenThrown = false;
  try {
    await cb.execute(async () => 'should not run');
  } catch (err) {
    circuitOpenThrown = err instanceof CircuitOpenError;
  }
  check('OPEN 상태 → CircuitOpenError 즉시 throw',   circuitOpenThrown);

  // recoveryTimeMs 대기 → HALF_OPEN → 성공 → CLOSED
  await new Promise(r => setTimeout(r, 120));  // 100ms 초과 대기

  const result = await cb.execute(async () => 'recovered');
  check('recoveryTime 경과 후 성공 → CLOSED 복귀',   cb.getState() === 'CLOSED');
  check('복귀 후 getFailures() === 0',               cb.getFailures() === 0);
  check('복구된 요청 결과 정상 반환',                  result === 'recovered');

  // HALF_OPEN에서 실패 → 다시 OPEN
  const cb2 = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 80 });
  for (let i = 0; i < 2; i++) {
    try { await cb2.execute(async () => { throw new Error('down'); }); } catch {}
  }
  await new Promise(r => setTimeout(r, 100));
  try { await cb2.execute(async () => { throw new Error('still down'); }); } catch {}
  check('HALF_OPEN에서 실패 → OPEN 재진입',          cb2.getState() === 'OPEN');
}

// ════════════════════════════════════════════════════════════════════════════
// [보너스] Sepolia 실제 연결 (선택 실습)
// ════════════════════════════════════════════════════════════════════════════

async function sectionBonus() {
  console.log('\n[보너스] Sepolia + Decorator 스택 (실제 RPC)');

  const base    = new EVMAdapter({ rpcUrl: evmConfig.rpcUrl, chainId: evmConfig.chainId });
  const logs: string[] = [];
  const stacked = new RetryAdapterDecorator(
    new LoggingAdapterDecorator(base, {
      info:  (msg: string) => { logs.push(msg); },
      error: (msg: string) => { logs.push(`ERR:${msg}`); },
    }),
    { maxAttempts: 2, initialDelayMs: 200, maxDelayMs: 1000, backoffFactor: 2 },
  );

  const connected = await stacked.isConnected();
  check(`Sepolia 연결: ${connected}`, connected);

  if (connected) {
    const block = await stacked.getBlockNumber();
    check(`블록 넘버 > 0: ${block}`, block > 0);
    check('Logging INFO 발생', logs.length > 0);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 실습 진입점
// ════════════════════════════════════════════════════════════════════════════

(async () => {
  console.log('=== S17: Decorator 패턴 + Circuit Breaker ===\n');

  await section1();
  await section2();
  await section3();
  await section4();
  await section5();
  await sectionBonus();

  console.log('\n=== S17 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  Decorator:     어댑터 기능을 바꾸지 않고 기능 추가 (Logging, Retry)');
  console.log('  조합:           Retry(Logging(adapter)) — 중첩 가능, inner 코드 무변경');
  console.log('  NON_RETRYABLE: REVERT/잔액 부족 → 재시도 없이 즉시 DLQ');
  console.log('  CircuitBreaker: CLOSED→OPEN(N회 실패)→HALF_OPEN(복구 탐색)→CLOSED(성공)');
  console.log('  Fail-fast:      OPEN 상태에서 fn() 실행 없이 CircuitOpenError 즉시 반환');

  process.exit(process.exitCode ?? 0);
})();
