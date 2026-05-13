// =============================================================================
// Phase 2 STUB — Circle ARC (Asset Routing Chain) + CCTP 어댑터
// =============================================================================
// 구현 시점: Phase 2 — USDC 기반 글로벌 결제 레이어 도입 시
//            (외국인 보험계약자 대상 보험금 USDC 정산, 크로스체인 이동)
//
// Phase 2에서 Circle ARC를 선택하는 이유:
//   - USDC: 전 세계 150개 이상 거래소 지원, 규제 명확 (미 SEC 등록)
//   - CCTP(Cross-Chain Transfer Protocol): USDC를 체인 간 네이티브 소각·발행
//     → Ethereum ↔ Arbitrum ↔ Solana 등 브릿지 없이 직접 이동
//   - 교보 활용: 해외 송금·외화 보험금 정산을 USDC로 처리
//
// Phase 1과의 차이:
//   Phase 1: EVMAdapter만 사용 (NFT 발행, 원화 결제)
//   Phase 2: EVMAdapter(NFT) + CircleAdapter(USDC 글로벌 정산) 병행
//            XRPLAdapter(KRW1 국내 결제)와 함께 결제 레이어 이중화
//
// Circle ARC / CCTP 구현 시 고려 사항:
//   - BFT 계열 합의 — 가스 모델 없음 (gasUsed: undefined)
//   - "블록" 개념 없음 — attestation round 기반 (getBlockNumber: 0 반환)
//   - NFT 발행: Circle은 스테이블코인 특화 — NFT 직접 발행 미지원
//     → mintNFT는 별도 EVM 컨트랙트 + CCTP 연계 구조 필요
//   - Travel Rule: Circle Compliance API 별도 연동 필요
//
// IBlockchainAdapter 인터페이스를 구현하므로 issuer-service 수정 없음.
// ChainAdapterFactory에서 chainType='BFT' 로 자동 라우팅.
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

  // 향후: Circle Developer API 키 + CCTP 컨트랙트 주소 초기화
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
