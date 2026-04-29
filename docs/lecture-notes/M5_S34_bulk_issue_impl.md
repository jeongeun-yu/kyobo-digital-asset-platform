# M5 S34 — BulkIssueService 구현과 1000건 부분 실패 통합 테스트

> 모듈 5 · 세션 34 · 1시간  
> 스켈레톤: `dmz/apps/issuer-service/src/services/BulkIssueService.ts`

---

## 강의 파트 (10분)

### 배치 분할 알고리즘 재확인

```
1000명 → CHUNK_SIZE=500 → 2개 청크
  청크 0: userIds[0~499]   → mintBatch tx #1
  청크 1: userIds[500~999] → mintBatch tx #2

순차 처리:
  청크 0 처리 완료 → doneChunks=1
  청크 1 처리 중 실패 → chunkErrors에 추가
  최종: PARTIAL_FAILURE
```

부분 실패 정책 재확인:
- 청크 단위로 try-catch
- 한 청크 실패 → 다음 청크 계속 진행
- 실패 청크는 `chunkErrors`에 기록
- `retryFailedChunks()`로 나중에 재처리

---

## 실습 파트 (50분)

### `executeBulkIssue()` 구현

```typescript
export class BulkIssueService {
  private static readonly CHUNK_SIZE = 500;

  constructor(
    private readonly jobRepo:   BulkJobRepository,
    private readonly submitter: MintSubmitter,
  ) {}

  private _chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }

  async executeBulkIssue(params: {
    userIds: string[];
    tokenId: bigint;
    amount?: bigint;
  }): Promise<string> {
    const { userIds, tokenId, amount = 1n } = params;
    const chunks = this._chunk(userIds, BulkIssueService.CHUNK_SIZE);
    const jobId  = randomUUID();

    // 1. BulkJob 생성 (RUNNING 상태)
    const job: BulkJob = {
      id: jobId,
      tokenId,
      totalUsers:  userIds.length,
      totalChunks: chunks.length,
      doneChunks:  0,
      status:      'RUNNING',
      chunkErrors: [],
      createdAt:   new Date(),
      updatedAt:   new Date(),
    };
    await this.jobRepo.save(job);

    // 2. 청크별 순차 처리 — 청크 간 순차, 청크 내 병렬
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        // 청크 내 500건은 동시 처리
        const requestIds = await Promise.all(
          chunk.map(userId =>
            this.submitter.submitMintRequest({ userId, tokenId, amount }),
          ),
        );

        job.doneChunks++;
        job.chunkErrors.push({ chunkIndex: i, requestIds, status: 'success' });
        await this.jobRepo.update(jobId, {
          doneChunks:  job.doneChunks,
          chunkErrors: job.chunkErrors,
          updatedAt:   new Date(),
        });

      } catch (err) {
        // 청크 실패 → 기록 후 다음 청크로 (전체 중단 안 함)
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

    // 3. 최종 상태 결정
    const failedCount = job.chunkErrors.filter(c => c.status === 'failed').length;
    const finalStatus: BulkJobStatus =
      failedCount === 0             ? 'COMPLETED'      :
      failedCount === chunks.length ? 'FAILED'         :
                                      'PARTIAL_FAILURE';

    await this.jobRepo.update(jobId, { status: finalStatus, updatedAt: new Date() });
    return jobId;
  }
}
```

### `retryFailedChunks()` 구현

```typescript
async retryFailedChunks(jobId: string, userIds: string[]): Promise<void> {
  const job = await this.jobRepo.findById(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  const failedChunkIndices = job.chunkErrors
    .filter(c => c.status === 'failed')
    .map(c => c.chunkIndex);

  if (failedChunkIndices.length === 0) return;

  const allChunks = this._chunk(userIds, BulkIssueService.CHUNK_SIZE);

  for (const chunkIdx of failedChunkIndices) {
    const chunk = allChunks[chunkIdx];
    if (!chunk) continue;

    try {
      const requestIds = await Promise.all(
        chunk.map(userId =>
          this.submitter.submitMintRequest({ userId, tokenId: job.tokenId, amount: 1n }),
        ),
      );

      // 실패 → 성공으로 업데이트
      const entry = job.chunkErrors.find(c => c.chunkIndex === chunkIdx);
      if (entry) {
        entry.status = 'success';
        entry.requestIds = requestIds;
        delete entry.error;
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
```

### InMemory Repository (테스트용)

```typescript
class InMemoryBulkJobRepository implements BulkJobRepository {
  private readonly store = new Map<string, BulkJob>();

  async save(job: BulkJob): Promise<void> {
    this.store.set(job.id, { ...job });
  }

  async update(id: string, patch: Partial<BulkJob>): Promise<void> {
    const current = this.store.get(id);
    if (current) this.store.set(id, { ...current, ...patch });
  }

  async findById(id: string): Promise<BulkJob | null> {
    return this.store.get(id) ?? null;
  }
}
```

### 1000건 부분 실패 통합 테스트

```typescript
describe('BulkIssueService — 1000건 부분 실패', () => {
  it('청크 1 실패 → PARTIAL_FAILURE, 청크 0은 정상', async () => {
    const userIds = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
    const tokenId = BigInt(0x01) << BigInt(64);

    // Mock: 500번 이후 userId에서 WalletNotFoundError 발생
    const mockSubmitter: MintSubmitter = {
      async submitMintRequest({ userId }) {
        const idx = parseInt(userId.replace('user-', ''));
        if (idx >= 500) throw new WalletNotFoundError(userId);
        return `req-${userId}`;
      },
    };

    const jobRepo = new InMemoryBulkJobRepository();
    const service = new BulkIssueService(jobRepo, mockSubmitter);

    const jobId = await service.executeBulkIssue({ userIds, tokenId });
    const job = await service.getJobStatus(jobId);

    expect(job.status).toBe('PARTIAL_FAILURE');
    expect(job.totalChunks).toBe(2);
    expect(job.doneChunks).toBe(1);   // 청크 0만 성공
    expect(job.chunkErrors.filter(c => c.status === 'failed')).toHaveLength(1);
    expect(job.chunkErrors.filter(c => c.status === 'success')).toHaveLength(1);
  });

  it('300건 WalletNotFound → 700건 성공, 300건 실패 목록', async () => {
    const userIds = Array.from({ length: 1000 }, (_, i) => `user-${i}`);

    // 처음 700명 성공, 700~999번 실패
    const mockSubmitter: MintSubmitter = {
      async submitMintRequest({ userId }) {
        const idx = parseInt(userId.replace('user-', ''));
        if (idx >= 700) throw new WalletNotFoundError(userId);
        return `req-${idx}`;
      },
    };

    const service = new BulkIssueService(new InMemoryBulkJobRepository(), mockSubmitter);
    const jobId = await service.executeBulkIssue({ userIds, tokenId: BigInt(0x01) << BigInt(64) });
    const job = await service.getJobStatus(jobId);

    // 청크 0 (0~499): 모두 성공
    // 청크 1 (500~999): 700~999번 실패 → 청크 전체 실패
    expect(job.status).toBe('PARTIAL_FAILURE');

    const failedChunk = job.chunkErrors.find(c => c.status === 'failed');
    expect(failedChunk?.chunkIndex).toBe(1);
    expect(failedChunk?.error).toContain('WalletNotFoundError');
  });

  it('retryFailedChunks → 재처리 후 COMPLETED', async () => {
    // ... 위 실패 시나리오 이후
    // 700~999번 사용자 지갑 등록 시뮬레이션

    const retrySubmitter: MintSubmitter = {
      async submitMintRequest({ userId }) {
        return `req-retry-${userId}`;  // 이제 모두 성공
      },
    };
    const retryService = new BulkIssueService(jobRepo, retrySubmitter);
    await retryService.retryFailedChunks(jobId, userIds);

    const updatedJob = await retryService.getJobStatus(jobId);
    expect(updatedJob.status).toBe('COMPLETED');
    expect(updatedJob.chunkErrors.every(c => c.status === 'success')).toBe(true);
  });
});
```

---

## M5 완료 기준

- [ ] 1000건 중 부분 실패 → 실패 건만 목록 반환
- [ ] 이벤트 → 요청 → VASP E2E 동작
- [ ] retryFailedChunks → COMPLETED 전환
- [ ] 진행률(doneChunks) 매 청크마다 업데이트 확인
