/**
 * S25 실습 — 온체인 상태와 내부 원장의 정합성 유지 · ReconcileService
 *
 * 강의 노트: M4_S25_reconcile_service.md
 *
 * 실행 방법 (루트에서): npm run exercise:s25
 *
 * 목표:
 *   [1] ReconcileService.reconcile() — KRW 스테이블코인 발행량 vs 수탁 계좌 잔액 대조
 *   [2] tolerance 기준 isHealthy 판정
 *   [3] warn / critical 심각도 분류 (불일치 크기 기준)
 *   [4] reconcileNftHoldings() — 사용자별 NFT 보유량 온체인 대조
 *   [5] 역방향 수정 코드 없음 확인 (mint/sendTransaction 메서드 부재)
 *   [6] getLastResult() — 마지막 결과 캐싱
 */

// ────────────────────────────────────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────────────────────────────────────

export interface ReconcileResult {
  onchainSupply: bigint;
  bankBalance: bigint;
  disparity: bigint;
  isHealthy: boolean;
  timestamp: number;
}

export interface NftReconcileResult {
  isHealthy: boolean;
  discrepancies: Array<{
    userId: string;
    tokenId: bigint;
    type: 'LEDGER_ONLY' | 'ONCHAIN_ONLY';
  }>;
  checkedAt: number;
}

interface AlertCall {
  message: string;
  severity: 'warn' | 'critical';
}

// ────────────────────────────────────────────────────────────────────────
// 실습: ReconcileService를 구현하라
//
// 단일 진실 원칙: 온체인이 항상 맞다.
// ReconcileService는 불일치를 감지하고 알림을 발송할 뿐,
// 온체인 TX를 발행하거나 역방향으로 원장을 수정하지 않는다.
// ────────────────────────────────────────────────────────────────────────

export class ReconcileService {
  private lastResult: ReconcileResult | null = null;

  constructor(
    private readonly onchain: {
      getTotalSupply(): Promise<bigint>;
      getCustodyAccountBalance(): Promise<bigint>;
      /** ERC-1155: balanceOf(account, tokenId) → 보유 수량 */
      balanceOf(address: string, tokenId: bigint): Promise<bigint>;
      /** 특정 사용자의 온체인 NFT 보유 tokenId 목록 */
      getNftHoldings(address: string): Promise<bigint[]>;
    },
    private readonly ledger: {
      getHoldings(userId: string): Promise<bigint[]>;
      getWalletAddress(userId: string): Promise<string | null>;
    },
    private readonly alerter: {
      fire(message: string, severity: 'warn' | 'critical'): Promise<void>;
    },
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // 실습 1: reconcile()을 구현하라
  //
  // 1. Promise.all로 onchain.getTotalSupply()와 onchain.getCustodyAccountBalance() 동시 조회
  // 2. disparity = onchainSupply - bankBalance (양수: 과잉발행, 음수: 과소발행)
  // 3. tolerance = 1n — ±1원 이내면 isHealthy = true
  //    힌트: disparity >= -tolerance && disparity <= tolerance
  // 4. !isHealthy이면 alerter.fire() 호출:
  //    - |disparity| >= 1_000_000n → 'critical'
  //    - 그 외 → 'warn'
  //    힌트: 절댓값: disparity < 0n ? -disparity : disparity
  // 5. result 객체 생성 후 this.lastResult에 저장 + 반환
  //    - timestamp: Date.now()
  // ────────────────────────────────────────────────────────────────────────

  async reconcile(): Promise<ReconcileResult> {
    return undefined as never;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 실습 2: getLastResult()를 구현하라
  //
  // 마지막 reconcile() 실행 결과를 반환한다.
  // 아직 실행하지 않았으면 null을 반환한다.
  // ────────────────────────────────────────────────────────────────────────

  getLastResult(): ReconcileResult | null {
    return undefined as never;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 실습 3: reconcileNftHoldings()를 구현하라
  //
  // 1. ledger.getWalletAddress(userId) — null이면 Error throw
  // 2. ledger.getHoldings(userId)로 원장 보유 목록 조회
  // 3. 원장 각 tokenId에 대해 onchain.balanceOf(userAddress, tokenId) 확인:
  //    → 0n이면 discrepancies에 { userId, tokenId, type: 'LEDGER_ONLY' } 추가
  // 4. onchain.getNftHoldings(userAddress)로 온체인 보유 목록 조회
  //    → 원장에 없는 tokenId는 { userId, tokenId, type: 'ONCHAIN_ONLY' } 추가
  //    힌트: Set<string>으로 원장 목록 빠르게 조회
  // 5. discrepancies.length === 0이면 isHealthy = true
  // 6. !isHealthy이면 alerter.fire():
  //    - discrepancies.length >= 10 → 'critical', 그 외 → 'warn'
  // 7. { isHealthy, discrepancies, checkedAt: Date.now() } 반환
  // ────────────────────────────────────────────────────────────────────────

  async reconcileNftHoldings(userId: string): Promise<NftReconcileResult> {
    return undefined as never;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 중요: 역방향 수정 메서드를 절대 추가하지 말 것
  // ❌ mintBatch()         — 원장 기반 온체인 TX 발행 → 보안 취약점
  // ❌ forceMint()         — 원장 기반 강제 발행 → 금지
  // ❌ sendTransaction()   — ReconcileService에서 TX 발행 → 금지
  // ────────────────────────────────────────────────────────────────────────
}

// ────────────────────────────────────────────────────────────────────────
// 인메모리 스텁 — 온체인 / 원장 어댑터 (완성 제공)
// ────────────────────────────────────────────────────────────────────────

export function createStubs(opts: {
  totalSupply: bigint;
  bankBalance: bigint;
  onchainHoldings?: Map<string, bigint[]>;  // address → tokenIds
  ledgerHoldings?: Map<string, bigint[]>;   // userId → tokenIds
  wallets?: Map<string, string>;            // userId → address
}) {
  const onchainHoldings = opts.onchainHoldings ?? new Map();
  const ledgerHoldings  = opts.ledgerHoldings  ?? new Map();
  const wallets         = opts.wallets         ?? new Map();

  const alertCalls: AlertCall[] = [];

  const onchain = {
    getTotalSupply: async () => opts.totalSupply,
    getCustodyAccountBalance: async () => opts.bankBalance,
    balanceOf: async (address: string, tokenId: bigint): Promise<bigint> => {
      const tokens = onchainHoldings.get(address) ?? [];
      return tokens.includes(tokenId) ? 1n : 0n;
    },
    getNftHoldings: async (address: string): Promise<bigint[]> => {
      return onchainHoldings.get(address) ?? [];
    },
  };

  const ledger = {
    getHoldings: async (userId: string): Promise<bigint[]> => {
      return ledgerHoldings.get(userId) ?? [];
    },
    getWalletAddress: async (userId: string): Promise<string | null> => {
      return wallets.get(userId) ?? null;
    },
  };

  const alerter = {
    fire: async (message: string, severity: 'warn' | 'critical') => {
      alertCalls.push({ message, severity });
    },
  };

  return { onchain, ledger, alerter, alertCalls };
}

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
  console.log('=== S25: ReconcileService — 온체인 vs 원장 정합성 대조 ===\n');

  // ── [1] 정상 상태 — 발행량 = 잔액 ───────────────────────────────────
  console.log('[검증 1] 정상 상태 — isHealthy = true');

  const { onchain: oc1, ledger: l1, alerter: a1, alertCalls: ac1 } = createStubs({
    totalSupply: 1_000_000n,
    bankBalance: 1_000_000n,
  });
  const svc1 = new ReconcileService(oc1, l1, a1);
  const r1 = await svc1.reconcile();

  check('isHealthy = true',     r1.isHealthy === true);
  check('disparity = 0n',       r1.disparity === 0n);
  check('알림 없음',             ac1.length === 0);
  check('timestamp 존재',       r1.timestamp > 0);

  // ── [2] ±1원 허용 오차 ────────────────────────────────────────────────
  console.log('\n[검증 2] ±1원 허용 오차 → isHealthy = true');

  const { onchain: oc2, ledger: l2, alerter: a2, alertCalls: ac2 } = createStubs({
    totalSupply: 1_000_001n,
    bankBalance: 1_000_000n,
  });
  const svc2 = new ReconcileService(oc2, l2, a2);
  const r2 = await svc2.reconcile();

  check('±1원 오차 → isHealthy = true', r2.isHealthy === true);
  check('disparity = 1n',               r2.disparity === 1n);
  check('알림 없음 (±1 허용)',            ac2.length === 0);

  // ── [3] warn 알림 ─────────────────────────────────────────────────────
  console.log('\n[검증 3] 100만원 미만 불일치 → warn 알림');

  const { onchain: oc3, ledger: l3, alerter: a3, alertCalls: ac3 } = createStubs({
    totalSupply: 1_000_000n,
    bankBalance:   999_000n,
  });
  const svc3 = new ReconcileService(oc3, l3, a3);
  const r3 = await svc3.reconcile();

  check('isHealthy = false',             r3.isHealthy === false);
  check('disparity = 1000n (과잉발행)',  r3.disparity === 1000n);
  check('warn 알림 발송',                ac3.length === 1 && ac3[0]?.severity === 'warn');

  // ── [4] critical 알림 ─────────────────────────────────────────────────
  console.log('\n[검증 4] 100만원 이상 불일치 → critical 알림');

  const { onchain: oc4, ledger: l4, alerter: a4, alertCalls: ac4 } = createStubs({
    totalSupply: 5_000_000n,
    bankBalance: 3_000_000n,
  });
  const svc4 = new ReconcileService(oc4, l4, a4);
  const r4 = await svc4.reconcile();

  check('critical 알림 발송',            ac4.length === 1 && ac4[0]?.severity === 'critical');
  check('disparity = 2_000_000n',        r4.disparity === 2_000_000n);

  // ── [5] 과소발행 — 음수 disparity ────────────────────────────────────
  console.log('\n[검증 5] 과소발행 — 수탁 잔액 > 발행량');

  const { onchain: oc5, ledger: l5, alerter: a5, alertCalls: ac5 } = createStubs({
    totalSupply: 900_000n,
    bankBalance: 1_500_000n,
  });
  const svc5 = new ReconcileService(oc5, l5, a5);
  const r5 = await svc5.reconcile();

  check('음수 disparity',                r5.disparity === -600_000n);
  check('isHealthy = false',             r5.isHealthy === false);
  check('warn 알림 (60만원 미만 100만)', ac5.length === 1 && ac5[0]?.severity === 'warn');

  // ── [6] getLastResult() 캐싱 ─────────────────────────────────────────
  console.log('\n[검증 6] getLastResult() — 마지막 결과 캐싱');

  check('캐싱 전: null',          svc1.getLastResult() === null || svc1.getLastResult()?.timestamp === r1.timestamp);
  const last3 = svc3.getLastResult();
  check('캐싱됨: timestamp 일치', last3?.timestamp === r3.timestamp);
  check('캐싱됨: disparity 일치', last3?.disparity === r3.disparity);

  // ── [7] reconcileNftHoldings() — 정상 상태 ───────────────────────────
  console.log('\n[검증 7] reconcileNftHoldings() — 정상 상태');

  const wallets7 = new Map([['user-001', '0xABCD']]);
  const onchainH7 = new Map([['0xABCD', [1001n, 1002n]]]);
  const ledgerH7  = new Map([['user-001', [1001n, 1002n]]]);

  const { onchain: oc7, ledger: l7, alerter: a7, alertCalls: ac7 } = createStubs({
    totalSupply: 1_000_000n, bankBalance: 1_000_000n,
    onchainHoldings: onchainH7,
    ledgerHoldings: ledgerH7,
    wallets: wallets7,
  });
  const svc7 = new ReconcileService(oc7, l7, a7);
  const nft7 = await svc7.reconcileNftHoldings('user-001');

  check('NFT: isHealthy = true',         nft7.isHealthy === true);
  check('NFT: discrepancies 없음',       nft7.discrepancies.length === 0);
  check('NFT: 알림 없음',                ac7.length === 0);

  // ── [8] reconcileNftHoldings() — LEDGER_ONLY ─────────────────────────
  console.log('\n[검증 8] reconcileNftHoldings() — LEDGER_ONLY (원장에만 있음)');

  const wallets8 = new Map([['user-002', '0xEFGH']]);
  const onchainH8 = new Map([['0xEFGH', [1001n]]]);
  const ledgerH8  = new Map([['user-002', [1001n, 9999n]]]);

  const { onchain: oc8, ledger: l8, alerter: a8, alertCalls: ac8 } = createStubs({
    totalSupply: 1_000_000n, bankBalance: 1_000_000n,
    onchainHoldings: onchainH8,
    ledgerHoldings: ledgerH8,
    wallets: wallets8,
  });
  const svc8 = new ReconcileService(oc8, l8, a8);
  const nft8 = await svc8.reconcileNftHoldings('user-002');

  check('NFT: isHealthy = false',        nft8.isHealthy === false);
  check('NFT: LEDGER_ONLY 1건',
    nft8.discrepancies.length === 1 && nft8.discrepancies[0]?.type === 'LEDGER_ONLY');
  check('NFT: 불일치 tokenId = 9999n',   nft8.discrepancies[0]?.tokenId === 9999n);
  check('NFT: warn 알림 발송',            ac8.length === 1 && ac8[0]?.severity === 'warn');

  // ── [9] reconcileNftHoldings() — ONCHAIN_ONLY ────────────────────────
  console.log('\n[검증 9] reconcileNftHoldings() — ONCHAIN_ONLY (원장 누락)');

  const wallets9 = new Map([['user-003', '0xIJKL']]);
  const onchainH9 = new Map([['0xIJKL', [1001n, 2001n]]]);
  const ledgerH9  = new Map([['user-003', [1001n]]]);

  const { onchain: oc9, ledger: l9, alerter: a9 } = createStubs({
    totalSupply: 1_000_000n, bankBalance: 1_000_000n,
    onchainHoldings: onchainH9,
    ledgerHoldings: ledgerH9,
    wallets: wallets9,
  });
  const svc9 = new ReconcileService(oc9, l9, a9);
  const nft9 = await svc9.reconcileNftHoldings('user-003');

  check('NFT: ONCHAIN_ONLY 1건',
    nft9.discrepancies.length === 1 && nft9.discrepancies[0]?.type === 'ONCHAIN_ONLY');
  check('NFT: 누락 tokenId = 2001n',     nft9.discrepancies[0]?.tokenId === 2001n);

  // ── [10] 역방향 수정 메서드 없음 확인 ────────────────────────────────
  console.log('\n[검증 10] 역방향 수정 메서드 부재 확인');

  const svcAny = svc1 as unknown as Record<string, unknown>;
  check('mintBatch 메서드 없음',        !('mintBatch'       in svcAny));
  check('forceMint 메서드 없음',        !('forceMint'       in svcAny));
  check('sendTransaction 메서드 없음',  !('sendTransaction' in svcAny));

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S25 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. 단일 진실 원칙: 온체인이 항상 맞다. 원장은 캐시.');
  console.log('  2. tolerance = 1n: 처리 지연 구간의 정상 운영 중 오경보 방지');
  console.log('  3. warn: ±1원 초과 / critical: ±100만원 이상');
  console.log('  4. ReconcileService: 감지 + 알림만. 역방향 수정 코드 절대 금지.');
  console.log('  5. 자동 보정하면 안 되는 이유: 정상 지연과 진짜 불일치를 코드가 구분할 수 없음');
})();
