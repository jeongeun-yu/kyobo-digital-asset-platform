/**
 * WalletProvisioningService — VASP별 지갑 프로비저닝 분기 처리
 *
 * M5 S27 핵심 개념:
 *
 * 단일 진입점 설계:
 *   POST /api/wallet/provision 하나로 VASP 종류와 무관하게 처리.
 *   VASP 타입별 내부 분기 → 상위 레이어(컨트롤러)는 VASP 구현 세부사항 모름.
 *
 * VASP별 분기:
 *   EXTERNAL VASP: ExternalVASPAdapter.getWalletAddr(userId)
 *     → 외부 Custody API가 지갑 관리. 서버는 조회만 함.
 *   KYOBO VASP: 내부 Custody API 직접 호출
 *     → Phase 4 내재화 이후. 지갑 직접 생성 + DB 저장.
 *
 * WalletMappingService 연계:
 *   provision() 성공 후 walletMapping.save()로 매핑 저장.
 *   이후 getWalletAddress()는 WalletMappingService에서 조회.
 *
 * 의존 방향:
 *   WalletProvisioningService → ExternalVASPAdapter (지갑 조회)
 *                             → WalletMappingService (매핑 저장)
 */

import type { WalletMappingService, VaspType } from './WalletMappingService';

export class UnsupportedVaspError extends Error {
  constructor(vaspType: string) {
    super(`지원하지 않는 VASP 타입: ${vaspType}`);
    this.name = 'UnsupportedVaspError';
  }
}

export interface ProvisionResult {
  userId:        string;
  walletAddress: string;
  vaspType:      VaspType;
  provisionedAt: Date;
}

export interface ExternalVaspClient {
  /** 외부 VASP에서 userId에 해당하는 custodial 지갑 주소 조회 */
  getWalletAddr(userId: string): Promise<string>;
  /** 교보 내부 Custody API — 지갑 신규 생성 */
  createWallet(userId: string): Promise<string>;
}

export class WalletProvisioningService {
  constructor(
    private readonly vaspClient:     ExternalVaspClient,
    private readonly walletMapping:  WalletMappingService,
  ) {}

  /**
   * VASP 타입별 지갑 프로비저닝
   *
   * @param userId   교보 내부 사용자 ID
   * @param vaspType 'EXTERNAL' | 'KYOBO'
   * @returns        지갑 주소 + 프로비저닝 결과
   * @throws         UnsupportedVaspError — 미지원 vaspType
   */
  async provision(userId: string, vaspType: VaspType): Promise<ProvisionResult> {
    // TODO (S27 실습): VASP 타입에 따라 지갑 주소 획득 경로 분기
    //   EXTERNAL → this.vaspClient.getWalletAddr(userId)
    //   KYOBO    → this.vaspClient.createWallet(userId)
    //   기타     → throw new UnsupportedVaspError(vaspType)
    //
    // 획득한 walletAddress를 walletMapping.saveMapping(userId, walletAddress, vaspType)으로 저장
    // ProvisionResult 반환

    throw new Error('TODO: implement provision()');
  }

  /* ── 답안 ──────────────────────────────────────────────────────────────────
  async provision(userId: string, vaspType: VaspType): Promise<ProvisionResult> {
    let walletAddress: string;

    if (vaspType === 'EXTERNAL') {
      walletAddress = await this.vaspClient.getWalletAddr(userId);
    } else if (vaspType === 'KYOBO') {
      walletAddress = await this.vaspClient.createWallet(userId);
    } else {
      throw new UnsupportedVaspError(vaspType);
    }

    await this.walletMapping.saveMapping(userId, walletAddress, vaspType);

    return { userId, walletAddress, vaspType, provisionedAt: new Date() };
  }
  ────────────────────────────────────────────────────────────────────────── */
}
