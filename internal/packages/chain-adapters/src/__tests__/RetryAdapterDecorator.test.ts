/**
 * RetryAdapterDecorator 단위 테스트
 *
 * 지수 백오프 재시도 로직, 재시도 불가 오류, 최대 시도 초과 검증
 */

import { RetryAdapterDecorator } from '../decorators/RetryAdapterDecorator';
import type { IBlockchainAdapter, TransactionReceipt, MintParams, MintBatchParams } from '../interfaces/IBlockchainAdapter';

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

const MOCK_RECEIPT: TransactionReceipt = {
  txHash:      '0xabc123',
  blockNumber: 100,
  blockHash:   '0xblock',
  status:      'success',
  gasUsed:     21000n,
  timestamp:   Date.now(),
};

function makeAdapter(mintImpl: () => Promise<TransactionReceipt>): IBlockchainAdapter {
  return {
    chainId:   '31337',
    chainType: 'EVM',
    isConnected:     async () => true,
    getBlockNumber:  async () => 100,
    mintNFT:         mintImpl,
    mintNFTBatch:    mintImpl as any,
    burnNFT:         mintImpl as any,
    getBalance:      async () => 0n,
    call:            async () => null,
    sendTransaction: mintImpl as any,
    getReceipt:      async () => null,
    subscribeEvents: async () => () => {},
    queryEvents:     async () => [],
  };
}

const MINT_PARAMS: MintParams = {
  contractAddr: '0xcontract',
  to:           '0xrecipient',
  tokenId:      1n,
  amount:       1n,
  requestId:    'req-001',
};

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('RetryAdapterDecorator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('정상 동작', () => {
    it('첫 번째 시도 성공 시 즉시 결과 반환', async () => {
      const inner = makeAdapter(async () => MOCK_RECEIPT);
      const decorator = new RetryAdapterDecorator(inner, { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 100, backoffFactor: 2 });

      const result = await decorator.mintNFT(MINT_PARAMS);
      expect(result.txHash).toBe('0xabc123');
    });

    it('두 번째 시도 성공 시 결과 반환', async () => {
      let attempts = 0;
      const inner = makeAdapter(async () => {
        attempts++;
        if (attempts === 1) throw new Error('network timeout');
        return MOCK_RECEIPT;
      });
      const decorator = new RetryAdapterDecorator(inner, { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 100, backoffFactor: 2 });

      const promise = decorator.mintNFT(MINT_PARAMS);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.txHash).toBe('0xabc123');
      expect(attempts).toBe(2);
    });

    it('chainId / chainType을 inner에서 위임', () => {
      const inner = makeAdapter(async () => MOCK_RECEIPT);
      const decorator = new RetryAdapterDecorator(inner, { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 100, backoffFactor: 2 });
      expect(decorator.chainId).toBe('31337');
      expect(decorator.chainType).toBe('EVM');
    });
  });

  describe('최대 시도 초과', () => {
    it('maxAttempts 횟수 모두 실패 → 마지막 에러 throw', async () => {
      let attempts = 0;
      const inner = makeAdapter(async () => {
        attempts++;
        throw new Error('RPC unavailable');
      });
      const decorator = new RetryAdapterDecorator(inner, { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 100, backoffFactor: 2 });

      const promise = decorator.mintNFT(MINT_PARAMS);
      // rejects 핸들러 먼저 등록 → 타이머 진행 중 unhandled rejection 방지
      const assertion = expect(promise).rejects.toThrow('RPC unavailable');
      await jest.advanceTimersByTimeAsync(500);
      await assertion;
      expect(attempts).toBe(3);
    });

    it('maxAttempts: 1이면 재시도 없이 즉시 throw', async () => {
      let attempts = 0;
      const inner = makeAdapter(async () => {
        attempts++;
        throw new Error('instant fail');
      });
      const decorator = new RetryAdapterDecorator(inner, { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 100, backoffFactor: 2 });

      await expect(decorator.mintNFT(MINT_PARAMS)).rejects.toThrow('instant fail');
      expect(attempts).toBe(1);
    });
  });

  describe('재시도 불가 오류', () => {
    it('"execution reverted" → 재시도 없이 즉시 throw', async () => {
      let attempts = 0;
      const inner = makeAdapter(async () => {
        attempts++;
        throw new Error('execution reverted: insufficient balance');
      });
      const decorator = new RetryAdapterDecorator(inner, { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 100, backoffFactor: 2 });

      await expect(decorator.mintNFT(MINT_PARAMS)).rejects.toThrow('execution reverted');
      expect(attempts).toBe(1);
    });

    it('"insufficient funds" → 재시도 없이 즉시 throw', async () => {
      let attempts = 0;
      const inner = makeAdapter(async () => {
        attempts++;
        throw new Error('insufficient funds for gas');
      });
      const decorator = new RetryAdapterDecorator(inner, { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 100, backoffFactor: 2 });

      await expect(decorator.mintNFT(MINT_PARAMS)).rejects.toThrow('insufficient funds');
      expect(attempts).toBe(1);
    });

    it('"nonce too high" → 재시도 없이 즉시 throw', async () => {
      let attempts = 0;
      const inner = makeAdapter(async () => {
        attempts++;
        throw new Error('nonce too high');
      });
      const decorator = new RetryAdapterDecorator(inner, { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 100, backoffFactor: 2 });

      await expect(decorator.mintNFT(MINT_PARAMS)).rejects.toThrow('nonce too high');
      expect(attempts).toBe(1);
    });
  });

  describe('sendTransaction 재시도', () => {
    it('sendTransaction도 재시도 로직 적용', async () => {
      let attempts = 0;
      const inner = makeAdapter(async () => {
        attempts++;
        if (attempts < 3) throw new Error('network error');
        return MOCK_RECEIPT;
      });
      const decorator = new RetryAdapterDecorator(inner, { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 100, backoffFactor: 2 });

      const promise = decorator.sendTransaction({
        contractAddr: '0xcontract',
        abi:          [],
        method:       'mint',
        args:         [],
      });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe('success');
      expect(attempts).toBe(3);
    });
  });
});
