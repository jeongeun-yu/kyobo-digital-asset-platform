/**
 * BulkIssueService — 대량 NFT 발행 오케스트레이션
 *
 * M5 S33~S34 핵심 개념:
 *
 * 배치 분할 전략 (S33):
 *   - 전체 userIds를 500건 청크로 분할
 *   - 청크별 독립 requestId → 부분 실패 시 해당 청크만 재처리
 *   - 가스 한도: ~50K gas/건 × 500건 ≈ 25M gas (30M block limit 이내)
 *
 * 부분 실패 처리 정책 (S33):
 *   - 실패 청크 → chunkErrors에 기록, 나머지 청크 계속 처리
 *   - 전체 실패가 아닌 이상 BulkJob 자체는 완료로 처리
 *   - 실패 청크 재실행: retryFailedChunks(jobId)
 *
 * Job 상태 추적:
 *   RUNNING → COMPLETED (모두 성공)
 *           → PARTIAL_FAILURE (일부 실패)
 *           → FAILED (전체 실패)
 *
 * BulkIssueService 위치:
 *   이벤트 → EventConditionService.evaluate() → eligible == true
 *   → 단건:  TxStateMachineService.submitMintRequest()
 *   → 대량:  BulkIssueService.executeBulkIssue()
 *
 * ── 교육생 안내 ──────────────────────────────────────────────────────────────
 * 역할: 참고용 구현체 — 수정하지 말 것
 * 관련 모듈: M5 S33~S34 (배치 발행 설계 · 부분 실패 처리)
 */

import { randomUUID } from 'crypto';

// ── 타입 ──────────────────────────────────────────────────────────────────

export type BulkJobStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL_FAILURE' | 'FAILED';

export interface BulkChunkResult {
  chunkIndex: number;
  requestIds: string[];   // 청크 내 각 발행의 requestId
  status:     'success' | 'failed';
  error?:     string;
}

export interface BulkJob {
  id:          string;
  tokenId:     bigint;
  amount:      bigint;
  totalUsers:  number;
  totalChunks: number;
  doneChunks:  number;
  status:      BulkJobStatus;
  chunkErrors: BulkChunkResult[];
  createdAt:   Date;
  updatedAt:   Date;
}

// ── 의존 인터페이스 ────────────────────────────────────────────────────────

export interface BulkJobRepository {
  save(job: BulkJob): Promise<void>;
  update(id: string, patch: Partial<BulkJob>): Promise<void>;
  findById(id: string): Promise<BulkJob | null>;
}

export interface MintSubmitter {
  submitMintRequest(params: {
    userId:  string;
    tokenId: bigint;
    amount:  bigint;
  }): Promise<string>;  // requestId 반환
}

// ── 서비스 ────────────────────────────────────────────────────────────────

/**
 * BulkIssueService
 *
 * M5 S34 핵심 실습:
 *   executeBulkIssue() 구현 + 1000건 부분 실패 통합 테스트
 *   - 499번째 청크 실패 시나리오 → 나머지 청크 정상 처리 확인
 *   - retryFailedChunks() → 실패 청크만 재처리
 */
export class BulkIssueService {
  private static readonly CHUNK_SIZE = 500;  // block gas limit 기준

  constructor(
    private readonly jobRepo:    BulkJobRepository,
    private readonly submitter:  MintSubmitter,
  ) {}

  /**
   * 대량 NFT 발행 실행
   *
   * M5 S34 실습: executeBulkIssue 흐름
   *   1. BulkJob 생성 (RUNNING)
   *   2. userIds를 CHUNK_SIZE로 분할
   *   3. 청크별 submitMintRequest 병렬 호출
   *   4. 성공/실패 집계 → Job 상태 업데이트
   *   5. jobId 반환 (진행률 조회에 사용)
   *
   * @param userIds   발행 대상 userId 배열 (중복 가능 — Idempotency로 방어)
   * @param tokenId   KyoboNFT.encodeTokenId() 결과
   * @param amount    사용자당 발행 수량
   * @returns jobId
   */
  async executeBulkIssue(params: {
    userIds: string[];
    tokenId: bigint;
    amount?: bigint;
  }): Promise<string> {
    const { userIds, tokenId, amount = 1n } = params;
    const chunks = this._chunk(userIds, BulkIssueService.CHUNK_SIZE);
    const jobId  = randomUUID();
    const now    = new Date();

    const job: BulkJob = {
      id:          jobId,
      tokenId,
      amount,
      totalUsers:  userIds.length,
      totalChunks: chunks.length,
      doneChunks:  0,
      status:      'RUNNING',
      chunkErrors: [],
      createdAt:   now,
      updatedAt:   now,
    };
    await this.jobRepo.save(job);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      try {
        const requestIds = await Promise.all(
          chunk.map(userId =>
            this.submitter.submitMintRequest({ userId, tokenId, amount }),
          ),
        );
        job.doneChunks++;
        await this.jobRepo.update(jobId, {
          doneChunks: job.doneChunks,
          updatedAt:  new Date(),
        });
        job.chunkErrors.push({ chunkIndex: i, requestIds, status: 'success' });
      } catch (err) {
        job.chunkErrors.push({
          chunkIndex: i,
          requestIds: [],
          status:     'failed',
          error:      String(err),
        });
        await this.jobRepo.update(jobId, {
          chunkErrors: job.chunkErrors,
          updatedAt:   new Date(),
        });
      }
    }

    const failedCount = job.chunkErrors.filter(c => c.status === 'failed').length;
    const finalStatus: BulkJobStatus =
      failedCount === 0              ? 'COMPLETED'       :
      failedCount === chunks.length  ? 'FAILED'          :
                                       'PARTIAL_FAILURE';

    await this.jobRepo.update(jobId, {
      status:    finalStatus,
      updatedAt: new Date(),
    });

    return jobId;
  }

  /**
   * 실패 청크 재처리
   *
   * M5 S34 실습: PARTIAL_FAILURE 상태 Job에서 실패 청크만 재실행
   */
  async retryFailedChunks(jobId: string, userIds: string[]): Promise<void> {
    const job = await this._getOrThrow(jobId);

    const failedChunks = job.chunkErrors
      .filter(c => c.status === 'failed')
      .map(c => c.chunkIndex);

    if (failedChunks.length === 0) return;

    const allChunks = this._chunk(userIds, BulkIssueService.CHUNK_SIZE);

    for (const chunkIdx of failedChunks) {
      const chunk = allChunks[chunkIdx];
      if (!chunk) continue;

      try {
        const requestIds = await Promise.all(
          chunk.map(userId =>
            this.submitter.submitMintRequest({ userId, tokenId: job.tokenId, amount: job.amount }),
          ),
        );
        // 해당 청크 결과 업데이트
        const errEntry = job.chunkErrors.find(c => c.chunkIndex === chunkIdx);
        if (errEntry) {
          errEntry.status     = 'success';
          errEntry.requestIds = requestIds;
          delete errEntry.error;
        }
      } catch (err) {
        console.error(`[BulkIssueService] retry chunk ${chunkIdx} failed:`, err);
      }
    }

    const failedCount = job.chunkErrors.filter(c => c.status === 'failed').length;
    await this.jobRepo.update(jobId, {
      status:      failedCount === 0 ? 'COMPLETED' : 'PARTIAL_FAILURE',
      chunkErrors: job.chunkErrors,
      updatedAt:   new Date(),
    });
  }

  async getJobStatus(jobId: string): Promise<BulkJob> {
    return this._getOrThrow(jobId);
  }

  // ── 내부 유틸 ────────────────────────────────────────────────────────

  private _chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }

  private async _getOrThrow(id: string): Promise<BulkJob> {
    const job = await this.jobRepo.findById(id);
    if (!job) throw new BulkJobNotFoundError(id);
    return job;
  }
}

export class BulkJobNotFoundError extends Error {
  constructor(id: string) {
    super(`BulkJob not found: ${id}`);
    this.name = 'BulkJobNotFoundError';
  }
}
