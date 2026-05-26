/**
 * S15 실습 — EVMAdapter 구현 분석 + XRPL Mock 교체 시뮬레이션
 *
 * 실행 방법 (루트에서):
 *   npm run exercise:s15      → 전체 실행
 *   npm run exercise:s15:1    → [1] isConnected()
 *   npm run exercise:s15:2    → [2] getBlockNumber()
 *   npm run exercise:s15:3    → [3] XRPLMockAdapter 교체 시뮬레이션
 *   npm run exercise:s15:4    → [4] read-only 모드
 *   npm run exercise:s15:5    → [5] mintNFT + getBalance (MOCK_CONTRACT_ADDR 필요)
 *   npm run exercise:s15:7    → [7] queryEvents (MOCK_CONTRACT_ADDR 필요)
 *
 * 전제 조건:
 *   인터넷 연결 (Sepolia 공개 RPC 사용)
 *   [5][7] 은 MOCK_CONTRACT_ADDR + EVM_SIGNER_KEY 환경변수 필요
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
import { EVMAdapter } from '@kyobo/chain-adapters';
import { evmConfig, contractConfig } from '@kyobo/shared';

const SEPOLIA_RPC_URL    = evmConfig.rpcUrl;
const SEPOLIA_CHAIN_ID   = evmConfig.chainId;
const MOCK_CONTRACT_ADDR = contractConfig.mockERC1155 || undefined;
const EVM_SIGNER_KEY     = evmConfig.signerKey;

// ── [3] 실습: XRPLMockAdapter — IBlockchainAdapter 직접 구현
//
// 모든 메서드가 IBlockchainAdapter 인터페이스를 만족해야 한다.
// TypeScript 컴파일 오류가 없으면 성공.
// ────────────────────────────────────────────────────────────────────────────

const MOCK_RECEIPT: TransactionReceipt = {
  txHash:      '0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  blockNumber: 99_999_999,
  blockHash:   '0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
  status:      'success',
  timestamp:   Date.now(),
};

class XRPLMockAdapter implements IBlockchainAdapter {
  readonly chainId   = 'xrpl-testnet';
  readonly chainType = 'XRPL' as const;

  async isConnected(): Promise<boolean>  { return true; }
  async getBlockNumber(): Promise<number> { return 99_999_999; }

  async mintNFT(_params: MintParams): Promise<TransactionReceipt> {
    return { ...MOCK_RECEIPT, txHash: '0xc0ffee00dead0000c0ffee00dead0000c0ffee00dead0000c0ffee00dead0000' };
  }
  async mintNFTBatch(_params: MintBatchParams): Promise<TransactionReceipt> {
    return { ...MOCK_RECEIPT, txHash: '0xdeadbeef00000000deadbeef00000000deadbeef00000000deadbeef00000000' };
  }
  async burnNFT(_params: BurnParams): Promise<TransactionReceipt> {
    return { ...MOCK_RECEIPT, txHash: '0xface000000000000face000000000000face000000000000face000000000000' };
  }
  async getBalance(_c: string, _o: string, _t: bigint): Promise<bigint>     { return 0n; }
  async call(_p: ContractCallParams): Promise<unknown>                       { return null; }
  async sendTransaction(_p: ContractCallParams): Promise<TransactionReceipt> {
    return { ...MOCK_RECEIPT, txHash: '0xbabe000000000000babe000000000000babe000000000000babe000000000000' };
  }
  async getReceipt(_txHash: string): Promise<TransactionReceipt | null>     { return null; }
  async queryEvents(_c: string, _a: unknown[], _e: string, _f: number, _t: number): Promise<ChainEvent[]> { return []; }
  async subscribeEvents(_c: string, _a: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> {
    return () => {};
  }
}

// ── 섹션 함수 ─────────────────────────────────────────────────────────────────

async function section1(): Promise<void> {
  console.log('[1] isConnected() — Sepolia 연결 확인');
  const evm = new EVMAdapter({ rpcUrl: SEPOLIA_RPC_URL, chainId: SEPOLIA_CHAIN_ID });
  const result = await evm.isConnected().catch(() => false);
  console.log('  isConnected:', result);
}

async function section2(): Promise<void> {
  console.log('[2] getBlockNumber() — 현재 Sepolia 블록');
  const evm = new EVMAdapter({ rpcUrl: SEPOLIA_RPC_URL, chainId: SEPOLIA_CHAIN_ID });
  const block = await evm.getBlockNumber();
  console.log('  blockNumber:', block);
}

async function section3(): Promise<void> {
  console.log('[3] XRPLMockAdapter — IBlockchainAdapter 교체 시뮬레이션');
  const adapters: IBlockchainAdapter[] = [
    new EVMAdapter({ rpcUrl: SEPOLIA_RPC_URL, chainId: SEPOLIA_CHAIN_ID }),
    new XRPLMockAdapter(),
  ];
  for (const adapter of adapters) {
    const connected = await adapter.isConnected().catch(() => false);
    const block     = await adapter.getBlockNumber().catch(() => 0);
    console.log(`  [${adapter.chainType}] isConnected: ${connected}  blockNumber: ${block}`);
  }
}

async function section4(): Promise<void> {
  console.log('[4] read-only 모드 — privateKey 없을 때 mintNFT');
  const evm = new EVMAdapter({ rpcUrl: SEPOLIA_RPC_URL, chainId: SEPOLIA_CHAIN_ID });
  try {
    await evm.mintNFT({
      contractAddr: '0x0000000000000000000000000000000000000000',
      to:           '0x0000000000000000000000000000000000000000',
      tokenId:      1n,
      amount:       1n,
      requestId:    'test-req',
    });
  } catch (err) {
    console.log('  에러:', (err as Error).message);
  }
}

async function section5(): Promise<void> {
  console.log('[5] mintNFT + getBalance — MockERC1155 on Sepolia');
  if (!MOCK_CONTRACT_ADDR || !EVM_SIGNER_KEY) {
    console.log('  스킵 — MOCK_CONTRACT_ADDR + EVM_SIGNER_KEY 필요');
    return;
  }
  const evm = new EVMAdapter({
    rpcUrl:     SEPOLIA_RPC_URL,
    chainId:    SEPOLIA_CHAIN_ID,
    privateKey: EVM_SIGNER_KEY,
  });
  const LAB_RECIPIENT = '0x0000000000000000000000000000000000000001';
  const receipt = await evm.mintNFT({
    contractAddr: MOCK_CONTRACT_ADDR,
    to:           LAB_RECIPIENT,
    tokenId:      1n,
    amount:       1n,
    requestId:    'lab-s15-001',
  });
  console.log('  receipt:', receipt);
  const bal = await evm.getBalance(MOCK_CONTRACT_ADDR, LAB_RECIPIENT, 1n);
  console.log('  balance:', bal);
}

async function section7(): Promise<void> {
  console.log('[7] queryEvents — TransferSingle 이벤트 조회');
  if (!MOCK_CONTRACT_ADDR) {
    console.log('  스킵 — MOCK_CONTRACT_ADDR 필요');
    return;
  }
  const evm = new EVMAdapter({ rpcUrl: SEPOLIA_RPC_URL, chainId: SEPOLIA_CHAIN_ID });
  const MOCK_ERC1155_ABI = [
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'function mint(address to, uint256 id, uint256 amount)',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
  ];
  const currentBlock = await evm.getBlockNumber();
  const events = await evm.queryEvents(
    MOCK_CONTRACT_ADDR, MOCK_ERC1155_ABI, 'TransferSingle',
    Math.max(0, currentBlock - 1000),
    currentBlock,
  );
  console.log('  events:', events);
}

// ── 진입점 ────────────────────────────────────────────────────────────────────

const SECTIONS: Record<string, () => Promise<void>> = {
  '1': section1,
  '2': section2,
  '3': section3,
  '4': section4,
  '5': section5,
  '7': section7,
};

(async () => {
  const arg = process.argv[2];

  if (arg && SECTIONS[arg]) {
    console.log(`=== S15: 섹션 [${arg}] ===\n`);
    await SECTIONS[arg]!();
  } else {
    console.log('=== S15: EVMAdapter 실습 (Sepolia 테스트넷) ===\n');
    for (const fn of Object.values(SECTIONS)) {
      try {
        await fn();
      } catch (err) {
        console.log(' ', (err as Error).message);
      }
      console.log();
    }
  }
})();
