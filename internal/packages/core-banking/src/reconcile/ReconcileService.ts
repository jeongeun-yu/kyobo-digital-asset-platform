import type { ICoreBankingAdapter } from '../interfaces/ICoreBankingAdapter';
import type { IReconcileService } from './IReconcileService';

/**
 * ReconcileService — KRW 스테이블코인 ↔ 원화 수탁 계좌 / NFT 보유 현황 대조 서비스
 *
 * 설계 원칙 (변경 금지):
 *   온체인 발행량과 교보생명 원화 수탁 계좌 잔액은 항상 1:1이어야 한다.
 *   불일치(disparity) 발생 시 즉시 알림 → 수동 조정 트리거.
 *
 * 실행 주기:
 *   - 실시간: mint/burn 이벤트마다 증분 검증
 *   - 정기:   매일 00:00 KST 전체 잔액 대조 (cron) / NFT: 매시 또는 이벤트 트리거
 *
 * Phase 2 구현 전 상태:
 *   CoreBanking API와 온체인 공급량 조회 모두 stub.
 *   KRWStablecoin 컨트랙트 배포 후 ethers.Contract 주입.
 */

export interface ReconcileResult {
  onchainSupply:  bigint;   // 온체인 totalSupply (원 단위)
  bankBalance:    bigint;   // 교보생명 수탁 계좌 잔액 (원 단위)
  disparity:      bigint;   // onchainSupply - bankBalance (음수 = 과소발행)
  timestamp:      number;
  isHealthy:      boolean;
}

export interface NftReconcileResult {
  isHealthy:      boolean;
  discrepancies:  Array<{
    userId:  string;
    tokenId: bigint;
    type:    'LEDGER_ONLY' | 'ONCHAIN_ONLY';
    // LEDGER_ONLY  — 원장에만 있고 온체인에 없음 (Reorg·DB 조작 의심)
    // ONCHAIN_ONLY — 온체인에만 있고 원장에 없음 (이벤트 미처리)
  }>;
  checkedAt:      number;
}

export class ReconcileService implements IReconcileService {
  private lastResult: ReconcileResult | null = null;

  constructor(
    private readonly coreBanking: ICoreBankingAdapter,
    private readonly onchain: {
      getTotalSupply(): Promise<bigint>;
      getCustodyAccountBalance(): Promise<bigint>;
      /** ERC-1155: balanceOf(account, tokenId) → 보유 수량 */
      balanceOf(address: string, tokenId: bigint): Promise<bigint>;
      /** 특정 주소의 온체인 NFT 보유 tokenId 목록 */
      getNftHoldings(address: string): Promise<bigint[]>;
      /** 현재 블록 번호 조회 */
      getBlockNumber(): Promise<number>;
    },
    private readonly ledger: {
      /** 내부 원장 기준 사용자 NFT 보유 tokenId 목록 */
      getHoldings(userId: string): Promise<bigint[]>;
      /** 특정 tokenId의 원장 누적 수량 (amount 합계) */
      getHoldingAmount(userId: string, tokenId: bigint): Promise<bigint>;
      /** 전체 사용자 ID 목록 (reconcileAllNftHoldings 배치용) */
      getAllUserIds(): Promise<string[]>;
    },
    private readonly alerter: {
      fire(message: string, severity: 'warn' | 'critical'): Promise<void>;
    },
  ) {}

  /**
   * 온체인 공급량 ↔ 수탁 계좌 잔액 대조
   * 불일치 허용 범위(tolerance): 연산 지연 고려 ±1원 (실제 값은 리스크팀 결정)
   */
  async reconcile(): Promise<ReconcileResult> {
    const [onchainSupply, bankBalance] = await Promise.all([
      this.onchain.getTotalSupply(),
      this.onchain.getCustodyAccountBalance(),
    ]);

    const disparity = onchainSupply - bankBalance;
    const tolerance = 1n;
    const isHealthy = disparity >= -tolerance && disparity <= tolerance;

    const result: ReconcileResult = {
      onchainSupply,
      bankBalance,
      disparity,
      timestamp: Math.floor(Date.now() / 1000),
      isHealthy,
    };

    if (!isHealthy) {
      const severity = disparity > 1_000_000n || disparity < -1_000_000n ? 'critical' : 'warn';
      await this.alerter.fire(
        `[Reconcile] 불일치 발생: onchain=${onchainSupply}, bank=${bankBalance}, diff=${disparity}`,
        severity,
      );
    }

    this.lastResult = result;
    return result;
  }

  getLastResult(): ReconcileResult | null {
    return this.lastResult;
  }

  /** 이벤트 블록 기준 확정 깊이 — 리스크팀 협의 값 */
  private static readonly CONFIRMATION_DEPTH = 12;

  /**
   * Mint/Burn 이벤트 수신 후 confirmation depth 확인 → reconcile() 트리거
   * 이벤트 블록 + 12블록 미만이면 아직 Reorg 가능 구간 → 대조 건너뜀
   */
  async onMintEvent(_tokenId: bigint, _amount: bigint, blockNumber: number): Promise<void> {
    const currentBlock = await this.onchain.getBlockNumber();
    if (currentBlock - blockNumber < ReconcileService.CONFIRMATION_DEPTH) return;
    await this.reconcile();
  }

  async onBurnEvent(_tokenId: bigint, _amount: bigint, blockNumber: number): Promise<void> {
    const currentBlock = await this.onchain.getBlockNumber();
    if (currentBlock - blockNumber < ReconcileService.CONFIRMATION_DEPTH) return;
    await this.reconcile();
  }

  /**
   * 단일 사용자 NFT 보유 현황 대조
   *   원장 O / 온체인 X → LEDGER_ONLY  (Reorg·DB 조작 의심)
   *   온체인 O / 원장 X → ONCHAIN_ONLY (이벤트 미처리)
   */
  async reconcileNftHoldings(userId: string): Promise<NftReconcileResult> {
    const account = await this.coreBanking.getUserAccount(userId);
    if (!account) throw new Error(`지갑 주소 없음: userId=${userId}`);

    const [ledgerTokens, onchainTokens] = await Promise.all([
      this.ledger.getHoldings(userId),
      this.onchain.getNftHoldings(account.walletAddr),
    ]);

    const discrepancies: NftReconcileResult['discrepancies'] = [];

    // 원장에만 있는 토큰 확인
    for (const tokenId of ledgerTokens) {
      const balance = await this.onchain.balanceOf(account.walletAddr, tokenId);
      if (balance === 0n) {
        discrepancies.push({ userId, tokenId, type: 'LEDGER_ONLY' });
      }
    }

    // 온체인에만 있는 토큰 확인 (원장 미등록 또는 온체인 잔고 > 원장 합계)
    const ledgerSet = new Set(ledgerTokens.map(String));
    for (const tokenId of onchainTokens) {
      if (!ledgerSet.has(String(tokenId))) {
        discrepancies.push({ userId, tokenId, type: 'ONCHAIN_ONLY' });
      } else {
        // tokenId가 양쪽에 있어도 온체인 잔고가 원장 합계보다 크면 미반영 민팅이 있는 것
        const [onchainBalance, ledgerAmount] = await Promise.all([
          this.onchain.balanceOf(account.walletAddr, tokenId),
          this.ledger.getHoldingAmount(userId, tokenId),
        ]);
        if (onchainBalance > ledgerAmount) {
          discrepancies.push({ userId, tokenId, type: 'ONCHAIN_ONLY' });
        }
      }
    }

    const isHealthy = discrepancies.length === 0;

    if (!isHealthy) {
      const severity = discrepancies.length >= 10 ? 'critical' : 'warn';
      await this.alerter.fire(
        `[NFT Reconcile] userId=${userId}, 불일치=${discrepancies.length}건`,
        severity,
      );
    }

    return { isHealthy, discrepancies, checkedAt: Date.now() };
  }

  /**
   * 전체 사용자 NFT 보유 현황 일괄 대조 (정기 배치)
   * 불일치가 한 건이라도 있으면 isHealthy = false
   */
  async reconcileAllNftHoldings(): Promise<NftReconcileResult> {
    const userIds = await this.ledger.getAllUserIds();
    const allDiscrepancies: NftReconcileResult['discrepancies'] = [];

    for (const userId of userIds) {
      const result = await this.reconcileNftHoldings(userId);
      allDiscrepancies.push(...result.discrepancies);
    }

    const isHealthy = allDiscrepancies.length === 0;

    if (!isHealthy) {
      const severity = allDiscrepancies.length >= 10 ? 'critical' : 'warn';
      await this.alerter.fire(
        `[NFT Reconcile All] 전체 불일치=${allDiscrepancies.length}건`,
        severity,
      );
    }

    return { isHealthy, discrepancies: allDiscrepancies, checkedAt: Date.now() };
  }
}
