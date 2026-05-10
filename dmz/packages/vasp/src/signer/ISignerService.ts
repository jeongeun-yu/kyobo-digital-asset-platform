/**
 * ISignerService — 서명 서비스 추상화 인터페이스 (Phase 3: 직접 Custody 전환 시 활성화)
 *
 * ─ 서명 방식 선택 ─
 *
 * HSM (Hardware Security Module)
 *   물리적 하드웨어 장치에 키를 저장. 키가 장치를 절대 벗어나지 않음.
 *   장점: FIPS 140-2 Level 3 인증, 물리 공격 방어
 *   단점: 단일 장애점(SPOF). 장치 파손 시 키 영구 소실. 확장성 낮음.
 *   사용: 소규모 고가치 자산 (컨트랙트 업그레이드, 거버넌스 TX)
 *
 * MPC (Multi-Party Computation)
 *   키 비밀을 N개 샤드로 분산. M개 샤드가 모여야 서명 가능.
 *   장점: SPOF 없음. 지리적 분산. 한 샤드 유출로 키 복구 불가.
 *   단점: 구현 복잡. 레이턴시 높음 (네트워크 라운드트립).
 *   사용: 고처리량 일상 TX (NFT 발행, 소각)
 *
 * Phase 1 현황:
 *   VASP(월렛원)의 HSM/MPC로 서명. 교보 직접 키 관리 없음.
 *   ISignerService 인터페이스는 Phase 3 직접 Custody 전환 시 활성화.
 *
 * Phase 3 구현체:
 *   AWSCloudHSMSigner    — AWS CloudHSM 연동
 *   AzureDedicatedHSMSigner — Azure HSM 연동
 *   FireblocksNCWSigner  — Fireblocks MPC (Non-Custodial Wallet)
 *   ThresholdMPCSigner   — 자체 MPC 구현 (TSS 라이브러리)
 *
 * Custody Track Session 2 참조: HSM vs MPC 비교, Signer Input Contract
 */

// ── Signer Input Contract ─────────────────────────────────────────────────────
//
// 서명 요청에 포함되어야 하는 필드 명세.
// 각 필드는 서명 내용을 완전히 특정하여 서명자가 임의로 다른 TX에 서명할 수 없게 함.

export interface SignRequest {
  requestId:        string;   // UUID — 멱등성 키
  mintRequestId:    string;   // FK → MintRequest.id
  attemptId:        string;   // FK → TxAttempt.id
  chainId:          string;   // 체인 ID — EIP-155 재생 방지
  fromAddress:      string;
  toAddress:        string;
  tokenId:          bigint;
  amount:           bigint;
  nonce:            number;
  maxFeePerGas:     bigint;
  maxPriorityFeePerGas: bigint;
  deadline:         Date;     // 이 시각 이후엔 서명 무효
  policyDecisionId: string;   // PolicyEngine이 승인한 결정 ID
  approvalBundleId: string;   // Approval 모듈의 다중 서명 번들 ID
  signingScope:     'NFT_MINT' | 'NFT_BURN' | 'CONTRACT_UPGRADE' | 'GOVERNANCE';
}

export interface SignResult {
  requestId:    string;
  signedTxHex:  string;   // RLP 인코딩된 서명된 TX
  r:            string;
  s:            string;
  v:            number;
  signerPubKey: string;
  signedAt:     Date;
}

// ── ISignerService ────────────────────────────────────────────────────────────

export interface ISignerService {
  /**
   * TX 서명 요청
   * Phase 1: VASP가 대신 서명
   * Phase 3: HSM 또는 MPC를 통해 교보 키로 직접 서명
   */
  sign(request: SignRequest): Promise<SignResult>;

  /**
   * 서명자 공개키 조회
   * 주소 검증 및 감사 로그용
   */
  getPublicKey(signerAddress: string): Promise<string>;

  /**
   * Phase 3: 서명 키 상태 확인 (HSM 연결, MPC 쿼럼 여부)
   */
  healthCheck(): Promise<{ healthy: boolean; mode: 'HSM' | 'MPC' | 'STUB' }>;
}

// ── Phase 1 Stub 구현 ─────────────────────────────────────────────────────────

/**
 * Phase 1 사용: VASP 외부 위임이므로 직접 서명 없음.
 * 스켈레톤에서 인터페이스를 충족하기 위한 stub.
 */
export class StubSignerService implements ISignerService {
  async sign(_request: SignRequest): Promise<SignResult> {
    throw new Error(
      'StubSignerService: Phase 1에서는 VASP(월렛원)가 서명 담당. ' +
      'Phase 3 직접 Custody 전환 시 HSM/MPC 구현체로 교체.',
    );
  }

  async getPublicKey(_signerAddress: string): Promise<string> {
    throw new Error('Phase 3 — HSM/MPC 서명자 공개키 조회 구현 필요');
  }

  async healthCheck(): Promise<{ healthy: boolean; mode: 'HSM' | 'MPC' | 'STUB' }> {
    return { healthy: true, mode: 'STUB' };
  }
}
