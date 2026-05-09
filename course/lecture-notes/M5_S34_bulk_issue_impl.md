# M5 S34 — BulkIssueService 구현과 1000건 부분 실패 통합 테스트

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.

> 모듈 5 · 세션 34 · 1시간  
> 스켈레톤: `dmz/apps/issuer-service/src/services/BulkIssueService.ts`

---

## 강의 파트 (25분)

### 1. 배치 분할 알고리즘 재확인

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

### 2. `_chunk()` 알고리즘 — 왜 이 구현인가

```typescript
private _chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
```

```
arr = ['u0','u1','u2','u3','u4','u5','u6','u7','u8','u9']
size = 3

i=0: slice(0,3) → ['u0','u1','u2']
i=3: slice(3,6) → ['u3','u4','u5']
i=6: slice(6,9) → ['u6','u7','u8']
i=9: slice(9,12) → ['u9']         ← 마지막 청크는 size보다 작을 수 있음

result = [['u0','u1','u2'], ['u3','u4','u5'], ['u6','u7','u8'], ['u9']]
```

`slice(i, i+size)`는 배열 끝을 넘어도 오류 없이 있는 만큼만 반환한다. 따라서 `arr.length % size !== 0`인 경우도 자동 처리된다.

**왜 라이브러리(lodash `_.chunk`)를 쓰지 않는가?** 이 로직은 단순하고 핵심 비즈니스 로직과 결합되어 있다. 외부 의존성을 최소화하는 것이 마이크로서비스 설계 원칙이다. 단, 팀 코딩 컨벤션이 lodash 허용이면 써도 된다.

---

### 3. BulkJob 상태 전이 다이어그램

```
                   executeBulkIssue() 호출
                          │
                          ▼
                       RUNNING
                          │
              ┌───────────┴───────────┐
              │                       │
        모든 청크 성공           일부 청크 실패
              │                       │
              ▼                       │
          COMPLETED           ┌───────┴─────────┐
                              │                 │
                       일부만 실패           모두 실패
                              │                 │
                              ▼                 ▼
                      PARTIAL_FAILURE         FAILED
                              │
                   retryFailedChunks() 호출
                              │
                    ┌─────────┴─────────┐
                    │                   │
              재처리 모두 성공       재처리도 실패
                    │                   │
                    ▼                   ▼
                COMPLETED        PARTIAL_FAILURE (유지)
```

PARTIAL_FAILURE에서 COMPLETED로 전이하는 유일한 경로: `retryFailedChunks()` 후 모든 청크 성공.

---

### 4. `getJobStatus()` — 운영자 폴링 엔드포인트

`executeBulkIssue()`는 jobId만 즉시 반환하고 백그라운드에서 계속 실행된다. 운영자는 별도 API로 진행률을 조회한다.

```typescript
// BulkIssueService에 추가
async getJobStatus(jobId: string): Promise<BulkJob> {
  const job = await this.jobRepo.findById(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return job;
}

// 컨트롤러
app.get('/admin/bulk-jobs/:jobId', async (req, res) => {
  const job = await bulkIssueService.getJobStatus(req.params.jobId);
  res.json({
    ...job,
    progress: `${job.doneChunks}/${job.totalChunks}`,
    progressPct: Math.round((job.doneChunks / job.totalChunks) * 100),
  });
});
```

응답 예시:

```json
{
  "id": "bulk-job-uuid-001",
  "status": "PARTIAL_FAILURE",
  "totalUsers": 1000,
  "totalChunks": 2,
  "doneChunks": 1,
  "progress": "1/2",
  "progressPct": 50,
  "chunkErrors": [
    { "chunkIndex": 0, "status": "success", "requestIds": ["req-0", "..."] },
    { "chunkIndex": 1, "status": "failed",  "error": "WalletNotFoundError: user-501" }
  ]
}
```

---

### 5. 청크 내 Promise.all 부분 실패 — 주의사항

```typescript
// 현재 구현: 청크 내 500건을 Promise.all로 동시 처리
const requestIds = await Promise.all(
  chunk.map(userId => this.submitter.submitMintRequest(...)),
);
```

`Promise.all`은 하나라도 reject되면 전체가 reject된다. 즉:

```
청크 내 499건 성공, 1건 WalletNotFoundError
→ Promise.all reject → 청크 전체 실패로 기록
```

499건의 성공은 이미 DB에 PENDING 상태로 기록됐을 수 있다. 재처리 시 멱등성 체크가 없으면 499건이 이중 발행된다.

**해결 방법 (운영 고려 사항):**

```typescript
// 개선 방법: Promise.allSettled 사용 → 개별 실패 추적
const results = await Promise.allSettled(
  chunk.map(userId => this.submitter.submitMintRequest(...)),
);

const successIds = results
  .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
  .map(r => r.value);

const failedUserIds = chunk.filter((_, i) => results[i].status === 'rejected');
```

Phase 1에서는 `Promise.all`을 사용한다(구현 단순성). Phase 2에서 `Promise.allSettled`로 전환해 청크 내 개별 실패 추적을 구현한다.

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

## 세션 완료 기준

- [ ] `_chunk()` 알고리즘 — 1000명을 CHUNK_SIZE=500으로 분할하면 정확히 2개 청크
- [ ] `_chunk()` — 마지막 청크가 size보다 작아도 (예: 1001명) 오류 없이 처리
- [ ] 1000건 중 청크 1 실패 → status=PARTIAL_FAILURE, doneChunks=1 확인
- [ ] 모든 청크 성공 → status=COMPLETED 확인
- [ ] 모든 청크 실패 → status=FAILED 확인
- [ ] retryFailedChunks → 실패 청크만 재처리 → 성공 후 COMPLETED 전환
- [ ] 진행률(doneChunks) 매 청크 성공마다 즉시 DB 업데이트 확인
- [ ] getJobStatus() → { progress, progressPct } 계산 정확성 확인
- [ ] Promise.all 내 1건 실패 → 청크 전체 실패 기록됨 이해

## M5 모듈 전체 완료 기준

- [ ] 지갑 프로비저닝 흐름 (S27): userId → VASP API → walletAddr → DB 저장
- [ ] 매핑 설계 (S28): UNIQUE(user_id), verified=false 지갑 차단
- [ ] EIP-191 서명 (S29): ecrecover → 주소 일치 → nonce 무효화 순서 준수
- [ ] 조건 판단 (S30): Strategy 패턴 → OCP 준수, tokenId 비트 인코딩 동기화
- [ ] 조건 테스트 (S31): 경계값 + 누락 방어 + 플러그인 교체 테스트 통과
- [ ] 단건 발행 (S32): 파이프라인 각 단계 실패 → 다음 단계 차단, fire-and-forget
- [ ] 대량 발행 아키텍처 (S33): 500건/배치 근거, 부분 커밋 정책, 병렬/순차 트레이드오프
- [ ] 대량 발행 구현 (S34): 부분 실패 → PARTIAL_FAILURE, retryFailedChunks → COMPLETED
