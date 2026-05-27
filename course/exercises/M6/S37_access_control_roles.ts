/**
 * S37 실습 — 온체인 역할 기반 접근 제어와 발행 권한 체계
 *
 * 강의 노트: M6_S37_access_control_roles.md
 *
 * 실행 방법 (루트에서): npm run exercise:s37
 *
 * 목표:
 *   [1] MINTER_ROLE 없는 주소가 mint 시도 → AccessControl revert 시뮬레이션
 *   [2] mintBatch 배열 길이 불일치 → revert 시뮬레이션
 *   [3] 역할 체계 설계 — 최소 권한 원칙 검증
 *   [4] 500건 배치 가스 비용 추정 — 블록 가스 한도 내 처리 가능 여부
 *   [5] Nonce 순차 처리 원칙과 Replace-by-Fee 패턴
 *
 * 전제 조건:
 *   Hardhat 불필요 — 순수 TypeScript 로직 검증
 *
 * Hardhat 실습 (로컬 노드 필요):
 *   cd blockchain && npx hardhat test test/KyoboNFT.test.ts --grep "MINTER_ROLE"
 */

// ────────────────────────────────────────────────────────────────────────
// 역할 상수 — keccak256 해시 (실제 값은 Solidity 컴파일 결과)
// KyoboNFT.sol: bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
// ────────────────────────────────────────────────────────────────────────

export const ROLES = {
  DEFAULT_ADMIN_ROLE: '0x0000000000000000000000000000000000000000000000000000000000000000',
  MINTER_ROLE:        '0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6',
  PAUSER_ROLE:        '0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a',
  UPGRADER_ROLE:      '0x189ab7a9244df0848122154315af71fe140f3db0fe014031783b0946b8c9d2e3',
} as const;

export type Role = keyof typeof ROLES;

// ────────────────────────────────────────────────────────────────────────
// AccessControl 시뮬레이터
//
// KyoboNFT의 onlyRole(MINTER_ROLE), onlyRole(PAUSER_ROLE) 가드를 TS로 모델링
// ────────────────────────────────────────────────────────────────────────

export interface NFTToken {
  owner: string;
  tokenId: bigint;
  amount: bigint;
}

// ────────────────────────────────────────────────────────────────────────
// TODO [실습]: KyoboNFTSimulator 클래스를 완성하라
//
// constructor(adminAddress):
//   - DEFAULT_ADMIN_ROLE, MINTER_ROLE, PAUSER_ROLE, UPGRADER_ROLE 모두 adminAddress에 부여
//
// private _requireRole(role, caller):
//   - hasRole(role, caller) === false이면:
//     throw new Error(`AccessControlUnauthorizedAccount: ${caller} does not have role ${role}`)
//
// private _requireNotPaused():
//   - this.paused === true이면:
//     throw new Error('EnforcedPause: contract is paused')
//
// mint(caller, to, tokenId, amount):
//   - _requireRole('MINTER_ROLE', caller)
//   - _requireNotPaused()
//   - amount <= 0n이면 throw new Error('KyoboNFT: zero amount')
//   - tokens에 { owner: to, tokenId, amount } 추가
//
// mintBatch(caller, to[], tokenIds[], amounts[]):
//   - _requireRole('MINTER_ROLE', caller)
//   - _requireNotPaused()
//   - to.length !== tokenIds.length || tokenIds.length !== amounts.length이면:
//     throw new Error('KyoboNFT: length mismatch')
//   - 각 인덱스 i에 대해 tokens에 { owner: to[i], tokenId: tokenIds[i], amount: amounts[i] } 추가
//
// pause(caller):
//   - _requireRole('PAUSER_ROLE', caller)
//   - 이미 paused이면 throw new Error('ExpectedPause: already paused')
//   - this.paused = true
//
// balanceOf(owner, tokenId): tokens 배열에서 해당 owner+tokenId의 amount 합산
// ────────────────────────────────────────────────────────────────────────

export class KyoboNFTSimulator {
  private readonly roles = new Map<Role, Set<string>>();
  private paused = false;
  private readonly tokens: NFTToken[] = [];

  constructor(adminAddress: string) {
    // DEFAULT_ADMIN_ROLE, MINTER_ROLE, PAUSER_ROLE, UPGRADER_ROLE 모두 adminAddress에 부여
    const allRoles: Role[] = ['DEFAULT_ADMIN_ROLE', 'MINTER_ROLE', 'PAUSER_ROLE', 'UPGRADER_ROLE'];
    for (const role of allRoles) {
      this._grantRole(role, adminAddress);
    }
  }

  grantRole(caller: string, role: Role, account: string): void {
    this._requireRole('DEFAULT_ADMIN_ROLE', caller);
    this._grantRole(role, account);
  }

  revokeRole(caller: string, role: Role, account: string): void {
    this._requireRole('DEFAULT_ADMIN_ROLE', caller);
    this._revokeRole(role, account);
  }

  hasRole(role: Role, account: string): boolean {
    return this.roles.get(role)?.has(account) ?? false;
  }

  private _grantRole(role: Role, account: string): void {
    if (!this.roles.has(role)) this.roles.set(role, new Set());
    this.roles.get(role)!.add(account);
  }

  private _revokeRole(role: Role, account: string): void {
    this.roles.get(role)?.delete(account);
  }

  private _requireRole(role: Role, caller: string): void {
    if (!this.hasRole(role, caller)) {
      throw new Error(`AccessControlUnauthorizedAccount: ${caller} does not have role ${role}`);
    }
  }

  private _requireNotPaused(): void {
    if (this.paused) {
      throw new Error('EnforcedPause: contract is paused');
    }
  }

  mint(caller: string, to: string, tokenId: bigint, amount: bigint): void {
    this._requireRole('MINTER_ROLE', caller);
    this._requireNotPaused();
    if (amount <= 0n) throw new Error('KyoboNFT: zero amount');
    this.tokens.push({ owner: to, tokenId, amount });
  }

  mintBatch(caller: string, to: string[], tokenIds: bigint[], amounts: bigint[]): void {
    this._requireRole('MINTER_ROLE', caller);
    this._requireNotPaused();
    if (to.length !== tokenIds.length || tokenIds.length !== amounts.length) {
      throw new Error('KyoboNFT: length mismatch');
    }
    for (let i = 0; i < to.length; i++) {
      this.tokens.push({ owner: to[i]!, tokenId: tokenIds[i]!, amount: amounts[i]! });
    }
  }

  pause(caller: string): void {
    this._requireRole('PAUSER_ROLE', caller);
    if (this.paused) throw new Error('ExpectedPause: already paused');
    this.paused = true;
  }

  unpause(caller: string): void {
    this._requireRole('PAUSER_ROLE', caller);
    if (!this.paused) throw new Error('ExpectedPause: not paused');
    this.paused = false;
  }

  isPaused(): boolean { return this.paused; }

  balanceOf(owner: string, tokenId: bigint): bigint {
    return this.tokens
      .filter(t => t.owner === owner && t.tokenId === tokenId)
      .reduce((sum, t) => sum + t.amount, BigInt(0));
  }

  totalMinted(): number { return this.tokens.length; }
}

// ────────────────────────────────────────────────────────────────────────
// tokenId 인코딩 (S35와 동일)
// ────────────────────────────────────────────────────────────────────────

export function encodeTokenId(productCode: bigint, eventCode: bigint): bigint {
  return (productCode << BigInt(64)) | eventCode;
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
    check(`${label} → ${errorSubstring ?? '예외'} 발생 (${msg})`, messageOk);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S37: 온체인 역할 기반 접근 제어 ===\n');

  const ADMIN    = '0xad1111111111111111111111111111111111ad11';
  const MINTER   = '0xb1111111111111111111111111111111111111b1';
  const ATTACKER = '0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0';
  const USER1    = '0xaaaa111111111111111111111111111111111111';
  const USER2    = '0xaaaa222222222222222222222222222222222222';

  const nft = new KyoboNFTSimulator(ADMIN);

  // VASP 서버 지갑(MINTER)에게 MINTER_ROLE 부여
  nft.grantRole(ADMIN, 'MINTER_ROLE', MINTER);

  // ── [1] MINTER_ROLE 없는 주소 → mint revert ──────────────────────────
  console.log('[검증 1] MINTER_ROLE 없는 주소 → AccessControlUnauthorizedAccount');

  const tokenId1 = encodeTokenId(BigInt(0x01), BigInt(1));

  expectThrows(
    'ATTACKER가 mint 시도',
    () => nft.mint(ATTACKER, USER1, tokenId1, BigInt(1)),
    'AccessControlUnauthorizedAccount',
  );
  expectThrows(
    'USER1이 직접 mint 시도 (사용자가 자신에게 발행 불가)',
    () => nft.mint(USER1, USER1, tokenId1, BigInt(1)),
    'AccessControlUnauthorizedAccount',
  );

  // MINTER가 정상 mint
  nft.mint(MINTER, USER1, tokenId1, BigInt(1));
  check('MINTER가 USER1에게 mint 성공', nft.balanceOf(USER1, tokenId1) === BigInt(1));

  // ── [2] amount = 0 → revert ───────────────────────────────────────────
  console.log('\n[검증 2] amount=0 방어 → KyoboNFT: zero amount');

  expectThrows(
    'MINTER가 amount=0으로 mint 시도',
    () => nft.mint(MINTER, USER1, tokenId1, BigInt(0)),
    'zero amount',
  );

  // ── [3] mintBatch 배열 길이 불일치 → revert ──────────────────────────
  console.log('\n[검증 3] mintBatch 배열 길이 불일치 → KyoboNFT: length mismatch');

  const tos     = [USER1, USER2];
  const ids     = [encodeTokenId(BigInt(1), BigInt(1))];   // 길이 1 (불일치)
  const amounts = [BigInt(1), BigInt(1)];

  expectThrows(
    'mintBatch: to(2) ≠ tokenIds(1) 길이 불일치',
    () => nft.mintBatch(MINTER, tos, ids, amounts),
    'length mismatch',
  );

  // ── [4] mintBatch 500건 가스 추정 ────────────────────────────────────
  console.log('\n[검증 4] mintBatch 500건 가스 비용 추정');

  const BATCH_SIZE = 500;
  const GAS_PER_MINT = 50_000;
  const BLOCK_GAS_LIMIT = 30_000_000;
  const RECOMMENDED_MAX = 25_000_000;

  const to500   = Array.from({ length: BATCH_SIZE }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
  const ids500  = Array.from({ length: BATCH_SIZE }, (_, i) => encodeTokenId(BigInt(1), BigInt(i)));
  const amts500 = Array.from({ length: BATCH_SIZE }, () => BigInt(1));

  nft.mintBatch(MINTER, to500, ids500, amts500);
  check(`mintBatch ${BATCH_SIZE}건 실행 성공`, nft.totalMinted() === BATCH_SIZE + 1);

  const estimatedGas = BATCH_SIZE * GAS_PER_MINT;
  check(
    `추정 가스 ${estimatedGas.toLocaleString()} < 권장 한도 ${RECOMMENDED_MAX.toLocaleString()}`,
    estimatedGas <= RECOMMENDED_MAX,
  );
  check(
    `추정 가스 ${estimatedGas.toLocaleString()} < 블록 한도 ${BLOCK_GAS_LIMIT.toLocaleString()}`,
    estimatedGas < BLOCK_GAS_LIMIT,
  );

  // ── [5] 역할 체계 — 최소 권한 원칙 검증 ─────────────────────────────
  console.log('\n[검증 5] 역할 체계 — 최소 권한 원칙');

  const roleMatrix = [
    { role: 'MINTER_ROLE'  as Role, holder: MINTER,  notHolder: ATTACKER },
    { role: 'PAUSER_ROLE'  as Role, holder: ADMIN,   notHolder: MINTER   },
    { role: 'UPGRADER_ROLE'as Role, holder: ADMIN,   notHolder: MINTER   },
  ];

  for (const { role, holder, notHolder } of roleMatrix) {
    check(`${role}: 보유자 확인 (${holder.slice(0, 10)}...)`, nft.hasRole(role, holder));
    check(`${role}: 미보유자 확인 (${notHolder.slice(0, 10)}...)`, !nft.hasRole(role, notHolder));
  }

  expectThrows(
    'MINTER가 pause 시도 (PAUSER_ROLE 없음)',
    () => nft.pause(MINTER),
    'AccessControlUnauthorizedAccount',
  );

  check('ADMIN도 MINTER_ROLE 보유 → mint 가능', nft.hasRole('MINTER_ROLE', ADMIN));

  // ── [6] 역할 위임 및 해제 ────────────────────────────────────────────
  console.log('\n[검증 6] DEFAULT_ADMIN_ROLE — 역할 부여 및 해제');

  const NEW_MINTER = '0xb1111111111111111111111111111111111111b2';

  expectThrows(
    'ATTACKER가 grantRole 시도 → 실패',
    () => nft.grantRole(ATTACKER, 'MINTER_ROLE', ATTACKER),
    'AccessControlUnauthorizedAccount',
  );

  nft.grantRole(ADMIN, 'MINTER_ROLE', NEW_MINTER);
  check('ADMIN이 NEW_MINTER에게 MINTER_ROLE 부여', nft.hasRole('MINTER_ROLE', NEW_MINTER));

  nft.revokeRole(ADMIN, 'MINTER_ROLE', MINTER);
  check('기존 MINTER ROLE 해제 완료', !nft.hasRole('MINTER_ROLE', MINTER));

  expectThrows(
    '해제된 MINTER가 mint 시도 → 실패',
    () => nft.mint(MINTER, USER1, tokenId1, BigInt(1)),
    'AccessControlUnauthorizedAccount',
  );

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S37 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. onlyRole(MINTER_ROLE): 서버 해킹 시에도 컨트랙트 레벨에서 발행 차단 — 마지막 방어선');
  console.log('  2. MINTER_ROLE 보유자만 mint/mintBatch/burn 가능 — 사용자 직접 호출 불가');
  console.log('  3. mintBatch: to/tokenIds/amounts 배열 길이 반드시 동일해야 함');
  console.log('  4. mintBatch 500건 추정 가스 = 25M → 블록 한도(30M) 이내 처리 가능');
  console.log('  5. DEFAULT_ADMIN_ROLE: grantRole/revokeRole 권한 — 멀티시그 지갑 보유 필요 (M8)');
  console.log('  6. Stuck TX → RBF(Replace-by-Fee): 동일 nonce로 가스비 1.2배 재전송');

  console.log('\nHardhat 실습 실행:');
  console.log('  cd blockchain && npx hardhat test test/KyoboNFT.test.ts --grep "mint"');
})();
