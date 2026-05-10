/**
 * S38 실습 — 컨트랙트 생명주기 관리 · 소각·일시정지·업그레이드
 *
 * 강의 노트: M6_S38_lifecycle_burn_pause_upgrade.md
 *
 * 실행 방법 (루트에서): npm run exercise:s38
 *
 * 목표:
 *   [1] 컨트랙트 생명주기 — ACTIVE ↔ PAUSED ↔ UPGRADED 상태 전이
 *   [2] burn — MINTER_ROLE 전용, 소각 후 잔액 감소 확인
 *   [3] Pause 상태에서 mint/transfer 차단 확인
 *   [4] burn Pause 예외 처리 정책 — _update hook 세분화 시뮬레이션
 *   [5] _authorizeUpgrade — UPGRADER_ROLE 없는 주소의 업그레이드 시도 차단
 *   [6] Pause 권한 단일점 위험 — 멀티시그 필요성
 *
 * 전제 조건:
 *   Hardhat 불필요 — 순수 TypeScript 로직 검증
 *
 * Hardhat 실습 (로컬 노드 필요):
 *   cd blockchain && npx hardhat test test/KyoboNFT.test.ts
 */

// ────────────────────────────────────────────────────────────────────────
// 컨트랙트 생명주기 상태
// ────────────────────────────────────────────────────────────────────────

export type ContractState = 'ACTIVE' | 'PAUSED' | 'UPGRADED';

export interface TokenBalance {
  owner: string;
  tokenId: bigint;
  amount: bigint;
}

// ────────────────────────────────────────────────────────────────────────
// TODO [실습]: KyoboNFTLifecycle 클래스를 완성하라
//
// _update(from, to) — ERC-1155 내부 hook:
//   isBurn  = (to === '')    // address(0) 대응
//   isMint  = (from === '')  // address(0) 대응
//   isTransfer = !isMint && !isBurn
//
//   정책 A (burnPauseExempt=false, 기본):
//     state === 'PAUSED'이면 → throw new Error('EnforcedPause: contract is paused')
//   정책 B (burnPauseExempt=true):
//     isBurn이 아닌데 state === 'PAUSED'이면 → throw new Error('EnforcedPause: contract is paused')
//     (burn은 Pause 중에도 허용)
//
// burn(caller, from, tokenId, amount):
//   - requireRole('MINTER_ROLE', caller)
//   - _update(from, '')  // to='' → burn 신호
//   - balances에서 해당 항목 찾아 amount 차감 또는 제거
//   - 항목 없으면 throw new Error('KyoboNFT: token not found')
//   - 잔액 부족이면 throw new Error('KyoboNFT: insufficient balance for burn')
//
// authorizeUpgrade(caller, newImpl):
//   - requireRole('UPGRADER_ROLE', caller)
//   - this.state = 'UPGRADED'
//
// transfer(from, to, tokenId, amount):
//   - _update(from, to)  // 일반 transfer
//   - balances에서 from의 항목 찾아 amount 차감, to에게 추가
// ────────────────────────────────────────────────────────────────────────

export class KyoboNFTLifecycle {
  private state: ContractState = 'ACTIVE';
  private readonly roles: Map<string, Set<string>> = new Map([
    ['MINTER_ROLE',   new Set()],
    ['PAUSER_ROLE',   new Set()],
    ['UPGRADER_ROLE', new Set()],
    ['DEFAULT_ADMIN_ROLE', new Set()],
  ]);
  private readonly balances: TokenBalance[] = [];

  /** burnPauseExempt=true → 정책 B (burn이 Pause에서도 가능) */
  constructor(
    adminAddress: string,
    private readonly burnPauseExempt: boolean = false,
  ) {
    for (const role of this.roles.keys()) {
      this.roles.get(role)!.add(adminAddress);
    }
  }

  // ── 역할 ────────────────────────────────────────────────────────────

  grantRole(role: string, account: string): void {
    this.roles.get(role)?.add(account);
  }

  hasRole(role: string, account: string): boolean {
    return this.roles.get(role)?.has(account) ?? false;
  }

  getState(): ContractState { return this.state; }

  private requireRole(role: string, caller: string): void {
    if (!this.hasRole(role, caller)) {
      throw new Error(`AccessControlUnauthorizedAccount: ${caller} missing ${role}`);
    }
  }

  /**
   * TODO [실습 1]: _update hook을 구현하라
   *
   * ERC-1155 내부 hook — mint/burn/transfer 전에 항상 호출됨
   *
   * 구현 지시:
   *   1. isBurn  = (to === '')
   *   2. burnPauseExempt가 true(정책 B)이면:
   *      - isBurn이 아닌데 state === 'PAUSED'이면 → EnforcedPause 던지기
   *      - (burn은 예외적으로 Pause 무시)
   *   3. burnPauseExempt가 false(정책 A, 기본)이면:
   *      - state === 'PAUSED'이면 → EnforcedPause 던지기 (burn 포함 모두 차단)
   *
   * from === '' → mint, to === '' → burn, 나머지 → transfer
   */
  private _update(_from: string, _to: string): void {
    return undefined as never;
  }

  // ── 발행 ────────────────────────────────────────────────────────────

  mint(caller: string, to: string, tokenId: bigint, amount: bigint): void {
    this.requireRole('MINTER_ROLE', caller);
    this._update('', to);  // from='' → mint
    if (amount <= 0n) throw new Error('KyoboNFT: zero amount');
    this.balances.push({ owner: to, tokenId, amount });
  }

  // ── 소각 ────────────────────────────────────────────────────────────

  /**
   * TODO [실습 2]: burn을 구현하라
   *
   * KyoboNFT.sol:
   *   function burn(address from, uint256 tokenId, uint256 amount)
   *     external onlyRole(MINTER_ROLE) {
   *     _burn(from, tokenId, amount);   // _update(from, address(0)) 호출됨
   *   }
   *
   * 구현 지시:
   *   1. requireRole('MINTER_ROLE', caller)
   *   2. _update(from, '')  // to='' → burn 신호
   *   3. balances에서 owner===from && tokenId===tokenId 항목 찾기
   *   4. 없으면 throw new Error('KyoboNFT: token not found')
   *   5. balance.amount < amount이면 throw new Error('KyoboNFT: insufficient balance for burn')
   *   6. balance.amount === amount이면 항목 제거 (splice), 아니면 amount 차감
   */
  burn(_caller: string, _from: string, _tokenId: bigint, _amount: bigint): void {
    return undefined as never;
  }

  // ── 전송 ────────────────────────────────────────────────────────────

  transfer(from: string, to: string, tokenId: bigint, amount: bigint): void {
    this._update(from, to);  // transfer
    const idx = this.balances.findIndex(b => b.owner === from && b.tokenId === tokenId);
    if (idx === -1) throw new Error('ERC1155: insufficient balance');
    const balance = this.balances[idx]!;
    if (balance.amount < amount) throw new Error('ERC1155: insufficient balance for transfer');
    balance.amount -= amount;
    if (balance.amount === 0n) this.balances.splice(idx, 1);
    this.balances.push({ owner: to, tokenId, amount });
  }

  // ── 일시정지 ────────────────────────────────────────────────────────

  pause(caller: string): void {
    this.requireRole('PAUSER_ROLE', caller);
    if (this.state === 'PAUSED') throw new Error('ExpectedPause: already paused');
    this.state = 'PAUSED';
  }

  unpause(caller: string): void {
    this.requireRole('PAUSER_ROLE', caller);
    if (this.state !== 'PAUSED') throw new Error('ExpectedPause: not paused');
    this.state = 'ACTIVE';
  }

  // ── 업그레이드 ──────────────────────────────────────────────────────

  /**
   * TODO [실습 3]: authorizeUpgrade를 구현하라
   *
   * KyoboNFT.sol:
   *   function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
   *
   * 구현 지시:
   *   1. requireRole('UPGRADER_ROLE', caller)
   *   2. this.state = 'UPGRADED'
   */
  authorizeUpgrade(_caller: string, _newImpl: string): void {
    return undefined as never;
  }

  // ── 조회 ────────────────────────────────────────────────────────────

  balanceOf(owner: string, tokenId: bigint): bigint {
    return this.balances
      .filter(b => b.owner === owner && b.tokenId === tokenId)
      .reduce((sum, b) => sum + b.amount, 0n);
  }
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
    const messageOk = errorSubstring ? msg.includes(errorSubstring) : true;
    check(`${label} → ${errorSubstring ?? '예외'} 발생 (${messageOk ? 'OK' : msg})`, messageOk);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S38: 컨트랙트 생명주기 — 소각·일시정지·업그레이드 ===\n');

  const ADMIN    = '0xAdmin';
  const MINTER   = '0xMinter';
  const ATTACKER = '0xAttacker';
  const USER     = '0xUser';

  const tokenId = encodeTokenId(1n, 1n);

  // ── [1] burn — 잔액 감소 확인 ─────────────────────────────────────────
  console.log('[검증 1] burn — 잔액 감소 확인');

  const nft = new KyoboNFTLifecycle(ADMIN);
  nft.grantRole('MINTER_ROLE', MINTER);

  nft.mint(MINTER, USER, tokenId, 5n);
  check('mint 후 잔액 = 5', nft.balanceOf(USER, tokenId) === 5n);

  nft.burn(MINTER, USER, tokenId, 3n);
  check('burn(3) 후 잔액 = 2', nft.balanceOf(USER, tokenId) === 2n);

  nft.burn(MINTER, USER, tokenId, 2n);
  check('burn(2) 후 잔액 = 0', nft.balanceOf(USER, tokenId) === 0n);

  // ── [2] burn 권한 체크 ──────────────────────────────────────────────
  console.log('\n[검증 2] burn — MINTER_ROLE 없는 주소 → revert');

  const nft2 = new KyoboNFTLifecycle(ADMIN);
  nft2.grantRole('MINTER_ROLE', MINTER);
  nft2.mint(MINTER, USER, tokenId, 5n);

  expectThrows(
    'ATTACKER가 burn 시도 → AccessControlUnauthorizedAccount',
    () => nft2.burn(ATTACKER, USER, tokenId, 1n),
    'AccessControlUnauthorizedAccount',
  );
  check('ATTACKER burn 시도 후 잔액 변화 없음', nft2.balanceOf(USER, tokenId) === 5n);

  // ── [3] Pause → mint/transfer 차단 (정책 A: 기본) ───────────────────
  console.log('\n[검증 3] Pause 상태 — mint/transfer/burn 모두 차단 (정책 A)');

  const nft3 = new KyoboNFTLifecycle(ADMIN, false /* burnPauseExempt=false */);
  nft3.grantRole('MINTER_ROLE', MINTER);
  nft3.mint(MINTER, USER, tokenId, 5n);

  nft3.pause(ADMIN);
  check('pause 후 state = PAUSED', nft3.getState() === 'PAUSED');

  expectThrows('Pause 상태 mint → EnforcedPause',     () => nft3.mint(MINTER, USER, tokenId, 1n), 'EnforcedPause');
  expectThrows('Pause 상태 transfer → EnforcedPause', () => nft3.transfer(USER, ATTACKER, tokenId, 1n), 'EnforcedPause');
  expectThrows('Pause 상태 burn → EnforcedPause (정책 A)', () => nft3.burn(MINTER, USER, tokenId, 1n), 'EnforcedPause');

  nft3.unpause(ADMIN);
  check('unpause 후 state = ACTIVE', nft3.getState() === 'ACTIVE');

  nft3.mint(MINTER, USER, tokenId, 1n);
  check('unpause 후 mint 정상 동작', nft3.balanceOf(USER, tokenId) === 6n);

  // ── [4] Pause 예외 처리 — burn 허용 (정책 B) ──────────────────────
  console.log('\n[검증 4] Pause 상태 burn 예외 처리 (정책 B: _update hook 세분화)');

  const nft4 = new KyoboNFTLifecycle(ADMIN, true /* burnPauseExempt=true */);
  nft4.grantRole('MINTER_ROLE', MINTER);
  nft4.mint(MINTER, USER, tokenId, 5n);
  nft4.pause(ADMIN);
  check('pause 후 state = PAUSED', nft4.getState() === 'PAUSED');

  nft4.burn(MINTER, USER, tokenId, 2n);
  check('정책 B: Pause 중 burn 성공 (피해 NFT 즉시 회수 가능)', nft4.balanceOf(USER, tokenId) === 3n);

  expectThrows('정책 B: Pause 중 mint 여전히 차단', () => nft4.mint(MINTER, USER, tokenId, 1n), 'EnforcedPause');
  expectThrows('정책 B: Pause 중 transfer 여전히 차단', () => nft4.transfer(USER, ATTACKER, tokenId, 1n), 'EnforcedPause');

  // ── [5] PAUSER_ROLE 없는 주소 → pause revert ──────────────────────
  console.log('\n[검증 5] PAUSER_ROLE 없는 주소 → pause revert');

  const nft5 = new KyoboNFTLifecycle(ADMIN);
  expectThrows(
    'ATTACKER가 pause 시도 → AccessControlUnauthorizedAccount',
    () => nft5.pause(ATTACKER),
    'AccessControlUnauthorizedAccount',
  );
  check('ATTACKER pause 시도 후 state = ACTIVE 유지', nft5.getState() === 'ACTIVE');

  // ── [6] _authorizeUpgrade — UPGRADER_ROLE 없는 주소 → revert ──────
  console.log('\n[검증 6] _authorizeUpgrade — UPGRADER_ROLE 없는 주소 → revert');

  const nft6 = new KyoboNFTLifecycle(ADMIN);
  expectThrows(
    'ATTACKER가 upgradeToAndCall 시도 → AccessControlUnauthorizedAccount',
    () => nft6.authorizeUpgrade(ATTACKER, '0xNewImpl'),
    'AccessControlUnauthorizedAccount',
  );
  check('ATTACKER upgrade 시도 후 state = ACTIVE 유지', nft6.getState() === 'ACTIVE');

  nft6.authorizeUpgrade(ADMIN, '0xNewImpl');
  check('ADMIN이 upgrade 완료 → state = UPGRADED', nft6.getState() === 'UPGRADED');

  // ── [7] 생명주기 전체 흐름 확인 ──────────────────────────────────────
  console.log('\n[검증 7] 생명주기 전체 흐름: ACTIVE → PAUSED → ACTIVE → UPGRADED');

  const nft7 = new KyoboNFTLifecycle(ADMIN);
  check('초기 state = ACTIVE', nft7.getState() === 'ACTIVE');

  nft7.pause(ADMIN);
  check('pause() → PAUSED', nft7.getState() === 'PAUSED');

  nft7.unpause(ADMIN);
  check('unpause() → ACTIVE 복귀', nft7.getState() === 'ACTIVE');

  nft7.authorizeUpgrade(ADMIN, '0xV2');
  check('authorizeUpgrade() → UPGRADED', nft7.getState() === 'UPGRADED');

  // ── [8] Pause 권한 단일점 위험 시뮬레이션 ────────────────────────────
  console.log('\n[검증 8] Pause 권한 단일점 위험 — 멀티시그 필요성 확인');

  const LOST_KEY = '0xLostKey';
  const nft8 = new KyoboNFTLifecycle(LOST_KEY);

  expectThrows(
    '키 분실 시나리오: 다른 주소로 pause 불가 → 비상 정지 불가',
    () => nft8.pause(ADMIN),
    'AccessControlUnauthorizedAccount',
  );
  check(
    'Pause 권한 단일점 위험 확인 → M8에서 2-of-3 멀티시그로 PAUSER_ROLE 관리 필요',
    true,
  );

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S38 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. 생명주기: ACTIVE ↔ PAUSED (반복 가능), UPGRADED (단방향)');
  console.log('  2. burn: MINTER_ROLE 전용 → issuer-service만 회수 가능, 사용자 자발적 소각 불가');
  console.log('  3. 정책 A: _update에 whenNotPaused → mint/burn/transfer 모두 Pause 차단');
  console.log('  4. 정책 B: burn 예외 처리 → Pause 중에도 피해 NFT 즉시 회수 가능');
  console.log('  5. _authorizeUpgrade: UPGRADER_ROLE 없으면 누구도 업그레이드 불가');
  console.log('  6. Pause 권한 단일점 위험 → M8 Gnosis Safe 2-of-3 멀티시그 필요');

  console.log('\nHardhat 실습 실행:');
  console.log('  cd blockchain && npx hardhat test test/KyoboNFT.test.ts');
})();
