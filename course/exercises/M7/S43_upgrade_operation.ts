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
// 역할(Role) 정의 (수정하지 말 것)
// ────────────────────────────────────────────────────────────────────────

export type Role = 'DEFAULT_ADMIN_ROLE' | 'MINTER_ROLE' | 'PAUSER_ROLE' | 'UPGRADER_ROLE' | 'NONE';

export interface Account {
  address: string;
  role: Role;
}

// ────────────────────────────────────────────────────────────────────────
// TODO 1: RoleRegistry 클래스 구현
//
// KyoboNFT AccessControl 역할 레지스트리를 시뮬레이션한다.
//
// 구현 지시:
//   private roles = new Map<string, Set<Role>>()
//
//   grantRole(role, account, caller):
//     - caller가 DEFAULT_ADMIN_ROLE을 보유하지 않으면 throw Error
//     - roles 맵에 account가 없으면 새 Set을 생성
//     - roles.get(account).add(role)
//
//   hasRole(role, account):
//     - roles.get(account)?.has(role) ?? false 반환
//
//   initialize(admin):
//     - admin에게 DEFAULT_ADMIN_ROLE, MINTER_ROLE, PAUSER_ROLE, UPGRADER_ROLE 모두 부여
// ────────────────────────────────────────────────────────────────────────

export class RoleRegistry {
  private roles = new Map<string, Set<Role>>();

  grantRole(role: Role, account: string, caller: Account): void {
    throw new Error('TODO: 구현하세요');
  }

  hasRole(role: Role, account: string): boolean {
    throw new Error('TODO: 구현하세요');
  }

  initialize(admin: string): void {
    throw new Error('TODO: 구현하세요');
  }
}

// ────────────────────────────────────────────────────────────────────────
// KyoboNFTVulnerable (보조 클래스 — 완성 코드 제공, 수정하지 말 것)
//
// 취약 버전과 수정 버전을 모두 포함하여 비교 학습에 활용한다.
// ────────────────────────────────────────────────────────────────────────

export class KyoboNFTVulnerable {
  private baseURI = 'https://api.kyobo.com/nft/';
  private maxSupply = 1000;
  public events: string[] = [];

  /** ❌ MEDIUM: 접근 제어 없음 — 누구나 URI 변경 가능 */
  updateTokenURIVulnerable(_caller: Account, newURI: string): void {
    this.baseURI = newURI;
    // emit 도 없음
  }

  /** ✅ 수정: onlyRole + emit 이벤트 추가 */
  updateTokenURIFixed(caller: Account, newURI: string, registry: RoleRegistry): void {
    if (!registry.hasRole('DEFAULT_ADMIN_ROLE', caller.address)) {
      throw new Error(`AccessControlUnauthorizedAccount: ${caller.address}`);
    }
    this.baseURI = newURI;
    this.events.push(`TokenURIUpdated(newURI=${newURI}, updatedBy=${caller.address})`);
  }

  /** ❌ MEDIUM: maxSupply 변경에 이벤트 없음 */
  updateMaxSupplyVulnerable(caller: Account, newMax: number, registry: RoleRegistry): void {
    if (!registry.hasRole('DEFAULT_ADMIN_ROLE', caller.address)) {
      throw new Error(`AccessControlUnauthorizedAccount: ${caller.address}`);
    }
    this.maxSupply = newMax;
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
// AuditLog (보조 클래스 — 완성 코드 제공, 수정하지 말 것)
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

  queryByEvent(eventName: string): OnchainEvent[] {
    return this.events.filter(e => e.eventName === eventName);
  }

  getRoleGrantHistory(): OnchainEvent[] {
    return this.queryByEvent('RoleGranted');
  }

  count(): number { return this.events.length; }
}

// ────────────────────────────────────────────────────────────────────────
// 보안 테스트 프레임워크 (수정하지 말 것)
// ────────────────────────────────────────────────────────────────────────

export type SecurityTestQuestion =
  | 'UNAUTHORIZED_CALL'
  | 'REPEATED_CALL'
  | 'BOUNDARY_VALUE'
  | 'REENTRANCY'
  | 'SIDE_EFFECT';

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
// TODO 2: KyoboNFTSecure 클래스 구현
//
// MINTER/PAUSER 역할 체계 + pause 기능을 갖춘 보안 컨트랙트 시뮬레이션.
//
// 구현 지시:
//   private balances = new Map<string, Map<number, number>>()
//   private paused = false
//   public events: string[] = []
//
//   requireRole(role, caller):
//     - registry.hasRole가 false이면 throw Error('AccessControlUnauthorizedAccount: ...')
//
//   requireNotPaused():
//     - paused가 true이면 throw Error('EnforcedPause')
//
//   mint(caller, to, tokenId, amount):
//     - requireRole('MINTER_ROLE', caller.address)
//     - requireNotPaused()
//     - amount <= 0 이면 throw Error('KyoboNFT: zero amount')
//     - balances 업데이트
//     - events.push('TransferSingle(from=0x0, to=..., id=..., value=...)')
//
//   pause(caller):
//     - requireRole('PAUSER_ROLE', caller.address)
//     - paused = true
//     - events.push('Paused(account=...)')
//
//   grantRole(caller, role, account):
//     - registry.grantRole(role, account, caller)
//     - events.push('RoleGranted(role=..., account=..., sender=...)')
//
//   balanceOf(account, tokenId): 잔액 반환
//   isPaused(): paused 반환
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
    throw new Error('TODO: 구현하세요');
  }

  private requireNotPaused(): void {
    throw new Error('TODO: 구현하세요');
  }

  mint(caller: Account, to: string, tokenId: number, amount: number): void {
    throw new Error('TODO: 구현하세요');
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
    throw new Error('TODO: 구현하세요');
  }

  grantRole(caller: Account, role: Role, account: string): void {
    throw new Error('TODO: 구현하세요');
  }

  balanceOf(account: string, tokenId: number): number {
    return this.balances.get(account)?.get(tokenId) ?? 0;
  }

  isPaused(): boolean { return this.paused; }
}

// ────────────────────────────────────────────────────────────────────────
// 헬퍼 (수정하지 말 것)
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

function expectRevert(label: string, fn: () => void): void {
  try {
    fn();
    check(`${label} → revert 기대`, false);
  } catch (_e) {
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
// 실습 진입점 (수정하지 말 것)
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S43: MEDIUM 취약점 처리 + 보안 테스트 설계 ===\n');

  const ADMIN   = { address: '0xADMIN',   role: 'DEFAULT_ADMIN_ROLE' as Role };
  const ATTACKER = { address: '0xATTACK',  role: 'NONE' as Role };
  const USER    = { address: '0xUSER',    role: 'NONE' as Role };

  // ── [1] MEDIUM 취약점: 접근 제어 누락 ───────────────────────────────
  console.log('[검증 1] MEDIUM 취약점 — 접근 제어 누락 (updateTokenURI)');

  const registry = new RoleRegistry();
  registry.initialize(ADMIN.address);

  const nftVuln = new KyoboNFTVulnerable();

  nftVuln.updateTokenURIVulnerable(ATTACKER, 'https://evil.com/');
  check('취약 버전: 공격자가 URI 변경 성공 (보안 위협)',
    nftVuln.getBaseURI() === 'https://evil.com/',
  );
  check('취약 버전: 이벤트 기록 없음 (감사 불가)',  nftVuln.events.length === 0);

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

  auditLog.emit('SomeOtherEvent', { data: 'irrelevant' });
  const roleHistory = auditLog.getRoleGrantHistory();
  check('이벤트 없는 역할 부여: RoleGranted 기록 없음 (감사 불가)',
    roleHistory.length === 0,
  );

  auditLog.emit('RoleGranted', { role: 'MINTER_ROLE', account: '0xVASP', sender: '0xADMIN' });
  const roleHistoryAfter = auditLog.getRoleGrantHistory();
  check('이벤트 있는 역할 부여: RoleGranted 기록 1건 (감사 가능)',
    roleHistoryAfter.length === 1,
  );
  check('RoleGranted 이벤트에 account 정보 포함',
    roleHistoryAfter[0]?.params['account'] === '0xVASP',
  );

  // ── [3] 보안 테스트 5가지 질문 프레임워크 ────────────────────────────
  console.log('\n[검증 3] 보안 테스트 설계 — 5가지 질문 프레임워크');

  const questionCounts = new Map<SecurityTestQuestion, number>();
  for (const tc of SECURITY_TEST_CASES) {
    questionCounts.set(tc.question, (questionCounts.get(tc.question) ?? 0) + 1);
  }

  check('UNAUTHORIZED_CALL 테스트 케이스 4건',
    (questionCounts.get('UNAUTHORIZED_CALL') ?? 0) === 4,
  );
  check('BOUNDARY_VALUE 테스트 케이스 포함', questionCounts.has('BOUNDARY_VALUE'));
  check('REENTRANCY 테스트 케이스 포함',     questionCounts.has('REENTRANCY'));
  check('SIDE_EFFECT 테스트 케이스 포함',    questionCounts.has('SIDE_EFFECT'));
  check('총 7가지 보안 테스트 케이스 설계',   SECURITY_TEST_CASES.length === 7);

  // ── [4] 접근 제어 우회 시도 시뮬레이션 ──────────────────────────────
  console.log('\n[검증 4] 접근 제어 우회 시도 — KyoboNFT 역할 체계');

  const nft = new KyoboNFTSecure(registry);
  const TOKEN_ID = 1;

  expectRevert('Q1: MINTER_ROLE 없음 → mint revert', () =>
    nft.mint(ATTACKER, USER.address, TOKEN_ID, 1),
  );
  expectRevert('Q1: PAUSER_ROLE 없음 → pause revert', () =>
    nft.pause(ATTACKER),
  );
  expectRevert('Q1: DEFAULT_ADMIN_ROLE 없음 → grantRole revert', () =>
    nft.grantRole(ATTACKER, 'MINTER_ROLE', ATTACKER.address),
  );
  expectSuccess('admin: mint 성공', () =>
    nft.mint(ADMIN, USER.address, TOKEN_ID, 5),
  );
  check('발행 후 잔액 = 5',          nft.balanceOf(USER.address, TOKEN_ID) === 5);
  expectRevert('Q3: amount=0 → revert', () =>
    nft.mint(ADMIN, USER.address, TOKEN_ID, 0),
  );
  nft.pause(ADMIN);
  check('pause() 후 isPaused = true', nft.isPaused());
  expectRevert('Q5: paused 상태에서 mint → EnforcedPause revert', () =>
    nft.mint(ADMIN, USER.address, TOKEN_ID, 1),
  );

  const mintEvents  = nft.events.filter(e => e.startsWith('TransferSingle'));
  const pauseEvents = nft.events.filter(e => e.startsWith('Paused'));
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
    { severity: 'HIGH',   count: 0, status: 'CLEARED' },
    { severity: 'MEDIUM', count: 0, status: 'CLEARED' },
    { severity: 'LOW',    count: 2, status: 'REMAINING' },
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
