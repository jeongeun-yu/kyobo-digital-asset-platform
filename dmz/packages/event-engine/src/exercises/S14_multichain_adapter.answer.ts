/**
 * S14 실습 — IBlockchainAdapter 설계 + 멀티체인 교체 시뮬레이션
 *
 * 실행: npx ts-node src/exercises/S14_multichain_adapter.ts
 *
 * [0] Sepolia 연결 확인       — 자동 실행 (구현 불필요)
 * [1] issuanceHealth 구현     — TODO 채우기
 * [2] formatGas 구현          — TODO 채우기
 * [3] withSubscription 구현   — TODO 채우기
 * [4] getFeeModel 구현        — TODO 채우기
 * [5] IssuerService 구현      — TODO 채우기
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
import { EVMAdapter, XRPLAdapter } from '@kyobo/chain-adapters';
import { evmConfig, xrplConfig, circleConfig, utxoConfig, contractConfig } from '@kyobo/shared';

// ── stub 어댑터 (참조 구현) ──────────────────────────────────────────────────

const STUB_RECEIPT: TransactionReceipt = {
  txHash: '0xstub', blockNumber: 0, blockHash: '0xstub-block',
  status: 'success', timestamp: Date.now(),
};

class CircleAdapter implements IBlockchainAdapter {
  readonly chainId = 'circle-arc-mainnet';
  readonly chainType = 'BFT' as const;
  constructor(_c: { apiKey: string }) {}
  async isConnected(): Promise<boolean>   { return false; }
  async getBlockNumber(): Promise<number> { return 0; }
  async mintNFT(_p: MintParams): Promise<TransactionReceipt>         { return { ...STUB_RECEIPT, txHash: `0xcircle-${Date.now().toString(16)}` }; }
  async mintNFTBatch(_p: MintBatchParams): Promise<TransactionReceipt> { return { ...STUB_RECEIPT }; }
  async burnNFT(_p: BurnParams): Promise<TransactionReceipt>         { return { ...STUB_RECEIPT }; }
  async getBalance(_a: string, _o: string, _t: bigint): Promise<bigint> { return 0n; }
  async call(_p: ContractCallParams): Promise<unknown>                { return null; }
  async sendTransaction(_p: ContractCallParams): Promise<TransactionReceipt> { return { ...STUB_RECEIPT }; }
  async getReceipt(_h: string): Promise<TransactionReceipt | null>   { return null; }
  async queryEvents(_a: string, _b: unknown[], _e: string, _f: number, _t: number): Promise<ChainEvent[]> { return []; }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { return () => {}; }
}

class UTXOAdapter implements IBlockchainAdapter {
  readonly chainId = 'bitcoin-mainnet';
  readonly chainType = 'UTXO' as const;
  constructor(_c: { rpcUrl: string }) {}
  async isConnected(): Promise<boolean>   { return false; }
  async getBlockNumber(): Promise<number> { return 0; }
  async mintNFT(_p: MintParams): Promise<TransactionReceipt>         { return { ...STUB_RECEIPT, txHash: `0xutxo-${Date.now().toString(16)}` }; }
  async mintNFTBatch(_p: MintBatchParams): Promise<TransactionReceipt> { return { ...STUB_RECEIPT }; }
  async burnNFT(_p: BurnParams): Promise<TransactionReceipt>         { return { ...STUB_RECEIPT }; }
  async getBalance(_a: string, _o: string, _t: bigint): Promise<bigint> { return 0n; }
  async call(_p: ContractCallParams): Promise<unknown>                { return null; }
  async sendTransaction(_p: ContractCallParams): Promise<TransactionReceipt> { return { ...STUB_RECEIPT }; }
  async getReceipt(_h: string): Promise<TransactionReceipt | null>   { return null; }
  async queryEvents(_a: string, _b: unknown[], _e: string, _f: number, _t: number): Promise<ChainEvent[]> { return []; }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { return () => {}; }
}

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

// ════════════════════════════════════════════════════════════════════════════
// [1] TODO: issuanceHealth 구현
//
// adapter의 isConnected()를 호출해 { chain, type, connected }를 반환하라.
// 이 함수는 어떤 어댑터를 받든 IBlockchainAdapter 인터페이스만 사용해야 한다.
// 힌트: stub 어댑터는 isConnected()가 throw할 수 있다 → .catch(() => false) 처리
// ════════════════════════════════════════════════════════════════════════════

async function issuanceHealth(adapter: IBlockchainAdapter): Promise<{
  chain: string; type: string; connected: boolean;
}> {
  const connected = await adapter.isConnected().catch(() => false);
  return { chain: adapter.chainId, type: adapter.chainType, connected };
}

// ════════════════════════════════════════════════════════════════════════════
// [2] TODO: formatGas 구현
//
// receipt.gasUsed가 있으면 숫자 문자열을, 없으면 'N/A'를 반환하라.
// EVM은 gasUsed가 있고, Circle/XRPL은 없다 — optional 필드 처리.
// ════════════════════════════════════════════════════════════════════════════

function formatGas(receipt: TransactionReceipt): string {
  return receipt.gasUsed !== undefined ? receipt.gasUsed.toString() : 'N/A';
}

// ════════════════════════════════════════════════════════════════════════════
// [3] TODO: withSubscription 구현
//
// adapter.subscribeEvents()를 호출하고, 반환된 unsubscribe 함수를 즉시 호출하라.
// 반환값: unsubscribe가 'function' 타입이었는지 여부 (boolean)
// ════════════════════════════════════════════════════════════════════════════

async function withSubscription(adapter: IBlockchainAdapter): Promise<boolean> {
  const unsubscribe = await adapter.subscribeEvents('0x0', [], ['Transfer'], 0, async () => {});
  const isFunc = typeof unsubscribe === 'function';
  unsubscribe();
  return isFunc;
}

// ════════════════════════════════════════════════════════════════════════════
// [4] TODO: getFeeModel 구현
//
// adapter.chainType을 switch로 분기해 각 체인의 수수료 모델 설명을 반환하라.
//   'EVM'  → '가스(gas) 기반 — EIP-1559'
//   'XRPL' → '고정 수수료 — XRP drops'
//   'BFT'  → '수수료 없음 — Circle 자체 부담'
//   'UTXO' → 'UTXO 차액 — 채굴자 수수료'
//
// 힌트: case를 하나 빠뜨리면 TypeScript가 컴파일 오류를 낸다.
// ════════════════════════════════════════════════════════════════════════════

function getFeeModel(adapter: IBlockchainAdapter): string {
  switch (adapter.chainType) {
    case 'EVM':  return '가스(gas) 기반 — EIP-1559';
    case 'XRPL': return '고정 수수료 — XRP drops';
    case 'BFT':  return '수수료 없음 — Circle 자체 부담';
    case 'UTXO': return 'UTXO 차액 — 채굴자 수수료';
  }
}

const CONTRACT = contractConfig.mockERC1155 || '0xD7B7586bd890C1A2791c2C18cbAEB7e0c30DB93F';

// ════════════════════════════════════════════════════════════════════════════
// [5] TODO: IssuerService 구현
//
// 1. constructor의 adapter 타입을 IBlockchainAdapter로 선언하라.
// 2. issue()에서 adapter.mintNFT()를 호출해 receipt를 반환하라.
//
// 완성 후 EVM / Circle 두 어댑터로 테스트한다.
// 두 어댑터 모두 같은 IssuerService 코드로 동작해야 한다.
// ════════════════════════════════════════════════════════════════════════════

class IssuerService {
  constructor(private adapter: IBlockchainAdapter) {}

  async issue(to: string, tokenId: bigint): Promise<TransactionReceipt> {
    return this.adapter.mintNFT({
      contractAddr: CONTRACT,
      to,
      tokenId,
      amount:    1n,
      requestId: `issue-${Date.now()}`,
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 실습 진입점
// ════════════════════════════════════════════════════════════════════════════

(async () => {
  console.log('=== S14: IBlockchainAdapter 설계 + 멀티체인 교체 시뮬레이션 ===\n');

  // ── [0] Sepolia 연결 확인 (구현 불필요) ──────────────────────────────────
  console.log('[0] Sepolia 연결 확인');
  const sepoliaAdapter = new EVMAdapter({
    rpcUrl:  evmConfig.rpcUrl,
    chainId: evmConfig.chainId,
    ...(evmConfig.signerKey && { privateKey: evmConfig.signerKey }),
  });
  const connected = await sepoliaAdapter.isConnected();
  check(`isConnected(): ${connected}`, connected);
  if (connected) {
    const block = await sepoliaAdapter.getBlockNumber();
    check(`getBlockNumber(): ${block} (> 0)`, block > 0);
  }

  // ── [1] issuanceHealth ────────────────────────────────────────────────────
  console.log('\n[1] issuanceHealth — 4개 어댑터 모두 동일한 함수로 처리');
  const adapters: IBlockchainAdapter[] = [
    new EVMAdapter({ rpcUrl: evmConfig.rpcUrl, chainId: evmConfig.chainId }),
    new XRPLAdapter({ wsUrl: xrplConfig.wsUrl }),
    new CircleAdapter({ apiKey: circleConfig.apiKey }),
    new UTXOAdapter({ rpcUrl: utxoConfig.rpcUrl }),
  ];
  for (const adapter of adapters) {
    await tryCheck(
      `[${adapter.chainType.padEnd(4)}] chain: ${adapter.chainId}`,
      async () => {
        const h = await issuanceHealth(adapter);
        return typeof h.connected === 'boolean' && h.chain === adapter.chainId && h.type === adapter.chainType;
      },
    );
  }

  // ── [2] formatGas ─────────────────────────────────────────────────────────
  console.log('\n[2] formatGas — gasUsed optional 처리');
  const evmReceipt: TransactionReceipt = {
    txHash: '0xevm', blockNumber: 1, blockHash: '0xblock',
    status: 'success', gasUsed: 47704n, timestamp: Date.now(),
  };
  const circleReceipt: TransactionReceipt = {
    txHash: '0xcircle', blockNumber: 0, blockHash: '0xblock',
    status: 'success', timestamp: Date.now(),
  };
  await tryCheck('EVM receipt   → gasUsed 숫자', async () => formatGas(evmReceipt) === '47704');
  await tryCheck('Circle receipt → gasUsed N/A', async () => formatGas(circleReceipt) === 'N/A');

  // ── [3] withSubscription ──────────────────────────────────────────────────
  console.log('\n[3] withSubscription — subscribeEvents + unsubscribe');
  const circle = new CircleAdapter({ apiKey: circleConfig.apiKey });
  await tryCheck('subscribeEvents → unsubscribe 함수 반환 후 즉시 해제',
    () => withSubscription(circle));

  // ── [4] getFeeModel ───────────────────────────────────────────────────────
  console.log('\n[4] getFeeModel — chainType 분기');
  const feeAdapters: IBlockchainAdapter[] = [
    new EVMAdapter({ rpcUrl: evmConfig.rpcUrl, chainId: evmConfig.chainId }),
    new XRPLAdapter({ wsUrl: xrplConfig.wsUrl }),
    new CircleAdapter({ apiKey: circleConfig.apiKey }),
    new UTXOAdapter({ rpcUrl: utxoConfig.rpcUrl }),
  ];
  for (const adapter of feeAdapters) {
    await tryCheck(`[${adapter.chainType.padEnd(4)}] getFeeModel → 비어있지 않음`,
      async () => getFeeModel(adapter).length > 0);
  }

  // ── [5] IssuerService ─────────────────────────────────────────────────────
  console.log('\n[5] IssuerService — 어댑터 교체 시 코드 변경 없음');
  const TO = '0x91ffcbB6f6dC947C01d402eA5703b9D27e8aA363';

  const evmService = new IssuerService(new EVMAdapter({
    rpcUrl: evmConfig.rpcUrl, chainId: evmConfig.chainId,
    ...(evmConfig.signerKey && { privateKey: evmConfig.signerKey }),
  }));
  await tryCheck('EVM   IssuerService.issue() → success + gasUsed 존재', async () => {
    const r = await evmService.issue(TO, 3n);
    return r.status === 'success' && r.gasUsed !== undefined;
  });

  const circleService = new IssuerService(new CircleAdapter({ apiKey: circleConfig.apiKey }));
  await tryCheck('Circle IssuerService.issue() → success + gasUsed 없음', async () => {
    const r = await circleService.issue(TO, 3n);
    return r.status === 'success' && r.gasUsed === undefined;
  });

  console.log('\n=== S14 실습 완료 ===');
  console.log(process.exitCode ? '❌ 미완성 — TODO를 채우세요' : '✅ 전체 통과');

  process.exit(process.exitCode ?? 0);
})();
