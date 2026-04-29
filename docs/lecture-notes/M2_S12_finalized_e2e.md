# M2 S12 — Finalized 블록 기준 처리와 파이프라인 장애 복원력 검증

> Block B — DMZ 이벤트 파이프라인 · M2 S12 · 강의 55분  
> 대상: `dmz/packages/event-engine/src/dmz/ConsumerGroupWorker.ts`, `dmz/packages/event-engine/src/dmz/DLQHandler.ts`

---

## 1. 왜 Finalized 블록 기준인가

**블록 확정 단계:**

```
PENDING    → 아직 마이닝 안 됨
CONFIRMED  → 마이닝됨, but Reorg 가능
FINALIZED  → PoS Checkpoint 통과, 절대 불변
```

**Reorg(체인 재편)가 일어나면:**

```
블록 #100에 NFT 발행 TX 포함
→ 원장 업데이트 완료
→ 체인 재편: 블록 #100이 고아 블록(Orphan)이 됨
→ TX가 없던 일이 됨
→ 원장에는 NFT 발행 기록이 남음 (불일치)
```

Finalized 이전에 처리하면 Reorg로 인한 데이터 불일치가 발생할 수 있다.

**Ethereum PoS Finality:**

```
블록 생성 → 2 epochs(약 12분) 후 Finalized
eth_subscribe('newFinalizedBlock') — 전용(Private) RPC에서만 지원
```

## 2. Finalized 체크 로직

```typescript
// EventProcessor.process() 내부에서 Finalized 체크
async process(message: StreamMessage): Promise<void> {
  const event = JSON.parse(message.fields['payload'] ?? '{}') as NFTIssuedEvent;

  // Finalized 체크
  const finalizedBlock = await this.adapter.getFinalizedBlockNumber();
  if (event.blockNumber > finalizedBlock) {
    // 아직 Finalized 안 됨 → XACK 안 함 → 다음 폴링에서 재처리
    console.log(
      `[Consumer] 블록 ${event.blockNumber} 아직 Finalized 안 됨` +
      ` (현재 Finalized: ${finalizedBlock})`
    );
    return;
  }

  // Finalized 확인 → 이하 정상 처리
  const idempotencyKey = `NFTIssued:${event.txHash}:${event.logIndex}`;
  await this.idempotencyGuard.run(idempotencyKey, async () => {
    // ...
  });
}
```

**주의:** `return`만 하고 XACK를 호출하지 않는다.  
→ PEL에 잔류 → 다음 폴링 주기에 `_reclaimPending()`이 재수신  
→ Finalized가 되면 그 때 처리

## 3. Consumer 장애 복구 실습 시나리오

**시나리오:**

```
1. ConsumerGroupWorker 실행 중
2. 메시지 XREADGROUP으로 소유 (PEL 등록)
3. 처리 중 Ctrl+C (강제 종료)
4. XACK 안 됨 → PEL에 메시지 잔류
5. 30초 경과 (minIdleMs)
6. Consumer 재시작
7. _reclaimPending() → XAUTOCLAIM으로 재수신
8. 정상 처리 + XACK
```

**CLI로 확인:**

```bash
# 1. PEL 상태 확인
redis-cli XPENDING kyobo:events issuer-consumers - + 10
# 결과: 메시지 ID, Consumer 이름, idle 시간, 전달 횟수

# 2. XAUTOCLAIM으로 강제 재수신 (idle 0ms = 즉시)
redis-cli XAUTOCLAIM kyobo:events issuer-consumers consumer-1 0 0-0 COUNT 10
# 결과: 재수신된 메시지 목록

# 3. PEL 비어있음 확인 (처리 완료 후)
redis-cli XPENDING kyobo:events issuer-consumers - + 10
# 결과: (empty list or set)
```

## 4. M2 전체 E2E 흐름 검증

```
VASP (외부) → WebhookServer(DMZ)
→ IdempotencyGuard (중복 차단)
→ RedisStreamPublisher → kyobo:events Stream
→ ConsumerGroupWorker → NFTIssuedProcessor
→ LedgerService (DB 트랜잭션)
→ XACK
```

**E2E 실행 스크립트:**

```bash
# Step 1: HMAC 서명 생성
BODY='{"eventType":"NFTIssued","txHash":"0xabc123","logIndex":0,"tokenId":1001,"to":"0xAlice"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "test-secret-key" | awk '{print $2}')

# Step 2: Webhook 전송
curl -s -w "\n%{http_code}" \
  -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Kyobo-Signature: $SIG" \
  -d "$BODY"
# 기대: 202

# Step 3: Stream 메시지 확인
redis-cli XRANGE kyobo:events - + COUNT 5
# 기대: NFTIssued 메시지 1건

# Step 4: Consumer 처리 대기 (~1초)
sleep 2

# Step 5: 원장 확인
# psql -c "SELECT user_id, token_id, amount FROM user_nft_holdings WHERE user_id = '0xAlice';"
# 기대: 0xAlice | 1001 | 1

# Step 6: PEL 비어있음 확인
redis-cli XPENDING kyobo:events issuer-consumers - + 10
# 기대: (empty)

# Step 7: 동일 이벤트 재전송 (멱등성 확인)
curl -s -w "\n%{http_code}" \
  -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Kyobo-Signature: $SIG" \
  -d "$BODY"
# 기대: 202 (but amount는 여전히 1)

sleep 2
# psql → amount = 1 (중복 처리 안 됨)
```

**각 단계별 확인 포인트:**

| 단계 | 확인 방법 | 기대값 |
|------|----------|--------|
| Webhook 수신 | HTTP 응답 코드 | 202 |
| HMAC 검증 실패 | 잘못된 서명 전송 → | 401 |
| Stream 적재 | XRANGE | 메시지 1건 |
| 멱등성 (Webhook) | requestId 동일 재전송 → | 202 but Stream에 추가 안 됨 |
| Consumer 처리 | XPENDING | empty |
| 원장 업데이트 | user_nft_holdings | amount = 1 |
| 멱등성 (Consumer) | 동일 이벤트 재처리 → | amount 변화 없음 |

## 5. M2 모듈 완료 기준 체크리스트

- [ ] **At-least-once + 멱등성**: 동일 이벤트 2회 → 원장 1회만 반영
- [ ] **장애 복구**: Consumer 강제 종료 → 재시작 후 미ACK 메시지 자동 재수신
- [ ] **DLQ**: 3회 실패 → DLQ 이동 + 알림
- [ ] **Finalized 체크**: Finalized 미확정 이벤트 → 처리 보류 (XACK 안 함)
- [ ] **E2E**: Webhook 수신 → Stream 적재 → Consumer 처리 → 원장 업데이트 1건 완주
- [ ] **수평 확장**: Consumer 2개 동시 실행 → 메시지 중복 처리 없음

---

## 핵심 정리

```
M2 DMZ 이벤트 파이프라인의 신뢰성 3원칙:

1. At-least-once + 멱등성
   "최소 1회 처리 보장 + 중복 발행 차단"
   → DB unique constraint + ON CONFLICT DO NOTHING

2. PEL + XAUTOCLAIM
   "Consumer 장애 시 미처리 메시지 자동 복구"
   → XACK를 마지막 단계로 → PEL에 잔류 → 재수신

3. DLQ + 알림
   "3회 실패 메시지 격리 + 운영자 개입 유도"
   → 무한 재시도 대신 격리 → 원인 파악 → 수동 재큐잉
```

**다음 모듈 (M3 S13~S17):**  
온체인 어댑터 계층 — EVMAdapter, ChainEventListener, TxStateMachineService  
오프체인 처리가 끝났으니 이제 온체인에서 이벤트가 어떻게 올라오는지 배운다.
