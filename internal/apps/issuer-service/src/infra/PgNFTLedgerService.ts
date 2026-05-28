/**
 * PgNFTLedgerService — NFTIssuedProcessor용 PostgreSQL 원장 구현체
 *
 * NFT_ISSUED 이벤트 수신 시 user_nft_holdings 테이블에 보유 현황을 기록한다.
 * wallet_addr → user_id 매핑은 user_wallet_mapping 테이블을 참조한다.
 *
 * 참고: user_nft_holdings의 영구 금융 원장은 Java internal-ledger가 관리한다.
 * 이 구현체는 Node.js issuer-service 측의 운영 추적 목적으로 upsert한다.
 */

import type { Pool } from 'pg';
import type { NFTLedgerService } from '@kyobo/event-engine';
import type { TxStateMachineService, TxRepository } from '../../../../packages/vasp/src/tx/TxStateMachineService';

export class PgNFTLedgerService implements NFTLedgerService {
  constructor(
    private readonly pool:            Pool,
    private readonly contractAddr:    string,
    private readonly chainId:         number,
    private readonly txStateMachine?: TxStateMachineService,
    private readonly txRepo?:         TxRepository,
  ) {}

  async creditNFT(
    walletAddr: string,
    tokenId:    string,
    amount      = 1,
    txHash      = '',
  ): Promise<void> {
    const userId = await this._resolveUserId(walletAddr);
    if (!userId) {
      console.warn(`[PgNFTLedger] wallet_addr 매핑 없음 — 건너뜀 (wallet=${walletAddr})`);
      return;
    }

    await this.pool.query(
      `INSERT INTO user_nft_holdings
         (user_id, token_id, contract_addr, chain_id, amount, acquired_at, on_chain_tx)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)
       ON CONFLICT (user_id, token_id, contract_addr, chain_id)
       DO UPDATE SET amount = user_nft_holdings.amount + EXCLUDED.amount,
                     on_chain_tx = EXCLUDED.on_chain_tx`,
      [userId, BigInt(tokenId), this.contractAddr, this.chainId, amount, txHash],
    );
    console.log(`[PgNFTLedger] user_nft_holdings 기록 완료  userId=${userId}  tokenId=${tokenId}  amount=${amount}  tx=${txHash.slice(0, 10)}…`);
  }

  async getNFTBalance(walletAddr: string, tokenId: string): Promise<number> {
    const userId = await this._resolveUserId(walletAddr);
    if (!userId) return 0;

    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS balance
       FROM user_nft_holdings
       WHERE user_id = $1 AND token_id = $2 AND contract_addr = $3 AND chain_id = $4`,
      [userId, BigInt(tokenId), this.contractAddr, this.chainId],
    );
    return Number(rows[0]?.['balance'] ?? 0);
  }

  async updateMintRequestConfirmed(requestId: string, blockNumber?: number): Promise<void> {
    if (!this.txStateMachine || !this.txRepo) return;
    const req = await this.txRepo.findById(requestId);
    if (!req || req.status === 'CONFIRMED' || req.status === 'FINALIZED' || req.status === 'FAILED') return;
    if (req.status === 'SUBMITTED' || req.status === 'PENDING') {
      await this.txStateMachine.handleMined(requestId, blockNumber ?? 0);
    }
    await this.txStateMachine.handleConfirmed(requestId);
  }

  private async _resolveUserId(walletAddr: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      'SELECT user_id FROM user_wallet_mapping WHERE wallet_addr = $1 LIMIT 1',
      [walletAddr],
    );
    return (rows[0]?.['user_id'] as string) ?? null;
  }
}
