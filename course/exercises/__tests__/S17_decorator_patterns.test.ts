/**
 * S17 채점 — Decorator 패턴 + Circuit Breaker
 *
 * S17_decorator_patterns.ts 는 export가 없으므로 @kyobo/chain-adapters와
 * @kyobo/core-banking 을 직접 import하여 채점한다.
 *
 * 채점 기준:
 *   · stacked (Retry(Logging(adapter))) 조합으로 mintNFT 호출 가능하고 결과 반환
 *   · CircuitBreaker 인스턴스 생성 가능
 *   · CircuitBreaker CLOSED → OPEN → HALF_OPEN → CLOSED 전이
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

// ── ControllableAdapter (S17 Stub 재현) ──────────────────────────────────────
const STUB_RECEIPT: TransactionReceipt = {
  txHash: '0xstub', blockNumber: 1, blockHash: '0xblock',
  status: 'success', gasUsed: 21000n, timestamp: Date.now(),
};

class ControllableAdapter implements IBlockchainAdapter {
  readonly chainId   = 'stub-1';
  readonly chainType = 'EVM' as const;

  callCount  = 0;
  failUntil  = 0;
  failMessage = 'transient rpc error';

  async isConnected():    Promise<boolean> { return true; }
  async getBlockNumber(): Promise<number>  { return 1; }

  async mintNFT(_p: MintParams): Promise<TransactionReceipt> {
    this.callCount++;
    if (this.callCount <= this.failUntil) throw new Error(this.failMessage);
    return { ...STUB_RECEIPT, txHash: `0xstub-${this.callCount}` };
  }

  async mintNFTBatch(_p: MintBatchParams):   Promise<TransactionReceipt>  { return STUB_RECEIPT; }
  async burnNFT(_p: BurnParams):             Promise<TransactionReceipt>  { return STUB_RECEIPT; }
  async getBalance():                        Promise<bigint>               { return 1n; }
  async call(_p: ContractCallParams):        Promise<unknown>              { return null; }
  async sendTransaction(_p: ContractCallParams): Promise<TransactionReceipt> { return STUB_RECEIPT; }
  async getReceipt():                        Promise<TransactionReceipt | null> { return null; }
  async queryEvents():                       Promise<ChainEvent[]>         { return []; }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { return () => {}; }
}

// ── 채점 테스트 ───────────────────────────────────────────────────────────────
describe('S17 채점 — Decorator 패턴 + Circuit Breaker', () => {

  describe('[1] LoggingAdapterDecorator — 경과 시간 측정', () => {
    it('mintNFT 호출 후 INFO 로그가 최소 1건 발생한다', async () => {
      const logs: string[] = [];
      const logger = {
        info:  (msg: string) => { logs.push(`INFO:${msg}`); },
        error: (msg: string) => { logs.push(`ERROR:${msg}`); },
      };
      const inner   = new ControllableAdapter();
      const wrapped = new LoggingAdapterDecorator(inner, logger);
      await wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r1' });
      expect(logs.some(l => l.startsWith('INFO:'))).toBe(true);
    });

    it('로그에 mintNFT 가 포함된다', async () => {
      const logs: string[] = [];
      const logger = {
        info:  (msg: string) => { logs.push(`INFO:${msg}`); },
        error: (msg: string) => { logs.push(`ERROR:${msg}`); },
      };
      const inner   = new ControllableAdapter();
      const wrapped = new LoggingAdapterDecorator(inner, logger);
      await wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r1' });
      expect(logs.some(l => l.toLowerCase().includes('mintnft'))).toBe(true);
    });

    it('inner.callCount === 1 (실제 어댑터 1회 호출)', async () => {
      const inner   = new ControllableAdapter();
      const wrapped = new LoggingAdapterDecorator(inner, { info: () => {}, error: () => {} });
      await wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r1' });
      expect(inner.callCount).toBe(1);
    });

    it('에러 없으면 ERROR 로그 없음', async () => {
      const logs: string[] = [];
      const inner   = new ControllableAdapter();
      const wrapped = new LoggingAdapterDecorator(inner, {
        info:  (msg: string) => { logs.push(`INFO:${msg}`); },
        error: (msg: string) => { logs.push(`ERROR:${msg}`); },
      });
      await wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r1' });
      expect(logs.some(l => l.startsWith('ERROR:'))).toBe(false);
    });

    it('실패 시 ERROR 로그 발생', async () => {
      const logs: string[] = [];
      const inner   = new ControllableAdapter();
      inner.failUntil = 999;
      const wrapped = new LoggingAdapterDecorator(inner, {
        info:  (msg: string) => { logs.push(`INFO:${msg}`); },
        error: (msg: string) => { logs.push(`ERROR:${msg}`); },
      });
      try { await wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r2' }); } catch {}
      expect(logs.some(l => l.startsWith('ERROR:'))).toBe(true);
    });
  });

  describe('[2] RetryAdapterDecorator — 일시적 실패 자동 재시도', () => {
    it('첫 2회 실패 + 3번째 성공 → maxAttempts=3이면 통과', async () => {
      const inner = new ControllableAdapter();
      inner.failUntil = 2;
      const wrapped = new RetryAdapterDecorator(inner, {
        maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100, backoffFactor: 2,
      });
      const receipt = await wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r3' });
      expect(inner.callCount).toBe(3);
      expect(receipt.status).toBe('success');
    });

    it('maxAttempts 초과 시 에러 throw', async () => {
      const inner = new ControllableAdapter();
      inner.failUntil = 999;
      const wrapped = new RetryAdapterDecorator(inner, {
        maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2,
      });
      await expect(
        wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r4' }),
      ).rejects.toThrow();
      expect(inner.callCount).toBe(2);
    });

    it('NON_RETRYABLE: "execution reverted" → callCount === 1 (즉시 throw)', async () => {
      const inner = new ControllableAdapter();
      inner.failUntil   = 999;
      inner.failMessage = 'execution reverted: ERC1155 transfer amount exceeds balance';
      const wrapped = new RetryAdapterDecorator(inner, {
        maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2,
      });
      try { await wrapped.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r5' }); } catch {}
      expect(inner.callCount).toBe(1);
    });
  });

  describe('[3] stacked — Retry(Logging(adapter)) 조합', () => {
    it('조합된 스택에서 최종 성공', async () => {
      const inner = new ControllableAdapter();
      inner.failUntil = 1;
      const stacked = new RetryAdapterDecorator(
        new LoggingAdapterDecorator(inner, { info: () => {}, error: () => {} }),
        { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2 },
      );
      const receipt = await stacked.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r6' });
      expect(receipt.status).toBe('success');
    });

    it('callCount === 2 (1회 실패 + 1회 성공)', async () => {
      const inner = new ControllableAdapter();
      inner.failUntil = 1;
      const stacked = new RetryAdapterDecorator(
        new LoggingAdapterDecorator(inner, { info: () => {}, error: () => {} }),
        { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2 },
      );
      await stacked.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r6' });
      expect(inner.callCount).toBe(2);
    });

    it('Logging이 두 번 실행됨 (INFO 최소 2건)', async () => {
      const logs: string[] = [];
      const logger = {
        info:  (msg: string) => { logs.push(`INFO:${msg}`); },
        error: (msg: string) => { logs.push(`ERROR:${msg}`); },
      };
      const inner = new ControllableAdapter();
      inner.failUntil = 1;
      const stacked = new RetryAdapterDecorator(
        new LoggingAdapterDecorator(inner, logger),
        { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2 },
      );
      await stacked.mintNFT({ contractAddr: '0x1', to: '0x2', tokenId: 1n, amount: 1n, requestId: 'r7' });
      expect(logs.filter(l => l.startsWith('INFO:')).length).toBeGreaterThanOrEqual(2);
    });

    it('stacked 는 IBlockchainAdapter 인터페이스를 만족한다', () => {
      const inner   = new ControllableAdapter();
      const stacked = new RetryAdapterDecorator(
        new LoggingAdapterDecorator(inner, { info: () => {}, error: () => {} }),
        { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2 },
      );
      expect(typeof stacked.mintNFT).toBe('function');
      expect(typeof stacked.isConnected).toBe('function');
    });
  });

  describe('[4] CircuitBreaker — 상태 전이', () => {
    it('CircuitBreaker 인스턴스가 생성된다', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });
      expect(cb).toBeDefined();
    });

    it('초기 상태: CLOSED', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });
      expect(cb.getState()).toBe('CLOSED');
    });

    it('성공 후: CLOSED 유지', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });
      await cb.execute(async () => 'ok');
      expect(cb.getState()).toBe('CLOSED');
    });

    it('failureThreshold 회 실패 후: OPEN', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });
      for (let i = 0; i < 3; i++) {
        try { await cb.execute(async () => { throw new Error('down'); }); } catch {}
      }
      expect(cb.getState()).toBe('OPEN');
    });

    it('getFailures() === failureThreshold 회 실패 수', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });
      for (let i = 0; i < 3; i++) {
        try { await cb.execute(async () => { throw new Error('down'); }); } catch {}
      }
      expect(cb.getFailures()).toBe(3);
    });

    it('OPEN 상태 → CircuitOpenError 즉시 throw', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100 });
      for (let i = 0; i < 3; i++) {
        try { await cb.execute(async () => { throw new Error('down'); }); } catch {}
      }
      await expect(cb.execute(async () => 'should not run')).rejects.toThrow(CircuitOpenError);
    });

    it('recoveryTime 경과 후 성공 → CLOSED 복귀', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 80 });
      for (let i = 0; i < 3; i++) {
        try { await cb.execute(async () => { throw new Error('down'); }); } catch {}
      }
      await new Promise(r => setTimeout(r, 100));
      const result = await cb.execute(async () => 'recovered');
      expect(cb.getState()).toBe('CLOSED');
      expect(result).toBe('recovered');
    }, 5000);

    it('복귀 후 getFailures() === 0', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 80 });
      for (let i = 0; i < 3; i++) {
        try { await cb.execute(async () => { throw new Error('down'); }); } catch {}
      }
      await new Promise(r => setTimeout(r, 100));
      await cb.execute(async () => 'ok');
      expect(cb.getFailures()).toBe(0);
    }, 5000);

    it('HALF_OPEN에서 실패 → OPEN 재진입', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 80 });
      for (let i = 0; i < 2; i++) {
        try { await cb.execute(async () => { throw new Error('down'); }); } catch {}
      }
      await new Promise(r => setTimeout(r, 100));
      try { await cb.execute(async () => { throw new Error('still down'); }); } catch {}
      expect(cb.getState()).toBe('OPEN');
    }, 5000);
  });
});
