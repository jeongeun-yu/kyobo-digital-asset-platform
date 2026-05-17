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

/** EVM 스토리지 시뮬레이터 */
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

// KyoboNFT v1 슬롯 레이아웃 (강의 노트 기준)
export function buildV1Layout(): EVMStorage {
  const storage = new EVMStorage();
  storage.define(0, 'ERC1155Upgradeable._uri',               'string');
  storage.define(1, 'ERC1155Upgradeable._balances',          'mapping(uint256 => mapping(address => uint256))');
  storage.define(2, 'ERC1155Upgradeable._operatorApprovals', 'mapping(address => mapping(address => bool))');
  storage.define(3, 'AccessControlUpgradeable._roles',       'mapping(bytes32 => RoleData)');
  storage.define(4, 'PausableUpgradeable._paused',           'bool');
  storage.define(5, 'UUPSUpgradeable (internal)',            'bytes32');
  // slot 6+: 비어 있음 — 직접 선언한 상태 변수 없음
  return storage;
}

// KyoboNFTV2 슬롯 레이아웃 — 올바른 버전 (새 변수를 끝에 추가)
export function buildV2SafeLayout(): EVMStorage {
  const storage = buildV1Layout();  // 기존 슬롯 그대로 유지
  storage.define(6, '_baseTokenURI',       'string');   // 새 변수: 끝에 추가
  storage.define(7, '_maxSupplyPerToken',  'uint256');  // 새 변수: 끝에 추가
  return storage;
}

// KyoboNFTV2_BAD 슬롯 레이아웃 — 잘못된 버전 (앞에 삽입)
export function buildV2BadLayout(): EVMStorage {
  const storage = new EVMStorage();
  // 앞에 새 변수 삽입 → 기존 변수들이 뒤로 밀림!
  storage.define(0, 'newFeature (삽입됨!)',              'address');
  storage.define(1, 'ERC1155Upgradeable._uri (밀림)',   'string');
  storage.define(2, 'ERC1155Upgradeable._balances (밀림)', 'mapping(...)');
  storage.define(3, 'ERC1155Upgradeable._operatorApprovals (밀림)', 'mapping(...)');
  // ... 모든 슬롯이 1칸씩 밀림
  return storage;
}

// ────────────────────────────────────────────────────────────────────────
// [2] Storage Collision 시뮬레이터
//
// Proxy storage의 실제 비트는 변하지 않는다.
// Implementation이 바뀌면 같은 비트를 다른 타입으로 해석한다.
// ────────────────────────────────────────────────────────────────────────

export interface TokenBalance {
  address: string;
  amount:  bigint;
}

export class ProxyStorageModel {
  /** Proxy의 실제 storage — 비트 레벨 */
  readonly rawSlots = new Map<number, unknown>();

  // v1로 초기화
  initializeV1(adminAddr: string): void {
    this.rawSlots.set(0, '');                    // slot 0: _uri = ""
    this.rawSlots.set(1, new Map<string, Map<bigint, bigint>>());  // slot 1: _balances
    this.rawSlots.set(3, new Map<string, Set<string>>());          // slot 3: _roles
    this.rawSlots.set(4, false);                 // slot 4: _paused = false

    // 역할 설정
    const roles = this.rawSlots.get(3) as Map<string, Set<string>>;
    roles.set('MINTER_ROLE', new Set([adminAddr]));
  }

  // v1 방식으로 잔액 쓰기
  writeBalance(tokenId: bigint, owner: string, amount: bigint): void {
    const balances = this.rawSlots.get(1) as Map<string, Map<bigint, bigint>>;
    if (!balances.has(owner)) balances.set(owner, new Map());
    balances.get(owner)!.set(tokenId, amount);
  }

  // v1 방식으로 잔액 읽기
  readBalance_V1(tokenId: bigint, owner: string): bigint {
    const balances = this.rawSlots.get(1) as Map<string, Map<bigint, bigint>>;
    return balances.get(owner)?.get(tokenId) ?? 0n;
  }

  // BAD v2 방식으로 slot 1 읽기 (원래 _uri가 있어야 하는 슬롯)
  // → BAD v2에서 slot 1은 _uri(string)인데 실제는 _balances(mapping)가 있음
  readSlot1_AsUri_BAD(): unknown {
    return this.rawSlots.get(1);  // mapping을 string으로 잘못 해석
  }

  // BAD v2 방식으로 slot 0 읽기 (원래 _uri인데 BAD impl은 newFeature(address)로 읽음)
  readSlot0_AsNewFeature_BAD(): unknown {
    return this.rawSlots.get(0);  // ""(string)을 address로 잘못 해석
  }
}

// ────────────────────────────────────────────────────────────────────────
// [4] reinitializer(N) — 버전 관리된 초기화
// ────────────────────────────────────────────────────────────────────────

export class InitializationVersionTracker {
  private _initialized = 0;

  /** initializer = reinitializer(1) */
  initialize(admin: string): void {
    if (this._initialized >= 1) throw new Error('InvalidInitialization: already initialized (>= 1)');
    this._initialized = 1;
    console.log(`    initialize(${admin}) 실행 → _initialized = ${this._initialized}`);
  }

  /** reinitializer(2) */
  initializeV2(baseUri: string, maxSupply: number): void {
    if (this._initialized >= 2) throw new Error('InvalidInitialization: already initialized (>= 2)');
    this._initialized = 2;
    console.log(`    initializeV2(${baseUri}, ${maxSupply}) 실행 → _initialized = ${this._initialized}`);
  }

  /** reinitializer(3) */
  initializeV3(newFeature: string): void {
    if (this._initialized >= 3) throw new Error('InvalidInitialization: already initialized (>= 3)');
    this._initialized = 3;
    console.log(`    initializeV3(${newFeature}) 실행 → _initialized = ${this._initialized}`);
  }

  getVersion(): number { return this._initialized; }
}

// ────────────────────────────────────────────────────────────────────────
// [5] hardhat-upgrades 레이아웃 체커 결과 해석
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
  const errors: string[] = [];
  const warnings: string[] = [];

  // v2에서 기존 슬롯(v1 범위)에 새 변수가 삽입됐는지 확인
  const v1MaxSlot = Math.max(...v1Slots);
  for (const entry of v2Slots) {
    if (entry.slot <= v1MaxSlot) {
      // 기존 슬롯 영역에 새 변수가 정의됨 → Collision 위험
      if (!v1Slots.includes(entry.slot)) {
        errors.push(`New storage layout is incompatible: "${entry.variable}" at slot ${entry.slot} conflicts with existing layout`);
      }
    }
  }

  return { compatible: errors.length === 0, errors, warnings };
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

  // Proxy storage에서 실제 데이터 파괴 시뮬레이션
  const proxy = new ProxyStorageModel();
  proxy.initializeV1('0xad1111111111111111111111111111111111ad11');

  const tokenId = encodeTokenId(1n, 42n);
  proxy.writeBalance(tokenId, '0xaaaa111111111111111111111111111111111111', 5n);
  check('v1 잔액 정상 기록: balanceOf(0xUser, tokenId) = 5', proxy.readBalance_V1(tokenId, '0xaaaa111111111111111111111111111111111111') === 5n);

  // BAD v2 업그레이드 후 같은 비트를 다른 타입으로 해석
  // slot 1에는 _balances(mapping)이 있는데 BAD v2는 이를 _uri(string)로 읽음
  const slot1AsUri = proxy.readSlot1_AsUri_BAD();
  check(
    'BAD v2: slot 1을 _uri(string)로 읽으면 mapping 객체 → 잔액 파괴됨',
    typeof slot1AsUri !== 'string',  // mapping인데 string으로 해석 → 타입 불일치
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
      { slot: 0, variable: 'newFeature' },  // slot 0은 기존에 있음 → 충돌
    ],
  );
  check('BAD v2: 레이아웃 체크 실패', !badCheck.compatible);
  check('BAD v2: "New storage layout is incompatible" 에러 발생', badCheck.errors.length > 0);
  console.log(`    에러: ${badCheck.errors[0]}`);

  // ── [5] reinitializer(N) — 버전 관리 ────────────────────────────
  console.log('\n[검증 5] reinitializer(N) — 버전 관리된 초기화');

  const tracker = new InitializationVersionTracker();

  tracker.initialize('0xad1111111111111111111111111111111111ad11');
  check('initialize() 실행 → _initialized = 1', tracker.getVersion() === 1);

  expectThrows(
    'initialize() 재호출 → InvalidInitialization',
    () => tracker.initialize('0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0'),
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
    () => tracker.initialize('0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0'),
    'InvalidInitialization',
  );

  tracker.initializeV3('newFeatureValue');
  check('initializeV3() 실행 → _initialized = 3', tracker.getVersion() === 3);

  // ── [6] v2 업그레이드 후 기존 토큰 잔액 보존 ────────────────────
  console.log('\n[검증 6] v2 업그레이드 후 기존 토큰 잔액 보존 확인');

  // v1 상태 구성
  const proxy2 = new ProxyStorageModel();
  proxy2.initializeV1('0xad1111111111111111111111111111111111ad11');

  const tid = encodeTokenId(1n, 1n);
  proxy2.writeBalance(tid, '0xaaaa111111111111111111111111111111111111', 5n);

  // 업그레이드 전 잔액 확인
  const balanceBefore = proxy2.readBalance_V1(tid, '0xaaaa111111111111111111111111111111111111');
  check(`업그레이드 전 잔액 = ${balanceBefore}`, balanceBefore === 5n);

  // v2 업그레이드 (슬롯 레이아웃 변경 없음 — slot 6, 7만 추가)
  // Proxy storage의 slot 0~5는 변경 없음
  proxy2.rawSlots.set(6, 'https://api.kyobo.com/');  // _baseTokenURI
  proxy2.rawSlots.set(7, 1000);                       // _maxSupplyPerToken

  // 업그레이드 후 잔액 보존 확인 (같은 slot 1에서 읽기)
  const balanceAfter = proxy2.readBalance_V1(tid, '0xaaaa111111111111111111111111111111111111');
  check(`업그레이드 후 잔액 보존 = ${balanceAfter} (기존과 동일)`, balanceAfter === 5n);
  check('slot 6: _baseTokenURI 정상 설정', proxy2.rawSlots.get(6) === 'https://api.kyobo.com/');
  check('slot 7: _maxSupplyPerToken 정상 설정', proxy2.rawSlots.get(7) === 1000);

  // ── [7] 업그레이드 안전 체크리스트 ──────────────────────────────
  console.log('\n[검증 7] 업그레이드 안전 체크리스트 — 사전 확인 항목');

  const preUpgradeChecklist = [
    { item: 'v2 컨트랙트 로컬 테스트 전부 PASS',                  required: true },
    { item: 'hardhat-upgrades 레이아웃 체크 통과 (에러 없음)',     required: true },
    { item: 'Sepolia 테스트넷 업그레이드 사전 검증 완료',          required: true },
    { item: 'proxy-address.json의 PROXY_ADDRESS 정확한 주소 확인', required: true },
    { item: 'upgradeProxy() 실행 → 새 implAddr 확인',             required: true },
    { item: 'initializeV2() 호출 완료',                            required: true },
    { item: '기존 토큰 잔액 보존 확인 (balanceOf 호출)',           required: true },
    { item: '새 기능(baseTokenURI 등) 정상 동작 확인',            required: true },
    { item: 'Etherscan verify — 새 Implementation 주소 등록',     required: true },
  ];

  check(`체크리스트 ${preUpgradeChecklist.length}개 항목 준비`, preUpgradeChecklist.length === 9);
  check('모든 항목 required=true', preUpgradeChecklist.every(c => c.required));

  console.log('\n  업그레이드 안전 체크리스트:');
  for (const item of preUpgradeChecklist) {
    console.log(`    [ ] ${item.item}`);
  }

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
