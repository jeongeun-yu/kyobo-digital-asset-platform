/**
 * NFTIssuedProcessor — NFT 발행 이벤트 소비자 처리기
 *
 * M2 S12 핵심 구현:
 *   ConsumerGroupWorker가 kyobo:events 스트림에서 꺼낸 NFT_ISSUED 메시지를
 *   Finalized 체크 → 멱등성 확인 → 원장 업데이트 순서로 처리.
 *
 * 처리 순서 (At-least-once 불변 규칙):
 *   1. Finalized 체크 — 미확정 블록이면 XACK 없이 return → PEL 잔류 → 재처리
 *   2. IdempotencyGuard.run() — requestId 중복이면 스킵 + XACK (Worker가 처리)
 *   3. LedgerService.creditNFT() — 원장 업데이트
 *   (XACK는 ConsumerGroupWorker._handleWithRetry() 에서 처리 — 이 클래스는 호출하지 않음)
 *
 * LedgerService:
 *   M2에서는 InMemoryLedgerService (실습·테스트용).
 *   M4에서 PostgreSQL + Knex 구현체로 교체 예정.
 */

import { type EventProcessor, type StreamMessage, DeferredProcessingError } from '../stream/ConsumerGroupWorker';
import { IdempotencyGuard } from '../webhook/IdempotencyGuard';
import { EventType } from '../EventTypes';
import { logger } from '../infra/logger';

// ── LedgerService 인터페이스 ─────────────────────────────────────────────────
// M4에서 구현체 추가. 이 파일에서는 인터페이스만 정의.

export interface LedgerService {
  creditNFT(owner: string, tokenId: string, amount?: number): Promise<void>;
  getNFTBalance(owner: string, tokenId: string): Promise<number>;
}

export interface FinalizedBlockProvider {
  getFinalizedBlockNumber(): Promise<number>;
}

// ── NFTIssuedProcessor ───────────────────────────────────────────────────────

export class NFTIssuedProcessor implements EventProcessor {
  readonly eventTypes = [EventType.NFT_ISSUED];

  constructor(
    private readonly idempotency:             IdempotencyGuard,
    private readonly ledger:                  LedgerService,
    private readonly finalizedBlockProvider?: FinalizedBlockProvider,
  ) {}

  async process(message: StreamMessage): Promise<void> {
    const payload = JSON.parse(message.fields['payload'] ?? '{}') as {
      tokenId:     string;
      to:          string;
      blockNumber?: number;
    };
    const requestId = message.fields['requestId'] ?? message.id;

    // ── Step 1: Finalized 체크 ─────────────────────────────────────────────
    // blockNumber가 현재 Finalized 블록보다 높으면 처리 보류.
    // XACK 없이 return → PEL 잔류 → _reclaimPending() 에서 Finalized 이후 재처리.
    if (this.finalizedBlockProvider && payload.blockNumber != null) {
      const finalized = await this.finalizedBlockProvider.getFinalizedBlockNumber();
      if (payload.blockNumber > finalized) {
        logger.info('block not yet finalized, deferring', { blockNumber: payload.blockNumber, finalized });
        throw new DeferredProcessingError(`block ${payload.blockNumber} not yet finalized (current: ${finalized})`);
      }
    }

    // ── Step 2 + 3: 멱등성 확인 → 원장 업데이트 ───────────────────────────
    const idempotencyKey = `NFTIssued:${requestId}`;

    const processed = await this.idempotency.run(idempotencyKey, async () => {
      await this.ledger.creditNFT(payload.to, payload.tokenId);
    });

    if (!processed) {
      logger.info('duplicate NFT event skipped', { idempotencyKey });
    }
  }
}

// ── InMemoryLedgerService ────────────────────────────────────────────────────
// M2 실습·테스트용. M4에서 PostgreSQL 구현체로 교체.

export class InMemoryLedgerService implements LedgerService {
  readonly holdings = new Map<string, number>();

  async creditNFT(owner: string, tokenId: string, amount = 1): Promise<void> {
    const key = `${owner}:${tokenId}`;
    this.holdings.set(key, (this.holdings.get(key) ?? 0) + amount);
  }

  async getNFTBalance(owner: string, tokenId: string): Promise<number> {
    return this.holdings.get(`${owner}:${tokenId}`) ?? 0;
  }
}
