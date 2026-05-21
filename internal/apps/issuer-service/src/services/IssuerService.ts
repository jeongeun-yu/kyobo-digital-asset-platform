import type { IBlockchainAdapter }   from '@kyobo/chain-adapters';
import type { IVASPAdapter }          from '@kyobo/vasp';
import type { ICoreBankingAdapter }   from '@kyobo/core-banking';
import type { IdempotencyGuard }      from '@kyobo/event-engine/webhook';
import type { ActivityEvent }         from './EventConditionService';
import { EventConditionService }      from './EventConditionService';
import { IssuancePolicyService }      from './IssuancePolicyService';
import NFT_ISSUER_ABI                 from '../abi/NFTIssuer.json';

/**
 * IssuerService — NFT 발행 비즈니스 로직
 *
 * 레이어 역할:
 *   Webhook → IssuerService → (조건 판단 → 정책 조회 → KYC/AML → VASP TX 위탁 → CoreBanking 알림)
 *
 * 발행 파이프라인 (M5 S28~S30):
 *   1. EventConditionService.evaluate()  — 조건 관문 (걸음수·자격 등)
 *   2. IssuancePolicyService.getPolicy() — 정책 관문 (tokenId·amount·유효기간)
 *   3. CoreBanking KYC 확인 + VASP AML 스크리닝
 *   4. VASP에 mint TX 위탁 (비동기 완료 — NFT_ISSUED Webhook으로 통보)
 *   5. CoreBanking 보상 알림 (fire-and-forget)
 *
 * 이 서비스는 체인·VASP·CoreBanking 구현을 모른다 (인터페이스만 참조).
 */
export class IssuerService {
  constructor(private readonly deps: {
    chainAdapter:     IBlockchainAdapter;
    vaspAdapter:      IVASPAdapter;
    coreBanking:      ICoreBankingAdapter;
    idempotency:      IdempotencyGuard;
    nftIssuerAddr:    string;
    policyService:    IssuancePolicyService;
    conditionService: EventConditionService;
  }) {}

  /**
   * 활동 달성 NFT 발행
   *
   * @param activityId 오프체인 활동 고유 ID (멱등성 키)
   * @param event      ActivityEvent — 조건 판단·정책 조회에 사용
   * @throws Error 조건 미충족 · 정책 없음 · KYC 실패 · AML 차단 · VASP TX 실패
   */
  async issueActivityNFT(params: {
    userId:     string;
    activityId: string;
    event:      ActivityEvent;
  }): Promise<{ txHash: string; tokenId: string }> {
    const { userId, activityId, event } = params;

    // ── 1. 조건 관문 ─────────────────────────────────────────────────
    const conditionResult = await this.deps.conditionService.evaluate(event);
    if (!conditionResult.eligible) {
      throw new Error(`IssuerService: condition not met: ${conditionResult.reason}`);
    }

    // ── 2. 정책 관문 (tokenId·amount 권위 있는 출처) ──────────────────
    // EventConditionService가 계산한 tokenId는 로컬 검증용.
    // 실제 발행에 사용하는 tokenId는 정책 DB에서만 가져온다 (SRP).
    const policy = await this.deps.policyService.getPolicy(event.eventType);

    // ── 3. KYC / AML ──────────────────────────────────────────────────
    const account = await this.deps.coreBanking.getUserAccount(userId);
    if (!account) throw new Error(`IssuerService: user not found: ${userId}`);
    if (account.status !== 'active') throw new Error(`IssuerService: account not active: ${userId}`);

    const aml = await this.deps.vaspAdapter.screenAddress(account.walletAddr);
    if (aml.flagged) throw new Error(`IssuerService: AML flagged: ${aml.reason}`);

    // ── 4. VASP(월렛원)에 mint TX 위탁 ───────────────────────────────
    // issuer-service(내부망)는 TX를 직접 서명하지 않는다. VASP가 서명·브로드캐스트 후
    // NFT_ISSUED Webhook으로 결과를 통보한다 (비동기 완료).
    const vaspReceipt = await this.deps.vaspAdapter.submitTransaction({
      contractAddr:   this.deps.nftIssuerAddr,
      abi:            NFT_ISSUER_ABI,
      method:         'mint',
      args: [
        account.walletAddr,
        policy.tokenId.toString(),
        policy.amount.toString(),
        `0x${Buffer.from(activityId).toString('hex').padEnd(64, '0')}`,
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
    //   method:       'mint',
    //   args:         [account.walletAddr, policy.tokenId.toString(), policy.amount.toString(), ...],
    // });
    // ─────────────────────────────────────────────────────────────────

    // ── 5. CoreBanking 보상 알림 (fire-and-forget) ────────────────────
    // 알림 실패가 발행 결과에 영향 주지 않음.
    // 원장 최종 기록은 NFT_ISSUED Webhook 수신 후 Consumer가 처리한다.
    this.deps.coreBanking.notifyReward({
      userId,
      rewardType: 'ACTIVITY_NFT',
      tokenId:    policy.tokenId.toString(),
      txHash:     vaspReceipt.txHash,
      issuedAt:   vaspReceipt.timestamp,
    }).catch(err => console.error('[IssuerService] CoreBanking notify failed:', err));

    return { txHash: vaspReceipt.txHash, tokenId: policy.tokenId.toString() };
  }
}
