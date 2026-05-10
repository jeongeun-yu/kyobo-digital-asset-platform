/**
 * S44 실습 — 업그레이드 시 데이터 손상 원인과 방어 패턴 · M7 종합 보안 리뷰
 *
 * 강의 노트: M7_S44_security_review.md
 *
 * 실행 방법 (루트에서): npm run exercise:s44
 *
 * 목표:
 *   [1] Storage Slot 충돌 — 슬롯 순서 변경이 데이터를 파괴하는 원리 시뮬레이션
 *   [2] reinitializer(2) — 이중 초기화 방지 메커니즘 검증
 *   [3] Gnosis Safe 2-of-3 업그레이드 거버넌스 흐름 시뮬레이션
 *   [4] M7 보안 감사 리포트 체크리스트 — 5개 필수 항목 완성도 검증
 *   [5] M6 + M7 전체 보안 테스트 회귀 요약
 *
 * ────────────────────────────────────────────────────────────────────────
 * Slither / Hardhat 커맨드 — M7 최종 확인:
 *
 *   # Storage layout 충돌 감지
 *   npx hardhat check
 *
 *   # Slither 최종 확인 — HIGH/MEDIUM 0건
 *   slither src/rewards/KyoboNFT.sol --exclude-dependencies
 *
 *   # 전체 테스트 실행 (M6 + M7 통합)
 *   forge test -vvv
 *   npx hardhat test
 * ────────────────────────────────────────────────────────────────────────
 */

// ────────────────────────────────────────────────────────────────────────
// 타입 정의 (수정하지 말 것)
// ────────────────────────────────────────────────────────────────────────

export interface StorageSlot {
  index: number;
  varName: string;
  value: unknown;
}

export type StorageLayout = StorageSlot[];

export type SignerType = 'VASP' | 'KYOBO_IT' | 'COMPLIANCE';

export interface PendingTransaction {
  id: string;
  description: string;
  newImplementation: string;
  signatures: Set<SignerType>;
  threshold: number;
  executed: boolean;
}

export interface AuditReportSection {
  id: string;
  title: string;
  required: boolean;
  completed: boolean;
  items: string[];
}

export interface RegressionTestResult {
  session: string;
  description: string;
  passed: boolean;
}

// ────────────────────────────────────────────────────────────────────────
// TODO 1: buildStorageV1 구현
//
// v1 Storage Layout을 반환한다.
//
// 구현 지시:
//   슬롯 3개를 담은 배열을 반환한다:
//   - slot[0]: varName='_balances', value=new Map([['0xUSER', 100]])
//   - slot[1]: varName='_baseURI',  value='https://api.kyobo.com/nft/'
//   - slot[2]: varName='_paused',   value=false
// ────────────────────────────────────────────────────────────────────────

export function buildStorageV1(): StorageLayout {
  throw new Error('TODO: 구현하세요');
}

// ────────────────────────────────────────────────────────────────────────
// TODO 2: buildStorageV2Bad 구현
//
// 슬롯 앞에 새 변수를 삽입하는 잘못된 v2 레이아웃을 시뮬레이션한다.
//
// 구현 지시:
//   v2Layout:
//   - slot[0]: varName='_insertedFirst', value=0  (❌ 앞에 삽입)
//   - slot[1]: varName='_balances', value=null
//   - slot[2]: varName='_baseURI', value=null
//   - slot[3]: varName='_paused', value=null
//
//   충돌 감지:
//   - v2Layout 각 슬롯에 대해 v1Storage에서 같은 index의 슬롯을 찾는다.
//   - v1 슬롯이 존재하고 varName이 다르면 corruptedVars에 push한다.
//     형식: `slot[${v2Slot.index}]: v1=${v1Slot.varName}, v2=${v2Slot.varName}`
//
//   반환: { layout: v2Layout, hasCollision: corruptedVars.length > 0, corruptedVars }
// ────────────────────────────────────────────────────────────────────────

export function buildStorageV2Bad(v1Storage: StorageLayout): {
  layout: StorageLayout;
  hasCollision: boolean;
  corruptedVars: string[];
} {
  throw new Error('TODO: 구현하세요');
}

// ────────────────────────────────────────────────────────────────────────
// TODO 3: buildStorageV2Good 구현
//
// 새 변수를 끝에만 추가하는 올바른 v2 레이아웃을 시뮬레이션한다.
//
// 구현 지시:
//   v2Layout:
//   - slot[0]: varName='_balances', value=v1Storage[0].value  (✅ 유지)
//   - slot[1]: varName='_baseURI',  value=v1Storage[1].value  (✅ 유지)
//   - slot[2]: varName='_paused',   value=v1Storage[2].value  (✅ 유지)
//   - slot[3]: varName='_newVar',   value=''                  (✅ 끝에 추가)
//
//   충돌 감지: v1과 동일한 슬롯에서 varName이 다른 경우만 corruptedVars에 추가.
//   반환: { layout: v2Layout, hasCollision: corruptedVars.length > 0, corruptedVars }
// ────────────────────────────────────────────────────────────────────────

export function buildStorageV2Good(v1Storage: StorageLayout): {
  layout: StorageLayout;
  hasCollision: boolean;
  corruptedVars: string[];
} {
  throw new Error('TODO: 구현하세요');
}

// ────────────────────────────────────────────────────────────────────────
// TODO 4: InitializerGuard 클래스 구현
//
// OpenZeppelin Initializable의 reinitializer 메커니즘을 재현한다.
//
// 구현 지시:
//   private _initialized = 0
//
//   constructor():
//     - this._initialized = 255  (_disableInitializers() 효과)
//
//   static createViaProxy():
//     - Object.create(InitializerGuard.prototype) 로 인스턴스 생성
//     - instance._initialized = 0 으로 설정 후 반환
//
//   initialize(adminAddress):
//     - _initialized >= 1 이면 { success: false, error: 'InvalidInitialization: already initialized' }
//     - 아니면 _initialized = 1 후 { success: true }
//
//   initializeV2(baseURI, maxSupply):
//     - _initialized >= 2 이면 { success: false, error: 'InvalidInitialization: V2 already initialized' }
//     - 아니면 _initialized = 2 후 { success: true }
//
//   getInitializedVersion(): _initialized 반환
// ────────────────────────────────────────────────────────────────────────

export class InitializerGuard {
  private _initialized = 0;

  constructor() {
    throw new Error('TODO: 구현하세요');
  }

  static createViaProxy(): InitializerGuard {
    throw new Error('TODO: 구현하세요');
  }

  initialize(adminAddress: string): { success: boolean; error?: string } {
    throw new Error('TODO: 구현하세요');
  }

  initializeV2(baseURI: string, maxSupply: number): { success: boolean; error?: string } {
    throw new Error('TODO: 구현하세요');
  }

  getInitializedVersion(): number { return this._initialized; }
}

// ────────────────────────────────────────────────────────────────────────
// TODO 5: GnosisSafeSimulator 클래스 구현
//
// 2-of-3 업그레이드 거버넌스 흐름을 시뮬레이션한다.
//
// 구현 지시:
//   private pendingTxs = new Map<string, PendingTransaction>()
//   public upgradeHistory: Array<...> = []
//
//   proposeTx(txId, newImplementation, description):
//     - PendingTransaction 생성: { id, description, newImplementation,
//         signatures: new Set(), threshold: 2, executed: false }
//     - pendingTxs.set(txId, tx), 반환
//
//   sign(txId, signer):
//     - tx 없으면 throw Error
//     - tx.executed이면 throw Error('Transaction ${txId} already executed')
//     - tx.signatures.add(signer)
//     - signatures.size >= threshold && !executed:
//       tx.executed = true, upgradeHistory.push({ txId, newImpl, executedAt })
//     - { signed: true, currentCount: tx.signatures.size } 반환
//
//   getPendingTx(txId): pendingTxs.get(txId) 반환
// ────────────────────────────────────────────────────────────────────────

export class GnosisSafeSimulator {
  private pendingTxs = new Map<string, PendingTransaction>();
  public upgradeHistory: Array<{ txId: string; newImpl: string; executedAt: Date }> = [];

  proposeTx(txId: string, newImplementation: string, description: string): PendingTransaction {
    throw new Error('TODO: 구현하세요');
  }

  sign(txId: string, signer: SignerType): { signed: boolean; currentCount: number } {
    throw new Error('TODO: 구현하세요');
  }

  getPendingTx(txId: string): PendingTransaction | undefined {
    return this.pendingTxs.get(txId);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 감사 리포트 / 회귀 테스트 데이터 (수정하지 말 것)
// ────────────────────────────────────────────────────────────────────────

export const AUDIT_REPORT: AuditReportSection[] = [
  {
    id: '1', title: '감사 범위', required: true, completed: true,
    items: ['blockchain/src/rewards/KyoboNFT.sol', 'Slither v0.10.x 사용', '감사 기간: 2026-04-21 ~ 2026-04-28', '커밋 해시 기록'],
  },
  {
    id: '2', title: '발견된 취약점 목록', required: true, completed: true,
    items: ['H1: reentrancy-eth (burn) — ReentrancyGuard + CEI 적용으로 수정 완료', 'H2: tx-origin — KyoboNFT에 해당 없음 확인', 'M1: events-access — emit 추가로 수정 완료', 'M2: visibility — internal override 확인 완료'],
  },
  {
    id: '3', title: '적용된 방어 패턴', required: true, completed: true,
    items: ['ReentrancyGuardUpgradeable: burn() nonReentrant', 'CEI 패턴', 'AccessControl: MINTER/PAUSER/UPGRADER 역할 분리', 'Initializable: _disableInitializers()', 'UUPS + _authorizeUpgrade'],
  },
  {
    id: '4', title: '잔여 LOW 항목', required: true, completed: true,
    items: ['L1: reentrancy-no-eth (OZ 내부 이벤트) — False Positive.', 'L2: pragma-floating — False Positive.'],
  },
  {
    id: '5', title: '권장 사항', required: true, completed: true,
    items: ['정기 재감사', 'Fuzzing 테스트 (Echidna)', 'MPC 키 관리', '업그레이드 거버넌스: M8 Gnosis Safe'],
  },
];

export const REGRESSION_TESTS: RegressionTestResult[] = [
  { session: 'S35', description: 'tokenId 인코딩/디코딩',                                          passed: true },
  { session: 'S36', description: 'initialize 재호출 → InvalidInitialization revert',               passed: true },
  { session: 'S37', description: 'MINTER_ROLE 없음 → mint revert',                                 passed: true },
  { session: 'S37', description: 'mintBatch 500건 가스 측정 (블록 한도 이내)',                      passed: true },
  { session: 'S38', description: 'Pause → mint revert (whenNotPaused)',                             passed: true },
  { session: 'S38', description: 'burn → balanceOf 잔액 감소',                                     passed: true },
  { session: 'S40', description: 'v2 upgrade → 기존 잔액 보존 (Storage Collision 없음)',           passed: true },
  { session: 'S40', description: 'reinitializer(2) 이중 호출 → InvalidInitialization revert',     passed: true },
  { session: 'S41', description: 'Reentrancy 공격 → ReentrancyGuard 차단',                         passed: true },
  { session: 'S42', description: 'tx.origin 공격 → msg.sender 기반 onlyRole로 차단',               passed: true },
  { session: 'S43', description: 'MINTER_ROLE 없음 → AccessControlUnauthorizedAccount',            passed: true },
  { session: 'S43', description: 'PAUSER_ROLE 없음 → pause revert',                                passed: true },
  { session: 'S43', description: 'UPGRADER_ROLE 없음 → upgradeToAndCall revert',                   passed: true },
  { session: 'S43', description: '역할 탈취 시도 → DEFAULT_ADMIN_ROLE 없음 revert',                passed: true },
  { session: 'S43', description: 'amount=0 mint → KyoboNFT: zero amount revert',                   passed: true },
  { session: 'S43', description: 'pause 후 mint → EnforcedPause revert (부작용 확인)',             passed: true },
  { session: 'S44', description: 'Storage Collision (슬롯 앞 삽입) → hardhat-upgrades 에러 차단', passed: true },
  { session: 'S44', description: 'v1 initialize 재호출 (v2 배포 후) → revert',                    passed: true },
];

// ────────────────────────────────────────────────────────────────────────
// 헬퍼 (수정하지 말 것)
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점 (수정하지 말 것)
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S44: 업그레이드 거버넌스 + Storage Collision + M7 최종 보안 리뷰 ===\n');

  // ── [1] Storage Slot 충돌 시뮬레이션 ────────────────────────────────
  console.log('[검증 1] Storage Slot 충돌 — 슬롯 앞 삽입 vs 끝 추가');

  const v1Storage = buildStorageV1();
  check('v1 Storage: 3개 슬롯 (0=_balances, 1=_baseURI, 2=_paused)', v1Storage.length === 3);

  const v2Bad  = buildStorageV2Bad(v1Storage);
  const v2Good = buildStorageV2Good(v1Storage);

  check('잘못된 v2 (슬롯 앞 삽입): 충돌 발생',           v2Bad.hasCollision === true);
  check('잘못된 v2: 충돌된 슬롯 3개 이상',               v2Bad.corruptedVars.length >= 3);
  check('올바른 v2 (끝에 추가): 충돌 없음',              v2Good.hasCollision === false);
  check('올바른 v2: 기존 3개 슬롯 유지 + 신규 슬롯 1개 추가 = 4개', v2Good.layout.length === 4);
  check('올바른 v2: slot[0]은 여전히 _balances',         v2Good.layout[0]?.varName === '_balances');

  // ── [2] reinitializer(2) 이중 초기화 방지 ───────────────────────────
  console.log('\n[검증 2] reinitializer(2) — 이중 초기화 방지');

  const implDirect = new InitializerGuard();
  const directInit = implDirect.initialize('0xADMIN');
  check('Implementation 직접 접근: initialize → revert (version=255)', directInit.success === false);

  const proxyInst = InitializerGuard.createViaProxy();
  const v1Init = proxyInst.initialize('0xADMIN');
  check('Proxy v1 initialize: 성공',             v1Init.success === true);
  check('초기화 버전: 1',                         proxyInst.getInitializedVersion() === 1);

  const v1Reinit = proxyInst.initialize('0xATTACK');
  check('v1 initialize 재호출 → InvalidInitialization', v1Reinit.success === false);

  const v2Init = proxyInst.initializeV2('https://api.kyobo.com/v2/', 5000);
  check('v2 initializeV2: 성공',                 v2Init.success === true);
  check('초기화 버전: 2',                         proxyInst.getInitializedVersion() === 2);

  const v2Reinit = proxyInst.initializeV2('https://evil.com/', 0);
  check('v2 initializeV2 재호출 → InvalidInitialization', v2Reinit.success === false);

  // ── [3] Gnosis Safe 2-of-3 업그레이드 거버넌스 ──────────────────────
  console.log('\n[검증 3] Gnosis Safe 2-of-3 업그레이드 거버넌스');

  const safe = new GnosisSafeSimulator();

  const tx = safe.proposeTx('TX-001', '0xNEW_IMPL_V2', 'KyoboNFT v1 → v2 업그레이드');
  check('TX 제안 완료: 서명 0건, 미실행', tx.signatures.size === 0 && !tx.executed);

  safe.sign('TX-001', 'VASP');
  const afterOne = safe.getPendingTx('TX-001');
  check('서명 1건: threshold 미달 — 실행 안 됨', afterOne?.signatures.size === 1 && !afterOne.executed);

  safe.sign('TX-001', 'KYOBO_IT');
  const afterTwo = safe.getPendingTx('TX-001');
  check('서명 2건: threshold 도달 → 업그레이드 자동 실행', afterTwo?.signatures.size === 2 && afterTwo.executed);
  check('업그레이드 이력 1건 기록',             safe.upgradeHistory.length === 1);
  check('실행된 Implementation 주소 정확',       safe.upgradeHistory[0]?.newImpl === '0xNEW_IMPL_V2');

  try {
    safe.sign('TX-001', 'COMPLIANCE');
    check('이미 실행된 TX 재서명 → 에러 발생해야 함', false);
  } catch {
    check('이미 실행된 TX 재서명 → revert (already executed)', true);
  }

  safe.proposeTx('TX-002', '0xNEW_IMPL_V3', 'KyoboNFT v2 → v3');
  safe.sign('TX-002', 'VASP');
  const tx2 = safe.getPendingTx('TX-002');
  check('개발자 단독 실행 불가: 1-of-3 상태 → 실행 안 됨', tx2?.signatures.size === 1 && !tx2.executed);

  // ── [4] 보안 감사 리포트 완성도 검증 ─────────────────────────────────
  console.log('\n[검증 4] M7 보안 감사 리포트 — 5개 필수 항목 완성도');

  const requiredSections  = AUDIT_REPORT.filter(s => s.required);
  const completedRequired = requiredSections.filter(s => s.completed);

  check('필수 항목 5개 정의됨',                   requiredSections.length === 5);
  check('필수 항목 5개 전부 완료',                 completedRequired.length === 5);
  check('1. 감사 범위 포함',                       AUDIT_REPORT.some(s => s.id === '1' && s.completed));
  check('2. 취약점 목록 포함',                     AUDIT_REPORT.some(s => s.id === '2' && s.completed));
  check('3. 방어 패턴 목록 포함',                  AUDIT_REPORT.some(s => s.id === '3' && s.completed));
  check('4. 잔여 LOW + False Positive 판단 포함', AUDIT_REPORT.some(s => s.id === '4' && s.completed));
  check('5. 권장 사항 포함',                       AUDIT_REPORT.some(s => s.id === '5' && s.completed));

  // ── [5] M6 + M7 회귀 테스트 요약 ────────────────────────────────────
  console.log('\n[검증 5] M6 + M7 전체 보안 테스트 회귀 요약');

  const totalTests  = REGRESSION_TESTS.length;
  const passedTests = REGRESSION_TESTS.filter(t => t.passed).length;

  check(`총 ${totalTests}건 테스트 케이스 정의됨`, totalTests === 18);
  check(`전체 ${passedTests}건 PASS`,              passedTests === totalTests);

  // ── 정리 ────────────────────────────────────────────────────────────
  console.log('\n=== S44 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. Storage Collision: 새 변수는 반드시 기존 슬롯 끝에만 추가 — 앞 삽입 금지');
  console.log('  2. reinitializer: _initialized 버전으로 이중 초기화 방지');
  console.log('  3. Gnosis Safe 2-of-3: VASP+교보IT+준법감시 중 2명 서명 필수 — 단독 실행 불가');
  console.log('  4. 감사 리포트 5항목: 범위/취약점목록/방어패턴/잔여LOW/권장사항');
  console.log('  5. 보안은 "한 번 완료" 아님 — 업그레이드마다 Slither 재실행 + 리포트 갱신');
  console.log('  6. M7 전체: S41(탐지) → S42(HIGH제거) → S43(MEDIUM제거) → S44(거버넌스+리포트)');
})();
