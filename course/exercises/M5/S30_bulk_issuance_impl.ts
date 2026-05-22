/**
 * S30 실습 — BulkIssueService · ERC-1155 배치 발행 구현
 *
 * 실행:
 *   npm run exercise:s30            → 전체 실행
 *   npm run exercise:s30:1          → [1] _chunk() 알고리즘
 *   npm run exercise:s30:2          → [2] 전체 성공 → COMPLETED
 *   npm run exercise:s30:3          → [3] 부분 실패 → PARTIAL_FAILURE
 *   npm run exercise:s30:4          → [4] 전체 실패 → FAILED
 *   npm run exercise:s30:5          → [5] retryFailedChunks → COMPLETED 전환
 *   npm run exercise:s30:6          → [6] Promise.all — 1건 실패 → 청크 전체 실패
 *   npm run exercise:s30:7          → [7] getJobStatus progressPct
 */

import { randomUUID } from 'crypto';

// ── 타입 정의 ─────────────────────────────────────────────────────────────────

type BulkJobStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL_FAILURE' | 'FAILED';

interface ChunkResult {
  chunkIndex:  number;
  requestIds:  string[];
  status:      'success' | 'failed';
  error?:      string;
}

interface BulkJob {
  id:           string;
  tokenId:      bigint;
  totalUsers:   number;
  totalChunks:  number;
  doneChunks:   number;
  status:       BulkJobStatus;
  chunkResults: ChunkResult[];
  createdAt:    Date;
  updatedAt:    Date;
}

// ── MintSubmitter 인터페이스 — DIP 핵심 ──────────────────────────────────────
//
// BulkIssueService는 이 인터페이스만 의존한다.
// Phase 1: VaspApiSubmitter (월렛원 REST API)
// Phase 3: OnchainSubmitter (직접 컨트랙트 호출)
// → 교체 시 BulkIssueService 코드 변경 없음

interface MintSubmitter {
  submitMintRequest(params: {
    userId:  string;
    tokenId: bigint;
    amount:  bigint;
  }): Promise<string>;  // requestId 반환
}

// ── InMemoryBulkJobRepository ─────────────────────────────────────────────────
//
// 운영에서는 PostgreSQL (bulk_jobs 테이블).
// 실습에서는 청크 알고리즘·상태 전이 로직에 집중하기 위해 in-memory 사용.

class InMemoryBulkJobRepository {
  private readonly store = new Map<string, BulkJob>();

  async save(job: BulkJob): Promise<void> {
    this.store.set(job.id, { ...job, chunkResults: [...job.chunkResults] });
    console.log(`  [REPO] save  id=${job.id}  status=${job.status}  totalChunks=${job.totalChunks}`);
  }

  async update(id: string, patch: Partial<BulkJob>): Promise<void> {
    const current = this.store.get(id);
    if (!current) return;
    this.store.set(id, {
      ...current,
      ...patch,
      chunkResults: patch.chunkResults ? [...patch.chunkResults] : current.chunkResults,
      updatedAt: new Date(),
    });
  }

  async findById(id: string): Promise<BulkJob | null> {
    const job = this.store.get(id);
    return job ? { ...job, chunkResults: [...job.chunkResults] } : null;
  }
}

// ── BulkIssueService ──────────────────────────────────────────────────────────
//
// CHUNK_SIZE = 500 (Block Gas Limit 기준 — 강의 참조)
// 청크 간 순차 처리: 한 청크 실패해도 다음 청크 계속 → PARTIAL_FAILURE
// 청크 내 병렬 처리: Promise.all → 1건 실패 시 청크 전체 실패

export class BulkIssueService {
  static readonly CHUNK_SIZE = 500;

  constructor(
    private readonly jobRepo:   InMemoryBulkJobRepository,
    private readonly submitter: MintSubmitter,
  ) {}

  // 배열을 size 단위로 분할
  // slice(i, i+size)는 배열 끝을 초과해도 있는 만큼만 반환 → 마지막 청크 자동 처리
  _chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }

  // 배치 발행 실행 — jobId 즉시 반환 후 청크 순차 처리
  async executeBulkIssue(params: {
    userIds: string[];
    tokenId: bigint;
    amount?: bigint;
  }): Promise<string> {
    const { userIds, tokenId, amount = 1n } = params;
    const chunks  = this._chunk(userIds, BulkIssueService.CHUNK_SIZE);
    const jobId   = randomUUID();
    const job: BulkJob = {
      id:           jobId,
      tokenId,
      totalUsers:   userIds.length,
      totalChunks:  chunks.length,
      doneChunks:   0,
      status:       'RUNNING',
      chunkResults: [],
      createdAt:    new Date(),
      updatedAt:    new Date(),
    };
    await this.jobRepo.save(job);

    // 청크 간 순차 — 한 청크 실패해도 다음 청크 계속 처리
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      console.log(`  [CHUNK] ${i}/${chunks.length - 1}  size=${chunk.length}`);
      try {
        // 청크 내 병렬 — Promise.all (1건 실패 → 청크 전체 실패)
        const requestIds = await Promise.all(
          chunk.map(userId => this.submitter.submitMintRequest({ userId, tokenId, amount })),
        );
        job.doneChunks++;
        job.chunkResults.push({ chunkIndex: i, requestIds, status: 'success' });
        await this.jobRepo.update(jobId, { doneChunks: job.doneChunks, chunkResults: job.chunkResults });
        console.log(`  [CHUNK] ${i} → success  requestIds=${requestIds.length}건`);
      } catch (err) {
        job.chunkResults.push({ chunkIndex: i, requestIds: [], status: 'failed', error: String(err) });
        await this.jobRepo.update(jobId, { chunkResults: job.chunkResults });
        console.log(`  [CHUNK] ${i} → failed  error=${String(err).slice(0, 60)}`);
      }
    }

    const failedCount = job.chunkResults.filter(c => c.status === 'failed').length;
    const finalStatus: BulkJobStatus =
      failedCount === 0             ? 'COMPLETED'       :
      failedCount === chunks.length ? 'FAILED'          :
                                      'PARTIAL_FAILURE';

    await this.jobRepo.update(jobId, { status: finalStatus });
    console.log(`  [JOB] 완료  status=${finalStatus}  done=${job.doneChunks}/${chunks.length}`);
    return jobId;
  }

  // 실패 청크만 재처리 → 모두 성공 시 COMPLETED 전환
  async retryFailedChunks(jobId: string, userIds: string[]): Promise<void> {
    const job = await this.jobRepo.findById(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const allChunks     = this._chunk(userIds, BulkIssueService.CHUNK_SIZE);
    const failedIndices = job.chunkResults
      .filter(c => c.status === 'failed')
      .map(c => c.chunkIndex);

    console.log(`  [RETRY] 실패 청크 인덱스: [${failedIndices.join(', ')}]`);

    for (const chunkIdx of failedIndices) {
      const chunk = allChunks[chunkIdx];
      if (!chunk) continue;
      try {
        const requestIds = await Promise.all(
          chunk.map(userId => this.submitter.submitMintRequest({ userId, tokenId: job.tokenId, amount: 1n })),
        );
        const entry = job.chunkResults.find(c => c.chunkIndex === chunkIdx)!;
        entry.status     = 'success';
        entry.requestIds = requestIds;
        delete entry.error;
        console.log(`  [RETRY] chunk ${chunkIdx} → success`);
      } catch (err) {
        console.error(`  [RETRY] chunk ${chunkIdx} → 여전히 실패:`, String(err));
      }
    }

    const remainingFailed = job.chunkResults.filter(c => c.status === 'failed').length;
    const newStatus: BulkJobStatus = remainingFailed === 0 ? 'COMPLETED' : 'PARTIAL_FAILURE';
    await this.jobRepo.update(jobId, { status: newStatus, chunkResults: job.chunkResults });
    console.log(`  [RETRY] 완료  status=${newStatus}`);
  }

  // 진행률 조회 — 운영자 폴링 엔드포인트
  async getJobStatus(jobId: string): Promise<BulkJob & { progress: string; progressPct: number }> {
    const job = await this.jobRepo.findById(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    return {
      ...job,
      progress:    `${job.doneChunks}/${job.totalChunks}`,
      progressPct: job.totalChunks > 0
        ? Math.round((job.doneChunks / job.totalChunks) * 100)
        : 0,
    };
  }
}

// ── Mock MintSubmitter 빌더 ───────────────────────────────────────────────────

function makeSubmitter(opts: {
  failForUsersFrom?: number;  // idx >= N인 userId 실패
  alwaysFail?:       boolean;
} = {}): MintSubmitter {
  return {
    async submitMintRequest({ userId }) {
      if (opts.alwaysFail) throw new Error(`WalletNotFoundError: ${userId}`);
      if (opts.failForUsersFrom !== undefined) {
        const idx = parseInt(userId.replace('user-', ''), 10);
        if (idx >= opts.failForUsersFrom) throw new Error(`WalletNotFoundError: ${userId}`);
      }
      return `req-${userId}`;
    },
  };
}

const TOKEN_ID = BigInt(0x01) << BigInt(64);

// ── 섹션 함수 ─────────────────────────────────────────────────────────────────

async function section1(): Promise<void> {
  console.log('[1] _chunk() 알고리즘');
  const svc = new BulkIssueService(new InMemoryBulkJobRepository(), makeSubmitter());

  const arr1000  = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
  const arr1001  = Array.from({ length: 1001 }, (_, i) => `user-${i}`);
  const arr0     = [] as string[];

  const c1000 = svc._chunk(arr1000, 500);
  const c1001 = svc._chunk(arr1001, 500);
  const c0    = svc._chunk(arr0,    500);

  console.log(`  1000명 → ${c1000.length}청크  [${c1000.map(c => c.length).join(', ')}]  ← [500, 500]`);
  console.log(`  1001명 → ${c1001.length}청크  [${c1001.map(c => c.length).join(', ')}]  ← [500, 500, 1]`);
  console.log(`  빈 배열 → ${c0.length}청크`);
}

async function section2(): Promise<void> {
  console.log('[2] 전체 성공 → COMPLETED');
  const repo = new InMemoryBulkJobRepository();
  const svc  = new BulkIssueService(repo, makeSubmitter());
  const users = Array.from({ length: 10 }, (_, i) => `user-${i}`);

  const jobId = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
  const job   = await svc.getJobStatus(jobId);

  console.log(`  status: ${job.status}  ← COMPLETED`);
  console.log(`  totalUsers: ${job.totalUsers}  totalChunks: ${job.totalChunks}  doneChunks: ${job.doneChunks}`);
  console.log(`  progress: ${job.progress}  progressPct: ${job.progressPct}%`);
}

async function section3(): Promise<void> {
  console.log('[3] 부분 실패 → PARTIAL_FAILURE (1000명, 청크 1 실패)');
  const repo  = new InMemoryBulkJobRepository();
  const svc   = new BulkIssueService(repo, makeSubmitter({ failForUsersFrom: 500 }));
  const users = Array.from({ length: 1000 }, (_, i) => `user-${i}`);

  const jobId = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
  const job   = await svc.getJobStatus(jobId);

  console.log(`  status: ${job.status}  ← PARTIAL_FAILURE`);
  console.log(`  doneChunks: ${job.doneChunks}/${job.totalChunks}  progress: ${job.progress}  progressPct: ${job.progressPct}%`);

  const success = job.chunkResults.filter(c => c.status === 'success');
  const failed  = job.chunkResults.filter(c => c.status === 'failed');
  console.log(`  성공 청크: ${success.length}개  실패 청크: ${failed.length}개`);
  console.log(`  실패 청크 인덱스: ${failed.map(c => c.chunkIndex).join(', ')}`);
}

async function section4(): Promise<void> {
  console.log('[4] 전체 실패 → FAILED');
  const repo  = new InMemoryBulkJobRepository();
  const svc   = new BulkIssueService(repo, makeSubmitter({ alwaysFail: true }));
  const users = Array.from({ length: 20 }, (_, i) => `user-${i}`);

  const jobId = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
  const job   = await svc.getJobStatus(jobId);

  console.log(`  status: ${job.status}  ← FAILED`);
  console.log(`  doneChunks: ${job.doneChunks}  ← 0 (성공 청크 없음)`);
}

async function section5(): Promise<void> {
  console.log('[5] retryFailedChunks → COMPLETED 전환');
  const repo  = new InMemoryBulkJobRepository();
  const users = Array.from({ length: 1000 }, (_, i) => `user-${i}`);

  // 1차: 청크 1 실패 → PARTIAL_FAILURE
  const svc1  = new BulkIssueService(repo, makeSubmitter({ failForUsersFrom: 500 }));
  const jobId = await svc1.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
  const before = await svc1.getJobStatus(jobId);
  console.log(`  재처리 전: status=${before.status}  progress=${before.progress}`);

  // 2차: 실패 청크 재처리 (이번엔 성공)
  const svc2 = new BulkIssueService(repo, makeSubmitter());
  await svc2.retryFailedChunks(jobId, users);
  const after = await svc2.getJobStatus(jobId);
  console.log(`  재처리 후: status=${after.status}  ← COMPLETED`);
  console.log(`  모든 청크 success: ${after.chunkResults.every(c => c.status === 'success')}`);
}

async function section6(): Promise<void> {
  console.log('[6] Promise.all — 청크 내 1건 실패 → 청크 전체 실패');
  const repo  = new InMemoryBulkJobRepository();
  const users = Array.from({ length: 5 }, (_, i) => `user-${i}`);

  // user-3만 실패
  const submitter: MintSubmitter = {
    async submitMintRequest({ userId }) {
      console.log(`  [MINT] submitMintRequest  userId=${userId}`);
      if (userId === 'user-3') throw new Error(`WalletNotFoundError: ${userId}`);
      return `req-${userId}`;
    },
  };

  const svc   = new BulkIssueService(repo, submitter);
  const jobId = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
  const job   = await svc.getJobStatus(jobId);

  console.log(`  status: ${job.status}  ← FAILED (5명 < 500 → 1청크, 전체 실패)`);
  console.log(`  실패 이유: Promise.all은 1건 실패 시 즉시 reject → 청크 전체 실패`);
  console.log(`  → Phase 2에서 Promise.allSettled로 개선 예정 (개별 실패 허용)`);
}

async function section7(): Promise<void> {
  console.log('[7] getJobStatus progressPct');
  const repo  = new InMemoryBulkJobRepository();
  const users = Array.from({ length: 600 }, (_, i) => `user-${i}`);
  const svc   = new BulkIssueService(repo, makeSubmitter());

  const jobId = await svc.executeBulkIssue({ userIds: users, tokenId: TOKEN_ID });
  const job   = await svc.getJobStatus(jobId);

  console.log(`  totalUsers: ${job.totalUsers}  totalChunks: ${job.totalChunks}  doneChunks: ${job.doneChunks}`);
  console.log(`  progress: ${job.progress}  progressPct: ${job.progressPct}%  ← 100`);
  console.log(`  계산식: Math.round(doneChunks / totalChunks * 100)`);
  console.log(`          Math.round(${job.doneChunks} / ${job.totalChunks} * 100) = ${job.progressPct}`);
}

// ── 진입점 ───────────────────────────────────────────────────────────────────

const SECTIONS: Record<string, () => Promise<void>> = {
  '1': section1,
  '2': section2,
  '3': section3,
  '4': section4,
  '5': section5,
  '6': section6,
  '7': section7,
};

(async () => {
  const arg = process.argv[2];

  if (arg && SECTIONS[arg]) {
    console.log(`=== S30: 섹션 [${arg}] ===\n`);
    await SECTIONS[arg]!();
  } else {
    console.log('=== S30: BulkIssueService — ERC-1155 배치 발행 구현 — 전체 실행 ===\n');
    for (const fn of Object.values(SECTIONS)) {
      await fn();
      console.log();
    }
  }

  console.log('\nS30 완료');
})();
