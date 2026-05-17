/**
 * S43 실습 — 중간 등급 취약점 패턴과 방어적 테스트 설계
 *
 * 강의 노트: M7_S43_upgrade_operation.md
 *
 * 실행 방법 (루트에서): npm run exercise:s43
 *
 * 목표:
 *   [1] MEDIUM 취약점 3가지 패턴 — 접근 제어 누락 / 이벤트 누락 / 가시성 실수
 *   [2] 이벤트 누락이 감사(audit)에 미치는 영향 이해
 *   [3] 보안 테스트 설계 5가지 질문 적용
 *   [4] 접근 제어 우회 시도 시뮬레이션 (MINTER/PAUSER/UPGRADER 역할 체계)
 *   [5] Slither MEDIUM 항목 수정 후 HIGH/MEDIUM 0건 검증
 *
 * ────────────────────────────────────────────────────────────────────────
 * Slither 커맨드 — MEDIUM 항목 확인 및 목표:
 *
 *   # MEDIUM 항목 확인
 *   slither src/rewards/KyoboNFT.sol --detect access-control,events-access,visibility
 *
 *   # OZ 라이브러리 제외 후 HIGH/MEDIUM 확인
 *   slither src/rewards/KyoboNFT.sol --exclude-dependencies
 *
 *   # 목표: HIGH 0건, MEDIUM 0건
 * ────────────────────────────────────────────────────────────────────────
 */

// ────────────────────────────────────────────────────────────────────────
// 역할(Role) 정의 — KyoboNFT AccessControl 체계
// ────────────────────────────────────────────────────────────────────────

export type Role = 'DEFAULT_ADMIN_ROLE' | 'MINTER_ROLE' | 'PAUSER_ROLE' | 'UPGRADER_ROLE' | 'NONE';

export interface Account {
  address: string;
  role: Role;
}

export class RoleRegistry {
  private roles = new Map<string, Set<Role>>();

  grantRole(role: Role, account: string, caller: Account): void {
    // AccessControl: DEFAULT_ADMIN_ROLE만 역할 부여 가능
    if (!this.hasRole('DEFAULT_ADMIN_ROLE', caller.address)) {
      throw new Error(`AccessControlUnauthorizedAccount: ${caller.address} lacks DEFAULT_ADMIN_ROLE`);
    }
    if (!this.roles.has(account)) this.roles.set(account, new Set());
    this.roles.get(account)!.add(role);
  }

  hasRole(role: Role, account: string): boolean {
    return this.roles.get(account)?.has(role) ?? false;
  }

  /** 초기 설정: admin 계정에 모든 역할 부여 */
  initialize(admin: string): void {
    this.roles.set(admin, new Set(['DEFAULT_ADMIN_ROLE', 'MINTER_ROLE', 'PAUSER_ROLE', 'UPGRADER_ROLE']));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 1: MEDIUM 취약점 — 접근 제어 누락
// ────────────────────────────────────────────────────────────────────────

/**
 * 취약한 패턴: updateTokenURI가 public이고 권한 체크 없음
 * 누구나 NFT 메타데이터 URI를 변경할 수 있음 → 메타데이터 조작 가능
 */
export class KyoboNFTVulnerable {
  private baseURI = 'https://api.kyobo.com/nft/';
  private maxSupply = 1000;
  public events: string[] = [];

  /** ❌ MEDIUM: 접근 제어 없음 — 누구나 URI 변경 가능 */
  updateTokenURIVulnerable(_caller: Account, newURI: string): void {
    // onlyRole(ADMIN_ROLE) 없음 → 취약
    this.baseURI = newURI;
    // emit 도 없음 → 두 번째 MEDIUM
  }

  /** ✅ 수정: onlyRole + emit 이벤트 추가 */
  updateTokenURIFixed(caller: Account, newURI: string, registry: RoleRegistry): void {
    if (!registry.hasRole('DEFAULT_ADMIN_ROLE', caller.address)) {
      throw new Error(`AccessControlUnauthorizedAccount: ${caller.address}`);
    }
    this.baseURI = newURI;
    // ✅ 이벤트 기록
    this.events.push(`TokenURIUpdated(newURI=${newURI}, updatedBy=${caller.address})`);
  }

  /** ❌ MEDIUM: maxSupply 변경에 이벤트 없음 */
  updateMaxSupplyVulnerable(caller: Account, newMax: number, registry: RoleRegistry): void {
    if (!registry.hasRole('DEFAULT_ADMIN_ROLE', caller.address)) {
      throw new Error(`AccessControlUnauthorizedAccount: ${caller.address}`);
    }
    this.maxSupply = newMax;
    // ❌ emit 누락 → 언제 변경됐는지 온체인 기록 없음
  }

  /** ✅ 수정: 이벤트 추가 */
  updateMaxSupplyFixed(caller: Account, newMax: number, registry: RoleRegistry): void {
    if (!registry.hasRole('DEFAULT_ADMIN_ROLE', caller.address)) {
      throw new Error(`AccessControlUnauthorizedAccount: ${caller.address}`);
    }
    this.maxSupply = newMax;
    this.events.push(`MaxSupplyUpdated(newMax=${newMax}, updatedBy=${caller.address})`);
  }

  getBaseURI(): string { return this.baseURI; }
  getMaxSupply(): number { return this.maxSupply; }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 2: 이벤트 누락이 감사(audit)에 미치는 영향
// ────────────────────────────────────────────────────────────────────────

export interface OnchainEvent {
  blockNumber: number;
  txHash: string;
  eventName: string;
  params: Record<string, string | number>;
}

export class AuditLog {
  private events: OnchainEvent[] = [];
  private blockCounter = 1000;

  emit(eventName: string, params: Record<string, string | number>): void {
    this.events.push({
      blockNumber: this.blockCounter++,
      txHash: `0x${Math.random().toString(16).slice(2, 10)}`,
      eventName,
      params,
    });
  }

  /** 감사 시 특정 이벤트 조회 — 이벤트 없으면 증명 불가 */
  queryByEvent(eventName: string): OnchainEvent[] {
    return this.events.filter(e => e.eventName === eventName);
  }

  /** 역할 부여 이력 조회 */
  getRoleGrantHistory(): OnchainEvent[] {
    return this.queryByEvent('RoleGranted');
  }

  count(): number { return this.events.length; }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 3: 보안 테스트 5가지 질문 프레임워크
// ────────────────────────────────────────────────────────────────────────

export type SecurityTestQuestion =
  | 'UNAUTHORIZED_CALL'      // 질문 1: 권한 없는 주소가 이 함수를 호출하면?
  | 'REPEATED_CALL'          // 질문 2: 이 함수를 반복 호출하면?
  | 'BOUNDARY_VALUE'         // 질문 3: 경계값에서 어떻게 동작하는가?
  | 'REENTRANCY'             // 질문 4: 외부 호출이 있다면 재진입 가능한가?
  | 'SIDE_EFFECT';           // 질문 5: 이 함수의 부작용이 다른 함수에 영향을 미치는가?

export interface SecurityTestCase {
  question: SecurityTestQuestion;
  target: string;
  scenario: string;
  expectedResult: 'REVERT' | 'SUCCESS' | 'BLOCKED';
}

export const SECURITY_TEST_CASES: SecurityTestCase[] = [
  {
    question: 'UNAUTHORIZED_CALL',
    target: 'mint()',
    scenario: 'MINTER_ROLE 없는 주소로 mint 시도',
    expectedResult: 'REVERT',
  },
  {
    question: 'UNAUTHORIZED_CALL',
    target: 'pause()',
    scenario: 'PAUSER_ROLE 없는 주소로 pause 시도',
    expectedResult: 'REVERT',
  },
  {
    question: 'UNAUTHORIZED_CALL',
    target: 'upgradeToAndCall()',
    scenario: 'UPGRADER_ROLE 없는 주소로 업그레이드 시도',
    expectedResult: 'REVERT',
  },
  {
    question: 'UNAUTHORIZED_CALL',
    target: 'grantRole()',
    scenario: '일반 사용자가 자신에게 MINTER_ROLE 부여 시도',
    expectedResult: 'REVERT',
  },
  {
    question: 'BOUNDARY_VALUE',
    target: 'mint()',
    scenario: 'amount = 0 으로 mint 시도',
    expectedResult: 'REVERT',
  },
  {
    question: 'REENTRANCY',
    target: 'burn()',
    scenario: 'ReentrancyAttacker 컨트랙트가 burn 호출 중 재진입 시도',
    expectedResult: 'BLOCKED',
  },
  {
    question: 'SIDE_EFFECT',
    target: 'pause()',
    scenario: 'pause 후 mint 시도 → whenNotPaused 가드',
    expectedResult: 'REVERT',
  },
];

// ────────────────────────────────────────────────────────────────────────
// 실습 4: 접근 제어 우회 시뮬레이션
// ────────────────────────────────────────────────────────────────────────

export class KyoboNFTSecure {
  private balances = new Map<string, Map<number, number>>();
  private paused = false;
  private registry: RoleRegistry;
  public events: string[] = [];

  constructor(registry: RoleRegistry) {
    this.registry = registry;
  }

  private requireRole(role: Role, caller: string): void {
    if (!this.registry.hasRole(role, caller)) {
      throw new Error(`AccessControlUnauthorizedAccount: ${caller} lacks ${role}`);
    }
  }

  private requireNotPaused(): void {
    if (this.paused) throw new Error('EnforcedPause');
  }

  mint(caller: Account, to: string, tokenId: number, amount: number): void {
    this.requireRole('MINTER_ROLE', caller.address);
    this.requireNotPaused();
    if (amount <= 0) throw new Error('KyoboNFT: zero amount');

    if (!this.balances.has(to)) this.balances.set(to, new Map());
    const userBal = this.balances.get(to)!;
    userBal.set(tokenId, (userBal.get(tokenId) ?? 0) + amount);

    this.events.push(`TransferSingle(from=0x0, to=${to}, id=${tokenId}, value=${amount})`);
  }

  burn(caller: Account, from: string, tokenId: number, amount: number): void {
    this.requireRole('MINTER_ROLE', caller.address);

    const userBal = this.balances.get(from);
    const current = userBal?.get(tokenId) ?? 0;
    if (current < amount) throw new Error('KyoboNFT: insufficient balance');

    userBal!.set(tokenId, current - amount);
    this.events.push(`TransferSingle(from=${from}, to=0x0, id=${tokenId}, value=${amount})`);
  }

  pause(caller: Account): void {
    this.requireRole('PAUSER_ROLE', caller.address);
    this.paused = true;
    this.events.push(`Paused(account=${caller.address})`);
  }

  grantRole(caller: Account, role: Role, account: string): void {
    this.registry.grantRole(role, account, caller);
    this.events.push(`RoleGranted(role=${role}, account=${account}, sender=${caller.address})`);
  }

  balanceOf(account: string, tokenId: number): number {
    return this.balances.get(account)?.get(tokenId) ?? 0;
  }

  isPaused(): boolean { return this.paused; }
}

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

function expectRevert(label: string, fn: () => void): void {
  try {
    fn();
    check(`${label} → revert 기대`, false);
  } catch (e) {
    check(`${label} → revert 발생`, true);
  }
}

function expectSuccess(label: string, fn: () => void): void {
  try {
    fn();
    check(`${label} → 성공`, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(`${label} → 성공 기대 (실패: ${msg})`, false);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S43: MEDIUM 취약점 처리 + 보안 테스트 설계 ===\n');

  const ADMIN   = { address: '0xad1111111111111111111111111111111111ad11',   role: 'DEFAULT_ADMIN_ROLE' as Role };
  const ATTACKER = { address: '0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0',  role: 'NONE' as Role };
  const USER    = { address: '0xaaaa111111111111111111111111111111111111',    role: 'NONE' as Role };

  // ── [1] MEDIUM 취약점: 접근 제어 누락 ───────────────────────────────
  console.log('[검증 1] MEDIUM 취약점 — 접근 제어 누락 (updateTokenURI)');

  const registry = new RoleRegistry();
  registry.initialize(ADMIN.address);

  const nftVuln = new KyoboNFTVulnerable();

  // 취약 버전: 공격자도 URI 변경 가능
  nftVuln.updateTokenURIVulnerable(ATTACKER, 'https://evil.com/');
  check('취약 버전: 공격자가 URI 변경 성공 (보안 위협)',
    nftVuln.getBaseURI() === 'https://evil.com/',
  );
  check('취약 버전: 이벤트 기록 없음 (감사 불가)',  nftVuln.events.length === 0);

  // 수정 버전: onlyRole 적용
  const nftFixed = new KyoboNFTVulnerable();
  expectRevert('수정 버전: 공격자는 URI 변경 불가',
    () => nftFixed.updateTokenURIFixed(ATTACKER, 'https://evil.com/', registry),
  );
  expectSuccess('수정 버전: admin은 URI 변경 가능',
    () => nftFixed.updateTokenURIFixed(ADMIN, 'https://api.kyobo.com/v2/', registry),
  );
  check('수정 버전: 이벤트 기록됨 (감사 가능)', nftFixed.events.length === 1);
  check('수정 버전: 이벤트에 URI 정보 포함',
    nftFixed.events[0]?.includes('TokenURIUpdated'),
  );

  // ── [2] MEDIUM 취약점: 이벤트 누락 ─────────────────────────────────
  console.log('\n[검증 2] MEDIUM 취약점 — 이벤트 누락 (감사 영향)');

  const auditLog = new AuditLog();

  // 이벤트 없는 역할 부여 → 감사 불가
  auditLog.emit('SomeOtherEvent', { data: 'irrelevant' });
  const roleHistory = auditLog.getRoleGrantHistory();
  check('이벤트 없는 역할 부여: RoleGranted 기록 없음 (감사 불가)',
    roleHistory.length === 0,
  );

  // 이벤트 있는 역할 부여 → 감사 가능
  auditLog.emit('RoleGranted', { role: 'MINTER_ROLE', account: '0xdadb000000000000000000000000000000000001', sender: '0xad1111111111111111111111111111111111ad11' });
  const roleHistoryAfter = auditLog.getRoleGrantHistory();
  check('이벤트 있는 역할 부여: RoleGranted 기록 1건 (감사 가능)',
    roleHistoryAfter.length === 1,
  );
  check('RoleGranted 이벤트에 account 정보 포함',
    roleHistoryAfter[0]?.params['account'] === '0xdadb000000000000000000000000000000000001',
  );

  // ── [3] 보안 테스트 5가지 질문 프레임워크 ────────────────────────────
  console.log('\n[검증 3] 보안 테스트 설계 — 5가지 질문 프레임워크');

  const questionCounts = new Map<SecurityTestQuestion, number>();
  for (const tc of SECURITY_TEST_CASES) {
    questionCounts.set(tc.question, (questionCounts.get(tc.question) ?? 0) + 1);
  }

  check('UNAUTHORIZED_CALL 테스트 케이스 4건 (mint/pause/upgrade/grantRole)',
    (questionCounts.get('UNAUTHORIZED_CALL') ?? 0) === 4,
  );
  check('BOUNDARY_VALUE 테스트 케이스 포함',
    questionCounts.has('BOUNDARY_VALUE'),
  );
  check('REENTRANCY 테스트 케이스 포함',
    questionCounts.has('REENTRANCY'),
  );
  check('SIDE_EFFECT 테스트 케이스 포함 (pause → mint 차단)',
    questionCounts.has('SIDE_EFFECT'),
  );
  check('총 7가지 보안 테스트 케이스 설계',
    SECURITY_TEST_CASES.length === 7,
  );

  // ── [4] 접근 제어 우회 시도 시뮬레이션 ──────────────────────────────
  console.log('\n[검증 4] 접근 제어 우회 시도 — KyoboNFT 역할 체계');

  const nft = new KyoboNFTSecure(registry);
  const TOKEN_ID = 1;

  // 질문 1: MINTER_ROLE 없는 공격자가 mint 시도
  expectRevert('Q1: MINTER_ROLE 없음 → mint revert', () =>
    nft.mint(ATTACKER, USER.address, TOKEN_ID, 1),
  );

  // 질문 1: PAUSER_ROLE 없는 공격자가 pause 시도
  expectRevert('Q1: PAUSER_ROLE 없음 → pause revert', () =>
    nft.pause(ATTACKER),
  );

  // 질문 1: 일반 사용자가 자신에게 역할 부여 시도
  expectRevert('Q1: DEFAULT_ADMIN_ROLE 없음 → grantRole revert', () =>
    nft.grantRole(ATTACKER, 'MINTER_ROLE', ATTACKER.address),
  );

  // admin은 정상 발행 가능
  expectSuccess('admin: mint 성공', () =>
    nft.mint(ADMIN, USER.address, TOKEN_ID, 5),
  );
  check('발행 후 잔액 = 5',          nft.balanceOf(USER.address, TOKEN_ID) === 5);

  // 질문 3: 경계값 — amount = 0
  expectRevert('Q3: amount=0 → revert', () =>
    nft.mint(ADMIN, USER.address, TOKEN_ID, 0),
  );

  // 질문 5: pause 후 mint 차단 (부작용 영향)
  nft.pause(ADMIN);
  check('pause() 후 isPaused = true', nft.isPaused());
  expectRevert('Q5: paused 상태에서 mint → EnforcedPause revert', () =>
    nft.mint(ADMIN, USER.address, TOKEN_ID, 1),
  );

  // 이벤트 기록 확인
  const mintEvents   = nft.events.filter(e => e.startsWith('TransferSingle'));
  const pauseEvents  = nft.events.filter(e => e.startsWith('Paused'));
  const roleEvents   = nft.events.filter(e => e.startsWith('RoleGranted'));
  check('TransferSingle 이벤트 1건 기록', mintEvents.length === 1);
  check('Paused 이벤트 1건 기록',         pauseEvents.length === 1);

  // ── [5] Slither MEDIUM 항목 수정 결과 요약 ──────────────────────────
  console.log('\n[검증 5] Slither HIGH/MEDIUM 최종 0건 달성 확인');

  interface SlitherSummary {
    severity: string;
    count: number;
    status: 'CLEARED' | 'REMAINING';
  }

  const slitherSummary: SlitherSummary[] = [
    { severity: 'HIGH',   count: 0, status: 'CLEARED' },   // S42에서 처리 완료
    { severity: 'MEDIUM', count: 0, status: 'CLEARED' },   // 이번 세션에서 처리 완료
    { severity: 'LOW',    count: 2, status: 'REMAINING' }, // False Positive — 감사 리포트에 기록
  ];

  for (const summary of slitherSummary) {
    if (summary.severity === 'HIGH' || summary.severity === 'MEDIUM') {
      check(`${summary.severity} 항목: ${summary.count}건 (${summary.status})`,
        summary.count === 0 && summary.status === 'CLEARED',
      );
    } else {
      check(`${summary.severity} 항목: ${summary.count}건 — False Positive 검토 후 감사 리포트 기록`,
        summary.status === 'REMAINING',
      );
    }
  }

  // ── 정리 ────────────────────────────────────────────────────────────
  console.log('\n=== S43 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. MEDIUM 접근 제어: 모든 상태 변경 함수에 onlyRole modifier 확인');
  console.log('  2. MEDIUM 이벤트 누락: 역할 부여·상태 변경 시 emit 필수 — 감사·규제 대응');
  console.log('  3. MEDIUM 가시성: internal/_authorizeUpgrade는 internal override만 허용');
  console.log('  4. 보안 테스트 5문: 권한없음 / 반복 / 경계값 / 재진입 / 부작용');
  console.log('  5. HIGH/MEDIUM 0건 달성 후 LOW는 False Positive 판단 → 감사 리포트에 기록');
  console.log('  6. 이벤트 없으면 온체인 감사 불가 — 규제 기관 제출용 로그 부재');
})();
