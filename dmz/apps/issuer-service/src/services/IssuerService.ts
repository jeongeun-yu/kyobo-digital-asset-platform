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

    // 1. Core Banking에서 사용자 계정·지갑 주소 조회
    const account = await this.deps.coreBanking.getUserAccount(userId);
    if (!account) throw new Error(`IssuerService: user not found: ${userId}`);
    if (account.status !== 'active') throw new Error(`IssuerService: account not active: ${userId}`);

    // 2. AML 스크리닝 — 블랙리스트 주소 차단
    const aml = await this.deps.vaspAdapter.screenAddress(account.walletAddr);
    if (aml.flagged) throw new Error(`IssuerService: AML flagged: ${aml.reason}`);

    // 3. 컨트랙트 호출 — NFTIssuer.issueActivityNFT
    const receipt = await this.deps.chainAdapter.sendTransaction({
      contractAddr: this.deps.nftIssuerAddr,
      abi:          NFT_ISSUER_ABI,
      method:       'issueActivityNFT',
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
    });

    if (receipt.status === 'failed') {
      throw new Error(`IssuerService: tx failed: ${receipt.txHash}`);
    }

    // 4. Core Banking 알림 (비동기 — 실패해도 발행은 완료)
    this.deps.coreBanking.notifyReward({
      userId,
      rewardType: 'ACTIVITY_NFT',
      tokenId:    activityId,
      txHash:     receipt.txHash,
      issuedAt:   receipt.timestamp,
    }).catch(err => console.error('[IssuerService] CoreBanking notify failed:', err));

    return { txHash: receipt.txHash };
  }
}
