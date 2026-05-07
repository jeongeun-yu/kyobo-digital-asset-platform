/**
 * ReconcileService 단위 테스트
 *
 * 온체인-은행 잔액 대조, 불일치 알림, 심각도 분류, onMint/onBurn 검증
 */

import { ReconcileService } from '../reconcile/ReconcileService';
import type { ICoreBankingAdapter } from '../interfaces/ICoreBankingAdapter';

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function makeCoreBanking(): ICoreBankingAdapter & { recordCalls: unknown[] } {
  const recordCalls: unknown[] = [];
  return {
    recordCalls,
    async recordTransaction(tx) { recordCalls.push(tx); },
    async getNftHolding()  { return null as any; },
    async recordNftHolding() {},
    async healthCheck() { return true; },
  } as any;
}

function makeOnchain(supply: bigint, bankBalance: bigint) {
  return {
    async getTotalSupply()          { return supply; },
    async getCustodyAccountBalance() { return bankBalance; },
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

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('ReconcileService.reconcile()', () => {
  it('공급량 = 잔액 → isHealthy: true', async () => {
    const svc = new ReconcileService(
      makeCoreBanking(),
      makeOnchain(1_000_000n, 1_000_000n),
      makeAlerter(),
    );
    const result = await svc.reconcile();
    expect(result.isHealthy).toBe(true);
    expect(result.disparity).toBe(0n);
  });

  it('disparity = 0 → 알림 없음', async () => {
    const alerter = makeAlerter();
    const svc = new ReconcileService(
      makeCoreBanking(),
      makeOnchain(500_000n, 500_000n),
      alerter,
    );
    await svc.reconcile();
    expect(alerter.fires).toHaveLength(0);
  });

  it('tolerance ±1 → isHealthy: true', async () => {
    const svc = new ReconcileService(
      makeCoreBanking(),
      makeOnchain(1_000_001n, 1_000_000n),  // disparity = 1
      makeAlerter(),
    );
    const result = await svc.reconcile();
    expect(result.isHealthy).toBe(true);
  });

  it('disparity = 2 → isHealthy: false, warn 알림', async () => {
    const alerter = makeAlerter();
    const svc = new ReconcileService(
      makeCoreBanking(),
      makeOnchain(1_000_002n, 1_000_000n),
      alerter,
    );
    const result = await svc.reconcile();
    expect(result.isHealthy).toBe(false);
    expect(alerter.fires).toHaveLength(1);
    expect(alerter.fires[0]!.severity).toBe('warn');
  });

  it('disparity > 1,000,000 → critical 알림', async () => {
    const alerter = makeAlerter();
    const svc = new ReconcileService(
      makeCoreBanking(),
      makeOnchain(2_000_002n, 1_000_000n),  // disparity = 1,000,002
      alerter,
    );
    await svc.reconcile();
    expect(alerter.fires[0]!.severity).toBe('critical');
  });

  it('결과에 onchainSupply, bankBalance, timestamp 포함', async () => {
    const svc = new ReconcileService(
      makeCoreBanking(),
      makeOnchain(999_999n, 999_999n),
      makeAlerter(),
    );
    const result = await svc.reconcile();
    expect(result.onchainSupply).toBe(999_999n);
    expect(result.bankBalance).toBe(999_999n);
    expect(typeof result.timestamp).toBe('number');
  });
});

describe('ReconcileService.onMint()', () => {
  it('coreBanking.recordTransaction KRW_MINT으로 호출', async () => {
    const cb = makeCoreBanking();
    const svc = new ReconcileService(cb, makeOnchain(0n, 0n), makeAlerter());
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
    const svc = new ReconcileService(cb, makeOnchain(0n, 0n), makeAlerter());
    await svc.onBurn(50_000n, '0xburnhash');
    expect(cb.recordCalls).toHaveLength(1);
    const call = cb.recordCalls[0] as any;
    expect(call.type).toBe('KRW_BURN');
    expect(call.amount).toBe('50000');
    expect(call.txHash).toBe('0xburnhash');
  });
});
