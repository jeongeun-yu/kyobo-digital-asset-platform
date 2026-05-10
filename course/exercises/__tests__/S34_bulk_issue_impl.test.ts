/**
 * S34 채점 — BulkIssueService 구현과 부분 실패 통합 테스트
 *
 * 채점 기준:
 *   · _chunk() 알고리즘 — 마지막 청크가 작아도 오류 없이 처리
 *   · executeBulkIssue — COMPLETED / PARTIAL_FAILURE / FAILED 상태 전이
 *   · retryFailedChunks — 실패 청크만 재처리 → COMPLETED 전환
 *   · getJobStatus — doneChunks 진행률 + progressPct 계산
 */

import { BulkIssueService } from '../M5/S34_bulk_issue_impl';

// ── InMemory BulkJobRepository 재현 ──────────────────────────────────────────

type BulkJobStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL_FAILURE' | 'FAILED';

interface ChunkError {
  chunkIndex:  number;
  requestIds:  string[];
  status:      'success' | 'failed';
  error?:      string;
}

interface BulkJob {
  id:          string;
  tokenId:     bigint;
  totalUsers:  number;
  totalChunks: number;
  doneChunks:  number;
  status:      BulkJobStatus;
  chunkErrors: ChunkError[];
  createdAt:   Date;
  updatedAt:   Date;
}

class InMemoryBulkJobRepository {
  private readonly store = new Map<string, BulkJob>();

  async save(job: BulkJob): Promise<void> {
    this.store.set(job.id, { ...job, chunkErrors: [...job.chunkErrors] });
  }

  async update(id: string, patch: Partial<BulkJob>): Promise<void> {
    const current = this.store.get(id);
    if (current) {
      this.store.set(id, {
        ...current,
        ...patch,
        chunkErrors: patch.chunkErrors ? [...patch.chunkErrors] : current.chunkErrors,
      });
    }
  }

  async findById(id: string): Promise<BulkJob | null> {
    const job = this.store.get(id);
    if (!job) return null;
    return { ...job, chunkErrors: [...job.chunkErrors] };
  }
}

const TOKEN_ID = BigInt(0x01) << BigInt(64);

// ── 채점 테스트 ───────────────────────────────────────────────────────────────

describe('S34 채점 — BulkIssueService 배치 발행 구현', () => {

  describe('[1] _chunk() 알고리즘', () => {
    let helper: BulkIssueService;
    beforeEach(() => {
      const dummyRepo  = new InMemoryBulkJobRepository();
      const dummyMint  = { async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-${userId}`; } };
      helper = new BulkIssueService(dummyRepo as any, dummyMint);
    });

    it('TODO: 1000명 → 2개 청크 (CHUNK_SIZE=500)', () => {
      const arr    = Array.from({ length: 1000 }, (_, i) => `u-${i}`);
      const chunks = helper._chunk(arr, 500);
      expect(chunks.length).toBe(2);
    });

    it('TODO: 첫 번째 청크 500명', () => {
      const arr    = Array.from({ length: 1000 }, (_, i) => `u-${i}`);
      const chunks = helper._chunk(arr, 500);
      expect(chunks[0]!.length).toBe(500);
    });

    it('TODO: 두 번째 청크 500명', () => {
      const arr    = Array.from({ length: 1000 }, (_, i) => `u-${i}`);
      const chunks = helper._chunk(arr, 500);
      expect(chunks[1]!.length).toBe(500);
    });

    it('TODO: 1001명 → 3개 청크', () => {
      const arr    = Array.from({ length: 1001 }, (_, i) => `u-${i}`);
      const chunks = helper._chunk(arr, 500);
      expect(chunks.length).toBe(3);
    });

    it('TODO: 마지막 청크 1명 (오류 없이 처리)', () => {
      const arr    = Array.from({ length: 1001 }, (_, i) => `u-${i}`);
      const chunks = helper._chunk(arr, 500);
      expect(chunks[2]!.length).toBe(1);
    });

    it('TODO: 빈 배열 → 0개 청크', () => {
      const chunks = helper._chunk([], 500);
      expect(chunks.length).toBe(0);
    });
  });

  describe('[2] 전체 성공 → COMPLETED', () => {
    it('TODO: 10명 → status=COMPLETED', async () => {
      const repo      = new InMemoryBulkJobRepository();
      const submitter = { async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-${userId}`; } };
      const svc       = new BulkIssueService(repo as any, submitter);
      const users     = Array.from({ length: 10 }, (_, i) => `user-${i}`);
      const jobId     = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job       = await svc.getJobStatus(jobId);
      expect(job.status).toBe('COMPLETED');
    });

    it('TODO: totalUsers=10', async () => {
      const repo      = new InMemoryBulkJobRepository();
      const submitter = { async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-${userId}`; } };
      const svc       = new BulkIssueService(repo as any, submitter);
      const users     = Array.from({ length: 10 }, (_, i) => `user-${i}`);
      const jobId     = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job       = await svc.getJobStatus(jobId);
      expect(job.totalUsers).toBe(10);
    });

    it('TODO: 10명(1청크) → doneChunks=1', async () => {
      const repo      = new InMemoryBulkJobRepository();
      const submitter = { async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-${userId}`; } };
      const svc       = new BulkIssueService(repo as any, submitter);
      const users     = Array.from({ length: 10 }, (_, i) => `user-${i}`);
      const jobId     = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job       = await svc.getJobStatus(jobId);
      expect(job.doneChunks).toBe(1);
    });

    it('TODO: progress 형식 "1/1"', async () => {
      const repo      = new InMemoryBulkJobRepository();
      const submitter = { async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-${userId}`; } };
      const svc       = new BulkIssueService(repo as any, submitter);
      const users     = Array.from({ length: 10 }, (_, i) => `user-${i}`);
      const jobId     = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job       = await svc.getJobStatus(jobId);
      expect(job.progress).toBe('1/1');
    });

    it('TODO: progressPct=100', async () => {
      const repo      = new InMemoryBulkJobRepository();
      const submitter = { async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-${userId}`; } };
      const svc       = new BulkIssueService(repo as any, submitter);
      const users     = Array.from({ length: 10 }, (_, i) => `user-${i}`);
      const jobId     = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job       = await svc.getJobStatus(jobId);
      expect(job.progressPct).toBe(100);
    });
  });

  describe('[3] 1000건 청크 1 실패 → PARTIAL_FAILURE', () => {
    async function runPartialFailJob() {
      const repo = new InMemoryBulkJobRepository();
      const submitter = {
        async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }): Promise<string> {
          const idx = parseInt(userId.replace('user-', ''));
          if (idx >= 500) throw new Error(`WalletNotFoundError: ${userId}`);
          return `req-${userId}`;
        },
      };
      const svc   = new BulkIssueService(repo as any, submitter);
      const users = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
      const jobId = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job   = await svc.getJobStatus(jobId);
      return { job, jobId, svc, repo, users };
    }

    it('TODO: status=PARTIAL_FAILURE', async () => {
      const { job } = await runPartialFailJob();
      expect(job.status).toBe('PARTIAL_FAILURE');
    });

    it('TODO: totalChunks=2', async () => {
      const { job } = await runPartialFailJob();
      expect(job.totalChunks).toBe(2);
    });

    it('TODO: doneChunks=1 (청크 0만 성공)', async () => {
      const { job } = await runPartialFailJob();
      expect(job.doneChunks).toBe(1);
    });

    it('TODO: progress="1/2"', async () => {
      const { job } = await runPartialFailJob();
      expect(job.progress).toBe('1/2');
    });

    it('TODO: progressPct=50', async () => {
      const { job } = await runPartialFailJob();
      expect(job.progressPct).toBe(50);
    });

    it('TODO: 성공 청크 1개, 실패 청크 1개', async () => {
      const { job } = await runPartialFailJob();
      const successChunks = job.chunkErrors.filter(c => c.status === 'success');
      const failedChunks  = job.chunkErrors.filter(c => c.status === 'failed');
      expect(successChunks.length).toBe(1);
      expect(failedChunks.length).toBe(1);
    });

    it('TODO: 실패 청크 인덱스 = 1 (두 번째 청크)', async () => {
      const { job } = await runPartialFailJob();
      const failedChunk = job.chunkErrors.find(c => c.status === 'failed');
      expect(failedChunk?.chunkIndex).toBe(1);
    });

    it('TODO: 실패 청크 error에 WalletNotFoundError 포함', async () => {
      const { job } = await runPartialFailJob();
      const failedChunk = job.chunkErrors.find(c => c.status === 'failed');
      expect(failedChunk?.error).toContain('WalletNotFoundError');
    });
  });

  describe('[4] 모든 청크 실패 → FAILED', () => {
    it('TODO: 모든 청크 실패 → status=FAILED', async () => {
      const repo      = new InMemoryBulkJobRepository();
      const submitter = {
        async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }): Promise<string> {
          throw new Error(`WalletNotFoundError: ${userId}`);
        },
      };
      const svc   = new BulkIssueService(repo as any, submitter);
      const users = Array.from({ length: 20 }, (_, i) => `user-${i}`);
      const jobId = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job   = await svc.getJobStatus(jobId);
      expect(job.status).toBe('FAILED');
    });

    it('TODO: 전체 실패 → doneChunks=0', async () => {
      const repo      = new InMemoryBulkJobRepository();
      const submitter = {
        async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }): Promise<string> {
          throw new Error(`WalletNotFoundError: ${userId}`);
        },
      };
      const svc   = new BulkIssueService(repo as any, submitter);
      const users = Array.from({ length: 20 }, (_, i) => `user-${i}`);
      const jobId = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job   = await svc.getJobStatus(jobId);
      expect(job.doneChunks).toBe(0);
    });
  });

  describe('[5] retryFailedChunks → COMPLETED 전환', () => {
    it('TODO: 재처리 전 PARTIAL_FAILURE', async () => {
      const repo = new InMemoryBulkJobRepository();
      const failingSubmitter = {
        async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }): Promise<string> {
          const idx = parseInt(userId.replace('user-', ''));
          if (idx >= 500) throw new Error(`WalletNotFoundError: ${userId}`);
          return `req-${userId}`;
        },
      };
      const users   = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
      const svc     = new BulkIssueService(repo as any, failingSubmitter);
      const jobId   = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const before  = await svc.getJobStatus(jobId);
      expect(before.status).toBe('PARTIAL_FAILURE');
    });

    it('TODO: retryFailedChunks 후 status=COMPLETED', async () => {
      const repo = new InMemoryBulkJobRepository();
      const failingSubmitter = {
        async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }): Promise<string> {
          const idx = parseInt(userId.replace('user-', ''));
          if (idx >= 500) throw new Error(`WalletNotFoundError: ${userId}`);
          return `req-${userId}`;
        },
      };
      const users  = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
      const svc    = new BulkIssueService(repo as any, failingSubmitter);
      const jobId  = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });

      // 지갑 등록 완료 시뮬레이션 → 재처리 submitter (모두 성공)
      const retrySubmitter = {
        async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-retry-${userId}`; },
      };
      const retrySvc = new BulkIssueService(repo as any, retrySubmitter);
      await retrySvc.retryFailedChunks(jobId, users);

      const after = await retrySvc.getJobStatus(jobId);
      expect(after.status).toBe('COMPLETED');
    });

    it('TODO: 재처리 후 모든 청크 success', async () => {
      const repo = new InMemoryBulkJobRepository();
      const failingSubmitter = {
        async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }): Promise<string> {
          const idx = parseInt(userId.replace('user-', ''));
          if (idx >= 500) throw new Error(`WalletNotFoundError: ${userId}`);
          return `req-${userId}`;
        },
      };
      const users  = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
      const svc    = new BulkIssueService(repo as any, failingSubmitter);
      const jobId  = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });

      const retrySubmitter = {
        async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-retry-${userId}`; },
      };
      const retrySvc = new BulkIssueService(repo as any, retrySubmitter);
      await retrySvc.retryFailedChunks(jobId, users);

      const after = await retrySvc.getJobStatus(jobId);
      expect(after.chunkErrors.every(c => c.status === 'success')).toBe(true);
    });
  });

  describe('[6] getJobStatus progressPct 계산', () => {
    it('TODO: 2청크 완료 → progressPct=100', async () => {
      const repo      = new InMemoryBulkJobRepository();
      const submitter = { async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-${userId}`; } };
      const svc       = new BulkIssueService(repo as any, submitter);
      const users     = Array.from({ length: 600 }, (_, i) => `user-${i}`);
      const jobId     = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job       = await svc.getJobStatus(jobId);
      expect(job.progressPct).toBe(100);
    });

    it('TODO: 600명 → doneChunks=2', async () => {
      const repo      = new InMemoryBulkJobRepository();
      const submitter = { async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-${userId}`; } };
      const svc       = new BulkIssueService(repo as any, submitter);
      const users     = Array.from({ length: 600 }, (_, i) => `user-${i}`);
      const jobId     = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job       = await svc.getJobStatus(jobId);
      expect(job.doneChunks).toBe(2);
    });
  });

  describe('[7] 1001명 비균등 분할 — 마지막 청크 1명', () => {
    it('TODO: 1001명 → 3청크 (totalChunks=3)', async () => {
      const repo      = new InMemoryBulkJobRepository();
      const submitter = { async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-${userId}`; } };
      const svc       = new BulkIssueService(repo as any, submitter);
      const users     = Array.from({ length: 1001 }, (_, i) => `user-${i}`);
      const jobId     = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job       = await svc.getJobStatus(jobId);
      expect(job.totalChunks).toBe(3);
    });

    it('TODO: 1001명 비균등 분할 → 전체 성공 COMPLETED', async () => {
      const repo      = new InMemoryBulkJobRepository();
      const submitter = { async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-${userId}`; } };
      const svc       = new BulkIssueService(repo as any, submitter);
      const users     = Array.from({ length: 1001 }, (_, i) => `user-${i}`);
      const jobId     = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job       = await svc.getJobStatus(jobId);
      expect(job.status).toBe('COMPLETED');
    });

    it('TODO: 1001명 → doneChunks=3', async () => {
      const repo      = new InMemoryBulkJobRepository();
      const submitter = { async submitMintRequest({ userId }: { userId: string; tokenId: bigint; amount: bigint }) { return `req-${userId}`; } };
      const svc       = new BulkIssueService(repo as any, submitter);
      const users     = Array.from({ length: 1001 }, (_, i) => `user-${i}`);
      const jobId     = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
      const job       = await svc.getJobStatus(jobId);
      expect(job.doneChunks).toBe(3);
    });
  });
});
