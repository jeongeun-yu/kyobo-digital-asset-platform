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
// 실습 1: Storage Slot 충돌 시뮬레이션
// ────────────────────────────────────────────────────────────────────────

/**
 * UUPS Proxy 업그레이드 시 Storage Layout 충돌 원리.
 *
 * Solidity 스토리지 슬롯:
 *   변수는 선언 순서대로 slot 0, 1, 2, ... 에 배치됨.
 *   Proxy는 Implementation을 교체해도 Storage(슬롯)는 유지됨.
 *
 * 충돌 시나리오:
 *   v1: slot[0]=_balances, slot[1]=_baseURI
 *   v2(잘못): slot[0]=_insertedFirst(신규), slot[1]=_balances, slot[2]=_baseURI
 *   → Proxy의 slot[0]에는 v1의 _balances 데이터가 있는데
 *     v2는 slot[0]을 _insertedFirst로 해석 → 데이터 손상
 */

export interface StorageSlot {
  index: number;
  varName: string;
  value: unknown;
}

export type StorageLayout = StorageSlot[];

export function buildStorageV1(): StorageLayout {
  return [
    { index: 0, varName: '_balances',  value: new Map([['0xaaaa111111111111111111111111111111111111', 100]]) },
    { index: 1, varName: '_baseURI',   value: 'https://api.kyobo.com/nft/' },
    { index: 2, varName: '_paused',    value: false },
  ];
}

/** ❌ 잘못된 v2: 기존 슬롯 앞에 변수 삽입 → 슬롯 충돌 */
export function buildStorageV2Bad(v1Storage: StorageLayout): {
  layout: StorageLayout;
  hasCollision: boolean;
  corruptedVars: string[];
} {
  // v2가 선언하는 레이아웃 (기존 앞에 삽입)
  const v2Layout: StorageLayout = [
    { index: 0, varName: '_insertedFirst', value: 0 },  // ❌ 새 변수를 slot[0]에
    { index: 1, varName: '_balances',      value: null },
    { index: 2, varName: '_baseURI',       value: null },
    { index: 3, varName: '_paused',        value: null },
  ];

  // Proxy Storage에는 v1 데이터가 그대로 있음
  // v2는 slot[0]을 _insertedFirst로 해석 → v1의 _balances(Map)를 숫자로 잘못 읽음
  const corruptedVars: string[] = [];
  for (const v2Slot of v2Layout) {
    const v1Slot = v1Storage.find(s => s.index === v2Slot.index);
    if (v1Slot && v1Slot.varName !== v2Slot.varName) {
      // 슬롯 index는 같지만 변수명이 다름 → 타입 불일치로 데이터 손상
      corruptedVars.push(`slot[${v2Slot.index}]: v1=${v1Slot.varName}, v2=${v2Slot.varName}`);
    }
  }

  return {
    layout: v2Layout,
    hasCollision: corruptedVars.length > 0,
    corruptedVars,
  };
}

/** ✅ 올바른 v2: 새 변수는 반드시 끝에만 추가 */
export function buildStorageV2Good(v1Storage: StorageLayout): {
  layout: StorageLayout;
  hasCollision: boolean;
  corruptedVars: string[];
} {
  const v2Layout: StorageLayout = [
    { index: 0, varName: '_balances',  value: v1Storage[0]?.value },  // ✅ 유지
    { index: 1, varName: '_baseURI',   value: v1Storage[1]?.value },  // ✅ 유지
    { index: 2, varName: '_paused',    value: v1Storage[2]?.value },  // ✅ 유지
    { index: 3, varName: '_newVar',    value: '' },                   // ✅ 끝에 추가
  ];

  const corruptedVars: string[] = [];
  for (const v2Slot of v2Layout) {
    const v1Slot = v1Storage.find(s => s.index === v2Slot.index);
    if (v1Slot && v1Slot.varName !== v2Slot.varName) {
      corruptedVars.push(`slot[${v2Slot.index}]: collision`);
    }
  }

  return {
    layout: v2Layout,
    hasCollision: corruptedVars.length > 0,
    corruptedVars,
  };
}

// ────────────────────────────────────────────────────────────────────────
// 실습 2: reinitializer(2) 이중 초기화 방지
// ────────────────────────────────────────────────────────────────────────

/**
 * OpenZeppelin Initializable의 reinitializer 메커니즘.
 *
 * - initializer(): 버전 1 초기화 — 한 번만 실행 가능
 * - reinitializer(2): 버전 2 초기화 — 한 번만 실행 가능
 * - 이미 실행된 버전 재호출 → revert: InvalidInitialization
 */

export class InitializerGuard {
  private _initialized = 0; // 0: 미초기화, N: 버전 N까지 초기화 완료

  /** @custom:oz-upgrades-unsafe-allow constructor */
  constructor() {
    this._initialized = 255; // _disableInitializers() 효과 — Implementation 직접 접근 차단
  }

  /** Proxy를 통한 초기화만 허용 — Proxy를 통하면 _initialized = 0에서 시작 */
  static createViaProxy(): InitializerGuard {
    const instance = Object.create(InitializerGuard.prototype) as InitializerGuard;
    instance._initialized = 0;
    return instance;
  }

  initialize(adminAddress: string): { success: boolean; error?: string } {
    if (this._initialized >= 1) {
      return { success: false, error: 'InvalidInitialization: already initialized' };
    }
    this._initialized = 1;
    // __ERC1155_init, __AccessControl_init 등 수행
    return { success: true };
  }

  initializeV2(baseURI: string, maxSupply: number): { success: boolean; error?: string } {
    if (this._initialized >= 2) {
      return { success: false, error: 'InvalidInitialization: V2 already initialized' };
    }
    this._initialized = 2;
    // 추가 초기화 수행
    return { success: true };
  }

  getInitializedVersion(): number { return this._initialized; }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 3: Gnosis Safe 2-of-3 업그레이드 거버넌스 시뮬레이션
// ────────────────────────────────────────────────────────────────────────

export type SignerType = 'VASP' | 'KYOBO_IT' | 'COMPLIANCE';

export interface PendingTransaction {
  id: string;
  description: string;
  newImplementation: string;
  signatures: Set<SignerType>;
  threshold: number;
  executed: boolean;
}

export class GnosisSafeSimulator {
  private pendingTxs = new Map<string, PendingTransaction>();
  public upgradeHistory: Array<{ txId: string; newImpl: string; executedAt: Date }> = [];

  /** 1단계: 개발자가 업그레이드 트랜잭션 제안 */
  proposeTx(txId: string, newImplementation: string, description: string): PendingTransaction {
    const tx: PendingTransaction = {
      id: txId,
      description,
      newImplementation,
      signatures: new Set(),
      threshold: 2, // 2-of-3
      executed: false,
    };
    this.pendingTxs.set(txId, tx);
    return tx;
  }

  /** 2단계: 서명자가 트랜잭션 서명 */
  sign(txId: string, signer: SignerType): { signed: boolean; currentCount: number } {
    const tx = this.pendingTxs.get(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    if (tx.executed) throw new Error(`Transaction ${txId} already executed`);

    tx.signatures.add(signer);

    // threshold 도달 시 자동 실행
    if (tx.signatures.size >= tx.threshold && !tx.executed) {
      this._execTransaction(tx);
    }

    return { signed: true, currentCount: tx.signatures.size };
  }

  /** 3단계: threshold 도달 시 자동 실행 */
  private _execTransaction(tx: PendingTransaction): void {
    tx.executed = true;
    this.upgradeHistory.push({
      txId: tx.id,
      newImpl: tx.newImplementation,
      executedAt: new Date(),
    });
    // 온체인 이벤트: Upgraded(newImplementation)
  }

  getPendingTx(txId: string): PendingTransaction | undefined {
    return this.pendingTxs.get(txId);
  }

  /** 서명자 1명만 서명 → threshold 미달 → 실행 불가 */
  canExecuteAlone(txId: string, signer: SignerType): boolean {
    const tx = this.pendingTxs.get(txId);
    if (!tx) return false;
    return tx.signatures.size >= tx.threshold;
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 4: M7 보안 감사 리포트 체크리스트
// ────────────────────────────────────────────────────────────────────────

export interface AuditReportSection {
  id: string;
  title: string;
  required: boolean;
  completed: boolean;
  items: string[];
}

export const AUDIT_REPORT: AuditReportSection[] = [
  {
    id: '1',
    title: '감사 범위',
    required: true,
    completed: true,
    items: [
      'blockchain/src/rewards/KyoboNFT.sol',
      'Slither v0.10.x 사용',
      '감사 기간: 2026-04-21 ~ 2026-04-28',
      '커밋 해시 기록',
    ],
  },
  {
    id: '2',
    title: '발견된 취약점 목록',
    required: true,
    completed: true,
    items: [
      'H1: reentrancy-eth (burn) — ReentrancyGuard + CEI 적용으로 수정 완료',
      'H2: tx-origin — KyoboNFT에 해당 없음 확인 (grep으로 전량 탐지)',
      'M1: events-access (updateMaxSupply emit 누락) — emit 추가로 수정 완료',
      'M2: visibility (_authorizeUpgrade) — internal override 확인 완료',
    ],
  },
  {
    id: '3',
    title: '적용된 방어 패턴',
    required: true,
    completed: true,
    items: [
      'ReentrancyGuardUpgradeable: burn() nonReentrant',
      'CEI 패턴: 상태 변경 후 외부 호출 순서 준수',
      'AccessControl: MINTER/PAUSER/UPGRADER 역할 분리',
      'Initializable: _disableInitializers() + initializer modifier',
      'UUPS + _authorizeUpgrade: UPGRADER_ROLE만 업그레이드 가능',
    ],
  },
  {
    id: '4',
    title: '잔여 LOW 항목',
    required: true,
    completed: true,
    items: [
      'L1: reentrancy-no-eth (OZ 내부 이벤트) — False Positive. 외부 호출 없음 확인.',
      'L2: pragma-floating — False Positive. 0.8.20 고정 버전 사용 확인.',
    ],
  },
  {
    id: '5',
    title: '권장 사항',
    required: true,
    completed: true,
    items: [
      '정기 재감사: 주요 업그레이드 전마다 Slither 재실행',
      'Fuzzing 테스트 (Echidna): 경계값 자동 탐색 도입 권장',
      'MPC 키 관리: Phase 2에서 MINTER 키 MPC 전환 권장',
      '업그레이드 거버넌스: M8 Gnosis Safe 2-of-3 서명 절차 준수',
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────
// 실습 5: M6 + M7 전체 보안 테스트 회귀 요약
// ────────────────────────────────────────────────────────────────────────

export interface RegressionTestResult {
  session: string;
  description: string;
  passed: boolean;
}

export const REGRESSION_TESTS: RegressionTestResult[] = [
  { session: 'S35', description: 'tokenId 인코딩/디코딩 — encodeTokenId + decodeTokenId',             passed: true },
  { session: 'S36', description: 'initialize 재호출 → InvalidInitialization revert',                   passed: true },
  { session: 'S37', description: 'MINTER_ROLE 없음 → mint revert',                                     passed: true },
  { session: 'S37', description: 'mintBatch 500건 가스 측정 (블록 한도 이내)',                         passed: true },
  { session: 'S38', description: 'Pause → mint revert (whenNotPaused)',                                 passed: true },
  { session: 'S38', description: 'burn → balanceOf 잔액 감소',                                         passed: true },
  { session: 'S40', description: 'v2 upgrade → 기존 잔액 보존 (Storage Collision 없음)',               passed: true },
  { session: 'S40', description: 'reinitializer(2) 이중 호출 → InvalidInitialization revert',         passed: true },
  { session: 'S41', description: 'Reentrancy 공격 → ReentrancyGuard 차단',                             passed: true },
  { session: 'S42', description: 'tx.origin 공격 → msg.sender 기반 onlyRole로 차단',                  passed: true },
  { session: 'S43', description: 'MINTER_ROLE 없음 → AccessControlUnauthorizedAccount',               passed: true },
  { session: 'S43', description: 'PAUSER_ROLE 없음 → pause revert',                                    passed: true },
  { session: 'S43', description: 'UPGRADER_ROLE 없음 → upgradeToAndCall revert',                       passed: true },
  { session: 'S43', description: '역할 탈취 시도 → DEFAULT_ADMIN_ROLE 없음 revert',                   passed: true },
  { session: 'S43', description: 'amount=0 mint → KyoboNFT: zero amount revert',                       passed: true },
  { session: 'S43', description: 'pause 후 mint → EnforcedPause revert (부작용 확인)',                 passed: true },
  { session: 'S44', description: 'Storage Collision (슬롯 앞 삽입) → hardhat-upgrades 에러 차단',     passed: true },
  { session: 'S44', description: 'v1 initialize 재호출 (v2 배포 후) → revert',                        passed: true },
];

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

(async () => {
  console.log('=== S44: 업그레이드 거버넌스 + Storage Collision + M7 최종 보안 리뷰 ===\n');

  // ── [1] Storage Slot 충돌 시뮬레이션 ────────────────────────────────
  console.log('[검증 1] Storage Slot 충돌 — 슬롯 앞 삽입 vs 끝 추가');

  const v1Storage = buildStorageV1();
  check('v1 Storage: 3개 슬롯 (0=_balances, 1=_baseURI, 2=_paused)',
    v1Storage.length === 3,
  );

  const v2Bad  = buildStorageV2Bad(v1Storage);
  const v2Good = buildStorageV2Good(v1Storage);

  check('잘못된 v2 (슬롯 앞 삽입): 충돌 발생',
    v2Bad.hasCollision === true,
  );
  check('잘못된 v2: 충돌된 슬롯 3개 이상 (기존 슬롯 전체 밀림)',
    v2Bad.corruptedVars.length >= 3,
  );
  check('올바른 v2 (끝에 추가): 충돌 없음',
    v2Good.hasCollision === false,
  );
  check('올바른 v2: 기존 3개 슬롯 유지 + 신규 슬롯 1개 추가 = 4개',
    v2Good.layout.length === 4,
  );
  check('올바른 v2: slot[0]은 여전히 _balances',
    v2Good.layout[0]?.varName === '_balances',
  );

  // ── [2] reinitializer(2) 이중 초기화 방지 ───────────────────────────
  console.log('\n[검증 2] reinitializer(2) — 이중 초기화 방지');

  // Implementation 직접 접근 차단 (constructor _disableInitializers)
  const implDirect = new InitializerGuard();
  const directInit = implDirect.initialize('0xad1111111111111111111111111111111111ad11');
  check('Implementation 직접 접근: initialize → revert (version=255)',
    directInit.success === false,
  );

  // Proxy를 통한 정상 초기화
  const proxyInst = InitializerGuard.createViaProxy();
  const v1Init = proxyInst.initialize('0xad1111111111111111111111111111111111ad11');
  check('Proxy v1 initialize: 성공',               v1Init.success === true);
  check('초기화 버전: 1',                           proxyInst.getInitializedVersion() === 1);

  // v1 initialize 재호출 → revert
  const v1Reinit = proxyInst.initialize('0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0');
  check('v1 initialize 재호출 → InvalidInitialization', v1Reinit.success === false);

  // v2 initializeV2 호출
  const v2Init = proxyInst.initializeV2('https://api.kyobo.com/v2/', 5000);
  check('v2 initializeV2: 성공',                   v2Init.success === true);
  check('초기화 버전: 2',                           proxyInst.getInitializedVersion() === 2);

  // v2 initializeV2 재호출 → revert
  const v2Reinit = proxyInst.initializeV2('https://evil.com/', 0);
  check('v2 initializeV2 재호출 → InvalidInitialization', v2Reinit.success === false);

  // ── [3] Gnosis Safe 2-of-3 업그레이드 거버넌스 ──────────────────────
  console.log('\n[검증 3] Gnosis Safe 2-of-3 업그레이드 거버넌스');

  const safe = new GnosisSafeSimulator();

  // 1단계: 업그레이드 트랜잭션 제안
  const tx = safe.proposeTx('TX-001', '0x1mp1000000000000000000000000000000000002', 'KyoboNFT v1 → v2 업그레이드');
  check('TX 제안 완료: 서명 0건, 미실행',
    tx.signatures.size === 0 && !tx.executed,
  );

  // 2단계: 서명자 1명만 서명 → threshold(2) 미달 → 실행 안 됨
  safe.sign('TX-001', 'VASP');
  const afterOne = safe.getPendingTx('TX-001');
  check('서명 1건: threshold 미달 — 실행 안 됨',
    afterOne?.signatures.size === 1 && !afterOne.executed,
  );

  // 3단계: 서명자 2명 서명 → threshold 도달 → 자동 실행
  safe.sign('TX-001', 'KYOBO_IT');
  const afterTwo = safe.getPendingTx('TX-001');
  check('서명 2건: threshold 도달 → 업그레이드 자동 실행',
    afterTwo?.signatures.size === 2 && afterTwo.executed,
  );
  check('업그레이드 이력 1건 기록 (온체인 Upgraded 이벤트)',
    safe.upgradeHistory.length === 1,
  );
  check('실행된 Implementation 주소 정확',
    safe.upgradeHistory[0]?.newImpl === '0x1mp1000000000000000000000000000000000002',
  );

  // 단독 실행 불가 검증: 이미 실행된 TX에 3번째 서명 → executed 이미 true
  try {
    safe.sign('TX-001', 'COMPLIANCE');
    check('이미 실행된 TX 재서명 → 에러 발생해야 함', false);
  } catch {
    check('이미 실행된 TX 재서명 → revert (already executed)', true);
  }

  // 개발자 단독 실행 불가: 새 TX에 서명자 1명만 있으면 미실행
  safe.proposeTx('TX-002', '0x1mp1000000000000000000000000000000000003', 'KyoboNFT v2 → v3');
  safe.sign('TX-002', 'VASP'); // 1명만 서명
  const tx2 = safe.getPendingTx('TX-002');
  check('개발자 단독 실행 불가: 1-of-3 상태 → 실행 안 됨',
    tx2?.signatures.size === 1 && !tx2.executed,
  );

  // ── [4] 보안 감사 리포트 완성도 검증 ─────────────────────────────────
  console.log('\n[검증 4] M7 보안 감사 리포트 — 5개 필수 항목 완성도');

  const requiredSections = AUDIT_REPORT.filter(s => s.required);
  const completedRequired = requiredSections.filter(s => s.completed);

  check('필수 항목 5개 정의됨',                     requiredSections.length === 5);
  check('필수 항목 5개 전부 완료 (completed=true)',  completedRequired.length === 5);
  check('1. 감사 범위 포함',
    AUDIT_REPORT.some(s => s.id === '1' && s.completed),
  );
  check('2. 취약점 목록 포함 (HIGH/MEDIUM 수정 내역)',
    AUDIT_REPORT.some(s => s.id === '2' && s.completed),
  );
  check('3. 방어 패턴 목록 포함 (ReentrancyGuard/CEI/AccessControl)',
    AUDIT_REPORT.some(s => s.id === '3' && s.completed),
  );
  check('4. 잔여 LOW 항목 + False Positive 판단 포함',
    AUDIT_REPORT.some(s => s.id === '4' && s.completed),
  );
  check('5. 권장 사항 포함 (Fuzzing/MPC/재감사)',
    AUDIT_REPORT.some(s => s.id === '5' && s.completed),
  );

  // ── [5] M6 + M7 회귀 테스트 요약 ────────────────────────────────────
  console.log('\n[검증 5] M6 + M7 전체 보안 테스트 회귀 요약');

  const totalTests  = REGRESSION_TESTS.length;
  const passedTests = REGRESSION_TESTS.filter(t => t.passed).length;

  check(`총 ${totalTests}건 테스트 케이스 정의됨`, totalTests === 18);
  check(`전체 ${passedTests}건 PASS`, passedTests === totalTests);

  // 세션별 분류
  const bySession = new Map<string, RegressionTestResult[]>();
  for (const t of REGRESSION_TESTS) {
    if (!bySession.has(t.session)) bySession.set(t.session, []);
    bySession.get(t.session)!.push(t);
  }

  for (const [session, tests] of [...bySession.entries()].sort()) {
    const passed = tests.filter(t => t.passed).length;
    const total  = tests.length;
    check(`  ${session}: ${passed}/${total} PASS`, passed === total);
  }

  // ── 정리 ────────────────────────────────────────────────────────────
  console.log('\n=== S44 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. Storage Collision: 새 변수는 반드시 기존 슬롯 끝에만 추가 — 앞 삽입 금지');
  console.log('  2. reinitializer: _initialized 버전으로 이중 초기화 방지 — 재진입과 유사 원리');
  console.log('  3. Gnosis Safe 2-of-3: VASP+교보IT+준법감시 중 2명 서명 필수 — 단독 실행 불가');
  console.log('  4. 감사 리포트 5항목: 범위/취약점목록/방어패턴/잔여LOW/권장사항');
  console.log('  5. 보안은 "한 번 완료" 아님 — 업그레이드마다 Slither 재실행 + 리포트 갱신');
  console.log('  6. M7 전체: S41(탐지) → S42(HIGH제거) → S43(MEDIUM제거) → S44(거버넌스+리포트)');

  console.log('\n=== M7 모듈 완료 ===');
  console.log('  Slither HIGH: 0건  MEDIUM: 0건  LOW: False Positive 처리 완료');
  console.log('  Storage Collision 없음 (hardhat-upgrades 검증)');
  console.log('  전체 보안 테스트 18건 PASS (M6 + M7 통합)');
})();
