// =============================================================================
// Phase 2+ STUB — XRP Ledger 어댑터
// =============================================================================
// 구현 시점: 교보 Phase 2 (KRW 스테이블코인) 또는 Phase 3 (STO) 진입 시
//
// XRPL 특성 고려 사항 (구현 전 반드시 검토):
//   - UTXO 모델이 아닌 계정 기반 원장 (EVM과 유사하나 스마트컨트랙트 없음)
//   - Hooks (XRPL 사이드체인) 또는 EVM Sidechain 사용 여부 결정 필요
//   - 토큰 발행: IOU (Issued Currency) 방식 — ERC-20과 개념적으로 유사
//   - Travel Rule: XRPL 자체 Memo 필드 활용 가능
//   - 결제 채널: KRW 스테이블코인의 빠른 정산에 유리
//
// IChainAdapter 인터페이스를 구현하므로 event-engine, issuer-service 수정 없음.
// =============================================================================

import type { IChainAdapter, ChainEvent, ContractCallParams, TransactionReceipt } from '../interfaces/IChainAdapter';

export class XRPLAdapter implements IChainAdapter {
  readonly chainId  = 'xrpl-mainnet';
  readonly chainType = 'XRPL' as const;

  // TODO Phase 2+: xrpl.js Client 초기화
  constructor(_config: { wsUrl: string; seed?: string }) {}

  async isConnected(): Promise<boolean> { throw new Error('XRPLAdapter: not implemented'); }
  async getBlockNumber(): Promise<number> { throw new Error('XRPLAdapter: not implemented'); }
  async call(_p: ContractCallParams): Promise<unknown> { throw new Error('XRPLAdapter: not implemented'); }
  async sendTransaction(_p: ContractCallParams): Promise<TransactionReceipt> { throw new Error('XRPLAdapter: not implemented'); }
  async getReceipt(_h: string): Promise<TransactionReceipt | null> { throw new Error('XRPLAdapter: not implemented'); }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { throw new Error('XRPLAdapter: not implemented'); }
  async queryEvents(_a: string, _b: unknown[], _e: string, _f: number, _t: number): Promise<ChainEvent[]> { throw new Error('XRPLAdapter: not implemented'); }
}
