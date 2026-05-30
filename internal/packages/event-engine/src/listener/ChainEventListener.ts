import type { IBlockchainAdapter, ChainEvent } from '@kyobo/chain-adapters';
import type { IEventHandler } from '../interfaces/IEventHandler';

/**
 * ReorgWatcher — 체인 재조직 감지 콜백 인터페이스
 *
 * ChainEventListener가 MINED/CONFIRMED TX를 주기적으로 조회해
 * getReceipt()가 null을 반환하면 reorg로 판단하고 onReorg()를 호출한다.
 *
 * 구현체: issuer-service의 IssuanceReorgHandler
 */
export interface ReorgWatcher {
  /** 현재 감시할 TX 목록 — MINED·CONFIRMED 상태 */
  getWatchedTxHashes(): Promise<Array<{ txHash: string; requestId: string }>>;
  /** reorg 확인된 requestId에 대한 처리 위임 */
  onReorg(requestId: string): Promise<void>;
}

/**
 * ChainEventListener — 온체인 이벤트 구독 → 이벤트 파이프라인 입구
 *
 * 동작 방식:
 *   1. 시작 시 DB의 마지막 처리 블록 조회
 *   2. queryEvents()로 missed event 먼저 처리 (재시작 안전성)
 *   3. subscribeEvents()로 실시간 구독 시작
 *   4. 이벤트 수신 → _dispatch() → 매칭 IEventHandler.handle() Promise.all 병렬 호출
 *      (RedisStreamPublisher 미사용 — 핸들러가 직접 상태 전이 처리)
 *
 * IBlockchainAdapter 의존 — 체인 교체 시 이 클래스 변경 없음 (DIP).
 *
 * 이벤트 파이프라인:
 *   ChainEventListener → _dispatch() → IEventHandler (IssuanceConfirmHandler 등)
 *                                                    → TxStateMachineService
 *                                                    → TxTransitionBridge → LedgerService
 *                                                                         → issuance_requests
 */
export class ChainEventListener {
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly adapter:      IBlockchainAdapter,
    private readonly handlers:     IEventHandler[],
    private readonly contracts:    Array<{
      addr:       string;
      abi:        unknown[];
      eventNames: string[];
    }>,
    private readonly stateStore: {
      getLastProcessedBlock(): Promise<number>;
      setLastProcessedBlock(block: number): Promise<void>;
    },
    private readonly reorgWatcher?: ReorgWatcher,
    private readonly reorgPollMs:   number = 5_000,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const fromBlock  = await this.stateStore.getLastProcessedBlock();
    const curBlock   = await this.adapter.getBlockNumber();

    // 재시작 시 missed event 복구
    if (fromBlock < curBlock) {
      await this._recoverMissedEvents(fromBlock, curBlock);
    }

    // 실시간 구독
    for (const contract of this.contracts) {
      const unsub = await this.adapter.subscribeEvents(
        contract.addr,
        contract.abi,
        contract.eventNames,
        curBlock,
        async (event) => {
          await this._dispatch(event);
          await this.stateStore.setLastProcessedBlock(event.blockNumber);
        },
      );
      this.unsubscribers.push(unsub);
    }

    // REORG 감지 폴링 (ReorgWatcher 주입 시에만)
    if (this.reorgWatcher) {
      this._pollReorg();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.unsubscribers.forEach(unsub => unsub());
    this.unsubscribers = [];
  }

  private async _recoverMissedEvents(from: number, to: number): Promise<void> {
    const CHUNK = 1000;  // 블록 청크 — RPC 과부하 방지
    for (const contract of this.contracts) {
      for (const eventName of contract.eventNames) {
        let start = from;
        while (start < to) {
          const end    = Math.min(start + CHUNK, to);
          const events = await this.adapter.queryEvents(
            contract.addr, contract.abi, eventName, start, end,
          );
          for (const event of events) {
            await this._dispatch(event);
          }
          await this.stateStore.setLastProcessedBlock(end);
          start = end + 1;
        }
      }
    }
  }

  private async _pollReorg(): Promise<void> {
    while (this.running) {
      try {
        const watched = await this.reorgWatcher!.getWatchedTxHashes();
        for (const { txHash, requestId } of watched) {
          const receipt = await this.adapter.getReceipt(txHash);
          if (receipt === null) {
            console.log(`[ChainEventListener] reorg detected: txHash=${txHash.slice(0, 10)}…  requestId=${requestId.slice(0, 8)}…`);
            await this.reorgWatcher!.onReorg(requestId);
          }
        }
      } catch (err) {
        // 폴링 오류는 루프 유지 — 다음 주기에 재시도
      }
      await new Promise(r => setTimeout(r, this.reorgPollMs));
    }
  }

  private async _dispatch(event: ChainEvent): Promise<void> {
    const matched = this.handlers.filter(
      h => h.eventName === event.eventName &&
           (!h.contractAddr || h.contractAddr === event.contractAddr),
    );
    await Promise.all(matched.map(h => h.handle(event)));
  }
}
