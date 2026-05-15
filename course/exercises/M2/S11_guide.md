# S11 실습 가이드 — Dead Letter Queue 운영 패턴

```bash
npm run exercise:s11
```

---

## 사전 준비

프로젝트 루트 `.env`에 Redis URL을 설정하세요.

```
REDIS_URL=호스트:포트
REDIS_PASSWORD=비밀번호
```

---

## 실습 구조

| Part | 내용 | 수정 여부 |
|------|------|-----------|
| Part 1 | 3가지 실패 시나리오 DLQ 적재 (`move()`) | 수정 불필요 |
| Part 2 | `listPending()`으로 DLQ 조회 | 수정 불필요 |
| Part 3 | **TODO ① · ②** — 분류 함수 + 처리 루프 구현 | **학생 구현** |
| Part 4 | 처리 결과 검증 + 재투입 필드 확인 | 수정 불필요 |

---

## TODO ① — `classifyItem()` 구현

`item.reason` 문자열을 보고 `'requeue' | 'drop' | 'hold'` 중 하나를 반환합니다.

| reason 키워드 | 판단 | 이유 |
|--------------|------|------|
| `'timeout'` 포함 | **requeue** | 일시적 장애, VASP 복구됨 |
| `'parse error'` 포함 | **hold** | 코드 버그 → 수정 후 재판단 |
| `'permanently'` 포함 | **drop** | KYC 영구 거부 → 재시도 무의미 |

---

## TODO ② — 처리 루프 구현

```typescript
if (action === 'requeue') {
  const { newMessageId } = await dlqHandler.requeueMessage(item.messageId);
  console.log(`  ↩  REQUEUE ... → newMessageId=${newMessageId}`);
} else if (action === 'drop') {
  await dlqHandler.drop(item.messageId);
  console.log(`  🗑  DROP   ...`);
}
```

---

## 기대 출력 (Part 3)

```
  ⏸  HOLD   [NFT_ISSUED] userId=user-001 → 코드 수정 후 재판단 필요
  ↩  REQUEUE [NFT_ISSUED] userId=user-002 → newMessageId=17...
  🗑  DROP   [NFT_ISSUED] userId=user-003 → 영구 삭제 (KYC 영구 거부)
```

## 기대 출력 (Part 4)

```
  DLQ 잔류: 1건 (기대: 1 — HOLD만 남음)
  ✅ 검증 완료

  재투입된 메시지 (kyobo:exercise:s11):
  ┌─ 17...
  │  [비즈니스] eventType   = NFT_ISSUED
  │  [비즈니스] userId      = user-002
  │  [비즈니스] tokenId     = 42
  │  [비즈니스] txHash      = 0xabc123def456
  │  [추적메타] _requeuedFrom = <원본 dlqId>
  │  [추적메타] _requeuedAt   = 2026-...
  └─
```

`_reason` / `_failedAt` 등 DLQ 전용 필드는 제거되고, 비즈니스 필드만 재투입됩니다.

---

## Redis CLI 직접 확인

```bash
redis-cli -u "$REDIS_URL"

> XRANGE kyobo:exercise:s11:dlq - +   # DLQ 잔류 확인
> XRANGE kyobo:exercise:s11 - +        # 재투입된 메시지 확인
```

---

## 완료 기준

- [ ] `classifyItem()`: timeout → requeue, permanently → drop, parse error → hold 반환
- [ ] `requeueMessage()` 호출 후 `newMessageId` 출력
- [ ] `drop()` 호출 후 DLQ에서 제거
- [ ] Part 4: DLQ 잔류 1건 (HOLD만), 재투입 메시지에 `_requeuedFrom` 포함 확인
- [ ] 아래를 말로 설명 가능:

```
move()           → DLQ에 비즈니스 필드 + _reason/_failedAt 등 인프라 메타 저장
requeueMessage() → _ 메타 제거 → 비즈니스 필드 + _requeuedFrom/_requeuedAt 재투입
drop()           → DLQ에서 영구 삭제 (원 스트림 재투입 없음)
```
