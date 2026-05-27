/**
 * WalletMappingService — 사용자 ↔ 지갑 주소 매핑 관리 (1:1)
 *
 * 설계:
 *   교보생명 내부 userId와 블록체인 walletAddr는 다른 식별자 공간.
 *   Phase 1: userId당 하나의 walletAddr만 허용 (UNIQUE user_id).
 *
 * 지갑 소유권 증명:
 *   EIP-191 서명 검증 — 사용자가 private key 보유 증명
 *   메시지: "Kyobo Digital Asset Wallet: {userId}:{nonce}"
 *   서명 → ecrecover → 복원 주소 == walletAddr 이면 소유 증명
 *   (교보 custodial 지갑은 이 단계 불필요 — VASP가 보관)
 *
 * VASP별 분기:
 *   VaspType.EXTERNAL → ExternalVaspClient.getWalletAddr(userId)
 *   VaspType.KYOBO    → ExternalVaspClient.createWallet(userId) (Phase 4)
 */

import { createHash } from 'crypto';
import type { Pool }  from 'pg';

// ── 타입 ──────────────────────────────────────────────────────────────────

export type VaspType = 'EXTERNAL' | 'KYOBO';

export interface WalletMapping {
  userId:     string;
  walletAddr: string;
  vaspType:   VaspType;
  verified:   boolean;   // EIP-191 소유권 증명 완료 여부
  createdAt:  Date;
}

// ── 의존 인터페이스 ────────────────────────────────────────────────────────

export interface WalletMappingRepository {
  /** userId의 지갑 단건 조회 */
  findByUserId(userId: string): Promise<WalletMapping | null>;
  /** walletAddr로 역방향 조회 */
  findByWalletAddr(walletAddr: string): Promise<WalletMapping | null>;
  /** 지갑 추가 또는 갱신 (user_id UNIQUE upsert) */
  save(mapping: WalletMapping): Promise<void>;
}

export interface SignatureVerifier {
  /** EIP-191 서명 검증 — ecrecover */
  recoverAddress(message: string, signature: string): Promise<string>;
}

// ── 서비스 ────────────────────────────────────────────────────────────────

/**
 * WalletMappingService
 *
 * userId는 교보 내부 식별자, walletAddr는 블록체인 식별자.
 * Phase 1: userId당 하나의 지갑만 허용.
 * VASP 교체 시 이 레이어만 변경 → 비즈니스 로직 무변경.
 */
export class WalletMappingService {
  constructor(
    private readonly repo:        WalletMappingRepository,
    private readonly sigVerifier: SignatureVerifier,
  ) {}

  /**
   * userId의 지갑 주소 반환.
   * 매핑이 없으면 WalletNotFoundError, verified=false이면 WalletNotVerifiedError.
   * 지갑을 자동 생성하지 않는다 — 명시적 provision() 호출을 통해서만 생성.
   */
  async getWalletAddr(userId: string): Promise<string> {
    const mapping = await this.repo.findByUserId(userId);
    if (!mapping) throw new WalletNotFoundError(userId);
    if (!mapping.verified) throw new WalletNotVerifiedError(userId);
    return mapping.walletAddr;
  }

  /**
   * userId의 지갑 매핑 단건 반환 (멱등성 체크용).
   * 없으면 null.
   */
  async getMapping(userId: string): Promise<WalletMapping | null> {
    return this.repo.findByUserId(userId);
  }

  /**
   * VASP 프로비저닝 성공 후 매핑을 DB에 저장.
   * Phase 1: 수탁 지갑이므로 verified=true.
   */
  async saveMapping(userId: string, walletAddr: string, vaspType: VaspType): Promise<void> {
    await this.repo.save({
      userId,
      walletAddr,
      vaspType,
      verified:  true,
      createdAt: new Date(),
    });
  }

  /**
   * 지갑 소유권 증명 — EIP-191 서명 검증.
   * 성공 시 해당 지갑의 verified=true로 갱신.
   *
   * 1. 메시지 = "Kyobo Digital Asset Wallet: {userId}:{nonce}"
   * 2. sigVerifier.recoverAddress(message, signature) → 복원 주소
   * 3. 복원 주소 == walletAddr → 소유 증명 완료
   * 4. DB UPDATE verified = true
   *
   * 교보 custodial 지갑은 VASP가 private key 보관 → 이 단계 불필요
   * 자기관리형(non-custodial) 사용자 지갑 등록 시 필요
   */
  async verifyOwnership(params: {
    userId:     string;
    walletAddr: string;
    signature:  string;
    nonce:      string;
  }): Promise<boolean> {
    const { userId, walletAddr, signature, nonce } = params;

    const message   = `Kyobo Digital Asset Wallet: ${userId}:${nonce}`;
    const recovered = await this.sigVerifier.recoverAddress(message, signature);
    if (recovered.toLowerCase() !== walletAddr.toLowerCase()) return false;

    const existing = await this.repo.findByWalletAddr(walletAddr);
    await this.repo.save({
      userId,
      walletAddr,
      vaspType:  'EXTERNAL',
      verified:  true,
      createdAt: existing?.createdAt ?? new Date(),
    });
    return true;
  }

  /**
   * 서명 검증용 nonce 생성.
   * 재생 공격 방지: userId + 현재 시각 해시
   */
  generateNonce(userId: string): string {
    const raw = `${userId}:${Date.now()}:${Math.random()}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }
}

export class WalletNotFoundError extends Error {
  constructor(userId: string) {
    super(`Wallet not found for user: ${userId}`);
    this.name = 'WalletNotFoundError';
  }
}

export class WalletNotVerifiedError extends Error {
  constructor(userId: string) {
    super(`Wallet not verified for user: ${userId}. Run wallet verification first.`);
    this.name = 'WalletNotVerifiedError';
  }
}

// ── PostgreSQL 구현체 ──────────────────────────────────────────────────────

type WalletRow = {
  user_id: string; wallet_addr: string;
  vasp_type: string; verified: boolean;
  created_at: Date;
};

export class PgWalletMappingRepository implements WalletMappingRepository {
  constructor(private readonly pool: Pool) {}

  async findByUserId(userId: string): Promise<WalletMapping | null> {
    const res = await this.pool.query<WalletRow>(
      `SELECT user_id, wallet_addr, vasp_type, verified, created_at
       FROM user_wallet_mapping WHERE user_id = $1`,
      [userId],
    );
    return res.rows[0] ? this._toMapping(res.rows[0]) : null;
  }

  async findByWalletAddr(walletAddr: string): Promise<WalletMapping | null> {
    const res = await this.pool.query<WalletRow>(
      `SELECT user_id, wallet_addr, vasp_type, verified, created_at
       FROM user_wallet_mapping WHERE wallet_addr = $1`,
      [walletAddr.toLowerCase()],
    );
    return res.rows[0] ? this._toMapping(res.rows[0]) : null;
  }

  async save(mapping: WalletMapping): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET wallet_addr = EXCLUDED.wallet_addr,
             vasp_type   = EXCLUDED.vasp_type,
             verified    = EXCLUDED.verified`,
      [mapping.userId, mapping.walletAddr, mapping.vaspType, mapping.verified],
    );
  }

  private _toMapping(row: WalletRow): WalletMapping {
    return {
      userId:     row.user_id,
      walletAddr: row.wallet_addr,
      vaspType:   row.vasp_type as VaspType,
      verified:   row.verified,
      createdAt:  row.created_at,
    };
  }
}
