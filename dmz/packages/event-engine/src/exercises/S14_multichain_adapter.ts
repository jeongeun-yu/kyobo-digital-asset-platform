/**
 * S14 실습 — IBlockchainAdapter 설계 + 멀티체인 교체 시뮬레이션
 *
 * 강의 노트: M3_S14_multichain_adapter.md
 *
 * 실행 방법 (dmz/packages/event-engine 폴더에서):
 *   npx ts-node src/exercises/S14_multichain_adapter.ts
 *
 * 목표:
 *   [1] IBlockchainAdapter 설계 원칙 — Strategy Pattern 확인
 *   [2] CircleAdapter stub 직접 작성 → IBlockchainAdapter 컴파일 통과
 *   [3] EVMAdapter / XRPLAdapter / CircleAdapter 동일 타입으로 사용 가능 확인
 *   [4] gasUsed optional — 가스 없는 체인 대응 확인
 *   [5] IVASPAdapter vs IBlockchainAdapter 레이어 구분 확인
 *
 * 핵심 질문:
 *   왜 비즈니스 로직(IssuerService)은 EVMAdapter를 직접 참조하지 않는가?
 *   → 체인 교체 시 IssuerService 코드를 한 줄도 바꾸지 않기 위해.
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

// ══════════════════════════════════════════════════════════════════════════
// 실습 1: CircleAdapter stub 직접 작성
//
// Circle ARC (Asset Routing Chain) 기반 글로벌 스테이블코인 정산 어댑터.
// Phase 3 글로벌 확장 시 추가 예정.
//
// ── 실습: 아래 CircleAdapter를 완성하라 ─────────────────────────────
// IBlockchainAdapter를 구현해야 한다.
// 모든 메서드가 컴파일 통과하면 성공.
//
// 주의: chainType은 IBlockchainAdapter에 정의된 리터럴 유니온 중 하나여야 한다.
//   'EVM' | 'XRPL' | 'UTXO' | 'BFT'
//   Circle ARC는 BFT 계열 — chainType: 'BFT'
//
// 실습 완성 전까지 아래 stub을 쓴다 → 완성하면 삭제
// ══════════════════════════════════════════════════════════════════════════

const MOCK_RECEIPT: TransactionReceipt = {
  txHash:      '0xcircle-mock',
  blockNumber: 0,
  blockHash:   '0xcircle-blockhash',
  status:      'success',
  // gasUsed 없음 — Circle ARC는 가스 모델 없음 (optional 필드)
  timestamp:   Date.now(),
};

class CircleAdapter implements IBlockchainAdapter {
  readonly chainId   = 'circle-arc-testnet';
  readonly chainType = 'BFT' as const;  // Circle은 BFT 계열

  async isConnected(): Promise<boolean> {
    // 실제 Circle API health check 대신 항상 true (stub)
    return true;
  }

  async getBlockNumber(): Promise<number> {
    // Circle ARC에서 "블록"은 attestation round — 여기선 고정값 반환
    return 0;
  }

  async mintNFT(_params: MintParams): Promise<TransactionReceipt> {
    return { ...MOCK_RECEIPT, txHash: `0xcircle-mint-${Date.now().toString(16)}` };
  }

  async mintNFTBatch(_params: MintBatchParams): Promise<TransactionReceipt> {
    return { ...MOCK_RECEIPT, txHash: `0xcircle-batch-${Date.now().toString(16)}` };
  }

  async burnNFT(_params: BurnParams): Promise<TransactionReceipt> {
    return { ...MOCK_RECEIPT, txHash: `0xcircle-burn-${Date.now().toString(16)}` };
  }

  async getBalance(_contractAddr: string, _owner: string, _tokenId: bigint): Promise<bigint> {
    return 0n;
  }

  async call(_params: ContractCallParams): Promise<unknown> {
    return null;
  }

  async sendTransaction(_params: ContractCallParams): Promise<TransactionReceipt> {
    return { ...MOCK_RECEIPT, txHash: `0xcircle-tx-${Date.now().toString(16)}` };
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
    return () => { /* unsubscribe no-op */ };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 가상 IssuerService — IBlockchainAdapter만 의존하는 상위 레이어
// 체인 교체 시 이 코드는 한 줄도 바뀌지 않아야 한다.
// ══════════════════════════════════════════════════════════════════════════

async function issuanceHealth(adapter: IBlockchainAdapter): Promise<{
  chain: string;
  type: string;
  connected: boolean;
}> {
  const connected = await adapter.isConnected();
  return { chain: adapter.chainId, type: adapter.chainType, connected };
}

// ══════════════════════════════════════════════════════════════════════════
// 헬퍼
// ══════════════════════════════════════════════════════════════════════════

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ══════════════════════════════════════════════════════════════════════════
// 실습 진입점
// ══════════════════════════════════════════════════════════════════════════

(async () => {
  console.log('=== S14: IBlockchainAdapter 설계 + 멀티체인 교체 시뮬레이션 ===\n');

  // ── [1] Strategy Pattern — 동일 인터페이스로 어댑터 교체 ──────────────
  console.log('[검증 1] Strategy Pattern — 3개 어댑터 모두 IBlockchainAdapter 타입');

  // 각 어댑터는 IBlockchainAdapter 타입으로 사용된다.
  // issuanceHealth()는 어댑터가 EVM인지 XRPL인지 Circle인지 모른다.
  const adapters: IBlockchainAdapter[] = [
    new EVMAdapter({ rpcUrl: 'https://rpc.sepolia.org', chainId: '11155111' }),
    new XRPLAdapter({ wsUrl: 'wss://xrplcluster.com' }),
    new CircleAdapter(),
  ];

  for (const adapter of adapters) {
    const health = await issuanceHealth(adapter).catch(() => ({
      chain: adapter.chainId, type: adapter.chainType, connected: false,
    }));
    check(
      `${health.type.padEnd(4)} | chain: ${health.chain.slice(0, 20).padEnd(20)} | connected: ${health.connected}`,
      true,
    );
  }

  console.log('\n  핵심: issuanceHealth()는 어댑터 구현체를 모른다 — 인터페이스만 의존');

  // ── [2] gasUsed optional — 가스 없는 체인 대응 ───────────────────────
  console.log('\n[검증 2] gasUsed optional — 가스 없는 체인 대응');

  const circle = new CircleAdapter();
  const receipt = await circle.mintNFT({
    contractAddr: '0x0',
    to:           '0x1',
    tokenId:      1n,
    amount:       1n,
    requestId:    'test',
  });

  check(`CircleAdapter receipt.status: ${receipt.status}`, receipt.status === 'success');
  check(
    `gasUsed 없음 (undefined): ${receipt.gasUsed} — 가스 없는 체인 대응`,
    receipt.gasUsed === undefined,
  );
  console.log('  → EVM receipt은 gasUsed가 있고, Circle/XRPL은 undefined → optional 설계');

  // ── [3] subscribeEvents — Promise<() => void> 반환 ────────────────────
  console.log('\n[검증 3] subscribeEvents → unsubscribe 함수 반환');
  console.log('  왜 Promise<() => void>인가:');
  console.log('  → 구독 시 비동기 초기화 필요 (WebSocket 연결, 필터 등록 등)');
  console.log('  → 반환된 () => void 를 호출하면 즉시 구독 해제');

  const unsubscribe = await circle.subscribeEvents('0x0', [], ['TransferSingle'], 0, async () => {});
  check('subscribeEvents → 함수 반환', typeof unsubscribe === 'function');

  unsubscribe(); // 구독 해제
  check('unsubscribe() 호출 후 에러 없음', true);

  // ── [4] chainType 리터럴 유니온 — 잘못된 타입 차단 ───────────────────
  console.log('\n[검증 4] chainType 확인 — 어댑터별 고유 식별자');
  const evm    = new EVMAdapter({ rpcUrl: 'http://localhost', chainId: '1' });
  const xrpl   = new XRPLAdapter({ wsUrl: 'wss://xrplcluster.com' });
  const circle2 = new CircleAdapter();

  check(`EVMAdapter.chainType:    ${evm.chainType}`,     evm.chainType    === 'EVM');
  check(`XRPLAdapter.chainType:   ${xrpl.chainType}`,   xrpl.chainType   === 'XRPL');
  check(`CircleAdapter.chainType: ${circle2.chainType}`, circle2.chainType === 'BFT');

  // ── [5] IVASPAdapter vs IBlockchainAdapter 레이어 구분 ────────────────
  console.log('\n[검증 5] IVASPAdapter vs IBlockchainAdapter 레이어 구분');
  console.log('  IVASPAdapter  — 비즈니스 추상화 (지갑 생성, 전송, AML 스크리닝)');
  console.log('  IBlockchainAdapter — 기술 추상화 (블록체인 프로토콜 연결)');
  console.log('');
  console.log('  Phase 1: IVASPAdapter → 외부 VASP(월렛원) 위임');
  console.log('           IBlockchainAdapter → EVMAdapter 직접 구현');
  console.log('');
  console.log('  Phase 3: IBlockchainAdapter → CircleAdapter 추가');
  console.log('           IssuerService 코드 변경 없음 — 어댑터만 교체');
  check('레이어 구분 이해 확인', true);

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S14 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. Strategy Pattern: IssuerService → 인터페이스만 의존, 구현체는 DI');
  console.log('  2. gasUsed? optional: XRPL/Circle 등 가스 없는 체인 대응');
  console.log('  3. subscribeEvents → Promise<() => void>: 비동기 구독 + 동기 해제');
  console.log('  4. queryEvents: Finalized 범위만 → REORG 안전한 missed event 복구');
  console.log('  5. chainType 리터럴: 런타임에 어댑터 종류 식별 가능');

  // EVMAdapter JsonRpcProvider가 백그라운드에서 재시도하므로 명시적 종료
  process.exit(process.exitCode ?? 0);
})();
