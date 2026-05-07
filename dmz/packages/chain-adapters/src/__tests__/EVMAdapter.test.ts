/**
 * EVMAdapter 단위 테스트
 *
 * read-only 모드(private key 없음), sendTransaction 방어, isConnected 검증
 * ethers v6 JsonRpcProvider / Wallet / Contract을 인라인 mock으로 처리
 */

// ethers 전체를 mock
jest.mock('ethers', () => {
  const MOCK_BLOCK_NUMBER = 18_500_000;

  return {
    JsonRpcProvider: jest.fn().mockImplementation(() => ({
      getBlockNumber: jest.fn().mockResolvedValue(MOCK_BLOCK_NUMBER),
      getTransactionReceipt: jest.fn().mockResolvedValue(null),
    })),
    Wallet: jest.fn().mockImplementation((_key: string, provider: unknown) => ({
      provider,
    })),
    Contract: jest.fn().mockImplementation((_addr: string, _iface: unknown, _signerOrProvider: unknown) => {
      // mintBatch, balanceOf, mint, burn 모두 기본 응답
      const mockTxResponse = {
        wait: jest.fn().mockResolvedValue({
          hash:        '0xmockhash',
          blockNumber: 18_500_001,
          blockHash:   '0xblockHash',
          status:      1,
          gasUsed:     21000n,
        }),
      };
      return new Proxy({}, {
        get: (_t, method) => {
          if (method === 'queryFilter') return jest.fn().mockResolvedValue([]);
          if (method === 'getEvent') return jest.fn().mockReturnValue('Transfer');
          if (method === 'on')  return jest.fn();
          if (method === 'off') return jest.fn();
          return jest.fn().mockResolvedValue(mockTxResponse);
        },
      });
    }),
    Interface: jest.fn().mockImplementation(() => ({})),
    EventLog: class {},
  };
});

import { EVMAdapter } from '../evm/EVMAdapter';
import type { MintParams, BurnParams, MintBatchParams } from '../interfaces/IBlockchainAdapter';

const CONFIG_READONLY  = { rpcUrl: 'http://localhost:8545', chainId: '31337' };
const CONFIG_WITH_KEY  = { rpcUrl: 'http://localhost:8545', chainId: '31337', privateKey: '0x' + 'a'.repeat(64) };

const MINT_PARAMS: MintParams = {
  contractAddr: '0xcontract',
  to:           '0xrecipient',
  tokenId:      1n,
  amount:       1n,
  requestId:    'req-evm-001',
};

const BURN_PARAMS: BurnParams = {
  contractAddr: '0xcontract',
  from:         '0xowner',
  tokenId:      1n,
  amount:       1n,
};

describe('EVMAdapter', () => {
  describe('생성자 / 메타 속성', () => {
    it('chainId가 config값과 일치', () => {
      const adapter = new EVMAdapter(CONFIG_READONLY);
      expect(adapter.chainId).toBe('31337');
    });

    it('chainType은 "EVM"', () => {
      const adapter = new EVMAdapter(CONFIG_READONLY);
      expect(adapter.chainType).toBe('EVM');
    });
  });

  describe('isConnected()', () => {
    it('provider.getBlockNumber() 성공 → true', async () => {
      const adapter = new EVMAdapter(CONFIG_READONLY);
      expect(await adapter.isConnected()).toBe(true);
    });

    it('provider.getBlockNumber() throw → false', async () => {
      const { JsonRpcProvider } = jest.requireMock('ethers');
      JsonRpcProvider.mockImplementationOnce(() => ({
        getBlockNumber: jest.fn().mockRejectedValue(new Error('connection refused')),
        getTransactionReceipt: jest.fn(),
      }));
      const adapter = new EVMAdapter(CONFIG_READONLY);
      expect(await adapter.isConnected()).toBe(false);
    });
  });

  describe('getBlockNumber()', () => {
    it('현재 블록 번호 반환', async () => {
      const adapter = new EVMAdapter(CONFIG_READONLY);
      const bn = await adapter.getBlockNumber();
      expect(bn).toBe(18_500_000);
    });
  });

  describe('read-only 모드 방어', () => {
    it('privateKey 없으면 sendTransaction throw', async () => {
      const adapter = new EVMAdapter(CONFIG_READONLY);
      await expect(
        adapter.sendTransaction({ contractAddr: '0xaddr', abi: [], method: 'mint', args: [] }),
      ).rejects.toThrow('read-only mode');
    });

    it('privateKey 없으면 mintNFT throw', async () => {
      const adapter = new EVMAdapter(CONFIG_READONLY);
      await expect(adapter.mintNFT(MINT_PARAMS)).rejects.toThrow();
    });

    it('privateKey 없으면 burnNFT throw', async () => {
      const adapter = new EVMAdapter(CONFIG_READONLY);
      await expect(adapter.burnNFT(BURN_PARAMS)).rejects.toThrow();
    });
  });

  describe('sendTransaction() — privateKey 있음', () => {
    it('tx.wait() 결과로 TransactionReceipt 반환', async () => {
      const adapter = new EVMAdapter(CONFIG_WITH_KEY);
      const result = await adapter.sendTransaction({
        contractAddr: '0xcontract',
        abi:          ['function mint(address, uint256, uint256)'],
        method:       'mint',
        args:         ['0xrecipient', 1n, 1n],
      });
      expect(result.txHash).toBe('0xmockhash');
      expect(result.blockNumber).toBe(18_500_001);
      expect(result.status).toBe('success');
    });

    it('receipt.status === 1 → status "success"', async () => {
      const adapter = new EVMAdapter(CONFIG_WITH_KEY);
      const result  = await adapter.mintNFT(MINT_PARAMS);
      expect(result.status).toBe('success');
    });
  });

  describe('getReceipt()', () => {
    it('receipt 없으면 null 반환', async () => {
      const adapter = new EVMAdapter(CONFIG_READONLY);
      expect(await adapter.getReceipt('0xunknown')).toBeNull();
    });
  });

  describe('queryEvents()', () => {
    it('이벤트 없으면 빈 배열 반환', async () => {
      const adapter = new EVMAdapter(CONFIG_READONLY);
      const events = await adapter.queryEvents('0xcontract', [], 'Transfer', 100, 200);
      expect(events).toEqual([]);
    });
  });
});
