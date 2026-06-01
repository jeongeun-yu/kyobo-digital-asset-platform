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

// ERC-1155 TransferSingle — tokenId 목록 스캔용
const TRANSFER_SINGLE_ABI = [
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
];

/**
 * EVMAdapter — IBlockchainAdapter EVM 구현체 (Ethereum / Polygon)
 *
 * IBlockchainAdapter 인터페이스만 구현하면 XRPL/Circle 교체 시
 * 상위 레이어(IssuerService, ChainEventListener) 코드 변경 없음.
 *
 * 보안 원칙:
 *   - 내부망 private RPC 노드만 연결 (public RPC 절대 금지)
 *   - RPC URL / private key 환경 변수 주입 (코드 하드코딩 금지)
 *   - privateKey 없으면 read-only 모드 (이벤트 구독 전용)
 *
 * Missed event 복구:
 *   재시작 시 DB에 저장된 마지막 처리 블록부터 queryEvents()로 보충
 *   Finalized 블록 범위만 queryEvents → 재조정 공격(REORG) 안전
 */
export class EVMAdapter implements IBlockchainAdapter {
  readonly chainId:   string;
  readonly chainType = 'EVM' as const;

  private provider: JsonRpcProvider;
  private wallet:   Wallet | null;

  constructor(config: {
    rpcUrl:      string;   // 내부망 노드 URL (env: EVM_RPC_URL)
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

  /**
   * ERC-1155 주소의 보유 tokenId 목록 조회
   *
   * ERC-1155는 enumeration이 없으므로 TransferSingle 이벤트를 스캔한다.
   * from/to에 address가 포함된 이벤트의 tokenId를 수집 → balanceOf > 0 필터링.
   */
  async getNftHoldings(
    contractAddr: string,
    address: string,
    fromBlock = 0,
    blockChunkSize = 9,
  ): Promise<bigint[]> {
    const currentBlock = await this.provider.getBlockNumber();
    const iface    = new Interface(TRANSFER_SINGLE_ABI);
    const contract = new Contract(contractAddr, iface, this.provider);

    const allLogs: EventLog[] = [];
    for (let start = fromBlock; start <= currentBlock; start += blockChunkSize + 1) {
      const end = Math.min(start + blockChunkSize, currentBlock);
      const chunk = await contract.queryFilter(
        contract.getEvent('TransferSingle'),
        start,
        end,
      ) as EventLog[];
      allLogs.push(...chunk);
    }
    const logs = allLogs;

    const addrLower = address.toLowerCase();
    const tokenIds  = new Set<string>();
    for (const log of logs) {
      const from = (log.args?.[1] as string | undefined)?.toLowerCase();
      const to   = (log.args?.[2] as string | undefined)?.toLowerCase();
      const id   = log.args?.[3] as bigint | undefined;
      if (id !== undefined && (from === addrLower || to === addrLower)) {
        tokenIds.add(String(id));
      }
    }

    const result: bigint[] = [];
    for (const tokenIdStr of tokenIds) {
      const tokenId = BigInt(tokenIdStr);
      const balance = await this.getBalance(contractAddr, address, tokenId);
      if (balance > 0n) result.push(tokenId);
    }
    return result;
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
        // ethers v6: contract.on() 마지막 인자는 ContractEventPayload
        // ContractEventPayload.log가 실제 EventLog (transactionHash 포함)
        const payload = args[args.length - 1] as { log?: EventLog } & EventLog;
        const log = payload.log ?? payload;
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
