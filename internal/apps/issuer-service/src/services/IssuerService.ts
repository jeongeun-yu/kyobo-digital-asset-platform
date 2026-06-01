import type { IBlockchainAdapter }        from '@kyobo/chain-adapters';
import type { ICoreBankingAdapter }        from '@kyobo/core-banking';
import type { ActivityEvent }              from './EventConditionService';
import { EventConditionService }           from './EventConditionService';
import { IssuancePolicyService }           from './IssuancePolicyService';
import type { IIssuanceRequestRepository } from './IssuanceRequestRepository';
import { TxStateMachineService }           from '../../../../packages/vasp/src/tx/TxStateMachineService';
import type { LedgerService }              from '../../../../packages/core-banking/src/ledger/LedgerService';

/**
 * IssuerService — NFT 발행 오케스트레이터
 *
 * 발행 파이프라인:
 *   ① 정책 조회   — IssuancePolicyService.getPolicy()          → tokenId·amount·유효기간
 *   ② 조건 판단   — EventConditionService.evaluate()            → eligible 여부
 *   ③ 멱등성 체크  — issuanceRepo.findPending()                 → 중복 요청 방지
 *   ④ REQUESTED   — issuanceRepo.create()
 *   ⑤ 지갑 조회   — coreBanking.getUserAccount()               → walletAddr 획득, 실패 시 FAILED
 *   ⑥ TX 위탁     — txStateMachine.submitMintRequest()          → tx_mint_requests REQUESTED→SUBMITTED
 *                   issuanceRepo SUBMITTED / 실패 시 FAILED
 *
 * 레이어 책임 분리:
 *   issuance_requests (내부 원장) — IssuerService 관리
 *   tx_mint_requests  (온체인 TX) — TxStateMachineService 관리
 *   온체인 이벤트 수신 후 issuance_requests가 tx_mint_requests 상태를 따라간다.
 *
 */
export class IssuerService {
  constructor(private readonly deps: {
    chainAdapter:          IBlockchainAdapter;
    coreBanking:           ICoreBankingAdapter;
    nftIssuerAddr:         string;
    policyService:         IssuancePolicyService;
    conditionService:      EventConditionService;
    issuanceRepo:          IIssuanceRequestRepository;
    txStateMachine:        TxStateMachineService;
    ledgerService:         LedgerService;
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
  }): Promise<{ requestId: string; eligible: boolean; txHash?: string; tokenId?: string; failed?: boolean }> {
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
    // issuance_requests(IssuanceStatus) + mint_requests(MintStatus) 동시 생성
    const req        = await this.deps.issuanceRepo.create({
      userId,
      eventType:  event.eventType,
      tokenId:    policy.tokenId,
      amount:     policy.amount,
      walletAddr: null,
      status:     'REQUESTED',
      txHash:     null,
      failReason: null,
    });
    await this.deps.coreBanking.recordAuditLog({
      actor:        userId,
      action:       'REQUESTED',
      resourceType: 'issuance_request',
      resourceId:   req.id,
      afterState:   { status: 'REQUESTED', eventType: event.eventType, tokenId: String(policy.tokenId) },
    });
    const ledgerReq  = await this.deps.ledgerService.createMintRequest(userId, String(policy.id));

    // ── ⑤ 지갑 조회 — 실패 → FAILED + throw ────────────────────────────
    let walletAddr: string;
    try {
      const account = await this.deps.coreBanking.getUserAccount(userId);
      if (!account) throw new Error(`user not found: ${userId}`);

      walletAddr = account.walletAddr;
      await this.deps.issuanceRepo.setWalletAddr(req.id, walletAddr);
    } catch (err) {
      const failReason = (err as Error).message;
      await this.deps.issuanceRepo.updateStatus(req.id, 'FAILED', { failReason });
      await this.deps.ledgerService.updateMintRequest(ledgerReq.id, { status: 'FAILED', errorMsg: failReason });
      this.deps.coreBanking.recordAuditLog({
        actor:        userId,
        action:       'FAILED',
        resourceType: 'issuance_request',
        resourceId:   req.id,
        beforeState:  { status: 'REQUESTED' },
        afterState:   { status: 'FAILED', failReason },
      }).catch(e => console.error('[IssuerService] audit-log 오류:', e));
      throw err;
    }

    // ── ⑥ TX 위탁 → SUBMITTED ───────────────────────────────────────────
    // TxStateMachineService → tx_mint_requests REQUESTED→SUBMITTED
    // TxTransitionBridge가 'transition' 이벤트를 수신하여 mint_requests도 SUBMITTED로 업데이트
    let txHash: string;
    try {
      const result = await this.deps.txStateMachine.submitMintRequest({
        userId,
        tokenId:    BigInt(policy.tokenId),
        amount:     BigInt(policy.amount),
        walletAddr,
      });
      txHash = result.txHash;
      await this.deps.issuanceRepo.updateStatus(req.id, 'SUBMITTED', { txHash });
      // mint_requests SUBMITTED: TxTransitionBridge의 'transition' 이벤트 핸들러가 담당
      // (txHash가 설정된 후 이벤트가 발행되므로 bridge에서 findByTxHash 가능)
      // 단, SUBMITTED 전이 이벤트 시점에 mint_requests.tx_hash가 아직 없으므로 직접 업데이트
      await this.deps.ledgerService.updateMintRequest(ledgerReq.id, { status: 'SUBMITTED', txHash });
      this.deps.coreBanking.recordAuditLog({
        actor:        userId,
        action:       'SUBMITTED',
        resourceType: 'issuance_request',
        resourceId:   req.id,
        afterState:   { status: 'SUBMITTED', txHash },
      }).catch(e => console.error('[IssuerService] audit-log 오류:', e));
    } catch (err) {
      const failReason = (err as Error).message;
      await this.deps.issuanceRepo.updateStatus(req.id, 'FAILED', { failReason });
      await this.deps.ledgerService.updateMintRequest(ledgerReq.id, { status: 'FAILED', errorMsg: failReason });
      this.deps.coreBanking.recordAuditLog({
        actor:        userId,
        action:       'FAILED',
        resourceType: 'issuance_request',
        resourceId:   req.id,
        beforeState:  { status: 'REQUESTED' },
        afterState:   { status: 'FAILED', failReason },
      }).catch(e => console.error('[IssuerService] audit-log 오류:', e));
      // VASP 실패(REVERT 포함)는 issuance_requests에 FAILED로 기록 후 정상 반환.
      // throw하면 IdempotencyGuard.unmark() → ConsumerGroupWorker가 PEL 재시도 →
      // setMode(NORMAL) 후 TX 성공 → user_nft_holdings 오중복. 복구는 VaspRecoveryService 경로.
      return { requestId: req.id, eligible: true, failed: true };
    }

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

  /**
   * VASP TX 실패 결과 수신 → IssuanceStatus FAILED 전이
   *
   * VASP가 TX를 브로드캐스트했으나 온체인에서 REVERT되거나
   * 타임아웃·네트워크 오류로 최종 실패한 경우 호출된다.
   * SUBMITTED 상태인 요청만 FAILED로 전이한다 (이미 CONFIRMED된 경우 무시).
   */
  async handleVaspTxFailed(params: { txHash: string; reason?: string }): Promise<void> {
    const req = await this.deps.issuanceRepo.findByTxHash(params.txHash);
    if (!req || req.status !== 'SUBMITTED') return;
    const failReason = params.reason ?? 'VASP TX failed on-chain';
    await this.deps.issuanceRepo.updateStatus(req.id, 'FAILED', { failReason });
    this.deps.coreBanking.recordAuditLog({
      actor:        req.userId,
      action:       'FAILED',
      resourceType: 'issuance_request',
      resourceId:   params.txHash,
      beforeState:  { status: 'SUBMITTED', txHash: params.txHash },
      afterState:   { status: 'FAILED', failReason },
    }).catch(e => console.error('[IssuerService] audit-log 오류:', e));
  }
}
