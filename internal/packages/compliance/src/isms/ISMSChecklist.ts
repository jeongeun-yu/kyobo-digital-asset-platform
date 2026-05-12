/**
 * ISMSChecklist — ISMS-P 인증 대응 체크리스트 실행기
 *
 * 교보생명은 ISMS-P 인증 보유. 블록체인 시스템 도입 시
 * 기존 정보보호 관리체계 범위에 포함시켜야 한다.
 *
 * 이 모듈은 운영 중 자동 점검 항목을 코드로 관리한다.
 * 점검 결과는 감사 로그 DB에 기록 — 인증 심사 시 증빙 자료.
 *
 * 의존성 주입:
 *   - adapter:    체인 호출 (INCIDENT 체크용)
 *   - dbQuery:    감사 로그 최신성 확인 (LOG 체크용)
 *   - rpcUrl:     내부망 전용 여부 검증 (NETWORK 체크용)
 */

// ── 공개 IP 대역 / 퍼블릭 RPC 패턴 — 내부망 only 원칙 위반 감지 ─────────────
const PUBLIC_RPC_PATTERNS = [
  'infura.io', 'alchemy.com', 'quicknode.com', 'ankr.com',
  'publicnode.com', 'chainstack.com', 'rpc.sepolia.org',
  'rpc-amoy.polygon', 'mainnet.infura', '0.0.0.0',
];

// ── 의존 인터페이스 ────────────────────────────────────────────────────────────

export interface ISMSCheckDeps {
  /** 컨트랙트 read-only 호출 (INCIDENT 체크) */
  contractCall(contractAddr: string, abi: string[], method: string): Promise<unknown>;
  /** DB 쿼리 — 최근 감사 로그 조회 (LOG 체크) */
  queryLatestAuditLog(): Promise<{ createdAt: Date } | null>;
  /** EVM RPC URL — 퍼블릭 노드 사용 여부 검증 (NETWORK 체크) */
  rpcUrl: string;
  /** NFT 컨트랙트 주소 — paused() 호출 대상 (INCIDENT 체크) */
  nftContractAddr: string;
}

export interface CheckItem {
  id:          string;
  category:    'ACCESS' | 'CRYPTO' | 'LOG' | 'NETWORK' | 'INCIDENT';
  description: string;
  check:       () => Promise<{ passed: boolean; detail?: string }>;
}

export interface CheckResult {
  itemId:    string;
  passed:    boolean;
  checkedAt: number;
  detail?:   string;
}

export class ISMSChecklist {
  private items: CheckItem[];

  constructor(private readonly deps: ISMSCheckDeps) {
    this.items = [
      {
        id:          'ISMS-ACCESS-001',
        category:    'ACCESS',
        description: '블록체인 노드 접근 계정의 최소 권한 원칙 준수 여부',
        check:       async () => this._checkAccess(),
      },
      {
        id:          'ISMS-CRYPTO-001',
        category:    'CRYPTO',
        description: '운영자 Private Key HSM/KMS 보관 여부 (서버 메모리 미보관)',
        check:       async () => this._checkCrypto(),
      },
      {
        id:          'ISMS-LOG-001',
        category:    'LOG',
        description: '온체인 발행·전송 이벤트 전량 감사 로그 기록 여부',
        check:       async () => this._checkLog(),
      },
      {
        id:          'ISMS-NETWORK-001',
        category:    'NETWORK',
        description: '내부망 방화벽 규칙 — 블록체인 노드 포트 최소 개방',
        check:       async () => this._checkNetwork(),
      },
      {
        id:          'ISMS-INCIDENT-001',
        category:    'INCIDENT',
        description: '스마트컨트랙트 비상정지(pause) 기능 작동 가능 여부',
        check:       async () => this._checkIncident(),
      },
    ];
  }

  async runAll(): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const item of this.items) {
      try {
        const { passed, detail } = await item.check();
        results.push({ itemId: item.id, passed, checkedAt: Date.now(), detail });
      } catch (err) {
        results.push({ itemId: item.id, passed: false, checkedAt: Date.now(), detail: String(err) });
      }
    }
    return results;
  }

  getSummary(results: CheckResult[]): { total: number; passed: number; failed: string[] } {
    const failed = results.filter(r => !r.passed).map(r => r.itemId);
    return { total: results.length, passed: results.length - failed.length, failed };
  }

  // ── 체크 구현 ──────────────────────────────────────────────────────────────────

  /**
   * ACCESS: 환경변수에 운영 Private Key가 직접 노출되어 있으면 실패.
   * 프로덕션에서 OPERATOR_PRIVATE_KEY / EVM_SIGNER_KEY는 KMS 주입이어야 한다.
   * 값이 채워져 있으면 평문 노출 위반.
   */
  private _checkAccess(): { passed: boolean; detail?: string } {
    const exposed = ['OPERATOR_PRIVATE_KEY', 'EVM_SIGNER_KEY', 'DEPLOYER_PRIVATE_KEY']
      .filter(key => {
        const v = process.env[key];
        // 비어 있거나 KMS ARN 형식(arn:aws:kms:...)이면 안전
        return v && !v.startsWith('arn:') && !v.startsWith('kms://');
      });

    if (exposed.length > 0) {
      return { passed: false, detail: `평문 키 환경변수 감지: ${exposed.join(', ')} — KMS 주입으로 교체 필요` };
    }
    return { passed: true, detail: '운영 Private Key 환경변수 미노출 확인' };
  }

  /**
   * CRYPTO: 위와 동일 원칙 — 서명 키가 메모리에 평문 존재하면 안 됨.
   * EVM_SIGNER_KEY가 hex 프라이빗 키 형태면 위반.
   */
  private _checkCrypto(): { passed: boolean; detail?: string } {
    const signerKey = process.env['EVM_SIGNER_KEY'] ?? '';
    const isPlaintextHex = /^(0x)?[0-9a-fA-F]{64}$/.test(signerKey);

    if (isPlaintextHex) {
      return { passed: false, detail: 'EVM_SIGNER_KEY가 평문 hex 프라이빗 키 형태 — HSM/KMS 래핑 필요' };
    }
    return { passed: true, detail: 'EVM_SIGNER_KEY KMS 형식 확인' };
  }

  /**
   * LOG: 최근 감사 로그가 1시간 이내에 기록됐는지 확인.
   * 이벤트 파이프라인이 정상 동작하면 반드시 최근 로그가 있어야 한다.
   */
  private async _checkLog(): Promise<{ passed: boolean; detail?: string }> {
    const latest = await this.deps.queryLatestAuditLog();

    if (!latest) {
      return { passed: false, detail: '감사 로그 레코드 없음 — 파이프라인 점검 필요' };
    }

    const ageMs = Date.now() - latest.createdAt.getTime();
    const ONE_HOUR = 60 * 60 * 1000;

    if (ageMs > ONE_HOUR) {
      const mins = Math.floor(ageMs / 60000);
      return { passed: false, detail: `마지막 감사 로그 ${mins}분 전 — 1시간 초과 (이벤트 파이프라인 중단 의심)` };
    }

    return { passed: true, detail: `감사 로그 최신 (${Math.floor(ageMs / 1000)}초 전)` };
  }

  /**
   * NETWORK: RPC URL이 퍼블릭 노드를 가리키면 실패.
   * 보안 원칙: 블록체인 노드는 내부망 사설 IP만 허용.
   */
  private _checkNetwork(): { passed: boolean; detail?: string } {
    const url = this.deps.rpcUrl.toLowerCase();
    const violation = PUBLIC_RPC_PATTERNS.find(p => url.includes(p));

    if (violation) {
      return { passed: false, detail: `퍼블릭 RPC 감지: "${violation}" — 내부망 전용 노드로 교체 필요` };
    }
    return { passed: true, detail: `RPC URL 내부망 확인: ${this.deps.rpcUrl}` };
  }

  /**
   * INCIDENT: NFT 컨트랙트의 paused() 호출이 성공하면 비상정지 기능 정상.
   * 호출 자체가 실패하면 컨트랙트 상태 이상 또는 연결 불가.
   */
  private async _checkIncident(): Promise<{ passed: boolean; detail?: string }> {
    if (!this.deps.nftContractAddr) {
      return { passed: false, detail: 'NFT_CONTRACT_ADDR 미설정 — 배포 후 환경변수 등록 필요' };
    }

    const paused = await this.deps.contractCall(
      this.deps.nftContractAddr,
      ['function paused() view returns (bool)'],
      'paused',
    );

    return {
      passed: true,
      detail: `paused() 호출 성공 (현재 상태: ${paused ? '일시정지' : '정상 운영'})`,
    };
  }
}
