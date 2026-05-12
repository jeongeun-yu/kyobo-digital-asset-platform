/**
 * WalletMappingService — 사용자 ↔ 지갑 주소 매핑 관리
 *
 * M5 S27~S29 핵심 개념:
 *
 * 설계 문제 (S28):
 *   교보생명 내부 userId와 블록체인 walletAddr는 다른 식별자 공간.
 *   VASP마다 지갑 생성 방식이 다름:
 *     - 외부 VASP (KorbitCustody, etc.): 사용자별 custodial 지갑 생성 → API 조회
 *     - 교보 자체 VASP (Phase 4): 내부 HSM/MPC 키 생성 → DB 직접 관리
 *
 * 지갑 소유권 증명 (S29):
 *   EIP-191 서명 검증 — 사용자가 private key 보유 증명
 *   메시지: "Kyobo Digital Asset Wallet: {userId}:{nonce}"
 *   서명 → ecrecover → 복원 주소 == walletAddr 이면 소유 증명
 *   (교보 custodial 지갑은 이 단계 불필요 — VASP가 보관)
 *
 * VASP별 분기 (S27):
 *   VaspType.EXTERNAL → ExternalVASPAdapter.getWalletAddr(userId)
 *   VaspType.KYOBO    → DB 직접 조회 (Phase 4 내재화 후)
 *
 * ── 교육생 안내 ──────────────────────────────────────────────────────────────
 * 역할: 참고용 구현체 — 수정하지 말 것
 * 관련 모듈: M5 S27~S29 (지갑 프로비저닝 · 매핑 설계 · EIP-191 서명)
 */

import { createHash } from 'crypto';

// ── 타입 ──────────────────────────────────────────────────────────────────

export type VaspType = 'EXTERNAL' | 'KYOBO';

export interface WalletMapping {
  userId:     string;
  walletAddr: string;
  vaspType:   VaspType;
  verified:   boolean;          // EIP-191 소유권 증명 완료 여부
  createdAt:  Date;
}

// ── 의존 인터페이스 ────────────────────────────────────────────────────────

export interface WalletMappingRepository {
  findByUserId(userId: string): Promise<WalletMapping | null>;
  save(mapping: WalletMapping): Promise<void>;
  findByWalletAddr(walletAddr: string): Promise<WalletMapping | null>;
}

export interface ExternalVaspWalletClient {
  /** 외부 VASP API — 사용자 custodial 지갑 주소 조회 또는 생성 */
  provisionWallet(userId: string): Promise<{ walletAddr: string }>;
}

export interface SignatureVerifier {
  /** EIP-191 서명 검증 — ecrecover */
  recoverAddress(message: string, signature: string): Promise<string>;
}

// ── 서비스 ────────────────────────────────────────────────────────────────

/**
 * WalletMappingService
 *
 * M5 S28 핵심 학습:
 *   userId는 교보 내부 식별자, walletAddr는 블록체인 식별자.
 *   둘의 매핑 테이블이 없으면 NFT 발행 대상을 특정할 수 없음.
 *   VASP 교체 시 이 레이어만 변경 → 비즈니스 로직 무변경.
 */
export class WalletMappingService {
  constructor(
    private readonly repo:            WalletMappingRepository,
    private readonly externalVasp:    ExternalVaspWalletClient,
    private readonly sigVerifier:     SignatureVerifier,
  ) {}

  /**
   * userId → walletAddr 조회
   *
   * M5 S27 실습: VASP별 분기
   *   1. DB 조회 (캐시 역할)
   *   2. 없으면 VASP 타입에 따라 프로비저닝:
   *      EXTERNAL → externalVasp.provisionWallet(userId)
   *      KYOBO    → throw (Phase 4 미구현)
   *   3. DB 저장 + 반환
   */
  async getWalletAddr(userId: string): Promise<string> {
    const existing = await this.repo.findByUserId(userId);
    if (existing) return existing.walletAddr;

    const { walletAddr } = await this.externalVasp.provisionWallet(userId);
    await this.repo.save({
      userId,
      walletAddr,
      vaspType:  'EXTERNAL',
      verified:  false,
      createdAt: new Date(),
    });
    return walletAddr;
  }

  /**
   * 지갑 소유권 증명 — EIP-191 서명 검증
   *
   * M5 S29 실습:
   *   1. nonce 생성 (재생 공격 방지)
   *   2. 메시지 = "Kyobo Digital Asset Wallet: {userId}:{nonce}"
   *   3. sigVerifier.recoverAddress(message, signature) → 복원 주소
   *   4. 복원 주소 == walletAddr → 소유 증명 완료
   *   5. DB UPDATE verified = true
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

    await this.repo.save({
      userId,
      walletAddr,
      vaspType:  'EXTERNAL',
      verified:  true,
      createdAt: new Date(),
    });
    return true;
  }

  /**
   * 서명 검증용 nonce 생성
   * 재생 공격 방지: userId + 현재 시각 해시
   */
  generateNonce(userId: string): string {
    const raw = `${userId}:${Date.now()}:${Math.random()}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  async getMapping(userId: string): Promise<WalletMapping | null> {
    return this.repo.findByUserId(userId);
  }
}

export class WalletNotFoundError extends Error {
  constructor(userId: string) {
    super(`Wallet not found for user: ${userId}`);
    this.name = 'WalletNotFoundError';
  }
}
