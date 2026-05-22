import type { IBlockchainAdapter }        from '@kyobo/chain-adapters';
import type { IVASPAdapter }               from '@kyobo/vasp';
import type { ICoreBankingAdapter }        from '@kyobo/core-banking';
import type { IdempotencyGuard }           from '@kyobo/event-engine/webhook';
import type { ActivityEvent }              from './EventConditionService';
import { EventConditionService }           from './EventConditionService';
import { IssuancePolicyService }           from './IssuancePolicyService';
import type { IIssuanceRequestRepository } from './IssuanceRequestRepository';
import NFT_ISSUER_ABI                      from '../abi/NFTIssuer.json';

/**
 * IssuerService — NFT 발행 오케스트레이터
 *
 * 발행 파이프라인 (M5 S28~S29):
 *   ① 정책 조회   — IssuancePolicyService.getPolicy()  → tokenId·amount·유효기간
 *   ② 조건 판단  — EventConditionService.evaluate()   → eligible 여부
 *   ③ 멱등성 체크 — issuanceRepo.findPending()         → 중복 요청 방지
 *   ④ REQUESTED  — issuanceRepo.create()
 *   ⑤ KYC/AML   — coreBanking + vaspAdapter           → 실패 시 FAILED
 *   ⑥ VASP 위탁  — vaspAdapter.submitTransaction()    → SUBMITTED / 실패 시 FAILED
 *
 * CONFIRMED 전이는 VASP Webhook 핸들러 담당 (이 서비스 범위 밖).
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
    issuanceRepo:     IIssuanceRequestRepository;
  }) {}

  /**
   * 활동 달성 NFT 발행
   *
   * @param activityId VASP 멱등성 키 (동일 activityId → VASP 중복 제출 방지)
   * @param event      ActivityEvent — 조건 판단·정책 조회에 사용
   * @returns eligible=false면 requestId 빈 문자열, DB 레코드 미생성
   * @throws NoPolicyError, Error (KYC·AML·VASP 실패)
   */
  async issueActivityNFT(params: {
    userId:     string;
    activityId: string;
    event:      ActivityEvent;
  }): Promise<{ requestId: string; eligible: boolean; txHash?: string; tokenId?: string }> {
    const { userId, activityId, event } = params;

    // ── ① 정책 조회 — NoPolicyError 상위 전파 ────────────────────────
    // tokenId 권위 있는 출처는 정책 DB. EventConditionService는 tokenId를 모른다 (SRP).
    const policy = await this.deps.policyService.getPolicy(event.eventType);

    // ── ② 조건 판단 ───────────────────────────────────────────────────
    const condition = await this.deps.conditionService.evaluate(event);
    if (!condition.eligible) {
      return { requestId: '', eligible: false };
    }

    // ── ③ 멱등성 체크 — 진행 중 요청 있으면 기존 반환 ────────────────
    const existing = await this.deps.issuanceRepo.findPending(userId, event.eventType, policy.tokenId);
    if (existing) {
      return { requestId: existing.id, eligible: true, txHash: existing.txHash ?? undefined };
    }

    // ── ④ 발행 요청 생성 → REQUESTED ─────────────────────────────────
    const req = await this.deps.issuanceRepo.create({
      userId,
      eventType:  event.eventType,
      tokenId:    policy.tokenId,
      amount:     policy.amount,
      walletAddr: null,
      status:     'REQUESTED',
      txHash:     null,
      failReason: null,
    });

    // ── ⑤ KYC / AML / 지갑 조회 — 실패 → FAILED + throw ─────────────
    let walletAddr: string;
    try {
      const account = await this.deps.coreBanking.getUserAccount(userId);
      if (!account) throw new Error(`user not found: ${userId}`);
      if (account.status !== 'active') throw new Error(`account not active: ${userId}`);

      const aml = await this.deps.vaspAdapter.screenAddress(account.walletAddr);
      if (aml.flagged) throw new Error(`AML flagged: ${aml.reason}`);

      walletAddr = account.walletAddr;
      await this.deps.issuanceRepo.setWalletAddr(req.id, walletAddr);
    } catch (err) {
      await this.deps.issuanceRepo.updateStatus(req.id, 'FAILED', { failReason: (err as Error).message });
      throw err;
    }

    // ── ⑥ VASP 위탁 → SUBMITTED — 실패 → FAILED + throw ─────────────
    // issuer-service(내부망)는 TX를 직접 서명하지 않는다.
    // VASP가 서명·브로드캐스트 후 NFT_ISSUED Webhook으로 결과를 통보한다 (비동기 완료).
    let txHash: string;
    try {
      const vaspReceipt = await this.deps.vaspAdapter.submitTransaction({
        contractAddr:   this.deps.nftIssuerAddr,
        abi:            NFT_ISSUER_ABI,
        method:         'mint',
        args: [
          walletAddr,
          policy.tokenId.toString(),
          policy.amount.toString(),
          `0x${Buffer.from(activityId).toString('hex').padEnd(64, '0')}`,
        ],
        idempotencyKey: activityId,
      });

      if (vaspReceipt.status === 'failed') throw new Error(`VASP TX failed: ${vaspReceipt.txHash}`);

      txHash = vaspReceipt.txHash;
      await this.deps.issuanceRepo.updateStatus(req.id, 'SUBMITTED', { txHash });
    } catch (err) {
      await this.deps.issuanceRepo.updateStatus(req.id, 'FAILED', { failReason: (err as Error).message });
      throw err;
    }

    // Phase 3 전환 시 ⑥ 블록을 chainAdapter.sendTransaction()으로 교체 (자체 Custody 인가 취득 후)

    // ── CoreBanking 보상 알림 (fire-and-forget) ───────────────────────
    // 알림 실패가 발행 결과에 영향 주지 않음.
    // 원장 최종 기록은 NFT_ISSUED Webhook 수신 후 Consumer가 처리한다.
    this.deps.coreBanking.notifyReward({
      userId,
      rewardType: 'ACTIVITY_NFT',
      tokenId:    policy.tokenId.toString(),
      txHash,
      issuedAt:   Math.floor(Date.now() / 1000),
    }).catch(err => console.error('[IssuerService] CoreBanking notify failed:', err));

    return { requestId: req.id, eligible: true, txHash, tokenId: policy.tokenId.toString() };
  }
}
