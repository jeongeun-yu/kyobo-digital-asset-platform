/**
 * IBlockchainAdapter — 블록체인 추상화 인터페이스
 *
 * M4 S16/S17 핵심 개념:
 *   VASP와 블록체인 사이에 삽입되는 Strategy Pattern 레이어.
 *   발행·소각·잔액 조회·TX 검증·이벤트 구독을 체인 무관하게 추상화.
 *   비즈니스 로직(VASP, 원장)은 이 인터페이스만 의존 — 체인 교체 시 무변경.
 *
 * 구현체:
 *   EVMAdapter    — Ethereum / Polygon (Phase 1)
 *   XRPLAdapter   — XRP Ledger (Phase 2+)
 *   CircleAdapter — Circle ARC / CCTP (Phase 3+)
 *
 * 의존 방향:
 *   IssuerService → IBlockchainAdapter ← EVMAdapter
 *                                      ← XRPLAdapter
 *                                      ← CircleAdapter
 *
 * 교체 시뮬레이션 (M4 S17):
 *   EVMAdapter → XRPLAdapter 교체 시 IssuerService 코드 한 줄도 변경 없음
 */

export interface TransactionReceipt {
  txHash:      string;
  blockNumber: number;
  blockHash:   string;
  status:      'success' | 'failed' | 'pending';
  gasUsed?:    bigint;
  timestamp:   number;
}

export interface ChainEvent {
  eventName:    string;
  contractAddr: string;
  txHash:       string;
  blockNumber:  number;
  logIndex:     number;
  args:         Record<string, unknown>;
  raw:          unknown;
}

export interface ContractCallParams {
  contractAddr: string;
  abi:          unknown[];
  method:       string;
  args:         unknown[];
  signerKey?:   string;  // 없으면 read-only
}

export interface MintParams {
  contractAddr: string;
  to:           string;
  tokenId:      bigint;
  amount:       bigint;
  requestId:    string;  // Idempotency key — UUID
}

export interface MintBatchParams {
  contractAddr: string;
  to:           string[];
  tokenIds:     bigint[];
  amounts:      bigint[];
  requestId:    string;
}

export interface BurnParams {
  contractAddr: string;
  from:         string;
  tokenId:      bigint;
  amount:       bigint;
}

export interface IBlockchainAdapter {
  readonly chainId:   string;
  readonly chainType: 'EVM' | 'XRPL' | 'UTXO' | 'BFT';

  // ── 연결 ────────────────────────────────────────────────────────────

  /** 노드 연결 상태 확인 (DMZ health check) */
  isConnected(): Promise<boolean>;

  /** 현재 블록 높이 — missed event 복구 기준점 */
  getBlockNumber(): Promise<number>;

  // ── NFT 발행·소각·잔액 ─────────────────────────────────────────────

  /**
   * NFT 단건 발행 (ERC-1155 mint)
   * Idempotency: requestId 기반 중복 방지
   */
  mintNFT(params: MintParams): Promise<TransactionReceipt>;

  /**
   * NFT 배치 발행 (ERC-1155 mintBatch)
   * 500건/배치 권장 — block gas limit 고려
   */
  mintNFTBatch(params: MintBatchParams): Promise<TransactionReceipt>;

  /** NFT 소각 — 만료/회수 처리 */
  burnNFT(params: BurnParams): Promise<TransactionReceipt>;

  /**
   * 잔액 조회 (balanceOf)
   * @returns 보유 수량 (ERC-1155에서 tokenId별 수량)
   */
  getBalance(contractAddr: string, owner: string, tokenId: bigint): Promise<bigint>;

  // ── 저수준 TX ───────────────────────────────────────────────────────

  /** 컨트랙트 read-only 호출 */
  call(params: ContractCallParams): Promise<unknown>;

  /** 트랜잭션 전송 — 서명은 어댑터 내부 처리 (private key 노출 없음) */
  sendTransaction(params: ContractCallParams): Promise<TransactionReceipt>;

  /** TX 상태 조회 — REVERT/TIMEOUT/REORG 감지에 사용 */
  getReceipt(txHash: string): Promise<TransactionReceipt | null>;

  // ── 이벤트 구독 ─────────────────────────────────────────────────────

  /**
   * 실시간 이벤트 구독
   * ChainEventListener → DMZPublisher 파이프라인의 입력
   * @returns unsubscribe 함수
   */
  subscribeEvents(
    contractAddr: string,
    abi: unknown[],
    eventNames: string[],
    fromBlock: number,
    handler: (event: ChainEvent) => Promise<void>,
  ): Promise<() => void>;

  /**
   * 과거 이벤트 조회 — 재시작 시 missed event 복구
   * M7 DMZ 파이프라인: Finalized 블록 범위만 처리
   */
  queryEvents(
    contractAddr: string,
    abi: unknown[],
    eventName: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<ChainEvent[]>;
}
