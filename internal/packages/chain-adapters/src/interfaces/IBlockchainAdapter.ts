/**
 * IBlockchainAdapter — 블록체인 추상화 인터페이스
 *
 * VASP와 블록체인 사이에 삽입되는 Strategy Pattern 레이어.
 * 발행·소각·잔액 조회·TX 검증·이벤트 구독을 체인 무관하게 추상화.
 * 비즈니스 로직(VASP, 원장)은 이 인터페이스만 의존 — 체인 교체 시 무변경.
 *
 * 구현체:
 *   EVMAdapter    — Ethereum / EVM 호환 체인 (Phase 1)
 *   XRPLAdapter   — XRP Ledger (향후 확장용 stub)
 *   CircleAdapter — Circle ARC / CCTP (향후 확장용 stub)
 *
 * 의존 방향:
 *   IssuerService → IBlockchainAdapter ← EVMAdapter
 *                                      ← XRPLAdapter
 *                                      ← CircleAdapter
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

// ── EIP-1559 수수료 구조 (Phase 3: 직접 TX 전송 시 필요) ────────────────────
//
// EIP-1559 (London 하드포크, 2021): Ethereum 기본 수수료 모델
//
//   실제 납부 = min(MaxFeePerGas, BaseFee + MaxPriorityFeePerGas)
//   BaseFee:             네트워크 혼잡도에 따라 프로토콜이 자동 결정 (소각됨)
//   MaxPriorityFeePerGas: 검증자에게 지불하는 팁 (채굴자 우선순위)
//   MaxFeePerGas:        사용자가 설정하는 최대 납부 한도
//
// Phase 1: VASP(월렛원)가 수수료 설정. EVMAdapter는 Legacy gasPrice 사용.
// Phase 3: 직접 TX 생성 시 EIP-1559 수수료 직접 설정 필요.

export interface Eip1559FeeParams {
  maxFeePerGas:         bigint;   // wei 단위
  maxPriorityFeePerGas: bigint;   // wei 단위
}

// ── 수수료 정책 ID (Phase 3) ──────────────────────────────────────────────────
//
// TX 전송 시 수수료 전략을 정책 ID로 추상화.
// 어댑터가 현재 네트워크 상황에 따라 적절한 수수료를 계산.
//
//   NORMAL: 표준 처리. BaseFee + 최소 Priority Fee. (~12초)
//   FAST:   빠른 처리. BaseFee * 1.2 + 높은 Priority Fee. (~6초)
//   SURGE:  긴급 처리. BaseFee * 1.5 + 최고 Priority Fee. (~1블록)

export type FeePolicyId = 'NORMAL' | 'FAST' | 'SURGE';

// ── RPC 저하 모드 (Phase 3) ───────────────────────────────────────────────────
//
// 단일 RPC 노드는 신뢰할 수 없다. 다중 RPC + quorum 합의 필요.
// RPC 신뢰성 저하 시 단계적으로 기능을 제한하는 저하 모드.
//
//   NORMAL:               정상. 모든 TX 처리 가능.
//   DEGRADED_READ:        읽기 전용 RPC 부분 장애. 쓰기(TX)는 정상.
//   DEGRADED_WRITE:       쓰기 RPC 부분 장애. 고가치 TX만 처리.
//   MANUAL_APPROVAL_ONLY: RPC 신뢰 불가. 모든 TX에 수동 승인 필요.
//   STOP_THE_LINE:        전체 중단. 어떤 TX도 전송하지 않음.

export type RpcDegradeMode =
  | 'NORMAL'
  | 'DEGRADED_READ'
  | 'DEGRADED_WRITE'
  | 'MANUAL_APPROVAL_ONLY'
  | 'STOP_THE_LINE';

// ── IBlockchainAdapter ────────────────────────────────────────────────────────

export interface IBlockchainAdapter {
  readonly chainId:   string;
  readonly chainType: 'EVM' | 'XRPL' | 'UTXO' | 'BFT';

  // ── 연결 ────────────────────────────────────────────────────────────

  /** 노드 연결 상태 확인 (내부망 헬스체크) */
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
   * ChainEventListener → 이벤트 파이프라인의 입력
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
   * Finalized 블록 범위만 처리 (REORG 안전)
   */
  queryEvents(
    contractAddr: string,
    abi: unknown[],
    eventName: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<ChainEvent[]>;
}

// ── Phase 3 확장 인터페이스 ───────────────────────────────────────────────────
//
// Phase 1 어댑터(EVMAdapter, XRPLAdapter)는 IBlockchainAdapter만 구현.
// Phase 3에서 직접 TX 전송 시 EIP-1559 수수료 계산 + RPC 다중화가 필요해지면
// IBlockchainAdapterV3를 추가로 구현한다.
//
// 이렇게 분리하는 이유:
//   IBlockchainAdapter에 직접 추가하면 기존 구현체(EVMAdapter 등)가 모두 에러.
//   인터페이스 확장(extends)으로 하위 호환성을 유지하면서 Phase 3 기능을 추가.

export interface IBlockchainAdapterV3 extends IBlockchainAdapter {
  /**
   * Phase 3: 현재 네트워크 수수료 조회
   *   feePolicyId에 따라 maxFeePerGas / maxPriorityFeePerGas 계산
   *   EVM: eth_feeHistory 기반 / XRPL: fee_base 조회
   */
  getFeeParams(policyId: FeePolicyId): Promise<Eip1559FeeParams>;

  /**
   * Phase 3: 현재 RPC 저하 모드 조회
   *   다중 RPC quorum 상태를 기반으로 저하 모드 반환
   *   STOP_THE_LINE이면 TX 전송 차단
   */
  getRpcDegradeMode(): Promise<RpcDegradeMode>;
}
