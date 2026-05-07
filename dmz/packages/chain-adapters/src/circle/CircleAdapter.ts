// =============================================================================
// 향후 확장 STUB — Circle ARC (Asset Routing Chain) 어댑터
// =============================================================================
// 구현 시점: Phase 3 글로벌 확장 — 외국인 보험계약자 대상 USDC 정산 도입 시
//
// Circle ARC / CCTP 특성 고려 사항 (구현 전 반드시 검토):
//   - BFT 계열 합의 — 가스 모델 없음 (gasUsed: undefined)
//   - "블록" 개념 없음 — attestation round 기반 (getBlockNumber: 0 반환)
//   - NFT 발행: Circle은 스테이블코인(USDC) 특화 — NFT 발행 API 미지원
//     → mintNFT/burnNFT는 별도 EVM 컨트랙트 + CCTP 연계 구조 필요
//   - Cross-Chain Transfer Protocol (CCTP): USDC를 체인 간 네이티브 소각/발행
//   - Travel Rule: Circle Compliance API 별도 연동 필요
//
// IBlockchainAdapter 인터페이스를 구현하므로 event-engine, issuer-service 수정 없음.
//
// S14 실습 참조: src/exercises/S14_multichain_adapter.ts
// =============================================================================

import type {
  IBlockchainAdapter,
  ChainEvent,
  ContractCallParams,
  TransactionReceipt,
  MintParams,
  MintBatchParams,
  BurnParams,
} from '../interfaces/IBlockchainAdapter';

export class CircleAdapter implements IBlockchainAdapter {
  readonly chainId   = 'circle-arc-mainnet';
  readonly chainType = 'BFT' as const;

  // TODO 향후: Circle Developer API 키 + CCTP 컨트랙트 주소 초기화
  constructor(_config?: { apiKey?: string; baseUrl?: string }) {}

  async isConnected(): Promise<boolean>      { throw new Error('CircleAdapter: not implemented'); }

  // Circle ARC는 블록 번호 개념 없음 — attestation round ID 매핑 필요
  async getBlockNumber(): Promise<number>    { throw new Error('CircleAdapter: not implemented'); }

  // mintNFT: Circle API에 NFT 발행 직접 지원 없음
  // → CCTP로 USDC 이동 후 EVM 측 컨트랙트에서 발행하는 구조로 구현 예정
  async mintNFT(_p: MintParams): Promise<TransactionReceipt>      { throw new Error('CircleAdapter: not implemented'); }
  async mintNFTBatch(_p: MintBatchParams): Promise<TransactionReceipt> { throw new Error('CircleAdapter: not implemented'); }
  async burnNFT(_p: BurnParams): Promise<TransactionReceipt>      { throw new Error('CircleAdapter: not implemented'); }

  async getBalance(_contractAddr: string, _owner: string, _tokenId: bigint): Promise<bigint> { throw new Error('CircleAdapter: not implemented'); }
  async call(_p: ContractCallParams): Promise<unknown>            { throw new Error('CircleAdapter: not implemented'); }
  async sendTransaction(_p: ContractCallParams): Promise<TransactionReceipt> { throw new Error('CircleAdapter: not implemented'); }
  async getReceipt(_h: string): Promise<TransactionReceipt | null> { throw new Error('CircleAdapter: not implemented'); }

  // subscribeEvents: Circle은 WebSocket 미지원 — Webhook 방식으로 구현 예정
  async subscribeEvents(
    _a: string, _b: unknown[], _e: string[], _f: number,
    _h: (e: ChainEvent) => Promise<void>,
  ): Promise<() => void> { throw new Error('CircleAdapter: not implemented'); }

  async queryEvents(
    _a: string, _b: unknown[], _e: string, _f: number, _t: number,
  ): Promise<ChainEvent[]> { throw new Error('CircleAdapter: not implemented'); }
}
