/**
 * S34 실습 — BulkIssueService 구현과 1000건 부분 실패 통합 테스트
 *
 * 강의 노트: M5_S34_bulk_issue_impl.md
 *
 * 실행 방법 (루트에서): npm run exercise:s34
 *
 * 목표:
 *   [1] _chunk() 알고리즘 — 마지막 청크가 작아도 오류 없이 처리
 *   [2] executeBulkIssue() — 청크 간 순차 / 청크 내 병렬(Promise.all)
 *   [3] 부분 실패 → PARTIAL_FAILURE / 전체 실패 → FAILED / 전체 성공 → COMPLETED
 *   [4] retryFailedChunks() — 실패 청크만 재처리 → COMPLETED 전환
 *   [5] getJobStatus() — doneChunks 진행률 + progressPct 계산
 */

import { randomUUID } from 'crypto';

// ────────────────────────────────────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────────────────────────────────────

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

interface BulkJobRepository {
  save(job: BulkJob): Promise<void>;
  update(id: string, patch: Partial<BulkJob>): Promise<void>;
  findById(id: string): Promise<BulkJob | null>;
}

/** 단건 발행 요청 제출 인터페이스 */
interface MintSubmitter {
  submitMintRequest(params: {
    userId:  string;
    tokenId: bigint;
    amount:  bigint;
  }): Promise<string>;  // returns requestId
}

// ────────────────────────────────────────────────────────────────────────
// 에러 클래스 (완성 코드 — 수정 불필요)
// ────────────────────────────────────────────────────────────────────────

class WalletNotFoundError extends Error {
  constructor(userId: string) {
    super(`WalletNotFoundError: ${userId}`);
    this.name = 'WalletNotFoundError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// InMemory BulkJobRepository (완성 코드 — 수정 불필요)
// ────────────────────────────────────────────────────────────────────────

class InMemoryBulkJobRepository implements BulkJobRepository {
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

// ────────────────────────────────────────────────────────────────────────
// 실습: BulkIssueService 메서드 3개를 구현하라
//
// ────────────────────────────────────────────────────────────────────────
// 실습 1: _chunk<T>(arr: T[], size: number): T[][]
//
// 배열을 size 단위로 분할한다.
// - slice(i, i+size)는 배열 끝을 넘어도 오류 없이 있는 만큼만 반환
// - 빈 배열 → [] 반환
//
// 구현 패턴:
//   const result: T[][] = [];
//   for (let i = 0; i < arr.length; i += size) {
//     result.push(arr.slice(i, i + size));
//   }
//   return result;
//
// ────────────────────────────────────────────────────────────────────────
// 실습 2: executeBulkIssue(params): Promise<string>
//
// 처리 순서:
// 1. chunks = this._chunk(userIds, BulkIssueService.CHUNK_SIZE)
// 2. jobId = randomUUID()
// 3. BulkJob 생성 후 jobRepo.save(job) 호출 (status: 'RUNNING', doneChunks: 0, chunkErrors: [])
// 4. 청크 간 순차 처리 (for loop):
//    try:
//      requestIds = await Promise.all(chunk.map(userId => submitter.submitMintRequest({ userId, tokenId, amount })))
//      job.doneChunks++
//      job.chunkErrors.push({ chunkIndex: i, requestIds, status: 'success' })
//      await jobRepo.update(jobId, { doneChunks: job.doneChunks, chunkErrors: job.chunkErrors, updatedAt: new Date() })
//    catch (err):
//      job.chunkErrors.push({ chunkIndex: i, requestIds: [], status: 'failed', error: String(err) })
//      await jobRepo.update(jobId, { chunkErrors: job.chunkErrors, updatedAt: new Date() })
// 5. 최종 상태 결정:
//    failedCount = job.chunkErrors.filter(c => c.status === 'failed').length
//    finalStatus =
//      failedCount === 0 → 'COMPLETED'
//      failedCount === chunks.length → 'FAILED'
//      else → 'PARTIAL_FAILURE'
// 6. await jobRepo.update(jobId, { status: finalStatus, updatedAt: new Date() })
// 7. return jobId
//
// ────────────────────────────────────────────────────────────────────────
// 실습 3: retryFailedChunks(jobId, userIds): Promise<void>
//
// 처리 순서:
// 1. job = await jobRepo.findById(jobId)
//    - null → throw new Error(`Job not found: ${jobId}`)
// 2. failedChunkIndices = 실패 청크 인덱스 목록
// 3. allChunks = this._chunk(userIds, BulkIssueService.CHUNK_SIZE)
// 4. 각 failedChunkIndex에 대해:
//    try:
//      requestIds = await Promise.all(chunk.map(...submitMintRequest))
//      entry = job.chunkErrors.find(c => c.chunkIndex === chunkIdx)
//      entry.status = 'success', entry.requestIds = requestIds, delete entry.error
//    catch (err): console.error 후 계속 (status='failed' 유지)
// 5. remainingFailed = 남은 실패 청크 수
// 6. await jobRepo.update(jobId, { status: remainingFailed === 0 ? 'COMPLETED' : 'PARTIAL_FAILURE', chunkErrors: job.chunkErrors, updatedAt: new Date() })
// ────────────────────────────────────────────────────────────────────────

export class BulkIssueService {
  static readonly CHUNK_SIZE = 500;

  constructor(
    private readonly jobRepo:   BulkJobRepository,
    private readonly submitter: MintSubmitter,
  ) {}

  /**
   * 배열을 size 단위로 청크 분할
   */
  _chunk<T>(arr: T[], size: number): T[][] {
    throw new Error('TODO: 구현하세요');
  }

  /** 배치 발행 실행 — jobId 즉시 반환, 청크 처리 후 상태 업데이트 */
  async executeBulkIssue(params: {
    userIds: string[];
    tokenId: bigint;
    amount?: bigint;
  }): Promise<string> {
    throw new Error('TODO: 구현하세요');
  }

  /**
   * 실패 청크만 재처리
   * PARTIAL_FAILURE → 모든 청크 성공 시 COMPLETED 전환
   */
  async retryFailedChunks(jobId: string, userIds: string[]): Promise<void> {
    throw new Error('TODO: 구현하세요');
  }

  /** 진행률 조회 — 운영자 폴링 엔드포인트 (완성 코드 — 수정 불필요) */
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

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

if (require.main === module) (async () => {
  console.log('=== S34: BulkIssueService — 배치 발행 구현 ===\n');

  const TOKEN_ID = BigInt(0x01) << BigInt(64);

  // ── [1] _chunk() 알고리즘 ──────────────────────────────────────────────
  console.log('[검증 1] _chunk() 알고리즘');
  const dummyRepo  = new InMemoryBulkJobRepository();
  const dummyMint: MintSubmitter = { async submitMintRequest({ userId }) { return `req-${userId}`; } };
  const helper     = new BulkIssueService(dummyRepo, dummyMint);

  const arr1000 = Array.from({ length: 1000 }, (_, i) => `u-${i}`);
  const chunks1000 = helper._chunk(arr1000, 500);
  check('1000명 → 2개 청크',                     chunks1000.length === 2);
  check('첫 번째 청크 500명',                     chunks1000[0]!.length === 500);
  check('두 번째 청크 500명',                     chunks1000[1]!.length === 500);

  const arr1001 = Array.from({ length: 1001 }, (_, i) => `u-${i}`);
  const chunks1001 = helper._chunk(arr1001, 500);
  check('1001명 → 3개 청크',                     chunks1001.length === 3);
  check('마지막 청크 1명 (오류 없이 처리)',         chunks1001[2]!.length === 1);

  const chunksEmpty = helper._chunk([], 500);
  check('빈 배열 → 0개 청크',                     chunksEmpty.length === 0);

  // ── [2] 전체 성공 → COMPLETED ─────────────────────────────────────────
  console.log('\n[검증 2] 전체 성공 → status=COMPLETED');
  const repo2    = new InMemoryBulkJobRepository();
  const submitter2: MintSubmitter = {
    async submitMintRequest({ userId }) { return `req-${userId}`; },
  };
  const svc2    = new BulkIssueService(repo2, submitter2);
  const users10 = Array.from({ length: 10 }, (_, i) => `user-${i}`);

  const jobId2 = await svc2.executeBulkIssue({ userIds: users10, tokenId: TOKEN_ID });
  const job2   = await svc2.getJobStatus(jobId2);

  check('10명 → status=COMPLETED',               job2.status === 'COMPLETED');
  check('totalUsers=10',                          job2.totalUsers === 10);
  check('doneChunks=1 (10명 < 500 → 1청크)',     job2.doneChunks === 1);
  check('progress 형식 "1/1"',                   job2.progress === '1/1');
  check('progressPct=100',                        job2.progressPct === 100);

  // ── [3] 1000건 청크 1 실패 → PARTIAL_FAILURE ──────────────────────────
  console.log('\n[검증 3] 1000건 부분 실패 — 청크 1 실패 → PARTIAL_FAILURE');
  const repo3    = new InMemoryBulkJobRepository();

  const submitter3: MintSubmitter = {
    async submitMintRequest({ userId }) {
      const idx = parseInt(userId.replace('user-', ''));
      if (idx >= 500) throw new WalletNotFoundError(userId);
      return `req-${userId}`;
    },
  };
  const svc3    = new BulkIssueService(repo3, submitter3);
  const users1000 = Array.from({ length: 1000 }, (_, i) => `user-${i}`);

  const jobId3 = await svc3.executeBulkIssue({ userIds: users1000, tokenId: TOKEN_ID });
  const job3   = await svc3.getJobStatus(jobId3);

  check('status=PARTIAL_FAILURE',                 job3.status === 'PARTIAL_FAILURE');
  check('totalChunks=2',                          job3.totalChunks === 2);
  check('doneChunks=1 (청크 0 성공)',             job3.doneChunks === 1);
  check('progress="1/2"',                         job3.progress === '1/2');
  check('progressPct=50',                         job3.progressPct === 50);

  const successChunks = job3.chunkErrors.filter(c => c.status === 'success');
  const failedChunks  = job3.chunkErrors.filter(c => c.status === 'failed');
  check('성공 청크 1개',                           successChunks.length === 1);
  check('실패 청크 1개',                           failedChunks.length === 1);
  check('실패 청크 인덱스 = 1',                    failedChunks[0]?.chunkIndex === 1);
  check('실패 청크 error에 WalletNotFoundError',   failedChunks[0]?.error?.includes('WalletNotFoundError') === true);

  // ── [4] 모든 청크 실패 → FAILED ──────────────────────────────────────
  console.log('\n[검증 4] 모든 청크 실패 → status=FAILED');
  const repo4    = new InMemoryBulkJobRepository();
  const submitter4: MintSubmitter = {
    async submitMintRequest({ userId }) { throw new WalletNotFoundError(userId); },
  };
  const svc4    = new BulkIssueService(repo4, submitter4);
  const users20 = Array.from({ length: 20 }, (_, i) => `user-${i}`);

  const jobId4 = await svc4.executeBulkIssue({ userIds: users20, tokenId: TOKEN_ID });
  const job4   = await svc4.getJobStatus(jobId4);

  check('모든 청크 실패 → status=FAILED',          job4.status === 'FAILED');
  check('doneChunks=0',                            job4.doneChunks === 0);

  // ── [5] retryFailedChunks → COMPLETED 전환 ────────────────────────────
  console.log('\n[검증 5] retryFailedChunks → 재처리 후 COMPLETED');

  const repo5    = new InMemoryBulkJobRepository();

  const submitter5First: MintSubmitter = {
    async submitMintRequest({ userId }) {
      const idx = parseInt(userId.replace('user-', ''));
      if (idx >= 500) throw new WalletNotFoundError(userId);
      return `req-${userId}`;
    },
  };
  const svc5First = new BulkIssueService(repo5, submitter5First);
  const jobId5    = await svc5First.executeBulkIssue({ userIds: users1000, tokenId: TOKEN_ID });

  const beforeRetry = await svc5First.getJobStatus(jobId5);
  check('재처리 전 PARTIAL_FAILURE',               beforeRetry.status === 'PARTIAL_FAILURE');

  const submitter5Retry: MintSubmitter = {
    async submitMintRequest({ userId }) { return `req-retry-${userId}`; },
  };
  const svc5Retry = new BulkIssueService(repo5, submitter5Retry);
  await svc5Retry.retryFailedChunks(jobId5, users1000);

  const afterRetry = await svc5Retry.getJobStatus(jobId5);
  check('재처리 후 status=COMPLETED',              afterRetry.status === 'COMPLETED');
  check('모든 청크 success',                       afterRetry.chunkErrors.every(c => c.status === 'success'));

  // ── [6] doneChunks 실시간 업데이트 확인 ────────────────────────────────
  console.log('\n[검증 6] doneChunks 매 청크 성공마다 즉시 DB 업데이트');
  const repo6    = new InMemoryBulkJobRepository();
  const submitter6: MintSubmitter = {
    async submitMintRequest({ userId }) { return `req-${userId}`; },
  };
  const svc6 = new BulkIssueService(repo6, submitter6);
  const users600 = Array.from({ length: 600 }, (_, i) => `user-${i}`);

  const jobId6 = await svc6.executeBulkIssue({ userIds: users600, tokenId: TOKEN_ID });
  const job6   = await svc6.getJobStatus(jobId6);

  check('600명 2청크 모두 성공',                   job6.status === 'COMPLETED');
  check('doneChunks=2',                            job6.doneChunks === 2);
  check('chunkErrors 2개 (모두 success)',          job6.chunkErrors.length === 2);

  // ── [7] getJobStatus — progressPct 계산 ──────────────────────────────
  console.log('\n[검증 7] getJobStatus progressPct 계산');
  const jobFull     = await svc6.getJobStatus(jobId6);
  check('progressPct=100 (2/2)',                   jobFull.progressPct === 100);

  const jobPartial  = await svc5Retry.getJobStatus(jobId5);
  check('재처리 완료 후 progressPct=50 → 이후 100으로 변경됨', jobPartial.progress === '1/2' || jobPartial.progress === '2/2');

  // ── [8] 1001명 (비균등 분할) 처리 확인 ──────────────────────────────────
  console.log('\n[검증 8] 1001명 비균등 분할 — 마지막 청크 1명');
  const repo8    = new InMemoryBulkJobRepository();
  const svc8     = new BulkIssueService(repo8, dummyMint);
  const users1001 = Array.from({ length: 1001 }, (_, i) => `user-${i}`);

  const jobId8 = await svc8.executeBulkIssue({ userIds: users1001, tokenId: TOKEN_ID });
  const job8   = await svc8.getJobStatus(jobId8);

  check('1001명 → 3청크',                          job8.totalChunks === 3);
  check('전체 성공 → COMPLETED',                   job8.status === 'COMPLETED');
  check('doneChunks=3',                            job8.doneChunks === 3);

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S34 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. _chunk(): slice(i, i+size) — 마지막 청크 size 미만이어도 자동 처리');
  console.log('  2. 청크 간 순차 + 청크 내 병렬(Promise.all) — 가스비 vs 안정성 트레이드오프');
  console.log('  3. 부분 실패 정책: 한 청크 실패 → 다음 청크 계속 → PARTIAL_FAILURE');
  console.log('  4. 상태 전이: RUNNING → COMPLETED / PARTIAL_FAILURE / FAILED');
  console.log('  5. retryFailedChunks(): 실패 청크만 재처리 → 성공 시 COMPLETED 전환');
  console.log('  6. getJobStatus(): doneChunks/totalChunks → progress + progressPct');
  console.log('  7. Promise.all 1건 실패 → 청크 전체 실패 → Phase 2에서 allSettled로 개선 예정');

  console.log('\n=== M5 모듈 전체 완료 기준 체크 ===');
  console.log('  ✅ S27: userId → VASP API → walletAddr → DB 저장 (프로비저닝 분기)');
  console.log('  ✅ S28: UNIQUE(user_id), verified=false 지갑 차단 (매핑 설계)');
  console.log('  ✅ S29: ecrecover → 주소 일치 → nonce 무효화 (EIP-191 서명)');
  console.log('  ✅ S30: Strategy 패턴 → OCP 준수, tokenId 비트 인코딩 (조건 판단)');
  console.log('  ✅ S31: 경계값 + 누락 방어 + 플러그인 교체 테스트 (조건 테스트)');
  console.log('  ✅ S32: 파이프라인 각 단계 차단, fire-and-forget (단건 발행)');
  console.log('  ✅ S34: 부분 실패 PARTIAL_FAILURE, retryFailedChunks → COMPLETED (대량 발행)');
})();
