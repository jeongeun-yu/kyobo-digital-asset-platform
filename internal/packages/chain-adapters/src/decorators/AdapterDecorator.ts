/**
 * AdapterDecorator — Decorator Pattern 베이스
 *
 * M3 S17 연계: IBlockchainAdapter를 감싸는 Decorator 베이스 클래스.
 * 모든 메서드를 그대로 위임 — 서브클래스는 필요한 메서드만 오버라이드.
 *
 * 체인: adapter → LoggingAdapterDecorator → RetryAdapterDecorator → 실제 호출
 */

import type {
  IBlockchainAdapter,
  ChainEvent,
  ContractCallParams,
  TransactionReceipt,
  MintParams,
  MintBatchParams,
  BurnParams,
} from '../interfaces/IBlockchainAdapter';

export abstract class AdapterDecorator implements IBlockchainAdapter {
  readonly chainId:   string;
  readonly chainType: 'EVM' | 'XRPL' | 'UTXO' | 'BFT';

  constructor(protected readonly inner: IBlockchainAdapter) {
    this.chainId   = inner.chainId;
    this.chainType = inner.chainType;
  }

  isConnected(): Promise<boolean> { return this.inner.isConnected(); }
  getBlockNumber(): Promise<number> { return this.inner.getBlockNumber(); }
  mintNFT(p: MintParams): Promise<TransactionReceipt> { return this.inner.mintNFT(p); }
  mintNFTBatch(p: MintBatchParams): Promise<TransactionReceipt> { return this.inner.mintNFTBatch(p); }
  burnNFT(p: BurnParams): Promise<TransactionReceipt> { return this.inner.burnNFT(p); }
  getBalance(c: string, o: string, t: bigint): Promise<bigint> { return this.inner.getBalance(c, o, t); }
  call(p: ContractCallParams): Promise<unknown> { return this.inner.call(p); }
  sendTransaction(p: ContractCallParams): Promise<TransactionReceipt> { return this.inner.sendTransaction(p); }
  getReceipt(h: string): Promise<TransactionReceipt | null> { return this.inner.getReceipt(h); }

  subscribeEvents(
    contractAddr: string,
    abi: unknown[],
    eventNames: string[],
    fromBlock: number,
    handler: (event: ChainEvent) => Promise<void>,
  ): Promise<() => void> {
    return this.inner.subscribeEvents(contractAddr, abi, eventNames, fromBlock, handler);
  }

  queryEvents(
    contractAddr: string,
    abi: unknown[],
    eventName: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<ChainEvent[]> {
    return this.inner.queryEvents(contractAddr, abi, eventName, fromBlock, toBlock);
  }
}
