/**
 * S15 채점 — XRPLMockAdapter (IBlockchainAdapter 구현)
 *
 * S15_evm_lab.ts 는 export가 없으므로 XRPLMockAdapter를 인라인으로 재현하여 채점한다.
 *
 * 채점 기준:
 *   · XRPLMockAdapter.isConnected() → true
 *   · XRPLMockAdapter.getBlockNumber() → 99_999_999
 *   · mintNFT() → txHash 있는 receipt 반환
 *   · IBlockchainAdapter 인터페이스 전체 메서드 구현 여부
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

// ── S15 학생 구현 재현 ─────────────────────────────────────────────────────────
const MOCK_RECEIPT: TransactionReceipt = {
  txHash:      '0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  blockNumber: 99_999_999,
  blockHash:   '0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff00',
  status:      'success',
  timestamp:   Date.now(),
};

class XRPLMockAdapter implements IBlockchainAdapter {
  readonly chainId   = 'xrpl-testnet';
  readonly chainType = 'XRPL' as const;

  async isConnected(): Promise<boolean>   { return true; }
  async getBlockNumber(): Promise<number> { return 99_999_999; }

  async mintNFT(_params: MintParams): Promise<TransactionReceipt> {
    const t = Date.now().toString(16);
    return { ...MOCK_RECEIPT, txHash: `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}` };
  }
  async mintNFTBatch(_params: MintBatchParams): Promise<TransactionReceipt> {
    const t = Date.now().toString(16);
    return { ...MOCK_RECEIPT, txHash: `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}` };
  }
  async burnNFT(_params: BurnParams): Promise<TransactionReceipt> {
    const t = Date.now().toString(16);
    return { ...MOCK_RECEIPT, txHash: `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}` };
  }
  async getBalance(_contractAddr: string, _owner: string, _tokenId: bigint): Promise<bigint> {
    return 0n;
  }
  async call(_params: ContractCallParams): Promise<unknown> { return null; }
  async sendTransaction(_params: ContractCallParams): Promise<TransactionReceipt> {
    const t = Date.now().toString(16);
    return { ...MOCK_RECEIPT, txHash: `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}` };
  }
  async getReceipt(_txHash: string): Promise<TransactionReceipt | null> { return null; }
  async queryEvents(): Promise<ChainEvent[]> { return []; }
  async subscribeEvents(
    _contractAddr: string, _abi: unknown[], _eventNames: string[],
    _fromBlock: number, _handler: (event: ChainEvent) => Promise<void>,
  ): Promise<() => void> { return () => {}; }
}

// ── 채점 테스트 ───────────────────────────────────────────────────────────────
describe('S15 채점 — XRPLMockAdapter', () => {
  let xrpl: IBlockchainAdapter;

  beforeEach(() => {
    xrpl = new XRPLMockAdapter();
  });

  describe('기본 속성', () => {
    it('chainId === "xrpl-testnet"', () => {
      expect(xrpl.chainId).toBe('xrpl-testnet');
    });

    it('chainType === "XRPL"', () => {
      expect(xrpl.chainType).toBe('XRPL');
    });
  });

  describe('isConnected()', () => {
    it('true를 반환한다 (실제 연결 없이 항상 true)', async () => {
      const result = await xrpl.isConnected();
      expect(result).toBe(true);
    });
  });

  describe('getBlockNumber()', () => {
    it('99_999_999를 반환한다 (XRPL 레저 인덱스 Mock)', async () => {
      const result = await xrpl.getBlockNumber();
      expect(result).toBe(99_999_999);
    });
  });

  describe('mintNFT()', () => {
    it('txHash 가 있는 receipt를 반환한다', async () => {
      const receipt = await xrpl.mintNFT({
        contractAddr: '0x0000000000000000000000000000000000000000',
        to:           '0xa11ce00000000000000000000000000000000001',
        tokenId:      1n,
        amount:       1n,
        requestId:    'req-s15-001',
      });
      expect(receipt).toBeDefined();
      expect(receipt.txHash).toBeTruthy();
      expect(typeof receipt.txHash).toBe('string');
    });

    it('status === "success"', async () => {
      const receipt = await xrpl.mintNFT({
        contractAddr: '0x0000000000000000000000000000000000000000', to: '0xb0b0000000000000000000000000000000000002', tokenId: 2n, amount: 1n, requestId: 'req-s15-002',
      });
      expect(receipt.status).toBe('success');
    });
  });

  describe('IBlockchainAdapter 인터페이스 전체 메서드 구현', () => {
    it('mintNFTBatch() 가 구현되어 있다', async () => {
      await expect(xrpl.mintNFTBatch({ contractAddr: '0x0000000000000000000000000000000000000000', to: [], tokenIds: [], amounts: [], requestId: 'r' })).resolves.toBeDefined();
    });

    it('burnNFT() 가 구현되어 있다', async () => {
      await expect(xrpl.burnNFT({ contractAddr: '0x0000000000000000000000000000000000000000', from: '0x0000000000000000000000000000000000000000', tokenId: 1n, amount: 1n })).resolves.toBeDefined();
    });

    it('getBalance() 가 bigint를 반환한다', async () => {
      const bal = await xrpl.getBalance('0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 1n);
      expect(typeof bal).toBe('bigint');
    });

    it('queryEvents() 가 배열을 반환한다', async () => {
      const events = await xrpl.queryEvents('0x0000000000000000000000000000000000000000', [], 'Transfer', 0, 1);
      expect(Array.isArray(events)).toBe(true);
    });

    it('subscribeEvents() 가 unsubscribe 함수를 반환한다', async () => {
      const unsub = await xrpl.subscribeEvents('0x0000000000000000000000000000000000000000', [], ['Transfer'], 0, async () => {});
      expect(typeof unsub).toBe('function');
      expect(() => unsub()).not.toThrow();
    });

    it('getReceipt() 가 null 또는 receipt를 반환한다', async () => {
      const result = await xrpl.getReceipt('0xba5e000000000000000000000000000000000000000000000000000000ba5e00');
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  describe('Strategy Pattern 검증 — IBlockchainAdapter로 다형성 사용', () => {
    it('IBlockchainAdapter 타입 변수에 할당 가능하다', () => {
      const adapter: IBlockchainAdapter = new XRPLMockAdapter();
      expect(adapter).toBeDefined();
    });

    it('EVMAdapter와 동일한 인터페이스로 교체 가능 (chainType만 다름)', () => {
      const adapter: IBlockchainAdapter = new XRPLMockAdapter();
      expect(adapter.chainType).toBe('XRPL');
      // EVM이 아닌 XRPL이지만 같은 인터페이스 사용
      expect(typeof adapter.mintNFT).toBe('function');
      expect(typeof adapter.isConnected).toBe('function');
    });
  });
});
