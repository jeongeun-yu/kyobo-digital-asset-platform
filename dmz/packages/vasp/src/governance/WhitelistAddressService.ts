/**
 * WhitelistAddressService — 출금 주소 화이트리스트 관리 (Phase 3: 직접 Custody 전환 시 활성화)
 *
 * ─ 왜 화이트리스트가 필요한가 ─
 *   내부자가 악의적 주소로 즉시 출금하는 것을 막기 위해,
 *   출금 가능한 주소를 사전 등록하고 일정 대기 기간 후 활성화한다.
 *   대기 기간(48h) 동안 비정상 등록을 감지·취소할 수 있다.
 *
 * ─ 상태 전이 ─
 *   REGISTERED
 *     → APPROVAL_PENDING  (내부 결재 요청)
 *     → HOLDING           (결재 완료, 48시간 대기 — 이 기간 동안 출금 불가)
 *     → ACTIVE            (48시간 경과 후 출금 허용)
 *     → REJECTED          (결재 거부)
 *     → REVOKED           (활성 주소 취소 — 즉시 출금 불가)
 *
 * ─ 보안 원칙 ─
 *   - HOLDING → ACTIVE 전이는 자동 (타이머) — 사람이 바이패스 불가
 *   - REVOKED는 ACTIVE에서만 가능 (즉시 출금 차단)
 *   - 모든 전이를 AuditLogService에 기록
 *
 * Phase 1 현황:
 *   VASP(월렛원)가 주소 화이트리스트를 직접 관리.
 *   IssuerService는 VASP가 승인한 주소로만 발행.
 *   교보 독립 화이트리스트 불필요.
 *
 * Phase 3 필요성:
 *   교보 자체 VASP 인가 시 출금 주소 통제를 직접 구현해야 함.
 *   금융감독원 가상자산 내부통제 요건: 자금 이동 전 주소 검증 필수.
 *
 * Custody Track Session 2 참조: 화이트리스트 주소 상태머신
 */

// ── 상태 ─────────────────────────────────────────────────────────────────────

export type WhitelistStatus =
  | 'REGISTERED'        // 등록 요청 접수
  | 'APPROVAL_PENDING'  // 내부 결재 대기
  | 'HOLDING'           // 결재 완료, 48시간 대기
  | 'ACTIVE'            // 출금 허용
  | 'REJECTED'          // 결재 거부
  | 'REVOKED';          // 활성 주소 취소

// ── 모델 ─────────────────────────────────────────────────────────────────────

export interface WhitelistEntry {
  id:          string;
  address:     string;   // 출금 대상 주소 (0x...)
  chainId:     string;
  userId:      string;   // 소유자
  label:       string;   // 별칭 (예: "개인 콜드월렛")
  status:      WhitelistStatus;
  holdingUntil?: Date;   // HOLDING 상태 종료 시각 (48h 후)
  registeredAt: Date;
  updatedAt:   Date;
}

// ── 유효 전이 ─────────────────────────────────────────────────────────────────

export const WHITELIST_VALID_TRANSITIONS: Record<WhitelistStatus, WhitelistStatus[]> = {
  REGISTERED:       ['APPROVAL_PENDING', 'REJECTED'],
  APPROVAL_PENDING: ['HOLDING',          'REJECTED'],
  HOLDING:          ['ACTIVE',           'REVOKED'],   // ACTIVE 전이는 타이머 자동
  ACTIVE:           ['REVOKED'],
  REJECTED:         [],  // 종단
  REVOKED:          [],  // 종단
};

// ── WhitelistAddressService ───────────────────────────────────────────────────

export class WhitelistAddressService {
  /**
   * Phase 3: 출금 주소 등록 요청
   */
  async register(
    _userId: string,
    _address: string,
    _chainId: string,
    _label: string,
  ): Promise<WhitelistEntry> {
    throw new Error('Phase 3 — WhitelistAddressService.register 구현 필요');
  }

  /**
   * Phase 3: 주소 활성 여부 확인
   *   ACTIVE 상태 + holdingUntil < now 확인
   */
  async isActive(_address: string, _chainId: string): Promise<boolean> {
    throw new Error('Phase 3 — WhitelistAddressService.isActive 구현 필요');
  }

  /**
   * Phase 3: HOLDING → ACTIVE 전이 배치
   *   holdingUntil < now인 HOLDING 상태 일괄 ACTIVE 전이
   *   크론: 1시간 간격
   */
  async activateMatured(): Promise<{ activated: number }> {
    throw new Error('Phase 3 — WhitelistAddressService.activateMatured 구현 필요');
  }

  /**
   * Phase 3: ACTIVE → REVOKED 즉시 취소
   */
  async revoke(_entryId: string, _reason: string): Promise<void> {
    throw new Error('Phase 3 — WhitelistAddressService.revoke 구현 필요');
  }
}
