import type { ICoreBankingAdapter } from '../interfaces/ICoreBankingAdapter';

/**
 * ReconcileService — KRW 스테이블코인 ↔ 원화 수탁 계좌 조정 서비스
 *
 * 설계 원칙 (변경 금지):
 *   온체인 발행량과 교보생명 원화 수탁 계좌 잔액은 항상 1:1이어야 한다.
 *   불일치(disparity) 발생 시 즉시 알림 → 수동 조정 트리거.
 *
 * 실행 주기:
 *   - 실시간: mint/burn 이벤트마다 증분 검증
 *   - 정기:   매일 00:00 KST 전체 잔액 대조 (cron)
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

export class ReconcileService {
  constructor(
    private readonly coreBanking: ICoreBankingAdapter,
    private readonly onchain: {
      getTotalSupply(): Promise<bigint>;
      getCustodyAccountBalance(): Promise<bigint>;  // 수탁 계좌 원화 잔액
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

    return result;
  }

  /**
   * mint/burn 이벤트 수신 후 증분 검증
   * ChainEventListener → NFTIssuedHandler 패턴과 동일하게 이벤트 핸들러로 등록
   */
  async onMint(amount: bigint, txHash: string): Promise<void> {
    await this.coreBanking.recordTransaction({
      txHash,
      userId:    'system',
      type:      'KRW_MINT',
      amount:    amount.toString(),
      status:    'confirmed',
      timestamp: Math.floor(Date.now() / 1000),
    });
    // TODO Phase 2: 증분 조정 후 불일치 시 알림
  }

  async onBurn(amount: bigint, txHash: string): Promise<void> {
    await this.coreBanking.recordTransaction({
      txHash,
      userId:    'system',
      type:      'KRW_BURN',
      amount:    amount.toString(),
      status:    'confirmed',
      timestamp: Math.floor(Date.now() / 1000),
    });
    // TODO Phase 2: 증분 조정 후 불일치 시 알림
  }
}
