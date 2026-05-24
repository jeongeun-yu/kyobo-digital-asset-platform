/**
 * NFTIssuedProcessor — NFT 발행 이벤트 소비자 처리기
 *
 * 처리 순서 (At-least-once 불변 규칙):
 *   1. Finalized 체크 — 미확정 블록이면 XACK 없이 return → PEL 잔류 → 재처리
 *   2. IdempotencyGuard.run() — requestId 중복이면 스킵 + XACK (Worker가 처리)
 *   3. LedgerService.creditNFT() — 원장 업데이트
 *   (XACK는 ConsumerGroupWorker._handleWithRetry() 에서 처리 — 이 클래스는 호출하지 않음)
 *
 * LedgerService:
 *   현재 InMemoryLedgerService (개발·테스트용).
 *   프로덕션에서는 PostgreSQL + Knex 구현체로 교체.
 */

import { type EventProcessor, type StreamMessage, DeferredProcessingError } from '../stream/ConsumerGroupWorker';
import { IdempotencyGuard } from '../webhook/IdempotencyGuard';
import { EventType } from '../EventTypes';
import { logger } from '../infra/logger';

// ── LedgerService 인터페이스 ─────────────────────────────────────────────────

export interface LedgerService {
  creditNFT(owner: string, tokenId: string, amount?: number, txHash?: string): Promise<void>;
  getNFTBalance(owner: string, tokenId: string): Promise<number>;
  updateMintRequestConfirmed?(requestId: string): Promise<void>;
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
    const txHash = message.fields['txHash'];

    console.log(`[NFTIssuedProcessor] NFT_ISSUED 수신  to=${payload.to?.slice(0, 10)}…  tokenId=${payload.tokenId}  txHash=${txHash?.slice(0, 10)}…  msgId=${message.id}`);

    const processed = await this.idempotency.run(idempotencyKey, async () => {
      console.log(`[NFTIssuedProcessor] creditNFT 호출 → owner=${payload.to?.slice(0, 10)}…  tokenId=${payload.tokenId}`);
      await this.ledger.creditNFT(payload.to, payload.tokenId, 1, txHash);
      console.log(`[NFTIssuedProcessor] creditNFT 완료 → user_nft_holdings 기록`);

      // TODO: Java 영구 원장 반영 완료 후 mint_request 상태를 CONFIRMED로 전이
      // 설계: CONFIRMED = "내부 원장 반영 완료" (온체인 확인과 별개)
      // 구현 시 아래 호출 추가:
      //   await this.ledger.updateMintRequestConfirmed?.(requestId);
    });

    if (!processed) {
      logger.info('duplicate NFT event skipped', { idempotencyKey });
    }
  }
}

// ── InMemoryLedgerService ────────────────────────────────────────────────────
// 개발·테스트용. 프로덕션에서는 PostgreSQL 구현체로 교체.

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
