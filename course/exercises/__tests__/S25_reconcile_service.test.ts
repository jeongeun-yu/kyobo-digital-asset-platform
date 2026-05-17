/**
 * S25 채점 — ReconcileService: 발행량 vs 수탁 잔액 대조 · tolerance · warn/critical 분류
 *
 * 채점 기준:
 *   · reconcile() — onchainSupply vs bankBalance, disparity 계산, isHealthy
 *   · tolerance = 1n — ±1원 허용
 *   · warn: ±1원 초과 ~ 100만원 미만 불일치
 *   · critical: ±100만원 이상 불일치
 *   · getLastResult() — 마지막 결과 캐싱
 *   · reconcileNftHoldings() — LEDGER_ONLY / ONCHAIN_ONLY 불일치 감지
 *   · 역방향 수정 메서드(mintBatch, forceMint, sendTransaction) 부재
 */

import {
  ReconcileService,
  createStubs,
} from '../M4/S25_reconcile_service';

// ── 채점 테스트 ───────────────────────────────────────────────────────────────

describe('S25 채점 — ReconcileService', () => {

  describe('reconcile() — 발행량 vs 수탁 잔액 대조', () => {
    it('TODO: 발행량 = 잔액이면 isHealthy=true, disparity=0n이어야 한다', async () => {
      const { onchain, ledger, alerter, alertCalls } = createStubs({ totalSupply: 1_000_000n, bankBalance: 1_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const r = await svc.reconcile();
      expect(r.isHealthy).toBe(true);
      expect(r.disparity).toBe(0n);
      expect(alertCalls).toHaveLength(0);
    });

    it('TODO: timestamp가 양수여야 한다', async () => {
      const { onchain, ledger, alerter } = createStubs({ totalSupply: 1_000_000n, bankBalance: 1_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const r = await svc.reconcile();
      expect(r.timestamp).toBeGreaterThan(0);
    });

    it('TODO: onchainSupply와 bankBalance가 결과에 포함되어야 한다', async () => {
      const { onchain, ledger, alerter } = createStubs({ totalSupply: 5_000_000n, bankBalance: 3_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const r = await svc.reconcile();
      expect(r.onchainSupply).toBe(5_000_000n);
      expect(r.bankBalance).toBe(3_000_000n);
    });
  });

  describe('tolerance — ±1원 허용 오차', () => {
    it('TODO: +1원 오차 (disparity=1n)는 isHealthy=true이어야 한다', async () => {
      const { onchain, ledger, alerter, alertCalls } = createStubs({ totalSupply: 1_000_001n, bankBalance: 1_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const r = await svc.reconcile();
      expect(r.isHealthy).toBe(true);
      expect(r.disparity).toBe(1n);
      expect(alertCalls).toHaveLength(0);
    });

    it('TODO: -1원 오차 (disparity=-1n)는 isHealthy=true이어야 한다', async () => {
      const { onchain, ledger, alerter, alertCalls } = createStubs({ totalSupply: 999_999n, bankBalance: 1_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const r = await svc.reconcile();
      expect(r.isHealthy).toBe(true);
      expect(r.disparity).toBe(-1n);
      expect(alertCalls).toHaveLength(0);
    });

    it('TODO: ±2원 오차부터는 isHealthy=false이어야 한다', async () => {
      const { onchain, ledger, alerter } = createStubs({ totalSupply: 1_000_002n, bankBalance: 1_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const r = await svc.reconcile();
      expect(r.isHealthy).toBe(false);
    });
  });

  describe('warn / critical 알림 분류', () => {
    it('TODO: 100만원 미만 불일치 (disparity=1000n) → warn 알림이 발송되어야 한다', async () => {
      const { onchain, ledger, alerter, alertCalls } = createStubs({ totalSupply: 1_000_000n, bankBalance: 999_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const r = await svc.reconcile();
      expect(r.isHealthy).toBe(false);
      expect(r.disparity).toBe(1000n);
      expect(alertCalls).toHaveLength(1);
      expect(alertCalls[0]?.severity).toBe('warn');
    });

    it('TODO: 100만원 이상 불일치 → critical 알림이 발송되어야 한다', async () => {
      const { onchain, ledger, alerter, alertCalls } = createStubs({ totalSupply: 5_000_000n, bankBalance: 3_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const r = await svc.reconcile();
      expect(r.disparity).toBe(2_000_000n);
      expect(alertCalls).toHaveLength(1);
      expect(alertCalls[0]?.severity).toBe('critical');
    });

    it('TODO: 과소발행 — 음수 disparity에서도 warn/critical이 올바르게 분류되어야 한다', async () => {
      const { onchain, ledger, alerter, alertCalls } = createStubs({ totalSupply: 900_000n, bankBalance: 1_500_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const r = await svc.reconcile();
      expect(r.disparity).toBe(-600_000n);
      expect(r.isHealthy).toBe(false);
      expect(alertCalls).toHaveLength(1);
      expect(alertCalls[0]?.severity).toBe('warn');
    });

    it('TODO: ±100만원 경계값 (disparity=1_000_000n) → critical이어야 한다', async () => {
      const { onchain, ledger, alerter, alertCalls } = createStubs({ totalSupply: 2_000_000n, bankBalance: 1_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      await svc.reconcile();
      expect(alertCalls[0]?.severity).toBe('critical');
    });
  });

  describe('getLastResult() — 마지막 결과 캐싱', () => {
    it('TODO: reconcile 실행 전 getLastResult()는 null이어야 한다', () => {
      const { onchain, ledger, alerter } = createStubs({ totalSupply: 1_000_000n, bankBalance: 1_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      expect(svc.getLastResult()).toBeNull();
    });

    it('TODO: reconcile 실행 후 getLastResult()가 마지막 결과를 반환해야 한다', async () => {
      const { onchain, ledger, alerter } = createStubs({ totalSupply: 1_000_000n, bankBalance: 999_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const r = await svc.reconcile();
      const last = svc.getLastResult();
      expect(last?.timestamp).toBe(r.timestamp);
      expect(last?.disparity).toBe(r.disparity);
    });
  });

  describe('reconcileNftHoldings() — 온체인 vs 원장 NFT 대조', () => {
    it('TODO: 원장과 온체인 보유 NFT가 일치하면 isHealthy=true, discrepancies 없음이어야 한다', async () => {
      const wallets = new Map([['user-001', '0xabcd000000000000000000000000000000000000']]);
      const onchainH = new Map([['0xabcd000000000000000000000000000000000000', [1001n, 1002n]]]);
      const ledgerH  = new Map([['user-001', [1001n, 1002n]]]);
      const { onchain, ledger, alerter, alertCalls } = createStubs({
        totalSupply: 1_000_000n, bankBalance: 1_000_000n,
        onchainHoldings: onchainH, ledgerHoldings: ledgerH, wallets,
      });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const nft = await svc.reconcileNftHoldings('user-001');
      expect(nft.isHealthy).toBe(true);
      expect(nft.discrepancies).toHaveLength(0);
      expect(alertCalls).toHaveLength(0);
    });

    it('TODO: 원장에만 있는 NFT는 LEDGER_ONLY 불일치로 감지되어야 한다', async () => {
      const wallets = new Map([['user-002', '0xef890000000000000000000000000000000000ef']]);
      const onchainH = new Map([['0xef890000000000000000000000000000000000ef', [1001n]]]);
      const ledgerH  = new Map([['user-002', [1001n, 9999n]]]);
      const { onchain, ledger, alerter, alertCalls } = createStubs({
        totalSupply: 1_000_000n, bankBalance: 1_000_000n,
        onchainHoldings: onchainH, ledgerHoldings: ledgerH, wallets,
      });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const nft = await svc.reconcileNftHoldings('user-002');
      expect(nft.isHealthy).toBe(false);
      expect(nft.discrepancies).toHaveLength(1);
      expect(nft.discrepancies[0]?.type).toBe('LEDGER_ONLY');
      expect(nft.discrepancies[0]?.tokenId).toBe(9999n);
      expect(alertCalls).toHaveLength(1);
      expect(alertCalls[0]?.severity).toBe('warn');
    });

    it('TODO: 온체인에만 있는 NFT는 ONCHAIN_ONLY 불일치로 감지되어야 한다', async () => {
      const wallets = new Map([['user-003', '0x194b0000000000000000000000000000000000ab']]);
      const onchainH = new Map([['0x194b0000000000000000000000000000000000ab', [1001n, 2001n]]]);
      const ledgerH  = new Map([['user-003', [1001n]]]);
      const { onchain, ledger, alerter } = createStubs({
        totalSupply: 1_000_000n, bankBalance: 1_000_000n,
        onchainHoldings: onchainH, ledgerHoldings: ledgerH, wallets,
      });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const nft = await svc.reconcileNftHoldings('user-003');
      expect(nft.discrepancies).toHaveLength(1);
      expect(nft.discrepancies[0]?.type).toBe('ONCHAIN_ONLY');
      expect(nft.discrepancies[0]?.tokenId).toBe(2001n);
    });

    it('TODO: 지갑 주소 없는 사용자 조회 시 에러가 발생해야 한다', async () => {
      const { onchain, ledger, alerter } = createStubs({ totalSupply: 1_000_000n, bankBalance: 1_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter);
      await expect(svc.reconcileNftHoldings('no-wallet-user')).rejects.toThrow();
    });

    it('TODO: checkedAt 타임스탬프가 양수여야 한다', async () => {
      const wallets = new Map([['user-001', '0xabcd000000000000000000000000000000000000']]);
      const { onchain, ledger, alerter } = createStubs({
        totalSupply: 1_000_000n, bankBalance: 1_000_000n,
        wallets,
      });
      const svc = new ReconcileService(onchain, ledger, alerter);
      const nft = await svc.reconcileNftHoldings('user-001');
      expect(nft.checkedAt).toBeGreaterThan(0);
    });
  });

  describe('역방향 수정 메서드 부재 확인', () => {
    it('TODO: ReconcileService에 mintBatch 메서드가 없어야 한다', () => {
      const { onchain, ledger, alerter } = createStubs({ totalSupply: 1_000_000n, bankBalance: 1_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter) as unknown as Record<string, unknown>;
      expect('mintBatch' in svc).toBe(false);
    });

    it('TODO: ReconcileService에 forceMint 메서드가 없어야 한다', () => {
      const { onchain, ledger, alerter } = createStubs({ totalSupply: 1_000_000n, bankBalance: 1_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter) as unknown as Record<string, unknown>;
      expect('forceMint' in svc).toBe(false);
    });

    it('TODO: ReconcileService에 sendTransaction 메서드가 없어야 한다', () => {
      const { onchain, ledger, alerter } = createStubs({ totalSupply: 1_000_000n, bankBalance: 1_000_000n });
      const svc = new ReconcileService(onchain, ledger, alerter) as unknown as Record<string, unknown>;
      expect('sendTransaction' in svc).toBe(false);
    });
  });
});
