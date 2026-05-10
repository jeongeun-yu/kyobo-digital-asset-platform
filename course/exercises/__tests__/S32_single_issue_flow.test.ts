/**
 * S32 채점 — 이벤트에서 NFT 요청까지 · 단건 발행 흐름 설계
 *
 * 채점 기준:
 *   · AML flagged=true → Error, 컨트랙트 미호출
 *   · 멱등성 이중 보장 — 같은 activityId 재요청 → Error
 *   · 발행 6단계 파이프라인 순서 검증
 *   · CoreBanking 알림 실패 → TX 롤백 없음 (fire-and-forget)
 *   · account.status !== 'active' → 발행 차단
 */

import { IssuerService } from '../M5/S32_single_issue_flow';

// ── 타입 정의 ─────────────────────────────────────────────────────────────────

interface OracleData {
  dataType:  string;
  value:     number;
  timestamp: number;
  signature: string;
}

// ── InMemory 멱등성 가드 ──────────────────────────────────────────────────────

class InMemoryIdempotencyGuard {
  private processed = new Set<string>();
  async check(key: string) { return { processed: this.processed.has(key) }; }
  async record(key: string) { this.processed.add(key); }
}

// ── Mock 빌더 ─────────────────────────────────────────────────────────────────

function buildMocks(overrides: {
  txStatus?:      'success' | 'failed';
  amlFlagged?:    boolean;
  amlReason?:     string;
  accountStatus?: 'active' | 'suspended' | 'closed';
  notifyFail?:    boolean;
  noAccount?:     boolean;
} = {}) {
  const txCalls:     unknown[][] = [];
  const notifyCalls: unknown[]   = [];
  let   notifyFailed = false;

  const chainAdapter = {
    async sendTransaction(params: { contractAddr: string; method: string; args: unknown[] }) {
      txCalls.push(params.args);
      return {
        status:    overrides.txStatus ?? 'success' as const,
        txHash:    '0xabc123def456',
        timestamp: Date.now(),
      };
    },
  };

  const vaspAdapter = {
    async screenAddress(_walletAddr: string) {
      return { flagged: overrides.amlFlagged ?? false, reason: overrides.amlReason };
    },
  };

  const coreBanking = {
    async getUserAccount(userId: string) {
      if (overrides.noAccount) return null;
      return { userId, walletAddr: '0xWallet001', status: overrides.accountStatus ?? 'active' as const };
    },
    async notifyReward(params: unknown) {
      notifyCalls.push(params);
      if (overrides.notifyFail) {
        notifyFailed = true;
        throw new Error('CoreBanking connection timeout');
      }
    },
  };

  return {
    chainAdapter, vaspAdapter, coreBanking,
    txCalls, notifyCalls,
    isNotifyFailed: () => notifyFailed,
  };
}

const BASE_ORACLE: OracleData = {
  dataType:  'WALK',
  value:     15_000,
  timestamp: Date.now(),
  signature: '0xOracleSig',
};

// ── 채점 테스트 ───────────────────────────────────────────────────────────────

describe('S32 채점 — 단건 발행 파이프라인', () => {

  describe('[1] 정상 발행 E2E', () => {
    it('TODO: 정상 발행 → txHash 반환됨', async () => {
      const mocks = buildMocks();
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract001' });
      const result = await svc.issueActivityNFT({ userId: 'K-20240001', activityId: 'act-001', oracleData: BASE_ORACLE });
      expect(result.txHash).toBeTruthy();
    });

    it('TODO: 정상 발행 → 컨트랙트 1회 호출됨', async () => {
      const mocks = buildMocks();
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract001' });
      await svc.issueActivityNFT({ userId: 'K-20240001', activityId: 'act-001', oracleData: BASE_ORACLE });
      expect(mocks.txCalls.length).toBe(1);
    });

    it('TODO: 정상 발행 → CoreBanking.notifyReward() 호출됨 (fire-and-forget)', async () => {
      const mocks = buildMocks();
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract001' });
      await svc.issueActivityNFT({ userId: 'K-20240001', activityId: 'act-001', oracleData: BASE_ORACLE });
      await new Promise(r => setTimeout(r, 10));
      expect(mocks.notifyCalls.length).toBe(1);
    });
  });

  describe('[2] 멱등성 — 동일 activityId 재요청 차단', () => {
    it('TODO: 중복 activityId → Error 발생', async () => {
      const mocks = buildMocks();
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      await svc.issueActivityNFT({ userId: 'K-20240001', activityId: 'act-walk-001', oracleData: BASE_ORACLE });
      await expect(
        svc.issueActivityNFT({ userId: 'K-20240001', activityId: 'act-walk-001', oracleData: BASE_ORACLE })
      ).rejects.toThrow();
    });

    it('TODO: 에러 메시지에 "already processed" 포함', async () => {
      const mocks = buildMocks();
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      await svc.issueActivityNFT({ userId: 'K-20240001', activityId: 'act-dup-001', oracleData: BASE_ORACLE });
      await expect(
        svc.issueActivityNFT({ userId: 'K-20240001', activityId: 'act-dup-001', oracleData: BASE_ORACLE })
      ).rejects.toThrow('already processed');
    });

    it('TODO: 중복 요청 시 컨트랙트 추가 호출 없음 (총 1회 유지)', async () => {
      const mocks = buildMocks();
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      await svc.issueActivityNFT({ userId: 'K-20240001', activityId: 'act-idem-001', oracleData: BASE_ORACLE });
      try {
        await svc.issueActivityNFT({ userId: 'K-20240001', activityId: 'act-idem-001', oracleData: BASE_ORACLE });
      } catch {}
      expect(mocks.txCalls.length).toBe(1);
    });
  });

  describe('[3] AML flagged=true → Error, 컨트랙트 미호출', () => {
    it('TODO: AML flagged → Error 발생', async () => {
      const mocks = buildMocks({ amlFlagged: true, amlReason: 'OFAC sanction list' });
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      await expect(
        svc.issueActivityNFT({ userId: 'K-AML', activityId: 'act-aml-001', oracleData: BASE_ORACLE })
      ).rejects.toThrow();
    });

    it('TODO: AML 에러 메시지에 "AML" 포함', async () => {
      const mocks = buildMocks({ amlFlagged: true, amlReason: 'OFAC sanction list' });
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      await expect(
        svc.issueActivityNFT({ userId: 'K-AML', activityId: 'act-aml-001', oracleData: BASE_ORACLE })
      ).rejects.toThrow('AML');
    });

    it('TODO: AML 차단 시 컨트랙트 미호출', async () => {
      const mocks = buildMocks({ amlFlagged: true });
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      try {
        await svc.issueActivityNFT({ userId: 'K-AML', activityId: 'act-aml-001', oracleData: BASE_ORACLE });
      } catch {}
      expect(mocks.txCalls.length).toBe(0);
    });
  });

  describe('[4] account.status !== active → 발행 차단', () => {
    it('TODO: suspended 계정 → Error 발생', async () => {
      const mocks = buildMocks({ accountStatus: 'suspended' });
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      await expect(
        svc.issueActivityNFT({ userId: 'K-SUSP', activityId: 'act-susp-001', oracleData: BASE_ORACLE })
      ).rejects.toThrow();
    });

    it('TODO: 에러 메시지에 "not active" 포함', async () => {
      const mocks = buildMocks({ accountStatus: 'suspended' });
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      await expect(
        svc.issueActivityNFT({ userId: 'K-SUSP', activityId: 'act-susp-001', oracleData: BASE_ORACLE })
      ).rejects.toThrow('not active');
    });

    it('TODO: suspended 계정 → 컨트랙트 미호출', async () => {
      const mocks = buildMocks({ accountStatus: 'suspended' });
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      try {
        await svc.issueActivityNFT({ userId: 'K-SUSP', activityId: 'act-susp-001', oracleData: BASE_ORACLE });
      } catch {}
      expect(mocks.txCalls.length).toBe(0);
    });

    it('TODO: closed 계정 → Error 발생', async () => {
      const mocks = buildMocks({ accountStatus: 'closed' });
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      await expect(
        svc.issueActivityNFT({ userId: 'K-CLOSED', activityId: 'act-closed-001', oracleData: BASE_ORACLE })
      ).rejects.toThrow();
    });
  });

  describe('[5] 계정 없음 → Error', () => {
    it('TODO: 계정 없음 → Error 발생', async () => {
      const mocks = buildMocks({ noAccount: true });
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      await expect(
        svc.issueActivityNFT({ userId: 'K-GHOST', activityId: 'act-ghost-001', oracleData: BASE_ORACLE })
      ).rejects.toThrow();
    });

    it('TODO: 에러 메시지에 "user not found" 포함', async () => {
      const mocks = buildMocks({ noAccount: true });
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      await expect(
        svc.issueActivityNFT({ userId: 'K-GHOST', activityId: 'act-ghost-001', oracleData: BASE_ORACLE })
      ).rejects.toThrow('user not found');
    });
  });

  describe('[6] CoreBanking 알림 실패 → TX 롤백 없음 (fire-and-forget)', () => {
    it('TODO: CoreBanking 실패해도 issueActivityNFT()는 성공 반환', async () => {
      const mocks = buildMocks({ notifyFail: true });
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      await expect(
        svc.issueActivityNFT({ userId: 'K-NOTIFY-FAIL', activityId: 'act-notify-001', oracleData: BASE_ORACLE })
      ).resolves.toBeDefined();
    });

    it('TODO: CoreBanking 실패해도 txHash 정상 반환됨', async () => {
      const mocks = buildMocks({ notifyFail: true });
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      const result = await svc.issueActivityNFT({ userId: 'K-NOTIFY-FAIL', activityId: 'act-notify-001', oracleData: BASE_ORACLE });
      expect(result.txHash).toBeTruthy();
    });

    it('TODO: CoreBanking 실패해도 컨트랙트는 1회 실행됨', async () => {
      const mocks = buildMocks({ notifyFail: true });
      const svc   = new IssuerService({ ...mocks, idempotency: new InMemoryIdempotencyGuard() as any, nftIssuerAddr: '0xNFTContract' });
      await svc.issueActivityNFT({ userId: 'K-NOTIFY-FAIL', activityId: 'act-notify-001', oracleData: BASE_ORACLE });
      expect(mocks.txCalls.length).toBe(1);
    });
  });
});
