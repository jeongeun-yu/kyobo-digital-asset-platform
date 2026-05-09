# M5 S33 — 대량 NFT 발행 아키텍처 · 배치 분할과 부분 실패 처리 정책

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.

> 모듈 5 · 세션 33 · 1시간 (강의 55분)  
> 스켈레톤: `dmz/apps/issuer-service/src/services/BulkIssueService.ts`

---

## 강의 파트 (55분)

### 1. 왜 대량 발행은 단건 발행과 다른 문제인가

교보생명 이벤트는 특정 날에 대규모로 동시 발생한다.

"1월 한 달 걷기 챌린지 달성자" 집계가 나온다. 결과: 15만명 달성. 이 15만명에게 동시에 NFT를 발행해야 한다.

단건 발행 방식(`issueActivityNFT()` 15만번 순차 호출)으로 처리하면:

```
단건 처리 시간: ~2초/건 (네트워크 지연 포함)
15만건 × 2초 = 300,000초 = 약 3.5일
```

3.5일 후에 NFT를 받는 사용자가 생긴다. 이것은 불가능하다.

블록체인 레벨에서도 문제가 있다. `mint()`를 15만번 호출하면 15만개의 트랜잭션이 필요하다. 각각 가스비를 낸다. `mintBatch()`를 사용하면 여러 명에게 한 번의 TX로 발행할 수 있다.

---

### 2. EVM Block Gas Limit — 왜 500건/배치인가

블록체인의 블록은 한 번에 처리할 수 있는 연산량에 한계가 있다. 이것이 "block gas limit"이다.

```
EVM block gas limit: ~30,000,000 gas
NFT 1건 mint 가스 소비량: ~50,000 gas
한 블록에 들어갈 수 있는 최대 mint 수: 30,000,000 / 50,000 = 600건
안전 여유(20% 버퍼): 600 × 0.83 ≈ 500건
```

1000건을 한 TX에 담으면:

```
1000 × 50,000 = 50,000,000 gas
→ block gas limit 30,000,000 초과
→ TX 자체가 실패
→ 1건도 발행 안 됨
```

그래서 **CHUNK_SIZE = 500**이다.

왜 정확히 500인가? 실제 가스 소비량은 컨트랙트 로직에 따라 다를 수 있다. 50,000 gas는 평균 추정치다. 10~20% 여유를 두면 안전하다. 운영 중에 컨트랙트가 업그레이드되어 가스 소비가 늘어도 여유 범위 안에서 처리된다.

---

### 3. 병렬 처리 vs 순차 처리 트레이드오프

15만명을 500명씩 300개 청크로 나눴다. 이 300개 청크를 어떻게 처리할까?

**병렬 처리 (`Promise.all(chunks)`):**

```typescript
await Promise.all(chunks.map(chunk => processChunk(chunk)));
```

장점: 빠르다. 300개 청크가 동시 실행되면 총 시간이 1개 청크 처리 시간과 같다.

단점:
- VASP API Rate Limit: VASP가 초당 최대 100 요청을 허용하는데 300개를 동시에 보내면 429(Too Many Requests) 발생
- Nonce 충돌: 같은 지갑에서 여러 TX를 동시에 보내면 nonce 순서가 뒤엉킴
- 부분 실패 추적 어려움

**순차 처리 (`for...of`):**

```typescript
for (const chunk of chunks) {
  await processChunk(chunk);
}
```

장점: VASP Rate Limit 안전, nonce 순서 보장, 실패 청크 식별 용이

단점: 느리다. 300개 × 10초/청크 = 50분

BulkIssueService는 **순차 처리**를 선택한다. 교보생명 케이스에서 VASP Rate Limit이 있고, 부분 실패 추적이 더 중요하기 때문이다.

---

### 4. 부분 실패 허용 정책 — 전체 롤백 vs 부분 커밋

대량 발행 중 청크 하나가 실패하면 어떻게 할까?

**전체 롤백 정책:**

```
청크 0 성공 (500명 발행 완료)
청크 1 실패 (500명 중 일부 WalletNotFoundError)
→ 전체 취소: 청크 0도 burn TX 발행 → 500명 NFT 회수
→ 다시 처음부터 실행
```

문제: 성공한 청크도 재처리해야 한다. 청크 0의 500명에게 두 번 발행하지 않으려면 멱등성 체크가 완벽해야 한다. 운영 비용이 높다.

**부분 커밋 정책:**

```
청크 0 성공 → 그대로 유지
청크 1 실패 → 실패 건만 추적, 나중에 재처리
```

당사에서 부분 커밋이 맞는 이유:

1. **보험 이벤트는 사용자별 독립 건**: 사용자 A의 지갑이 미등록됐다고 사용자 B의 발행까지 막을 이유가 없다. 각 사용자의 보험 이벤트는 독립적이다.

2. **재처리 가능**: 실패 건은 `chunkErrors` 목록에 저장된다. `retryFailedChunks()`로 나중에 재처리한다.

3. **실제 운영 현실**: 15만명 중 100명의 지갑이 미등록됐다고 15만건 전체를 다시 처음부터 하는 건 비효율적이다.

---

### 5. 실패 건 추적 구조

```typescript
export type BulkJobStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL_FAILURE' | 'FAILED';

export interface BulkChunkResult {
  chunkIndex: number;
  requestIds: string[];  // 성공 시 각 발행의 requestId
  status:     'success' | 'failed';
  error?:     string;    // 실패 사유 (WalletNotFoundError, RateLimitError 등)
}

export interface BulkJob {
  id:          string;
  tokenId:     bigint;
  totalUsers:  number;
  totalChunks: number;
  doneChunks:  number;       // 처리 완료 청크 수 → 진행률 계산
  status:      BulkJobStatus;
  chunkErrors: BulkChunkResult[];
  createdAt:   Date;
  updatedAt:   Date;
}
```

BulkJob 상태 결정:
- 모든 청크 성공 → `COMPLETED`
- 일부 청크 실패 → `PARTIAL_FAILURE`
- 모든 청크 실패 → `FAILED`

---

### 6. 진행률 업데이트 패턴

15만명 발행이 진행 중일 때 운영자가 "지금 몇 퍼센트 완료됐나?"를 보고 싶다.

```typescript
// 청크 처리 후 즉시 DB 업데이트
await this.jobRepo.update(jobId, {
  doneChunks: job.doneChunks + 1,
  updatedAt:  new Date(),
});
```

클라이언트가 진행률을 확인하는 방법:

| 방식 | 구현 난이도 | 실시간성 | Phase 1 선택 |
|---|---|---|---|
| Polling (`GET /jobs/{id}`) | 쉬움 | 낮음 (5~10초 지연) | ✅ |
| SSE (Server-Sent Events) | 중간 | 높음 | Phase 2 |
| WebSocket | 어려움 | 매우 높음 | Phase 3 |

Phase 1: `GET /admin/bulk-jobs/{jobId}` 폴링 방식으로 구현한다.

---

### 7. 청크 내부는 병렬, 청크 간은 순차

중요한 세부사항이다. **청크 간**은 순차이지만, **청크 내부**는 병렬이다.

```typescript
for (const chunk of chunks) {
  // 청크 내부 500건은 동시 처리
  const requestIds = await Promise.all(
    chunk.map(userId => this.submitter.submitMintRequest({ userId, tokenId, amount })),
  );
  // 이 청크 완료 후 다음 청크로
}
```

청크 내 500건을 병렬로 처리하면 한 청크 처리 시간이 ~10초다(단건 순차면 500 × 2초 = 1000초). 300개 청크 × 10초 = 50분. 수용 가능한 시간이다.

---

## 완료 기준 (강의 세션 — 이해 체크)

- [ ] 500건/배치 근거 설명 가능 (가스 계산 포함)
- [ ] 부분 실패 정책 판단 기준 설명 (독립 건 특성)
- [ ] 실패 건 추적 구조 설계 가능
- [ ] 병렬 vs 순차 트레이드오프 설명 가능
