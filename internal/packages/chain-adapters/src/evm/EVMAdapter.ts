import {
  JsonRpcProvider,
  Wallet,
  Contract,
  Interface,
  EventLog,
} from 'ethers';
import type {
  IBlockchainAdapter,
  ChainEvent,
  ContractCallParams,
  TransactionReceipt,
  MintParams,
  MintBatchParams,
  BurnParams,
} from '../interfaces/IBlockchainAdapter';

// ERC-1155 최소 ABI — mint / mintBatch / burn / balanceOf
const ERC1155_ABI = [
  'function mint(address to, uint256 id, uint256 amount)',
  'function mintBatch(address[] to, uint256[] ids, uint256[] amounts)',
  'function burn(address from, uint256 id, uint256 amount)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
];

/**
 * EVMAdapter — IBlockchainAdapter EVM 구현체 (Ethereum / Polygon)
 *
 * M3 S15 핵심:
 *   IBlockchainAdapter 인터페이스만 구현하면 XRPL/Circle 교체 시
 *   상위 레이어(IssuerService, ChainEventListener) 코드 변경 없음.
 *
 * 보안 원칙:
 *   - DMZ 내부 private RPC 노드만 연결 (public RPC 절대 금지)
 *   - RPC URL / private key 환경 변수 주입 (코드 하드코딩 금지)
 *   - privateKey 없으면 read-only 모드 (이벤트 구독 전용)
 *
 * Missed event 복구 (M7):
 *   재시작 시 DB에 저장된 마지막 처리 블록부터 queryEvents()로 보충
 *   Finalized 블록 범위만 queryEvents → 재조정 공격(REORG) 안전
 *
 * ── 교육생 안내 ──────────────────────────────────────────────────────────────
 * 역할: 참고용 구현체 (M3 S15 실습 포인트 2개 있음)
 * 실습: course/exercises/M3/S15_evm_lab.ts    ← EVMAdapter mintNFT 직접 구현
 *       course/exercises/M3/S14_multichain_adapter.ts ← Strategy 패턴 체인 교체
 * 실습 포인트: mintNFT() (line 88), mintNFTBatch() (line 103) — M4 S17 실습 참고
 */
export class EVMAdapter implements IBlockchainAdapter {
  readonly chainId:   string;
  readonly chainType = 'EVM' as const;

  private provider: JsonRpcProvider;
  private wallet:   Wallet | null;

  constructor(config: {
    rpcUrl:      string;   // DMZ 내부 노드 URL (env: EVM_RPC_URL)
    chainId:     string;
    privateKey?: string;   // 없으면 read-only 모드 (env: EVM_SIGNER_KEY)
  }) {
    this.chainId  = config.chainId;
    this.provider = new JsonRpcProvider(config.rpcUrl);
    this.wallet   = config.privateKey
      ? new Wallet(config.privateKey, this.provider)
      : null;
  }

  // ── 연결 ──────────────────────────────────────────────────────────

  async isConnected(): Promise<boolean> {
    try {
      await this.provider.getBlockNumber();
      return true;
    } catch {
      return false;
    }
  }

  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  // ── NFT 발행·소각·잔액 ────────────────────────────────────────────

  /**
   * ERC-1155 단건 발행
   * @dev NFTIssuer.issueNFT() 컨트랙트 호출 래퍼
   */
  async mintNFT(params: MintParams): Promise<TransactionReceipt> {
    // M4 S17 실습: sendTransaction으로 컨트랙트 mint 호출
    //   TX 상태머신: SUBMITTED → (여기서) → CONFIRMED / FAILED
    return this.sendTransaction({
      contractAddr: params.contractAddr,
      abi:          ERC1155_ABI,
      method:       'mint',
      args:         [params.to, params.tokenId, params.amount],
    });
  }

  /**
   * ERC-1155 배치 발행
   * @dev 500건 초과 시 BulkIssuerService.ts에서 청크 분할 후 호출
   */
  async mintNFTBatch(params: MintBatchParams): Promise<TransactionReceipt> {
    // M4 S17 실습: mintBatch 호출 + 가스 소비량 측정
    return this.sendTransaction({
      contractAddr: params.contractAddr,
      abi:          ERC1155_ABI,
      method:       'mintBatch',
      args:         [params.to, params.tokenIds, params.amounts],
    });
  }

  /** NFT 소각 (만료/회수) */
  async burnNFT(params: BurnParams): Promise<TransactionReceipt> {
    return this.sendTransaction({
      contractAddr: params.contractAddr,
      abi:          ERC1155_ABI,
      method:       'burn',
      args:         [params.from, params.tokenId, params.amount],
    });
  }

  /** ERC-1155 잔액 조회 */
  async getBalance(
    contractAddr: string,
    owner: string,
    tokenId: bigint,
  ): Promise<bigint> {
    const result = await this.call({
      contractAddr,
      abi:    ERC1155_ABI,
      method: 'balanceOf',
      args:   [owner, tokenId],
    });
    return BigInt(String(result));
  }

  // ── 저수준 TX ─────────────────────────────────────────────────────

  async call(params: ContractCallParams): Promise<unknown> {
    const iface    = new Interface(params.abi as string[]);
    const contract = new Contract(params.contractAddr, iface, this.provider) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    return contract[params.method]!(...params.args);
  }

  async sendTransaction(params: ContractCallParams): Promise<TransactionReceipt> {
    if (!this.wallet) throw new Error('EVMAdapter: read-only mode, no private key');

    type TxResponse = { wait(): Promise<{ hash: string; blockNumber: number; blockHash: string; status: number; gasUsed: bigint }> };
    type ContractMethods = Record<string, (...args: unknown[]) => Promise<TxResponse>>;
    const iface    = new Interface(params.abi as string[]);
    const contract = new Contract(params.contractAddr, iface, this.wallet) as unknown as ContractMethods;
    const tx       = await contract[params.method]!(...params.args);
    const receipt  = await tx.wait();

    return {
      txHash:      receipt.hash,
      blockNumber: receipt.blockNumber,
      blockHash:   receipt.blockHash,
      status:      receipt.status === 1 ? 'success' : 'failed',
      gasUsed:     receipt.gasUsed,
      timestamp:   Date.now(),
    };
  }

  async getReceipt(txHash: string): Promise<TransactionReceipt | null> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) return null;
    return {
      txHash:      receipt.hash,
      blockNumber: receipt.blockNumber,
      blockHash:   receipt.blockHash,
      status:      receipt.status === 1 ? 'success' : 'failed',
      gasUsed:     receipt.gasUsed,
      timestamp:   Date.now(),
    };
  }

  // ── 이벤트 구독 ───────────────────────────────────────────────────

  async subscribeEvents(
    contractAddr: string,
    abi: unknown[],
    eventNames: string[],
    _fromBlock: number,
    handler: (event: ChainEvent) => Promise<void>,
  ): Promise<() => void> {
    const iface    = new Interface(abi as string[]);
    const contract = new Contract(contractAddr, iface, this.provider);

    const listeners: Array<() => void> = [];

    for (const eventName of eventNames) {
      const listener = async (...args: unknown[]) => {
        const log = args[args.length - 1] as EventLog;
        await handler(this._toChainEvent(eventName, contractAddr, log, args));
      };
      contract.on(eventName, listener);
      listeners.push(() => contract.off(eventName, listener));
    }

    return () => listeners.forEach(off => off());
  }

  async queryEvents(
    contractAddr: string,
    abi: unknown[],
    eventName: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<ChainEvent[]> {
    const iface    = new Interface(abi as string[]);
    const contract = new Contract(contractAddr, iface, this.provider);
    const logs     = await contract.queryFilter(
      contract.getEvent(eventName),
      fromBlock,
      toBlock,
    );
    return (logs as EventLog[]).map(log =>
      this._toChainEvent(eventName, contractAddr, log, []),
    );
  }

  private _toChainEvent(
    eventName: string,
    contractAddr: string,
    log: EventLog,
    args: unknown[],
  ): ChainEvent {
    const named: Record<string, unknown> = {};
    if (log.fragment) {
      log.fragment.inputs.forEach((input, i) => {
        named[input.name] = log.args?.[i];
      });
    }
    return {
      eventName,
      contractAddr,
      txHash:      log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex:    log.index,
      args:        Object.keys(named).length ? named : { raw: args },
      raw:         log,
    };
  }
}
