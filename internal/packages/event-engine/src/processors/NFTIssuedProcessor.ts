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
 *   인터페이스 — 구현체는 주입으로 결정.
 *   프로덕션·통합 테스트: PgNFTLedgerService / 유닛 테스트: InMemoryLedgerService
 */

import { type EventProcessor, type StreamMessage, DeferredProcessingError } from '../stream/ConsumerGroupWorker';
import { IdempotencyGuard } from '../webhook/IdempotencyGuard';
import { EventType } from '../EventTypes';
import { logger } from '../infra/logger';

// ── LedgerService 인터페이스 ─────────────────────────────────────────────────

export interface NFTLedgerService {
  creditNFT(owner: string, tokenId: string, amount?: number, txHash?: string): Promise<void>;
  getNFTBalance(owner: string, tokenId: string): Promise<number>;
  updateMintRequestConfirmed?(requestId: string, blockNumber?: number): Promise<void>;
}

export interface FinalizedBlockProvider {
  getFinalizedBlockNumber(): Promise<number>;
}

// ── NFTIssuedProcessor ───────────────────────────────────────────────────────

export class NFTIssuedProcessor implements EventProcessor {
  readonly eventTypes = [EventType.NFT_ISSUED];

  constructor(
    private readonly idempotency:             IdempotencyGuard,
    private readonly ledger:                  NFTLedgerService,
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
      // TX 상태 전이(MINED→CONFIRMED) → IssuanceTransitionBridge가 ISSUANCE_CONFIRMED 기록
      // 이후 creditNFT → NFT_ACQUIRED 순서
      await this.ledger.updateMintRequestConfirmed?.(requestId, payload.blockNumber);
      console.log(`[NFTIssuedProcessor] creditNFT 호출 → owner=${payload.to?.slice(0, 10)}…  tokenId=${payload.tokenId}`);
      await this.ledger.creditNFT(payload.to, payload.tokenId, 1, txHash);
      console.log(`[NFTIssuedProcessor] creditNFT 완료 → user_nft_holdings 기록`);
    });

    if (!processed) {
      logger.info('duplicate NFT event skipped', { idempotencyKey });
    }
  }
}

// ── InMemoryLedgerService ────────────────────────────────────────────────────
// 개발·테스트용. 프로덕션에서는 PostgreSQL 구현체로 교체.

export class InMemoryLedgerService implements NFTLedgerService {
  readonly holdings = new Map<string, number>();

  async creditNFT(owner: string, tokenId: string, amount = 1): Promise<void> {
    const key = `${owner}:${tokenId}`;
    this.holdings.set(key, (this.holdings.get(key) ?? 0) + amount);
  }

  async getNFTBalance(owner: string, tokenId: string): Promise<number> {
    return this.holdings.get(`${owner}:${tokenId}`) ?? 0;
  }
}
