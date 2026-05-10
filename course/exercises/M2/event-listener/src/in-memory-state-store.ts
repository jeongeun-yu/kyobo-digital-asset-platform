// S6 실습용 인메모리 stateStore
// 운영 환경에서는 DB 기반 구현체로 교체

export class InMemoryStateStore {
  private lastBlock: number;

  constructor(initialBlock: number = 0) {
    this.lastBlock = initialBlock;
  }

  async getLastProcessedBlock(): Promise<number> {
    console.log(`[StateStore] getLastProcessedBlock → ${this.lastBlock}`);
    return this.lastBlock;
  }

  async setLastProcessedBlock(block: number): Promise<void> {
    this.lastBlock = block;
    console.log(`[StateStore] setLastProcessedBlock → ${block}`);
  }
}
