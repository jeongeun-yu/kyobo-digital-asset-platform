/**
 * RetryAdapterDecorator — TX 재시도 데코레이터
 *
 * mintNFT / mintNFTBatch / sendTransaction 에서 일시적 RPC 오류 발생 시
 * 지수 백오프로 자동 재시도.
 *
 * 재시도 대상 오류: 네트워크 타임아웃, RPC 과부하 (5xx), NONCE_EXPIRED
 * 재시도 제외: REVERT (비즈니스 로직 오류), 잔액 부족
 *
 * 사용:
 *   const adapter = new RetryAdapterDecorator(new EVMAdapter(...), { maxAttempts: 3 });
 */

import type { TransactionReceipt, MintParams, MintBatchParams, ContractCallParams } from '../interfaces/IBlockchainAdapter';
import type { IBlockchainAdapter } from '../interfaces/IBlockchainAdapter';
import { AdapterDecorator } from './AdapterDecorator';

export interface RetryOptions {
  maxAttempts:    number;   // 최대 시도 횟수 (기본 3)
  initialDelayMs: number;   // 첫 재시도 대기 ms (기본 500)
  maxDelayMs:     number;   // 최대 대기 ms (기본 10000)
  backoffFactor:  number;   // 지수 배율 (기본 2)
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts:    3,
  initialDelayMs: 500,
  maxDelayMs:     10_000,
  backoffFactor:  2,
};

// 재시도하지 않는 오류 패턴 — REVERT, 잔액 부족 등
const NON_RETRYABLE = [
  'execution reverted',
  'insufficient funds',
  'nonce too high',
];

export class RetryAdapterDecorator extends AdapterDecorator {
  private readonly opts: RetryOptions;

  constructor(inner: IBlockchainAdapter, opts: Partial<RetryOptions> = {}) {
    super(inner);
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  override async mintNFT(p: MintParams): Promise<TransactionReceipt> {
    return this._retry(() => this.inner.mintNFT(p));
  }

  override async mintNFTBatch(p: MintBatchParams): Promise<TransactionReceipt> {
    return this._retry(() => this.inner.mintNFTBatch(p));
  }

  override async sendTransaction(p: ContractCallParams): Promise<TransactionReceipt> {
    return this._retry(() => this.inner.sendTransaction(p));
  }

  private async _retry<T>(fn: () => Promise<T>): Promise<T> {
    let delayMs = this.opts.initialDelayMs;

    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg = String(err).toLowerCase();
        
        // NON_RETRYABLE 재시도 불가 오류 감지, 
        // NON_RETRYABLE 에러 재시도 시 가스비만 낭비되고, 문제 해결되지 않음
        if (NON_RETRYABLE.some(p => msg.includes(p))) throw err;
        if (attempt === this.opts.maxAttempts) throw err;

        // 여러 클라이언트 동시 재시도 방지
        const jittered = delayMs * (0.8 + Math.random() * 0.4);
        await new Promise(r => setTimeout(r, jittered));
       
        // 다음 재시도 대기 시간 계산 (지수 백오프)
        // 서버가 과부하 상태면, 바로 재시도 시 더 큰 부하가 될 수 있으므로, 재시도 간격을 점점 늘려가는 전략
        // (서버 상태 개선될 때까지 기다리되, 너무 오래 기다리지 말자)
        delayMs = Math.min(delayMs * this.opts.backoffFactor, this.opts.maxDelayMs);
      }
    }

    throw new Error('RetryAdapterDecorator: unreachable');
  }
}
