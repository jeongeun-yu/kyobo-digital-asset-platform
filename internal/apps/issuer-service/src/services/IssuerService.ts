import type { IBlockchainAdapter }   from '@kyobo/chain-adapters';
import type { IVASPAdapter }          from '@kyobo/vasp';
import type { ICoreBankingAdapter }   from '@kyobo/core-banking';
import type { IdempotencyGuard }      from '@kyobo/event-engine/webhook';
import NFT_ISSUER_ABI                 from '../abi/NFTIssuer.json';

/**
 * IssuerService — NFT 발행 비즈니스 로직
 *
 * 레이어 역할:
 *   Webhook → IssuerService → (KYC 확인 → AML 스크리닝 → 컨트랙트 호출 → CoreBanking 알림)
 *
 * 이 서비스는 체인·VASP·CoreBanking 구현을 모른다 (인터페이스만 참조).
 * Phase 2/3에서 로직이 추가되면 이 클래스에 메서드가 추가된다.
 */
export class IssuerService {
  constructor(private readonly deps: {
    chainAdapter:  IBlockchainAdapter;
    vaspAdapter:   IVASPAdapter;
    coreBanking:   ICoreBankingAdapter;
    idempotency:   IdempotencyGuard;
    nftIssuerAddr: string;
  }) {}

  /**
   * 활동 달성 NFT 발행
   * @param activityId 오프체인 활동 고유 ID (멱등성 키)
   */
  async issueActivityNFT(params: {
    userId:     string;
    activityId: string;
    oracleData: { dataType: string; value: number; timestamp: number; signature: string };
  }): Promise<{ txHash: string; tokenId?: string }> {
    const { userId, activityId, oracleData } = params;

    const account = await this.deps.coreBanking.getUserAccount(userId);
    if (!account) throw new Error(`IssuerService: user not found: ${userId}`);
    if (account.status !== 'active') throw new Error(`IssuerService: account not active: ${userId}`);

    const aml = await this.deps.vaspAdapter.screenAddress(account.walletAddr);
    if (aml.flagged) throw new Error(`IssuerService: AML flagged: ${aml.reason}`);

    // ── Phase 1: VASP(월렛원)에 TX 위탁 ──────────────────────────────
    // issuer-service(내부망)는 TX를 직접 서명하지 않는다. VASP가 서명·브로드캐스트 후
    // NFT_ISSUED Webhook으로 결과를 통보한다 (비동기 완료).
    const vaspReceipt = await this.deps.vaspAdapter.submitTransaction({
      contractAddr:   this.deps.nftIssuerAddr,
      abi:            NFT_ISSUER_ABI,
      method:         'issueActivityNFT',
      args: [
        account.walletAddr,
        `0x${Buffer.from(activityId).toString('hex').padEnd(64, '0')}`,
        {
          dataType:  `0x${Buffer.from(oracleData.dataType).toString('hex').padEnd(64, '0')}`,
          value:     oracleData.value,
          timestamp: oracleData.timestamp,
          signature: oracleData.signature,
        },
      ],
      idempotencyKey: activityId,
    });

    if (vaspReceipt.status === 'failed') {
      throw new Error(`IssuerService: VASP TX failed: ${vaspReceipt.txHash}`);
    }

    // Phase 3 전환 시 위 블록을 아래로 교체 (자체 Custody 인가 취득 후):
    // const receipt = await this.deps.chainAdapter.sendTransaction({
    //   contractAddr: this.deps.nftIssuerAddr,
    //   abi:          NFT_ISSUER_ABI,
    //   method:       'issueActivityNFT',
    //   args:         [...],
    // });
    // ─────────────────────────────────────────────────────────────────

    // fire-and-forget: 알림 실패가 발행 결과에 영향 주지 않음
    // 원장 최종 기록은 NFT_ISSUED Webhook 수신 후 Consumer가 처리한다
    this.deps.coreBanking.notifyReward({
      userId,
      rewardType: 'ACTIVITY_NFT',
      tokenId:    activityId,
      txHash:     vaspReceipt.txHash,
      issuedAt:   vaspReceipt.timestamp,
    }).catch(err => console.error('[IssuerService] CoreBanking notify failed:', err));

    return { txHash: vaspReceipt.txHash };
  }
}
