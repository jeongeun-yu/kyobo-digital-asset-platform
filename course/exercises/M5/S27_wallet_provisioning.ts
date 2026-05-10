/**
 * S27 실습 — 사용자 레이어 진입점 설계 · VASP별 지갑 프로비저닝 분기
 *
 * 강의 노트: M5_S27_wallet_provisioning.md
 *
 * 실행 방법 (루트에서): npm run exercise:s27
 *
 * 목표:
 *   [1] VaspType 분기 — EXTERNAL / KYOBO / 미지원 타입 처리
 *   [2] WalletProvisioningService.provision() 구현
 *   [3] UnsupportedVaspError 에러 클래스
 *   [4] saveMapping() 호출 검증
 */

// ────────────────────────────────────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────────────────────────────────────

type VaspType = 'EXTERNAL' | 'KYOBO';

interface ProvisionResult {
  userId:        string;
  walletAddress: string;
  vaspType:      VaspType;
  provisionedAt: Date;
}

/** VASP 클라이언트 인터페이스 — Phase 1: 월렛원 위탁 / Phase 4: 교보 내부 HSM */
interface ExternalVaspClient {
  /** 기존 Custody 지갑 주소 조회 (EXTERNAL 방식) */
  getWalletAddr(userId: string): Promise<string>;
  /** 내부 신규 지갑 생성 (KYOBO/Phase 4 방식) */
  createWallet(userId: string): Promise<string>;
}

interface WalletMappingService {
  saveMapping(userId: string, walletAddr: string, vaspType: VaspType): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 1: UnsupportedVaspError 에러 클래스를 구현하라
//
// 힌트:
//   - Error를 상속한다
//   - 생성자: constructor(vaspType: string)
//   - super()에 메시지 전달: `지원하지 않는 VASP 타입: ${vaspType}`
//   - this.name = 'UnsupportedVaspError' 설정
// ────────────────────────────────────────────────────────────────────────

// UnsupportedVaspError는 완성 코드로 제공 (에러 클래스 구조 참고)
export class UnsupportedVaspError extends Error {
  constructor(vaspType: string) {
    super(`지원하지 않는 VASP 타입: ${vaspType}`);
    this.name = 'UnsupportedVaspError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 2: WalletProvisioningService.provision()을 구현하라
//
// 역할: 지갑 주소를 "획득"하는 역할 — VASP 유형별 분기
//
// 분기 로직:
//   EXTERNAL → vaspClient.getWalletAddr(userId)  (월렛원 Custody 조회)
//   KYOBO    → vaspClient.createWallet(userId)   (Phase 4: 교보 내부 HSM)
//   기타     → UnsupportedVaspError를 throw
//
// 지갑 주소 획득 후:
//   → walletMapping.saveMapping(userId, walletAddress, vaspType) 호출
//   → ProvisionResult 반환 { userId, walletAddress, vaspType, provisionedAt: new Date() }
//
// 주의: 미지원 vaspType 시 saveMapping()은 절대 호출하지 않는다
// ────────────────────────────────────────────────────────────────────────

export class WalletProvisioningService {
  constructor(
    private readonly vaspClient:     ExternalVaspClient,
    private readonly walletMapping:  WalletMappingService,
  ) {}

  async provision(userId: string, vaspType: VaspType | string): Promise<ProvisionResult> {
    throw new Error('TODO: 구현하세요');
  }
}

// ────────────────────────────────────────────────────────────────────────
// Mock 구현체 (완성 코드 — 수정 불필요)
// ────────────────────────────────────────────────────────────────────────

/** Mock VASP 클라이언트 — 실제 월렛원 API 없이 로직 검증 */
const mockVaspClient: ExternalVaspClient = {
  async getWalletAddr(userId: string): Promise<string> {
    // EXTERNAL: 월렛원 Custody 지갑 주소 반환 (실제에선 REST API 호출)
    return `0x${Buffer.from(`external-${userId}`).toString('hex').padEnd(40, '0').slice(0, 40)}`;
  },
  async createWallet(userId: string): Promise<string> {
    // KYOBO: 교보 내부 HSM으로 생성한 지갑 주소 (실제에선 HSM API 호출)
    return `0x${Buffer.from(`kyobo-${userId}`).toString('hex').padEnd(40, '0').slice(0, 40)}`;
  },
};

/** 저장 기록 추적용 Mock WalletMappingService */
const savedMappings: Array<{ userId: string; walletAddr: string; vaspType: string }> = [];
const mockWalletMapping: WalletMappingService = {
  async saveMapping(userId, walletAddr, vaspType): Promise<void> {
    savedMappings.push({ userId, walletAddr, vaspType });
    console.log(`  [DB] saveMapping(${userId}, ${walletAddr}, ${vaspType})`);
  },
};

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

if (require.main === module) (async () => {
  console.log('=== S27: 지갑 프로비저닝 — VASP 유형별 분기 ===\n');

  const service = new WalletProvisioningService(mockVaspClient, mockWalletMapping);

  // ── [1] EXTERNAL 방식: getWalletAddr() 호출 ────────────────────────────
  console.log('[검증 1] EXTERNAL → vaspClient.getWalletAddr() 호출');
  savedMappings.length = 0;
  const extResult = await service.provision('K-20240001', 'EXTERNAL');
  check('EXTERNAL walletAddress 반환됨',               extResult.walletAddress.startsWith('0x'));
  check('vaspType = EXTERNAL',                         extResult.vaspType === 'EXTERNAL');
  check('userId 일치',                                 extResult.userId === 'K-20240001');
  check('provisionedAt이 Date 타입',                   extResult.provisionedAt instanceof Date);
  check('saveMapping() 1회 호출됨',                    savedMappings.length === 1);
  check('저장된 userId 일치',                          savedMappings[0]?.userId === 'K-20240001');
  check('저장된 vaspType 일치',                        savedMappings[0]?.vaspType === 'EXTERNAL');

  // ── [2] KYOBO 방식: createWallet() 호출 ────────────────────────────────
  console.log('\n[검증 2] KYOBO → vaspClient.createWallet() 호출');
  savedMappings.length = 0;
  const kyoboResult = await service.provision('K-20240002', 'KYOBO');
  check('KYOBO walletAddress 반환됨',                  kyoboResult.walletAddress.startsWith('0x'));
  check('vaspType = KYOBO',                            kyoboResult.vaspType === 'KYOBO');
  check('saveMapping() 1회 호출됨',                    savedMappings.length === 1);

  // ── [3] 미지원 vaspType → UnsupportedVaspError ─────────────────────────
  console.log('\n[검증 3] 미지원 vaspType → UnsupportedVaspError');
  savedMappings.length = 0;  // 이전 테스트 잔여값 초기화
  let caughtError: unknown;
  try {
    await service.provision('K-20240003', 'UNKNOWN_VASP' as VaspType);
  } catch (err) {
    caughtError = err;
  }
  check('UnsupportedVaspError 발생',                  caughtError instanceof UnsupportedVaspError);
  check('에러 메시지에 vaspType 포함',                  caughtError instanceof Error && caughtError.message.includes('UNKNOWN_VASP'));
  check('UnsupportedVaspError 시 saveMapping 미호출',  savedMappings.length === 0);

  // ── [4] 컨트롤러 계층 시뮬레이션 ────────────────────────────────────────
  console.log('\n[검증 4] 컨트롤러 계층 — UnsupportedVaspError → 400, 나머지 → 200');

  async function simulateController(userId: string, vaspType: string): Promise<number> {
    try {
      await service.provision(userId, vaspType as VaspType);
      return 200;
    } catch (err) {
      if (err instanceof UnsupportedVaspError) return 400;
      return 500;
    }
  }

  const status200 = await simulateController('K-20240004', 'EXTERNAL');
  const status400 = await simulateController('K-20240005', 'LEGACY_VASP');

  check('EXTERNAL → HTTP 200',                        status200 === 200);
  check('미지원 vaspType → HTTP 400',                  status400 === 400);

  // ── 핵심 구조 출력 ────────────────────────────────────────────────────
  console.log('\n=== S27 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. 컨트롤러는 분기하지 않는다 — POST /api/wallet/provision 단일 엔드포인트');
  console.log('  2. VaspType 분기는 WalletProvisioningService.provision() 내부에서만');
  console.log('  3. EXTERNAL: getWalletAddr() — 월렛원 Custody에서 기존 지갑 조회');
  console.log('  4. KYOBO: createWallet() — Phase 4 교보 내부 HSM (현재 예약 경로)');
  console.log('  5. 미지원 타입 → UnsupportedVaspError → 컨트롤러 400 응답');
  console.log('  6. provision() 이후엔 getWalletAddr()만 — VASP API 재호출 없음');
})();
