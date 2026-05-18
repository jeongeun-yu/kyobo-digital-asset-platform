/**
 * S14 채점 — IBlockchainAdapter 설계 + 멀티체인 교체 시뮬레이션
 *
 * S14_multichain_adapter.ts 는 export가 없으므로 동일한 함수/클래스를 인라인으로
 * 재현하여 채점한다.
 *
 * 채점 기준:
 *   · issuanceHealth() — 반환값 { chain, type, connected } 구조 검증
 *   · formatGas()     — gasUsed 있으면 숫자 문자열, 없으면 'N/A'
 *   · getFeeModel()   — chainType 분기 결과 검증
 *   · IssuerService   — mintNFT 결과 반환 확인
 */

import type {
  IBlockchainAdapter,
  TransactionReceipt,
  MintParams,
  MintBatchParams,
  BurnParams,
  ContractCallParams,
  ChainEvent,
} from '@kyobo/chain-adapters';
import { ChainAdapterFactory, UnsupportedChainError } from '@kyobo/chain-adapters';

// ── Stub 어댑터 ───────────────────────────────────────────────────────────────
const STUB_RECEIPT: TransactionReceipt = {
  txHash: '0x5700b000000000000000000000000000000000000000000000000000005700b0', blockNumber: 0, blockHash: '0x5700b10b10c0000000000000000000000000000000000000000000000005700b0',
  status: 'success', timestamp: Date.now(),
};

class StubEVMAdapter implements IBlockchainAdapter {
  readonly chainId   = 'ethereum-sepolia';
  readonly chainType = 'EVM' as const;
  async isConnected()                                        { return true; }
  async getBlockNumber()                                     { return 1; }
  async mintNFT(_p: MintParams): Promise<TransactionReceipt>{ return { ...STUB_RECEIPT, txHash: '0xe0410000000000000000000000000000000000000000000000000000e0410000', gasUsed: 47704n }; }
  async mintNFTBatch(_p: MintBatchParams)                    { return STUB_RECEIPT; }
  async burnNFT(_p: BurnParams)                              { return STUB_RECEIPT; }
  async getBalance()                                         { return 0n; }
  async call(_p: ContractCallParams)                         { return null; }
  async sendTransaction(_p: ContractCallParams)              { return STUB_RECEIPT; }
  async getReceipt(_h: string)                               { return null; }
  async queryEvents(): Promise<ChainEvent[]>                 { return []; }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { return () => {}; }
}

class StubXRPLAdapter implements IBlockchainAdapter {
  readonly chainId   = 'xrpl-testnet';
  readonly chainType = 'XRPL' as const;
  async isConnected()                                        { return false; }
  async getBlockNumber()                                     { return 0; }
  async mintNFT(_p: MintParams): Promise<TransactionReceipt>{ return { ...STUB_RECEIPT, txHash: '0x04100000000000000000000000000000000000000000000000000000041000ab' }; }
  async mintNFTBatch(_p: MintBatchParams)                    { return STUB_RECEIPT; }
  async burnNFT(_p: BurnParams)                              { return STUB_RECEIPT; }
  async getBalance()                                         { return 0n; }
  async call(_p: ContractCallParams)                         { return null; }
  async sendTransaction(_p: ContractCallParams)              { return STUB_RECEIPT; }
  async getReceipt(_h: string)                               { return null; }
  async queryEvents(): Promise<ChainEvent[]>                 { return []; }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { return () => {}; }
}

class StubCircleAdapter implements IBlockchainAdapter {
  readonly chainId   = 'circle-arc-mainnet';
  readonly chainType = 'BFT' as const;
  async isConnected()                                        { return false; }
  async getBlockNumber()                                     { return 0; }
  async mintNFT(_p: MintParams): Promise<TransactionReceipt>{ return { ...STUB_RECEIPT, txHash: '0xc14c1e0000000000000000000000000000000000000000000000000000c14c1e' }; }
  async mintNFTBatch(_p: MintBatchParams)                    { return STUB_RECEIPT; }
  async burnNFT(_p: BurnParams)                              { return STUB_RECEIPT; }
  async getBalance()                                         { return 0n; }
  async call(_p: ContractCallParams)                         { return null; }
  async sendTransaction(_p: ContractCallParams)              { return STUB_RECEIPT; }
  async getReceipt(_h: string)                               { return null; }
  async queryEvents(): Promise<ChainEvent[]>                 { return []; }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { return () => {}; }
}

class StubUTXOAdapter implements IBlockchainAdapter {
  readonly chainId   = 'bitcoin-mainnet';
  readonly chainType = 'UTXO' as const;
  async isConnected()                                        { return false; }
  async getBlockNumber()                                     { return 0; }
  async mintNFT(_p: MintParams): Promise<TransactionReceipt>{ return { ...STUB_RECEIPT, txHash: '0x070000000000000000000000000000000000000000000000000000000000007a' }; }
  async mintNFTBatch(_p: MintBatchParams)                    { return STUB_RECEIPT; }
  async burnNFT(_p: BurnParams)                              { return STUB_RECEIPT; }
  async getBalance()                                         { return 0n; }
  async call(_p: ContractCallParams)                         { return null; }
  async sendTransaction(_p: ContractCallParams)              { return STUB_RECEIPT; }
  async getReceipt(_h: string)                               { return null; }
  async queryEvents(): Promise<ChainEvent[]>                 { return []; }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { return () => {}; }
}

// ── S14 학생 구현 재현 ─────────────────────────────────────────────────────────

async function issuanceHealth(adapter: IBlockchainAdapter) {
  const connected = await adapter.isConnected().catch(() => false);
  return { chain: adapter.chainId, type: adapter.chainType, connected };
}

function formatGas(receipt: TransactionReceipt): string {
  return receipt.gasUsed !== undefined ? receipt.gasUsed.toString() : 'N/A';
}

function getFeeModel(adapter: IBlockchainAdapter): string {
  switch (adapter.chainType) {
    case 'EVM':  return '가스(gas) 기반 — EIP-1559';
    case 'XRPL': return '고정 수수료 — XRP drops';
    case 'BFT':  return '수수료 없음 — Circle 자체 부담';
    case 'UTXO': return 'UTXO 차액 — 채굴자 수수료';
  }
}

class IssuerService {
  constructor(private adapter: IBlockchainAdapter) {}
  async issue(to: string, tokenId: bigint): Promise<TransactionReceipt> {
    return this.adapter.mintNFT({
      contractAddr: '0xD7B7586bd890C1A2791c2C18cbAEB7e0c30DB93F',
      to,
      tokenId,
      amount:    1n,
      requestId: `issue-${Date.now()}`,
    });
  }
}

// ── 채점 테스트 ───────────────────────────────────────────────────────────────
describe('S14 채점 — IBlockchainAdapter 설계', () => {
  describe('[1] issuanceHealth() — 반환값 구조 검증', () => {
    it('{ chain, type, connected } 구조를 반환한다', async () => {
      const adapter = new StubEVMAdapter();
      const result  = await issuanceHealth(adapter);
      expect(result).toHaveProperty('chain');
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('connected');
    });

    it('connected 는 boolean 타입이다', async () => {
      const adapter = new StubEVMAdapter();
      const result  = await issuanceHealth(adapter);
      expect(typeof result.connected).toBe('boolean');
    });

    it('chain 은 adapter.chainId 와 일치한다', async () => {
      const adapter = new StubEVMAdapter();
      const result  = await issuanceHealth(adapter);
      expect(result.chain).toBe(adapter.chainId);
    });

    it('type 은 adapter.chainType 과 일치한다', async () => {
      const adapter = new StubEVMAdapter();
      const result  = await issuanceHealth(adapter);
      expect(result.type).toBe(adapter.chainType);
    });

    it('isConnected() throw 시 connected: false (catch 처리)', async () => {
      class BrokenAdapter extends StubEVMAdapter {
        async isConnected(): Promise<boolean> { throw new Error('network error'); }
      }
      const result = await issuanceHealth(new BrokenAdapter());
      expect(result.connected).toBe(false);
    });
  });

  describe('[2] formatGas() — optional gasUsed 처리', () => {
    it('gasUsed 가 있으면 숫자 문자열을 반환한다', () => {
      const receipt: TransactionReceipt = { ...STUB_RECEIPT, gasUsed: 12345n };
      expect(formatGas(receipt)).toBe('12345');
    });

    it('gasUsed 가 없으면 "N/A"를 반환한다', () => {
      const receipt: TransactionReceipt = { txHash: '0xc14c1e0000000000000000000000000000000000000000000000000000c14c1e', blockNumber: 0, blockHash: '0xb10c0000000000000000000000000000000000000000000000000000b10c0000', status: 'success', timestamp: Date.now() };
      expect(formatGas(receipt)).toBe('N/A');
    });

    it('gasUsed = 0n 이면 "0"을 반환한다', () => {
      const receipt: TransactionReceipt = { ...STUB_RECEIPT, gasUsed: 0n };
      expect(formatGas(receipt)).toBe('0');
    });

    it('gasUsed = 47704n 이면 "47704"를 반환한다', () => {
      const receipt: TransactionReceipt = { ...STUB_RECEIPT, gasUsed: 47704n };
      expect(formatGas(receipt)).toBe('47704');
    });
  });

  describe('[3] getFeeModel() — chainType 분기', () => {
    it('EVM → 가스(gas) 기반 설명 반환', () => {
      const adapter = new StubEVMAdapter();
      expect(getFeeModel(adapter)).toContain('gas');
    });

    it('XRPL → XRP drops 설명 반환', () => {
      const adapter = new StubXRPLAdapter();
      expect(getFeeModel(adapter)).toContain('XRP');
    });

    it('BFT → Circle 관련 설명 반환', () => {
      const adapter = new StubCircleAdapter();
      expect(getFeeModel(adapter)).toContain('Circle');
    });

    it('UTXO → UTXO 관련 설명 반환', () => {
      const adapter = new StubUTXOAdapter();
      expect(getFeeModel(adapter)).toContain('UTXO');
    });

    it('각 chainType 별 반환값이 비어있지 않다', () => {
      const adapters: IBlockchainAdapter[] = [
        new StubEVMAdapter(), new StubXRPLAdapter(), new StubCircleAdapter(), new StubUTXOAdapter(),
      ];
      for (const adapter of adapters) {
        expect(getFeeModel(adapter).length).toBeGreaterThan(0);
      }
    });
  });

  describe('[4] IssuerService — mintNFT 결과 반환', () => {
    it('EVM 어댑터로 issue() 호출 → receipt 반환', async () => {
      const svc     = new IssuerService(new StubEVMAdapter());
      const receipt = await svc.issue('0xa11ce00000000000000000000000000000000001', 1n);
      expect(receipt).toBeDefined();
      expect(receipt.txHash).toBeTruthy();
    });

    it('Circle 어댑터로 issue() 호출 → receipt 반환 (어댑터 교체 검증)', async () => {
      const svc     = new IssuerService(new StubCircleAdapter());
      const receipt = await svc.issue('0xa11ce00000000000000000000000000000000001', 1n);
      expect(receipt).toBeDefined();
      expect(receipt.status).toBe('success');
    });

    it('IssuerService 코드 변경 없이 어댑터 교체 가능 (Strategy Pattern)', async () => {
      const adapters: IBlockchainAdapter[] = [
        new StubEVMAdapter(), new StubXRPLAdapter(), new StubCircleAdapter(), new StubUTXOAdapter(),
      ];
      for (const adapter of adapters) {
        const svc     = new IssuerService(adapter);
        const receipt = await svc.issue('0xde5700000000000000000000000000000000005e', 1n);
        expect(receipt.txHash).toBeTruthy();
      }
    });
  });

  describe('[5] ChainAdapterFactory — Factory Pattern', () => {
    it('EVM 어댑터 생성 → chainType === EVM', () => {
      const adapter = ChainAdapterFactory.create({
        chainType: 'EVM',
        rpcUrl:    'https://rpc.sepolia.org',
        chainId:   '11155111',
      });
      expect(adapter.chainType).toBe('EVM');
    });

    it('XRPL 어댑터 생성 → chainType === XRPL', () => {
      const adapter = ChainAdapterFactory.create({
        chainType: 'XRPL',
        rpcUrl:    '',
        chainId:   '',
      });
      expect(adapter.chainType).toBe('XRPL');
    });

    it('알 수 없는 chainType → UnsupportedChainError', () => {
      expect(() => {
        ChainAdapterFactory.create({ chainType: 'UNKNOWN' as any, rpcUrl: '', chainId: '' });
      }).toThrow(UnsupportedChainError);
    });

    it('Factory 생성 어댑터 → IBlockchainAdapter 인터페이스 만족', () => {
      const adapter = ChainAdapterFactory.create({
        chainType: 'EVM',
        rpcUrl:    'https://rpc.sepolia.org',
        chainId:   '11155111',
      } as Parameters<typeof ChainAdapterFactory.create>[0]);
      expect(typeof adapter.isConnected).toBe('function');
      expect(typeof adapter.mintNFT).toBe('function');
      expect(typeof adapter.queryEvents).toBe('function');
    });
  });
});
