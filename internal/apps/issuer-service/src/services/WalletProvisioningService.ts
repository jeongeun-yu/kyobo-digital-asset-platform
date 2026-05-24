/**
 * WalletProvisioningService — VASP별 지갑 프로비저닝 분기 처리
 *
 * 단일 진입점 설계:
 *   POST /api/wallet/provision 하나로 VASP 종류와 무관하게 처리.
 *   VASP 타입별 내부 분기 → 상위 레이어(컨트롤러)는 VASP 구현 세부사항 모름.
 *
 * VASP별 분기:
 *   EXTERNAL VASP: ExternalVaspClient.getWalletAddr(userId)
 *     → 외부 Custody API에서 기존 custodial 지갑 조회. 서버는 결과를 저장.
 *   KYOBO VASP: ExternalVaspClient.createWallet(userId)
 *     → 내부 HSM/MPC로 신규 지갑 생성 (Phase 4)
 *
 * WalletMappingService 연계:
 *   provision() 멱등성 체크 → getMapping() 조회
 *   VASP 성공 후 → saveMapping() 저장
 *   이후 getWalletAddr()는 WalletMappingService에서 조회.
 *
 * 의존 방향:
 *   WalletProvisioningService → ExternalVaspClient (지갑 획득)
 *                             → WalletMappingService (매핑 조회·저장)
 *                             → AuditLogAdapter? (감사 로그, 선택적)
 */

import type { WalletMappingService, VaspType } from './WalletMappingService';

// ── 에러 ──────────────────────────────────────────────────────────────────────

export class UnsupportedVaspError extends Error {
  constructor(vaspType: string) {
    super(`미지원 VASP 타입: ${vaspType}`);
    this.name = 'UnsupportedVaspError';
  }
}

// ── 인터페이스 ────────────────────────────────────────────────────────────────

export interface ProvisionResult {
  userId:        string;
  walletAddress: string;
  vaspType:      VaspType;
  provisionedAt: Date;
}

export interface ExternalVaspClient {
  /** 외부 VASP에서 userId에 해당하는 custodial 지갑 조회 (EXTERNAL) */
  getWalletAddr(userId: string): Promise<string>;
  /** 내부 HSM/MPC로 신규 지갑 생성 (KYOBO — Phase 4) */
  createWallet(userId: string): Promise<string>;
}

export interface AuditLogAdapter {
  record(entry: {
    actor:        string;
    action:       string;
    resourceType: string;
    resourceId:   string;
    afterState:   Record<string, unknown>;
  }): Promise<void>;
}

// ── 서비스 ────────────────────────────────────────────────────────────────────

export class WalletProvisioningService {
  constructor(
    private readonly vaspClient:    ExternalVaspClient,
    private readonly walletMapping: WalletMappingService,
    private readonly auditLog?:     AuditLogAdapter,
  ) {}

  /**
   * VASP 타입별 지갑 프로비저닝
   *
   * ① 멱등성 체크 — 이미 매핑 있으면 즉시 반환
   * ② VASP 분기 — vaspType에 따라 지갑 획득
   * ③ 매핑 저장 — saveMapping()
   * ④ 감사 로그 기록 (auditLog 주입된 경우)
   * ⑤ 반환
   *
   * @throws UnsupportedVaspError — 미지원 vaspType
   */
  async provision(userId: string, vaspType: VaspType | string): Promise<ProvisionResult> {
    // ① 멱등성 체크
    const existing = await this.walletMapping.getMapping(userId);
    if (existing) {
      return {
        userId,
        walletAddress: existing.walletAddr,
        vaspType: existing.vaspType,
        provisionedAt: existing.createdAt,
      };
    }

    // ② VASP 분기
    let walletAddress: string;
    if (vaspType === 'EXTERNAL') {
      walletAddress = await this.vaspClient.getWalletAddr(userId);
    } else if (vaspType === 'KYOBO') {
      walletAddress = await this.vaspClient.createWallet(userId);
    } else {
      throw new UnsupportedVaspError(vaspType);
    }

    // ③ 매핑 저장 — VASP 성공 시에만 호출
    await this.walletMapping.saveMapping(userId, walletAddress, vaspType as VaspType);

    // ④ 감사 로그 (선택적 — 미주입 시 무시)
    await this.auditLog?.record({
      actor:        'system',
      action:       'WALLET_PROVISIONED',
      resourceType: 'USER',
      resourceId:   userId,
      afterState:   { walletAddress, vaspType },
    });

    // ⑤ 반환
    return { userId, walletAddress, vaspType: vaspType as VaspType, provisionedAt: new Date() };
  }
}
