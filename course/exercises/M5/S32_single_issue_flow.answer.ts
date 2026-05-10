/**
 * S32 실습 — 이벤트에서 NFT 요청까지 · 단건 발행 흐름 설계
 *
 * 강의 노트: M5_S32_single_issue_flow.md
 *
 * 실행 방법 (루트에서): npm run exercise:s32
 *
 * 목표:
 *   [1] IssuerService.issueActivityNFT() — 6단계 파이프라인 구현
 *   [2] AML flagged=true → Error, 컨트랙트 미호출
 *   [3] CoreBanking 알림 실패 → 발행 TX 롤백 없음 (fire-and-forget)
 *   [4] 멱등성 이중 보장 — 서비스 레이어 idempotency guard
 *   [5] account.status !== 'active' → 발행 차단
 */

// ────────────────────────────────────────────────────────────────────────
// 인터페이스 정의
// ────────────────────────────────────────────────────────────────────────

interface UserAccount {
  userId:     string;
  walletAddr: string;
  status:     'active' | 'suspended' | 'closed';
}

interface OracleData {
  dataType:  string;
  value:     number;
  timestamp: number;
  signature: string;
}

interface TxReceipt {
  status:    'success' | 'failed';
  txHash:    string;
  timestamp: number;
}

interface AmlResult {
  flagged: boolean;
  reason?: string;
}

/** 블록체인 어댑터 — 체인 무관 인터페이스 (EVM / XRPL 교체 가능) */
interface IBlockchainAdapter {
  sendTransaction(params: {
    contractAddr: string;
    method:       string;
    args:         unknown[];
  }): Promise<TxReceipt>;
}

/** VASP 어댑터 — AML 스크리닝 */
interface IVaspAdapter {
  screenAddress(walletAddr: string): Promise<AmlResult>;
}

/** Core Banking 어댑터 */
interface ICoreBankingAdapter {
  getUserAccount(userId: string): Promise<UserAccount | null>;
  notifyReward(params: {
    userId:     string;
    rewardType: string;
    tokenId:    string;
    txHash:     string;
    issuedAt:   number;
  }): Promise<void>;
}

/** 멱등성 가드 — activityId 중복 발행 차단 */
interface IdempotencyGuard {
  check(key: string): Promise<{ processed: boolean }>;
  record(key: string): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────
// WalletNotFoundError (S28에서 이어짐)
// ────────────────────────────────────────────────────────────────────────

class WalletNotFoundError extends Error {
  constructor(userId: string) {
    super(`Wallet not found for user: ${userId}`);
    this.name = 'WalletNotFoundError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// IssuerService — 단건 발행 파이프라인
//
// 발행 단계 (각 단계 실패 시 다음 단계 진행 안 함):
//   1. 계정 조회 + status 검증
//   2. 멱등성 체크 (activityId 중복 차단)
//   3. AML 스크리닝 (블랙리스트 지갑 차단)
//   4. 컨트랙트 호출 (NFT 발행)
//   5. 멱등성 기록 (발행 완료 후 key 등록)
//   6. CoreBanking 알림 (fire-and-forget — 발행 성공 후 비동기)
//
// Phase 1: vaspAdapter.submitTransaction() → 월렛원 REST API
// Phase 3: chainAdapter.sendTransaction() 직접 호출 (자체 Custody 인가 취득 후)
// ────────────────────────────────────────────────────────────────────────

export class IssuerService {
  constructor(private readonly deps: {
    chainAdapter:  IBlockchainAdapter;
    vaspAdapter:   IVaspAdapter;
    coreBanking:   ICoreBankingAdapter;
    idempotency:   IdempotencyGuard;
    nftIssuerAddr: string;
  }) {}

  async issueActivityNFT(params: {
    userId:     string;
    activityId: string;
    oracleData: OracleData;
  }): Promise<{ txHash: string }> {
    const { userId, activityId, oracleData } = params;

    // 1. Core Banking에서 계정 + 지갑 주소 조회
    const account = await this.deps.coreBanking.getUserAccount(userId);
    if (!account) throw new Error(`user not found: ${userId}`);
    if (account.status !== 'active') throw new Error(`account not active: ${userId} (status: ${account.status})`);

    // 2. 멱등성 체크 — 레이어 1 (서비스 레이어 DB에서 빠르게 차단)
    //    레이어 2는 컨트랙트 내 processedActivities 매핑 (M6 구현)
    const { processed } = await this.deps.idempotency.check(activityId);
    if (processed) {
      throw new Error(`already processed: ${activityId}`);
    }

    // 3. AML 스크리닝 — 블랙리스트 지갑 주소 차단
    const aml = await this.deps.vaspAdapter.screenAddress(account.walletAddr);
    if (aml.flagged) throw new Error(`AML flagged: ${aml.reason ?? 'blacklisted address'}`);

    // 4. 컨트랙트 호출
    // Phase 1: 내부적으로 vaspAdapter.submitTransaction() → 월렛원 REST API
    // Phase 3 이후: chainAdapter.sendTransaction() 직접 호출
    const receipt = await this.deps.chainAdapter.sendTransaction({
      contractAddr: this.deps.nftIssuerAddr,
      method:       'issueActivityNFT',
      args: [
        account.walletAddr,
        `0x${Buffer.from(activityId).toString('hex').padEnd(64, '0').slice(0, 64)}`,  // bytes32
        oracleData,
      ],
    });

    if (receipt.status === 'failed') {
      throw new Error(`tx failed: ${receipt.txHash}`);
    }

    // 5. 멱등성 기록 — 발행 완료 후 activityId 등록 (다음 중복 요청 차단)
    await this.deps.idempotency.record(activityId);

    // 6. Core Banking 알림 — fire-and-forget
    // 발행은 이미 완료됨 → 알림 실패가 발행을 롤백하면 안 됨
    // 알림 실패는 별도 DLQ/재처리 경로에서 처리
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

// ────────────────────────────────────────────────────────────────────────
// InMemory 멱등성 가드
// ────────────────────────────────────────────────────────────────────────

class InMemoryIdempotencyGuard implements IdempotencyGuard {
  private processed = new Set<string>();

  async check(key: string): Promise<{ processed: boolean }> {
    return { processed: this.processed.has(key) };
  }

  async record(key: string): Promise<void> {
    this.processed.add(key);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Mock 빌더
// ────────────────────────────────────────────────────────────────────────

function buildMocks(overrides: {
  txStatus?:       'success' | 'failed';
  amlFlagged?:     boolean;
  amlReason?:      string;
  accountStatus?:  'active' | 'suspended' | 'closed';
  notifyFail?:     boolean;
  noAccount?:      boolean;
} = {}) {
  const txCalls:      unknown[][] = [];
  const notifyCalls:  unknown[]   = [];
  let notifyFailed    = false;

  const chainAdapter: IBlockchainAdapter = {
    async sendTransaction(params) {
      txCalls.push(params.args);
      return {
        status:    overrides.txStatus ?? 'success',
        txHash:    '0xabc123def456',
        timestamp: Date.now(),
      };
    },
  };

  const vaspAdapter: IVaspAdapter = {
    async screenAddress() {
      return {
        flagged: overrides.amlFlagged ?? false,
        reason:  overrides.amlReason,
      };
    },
  };

  const coreBanking: ICoreBankingAdapter = {
    async getUserAccount(userId) {
      if (overrides.noAccount) return null;
      return {
        userId,
        walletAddr: '0xWallet001',
        status:     overrides.accountStatus ?? 'active',
      };
    },
    async notifyReward(params) {
      notifyCalls.push(params);
      if (overrides.notifyFail) {
        notifyFailed = true;
        throw new Error('CoreBanking connection timeout');
      }
    },
  };

  return { chainAdapter, vaspAdapter, coreBanking, txCalls, notifyCalls, isNotifyFailed: () => notifyFailed };
}

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

const BASE_ORACLE: OracleData = {
  dataType:  'WALK',
  value:     15_000,
  timestamp: Date.now(),
  signature: '0xOracleSig',
};

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S32: 단건 발행 파이프라인 — 이벤트 → NFT 요청 ===\n');

  // ── [1] 정상 발행 E2E ─────────────────────────────────────────────────
  console.log('[검증 1] 정상 발행 E2E — 이벤트 → AML → 컨트랙트 → CoreBanking');
  const mocks1     = buildMocks();
  const idempotency1 = new InMemoryIdempotencyGuard();
  const svc1       = new IssuerService({
    ...mocks1,
    idempotency: idempotency1,
    nftIssuerAddr: '0xNFTContract001',
  });

  const result1 = await svc1.issueActivityNFT({
    userId:     'K-20240001',
    activityId: 'act-walk-20240315-001',
    oracleData: BASE_ORACLE,
  });

  check('txHash 반환됨',                          result1.txHash === '0xabc123def456');
  check('컨트랙트 1회 호출됨',                     mocks1.txCalls.length === 1);

  // 비동기 notifyReward 완료 대기
  await new Promise(r => setTimeout(r, 10));
  check('CoreBanking.notifyReward() 호출됨',       mocks1.notifyCalls.length === 1);

  // ── [2] 멱등성 — 같은 activityId 두 번 → 두 번째 차단 ────────────────
  console.log('\n[검증 2] 멱등성 — 동일 activityId 재요청 차단');
  let dupErr: Error | undefined;
  try {
    await svc1.issueActivityNFT({
      userId:     'K-20240001',
      activityId: 'act-walk-20240315-001',  // 이미 처리된 activityId
      oracleData: BASE_ORACLE,
    });
  } catch (e) {
    dupErr = e as Error;
  }
  check('중복 activityId → 에러 발생',             dupErr !== undefined);
  check('에러 메시지에 "already processed" 포함', dupErr?.message.includes('already processed') === true);
  check('컨트랙트 추가 호출 없음 (총 1회 유지)',   mocks1.txCalls.length === 1);

  // ── [3] AML flagged → 에러, 컨트랙트 미호출 ──────────────────────────
  console.log('\n[검증 3] AML flagged=true → Error, 컨트랙트 호출 안 됨');
  const mocks3 = buildMocks({ amlFlagged: true, amlReason: 'OFAC sanction list' });
  const svc3   = new IssuerService({ ...mocks3, idempotency: new InMemoryIdempotencyGuard(), nftIssuerAddr: '0xNFTContract' });

  let amlErr: Error | undefined;
  try {
    await svc3.issueActivityNFT({ userId: 'K-AML', activityId: 'act-aml-001', oracleData: BASE_ORACLE });
  } catch (e) { amlErr = e as Error; }

  check('AML flagged → Error 발생',                amlErr !== undefined);
  check('에러 메시지에 "AML" 포함',                amlErr?.message.includes('AML') === true);
  check('컨트랙트 미호출 (AML 차단)',              mocks3.txCalls.length === 0);

  // ── [4] account.status !== 'active' → 발행 차단 ────────────────────────
  console.log('\n[검증 4] account.status=suspended → 발행 차단');
  const mocks4 = buildMocks({ accountStatus: 'suspended' });
  const svc4   = new IssuerService({ ...mocks4, idempotency: new InMemoryIdempotencyGuard(), nftIssuerAddr: '0xNFTContract' });

  let suspendedErr: Error | undefined;
  try {
    await svc4.issueActivityNFT({ userId: 'K-SUSP', activityId: 'act-susp-001', oracleData: BASE_ORACLE });
  } catch (e) { suspendedErr = e as Error; }

  check('suspended 계정 → Error 발생',             suspendedErr !== undefined);
  check('에러 메시지에 "not active" 포함',         suspendedErr?.message.includes('not active') === true);
  check('컨트랙트 미호출',                          mocks4.txCalls.length === 0);

  // ── [5] 계정 없음 → Error ────────────────────────────────────────────
  console.log('\n[검증 5] 계정 없음 → Error (WalletNotFoundError가 아님)');
  const mocks5 = buildMocks({ noAccount: true });
  const svc5   = new IssuerService({ ...mocks5, idempotency: new InMemoryIdempotencyGuard(), nftIssuerAddr: '0xNFTContract' });

  let noAccErr: Error | undefined;
  try {
    await svc5.issueActivityNFT({ userId: 'K-GHOST', activityId: 'act-ghost-001', oracleData: BASE_ORACLE });
  } catch (e) { noAccErr = e as Error; }
  check('계정 없음 → Error 발생',                   noAccErr !== undefined);
  check('에러 메시지에 "user not found" 포함',      noAccErr?.message.includes('user not found') === true);

  // ── [6] TX 실패 → Error ──────────────────────────────────────────────
  console.log('\n[검증 6] TX status=failed → Error');
  const mocks6 = buildMocks({ txStatus: 'failed' });
  const svc6   = new IssuerService({ ...mocks6, idempotency: new InMemoryIdempotencyGuard(), nftIssuerAddr: '0xNFTContract' });

  let txErr: Error | undefined;
  try {
    await svc6.issueActivityNFT({ userId: 'K-TX-FAIL', activityId: 'act-tx-fail-001', oracleData: BASE_ORACLE });
  } catch (e) { txErr = e as Error; }
  check('TX failed → Error 발생',                   txErr !== undefined);
  check('에러 메시지에 "tx failed" 포함',           txErr?.message.includes('tx failed') === true);

  // ── [7] CoreBanking 알림 실패 → TX 롤백 없음 (fire-and-forget) ─────────
  console.log('\n[검증 7] CoreBanking 알림 실패 → 발행 TX 롤백 없음 (fire-and-forget)');
  const mocks7 = buildMocks({ notifyFail: true });
  const svc7   = new IssuerService({ ...mocks7, idempotency: new InMemoryIdempotencyGuard(), nftIssuerAddr: '0xNFTContract' });

  let notifyErr: Error | undefined;
  let txHash7: string | undefined;
  try {
    const r = await svc7.issueActivityNFT({ userId: 'K-NOTIFY-FAIL', activityId: 'act-notify-001', oracleData: BASE_ORACLE });
    txHash7 = r.txHash;
  } catch (e) { notifyErr = e as Error; }

  // 비동기 catch가 처리될 시간 허용
  await new Promise(r => setTimeout(r, 20));

  check('CoreBanking 실패해도 issueActivityNFT()는 성공 반환',  notifyErr === undefined);
  check('txHash 정상 반환됨',                                   txHash7 !== undefined);
  check('발행 TX는 실제로 실행됨 (컨트랙트 1회 호출)',          mocks7.txCalls.length === 1);
  check('CoreBanking notify()가 호출됨 (fire-and-forget)',      mocks7.isNotifyFailed() === true);

  // ── 파이프라인 구조 출력 ──────────────────────────────────────────────
  console.log('\n=== S32 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. 파이프라인 각 단계 실패 → 다음 단계 차단 (보수적 설계)');
  console.log('  2. 멱등성 이중 보장: 서비스(DB 체크) + 컨트랙트(processedActivities)');
  console.log('  3. AML 차단: screenAddress() flagged=true → 컨트랙트 호출 전 즉시 중단');
  console.log('  4. CoreBanking fire-and-forget: 발행 완료 후 → 알림 실패가 발행 롤백하면 안 됨');
  console.log('  5. account.status 검증: suspended/closed 계정 차단 — 계정 조회 후 즉시 확인');
  console.log('  6. Phase 1: vaspAdapter → 월렛원 REST API / Phase 3: chainAdapter 직접 호출');
})();
