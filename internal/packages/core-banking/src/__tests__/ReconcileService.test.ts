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
) {
  return {
    async getTotalSupply()           { return supply; },
    async getCustodyAccountBalance() { return bankBalance; },
    async balanceOf(address: string, tokenId: bigint): Promise<bigint> {
      const tokens = onchainHoldings.get(address) ?? [];
      return tokens.includes(tokenId) ? 1n : 0n;
    },
    async getNftHoldings(address: string): Promise<bigint[]> {
      return onchainHoldings.get(address) ?? [];
    },
  };
}

function makeLedger(ledgerHoldings: Map<string, bigint[]> = new Map()) {
  return {
    async getHoldings(userId: string): Promise<bigint[]> {
      return ledgerHoldings.get(userId) ?? [];
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

describe('ReconcileService.onMint()', () => {
  it('coreBanking.recordTransaction KRW_MINT으로 호출', async () => {
    const cb = makeCoreBanking();
    const svc = new ReconcileService(cb, makeOnchain(0n, 0n), makeLedger(), makeAlerter());
    await svc.onMint(100_000n, '0xminthash');
    expect(cb.recordCalls).toHaveLength(1);
    const call = cb.recordCalls[0] as any;
    expect(call.type).toBe('KRW_MINT');
    expect(call.amount).toBe('100000');
    expect(call.txHash).toBe('0xminthash');
  });
});

describe('ReconcileService.onBurn()', () => {
  it('coreBanking.recordTransaction KRW_BURN으로 호출', async () => {
    const cb = makeCoreBanking();
    const svc = new ReconcileService(cb, makeOnchain(0n, 0n), makeLedger(), makeAlerter());
    await svc.onBurn(50_000n, '0xburnhash');
    expect(cb.recordCalls).toHaveLength(1);
    const call = cb.recordCalls[0] as any;
    expect(call.type).toBe('KRW_BURN');
    expect(call.amount).toBe('50000');
    expect(call.txHash).toBe('0xburnhash');
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
