/**
 * S14 실습 — IBlockchainAdapter 설계 + 멀티체인 교체 시뮬레이션
 *
 * 실행 방법 (루트에서):
 *   npm run exercise:s14      → 전체 실행
 *   npm run exercise:s14:0    → [0] Sepolia 연결 확인
 *   npm run exercise:s14:1    → [1] issuanceHealth
 *   npm run exercise:s14:2    → [2] formatGas
 *   npm run exercise:s14:3    → [3] withSubscription
 *   npm run exercise:s14:4    → [4] getFeeModel
 *   npm run exercise:s14:5    → [5] IssuerService
 *   npm run exercise:s14:6    → [6] ChainAdapterFactory
 *   npm run exercise:s14:7    → [7] ChainAdapterRegistry — 멀티체인 동시 운영
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
import { EVMAdapter, XRPLAdapter, ChainAdapterFactory, UnsupportedChainError } from '@kyobo/chain-adapters';
import { evmConfig, xrplConfig, circleConfig, utxoConfig, contractConfig } from '@kyobo/shared';

// ── stub 어댑터 ───────────────────────────────────────────────────────────────

const STUB_RECEIPT: TransactionReceipt = {
  txHash: '0xaaaa0000bbbb1111cccc2222dddd3333aaaa0000bbbb1111cccc2222dddd3333',
  blockNumber: 0, blockHash: '0xbbbb1111cccc2222dddd3333aaaa0000bbbb1111cccc2222dddd3333aaaa0000',
  status: 'success', timestamp: Date.now(),
};

class CircleAdapter implements IBlockchainAdapter {
  readonly chainId = 'circle-arc-mainnet';
  readonly chainType = 'BFT' as const;
  constructor(_c: { apiKey: string }) {}
  async isConnected(): Promise<boolean>                                    { return false; }
  async getBlockNumber(): Promise<number>                                  { return 0; }
  async mintNFT(_p: MintParams): Promise<TransactionReceipt>              { const t = Date.now().toString(16); return { ...STUB_RECEIPT, txHash: `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}` }; }
  async mintNFTBatch(_p: MintBatchParams): Promise<TransactionReceipt>    { return { ...STUB_RECEIPT }; }
  async burnNFT(_p: BurnParams): Promise<TransactionReceipt>              { return { ...STUB_RECEIPT }; }
  async getBalance(_a: string, _o: string, _t: bigint): Promise<bigint>   { return 0n; }
  async call(_p: ContractCallParams): Promise<unknown>                     { return null; }
  async sendTransaction(_p: ContractCallParams): Promise<TransactionReceipt> { return { ...STUB_RECEIPT }; }
  async getReceipt(_h: string): Promise<TransactionReceipt | null>        { return null; }
  async queryEvents(_a: string, _b: unknown[], _e: string, _f: number, _t: number): Promise<ChainEvent[]> { return []; }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { return () => {}; }
}

class UTXOAdapter implements IBlockchainAdapter {
  readonly chainId = 'bitcoin-mainnet';
  readonly chainType = 'UTXO' as const;
  constructor(_c: { rpcUrl: string }) {}
  async isConnected(): Promise<boolean>                                    { return false; }
  async getBlockNumber(): Promise<number>                                  { return 0; }
  async mintNFT(_p: MintParams): Promise<TransactionReceipt>              { const t = Date.now().toString(16); return { ...STUB_RECEIPT, txHash: `0x${t.repeat(Math.ceil(64 / t.length)).slice(0, 64)}` }; }
  async mintNFTBatch(_p: MintBatchParams): Promise<TransactionReceipt>    { return { ...STUB_RECEIPT }; }
  async burnNFT(_p: BurnParams): Promise<TransactionReceipt>              { return { ...STUB_RECEIPT }; }
  async getBalance(_a: string, _o: string, _t: bigint): Promise<bigint>   { return 0n; }
  async call(_p: ContractCallParams): Promise<unknown>                     { return null; }
  async sendTransaction(_p: ContractCallParams): Promise<TransactionReceipt> { return { ...STUB_RECEIPT }; }
  async getReceipt(_h: string): Promise<TransactionReceipt | null>        { return null; }
  async queryEvents(_a: string, _b: unknown[], _e: string, _f: number, _t: number): Promise<ChainEvent[]> { return []; }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { return () => {}; }
}

// ── 유틸 함수 ─────────────────────────────────────────────────────────────────

async function issuanceHealth(adapter: IBlockchainAdapter): Promise<{
  chain: string; type: string; connected: boolean;
}> {
  const connected = await adapter.isConnected().catch(() => false);
  return { chain: adapter.chainId, type: adapter.chainType, connected };
}

function formatGas(receipt: TransactionReceipt): string {
  return receipt.gasUsed !== undefined ? receipt.gasUsed.toString() : 'N/A';
}

async function withSubscription(adapter: IBlockchainAdapter): Promise<boolean> {
  const unsubscribe = await adapter.subscribeEvents('', [], [], 0, async () => {});
  const isFunction = typeof unsubscribe === 'function';
  unsubscribe();
  return isFunction;
}

function getFeeModel(adapter: IBlockchainAdapter): string {
  switch (adapter.chainType) {
    case 'EVM':  return '가스(gas) 기반 — EIP-1559';
    case 'XRPL': return '고정 수수료 — XRP drops';
    case 'BFT':  return '수수료 없음 — Circle 자체 부담';
    case 'UTXO': return 'UTXO 차액 — 채굴자 수수료';
  }
}

const CONTRACT = contractConfig.mockERC1155 || '0xD7B7586bd890C1A2791c2C18cbAEB7e0c30DB93F';

class IssuerService {
  constructor(private adapter: IBlockchainAdapter) {}

  async issue(to: string, tokenId: bigint): Promise<TransactionReceipt> {
    return this.adapter.mintNFT({ contractAddr: CONTRACT, to, tokenId, amount: 1n, requestId: `issue-${Date.now()}` });
  }
}

// ── 섹션 함수 ─────────────────────────────────────────────────────────────────

async function section0(): Promise<void> {
  console.log('[0] Sepolia 연결 확인');
  const adapter = new EVMAdapter({
    rpcUrl:  evmConfig.rpcUrl,
    chainId: evmConfig.chainId,
    ...(evmConfig.signerKey && { privateKey: evmConfig.signerKey }),
  });
  const connected = await adapter.isConnected();
  console.log('  isConnected:', connected);
  if (connected) {
    const block = await adapter.getBlockNumber();
    console.log('  blockNumber:', block);
  }
}

async function section1(): Promise<void> {
  console.log('[1] issuanceHealth — 4개 어댑터');
  const adapters: IBlockchainAdapter[] = [
    new EVMAdapter({ rpcUrl: evmConfig.rpcUrl, chainId: evmConfig.chainId }),
    new XRPLAdapter({ wsUrl: xrplConfig.wsUrl }),
    new CircleAdapter({ apiKey: circleConfig.apiKey }),
    new UTXOAdapter({ rpcUrl: utxoConfig.rpcUrl }),
  ];
  for (const adapter of adapters) {
    const result = await issuanceHealth(adapter);
    console.log(`  [${adapter.chainType}]`, result);
  }
}

async function section2(): Promise<void> {
  console.log('[2] formatGas — gasUsed optional 처리');
  const evmReceipt: TransactionReceipt = {
    txHash: '0xeee0000000000000000000000000000000000000000000000000000000000eee',
    blockNumber: 1, blockHash: '0xb10c0000000000000000000000000000000000000000000000000000000b10c0',
    status: 'success', gasUsed: 47704n, timestamp: Date.now(),
  };
  const circleReceipt: TransactionReceipt = {
    txHash: '0xc1c1e000000000000000000000000000000000000000000000000000000c1c1e',
    blockNumber: 0, blockHash: '0xb10c0000000000000000000000000000000000000000000000000000000b10c0',
    status: 'success', timestamp: Date.now(),
  };
  console.log('  EVM    gasUsed:', formatGas(evmReceipt));
  console.log('  Circle gasUsed:', formatGas(circleReceipt));
}

async function section3(): Promise<void> {
  console.log('[3] withSubscription — subscribeEvents + unsubscribe');
  const circle = new CircleAdapter({ apiKey: circleConfig.apiKey });
  const result = await withSubscription(circle);
  console.log('  unsubscribe 함수 반환:', result);
}

async function section4(): Promise<void> {
  console.log('[4] getFeeModel — chainType 분기');
  const adapters: IBlockchainAdapter[] = [
    new EVMAdapter({ rpcUrl: evmConfig.rpcUrl, chainId: evmConfig.chainId }),
    new XRPLAdapter({ wsUrl: xrplConfig.wsUrl }),
    new CircleAdapter({ apiKey: circleConfig.apiKey }),
    new UTXOAdapter({ rpcUrl: utxoConfig.rpcUrl }),
  ];
  for (const adapter of adapters) {
    console.log(`  [${adapter.chainType}]`, getFeeModel(adapter));
  }
}

async function section5(): Promise<void> {
  console.log('[5] IssuerService — 어댑터 교체 시 코드 변경 없음');
  const TO = '0x91ffcbB6f6dC947C01d402eA5703b9D27e8aA363';

  const evmService = new IssuerService(new EVMAdapter({
    rpcUrl: evmConfig.rpcUrl, chainId: evmConfig.chainId,
    ...(evmConfig.signerKey && { privateKey: evmConfig.signerKey }),
  }));
  const evmReceipt = await evmService.issue(TO, 3n);
  console.log('  EVM   :', evmReceipt);

  const circleService = new IssuerService(new CircleAdapter({ apiKey: circleConfig.apiKey }));
  const circleReceipt = await circleService.issue(TO, 3n);
  console.log('  Circle:', circleReceipt);
}

async function section6(): Promise<void> {
  console.log('[6] ChainAdapterFactory');

  const evm = ChainAdapterFactory.create({ chainType: 'EVM', rpcUrl: evmConfig.rpcUrl, chainId: evmConfig.chainId });
  console.log('  EVM  :', evm.chainType, evm.chainId);

  const xrpl = ChainAdapterFactory.create({ chainType: 'XRPL', rpcUrl: 'wss://s.altnet.rippletest.net:51233', chainId: 'xrpl-testnet' });
  console.log('  XRPL :', xrpl.chainType, xrpl.chainId);

  try {
    ChainAdapterFactory.create({ chainType: 'UNKNOWN' as any, rpcUrl: '', chainId: '' });
  } catch (err) {
    console.log('  UNKNOWN →', (err as Error).constructor.name, (err as Error).message);
  }
}

// ── ChainAdapterRegistry (섹션 9-1 — 멀티체인 동시 운영) ────────────────────────

class ChainAdapterRegistry {
  private readonly adapters = new Map<string, IBlockchainAdapter>();

  register(adapter: IBlockchainAdapter): void {
    this.adapters.set(adapter.chainId, adapter);
  }

  get(chainId: string): IBlockchainAdapter {
    const adapter = this.adapters.get(chainId);
    if (!adapter) throw new UnsupportedChainError(chainId);
    return adapter;
  }

  getAll(): IBlockchainAdapter[] {
    return [...this.adapters.values()];
  }
}

async function section7(): Promise<void> {
  console.log('[7] ChainAdapterRegistry — 멀티체인 동시 운영');

  // 여러 어댑터를 레지스트리에 등록 — 교체가 아닌 추가
  const registry = new ChainAdapterRegistry();
  registry.register(new EVMAdapter({ rpcUrl: evmConfig.rpcUrl, chainId: evmConfig.chainId }));
  registry.register(new XRPLAdapter({ wsUrl: xrplConfig.wsUrl }));
  registry.register(new CircleAdapter({ apiKey: circleConfig.apiKey }));
  registry.register(new UTXOAdapter({ rpcUrl: utxoConfig.rpcUrl }));

  // 모든 체인에 동일한 비즈니스 로직(issuanceHealth) 적용 — IssuerService 역할
  console.log('  [registry.getAll()] 등록된 모든 어댑터 동시 조회:');
  const results = await Promise.all(
    registry.getAll().map(adapter => issuanceHealth(adapter)),
  );
  for (const r of results) {
    console.log(`    [${r.type}] chainId=${r.chain}  connected=${r.connected}`);
  }

  // chainId 기반 라우팅 — 정책 DB의 chain_id로 어댑터 선택
  console.log('\n  [registry.get(chainId)] 정책 기반 라우팅:');
  const evmAdapter = registry.get(evmConfig.chainId);
  console.log(`    chain_id='${evmConfig.chainId}' → ${evmAdapter.chainType} 어댑터 선택`);

  // 미등록 chainId → UnsupportedChainError
  console.log('\n  [미등록 chainId] 오류 처리:');
  try {
    registry.get('cosmos-mainnet');
  } catch (err) {
    console.log(`    'cosmos-mainnet' → ${(err as Error).constructor.name}: ${(err as Error).message}`);
  }

  // ChainEventListener 동시 구동 시뮬레이션 — 각 체인마다 독립 구독
  console.log('\n  [ChainEventListener × N] 체인 수만큼 독립 구독:');
  const unsubscribes = await Promise.all(
    registry.getAll().map(async adapter => {
      try {
        const unsub = await withSubscription(adapter);
        console.log(`    [${adapter.chainType}] subscribeEvents 등록 완료, unsubscribe 함수: ${unsub}`);
        return unsub;
      } catch (err) {
        // 스텁 어댑터(XRPL 등)는 실제 RPC 없어 오류 발생 — 실환경에서는 정상
        console.log(`    [${adapter.chainType}] subscribeEvents 스텁 오류 (실환경 무관): ${(err as Error).message.slice(0, 60)}`);
        return false;
      }
    }),
  );
  const ok = unsubscribes.filter(Boolean).length;
  console.log(`  → ${ok}/${unsubscribes.length}개 체인 구독 완료 (GracefulShutdown 시 모두 해제)`);
}

// ── 진입점 ────────────────────────────────────────────────────────────────────

const SECTIONS: Record<string, () => Promise<void>> = {
  '0': section0,
  '1': section1,
  '2': section2,
  '3': section3,
  '4': section4,
  '5': section5,
  '6': section6,
  '7': section7,
};

(async () => {
  const arg = process.argv[2];

  if (arg && SECTIONS[arg]) {
    console.log(`=== S14: 섹션 [${arg}] ===\n`);
    await SECTIONS[arg]!();
  } else {
    console.log('=== S14: IBlockchainAdapter 설계 + 멀티체인 교체 시뮬레이션 ===\n');
    for (const fn of Object.values(SECTIONS)) {
      try {
        await fn();
      } catch (err) {
        console.log(' ', (err as Error).message);
      }
      console.log();
    }
  }

  process.exit(process.exitCode ?? 0);
})();
