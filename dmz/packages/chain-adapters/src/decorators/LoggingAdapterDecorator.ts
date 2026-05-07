/**
 * LoggingAdapterDecorator — 체인 호출 로깅 데코레이터
 *
 * 모든 TX 발행·소각·이벤트 쿼리에 대해:
 *   - 호출 시작 / 완료 / 소요시간 로깅
 *   - 에러 발생 시 method + params + error 기록
 *
 * 사용:
 *   const adapter = new LoggingAdapterDecorator(new EVMAdapter(...), console);
 */

import type { TransactionReceipt, MintParams, MintBatchParams, BurnParams, ContractCallParams, ChainEvent } from '../interfaces/IBlockchainAdapter';
import type { IBlockchainAdapter } from '../interfaces/IBlockchainAdapter';
import { AdapterDecorator } from './AdapterDecorator';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export class LoggingAdapterDecorator extends AdapterDecorator {
  constructor(inner: IBlockchainAdapter, private readonly log: Logger) {
    super(inner);
  }

  override async mintNFT(p: MintParams): Promise<TransactionReceipt> {
    return this._wrap('mintNFT', { to: p.to, tokenId: String(p.tokenId) }, () => this.inner.mintNFT(p));
  }

  override async mintNFTBatch(p: MintBatchParams): Promise<TransactionReceipt> {
    return this._wrap('mintNFTBatch', { count: p.to.length }, () => this.inner.mintNFTBatch(p));
  }

  override async burnNFT(p: BurnParams): Promise<TransactionReceipt> {
    return this._wrap('burnNFT', { from: p.from, tokenId: String(p.tokenId) }, () => this.inner.burnNFT(p));
  }

  override async sendTransaction(p: ContractCallParams): Promise<TransactionReceipt> {
    return this._wrap('sendTransaction', { contract: p.contractAddr, method: p.method }, () => this.inner.sendTransaction(p));
  }

  override async queryEvents(
    contractAddr: string,
    abi: unknown[],
    eventName: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<ChainEvent[]> {
    return this._wrap(
      'queryEvents',
      { contract: contractAddr, event: eventName, fromBlock, toBlock },
      () => this.inner.queryEvents(contractAddr, abi, eventName, fromBlock, toBlock),
    );
  }

  private async _wrap<T>(
    method: string,
    meta: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = Date.now();
    this.log.info(`[adapter] ${method} start`, { chain: this.chainId, ...meta });
    try {
      const result = await fn();
      this.log.info(`[adapter] ${method} ok`, { chain: this.chainId, ms: Date.now() - start, ...meta });
      return result;
    } catch (err) {
      this.log.error(`[adapter] ${method} error`, { chain: this.chainId, ms: Date.now() - start, error: String(err), ...meta });
      throw err;
    }
  }
}
