/**
 * ICoreBankingAdapter ??援먮낫?앸챸 Core Banking ?쒖뒪???곕룞 ?명꽣?섏씠??
 *
 * Phase 1 (?뺤젙): NFT 諛쒗뻾 ???ъ씤??荑좏룿 ?곹깭 ?낅뜲?댄듃 ?뚮┝
 * ?ν썑 ?뺤옣: ?ㅽ뀒?대툝肄붿씤쨌利앷텒 怨꾩쥖 ?곕룞 ??(援먮낫?앸챸 ?대? 寃곗젙)
 *
 * Core Banking API ?ㅽ럺? 援먮낫DTS ?대? ?쒖뒪?쒖뿉 ?곕씪 寃곗젙.
 * ???명꽣?섏씠?ㅺ? ?뺤젙?섎㈃ ?묒륫???낅┰?곸쑝濡?援ы쁽 媛??
 */

export interface UserAccount {
  userId:     string;
  accountId:  string;
  walletAddr: string;
  status:     'active' | 'suspended' | 'closed';
}

export interface RewardNotification {
  userId:      string;
  rewardType:  string;
  tokenId:     string;
  txHash:      string;
  issuedAt:    number;
  metadata?:   Record<string, unknown>;
}

export interface BalanceSyncRequest {
  accountId:  string;
  tokenAddr:  string;
  amount:     bigint;
  direction:  'mint' | 'burn';
  txHash:     string;
}

export interface ICoreBankingAdapter {
  /**
   * ?ъ슜??怨꾩젙 議고쉶 ??KYC ?곹깭쨌吏媛?二쇱냼 留ㅽ븨 ?뺤씤
   */
  getUserAccount(userId: string): Promise<UserAccount | null>;

  /**
   * NFT 諛쒗뻾 ?꾨즺 ?뚮┝ ???ъ씤?맞룹퓼???쒖뒪???곹깭 ?낅뜲?댄듃
   */
  notifyReward(notification: RewardNotification): Promise<void>;

  /**
   * Phase 2: ?먰솕 ?낃툑 ???ㅽ뀒?대툝肄붿씤 諛쒗뻾 ?붿껌
   */
  syncBalance(req: BalanceSyncRequest): Promise<{ confirmed: boolean }>;

  /**
   * 嫄곕옒 ?대젰 湲곕줉 ??媛먯궗 異붿쟻 (ISMS-P ?붽굔)
   */
  recordTransaction(tx: {
    txHash:   string;
    userId:   string;
    type:     string;
    amount:   string;
    status:   string;
    timestamp: number;
  }): Promise<void>;

  // ?? ?대?留??곴뎄 ?먯옣 ?꾩엫 (Java internal-ledger媛 ?ㅼ젣 湲곕줉) ????????????

  /**
   * ?⑥껜??NFT Transfer ?대깽???뺤씤 ???몄텧 ??Java gateway媛 user_nft_holdings ?뚯씠釉붿뿉 湲곕줉
   */
  recordNftHolding(params: {
    userId: string;
    tokenId: bigint;
    contractAddr: string;
    chainId: number;
    acquiredAt: Date;
    onChainTx: string;
  }): Promise<void>;

  /**
   * issuer-service ?곹깭 蹂寃쎈쭏???몄텧 ??Java gateway媛 audit_log ?뚯씠釉붿뿉 append-only 湲곕줉
   */
  recordAuditLog(entry: {
    actor: string;
    action: string;
    resourceType: string;
    resourceId: string;
    beforeState?: unknown;
    afterState: unknown;
  }): Promise<void>;
}
