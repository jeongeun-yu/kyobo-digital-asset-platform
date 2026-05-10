/**
 * S40 실습 — 프록시 업그레이드 안전성 · Storage Layout 규칙과 버전 관리
 *
 * 강의 노트: M6_S40_storage_layout_upgrade.md
 *
 * 실행 방법 (루트에서): npm run exercise:s40
 *
 * 목표:
 *   [1] EVM Storage 슬롯 레이아웃 시각화 — 슬롯 번호와 변수 매핑
 *   [2] Storage Collision 재현 — 앞에 변수 삽입 시 데이터 파괴 확인
 *   [3] 안전한 업그레이드 — 새 변수는 끝에만 추가
 *   [4] reinitializer(N) — 버전 관리된 초기화, 단조 증가 규칙
 *   [5] hardhat-upgrades 레이아웃 체커 결과 해석
 *   [6] v2 업그레이드 후 기존 토큰 잔액 보존 확인
 *
 * 전제 조건:
 *   Hardhat 불필요 — 순수 TypeScript 로직 검증
 *
 * Hardhat 실습 (로컬 노드 필요):
 *   cd blockchain && npx hardhat run scripts/upgrade.ts --network sepolia
 */

// ────────────────────────────────────────────────────────────────────────
// [1] EVM Storage 슬롯 모델링
//
// 슬롯은 0번부터 변수 선언 순서대로 할당된다.
// OZ Upgradeable 컨트랙트의 내부 슬롯이 먼저 차지하고,
// 직접 선언한 변수가 그 다음 슬롯에 위치한다.
// ────────────────────────────────────────────────────────────────────────

export interface SlotEntry {
  slot:     number;
  variable: string;
  type:     string;
  value:    unknown;
}

/** EVM 스토리지 시뮬레이터 — 완성 코드 (수정 불필요) */
export class EVMStorage {
  private readonly slots = new Map<number, unknown>();
  readonly layout: SlotEntry[] = [];

  define(slot: number, variable: string, type: string): void {
    this.layout.push({ slot, variable, type, value: undefined });
  }

  write(slot: number, value: unknown): void {
    this.slots.set(slot, value);
    const entry = this.layout.find(e => e.slot === slot);
    if (entry) entry.value = value;
  }

  read(slot: number): unknown {
    return this.slots.get(slot);
  }

  /** 슬롯 레이아웃 출력 */
  printLayout(): void {
    for (const entry of this.layout) {
      const val = entry.value !== undefined ? JSON.stringify(entry.value) : '(empty)';
      console.log(`    slot ${entry.slot}: ${entry.variable} (${entry.type}) = ${val}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// TODO [실습 1]: buildV1Layout을 완성하라
//
// KyoboNFT v1 슬롯 레이아웃을 정의한다.
// EVMStorage.define(slot, variable, type) 순서대로 호출한다.
//
// slot 0: 'ERC1155Upgradeable._uri'               / 'string'
// slot 1: 'ERC1155Upgradeable._balances'          / 'mapping(uint256 => mapping(address => uint256))'
// slot 2: 'ERC1155Upgradeable._operatorApprovals' / 'mapping(address => mapping(address => bool))'
// slot 3: 'AccessControlUpgradeable._roles'       / 'mapping(bytes32 => RoleData)'
// slot 4: 'PausableUpgradeable._paused'           / 'bool'
// slot 5: 'UUPSUpgradeable (internal)'            / 'bytes32'
// ────────────────────────────────────────────────────────────────────────

export function buildV1Layout(): EVMStorage {
  throw new Error('TODO: 구현하세요 — slot 0~5에 KyoboNFT v1 변수 정의');
}

// ────────────────────────────────────────────────────────────────────────
// TODO [실습 2]: buildV2SafeLayout을 완성하라
//
// v1 레이아웃을 그대로 유지하고 새 변수를 끝에 추가한다.
//
// 힌트:
//   const storage = buildV1Layout();  // 기존 슬롯 그대로 유지
//   storage.define(6, '_baseTokenURI',      'string');
//   storage.define(7, '_maxSupplyPerToken', 'uint256');
//   return storage;
// ────────────────────────────────────────────────────────────────────────

export function buildV2SafeLayout(): EVMStorage {
  throw new Error('TODO: 구현하세요 — buildV1Layout() 후 slot 6, 7에 새 변수 추가');
}

// ────────────────────────────────────────────────────────────────────────
// [교육용] buildV2BadLayout — 완성 코드 (수정 불필요)
// 앞에 새 변수 삽입 → Storage Collision 유발
// ────────────────────────────────────────────────────────────────────────

export function buildV2BadLayout(): EVMStorage {
  const storage = new EVMStorage();
  // 앞에 새 변수 삽입 → 기존 변수들이 뒤로 밀림!
  storage.define(0, 'newFeature (삽입됨!)',              'address');
  storage.define(1, 'ERC1155Upgradeable._uri (밀림)',   'string');
  storage.define(2, 'ERC1155Upgradeable._balances (밀림)', 'mapping(...)');
  storage.define(3, 'ERC1155Upgradeable._operatorApprovals (밀림)', 'mapping(...)');
  return storage;
}

// ────────────────────────────────────────────────────────────────────────
// Storage Collision 시뮬레이터 — 완성 코드 (수정 불필요)
// ────────────────────────────────────────────────────────────────────────

export interface TokenBalance {
  address: string;
  amount:  bigint;
}

export class ProxyStorageModel {
  readonly rawSlots = new Map<number, unknown>();

  initializeV1(adminAddr: string): void {
    this.rawSlots.set(0, '');
    this.rawSlots.set(1, new Map<string, Map<bigint, bigint>>());
    this.rawSlots.set(3, new Map<string, Set<string>>());
    this.rawSlots.set(4, false);
    const roles = this.rawSlots.get(3) as Map<string, Set<string>>;
    roles.set('MINTER_ROLE', new Set([adminAddr]));
  }

  writeBalance(tokenId: bigint, owner: string, amount: bigint): void {
    const balances = this.rawSlots.get(1) as Map<string, Map<bigint, bigint>>;
    if (!balances.has(owner)) balances.set(owner, new Map());
    balances.get(owner)!.set(tokenId, amount);
  }

  readBalance_V1(tokenId: bigint, owner: string): bigint {
    const balances = this.rawSlots.get(1) as Map<string, Map<bigint, bigint>>;
    return balances.get(owner)?.get(tokenId) ?? 0n;
  }

  readSlot1_AsUri_BAD(): unknown { return this.rawSlots.get(1); }
}

// ────────────────────────────────────────────────────────────────────────
// TODO [실습 3]: InitializationVersionTracker를 완성하라
//
// reinitializer(N) 패턴: _initialized 값으로 버전 관리
//
// initialize(admin):
//   - _initialized >= 1이면 → throw new Error('InvalidInitialization: already initialized (>= 1)')
//   - _initialized = 1
//
// initializeV2(baseUri, maxSupply):
//   - _initialized >= 2이면 → throw new Error('InvalidInitialization: already initialized (>= 2)')
//   - _initialized = 2
//
// initializeV3(newFeature):
//   - _initialized >= 3이면 → throw new Error('InvalidInitialization: already initialized (>= 3)')
//   - _initialized = 3
//
// 핵심: _initialized는 단조 증가 — 한 번 올라가면 낮은 버전으로 재초기화 불가
// ────────────────────────────────────────────────────────────────────────

export class InitializationVersionTracker {
  private _initialized = 0;

  /** initializer = reinitializer(1) */
  initialize(_admin: string): void {
    throw new Error('TODO: 구현하세요 — _initialized >= 1이면 예외, 아니면 _initialized = 1');
  }

  /** reinitializer(2) */
  initializeV2(_baseUri: string, _maxSupply: number): void {
    throw new Error('TODO: 구현하세요 — _initialized >= 2이면 예외, 아니면 _initialized = 2');
  }

  /** reinitializer(3) */
  initializeV3(_newFeature: string): void {
    throw new Error('TODO: 구현하세요 — _initialized >= 3이면 예외, 아니면 _initialized = 3');
  }

  getVersion(): number { return this._initialized; }
}

// ────────────────────────────────────────────────────────────────────────
// TODO [실습 4]: checkStorageLayoutCompatibility를 완성하라
//
// hardhat-upgrades의 레이아웃 체커를 시뮬레이션한다.
//
// 알고리즘:
//   1. v1MaxSlot = Math.max(...v1Slots)
//   2. v2Slots의 각 entry에 대해:
//      - entry.slot <= v1MaxSlot이면서 v1Slots에 없는 슬롯이면:
//        errors에 `New storage layout is incompatible: "${entry.variable}" at slot ${entry.slot} conflicts with existing layout` 추가
//   3. compatible = errors.length === 0
//
// 예시:
//   v1Slots = [0, 1, 2, 3, 4, 5], v2Slots = [{ slot: 6, variable: '_baseTokenURI' }]
//   → slot 6 > v1MaxSlot(5) → 안전 → compatible = true
//
//   v1Slots = [0, 1, 2, 4, 5], v2Slots = [{ slot: 3, variable: 'newFeature' }]
//   → slot 3 <= v1MaxSlot(5), slot 3은 v1Slots에 없음 → 충돌 → compatible = false
// ────────────────────────────────────────────────────────────────────────

export interface StorageLayoutCheckResult {
  compatible:  boolean;
  errors:      string[];
  warnings:    string[];
}

export function checkStorageLayoutCompatibility(
  v1Slots: number[],
  v2Slots: Array<{ slot: number; variable: string }>,
): StorageLayoutCheckResult {
  throw new Error('TODO: 구현하세요 — v1MaxSlot 계산 후 충돌 슬롯 감지');
  void v1Slots; void v2Slots;
}

// ────────────────────────────────────────────────────────────────────────
// tokenId 인코딩
// ────────────────────────────────────────────────────────────────────────

export function encodeTokenId(productCode: bigint, eventCode: bigint): bigint {
  return (productCode << 64n) | eventCode;
}

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

function expectThrows(label: string, fn: () => void, errorSubstring?: string): void {
  try {
    fn();
    check(`${label} → 예외 발생해야 함`, false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ok  = errorSubstring ? msg.includes(errorSubstring) : true;
    check(`${label} → ${ok ? '예외 발생 (정상)' : `기대 오류 없음: ${msg}`}`, ok);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S40: Storage Layout 규칙과 안전한 업그레이드 ===\n');

  // ── [1] v1 슬롯 레이아웃 시각화 ──────────────────────────────────
  console.log('[검증 1] KyoboNFT v1 슬롯 레이아웃');

  const v1Layout = buildV1Layout();
  v1Layout.printLayout();

  check('v1: slot 0 = ERC1155 _uri',      v1Layout.layout[0]?.variable.includes('_uri'));
  check('v1: slot 1 = ERC1155 _balances', v1Layout.layout[1]?.variable.includes('_balances'));
  check('v1: slot 4 = Pausable _paused',  v1Layout.layout[4]?.variable.includes('_paused'));

  // ── [2] 안전한 v2 레이아웃 ───────────────────────────────────────
  console.log('\n[검증 2] KyoboNFTV2 (올바른 — 새 변수를 끝에 추가)');

  const v2SafeLayout = buildV2SafeLayout();
  v2SafeLayout.printLayout();

  check('v2 safe: slot 0~5 변경 없음 (기존 슬롯 유지)',   v2SafeLayout.layout[0]?.variable.includes('_uri'));
  check('v2 safe: slot 6 = _baseTokenURI (끝에 추가)',    v2SafeLayout.layout[6]?.variable === '_baseTokenURI');
  check('v2 safe: slot 7 = _maxSupplyPerToken (끝에 추가)', v2SafeLayout.layout[7]?.variable === '_maxSupplyPerToken');

  // ── [3] Storage Collision 재현 ───────────────────────────────────
  console.log('\n[검증 3] Storage Collision — 앞에 삽입 시 슬롯 밀림');

  const v2BadLayout = buildV2BadLayout();
  console.log('  BAD v2 레이아웃 (앞에 삽입):');
  v2BadLayout.printLayout();

  check(
    'BAD v2: slot 0 = newFeature(삽입) → 원래 _uri 자리 오염',
    v2BadLayout.layout[0]?.variable.includes('newFeature'),
  );
  check(
    'BAD v2: slot 1 = _uri(밀림) → 원래 _balances 자리',
    v2BadLayout.layout[1]?.variable.includes('_uri'),
  );

  const proxy = new ProxyStorageModel();
  proxy.initializeV1('0xAdmin');

  const tokenId = encodeTokenId(1n, 42n);
  proxy.writeBalance(tokenId, '0xUser', 5n);
  check('v1 잔액 정상 기록: balanceOf(0xUser, tokenId) = 5', proxy.readBalance_V1(tokenId, '0xUser') === 5n);

  const slot1AsUri = proxy.readSlot1_AsUri_BAD();
  check(
    'BAD v2: slot 1을 _uri(string)로 읽으면 mapping 객체 → 잔액 파괴됨',
    typeof slot1AsUri !== 'string',
  );

  // ── [4] hardhat-upgrades 체커 시뮬레이션 ─────────────────────────
  console.log('\n[검증 4] hardhat-upgrades Storage Layout 체커');

  const v1UsedSlots = [0, 1, 2, 3, 4, 5];

  // 안전한 v2: 새 변수를 slot 6, 7에 추가
  const safeCheck = checkStorageLayoutCompatibility(
    v1UsedSlots,
    [
      { slot: 6, variable: '_baseTokenURI' },
      { slot: 7, variable: '_maxSupplyPerToken' },
    ],
  );
  check('안전한 v2: 레이아웃 체크 통과', safeCheck.compatible);
  check('안전한 v2: 에러 없음',          safeCheck.errors.length === 0);

  // BAD v2: slot 0에 새 변수 삽입
  const badCheck = checkStorageLayoutCompatibility(
    v1UsedSlots,
    [
      { slot: 0, variable: 'newFeature' },
    ],
  );
  check('BAD v2: 레이아웃 체크 실패', !badCheck.compatible);
  check('BAD v2: "New storage layout is incompatible" 에러 발생', badCheck.errors.length > 0);
  console.log(`    에러: ${badCheck.errors[0]}`);

  // ── [5] reinitializer(N) — 버전 관리 ────────────────────────────
  console.log('\n[검증 5] reinitializer(N) — 버전 관리된 초기화');

  const tracker = new InitializationVersionTracker();

  tracker.initialize('0xAdmin');
  check('initialize() 실행 → _initialized = 1', tracker.getVersion() === 1);

  expectThrows(
    'initialize() 재호출 → InvalidInitialization',
    () => tracker.initialize('0xAttacker'),
    'InvalidInitialization',
  );
  check('initialize() 재호출 후 version 변화 없음', tracker.getVersion() === 1);

  tracker.initializeV2('https://api.kyobo.com/', 1000);
  check('initializeV2() 실행 → _initialized = 2', tracker.getVersion() === 2);

  expectThrows(
    'initializeV2() 재호출 → InvalidInitialization',
    () => tracker.initializeV2('https://other.com/', 999),
    'InvalidInitialization',
  );

  expectThrows(
    'initialize() (v1) 재호출도 여전히 차단',
    () => tracker.initialize('0xAttacker'),
    'InvalidInitialization',
  );

  tracker.initializeV3('newFeatureValue');
  check('initializeV3() 실행 → _initialized = 3', tracker.getVersion() === 3);

  // ── [6] v2 업그레이드 후 기존 토큰 잔액 보존 ────────────────────
  console.log('\n[검증 6] v2 업그레이드 후 기존 토큰 잔액 보존 확인');

  const proxy2 = new ProxyStorageModel();
  proxy2.initializeV1('0xAdmin');

  const tid = encodeTokenId(1n, 1n);
  proxy2.writeBalance(tid, '0xUser', 5n);

  const balanceBefore = proxy2.readBalance_V1(tid, '0xUser');
  check(`업그레이드 전 잔액 = ${balanceBefore}`, balanceBefore === 5n);

  // v2 업그레이드 (슬롯 레이아웃 변경 없음 — slot 6, 7만 추가)
  proxy2.rawSlots.set(6, 'https://api.kyobo.com/');
  proxy2.rawSlots.set(7, 1000);

  const balanceAfter = proxy2.readBalance_V1(tid, '0xUser');
  check(`업그레이드 후 잔액 보존 = ${balanceAfter} (기존과 동일)`, balanceAfter === 5n);
  check('slot 6: _baseTokenURI 정상 설정', proxy2.rawSlots.get(6) === 'https://api.kyobo.com/');
  check('slot 7: _maxSupplyPerToken 정상 설정', proxy2.rawSlots.get(7) === 1000);

  // ── 정리 ─────────────────────────────────────────────────────────
  console.log('\n=== S40 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. EVM 슬롯: 변수 선언 순서대로 0번부터 할당. 타입 무관하게 순서가 슬롯 번호 결정');
  console.log('  2. Storage Collision: 앞에 변수 삽입 → 슬롯 번호 밀림 → 기존 데이터 다른 타입으로 해석 → 복구 불가');
  console.log('  3. 안전한 업그레이드: 새 변수는 반드시 끝에만 추가. 기존 변수 삭제/순서변경/타입변경 절대 금지');
  console.log('  4. reinitializer(N): N 단조 증가 필수. v1→v3 건너뛰면 v2 번호 영구 잠김');
  console.log('  5. hardhat-upgrades: upgradeProxy() 실행 전 자동 레이아웃 체크 → "New storage layout is incompatible" 에러');
  console.log('  6. v2 업그레이드 후: Proxy storage의 기존 슬롯 변경 없음 → 기존 토큰 잔액 완전 보존');

  console.log('\nHardhat 업그레이드 실행:');
  console.log('  cd blockchain && npx hardhat run scripts/upgrade.ts --network sepolia');
})();
