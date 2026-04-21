/**
 * IChainAdapter — 체인 추상화 인터페이스
 *
 * 모든 체인 연동은 이 인터페이스를 통한다.
 * Phase 1: EVMAdapter (Ethereum/Polygon)
 * Phase 2+: XRPLAdapter, UTXOAdapter, BFTAdapter 교체·추가 가능.
 * 상위 레이어(event-engine, issuer-service)는 체인을 모른다.
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
  eventName:   string;
  contractAddr: string;
  txHash:      string;
  blockNumber: number;
  logIndex:    number;
  args:        Record<string, unknown>;
  raw:         unknown;
}

export interface ContractCallParams {
  contractAddr: string;
  abi:          unknown[];
  method:       string;
  args:         unknown[];
  signerKey?:   string;   // 없으면 read-only
}

export interface IChainAdapter {
  readonly chainId: string;
  readonly chainType: 'EVM' | 'XRPL' | 'UTXO' | 'BFT';

  /**
   * 네트워크 연결 상태 확인
   * DMZ 내부에서 노드까지 접근 가능한지 health check
   */
  isConnected(): Promise<boolean>;

  /**
   * 현재 블록 높이
   * 이벤트 리스너가 재시작 시 어디서부터 스캔할지 결정에 사용
   */
  getBlockNumber(): Promise<number>;

  /**
   * 컨트랙트 메서드 호출 (read)
   */
  call(params: ContractCallParams): Promise<unknown>;

  /**
   * 트랜잭션 전송 (write)
   * 서명은 어댑터 내부에서 처리 — 상위 레이어에 private key 노출 없음
   */
  sendTransaction(params: ContractCallParams): Promise<TransactionReceipt>;

  /**
   * 트랜잭션 상태 조회
   */
  getReceipt(txHash: string): Promise<TransactionReceipt | null>;

  /**
   * 이벤트 구독 (실시간)
   * ChainEventListener가 이 메서드를 통해 이벤트를 수신한다
   */
  subscribeEvents(
    contractAddr: string,
    abi: unknown[],
    eventNames: string[],
    fromBlock: number,
    handler: (event: ChainEvent) => Promise<void>,
  ): Promise<() => void>;  // 반환값: unsubscribe 함수

  /**
   * 과거 이벤트 조회 (재시작 시 missed event 복구)
   */
  queryEvents(
    contractAddr: string,
    abi: unknown[],
    eventName: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<ChainEvent[]>;
}
