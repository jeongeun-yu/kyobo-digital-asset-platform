// =============================================================================
// 향후 확장 STUB — UTXO 체인 어댑터 (Bitcoin / Bitcoin Cash 등)
// =============================================================================
// 구현 시점: UTXO 기반 체인 연동이 필요한 시점 (현재 계획 없음)
//
// UTXO 특성 고려 사항 (구현 전 반드시 검토):
//   - 계정 모델 없음 — 미사용 출력(UTXO) 집합으로 잔액 표현
//   - 스마트컨트랙트 없음 — mintNFT/burnNFT는 Ordinals/Runes 프로토콜 필요
//   - "블록 번호" 대신 블록 높이(height) 사용 — 개념은 동일
//   - 수수료: sat/vByte 단위 (EIP-1559 없음, UTXO 크기에 비례)
//   - Travel Rule: OP_RETURN 필드 활용 가능
//   - NFT 발행: Ordinals(비트코인 刻印) 또는 RGB 프로토콜 검토 필요
//
// IBlockchainAdapter 인터페이스를 구현하므로 event-engine, issuer-service 수정 없음.
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

export class UTXOAdapter implements IBlockchainAdapter {
  readonly chainId   = 'bitcoin-mainnet';
  readonly chainType = 'UTXO' as const;

  // TODO 향후: bitcoinjs-lib + Electrum / BitcoinCore RPC 초기화
  constructor(_config?: { rpcUrl?: string; network?: 'mainnet' | 'testnet' }) {}

  async isConnected(): Promise<boolean>      { throw new Error('UTXOAdapter: not implemented'); }
  async getBlockNumber(): Promise<number>    { throw new Error('UTXOAdapter: not implemented'); }

  // mintNFT: UTXO 체인은 스마트컨트랙트 없음
  // → Ordinals(Inscription) 또는 Runes 프로토콜 기반 구현 필요
  async mintNFT(_p: MintParams): Promise<TransactionReceipt>         { throw new Error('UTXOAdapter: not implemented'); }
  async mintNFTBatch(_p: MintBatchParams): Promise<TransactionReceipt> { throw new Error('UTXOAdapter: not implemented'); }
  async burnNFT(_p: BurnParams): Promise<TransactionReceipt>         { throw new Error('UTXOAdapter: not implemented'); }

  // getBalance: UTXO 집합 합산 필요 — tokenId 개념 없음 (Ordinals 연동 시 별도 설계)
  async getBalance(_contractAddr: string, _owner: string, _tokenId: bigint): Promise<bigint> { throw new Error('UTXOAdapter: not implemented'); }

  async call(_p: ContractCallParams): Promise<unknown>               { throw new Error('UTXOAdapter: not implemented'); }
  async sendTransaction(_p: ContractCallParams): Promise<TransactionReceipt> { throw new Error('UTXOAdapter: not implemented'); }
  async getReceipt(_h: string): Promise<TransactionReceipt | null>  { throw new Error('UTXOAdapter: not implemented'); }

  // subscribeEvents: Bitcoin은 이벤트 로그 없음 — ZMQ 또는 블록 폴링 방식 필요
  async subscribeEvents(
    _a: string, _b: unknown[], _e: string[], _f: number,
    _h: (e: ChainEvent) => Promise<void>,
  ): Promise<() => void> { throw new Error('UTXOAdapter: not implemented'); }

  async queryEvents(
    _a: string, _b: unknown[], _e: string, _f: number, _t: number,
  ): Promise<ChainEvent[]> { throw new Error('UTXOAdapter: not implemented'); }
}
