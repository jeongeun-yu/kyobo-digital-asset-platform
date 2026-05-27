# Day 06 — M3 마무리 + M4 전반부: VASP 이중 채널 + 내부 원장 (S21~S24)

**세션**: S21~S24 | **모듈**: M3~M4 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: pollStaleRequests + 3종 복구 통합 테스트 + 내부 원장 4테이블 + 상태 전이 가드

---

## S21: VASP 이중 채널 동기화 아키텍처 설계 원리 (강의 55분)

### 강의 (이론 세션 — 실습 없음)

**단일 콜백 방식의 취약점:**
- 콜백 1회 유실 시 상태 갱신 불가
- VASP 재전송 보장 없는 경우 영구 PENDING 상태 방치

**이중 채널 필요성:**
- [A] 콜백(빠름, 유실 가능) + [B] 폴링(느림, 확실)
- 두 채널이 상호 보완 → 멱등성으로 충돌 없음

**30분 타임아웃 기준 근거:**
- VASP SLA 기준 정상 처리 시간: 평균 2~10분
- 안전 여유 포함 → 30분
- 너무 짧으면 오탐, 너무 길면 감지 지연

**폴링 대상 선별 원칙:**
- PENDING 상태 + 생성 30분 초과 건만
- 전체 조회 시 DB 부하 → 인덱스 설계 필요

**콜백 누락 경로 전체 분석:**
1. 네트워크 유실
2. VASP 재전송 정책 없음
3. WebhookReceiver 처리 실패
4. Consumer 장애

**pollStaleRequests 알고리즘:**
```
1. PENDING 30분 초과 목록 조회
2. 각 건에 대해 VASP API 직접 조회
3. 결과별 전이 적용 (CONFIRMED / FAILED / 여전히 PENDING)
```

**이중 채널 실제 운영:**
- 콜백이 처리되면 폴링은 멱등성에 의해 무시 → 추가 비용 없음

### ✅ 완료 기준 (강의 이해 확인)
- [ ] 이중 채널 필요성 설명 가능
- [ ] 콜백 누락 시나리오 3가지 나열 가능
- [ ] pollStaleRequests 알고리즘 설계 설명 가능

---

## S22: 폴링 기반 상태 보정과 3종 복구 전략 통합 검증 (개요 10분 + 실습 50분)

### 개요 (10분)

이중 채널 아키텍처 재확인 + pollStaleRequests 알고리즘 흐름 재확인

### 🔴 실습 (50분) — 수강생 직접 작성

**Step 1**: pollStaleRequests 구현
```typescript
// internal/packages/vasp/src/VaspService.ts
// TODO: 30분 초과 PENDING 목록 조회 → VASP 상태 직접 조회 → 결과 반영

async pollStaleRequests(): Promise<void> {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

  // TODO: PENDING 상태 + created_at < thirtyMinutesAgo 조회
  const staleRequests = await this.db('mint_requests')
    .where({ status: 'PENDING' })
    .where('created_at', '<', thirtyMinutesAgo);

  for (const request of staleRequests) {
    // TODO: adapter.verifyTx(request.tx_hash) 호출
    // TODO: 결과에 따라 전이: confirmed → CONFIRMED / reverted → FAILED
  }
}
```

**Step 2**: 3종 통합 테스트
```typescript
// TODO: REVERT 시나리오
it('REVERT → FAILED 전이', async () => {
  // Mock: REVERT 응답 설정
  // vaspService.submitMintRequest() 호출
  // 결과: FAILED + reason 저장
});

// TODO: TIMEOUT 시나리오
it('TIMEOUT → gas bump → CONFIRMED', async () => {
  // Mock: 3블록 미채굴 → gas bump 후 성공
  // handleTxTimeout() 호출
  // 결과: CONFIRMED
});

// TODO: REORG 시나리오
it('REORG → 재확인 → CONFIRMED', async () => {
  // Mock: CONFIRMED 후 REORG → 재조회 시 CONFIRMED
  // handleReorg() 호출
  // 결과: CONFIRMED
});
```

**Step 3**: 콜백 차단 테스트
```typescript
// TODO: WebhookReceiver 응답 막기 → 30분 폴링에서 자동 처리 확인
it('콜백 차단 → 폴링 자동 처리', async () => {
  // 1. WebhookReceiver 비활성화
  // 2. 요청 생성 → PENDING 상태
  // 3. created_at을 30분 전으로 강제 설정
  // 4. pollStaleRequests() 실행
  // 5. 상태가 CONFIRMED로 변경됨 확인
});
```

### ✅ 답안

```typescript
// pollStaleRequests 완성
async pollStaleRequests(): Promise<void> {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
  
  const staleRequests = await this.db('mint_requests')
    .where({ status: 'PENDING' })
    .where('created_at', '<', thirtyMinutesAgo);

  for (const request of staleRequests) {
    try {
      const result = await this.adapter.verifyTx(request.tx_hash);
      
      if (result.confirmed) {
        await transitionStatus(request.id, 'PENDING', 'CONFIRMED', this.db);
      } else if (result.reverted) {
        await this.handleTxRevert(request.id, result.revertReason ?? 'UNKNOWN');
      }
      // 여전히 PENDING: 다음 폴링에서 재확인
    } catch (err) {
      console.error(`[Poll] 요청 ${request.id} 상태 조회 실패:`, err);
    }
  }
}
```

### ✅ M3 완료 기준
- [ ] 3종 복구 통합 테스트 전부 통과
- [ ] 콜백 차단 후 폴링 동작 확인
- [ ] 동일 requestId 재전송 → 중복 없음

---

## M3 마무리 — TX 상태머신 테스트 실행 (강의 5분 + 실습 10분)

### 강의 (5분)

M3에서 구현한 TX 상태머신과 pollStaleRequests가 실제 PostgreSQL과 맞게 동작하는지 확인한다.

`tx-status.integration.test.ts` — `TxStateMachineService` + `PgTxRepository`만 올린다. VASP는 테스트 전용 페이크(`ControlledVaspClient`)로 교체하므로 블록체인 없이 실행된다.

| 테스트 | 검증 항목 |
|---|---|
| `[2]` SUBMITTED → MINED → CONFIRMED → FINALIZED | 정상 전이 순서 |
| `[2-b]` SUBMITTED → PENDING → MINED → CONFIRMED → FINALIZED | PENDING 경유 정상 경로 |
| `[3]` MINED → REORGED → MINED | S19~20 REORG 복구 |
| `[4]` SUBMITTED → FAILED | S18 REVERT |
| `[5]` FINALIZED 이후 전이 → InvalidStatusTransitionError | 종단 상태 보호 |
| `[6]` FAILED 이후 전이 → DB 변경 없음 | 종단 상태 보호 |
| `[7]` PENDING 30분 초과 → pollStaleRequests → CONFIRMED | S22 폴링 복구 |
| `[8]` transition 이벤트 발행 확인 | 이벤트 설계 |

### 🔴 실습 (10분)

```bash
cd internal/integration
npx jest tx-status --runInBand
```

통과 후 확인할 것:
- `[5]` FINALIZED → FAILED 시도 시 `InvalidStatusTransitionError` 출력
- `[7]` `pollStaleRequests()` 반환값 `{ processed: 1 }`

### ✅ M3 테스트 완료 기준
- [ ] `tx-status` 8개 전체 통과
---

## S23: 온체인만으로 부족한 이유 — 내부 원장 필요성과 데이터 모델 설계 (강의 25분 + 실습 30분)

### 강의

**온체인만으론 부족한 이유:**
- 조회 비용: 매 balanceOf 호출 → 가스비 또는 RPC 부하
- 인덱싱 불가: 사용자별 보유 NFT 목록 쿼리 불가
- 비즈니스 맥락: 보험 계약 연결, 수익자 정보 등

**4개 테이블 역할 분리:**
| 테이블 | 역할 |
|---|---|
| `user_nft_holdings` | 현재 보유 상태 |
| `processed_events` | 처리 이력 (UNIQUE 키 = 멱등성) |
| `mint_requests` | 요청 상태머신 |
| `audit_log` | 불변 감사 로그 |

**규제 요건:**
- 전금법·가상자산법: 5년 보관 의무
- 감독원 요청 시 즉시 조회 가능해야 함

### 🔴 실습 (30분) — 수강생 직접 작성

**Step 1**: 4개 테이블 마이그레이션 작성
```typescript
// internal/packages/ledger/src/migrations/001_create_tables.ts
// TODO: 아래 테이블들의 마이그레이션 작성

export async function up(knex: Knex): Promise<void> {
  // user_nft_holdings
  await knex.schema.createTable('user_nft_holdings', (t) => {
    // TODO: user_id, token_id, amount, updated_at
    // TODO: PRIMARY KEY (user_id, token_id)
  });

  // processed_events
  await knex.schema.createTable('processed_events', (t) => {
    // TODO: id, tx_hash, log_index, event_type, payload, processed_at
    // TODO: UNIQUE(tx_hash, log_index) — 멱등성 핵심
  });

  // mint_requests
  await knex.schema.createTable('mint_requests', (t) => {
    // TODO: id(UUID), user_id, token_id, amount, status, tx_hash,
    //        failure_reason, gas_price, nonce, created_at, updated_at
  });

  // audit_log
  await knex.schema.createTable('audit_log', (t) => {
    // TODO: id, actor, action, resource_id, after_state, checksum,
    //        created_at (UPDATE/DELETE 금지 — Append-only)
  });
}
```

**Step 2**: 각 테이블의 쓰기 경로 확인
```
| 테이블 | 쓰는 주체 | 언제 |
|---|---|---|
| user_nft_holdings | EventConsumer | NFTIssued 이벤트 처리 시 |
| processed_events | EventConsumer | 이벤트 처리 전 멱등성 기록 시 |
| mint_requests | VaspService | 요청 생성 + 상태 전이 시 |
| audit_log | 모든 서비스 | 중요 행위 발생 시마다 |
```

### ✅ 답안

```typescript
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_nft_holdings', (t) => {
    t.string('user_id').notNullable();
    t.string('token_id').notNullable();
    t.integer('amount').notNullable().defaultTo(0);
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.primary(['user_id', 'token_id']);
  });

  await knex.schema.createTable('processed_events', (t) => {
    t.increments('id');
    t.string('tx_hash').notNullable();
    t.integer('log_index').notNullable();
    t.string('event_type').notNullable();
    t.jsonb('payload');
    t.timestamp('processed_at').defaultTo(knex.fn.now());
    t.unique(['tx_hash', 'log_index']); // 멱등성 핵심
  });

  await knex.schema.createTable('mint_requests', (t) => {
    t.uuid('id').primary();
    t.string('user_id').notNullable();
    t.string('token_id').notNullable();
    t.integer('amount').notNullable();
    t.string('status').notNullable().defaultTo('REQUESTED');
    t.string('tx_hash');
    t.string('failure_reason');
    t.string('gas_price');
    t.integer('nonce');
    t.timestamps(true, true);
    t.index(['status', 'created_at']); // pollStaleRequests 인덱스
  });

  await knex.schema.createTable('audit_log', (t) => {
    t.increments('id');
    t.string('actor').notNullable();
    t.string('action').notNullable();
    t.string('resource_id');
    t.jsonb('after_state');
    t.string('checksum').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    // UPDATE/DELETE 없음 — 원장 레벨에서 강제
  });
}
```

### ✅ 완료 기준
- [ ] 4개 테이블 마이그레이션 완성
- [ ] UNIQUE 제약 + 인덱스 설계

---

## S24: 원장 일관성 보장 — 상태 전이 가드와 멱등 이벤트 처리 (강의 20분 + 실습 35분)

### 강의

**상태머신 전이 가드:**
- `VALID_TRANSITIONS` 맵 (M3 S13에서 정의한 것과 동일)
- 허용 안 된 전이 즉시 예외

**이벤트 중복 처리 방지:**
- 동일 온체인 이벤트 두 번 처리 시 holdings +2
- `ON CONFLICT DO NOTHING`으로 DB 레벨 차단

### 🔴 실습 (35분) — 수강생 직접 작성

**Step 1**: transitionMintRequest 구현
```typescript
// internal/packages/ledger/src/LedgerService.ts
// TODO: 상태 전이 가드 포함 구현

async transitionMintRequest(
  id: string,
  toStatus: TxStatus,
  trx?: Knex.Transaction,
): Promise<void> {
  const db = trx ?? this.db;
  const request = await db('mint_requests').where({ id }).first();

  if (!request) throw new Error(`Request not found: ${id}`);

  // TODO: VALID_TRANSITIONS 확인 → 허용 안 된 전이 예외
  // TODO: 허용된 전이 → DB 업데이트
}
```

**Step 2**: recordProcessedEvent 구현 (멱등 삽입)
```typescript
// TODO: 중복 시 스킵, 처리 성공/스킵 반환

async recordProcessedEvent(
  txHash: string,
  logIndex: number,
  eventType: string,
  payload: unknown,
): Promise<boolean> {
  // TODO: INSERT INTO processed_events ... ON CONFLICT DO NOTHING
  // 반환: true = 신규 처리 / false = 이미 처리됨 (스킵)
}
```

**Step 3**: 테스트
```typescript
// 중복 txHash+logIndex 테스트
it('동일 txHash+logIndex 2회 → 1회만 반영', async () => {
  const result1 = await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', {});
  const result2 = await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', {});
  
  // TODO: result1 = true (신규), result2 = false (스킵)
});

// 허용 안 된 전이 테스트
it('FAILED → CONFIRMED 전이 → 예외', async () => {
  // TODO: FAILED 상태로 설정 후 CONFIRMED 전이 시도 → throw
});
```

### ✅ 답안

```typescript
// transitionMintRequest 완성
async transitionMintRequest(id: string, toStatus: TxStatus, trx?: Knex.Transaction): Promise<void> {
  const db = trx ?? this.db;
  const request = await db('mint_requests').where({ id }).first();
  if (!request) throw new Error(`Request not found: ${id}`);

  const allowed = VALID_TRANSITIONS[request.status as TxStatus] ?? [];
  if (!allowed.includes(toStatus)) {
    throw new Error(`Invalid transition: ${request.status} → ${toStatus} for ${id}`);
  }

  await db('mint_requests').where({ id }).update({
    status: toStatus,
    updated_at: new Date(),
  });
}

// recordProcessedEvent 완성
async recordProcessedEvent(
  txHash: string,
  logIndex: number,
  eventType: string,
  payload: unknown,
): Promise<boolean> {
  const inserted = await this.db('processed_events')
    .insert({ tx_hash: txHash, log_index: logIndex, event_type: eventType, payload })
    .onConflict(['tx_hash', 'log_index'])
    .ignore();

  return inserted.rowCount > 0; // true = 신규, false = 중복 스킵
}
```

### ✅ 완료 기준
- [ ] 동일 txHash+logIndex 2회 → 1회만 반영
- [ ] 허용 안 된 전이 → 예외
