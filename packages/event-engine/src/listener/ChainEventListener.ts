import type { IChainAdapter } from '@kyobo/chain-adapters';
import type { IEventHandler } from '../interfaces/IEventHandler';

/**
 * ChainEventListener — 온체인 이벤트 구독 및 핸들러 디스패치
 *
 * 동작 방식:
 *   1. 시작 시 DB의 마지막 처리 블록 조회
 *   2. queryEvents()로 missed event 먼저 처리 (재시작 안전성)
 *   3. subscribeEvents()로 실시간 구독 시작
 *   4. 이벤트 수신 → 핸들러 디스패치 → 처리 블록 DB 업데이트
 *
 * 체인 어댑터를 교체해도 이 클래스는 변경 없음 (IChainAdapter 의존).
 */
export class ChainEventListener {
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly adapter:   IChainAdapter,
    private readonly handlers:  IEventHandler[],
    private readonly contracts: Array<{
      addr:       string;
      abi:        unknown[];
      eventNames: string[];
    }>,
    private readonly stateStore: {
      getLastProcessedBlock(): Promise<number>;
      setLastProcessedBlock(block: number): Promise<void>;
    },
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

  private async _dispatch(event: { eventName: string; contractAddr: string; [key: string]: unknown }): Promise<void> {
    const matched = this.handlers.filter(
      h => h.eventName === event.eventName &&
           (!h.contractAddr || h.contractAddr === event.contractAddr),
    );
    await Promise.all(matched.map(h => h.handle(event as never)));
  }
}
