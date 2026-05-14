/**
 * ConsumerGroupPool — 이벤트 타입별 Consumer Group 분리 관리
 *
 * 동기:
 *   단일 Consumer Group에 모든 Processor를 등록하면 특정 이벤트 도메인이
 *   밀릴 때 전체 처리가 지연된다. 도메인별로 Consumer Group을 분리하면
 *   PEL·재시도·DLQ 큐가 독립되어 격리된다.
 *
 * 사용 예:
 *   const pool = new ConsumerGroupPool(redis, dlq, {
 *     streamKey: 'kyobo:events',
 *     batchSize: 10,
 *     blockMs:   1000,
 *     minIdleMs: 30_000,
 *   }, [
 *     { groupName: 'nft-consumers',      consumerId: 'nft-1',      processors: [nftIssuedProcessor] },
 *     { groupName: 'activity-consumers', consumerId: 'activity-1', processors: [activityProcessor] },
 *     { groupName: 'coupon-consumers',   consumerId: 'coupon-1',   processors: [couponProcessor]   },
 *   ]);
 *
 *   await pool.start();   // 그룹별 Worker 동시 기동
 *   pool.stop();          // 전체 정지
 *
 * 주의:
 *   각 Worker는 스트림의 모든 메시지를 수신하지만,
 *   eventType이 일치하지 않는 메시지는 즉시 XACK 처리된다.
 *   (ConsumerGroupWorker._handleWithRetry() processors.length === 0 분기)
 */

import { ConsumerGroupWorker, type WorkerConfig, type RedisConsumerClient, type EventProcessor } from './ConsumerGroupWorker';
import type { DLQHandler } from './DLQHandler';
import { logger } from '../infra/logger';

export interface WorkerGroupConfig {
  groupName:  string;
  consumerId: string;
  processors: EventProcessor[];
}

type SharedConfig = Omit<WorkerConfig, 'groupName' | 'consumerId'>;

export class ConsumerGroupPool {
  private readonly workers: ConsumerGroupWorker[];

  constructor(
    redis:        RedisConsumerClient,
    dlq:          DLQHandler,
    sharedConfig: SharedConfig,
    groups:       WorkerGroupConfig[],
  ) {
    this.workers = groups.map(g =>
      new ConsumerGroupWorker(redis, g.processors, dlq, {
        ...sharedConfig,
        groupName:  g.groupName,
        consumerId: g.consumerId,
      }),
    );

    logger.info('ConsumerGroupPool initialized', {
      groups: groups.map(g => ({
        groupName:  g.groupName,
        consumerId: g.consumerId,
        eventTypes: g.processors.flatMap(p => p.eventTypes),
      })),
    });
  }

  async start(): Promise<void> {
    logger.info('ConsumerGroupPool starting', { workerCount: this.workers.length });
    await Promise.all(this.workers.map(w => w.start()));
  }

  stop(): void {
    for (const w of this.workers) {
      w.stop();
    }
    logger.info('ConsumerGroupPool stopped');
  }
}
