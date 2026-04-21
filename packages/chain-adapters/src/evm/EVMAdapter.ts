import {
  JsonRpcProvider,
  Wallet,
  Contract,
  Interface,
  EventLog,
} from 'ethers';
import type {
  IChainAdapter,
  ChainEvent,
  ContractCallParams,
  TransactionReceipt,
} from '../interfaces/IChainAdapter';

/**
 * EVMAdapter — Phase 1 체인 어댑터 (Ethereum / Polygon)
 *
 * DMZ 내부 private RPC 노드에만 연결한다. Public RPC 직접 호출 금지.
 * RPC 엔드포인트는 환경 변수로 주입 — 코드에 하드코딩 절대 금지.
 *
 * Missed event 복구 전략:
 *   - 서비스 재시작 시 DB에 저장된 마지막 처리 블록부터 queryEvents()로 보충
 *   - subscribeEvents()는 그 이후 실시간 구독
 */
export class EVMAdapter implements IChainAdapter {
  readonly chainId: string;
  readonly chainType = 'EVM' as const;

  private provider: JsonRpcProvider;
  private wallet:   Wallet | null;

  constructor(config: {
    rpcUrl:     string;   // DMZ 내부 노드 URL
    chainId:    string;
    privateKey?: string;  // 없으면 read-only 모드
  }) {
    this.chainId  = config.chainId;
    this.provider = new JsonRpcProvider(config.rpcUrl);
    this.wallet   = config.privateKey
      ? new Wallet(config.privateKey, this.provider)
      : null;
  }

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

  async call(params: ContractCallParams): Promise<unknown> {
    const iface    = new Interface(params.abi as string[]);
    const contract = new Contract(params.contractAddr, iface, this.provider);
    return contract[params.method](...params.args);
  }

  async sendTransaction(params: ContractCallParams): Promise<TransactionReceipt> {
    if (!this.wallet) throw new Error('EVMAdapter: read-only mode, no private key');

    const iface    = new Interface(params.abi as string[]);
    const contract = new Contract(params.contractAddr, iface, this.wallet);
    const tx       = await contract[params.method](...params.args);
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
