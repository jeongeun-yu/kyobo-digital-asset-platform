# M3 S21 — VASP 이중 채널 동기화 아키텍처 설계

> **[Phase 1 — 아키텍처 설계]** 이중 채널(Push + 블록체인 직접 구독) 설계 원리를 다룹니다.  
> **Phase 1 구현:** 채널 A(VASP Webhook → Redis → NFTIssuedProcessor)와 채널 B(ChainEventListener → IssuanceConfirmHandler)가 Phase 1부터 동시 가동됩니다.  
> **안전망:** `pollStaleRequests()`는 두 채널 모두 실패한 극단적 케이스에 대한 최후 보완입니다.

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S21 · 강의 55분  
> 대상: `internal/packages/vasp/src/tx/TxStateMachineService.ts`

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

Pull 채널 (직접 확인):
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
│  블록체인 TX 확정 (VASP 처리 완료)                               │
│    │                                                             │
│    ├──[채널 A: Webhook Push]──────────────────────────────────▶ │
│    │                         VASP → NFT_ISSUED Webhook           │
│    │                              │                              │
│    │                         WebhookPublishHandler               │
│    │                              │                              │
│    │                         Redis Stream (kyobo:events)         │
│    │                              │                              │
│    │                         ConsumerGroupPool                   │
│    │                              │                              │
│    │                         NFTIssuedProcessor                  │
│    │                              │                              │
│    │                         LedgerService.creditNFT()           │
│    │                         user_nft_holdings ✅                │
│    │                                                             │
│    └──[채널 B: ChainEventListener]──────────────────────────▶  │
│          ┌─ 재시작 시: queryEvents(lastBlock, curBlock)           │
│          │             missed event 일괄 복구                     │
│          ├─ 실시간:    subscribeEvents('Issued')                  │
│          └──────────────────────┐                                │
│                              _dispatch()                         │
│                              → IssuanceConfirmHandler.handle()   │
│                              → txStateMachine.handleMined()      │
│                              → txStateMachine.handleConfirmed()  │
│                              → TxTransitionBridge                │
│                              → LedgerService.updateMintRequest() │
│                              DB: MINED → CONFIRMED ✅            │
└─────────────────────────────────────────────────────────────────┘

  채널 A 성공: 채널 B 이벤트 수신 시 IssuanceConfirmHandler에서
              status CONFIRMED 확인 → skip (멱등성)
  채널 A 실패: 채널 B가 블록체인 Issued 이벤트 직접 감지 → 수 분 내 처리

  ※ pollStaleRequests() — 별도 안전망 (채널 A·B 모두 실패한 극단적 케이스)
     PENDING 10분(STALE_MINUTES) 초과 건에 한해 vasp.getStatus(txHash) 직접 조회
     (크론 주기는 호출자 설정 — Phase 1 현재 index.ts에 미등록)
```

---

#### 0-4. 멱등성이 이중 채널을 가능하게 한다

```
채널 A가 먼저 처리하고, 채널 B도 동일 TX의 Issued 이벤트를 수신했을 때:

  잘못된 설계 (멱등성 없음):
    채널 B: IssuanceConfirmHandler.handle() 호출
    → handleConfirmed() 재호출
    → user_nft_holdings +1 (중복!)
    → NFT 이중 발행 사고

  올바른 설계 (멱등성 있음) — IssuanceConfirmHandler 내부 guard:
    채널 B: txRepo.findByTxHash(event.txHash)
    → status = 'CONFIRMED' (이미 처리됨)
    → if (status === 'CONFIRMED' || status === 'FINALIZED') return;  ← skip ✅

  pollStaleRequests의 멱등성은 별도 메커니즘:
    findPendingOlderThan() → PENDING인 건만 조회
    채널 A·B가 처리하면 PENDING이 아니게 됨 → 조회 결과에서 자동 제외
```

---

### 1. 단일 콜백 방식의 취약점

```
흐름: VASP TX 완료 → VASP가 Webhook 콜백 → 내부망 WebhookReceiver
                                                    ↓
                                              ConsumerGroupWorker
                                                    ↓
                                              상태 갱신

문제 1: 콜백 1회 유실
  VASP Webhook 전송 → 네트워크 순단
  → 콜백 내부망에 도달 안 됨
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
채널 A: Webhook Push (정상 경로)
  VASP → NFT_ISSUED Webhook → WebhookPublishHandler → Redis Stream
  → ConsumerGroupPool → NFTIssuedProcessor → LedgerService.creditNFT()
  ✅ 장점: 빠름 (TX 완료 즉시), Redis at-least-once 보장
  ❌ 단점: VASP Webhook 유실 시 누락 가능

채널 B: ChainEventListener (블록체인 직접 구독, 폴백 경로)
  재시작 시: queryEvents(lastBlock, curBlock) — missed event 일괄 복구
  실시간:    subscribeEvents('Issued') — 이벤트 수신
  → IssuanceConfirmHandler → TxStateMachine → TxTransitionBridge
  → LedgerService.updateMintRequest() (Redis 미경유, 직접 호출)
  ✅ 장점: VASP 의존 없음, 블록체인 원장이 진실의 원천
  ❌ 단점: 노드 연결 장애 시 이벤트 누락 가능, 재시작 시 queryEvents 필요

두 채널 상호 보완:
  채널 A 성공 → 채널 B도 Issued 이벤트 수신 → IssuanceConfirmHandler에서 CONFIRMED 확인 → skip
  채널 A 실패 → 채널 B가 블록체인에서 직접 감지 → 수 분 내 처리

안전망: pollStaleRequests (채널 A·B 모두 실패 시)
  PENDING 10분 초과 건에 한해 vasp.getStatus() 직접 조회
  → 최대 10분+ 크론 주기 지연이지만 반드시 처리
```

**왜 10분 타임아웃 기준인가:**

```
이더리움 PoS 블록 확정 시간: ~5분 (25블록 × 12초)
10분 = 확정 시간 × 2배 안전 마진

10분이 지나도 PENDING이면:
  → 블록체인상으로는 이미 확정됐거나 완전히 실패한 TX
  → 채널 A(Webhook)·채널 B(ChainEventListener) 모두 누락한 비정상 상태
  → pollStaleRequests 개입 시점

너무 짧으면 (2분): 블록 확정 전 TX를 오탐 → gas bump 남발
너무 길면 (30분): 이미 확정된 TX를 20분 이상 방치 → 사용자 불만
```

### 3. 콜백 누락 경로 전체 분석

```
경로 1: 네트워크 유실
  VASP → [인터넷] → DMZ Nginx → 내부망
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

경로 1~3: 채널 B(ChainEventListener)가 1차 커버 (Issued 이벤트 직접 감지)
          → 채널 B도 실패 시: pollStaleRequests가 최후 보완
경로 4: XAUTOCLAIM이 커버
```

### 4. pollStaleRequests 알고리즘 설계

```
1. DB 조회: status = 'PENDING' AND createdAt < now - 10분
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

**폴링 대상 선별 원칙 — 왜 PENDING 10분 초과만인가:**

```
전체 PENDING 조회 시:
  초당 수십 건의 신규 PENDING
  → 전체 조회 → DB 부하 폭발

10분 초과만 조회:
  이더리움 블록 확정(~5분) × 2배 = 10분
  10분 이내 TX는 채널 A·B가 정상 처리할 것으로 기대
  10분 넘어야 "채널 A·B 모두 놓쳤다" 판단 → pollStaleRequests 개입
```

### 5. 이중 채널 실제 운영 흐름

```
정상 케이스 (채널 A 성공):
  t=0:    submitMintRequest → PENDING
  t=3분:  VASP TX 완료 → NFT_ISSUED Webhook → Redis → NFTIssuedProcessor → creditNFT ✅
  t=3분:  채널 B도 Issued 이벤트 수신 → IssuanceConfirmHandler → CONFIRMED 확인 → skip

채널 A 누락 케이스 (Webhook 유실):
  t=0:    submitMintRequest → PENDING
  t=3분:  VASP TX 완료 → Webhook 유실 (채널 A 실패)
  t=5분:  채널 B: Issued 이벤트 수신 → handleMined() → handleConfirmed()
          → TxTransitionBridge → LedgerService.updateMintRequest() CONFIRMED ✅
  t=10분: pollStaleRequests 실행 → 이미 CONFIRMED → skip (멱등성)

최악 케이스 (채널 A·B 모두 실패 — 노드 연결 장애 등):
  t=0:    submitMintRequest → PENDING
  t=10분: pollStaleRequests → vasp.getStatus() → 'confirmed' → handleConfirmed() ✅

VASP 장애 케이스:
  t=0:    submitMintRequest → PENDING
  t=10분: pollStaleRequests → vasp.getStatus() → 'not_found'
  t=10분: FAILED 전이 + 운영팀 알림
```

### 6. TxStateMachineService 전이 이후 흐름 (TxTransitionBridge)

```
채널 B 또는 pollStaleRequests → TxStateMachineService.handleConfirmed() 호출
     ↓
txStateMachine이 'transition' 이벤트 발행 (EventEmitter)
     ↓
TxTransitionBridge._handle() (transition 이벤트 구독자)
     ↓
  ┌─ LedgerService.updateMintRequest()    → mint_requests CONFIRMED
  └─ issuanceRepo.updateStatus()          → issuance_requests CONFIRMED

※ 채널 A 경로 (Webhook → NFTIssuedProcessor):
     NFTIssuedProcessor.process()
     → IdempotencyGuard.run()
     → LedgerService.creditNFT()          → user_nft_holdings 업데이트
```

---

### 7. 설계 의사결정 — 왜 이 구조로 만들었는가

#### 7-1. "폴링을 없애고 Webhook만 쓰면 안 되는가?"

```
Webhook 단독:
  VASP SLA: "Webhook 99.9% 전달 보장"
  의미: 1000건 중 1건은 유실 가능
  교보 NFT 발행 규모: 월 100만 건 목표
  → 월 1000건 유실 가능
  → 금융 자산 기록 누락 → 규제 위반

  추가 문제: VASP 자체 장애 시 Webhook 발신 불가
           (VASP 서버가 죽으면 Webhook을 보낼 수 없음)

결론: Webhook만으로는 100% 처리 보장 불가
```

#### 7-2. "ChainEventListener만 쓰고 Webhook을 없애면 안 되는가?"

```
ChainEventListener 단독:
  처리 경로: Issued 이벤트 → IssuanceConfirmHandler → TxTransitionBridge
  → mint_requests / issuance_requests 업데이트

  문제: NFTIssuedProcessor → creditNFT() 경로 없음
       → user_nft_holdings 미업데이트
       → 채널 A와 채널 B가 업데이트하는 테이블/메서드가 다름
       → 두 채널이 상호 보완 관계이지 완전한 대체 관계가 아님

결론: 두 채널은 역할이 다르므로 반드시 공존해야 함
```

#### 7-3. "왜 10분이 기준인가 — 다른 값은 안 되는가?"

```
이더리움 PoS 블록 확정 시간: ~5분 (25블록 × 12초)

10분 = 확정 시간 × 2배

10분이 지나도 PENDING = "블록에 포함됐거나 완전히 실패했는데
                          채널 A·B 모두 우리 DB에 반영 못 한 비정상 상태"
→ pollStaleRequests가 vasp.getStatus()로 직접 확인

너무 짧게 설정 (2분):
  블록 확정 전 TX를 오탐 → 불필요한 gas bump
  → 가스 낭비 + VASP 부하

너무 길게 설정 (30분):
  확정된 지 25분이 지나도록 방치
  → 사용자 경험 최악, 금융 서비스 기준 허용 불가

10분 = "오탐 최소화 + 확정 후 신속 감지" 균형점
→ 체인·VASP SLA가 바뀌면 재조정 필요
```

#### 7-4. "두 채널이 동시에 처리하면 중복 발행이 일어나지 않는가?"

```
우려: 채널 A와 채널 B가 동시에 처리
     → 원장 중복 업데이트 → NFT 이중 기록 🚨

채널 B의 멱등성 (IssuanceConfirmHandler 내부 guard):
  if (txReq.status === 'CONFIRMED' || txReq.status === 'FINALIZED') return;
  → 채널 A가 먼저 처리해 CONFIRMED가 됐으면 채널 B는 skip ✅

채널 A의 멱등성 (NFTIssuedProcessor):
  IdempotencyGuard.run(idempotencyKey, ...) — 동일 requestId 재처리 방지

pollStaleRequests의 멱등성:
  findPendingOlderThan() → PENDING인 건만 조회
  → 이미 처리된 건은 PENDING이 아니므로 조회 대상 자체에서 제외 ✅
```

---

### 8. 이중 채널 수신 경로 전체 아스키 다이어그램

```
블록체인 TX 확정
       │
  ┌────┴─────────────────────────────────────────────────┐
  │                                                       │
  ▼                                                       ▼
[채널 A: Webhook Push]               [채널 B: ChainEventListener]
VASP → NFT_ISSUED Webhook            ┌─ 재시작 시: queryEvents(lastBlock, curBlock)
       │                             │             missed event 일괄 복구
       ▼                             ├─ 실시간:    subscribeEvents('Issued')
WebhookPublishHandler                └──────────────────────┐
       │                                                     ▼
  Redis XADD 성공?                            _dispatch() → IssuanceConfirmHandler.handle()
  │           │                                             │
  ✅ 성공     ❌ 실패                          txRepo.findByTxHash(event.txHash)
  │           │                                             │
  ▼           ▼                               status 확인 (CONFIRMED이면 skip)
ConsumerGroupPool  [경로3 유실]                             │
       │           → 채널 B가 복구            txStateMachine.handleMined()
       ▼                                                    │
NFTIssuedProcessor                           txStateMachine.handleConfirmed()
  IdempotencyGuard.run()                                    │
       │                                      TxTransitionBridge._handle()
  LedgerService.creditNFT()                  │                        │
  user_nft_holdings 업데이트 ✅    LedgerService.updateMintRequest()  issuanceRepo.updateStatus()
                                  mint_requests CONFIRMED ✅           issuance_requests CONFIRMED ✅

[채널 A 성공 + 채널 B 이벤트 수신]:
  IssuanceConfirmHandler: status = CONFIRMED → skip → 중복 처리 없음 ✅

[별도 안전망] pollStaleRequests() — 채널 A·B 모두 실패 시
  PENDING 10분 초과 건 → vasp.getStatus(txHash) → 결과별 전이
  confirmed → handleConfirmed() / failed → handleFailed() / not_found → handleFailed()
  → TxTransitionBridge → LedgerService.updateMintRequest() + issuanceRepo.updateStatus()
```

---

### 9. 실습 설계 문제 — 이중 채널 판단 연습

아래 시나리오별로 채널 A / 채널 B / pollStaleRequests 중 어느 쪽이 처리하는지, 최종 상태는 무엇인지 판단한다.

```
시나리오 1:
  t=0:  submitMintRequest → PENDING (txHash=0xaaa)
  t=3분: VASP TX 완료 → NFT_ISSUED Webhook 수신 → Redis → NFTIssuedProcessor → creditNFT ✅
  t=4분: 채널 B: Issued 이벤트 수신
  t=35분: pollStaleRequests() 실행
  
  Q: 채널 B(t=4분)와 pollStaleRequests(t=35분)는 어떻게 동작하는가?
  A: ________

시나리오 2:
  t=0:  submitMintRequest → PENDING (txHash=0xbbb)
  t=3분: VASP TX 완료 → Webhook 전송 중 네트워크 유실 (채널 A 실패)
  t=5분: 채널 B: Issued 이벤트 수신
  
  Q: 최종 처리 주체와 상태는?
  A: ________

시나리오 3:
  t=0:  submitMintRequest → PENDING (txHash=0xccc)
  t=10분: pollStaleRequests() 실행 → vasp.getStatus() = 'not_found'
  
  Q: 최종 상태는? 왜 not_found인가?
  A: ________

시나리오 4:
  t=0:  submitMintRequest → PENDING (txHash=0xddd)
  t=5분: WebhookReceiver 수신 → Redis XADD 실패 → 채널 A 유실
  t=7분: 채널 B: Issued 이벤트 수신
  t=35분: pollStaleRequests() 실행
  
  Q: 최종 처리 주체는? pollStaleRequests는 어떻게 동작하는가?
  A: ________
```

**정답:**

```
시나리오 1:
  채널 B(t=4분): IssuanceConfirmHandler → status 미확인 가능성 있으나
               NFTIssuedProcessor가 creditNFT 완료 → mint_requests는 별도 경로
               채널 B는 TxTransitionBridge 경로로 updateMintRequest CONFIRMED
               pollStaleRequests(t=35분): status = CONFIRMED → findPendingOlderThan에서 제외 → skip

시나리오 2:
  채널 B가 처리. t=5분에 Issued 이벤트 수신 → handleMined() → handleConfirmed()
  → TxTransitionBridge → mint_requests CONFIRMED ✅
  채널 A가 없어도 채널 B만으로 수 분 내 처리 가능

시나리오 3:
  FAILED 전이. not_found = mempool에서 TX 드롭됨 (gas 너무 낮아 삭제)
  채널 B도 Issued 이벤트 없음 (TX가 블록에 포함되지 않았으므로)

시나리오 4:
  채널 B(t=7분)가 처리. → CONFIRMED ✅
  pollStaleRequests(t=35분): 이미 CONFIRMED → findPendingOlderThan에서 제외 → skip
  WebhookReceiver 실패(경로 3)는 XAUTOCLAIM 불가
  → Stream에 적재조차 안 됐으므로 XAUTOCLAIM이 복구할 대상 없음
  → 채널 B가 커버
```

---

**완료 기준:**
- [ ] 이중 채널 필요성 — 채널 A(빠름, VASP 의존) + 채널 B(블록체인 직접, VASP 독립) 역할 구분 설명
- [ ] 채널 A 경로: Webhook → WebhookPublishHandler → Redis → NFTIssuedProcessor → creditNFT
- [ ] 채널 B 경로: subscribeEvents/queryEvents → IssuanceConfirmHandler → TxStateMachine → TxTransitionBridge → updateMintRequest
- [ ] 콜백 누락 4가지 경로 설명 (네트워크 유실 / VASP 재전송 없음 / WebhookReceiver 실패 / Consumer 장애)
- [ ] 경로 1~3은 채널 B가 1차 커버, pollStaleRequests가 최후 보완
- [ ] 채널 B 멱등성: IssuanceConfirmHandler status guard (CONFIRMED/FINALIZED이면 skip)
- [ ] pollStaleRequests 멱등성: findPendingOlderThan (PENDING이 아닌 건 조회 자체에서 제외)
- [ ] 10분 타임아웃 기준 근거 설명 — 이더리움 확정 시간(~5분) × 2배, 너무 짧으면 오탐, 너무 길면 확정 후 방치
- [ ] pollStaleRequests 결과별 전이 설계 — confirmed/failed/not_found/pending/mined 각각
- [ ] WebhookReceiver 실패(경로 3)가 XAUTOCLAIM으로 커버되지 않는 이유 설명
- [ ] 시나리오 1~4 판단 문제 정답 설명
