# M3 S21 — VASP 이중 채널 동기화 아키텍처 설계

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S21 · 강의 55분  
> 대상: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`

---

## S21 — 이중 채널 동기화 아키텍처 설계 원리

> **강의 55분** — 이론 중심 세션. 실습 없음.

### 1. 단일 콜백 방식의 취약점

```
흐름: VASP TX 완료 → VASP가 Webhook 콜백 → DMZ WebhookReceiver
                                                    ↓
                                              ConsumerGroupWorker
                                                    ↓
                                              상태 갱신

문제 1: 콜백 1회 유실
  VASP Webhook 전송 → 네트워크 순단
  → 콜백 DMZ에 도달 안 됨
  → 재전송 정책이 없는 VASP → 영구 PENDING

문제 2: WebhookReceiver 처리 실패
  콜백 수신 → Redis XADD 실패
  → ConsumerGroupWorker 처리 못 함
  → XAUTOCLAIM도 소용없음 (처음부터 Stream에 안 들어감)

문제 3: VASP 자체 장애
  TX는 완료됐지만 VASP 콜백 발신 시스템 장애
  → 콜백 영구 미발신
```

### 2. 이중 채널 설계

```
채널 A: 콜백 (Push 방식)
  VASP → Webhook → ConsumerGroupWorker
  ✅ 장점: 빠름 (TX 완료 즉시)
  ❌ 단점: 유실 가능, VASP 재전송 정책 의존

채널 B: 폴링 (Pull 방식)
  pollStaleRequests (크론 5분 간격)
  → PENDING 30분 초과 건 직접 VASP API 조회
  ✅ 장점: 확실 (직접 조회)
  ❌ 단점: 느림 (최대 35분 지연)

두 채널 상호 보완:
  콜백 성공 → 폴링 시 이미 CONFIRMED → 멱등성에 의해 무시 (추가 비용 없음)
  콜백 실패 → 폴링에서 늦게 처리 → 최대 35분 지연이지만 반드시 처리됨
```

**왜 30분 타임아웃 기준인가:**

```
VASP SLA: 정상 처리 시간 평균 2~10분
30분 기준 = 10분 × 3 (충분한 여유) = 오탐 방지
너무 짧으면 (5분): 정상 처리 중 TX를 TIMEOUT으로 오탐
너무 길면 (2시간): 진짜 stuck TX 감지 지연 → 사용자 불만
```

### 3. 콜백 누락 경로 전체 분석

```
경로 1: 네트워크 유실
  VASP → [인터넷] → DMZ
  유실 지점: 방화벽, NAT, 일시적 네트워크 오류

경로 2: VASP 재전송 정책 없음
  일부 VASP: 1회 전송 후 실패 무시
  → SLA 계약 시 반드시 재전송 정책 확인 (몇 회, 어떤 Backoff)

경로 3: WebhookReceiver 처리 실패
  수신은 했으나 → Redis XADD 실패
  → HTTP 202 응답 전에 실패 → VASP는 성공으로 간주
  → Stream에 미적재 → ConsumerGroupWorker 처리 불가

경로 4: Consumer 장애
  Stream 적재 성공 → Consumer 크래시
  → XAUTOCLAIM으로 복구 가능 (M2에서 배움)
  → 이 경로는 At-least-once + XAUTOCLAIM이 커버

경로 1~3: 폴링 채널이 커버
경로 4: XAUTOCLAIM이 커버
```

### 4. pollStaleRequests 알고리즘 설계

```
1. DB 조회: status = 'PENDING' AND createdAt < now - 30분
2. 조회 결과 건별:
   a. vasp.getStatus(txHash) 직접 호출
   b. 결과별 전이:
      'confirmed'  → handleConfirmed(requestId)
      'failed'     → handleFailed(requestId, revertReason)
      'not_found'  → handleFailed(requestId, 'tx not found in mempool')
      'pending'    → 계속 대기 (업데이트 없음)
      'mined'      → handleMined(requestId, blockNumber)
3. processed 건수 반환
4. 크론으로 5분 간격 실행
```

**폴링 대상 선별 원칙 — 왜 PENDING 30분 초과만인가:**

```
전체 PENDING 조회 시:
  초당 수십 건의 신규 PENDING
  → 5분마다 전체 조회 → DB 부하 폭발

30분 초과만 조회:
  "아직 정상 처리 범위"에 있는 TX는 건드리지 않음
  콜백 채널이 처리할 것으로 기대
  30분 넘어야 폴링이 개입
```

### 5. 이중 채널 실제 운영 흐름

```
정상 케이스 (콜백 성공):
  t=0:    submitMintRequest → PENDING
  t=3분:  VASP 콜백 수신 → CONFIRMED
  t=35분: pollStaleRequests 실행 → 이미 CONFIRMED → skip (멱등성)
  
콜백 누락 케이스:
  t=0:    submitMintRequest → PENDING
  t=3분:  VASP 콜백 유실
  t=30분: pollStaleRequests 실행 → PENDING 30분 초과 감지
  t=30분: vasp.getStatus() → 'confirmed' → CONFIRMED 전이
  
최악 케이스 (VASP 장애):
  t=0:    submitMintRequest → PENDING
  t=30분: pollStaleRequests → vasp.getStatus() → 'not_found'
  t=30분: FAILED 전이 + 운영팀 알림
```

### 6. ConsumerGroupWorker와의 연계 (M2 복습)

```
S22 pollStaleRequests 결과 → 상태 전이
     ↓
TxStateMachineService.handleConfirmed()
     ↓
(이후 연계) LedgerService 트리거 이벤트 발행
     ↓
Redis Stream에 XADD
     ↓
ConsumerGroupWorker (M2에서 구현)
     ↓
NFTIssuedProcessor.process()
     ↓
IdempotencyGuard + DB 트랜잭션
     ↓
user_nft_holdings +1
```

**완료 기준:**
- [ ] 이중 채널 (콜백 + 폴링) 필요성 설명 가능
- [ ] 콜백 누락 시나리오 3가지 나열 (네트워크 유실 / VASP 재전송 없음 / WebhookReceiver 실패)
- [ ] pollStaleRequests 알고리즘 설계 (조회 조건 + 결과별 전이) 설명 가능
