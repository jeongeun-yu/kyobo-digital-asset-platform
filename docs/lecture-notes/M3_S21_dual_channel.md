# M3 S21 — VASP 이중 채널 동기화 아키텍처 설계

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S21 · 강의 55분  
> 대상: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`

---

## S21 — 이중 채널 동기화 아키텍처 설계 원리

> **강의 55분** — 이론 중심 세션. 실습 없음.

---

### 0. 이론 — 분산 시스템에서 "상태 동기화"가 왜 어려운가

#### 0-1. 두 시스템 간 상태 동기화 문제

```
우리 시스템:  mint_requests.status = 'PENDING'
VASP 시스템:  TX 내부 상태 = 'confirmed'

두 시스템이 동시에 같은 상태를 유지하는 것은 불가능하다.
어느 순간에는 한쪽이 뒤처진다 (Eventual Consistency).

문제: VASP가 TX를 완료했을 때, 우리 DB가 그것을 언제 알 수 있는가?
```

**두 가지 동기화 전략:**

```
  Push (이벤트 기반)                  Pull (폴링 기반)
  ─────────────────                   ────────────────
  VASP가 완료 즉시 알림               우리가 주기적으로 물어봄

  VASP ──[Webhook]──▶ 우리 시스템     우리 ──[API 요청]──▶ VASP
                                              ◀──[응답]────

  장점: 즉시성 (초~분 단위)           장점: 신뢰성 (우리가 제어)
  단점: VASP 장애 시 유실 가능        단점: 지연 (폴링 주기 = 최대 지연)

  ─────────────────────────────────────────────────────────
  핵심 통찰: 어느 하나만으로는 충분하지 않다
  Push 단독: 유실 시 복구 불가
  Pull 단독: 수백만 건 조회 → DB/VASP API 부하

  해결: 두 채널을 결합 → 각자의 단점을 상호 보완
```

---

#### 0-2. 비유 — 택배 수령과 문자 알림

```
시나리오: 온라인 쇼핑몰에서 상품을 주문했다.

Push 채널 (콜백):
  배송 완료 → 택배회사가 "배송 완료" 문자 발송
  → 대부분의 경우 즉시 알 수 있음
  → 문제: 문자 발송 실패 시 소비자가 모름

Pull 채널 (폴링):
  소비자가 주기적으로 앱에서 배송 현황 확인
  → 문자가 안 와도 앱을 보면 알 수 있음
  → 문제: 확인 주기만큼 지연 (1시간마다 확인하면 최대 1시간 지연)

이중 채널:
  문자 오면 → 즉시 앎 (Push)
  문자 안 오면 → 앱 확인으로 나중에 앎 (Pull)

  = 결국 반드시 알게 됨 (Eventual Consistency 보장)
```

---

#### 0-3. 전체 아키텍처 — 이중 채널 전체 그림

```
┌─────────────────────────────────────────────────────────────────┐
│  VASP TX 완료                                                    │
│    │                                                             │
│    ├──[채널 A: Webhook Push]──────────────────────────────────▶ │
│    │                         WebhookReceiver                     │
│    │                              │                              │
│    │                         Redis XADD                          │
│    │                              │                              │
│    │                         ConsumerGroupWorker                 │
│    │                              │                              │
│    │                         handleConfirmed()                   │
│    │                              │                              │
│    │                         DB: CONFIRMED ✅                    │
│    │                                                             │
│    └──[채널 B: 폴링 Pull 5분 크론]                              │
│                                                                  │
│    pollStaleRequests()                                           │
│         │                                                        │
│    PENDING 30분 초과 건 조회                                     │
│         │                                                        │
│    vasp.getStatus(txHash) ──────────────────────────────────▶   │
│         │                  ◀──────────────────────────────────   │
│    결과별 전이                                                   │
│    confirmed → handleConfirmed()                                 │
│    failed    → handleFailed()                                    │
│    not_found → handleFailed()                                    │
│    pending   → 대기                                              │
└─────────────────────────────────────────────────────────────────┘

  채널 A 성공: 채널 B 실행 시 이미 CONFIRMED → findPendingOlderThan에서 제외 → skip
  채널 A 실패: 채널 B가 늦게 처리 (최대 30분+5분 = 35분 지연)
```

---

#### 0-4. 멱등성이 이중 채널을 가능하게 한다

```
채널 A가 먼저 CONFIRMED 처리하고, 채널 B도 동일 TX를 조회했을 때:

  잘못된 설계 (멱등성 없음):
    채널 B: vasp.getStatus() → 'confirmed'
    → handleConfirmed() 재호출
    → DB: user_nft_holdings +1 (중복!)
    → NFT 이중 발행 사고

  올바른 설계 (멱등성 있음):
    채널 B: findPendingOlderThan()
    → status = 'CONFIRMED' (이미 처리됨)
    → 조회 결과에서 제외 (PENDING이 아니므로)
    → handleConfirmed() 호출 안 됨 ✅

  핵심: "PENDING 30분 초과"라는 조건이 자연스러운 멱등성 필터
  채널 A가 처리하면 PENDING이 아니게 됨 → 채널 B 조회 대상에서 자동 제외
```

---

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
  t=3분:  VASP 콜백 수신 → MINED
  t=15분: PoS finality 확보 → FINALIZED → 원장 업데이트 → CONFIRMED
  t=35분: pollStaleRequests 실행 → 이미 CONFIRMED → skip (멱등성)
  
콜백 누락 케이스:
  t=0:    submitMintRequest → PENDING
  t=3분:  VASP 콜백 유실
  t=30분: pollStaleRequests 실행 → PENDING 30분 초과 감지
  t=30분: vasp.getStatus() → 'confirmed' → FINALIZED 전이 (PoS finality 확보 기준)
  
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
- [ ] 이중 채널 필요성 — 콜백(빠름, 유실 가능) + 폴링(느림, 확실) 역할 구분 설명
- [ ] 콜백 누락 4가지 경로 설명 (네트워크 유실 / VASP 재전송 없음 / WebhookReceiver 실패 / Consumer 장애)
- [ ] 30분 타임아웃 기준 근거 설명 — 너무 짧으면 오탐, 너무 길면 감지 지연
- [ ] pollStaleRequests 결과별 전이 설계 — confirmed/failed/not_found/pending/mined 각각
- [ ] 콜백 성공 후 폴링이 중복 처리하지 않는 이유 (PENDING이 아니므로 findPendingOlderThan에서 제외)
- [ ] WebhookReceiver 실패(경로 3)가 XAUTOCLAIM으로 커버되지 않는 이유 설명
