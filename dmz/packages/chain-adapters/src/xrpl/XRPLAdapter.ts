// =============================================================================
// Phase 2 STUB — XRP Ledger 어댑터
// =============================================================================
// 구현 시점: Phase 2 — 원화 스테이블코인(KRW1) 결제 레이어 도입 시
//
// Phase 2에서 XRPL을 선택하는 이유:
//   - KRW1 스테이블코인: XRPL IOU(Issued Currency) 방식으로 발행
//     → 교보생명이 발행자(Issuer) 계정을 보유, 보험금·환급금을 KRW1로 지급
//   - 결제 채널(Payment Channel): 마이크로 결제 최종 정산에 유리
//   - 수수료: EVM 대비 극히 낮음 (건당 $0.0002 수준)
//   - 기관 사례: SBI, 리플 파트너사 다수 (국내 신한은행 파일럿)
//
// XRPL 구현 시 고려 사항:
//   - 계정 기반 원장 (EVM과 유사, 스마트컨트랙트 없음)
//   - Hooks(XRPL 온체인 로직) 또는 EVM Sidechain 사용 여부 결정 필요
//   - Trust Line 설정 필수 — 수신자가 KRW1 IOU 수신 허용해야 함
//   - Travel Rule: XRPL Memo 필드 활용 가능
//
// Phase 1과의 차이:
//   Phase 1: EVMAdapter만 사용 (Ethereum — NFT 발행)
//   Phase 2: EVMAdapter(NFT) + XRPLAdapter(KRW1 결제) 병행
//
// IBlockchainAdapter 인터페이스를 구현하므로 issuer-service 수정 없음.
// ChainAdapterFactory에서 chainType='XRPL' 로 자동 라우팅.
// =============================================================================

import type { IBlockchainAdapter, ChainEvent, ContractCallParams, TransactionReceipt, MintParams, MintBatchParams, BurnParams } from '../interfaces/IBlockchainAdapter';

export class XRPLAdapter implements IBlockchainAdapter {
  readonly chainId  = 'xrpl-mainnet';
  readonly chainType = 'XRPL' as const;

  // 향후: xrpl.js Client 초기화
  constructor(_config?: { wsUrl?: string; seed?: string }) {}

  async isConnected(): Promise<boolean> { throw new Error('XRPLAdapter: not implemented'); }
  async getBlockNumber(): Promise<number> { throw new Error('XRPLAdapter: not implemented'); }
  async mintNFT(_p: MintParams): Promise<TransactionReceipt> { throw new Error('XRPLAdapter: not implemented'); }
  async mintNFTBatch(_p: MintBatchParams): Promise<TransactionReceipt> { throw new Error('XRPLAdapter: not implemented'); }
  async burnNFT(_p: BurnParams): Promise<TransactionReceipt> { throw new Error('XRPLAdapter: not implemented'); }
  async getBalance(_contractAddr: string, _owner: string, _tokenId: bigint): Promise<bigint> { throw new Error('XRPLAdapter: not implemented'); }
  async call(_p: ContractCallParams): Promise<unknown> { throw new Error('XRPLAdapter: not implemented'); }
  async sendTransaction(_p: ContractCallParams): Promise<TransactionReceipt> { throw new Error('XRPLAdapter: not implemented'); }
  async getReceipt(_h: string): Promise<TransactionReceipt | null> { throw new Error('XRPLAdapter: not implemented'); }
  async subscribeEvents(_a: string, _b: unknown[], _e: string[], _f: number, _h: (e: ChainEvent) => Promise<void>): Promise<() => void> { throw new Error('XRPLAdapter: not implemented'); }
  async queryEvents(_a: string, _b: unknown[], _e: string, _f: number, _t: number): Promise<ChainEvent[]> { throw new Error('XRPLAdapter: not implemented'); }
}
