/**
 * LoggingAdapterDecorator 단위 테스트
 *
 * 호출 시작·완료·에러 로깅, 소요 시간 기록, 에러 전파 검증
 */

import { LoggingAdapterDecorator, type Logger } from '../decorators/LoggingAdapterDecorator';
import type { IBlockchainAdapter, TransactionReceipt, MintParams, BurnParams, ChainEvent } from '../interfaces/IBlockchainAdapter';

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

const MOCK_RECEIPT: TransactionReceipt = {
  txHash:      '0xlog123',
  blockNumber: 200,
  blockHash:   '0xblockhash',
  status:      'success',
  gasUsed:     50000n,
  timestamp:   Date.now(),
};

function makeLogger(): Logger & { infoCalls: Array<{ msg: string; meta?: Record<string, unknown> }>; errorCalls: Array<{ msg: string; meta?: Record<string, unknown> }> } {
  const infoCalls:  Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const errorCalls: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  return {
    infoCalls,
    errorCalls,
    info(msg, meta)  { infoCalls.push({ msg, meta }); },
    error(msg, meta) { errorCalls.push({ msg, meta }); },
  };
}

function makeInner(mintImpl?: () => Promise<TransactionReceipt>): IBlockchainAdapter {
  return {
    chainId:   '31337',
    chainType: 'EVM',
    isConnected:     async () => true,
    getBlockNumber:  async () => 200,
    mintNFT:         mintImpl ?? (async () => MOCK_RECEIPT),
    mintNFTBatch:    async () => MOCK_RECEIPT,
    burnNFT:         async () => MOCK_RECEIPT,
    getBalance:      async () => 10n,
    call:            async () => null,
    sendTransaction: mintImpl ?? (async () => MOCK_RECEIPT),
    getReceipt:      async () => null,
    subscribeEvents: async () => () => {},
    queryEvents:     async () => [],
  };
}

const MINT_PARAMS: MintParams = {
  contractAddr: '0xcontract',
  to:           '0xrecipient',
  tokenId:      42n,
  amount:       1n,
  requestId:    'req-log-001',
};

const BURN_PARAMS: BurnParams = {
  contractAddr: '0xcontract',
  from:         '0xowner',
  tokenId:      42n,
  amount:       1n,
};

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('LoggingAdapterDecorator', () => {
  describe('mintNFT 로깅', () => {
    it('mintNFT 시작 시 info 로그 기록', async () => {
      const logger = makeLogger();
      const decorator = new LoggingAdapterDecorator(makeInner(), logger);

      await decorator.mintNFT(MINT_PARAMS);

      const startLog = logger.infoCalls.find(c => c.msg.includes('mintNFT') && c.msg.includes('start'));
      expect(startLog).toBeDefined();
    });

    it('mintNFT 성공 시 ok 로그 기록', async () => {
      const logger = makeLogger();
      const decorator = new LoggingAdapterDecorator(makeInner(), logger);

      await decorator.mintNFT(MINT_PARAMS);

      const okLog = logger.infoCalls.find(c => c.msg.includes('mintNFT') && c.msg.includes('ok'));
      expect(okLog).toBeDefined();
    });

    it('mintNFT ok 로그에 소요 시간(ms) 포함', async () => {
      const logger = makeLogger();
      const decorator = new LoggingAdapterDecorator(makeInner(), logger);

      await decorator.mintNFT(MINT_PARAMS);

      const okLog = logger.infoCalls.find(c => c.msg.includes('ok'));
      expect(okLog?.meta).toHaveProperty('ms');
      expect(typeof okLog?.meta!['ms']).toBe('number');
    });

    it('mintNFT 결과값을 그대로 반환', async () => {
      const logger = makeLogger();
      const decorator = new LoggingAdapterDecorator(makeInner(), logger);

      const result = await decorator.mintNFT(MINT_PARAMS);
      expect(result.txHash).toBe('0xlog123');
    });
  });

  describe('에러 로깅', () => {
    it('mintNFT 실패 시 error 로그 기록 후 에러 재전파', async () => {
      const logger = makeLogger();
      const inner = makeInner(async () => { throw new Error('contract error'); });
      const decorator = new LoggingAdapterDecorator(inner, logger);

      await expect(decorator.mintNFT(MINT_PARAMS)).rejects.toThrow('contract error');

      const errLog = logger.errorCalls.find(c => c.msg.includes('mintNFT') && c.msg.includes('error'));
      expect(errLog).toBeDefined();
    });

    it('에러 로그에 error 필드 포함', async () => {
      const logger = makeLogger();
      const inner = makeInner(async () => { throw new Error('revert reason'); });
      const decorator = new LoggingAdapterDecorator(inner, logger);

      await expect(decorator.mintNFT(MINT_PARAMS)).rejects.toThrow();

      const errLog = logger.errorCalls[0];
      expect(errLog?.meta?.['error']).toContain('revert reason');
    });

    it('에러 로그에도 소요 시간(ms) 포함', async () => {
      const logger = makeLogger();
      const inner = makeInner(async () => { throw new Error('fail'); });
      const decorator = new LoggingAdapterDecorator(inner, logger);

      await expect(decorator.mintNFT(MINT_PARAMS)).rejects.toThrow();
      expect(logger.errorCalls[0]?.meta).toHaveProperty('ms');
    });
  });

  describe('burnNFT 로깅', () => {
    it('burnNFT 시작·완료 로그 기록', async () => {
      const logger = makeLogger();
      const decorator = new LoggingAdapterDecorator(makeInner(), logger);

      await decorator.burnNFT(BURN_PARAMS);

      expect(logger.infoCalls.some(c => c.msg.includes('burnNFT') && c.msg.includes('start'))).toBe(true);
      expect(logger.infoCalls.some(c => c.msg.includes('burnNFT') && c.msg.includes('ok'))).toBe(true);
    });
  });

  describe('queryEvents 로깅', () => {
    it('queryEvents 시작·완료 로그 기록', async () => {
      const logger = makeLogger();
      const decorator = new LoggingAdapterDecorator(makeInner(), logger);

      await decorator.queryEvents('0xaddr', [], 'Transfer', 100, 200);

      expect(logger.infoCalls.some(c => c.msg.includes('queryEvents') && c.msg.includes('start'))).toBe(true);
      expect(logger.infoCalls.some(c => c.msg.includes('queryEvents') && c.msg.includes('ok'))).toBe(true);
    });
  });

  describe('위임 동작', () => {
    it('isConnected() 위임', async () => {
      const decorator = new LoggingAdapterDecorator(makeInner(), makeLogger());
      expect(await decorator.isConnected()).toBe(true);
    });

    it('getBlockNumber() 위임', async () => {
      const decorator = new LoggingAdapterDecorator(makeInner(), makeLogger());
      expect(await decorator.getBlockNumber()).toBe(200);
    });
  });
});
