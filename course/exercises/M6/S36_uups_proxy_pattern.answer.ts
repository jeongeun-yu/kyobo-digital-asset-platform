/**
 * S36 실습 — UUPS 프록시 패턴과 Storage Collision
 *
 * 강의 노트: M6_S36_uups_proxy_pattern.md
 *
 * 실행 방법 (루트에서): npm run exercise:s36
 *
 * 목표:
 *   [1] delegatecall 동작 원리 — Proxy는 상태, Implementation은 코드
 *   [2] initialize() vs constructor() — 왜 프록시에서 constructor가 무효한가
 *   [3] initializer modifier 없을 때 재호출 공격 시뮬레이션
 *   [4] Storage Collision — 앞에 변수 삽입 시 슬롯 밀림 시뮬레이션
 *   [5] 투명 프록시 vs UUPS 차이점 비교
 *
 * 전제 조건:
 *   Hardhat 불필요 — 순수 TypeScript 로직 검증
 *
 * Hardhat 실습 (로컬 노드 필요):
 *   cd blockchain && npx hardhat test test/KyoboNFT.test.ts --grep "initialize"
 */

// ────────────────────────────────────────────────────────────────────────
// [1] delegatecall 동작 원리 모델링
//
// 실제 EVM delegatecall을 TypeScript로 시뮬레이션:
//   - Proxy가 상태(storage)를 보유
//   - Implementation이 로직을 보유
//   - 코드는 Implementation에서 가져오지만 상태는 Proxy에 저장됨
// ────────────────────────────────────────────────────────────────────────

export interface Storage {
  [slot: number]: unknown;
}

export class ProxySimulator {
  /** Proxy의 storage — 실제 상태가 여기에 저장됨 */
  readonly proxyStorage: Storage = {};

  private implementationV1: ImplementationV1 | null = null;
  private implementationV2: ImplementationV2 | null = null;
  private currentVersion: 1 | 2 = 1;

  setImplementation(v: 1 | 2): void {
    if (v === 1) {
      this.implementationV1 = new ImplementationV1(this.proxyStorage);
      this.currentVersion = 1;
    } else {
      this.implementationV2 = new ImplementationV2(this.proxyStorage);
      this.currentVersion = 2;
    }
  }

  /** delegatecall: Implementation 코드 실행, Proxy storage에 상태 저장 */
  call(method: string, ...args: unknown[]): unknown {
    if (this.currentVersion === 1 && this.implementationV1) {
      return (this.implementationV1 as unknown as Record<string, (...a: unknown[]) => unknown>)[method]?.(...args);
    }
    if (this.currentVersion === 2 && this.implementationV2) {
      return (this.implementationV2 as unknown as Record<string, (...a: unknown[]) => unknown>)[method]?.(...args);
    }
    throw new Error(`Method ${method} not found`);
  }
}

/** v1 Implementation — 로직만, 상태 없음 */
export class ImplementationV1 {
  constructor(private readonly storage: Storage) {}

  initialize(admin: string): void {
    if (this.storage[0] !== undefined) {
      throw new Error('InvalidInitialization: already initialized');
    }
    this.storage[0] = admin;   // slot 0: DEFAULT_ADMIN_ROLE holder
    this.storage[1] = false;   // slot 1: _paused
  }

  getAdmin(): string | undefined {
    return this.storage[0] as string | undefined;
  }

  isPaused(): boolean {
    return this.storage[1] as boolean ?? false;
  }

  setValue(slot: number, value: unknown): void {
    this.storage[slot] = value;
  }
}

/** v2 Implementation — 새 변수를 끝에 추가 (slot 2+) */
export class ImplementationV2 {
  constructor(private readonly storage: Storage) {}

  // 기존 슬롯 레이아웃 완전 유지
  getAdmin(): string | undefined { return this.storage[0] as string | undefined; }
  isPaused(): boolean            { return this.storage[1] as boolean ?? false; }

  // v2 신규 기능: slot 2에 새 변수 (끝에 추가)
  initializeV2(baseUri: string): void {
    if (this.storage[2] !== undefined) {
      throw new Error('InvalidInitialization: v2 already initialized');
    }
    this.storage[2] = baseUri;
  }

  getBaseUri(): string | undefined { return this.storage[2] as string | undefined; }
}

/** v2_BAD — 앞에 새 변수 삽입 (Storage Collision 유발) */
export class ImplementationV2_BAD {
  constructor(private readonly storage: Storage) {}

  // 새 변수가 slot 0에 삽입됨 → 기존 admin이 slot 0에서 밀려남!
  getNewFeature(): unknown { return this.storage[0]; }  // slot 0 → 원래 admin 주소가 여기 있음
  getAdmin(): unknown      { return this.storage[1]; }  // slot 1 → 원래 _paused(bool)가 여기 있음
}

// ────────────────────────────────────────────────────────────────────────
// [3] initializer 없는 취약 컨트랙트 시뮬레이션
// ────────────────────────────────────────────────────────────────────────

export class VulnerableImpl {
  private admin: string | null = null;

  /** initializer modifier 없음 — 재호출 가능! */
  initialize(admin: string): void {
    this.admin = admin;
  }

  getAdmin(): string | null { return this.admin; }
}

export class SafeImpl {
  private admin: string | null = null;
  private initialized = false;

  /** initializer modifier 있음 — 한 번만 실행 보장 */
  initialize(admin: string): void {
    if (this.initialized) {
      throw new Error('InvalidInitialization: already initialized');
    }
    this.initialized = true;
    this.admin = admin;
  }

  getAdmin(): string | null { return this.admin; }
}

// ERC-1967 표준 슬롯 상수
export const ERC1967_IMPL_SLOT  = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const ERC1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

function expectThrows(label: string, fn: () => void): void {
  try {
    fn();
    check(`${label} → 예외 발생해야 함`, false);
  } catch {
    check(`${label} → 예외 발생 (정상)`, true);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S36: UUPS 프록시 패턴과 Storage Collision ===\n');

  // ── [1] delegatecall 동작 원리 ───────────────────────────────────────
  console.log('[검증 1] delegatecall — Proxy storage, Implementation logic');

  const proxy = new ProxySimulator();
  proxy.setImplementation(1);
  proxy.call('initialize', '0xad1111111111111111111111111111111111ad11');

  check('initialize() → Proxy storage[0]에 admin 저장', proxy.proxyStorage[0] === '0xad1111111111111111111111111111111111ad11');
  check('Proxy storage[1]에 _paused=false 저장',        proxy.proxyStorage[1] === false);
  check('getAdmin() → Proxy storage에서 읽기',          proxy.call('getAdmin') === '0xad1111111111111111111111111111111111ad11');

  // ── [2] 업그레이드 후 상태 보존 (올바른 v2) ──────────────────────────
  console.log('\n[검증 2] 올바른 v2 업그레이드 — 기존 상태 보존');

  proxy.setImplementation(2);  // Implementation 교체 (Proxy storage는 그대로)
  proxy.call('initializeV2', 'https://api.kyobo.com/');

  check('v2 업그레이드 후 admin 데이터 유지',     proxy.call('getAdmin') === '0xad1111111111111111111111111111111111ad11');
  check('v2 업그레이드 후 paused 상태 유지',      proxy.call('isPaused') === false);
  check('v2 새 기능(baseUri) slot 2에 정상 저장', proxy.call('getBaseUri') === 'https://api.kyobo.com/');
  check('기존 데이터(slot 0, 1) 변경 없음',       proxy.proxyStorage[2] === 'https://api.kyobo.com/');

  // ── [3] Storage Collision — 앞에 삽입 시 슬롯 밀림 ──────────────────
  console.log('\n[검증 3] Storage Collision — BAD v2로 슬롯 해석 오염');

  // Proxy storage에는 slot 0 = admin('0xad1111111111111111111111111111111111ad11'), slot 1 = false(_paused) 존재
  // BAD Implementation이 slot 0을 newFeature로, slot 1을 admin으로 해석하면?
  const badImpl = new ImplementationV2_BAD(proxy.proxyStorage);

  // slot 0은 원래 admin 주소인데 BAD impl은 이를 newFeature로 읽음
  check(
    'BAD v2: slot 0(원래 admin)을 newFeature로 잘못 해석',
    badImpl.getNewFeature() === '0xad1111111111111111111111111111111111ad11',  // admin 주소가 newFeature로 오염
  );
  // slot 1은 원래 _paused(false)인데 BAD impl은 이를 admin으로 읽음
  check(
    'BAD v2: slot 1(원래 _paused=false)을 admin으로 잘못 해석',
    badImpl.getAdmin() === false,  // false가 admin으로 오염 → 주소가 아님
  );
  check(
    'BAD v2 upgrade 후 원래 admin 주소를 getAdmin()으로 찾을 수 없음',
    typeof badImpl.getAdmin() !== 'string',  // string이어야 하는데 boolean → 파괴됨
  );

  // ── [4] initializer 취약 컨트랙트 공격 시뮬레이션 ───────────────────
  console.log('\n[검증 4] initializer 없는 취약 컨트랙트 — 재호출 공격');

  const vulnerable = new VulnerableImpl();
  vulnerable.initialize('0xde910000000000000000000000000000000000de');
  check('초기 배포 후 admin = 0xDeployer', vulnerable.getAdmin() === '0xde910000000000000000000000000000000000de');

  // 공격자가 initialize 재호출
  vulnerable.initialize('0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0');
  check(
    '취약: initializer 없으면 공격자가 initialize 재호출 가능',
    vulnerable.getAdmin() === '0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0',  // admin 탈취됨
  );

  // ── [5] 안전한 컨트랙트 — initializer 보호 ───────────────────────────
  console.log('\n[검증 5] initializer modifier — 한 번만 실행 보장');

  const safe = new SafeImpl();
  safe.initialize('0xde910000000000000000000000000000000000de');
  check('초기 배포 후 admin = 0xDeployer', safe.getAdmin() === '0xde910000000000000000000000000000000000de');

  expectThrows(
    '안전: 재호출 시 InvalidInitialization 발생',
    () => safe.initialize('0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0'),
  );
  check('재호출 시도 후에도 admin은 0xDeployer 유지', safe.getAdmin() === '0xde910000000000000000000000000000000000de');

  // ── [6] 투명 프록시 vs UUPS 비교 ─────────────────────────────────────
  console.log('\n[검증 6] 투명 프록시 vs UUPS 특성 비교');

  const comparison = {
    transparent: {
      upgradeLocation: 'ProxyContract',
      gasOverhead: 'high',   // 모든 호출마다 admin 체크
      deploymentCost: 'high',
      mainRisk: 'ProxyAdmin key loss',
    },
    uups: {
      upgradeLocation: 'ImplementationContract',
      gasOverhead: 'low',
      deploymentCost: 'low',
      mainRisk: '_authorizeUpgrade missing → anyone can upgrade',
    },
  };

  check('UUPS: 업그레이드 함수가 Implementation에 위치', comparison.uups.upgradeLocation === 'ImplementationContract');
  check('UUPS: 가스 오버헤드 낮음',                      comparison.uups.gasOverhead === 'low');
  check('투명 프록시: 가스 오버헤드 높음',               comparison.transparent.gasOverhead === 'high');
  check('UUPS 주요 위험: _authorizeUpgrade 누락',        comparison.uups.mainRisk.includes('_authorizeUpgrade'));

  // ── [7] ERC-1967 슬롯 — Implementation 주소 저장 위치 ────────────────
  console.log('\n[검증 7] ERC-1967 표준 슬롯 주소 확인');

  check('ERC-1967 Implementation 슬롯 주소 확인', ERC1967_IMPL_SLOT.startsWith('0x360894'));
  check('ERC-1967 Admin 슬롯 주소 확인',          ERC1967_ADMIN_SLOT.startsWith('0xb53127'));
  check(
    'Implementation 슬롯이 일반 slot 0~5와 겹치지 않음 (특수 슬롯)',
    (ERC1967_IMPL_SLOT as string) !== '0x0000000000000000000000000000000000000000000000000000000000000000',
  );

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S36 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. delegatecall: Implementation 코드 실행, Proxy storage에 상태 기록');
  console.log('  2. constructor()는 Implementation storage에 실행 → Proxy 초기화 불가 → initialize() 필수');
  console.log('  3. initializer modifier 없으면 공격자가 initialize 재호출 → admin 탈취 가능');
  console.log('  4. Storage Collision: v2에서 앞에 변수 삽입 시 슬롯 번호 밀림 → 기존 데이터 파괴');
  console.log('  5. UUPS: 업그레이드 함수가 Implementation에 위치, 가스 효율 높음');
  console.log('  6. ERC-1967: Implementation 주소를 특수 슬롯에 저장 → 일반 변수와 충돌 없음');

  console.log('\nHardhat 실습 실행:');
  console.log('  cd blockchain && npx hardhat test test/KyoboNFT.test.ts --grep "initialize"');
})();
