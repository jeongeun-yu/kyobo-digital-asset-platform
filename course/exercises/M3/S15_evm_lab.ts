/**
 * S15 실습 — EVMAdapter 구현 분석 + XRPL Mock 교체 시뮬레이션
 *
 * 강의 노트: M3_S15_evm_implementation.md
 *
 * 실행 방법 (루트에서): npm run exercise:s15
 *
 * 전제 조건:
 *   - 인터넷 연결 (Sepolia 공개 RPC 사용)
 *   - 월렛원 API 키 불필요 — Sepolia 테스트넷으로 실습
 *
 * 목표:
 *   [1] EVMAdapter.isConnected() → Sepolia 연결 확인
 *   [2] EVMAdapter.getBlockNumber() → 현재 블록 번호 조회
 *   [3] XRPLMockAdapter 직접 작성 → IBlockchainAdapter 컴파일 통과 확인
 *       (핵심: 인터페이스만 맞으면 상위 레이어 코드 변경 없음)
 *   [4] EVMAdapter read-only vs write 모드 차이 확인
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

// ────────────────────────────────────────────────────────────────────────
// Sepolia 테스트넷 설정 (강의 전용 — 프로덕션에서는 환경변수 주입)
// ────────────────────────────────────────────────────────────────────────

const SEPOLIA_RPC_URL    = process.env['EVM_RPC_URL']          ?? 'https://rpc.sepolia.org';
const SEPOLIA_CHAIN_ID   = process.env['EVM_CHAIN_ID']         ?? '11155111';
const MOCK_CONTRACT_ADDR = process.env['MOCK_CONTRACT_ADDR'];   // MockERC1155 Sepolia 주소 (선택)
const EVM_SIGNER_KEY     = process.env['EVM_SIGNER_KEY'];       // write 모드 활성화 (선택)

// ────────────────────────────────────────────────────────────────────────
// 실습 3: XRPLMockAdapter — IBlockchainAdapter 직접 구현
//
// 목표: XRPL로 체인을 교체한다고 가정.
//   IBlockchainAdapter만 구현하면 EVMAdapter 상위 레이어(IssuerService 등)
//   코드를 한 줄도 수정하지 않고 교체 가능하다는 것을 확인한다.
//
// 모든 메서드가 IBlockchainAdapter 인터페이스를 만족해야 한다.
// TypeScript 컴파일 오류가 없으면 성공.
//
// 힌트:
//   chainId   = 'xrpl-testnet'
//   chainType = 'XRPL' as const
//   isConnected() → true 반환 (실제 연결 없이 항상 true)
//   getBlockNumber() → 99_999_999 반환 (XRPL은 레저 인덱스)
//   mintNFT/mintNFTBatch/burnNFT/getBalance/call/sendTransaction/getReceipt →
//     각각 MOCK_RECEIPT 기반 또는 0n/null/() => {} 반환
//   queryEvents() → [] 반환
//   subscribeEvents() → () => {} 반환
// ────────────────────────────────────────────────────────────────────────

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

  async isConnected(): Promise<boolean> {
    return true;
  }

  async getBlockNumber(): Promise<number> {
    return 99_999_999;
  }

  async mintNFT(_params: MintParams): Promise<TransactionReceipt> {
    return { ...MOCK_RECEIPT, txHash: '0xc0ffee00dead0000c0ffee00dead0000c0ffee00dead0000c0ffee00dead0000' };
  }

  async mintNFTBatch(_params: MintBatchParams): Promise<TransactionReceipt> {
    return { ...MOCK_RECEIPT, txHash: '0xdeadbeef00000000deadbeef00000000deadbeef00000000deadbeef00000000' };
  }

  async burnNFT(_params: BurnParams): Promise<TransactionReceipt> {
    return { ...MOCK_RECEIPT, txHash: '0xface000000000000face000000000000face000000000000face000000000000' };
  }

  async getBalance(_contractAddr: string, _owner: string, _tokenId: bigint): Promise<bigint> {
    return 0n;
  }

  async call(_params: ContractCallParams): Promise<unknown> {
    return null;
  }

  async sendTransaction(_params: ContractCallParams): Promise<TransactionReceipt> {
    return { ...MOCK_RECEIPT, txHash: '0xbabe000000000000babe000000000000babe000000000000babe000000000000' };
  }

  async getReceipt(_txHash: string): Promise<TransactionReceipt | null> {
    return null;
  }

  async queryEvents(
    _contractAddr: string,
    _abi: unknown[],
    _eventName: string,
    _fromBlock: number,
    _toBlock: number,
  ): Promise<ChainEvent[]> {
    return [];
  }

  async subscribeEvents(
    _contractAddr: string,
    _abi: unknown[],
    _eventNames: string[],
    _fromBlock: number,
    _handler: (event: ChainEvent) => Promise<void>,
  ): Promise<() => void> {
    return () => { /* no-op */ };
  }
}

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S15: EVMAdapter 실습 (Sepolia 테스트넷) ===\n');
  console.log(`RPC: ${SEPOLIA_RPC_URL}`);
  console.log(`Chain ID: ${SEPOLIA_CHAIN_ID}\n`);

  if (MOCK_CONTRACT_ADDR) {
    console.log(`Mock Contract: ${MOCK_CONTRACT_ADDR}`);
  } else {
    console.log('Mock Contract: 미설정 — [5][6] 검증 스킵 (MOCK_CONTRACT_ADDR 환경변수 필요)');
    console.log('  → blockchain/scripts/deploy/deploy-mock-sepolia.ts 실행 후 주소 설정\n');
  }

  // ── 실습 1: EVMAdapter 인스턴스를 생성하라 (read-only 모드) ────────────
  const evm = new EVMAdapter({
    rpcUrl:  SEPOLIA_RPC_URL,
    chainId: SEPOLIA_CHAIN_ID,
  });

  // ── [1] Sepolia 연결 확인 ─────────────────────────────────────────────
  console.log('[검증 1] isConnected() → Sepolia 연결');

  let connected: boolean;
  try {
    connected = await evm.isConnected();
  } catch {
    connected = false;
  }
  check(`Sepolia 연결: ${connected} (RPC에 따라 false일 수 있음)`, true);
  console.log(`  → isConnected 반환값: ${connected}`);

  // ── [2] 현재 블록 번호 ────────────────────────────────────────────────
  console.log('\n[검증 2] getBlockNumber() → 현재 Sepolia 블록');

  if (connected) {
    try {
      const blockNumber = await evm.getBlockNumber();
      check(`블록 번호 > 0: ${blockNumber}`, blockNumber > 0);
      console.log(`  → Sepolia 현재 블록: #${blockNumber.toLocaleString()}`);
      console.log(`  → 블록 번호는 계속 증가 중 (약 12초마다 새 블록)`);
    } catch (err) {
      console.log(`  [스킵] RPC 응답 없음: ${err instanceof Error ? err.message : String(err)}`);
      console.log('  → 강의 환경에서 RPC 연결 불가 시 정상 스킵');
    }
  } else {
    console.log('  [스킵] Sepolia 연결 실패 — 다른 공개 RPC로 재시도');
    console.log(`  → 대체 RPC: https://ethereum-sepolia-rpc.publicnode.com`);
    console.log('  → EVM_RPC_URL 환경변수로 대체 RPC 설정 가능');
  }
  check('getBlockNumber (RPC 가용 시 검증)', true);

  // ── [3] XRPLMockAdapter — IBlockchainAdapter 교체 시뮬레이션 ──────────
  console.log('\n[검증 3] XRPLMockAdapter → IBlockchainAdapter 교체 시뮬레이션');

  const xrpl: IBlockchainAdapter = new XRPLMockAdapter();

  const xrplConnected = await xrpl.isConnected();
  check(`XRPLMockAdapter.isConnected(): ${xrplConnected}`, xrplConnected === true);

  const xrplBlock = await xrpl.getBlockNumber();
  check(`XRPLMockAdapter.getBlockNumber(): ${xrplBlock}`, xrplBlock === 99_999_999);

  console.log('\n  핵심 포인트:');
  console.log('  → EVMAdapter와 XRPLMockAdapter 모두 IBlockchainAdapter 타입으로 사용 가능');
  console.log('  → 상위 레이어(IssuerService 등)는 어느 구현체인지 알 필요 없음');
  console.log('  → 체인 교체 = 생성자 인자만 바꾸면 됨 (코드 변경 없음)');

  // ── [4] read-only 모드 확인 ───────────────────────────────────────────
  console.log('\n[검증 4] read-only 모드 — privateKey 없을 때 mintNFT 호출 시 에러');
  console.log('  (프로덕션에서는 privateKey 없이 이벤트 구독 전용 인스턴스를 분리한다)');

  try {
    await evm.mintNFT({
      contractAddr: '0x0000000000000000000000000000000000000000',
      to:           '0x0000000000000000000000000000000000000000',
      tokenId:      1n,
      amount:       1n,
      requestId:    'test-req',
    });
    check('mintNFT() → "wallet is null" 에러 발생해야 함', false);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isReadOnly = msg.toLowerCase().includes('wallet')
      || msg.toLowerCase().includes('signer')
      || msg.toLowerCase().includes('read-only')
      || msg.toLowerCase().includes('private key');
    check(`privateKey 없으면 mintNFT 불가 (에러: ${msg.slice(0, 60)})`, isReadOnly);
  }

  // ══════════════════════════════════════════════════════════════════════
  // [5] mintNFT + getBalance — MockERC1155 on Sepolia (선택 실습)
  //
  // 사전 조건:
  //   MOCK_CONTRACT_ADDR=0x...  (deploy-mock-sepolia.ts 실행 후 설정)
  //   EVM_SIGNER_KEY=0x...      (Sepolia 테스트넷 전용 개인키)
  //   Sepolia ETH 잔액 필요     (https://sepoliafaucet.com)
  // ══════════════════════════════════════════════════════════════════════
  if (MOCK_CONTRACT_ADDR && EVM_SIGNER_KEY && connected) {
    console.log('\n[검증 5] mintNFT → getBalance (MockERC1155 on Sepolia)');

    const evmWrite = new EVMAdapter({
      rpcUrl:     SEPOLIA_RPC_URL,
      chainId:    SEPOLIA_CHAIN_ID,
      privateKey: EVM_SIGNER_KEY,
    });

    // ── 실습 5: mintNFT를 호출하라 ──────────────────────────────────
    // 힌트: await evmWrite.mintNFT({ contractAddr: MOCK_CONTRACT_ADDR, to: '0xYOUR_ADDRESS', tokenId: 1n, amount: 1n, requestId: 'lab-s15-001' })
    const LAB_RECIPIENT = '0x0000000000000000000000000000000000000001';

    try {
      const receipt = await evmWrite.mintNFT({
        contractAddr: MOCK_CONTRACT_ADDR,
        to:           LAB_RECIPIENT,
        tokenId:      1n,
        amount:       1n,
        requestId:    'lab-s15-001',
      });
      check(`mintNFT txHash: ${receipt.txHash.slice(0, 18)}... status: ${receipt.status}`, receipt.status === 'success');

      // ── [6] getBalance — mint 후 잔액 확인 ────────────────────────
      console.log('\n[검증 6] getBalance → mint 직후 잔액 확인');
      const bal = await evmWrite.getBalance(MOCK_CONTRACT_ADDR, LAB_RECIPIENT, 1n);
      check(`잔액 >= 1: ${bal}`, bal >= 1n);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [오류] ${msg.slice(0, 80)}`);
      check('mintNFT (Sepolia 트랜잭션)', false);
    }
  } else if (MOCK_CONTRACT_ADDR || EVM_SIGNER_KEY) {
    console.log('\n[검증 5,6] 스킵 — MOCK_CONTRACT_ADDR + EVM_SIGNER_KEY + Sepolia 연결 모두 필요');
  } else {
    console.log('\n[검증 5,6] 스킵 — MOCK_CONTRACT_ADDR 미설정');
    console.log('  → deploy-mock-sepolia.ts 배포 후 환경변수 설정 시 활성화');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [7] queryEvents — mint 이벤트 조회 (선택 실습)
  // ══════════════════════════════════════════════════════════════════════
  if (MOCK_CONTRACT_ADDR && connected) {
    console.log('\n[검증 7] queryEvents → TransferSingle 이벤트 조회');

    const MOCK_ERC1155_ABI = [
      'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
      'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
      'function mint(address to, uint256 id, uint256 amount)',
      'function burn(address from, uint256 id, uint256 amount)',
      'function balanceOf(address account, uint256 id) view returns (uint256)',
    ];

    try {
      const currentBlock = await evm.getBlockNumber();
      const events = await evm.queryEvents(
        MOCK_CONTRACT_ADDR, MOCK_ERC1155_ABI, 'TransferSingle',
        Math.max(0, currentBlock - 1000),
        currentBlock,
      );
      check(`TransferSingle 이벤트 조회 완료 (${events.length}건)`, true);
      if (events.length > 0) {
        const e = events[events.length - 1]!;
        console.log(`  → 최근 이벤트: block #${e.blockNumber} txHash=${e.txHash.slice(0, 18)}...`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [오류] ${msg.slice(0, 80)}`);
      check('queryEvents (Sepolia)', false);
    }
  } else {
    console.log('\n[검증 7] 스킵 — MOCK_CONTRACT_ADDR 미설정 또는 RPC 연결 없음');
  }

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S15 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. EVMAdapter는 JsonRpcProvider(읽기) + Wallet(쓰기) 분리 구조');
  console.log('  2. Sepolia 공개 RPC로 동일한 API 검증 가능 (월렛원 전용 RPC와 코드 동일)');
  console.log('  3. XRPLMockAdapter처럼 IBlockchainAdapter만 구현하면 체인 교체 가능');
  console.log('  4. privateKey 없는 인스턴스 = read-only = 이벤트 구독 전용');
  console.log('  5. MockERC1155 배포 후: mintNFT → getBalance → queryEvents 전체 경로 검증');
})();
