/**
 * ReconcileService 단위 테스트
 *
 * KRW 발행량 대조, 불일치 알림, 심각도 분류, onMint/onBurn, NFT 보유 대조 검증
 */

import { ReconcileService } from '../reconcile/ReconcileService';
import type { ICoreBankingAdapter, UserAccount } from '../interfaces/ICoreBankingAdapter';

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function makeCoreBanking(walletAddr = '0xabc'): ICoreBankingAdapter & { recordCalls: unknown[] } {
  const recordCalls: unknown[] = [];
  return {
    recordCalls,
    async getUserAccount(userId: string): Promise<UserAccount | null> {
      return { userId, accountId: 'acc-1', walletAddr, status: 'active' };
    },
    async notifyReward()      {},
    async syncBalance()       { return { confirmed: true }; },
    async recordTransaction(tx: unknown) { recordCalls.push(tx); },
    async recordNftHolding()  {},
    async recordAuditLog()    {},
  } as any;
}

function makeOnchain(
  supply: bigint,
  bankBalance: bigint,
  onchainHoldings: Map<string, bigint[]> = new Map(),
  currentBlock = 1000,
) {
  return {
    async getTotalSupply()           { return supply; },
    async getCustodyAccountBalance() { return bankBalance; },
    async balanceOf(address: string, tokenId: bigint): Promise<bigint> {
      const tokens = onchainHoldings.get(address) ?? [];
      // 배열 내 중복 항목 수 = 온체인 잔고 (동일 tokenId 2회 민팅 시 balance=2)
      return BigInt(tokens.filter(t => t === tokenId).length);
    },
    async getNftHoldings(address: string): Promise<bigint[]> {
      // balance > 0인 고유 tokenId 반환 (실제 EVMAdapter와 동일)
      const tokens = onchainHoldings.get(address) ?? [];
      return [...new Set(tokens.map(String))].map(BigInt);
    },
    async getBlockNumber() { return currentBlock; },
  };
}

function makeLedger(ledgerHoldings: Map<string, bigint[]> = new Map()) {
  return {
    async getHoldings(userId: string): Promise<bigint[]> {
      return ledgerHoldings.get(userId) ?? [];
    },
    async getHoldingAmount(userId: string, tokenId: bigint): Promise<bigint> {
      const holdings = ledgerHoldings.get(userId) ?? [];
      return BigInt(holdings.filter(t => t === tokenId).length);
    },
    async getAllUserIds(): Promise<string[]> {
      return [...ledgerHoldings.keys()];
    },
  };
}

function makeAlerter() {
  const fires: Array<{ msg: string; severity: string }> = [];
  return {
    fires,
    async fire(message: string, severity: 'warn' | 'critical') {
      fires.push({ msg: message, severity });
    },
  };
}

// ── KRW 발행량 대조 ───────────────────────────────────────────────────────────

describe('ReconcileService.reconcile()', () => {
  it('공급량 = 잔액 → isHealthy: true', async () => {
    const svc = new ReconcileService(
      makeCoreBanking(), makeOnchain(1_000_000n, 1_000_000n), makeLedger(), makeAlerter(),
    );
    const result = await svc.reconcile();
    expect(result.isHealthy).toBe(true);
    expect(result.disparity).toBe(0n);
  });

  it('disparity = 0 → 알림 없음', async () => {
    const alerter = makeAlerter();
    const svc = new ReconcileService(
      makeCoreBanking(), makeOnchain(500_000n, 500_000n), makeLedger(), alerter,
    );
    await svc.reconcile();
    expect(alerter.fires).toHaveLength(0);
  });

  it('tolerance ±1 → isHealthy: true', async () => {
    const svc = new ReconcileService(
      makeCoreBanking(), makeOnchain(1_000_001n, 1_000_000n), makeLedger(), makeAlerter(),
    );
    const result = await svc.reconcile();
    expect(result.isHealthy).toBe(true);
  });

  it('disparity = 2 → isHealthy: false, warn 알림', async () => {
    const alerter = makeAlerter();
    const svc = new ReconcileService(
      makeCoreBanking(), makeOnchain(1_000_002n, 1_000_000n), makeLedger(), alerter,
    );
    const result = await svc.reconcile();
    expect(result.isHealthy).toBe(false);
    expect(alerter.fires).toHaveLength(1);
    expect(alerter.fires[0]!.severity).toBe('warn');
  });

  it('disparity > 1,000,000 → critical 알림', async () => {
    const alerter = makeAlerter();
    const svc = new ReconcileService(
      makeCoreBanking(), makeOnchain(2_000_002n, 1_000_000n), makeLedger(), alerter,
    );
    await svc.reconcile();
    expect(alerter.fires[0]!.severity).toBe('critical');
  });

  it('결과에 onchainSupply, bankBalance, timestamp 포함', async () => {
    const svc = new ReconcileService(
      makeCoreBanking(), makeOnchain(999_999n, 999_999n), makeLedger(), makeAlerter(),
    );
    const result = await svc.reconcile();
    expect(result.onchainSupply).toBe(999_999n);
    expect(result.bankBalance).toBe(999_999n);
    expect(typeof result.timestamp).toBe('number');
  });
});

// ── onMint / onBurn ───────────────────────────────────────────────────────────

describe('ReconcileService.onMintEvent() / onBurnEvent()', () => {
  it('confirmation depth 미달(11블록) → reconcile() 스킵', async () => {
    const svc = new ReconcileService(
      makeCoreBanking(), makeOnchain(1_000_000n, 1_000_000n, new Map(), 1011),
      makeLedger(), makeAlerter(),
    );
    await svc.onMintEvent(1n, 100_000n, 1000);  // 1011 - 1000 = 11 < 12
    expect(svc.getLastResult()).toBeNull();       // reconcile 호출 안 됨
  });

  it('confirmation depth 충족(12블록) → reconcile() 실행', async () => {
    const svc = new ReconcileService(
      makeCoreBanking(), makeOnchain(1_000_000n, 1_000_000n, new Map(), 1012),
      makeLedger(), makeAlerter(),
    );
    await svc.onMintEvent(1n, 100_000n, 1000);  // 1012 - 1000 = 12 >= 12
    expect(svc.getLastResult()?.isHealthy).toBe(true);
  });

  it('onBurnEvent — depth 충족 + 불일치 시 critical 알림', async () => {
    const alerter = makeAlerter();
    const svc = new ReconcileService(
      makeCoreBanking(), makeOnchain(3_000_000n, 1_000_000n, new Map(), 1012),
      makeLedger(), alerter,
    );
    await svc.onBurnEvent(1n, 50_000n, 1000);
    expect(alerter.fires).toHaveLength(1);
    expect(alerter.fires[0]!.severity).toBe('critical');
  });
});

// ── NFT 보유 대조 ─────────────────────────────────────────────────────────────

describe('ReconcileService.reconcileNftHoldings()', () => {
  const ADDR = '0xabc';

  it('원장 = 온체인 → isHealthy: true, discrepancies 없음', async () => {
    const onchainH = new Map([[ADDR, [1001n, 1002n]]]);
    const ledgerH  = new Map([['user-1', [1001n, 1002n]]]);
    const svc = new ReconcileService(
      makeCoreBanking(ADDR),
      makeOnchain(0n, 0n, onchainH),
      makeLedger(ledgerH),
      makeAlerter(),
    );
    const result = await svc.reconcileNftHoldings('user-1');
    expect(result.isHealthy).toBe(true);
    expect(result.discrepancies).toHaveLength(0);
  });

  it('원장에만 있는 NFT → LEDGER_ONLY, warn 알림', async () => {
    const onchainH = new Map([[ADDR, [1001n]]]);
    const ledgerH  = new Map([['user-1', [1001n, 9999n]]]);
    const alerter  = makeAlerter();
    const svc = new ReconcileService(
      makeCoreBanking(ADDR),
      makeOnchain(0n, 0n, onchainH),
      makeLedger(ledgerH),
      alerter,
    );
    const result = await svc.reconcileNftHoldings('user-1');
    expect(result.isHealthy).toBe(false);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.type).toBe('LEDGER_ONLY');
    expect(result.discrepancies[0]!.tokenId).toBe(9999n);
    expect(alerter.fires[0]!.severity).toBe('warn');
  });

  it('온체인에만 있는 NFT → ONCHAIN_ONLY', async () => {
    const onchainH = new Map([[ADDR, [1001n, 2001n]]]);
    const ledgerH  = new Map([['user-1', [1001n]]]);
    const svc = new ReconcileService(
      makeCoreBanking(ADDR),
      makeOnchain(0n, 0n, onchainH),
      makeLedger(ledgerH),
      makeAlerter(),
    );
    const result = await svc.reconcileNftHoldings('user-1');
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.type).toBe('ONCHAIN_ONLY');
    expect(result.discrepancies[0]!.tokenId).toBe(2001n);
  });

  it('원장 있지만 온체인 잔고 > 원장 합계 → ONCHAIN_ONLY (no-emit 중복 민팅 케이스)', async () => {
    // 온체인: tokenId=1001 balance=2 (pending 1회 + no-emit 1회)
    // 원장:   tokenId=1001 amount=1  (pending CREDITED 1회만 반영)
    const onchainH = new Map([[ADDR, [1001n, 1001n]]]);  // 중복 = balance 2
    const ledgerH  = new Map([['user-1', [1001n]]]);      // 원장 합계 1
    const svc = new ReconcileService(
      makeCoreBanking(ADDR),
      makeOnchain(0n, 0n, onchainH),
      makeLedger(ledgerH),
      makeAlerter(),
    );
    const result = await svc.reconcileNftHoldings('user-1');
    expect(result.isHealthy).toBe(false);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.type).toBe('ONCHAIN_ONLY');
    expect(result.discrepancies[0]!.tokenId).toBe(1001n);
  });

  it('지갑 주소 없는 사용자 → Error throw', async () => {
    const cb = {
      ...makeCoreBanking(),
      async getUserAccount() { return null; },
    } as any;
    const svc = new ReconcileService(cb, makeOnchain(0n, 0n), makeLedger(), makeAlerter());
    await expect(svc.reconcileNftHoldings('no-wallet')).rejects.toThrow();
  });

  it('checkedAt 타임스탬프가 양수', async () => {
    const svc = new ReconcileService(
      makeCoreBanking(ADDR), makeOnchain(0n, 0n), makeLedger(), makeAlerter(),
    );
    const result = await svc.reconcileNftHoldings('user-1');
    expect(result.checkedAt).toBeGreaterThan(0);
  });
});
