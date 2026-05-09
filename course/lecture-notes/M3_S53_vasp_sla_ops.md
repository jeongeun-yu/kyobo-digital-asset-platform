# M3 S53 — VASP SLA 운영 · 월렛원 장애 에스컬레이션과 TX Stuck 모니터링

> 모듈 3 · 세션 53 · 1시간 `운영`  
> 전제: S13 TxStateMachineService 구현 완료, S17 RetryHandler 운영 중  
> 스켈레톤: `dmz/packages/vasp/src/admin/VASPMonitorService.ts`

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.

> **Phase 1 의존성 맥락**  
> Phase 1에서 TX 실행(서명·브로드캐스트·온체인 확정)은 전적으로 월렛원(VASP)에 위탁된다.  
> 따라서 VASP SLA 장애는 교보 시스템의 NFT 발행 파이프라인 전체에 직접 영향을 준다.  
> - 월렛원 가용성 저하 → `submitTransaction()` 실패 → TX PENDING 체류 급증  
> - 월렛원 Webhook 지연 → `handleMined()` 미호출 → SUBMITTED 상태 고착  
> Phase 3에서 직접 Custody로 전환하면 SLA 의존 대상이 외부 VASP에서 자체 인프라(RPC 노드, HSM)로 바뀐다.

> ⚠️ **운영 세션** — S13~S22에서 TX 상태머신·재시도·복구 코드를 구현했다. 이번 세션은 **그 코드가 실제로 동작 중일 때 운영자가 무엇을 보고, 언제 행동하는가**다. "월렛원이 느려졌다"는 알림을 받은 운영자가 L1~L4 중 어디서 멈출지 판단하는 것이 핵심이다.

---

## 강의 파트 (30분)

### 1. VASP SLA란 무엇인가 — 계약서에서 확인해야 할 항목 (10분)

SLA(Service Level Agreement)는 월렛원이 우리에게 보장하는 서비스 수준 계약이다. 수치가 없으면 장애 시 책임 소재가 불명확해진다.

#### 확인해야 할 SLA 항목

```
가용성 (Availability)
  → "월 기준 99.9% = 월 43분 다운 허용"
  → 99.95% = 월 22분
  → 측정 기준: HTTP 200 응답 비율? 아니면 핵심 API 기준?

응답시간 (Latency)
  → p50 / p95 / p99 각각 명시되어 있는가
  → "평균 응답시간 500ms"는 의미 없음 — p99 3초가 숨어있을 수 있음
  → 우리 서비스 TIMEOUT 설정 기준이 이 수치에서 나와야 함

장애 복구 목표 (RTO / RPO)
  → RTO (Recovery Time Objective): 장애 인지 후 서비스 복구까지 목표 시간
  → RPO (Recovery Point Objective): 데이터 손실 허용 범위
  → 월렛원 RTO 4시간이면 → 우리 시스템이 4시간 동안 대기 가능한 구조인지 확인

페널티 조항
  → SLA 위반 시 크레딧 지급 비율 (예: 가용성 99% 미달 시 월 요금 10% 환급)
  → 위반 기록을 우리가 직접 수집해야 청구 가능 (월렛원 데이터만 믿으면 안 됨)
```

#### S17 RetryHandler와 SLA의 연결

```
S17에서 설정한 TIMEOUT 값:
  retryConfig.timeoutMs = 30_000   // 30초

이 값의 근거:
  월렛원 SLA p99 응답시간 × 안전 여유
  예) p99 = 10s → timeoutMs = 30s (3배 여유)

SLA p99가 변경되면 → timeoutMs도 재검토 대상
SLA 문서 없이 임의로 설정하면 → 오탐(정상인데 타임아웃) 또는 미탐(느린데 통과)
```

---

### 2. TX Stuck 패턴 — 왜 발생하고 어떻게 감지하는가 (10분)

"TX Stuck"이란 `mint_requests` 테이블에서 PENDING 상태가 비정상적으로 오래 지속되는 건이다.

#### Stuck 발생 시나리오 3가지

```
시나리오 1 — VASP 처리 지연
  SUBMITTED → 월렛원 내부 처리 → 블록 채굴
  정상: 2~5분
  이상: 30분+ (월렛원 내부 큐 밀림, 네트워크 혼잡)
  감지: PENDING 상태 30분 초과 건 집계

시나리오 2 — Gas 부족으로 mempool 정체
  TX가 mempool에 들어갔으나 Gas Price 낮음
  → 채굴자가 선택 안 함 → 무기한 대기
  감지: getReceipt(txHash) = null이 30분 이상 지속
  조치: S22에서 구현한 gas bump 또는 TIMEOUT 전이

시나리오 3 — 콜백 누락 + 폴링도 못 받음
  S18 Webhook 콜백: 미수신
  S22 pollStaleRequests: getReceipt null 반복 (RPC 장애)
  결과: DB는 SUBMITTED, 실제로는 처리됐거나 실패
  감지: SUBMITTED 상태 30분 초과 건 (더 심각)
```

#### 감지 쿼리

```sql
-- 30분 초과 PENDING/SUBMITTED 건 조회
SELECT
  id, request_id, tx_hash, status,
  EXTRACT(EPOCH FROM (NOW() - updated_at)) / 60 AS pending_minutes,
  user_id, token_id, amount
FROM mint_requests
WHERE status IN ('PENDING', 'SUBMITTED')
  AND updated_at < NOW() - INTERVAL '30 minutes'
ORDER BY pending_minutes DESC;
```

```
Stuck 건수별 의미:
  0건   → 정상
  1~3건 → VASP 일시 지연 또는 개별 TX 문제
  10건+ → VASP 처리 지연 또는 시스템 전반 문제 가능성
  30건+ → 대규모 장애, 즉시 에스컬레이션
```

---

### 3. 에스컬레이션 절차 L1~L4 + Circuit Breaker 운영 (10분)

#### 에스컬레이션 트리

```
┌─────────────────────────────────────────────────────────┐
│  VASP 장애 감지 시 에스컬레이션 흐름                     │
│                                                          │
│  Stuck 발생 감지 (모니터링 알림)                         │
│          │                                               │
│          ▼                                               │
│  L1 — 자동 대응 (코드가 처리)                            │
│    RetryHandler 지수 백오프 재시도 중                    │
│    Circuit Breaker 상태 확인                             │
│    5분 내 자연 해소되면 → 종료                           │
│          │ 5분 후에도 Stuck 지속                         │
│          ▼                                               │
│  L2 — 담당자 알림 (운영자 개입)                          │
│    Slack/Teams 알림 발송                                 │
│    /admin/vasp/stuck 조회 → 원인 파악                    │
│    /admin/vasp/health → VASP 응답시간 확인               │
│    월렛원 상태 페이지 확인 (status.walletone.kr 등)      │
│          │ 30분 후에도 미해소                            │
│          ▼                                               │
│  L3 — 월렛원 기술지원 접수                               │
│    월렛원 장애 신고 티켓 접수                            │
│    SLA 위반 기록 시작 (시각, 영향 건수, 증상)            │
│    Circuit Breaker 수동 OPEN 전환 검토                   │
│          │ 2시간 후에도 미해소 또는 서비스 전면 영향      │
│          ▼                                               │
│  L4 — 경영진 보고 + 대체 VASP 전환 검토                 │
│    장애 현황 요약 보고 (영향 고객 수, 미처리 건수)       │
│    대체 VASP 전환 판단 (계약·기술 검토 후)               │
└─────────────────────────────────────────────────────────┘
```

#### Circuit Breaker 운영 — S17 구현의 운영 측면

S17에서 `RetryHandler`가 Circuit Breaker 역할을 한다 (연속 실패 N회 → 요청 차단). 운영자가 개입할 지점:

```
Circuit Breaker 상태:
  CLOSED  → 정상. 요청 통과, 실패 카운트 집계 중
  OPEN    → 장애. 모든 요청 즉시 차단, 주기적 HALF_OPEN 시도
  HALF_OPEN → 회복 중. 소수 요청만 통과해서 성공하면 CLOSED 복귀

운영자 개입이 필요한 경우:
  ① OPEN이 30분 이상 지속 → 월렛원이 아직 미복구
    → L3 에스컬레이션 (월렛원 기술지원 접수)

  ② OPEN인데 월렛원은 정상 → CB 임계값 설정 오류 가능성
    → /admin/vasp/circuitbreaker/reset 으로 수동 CLOSED 전환
    → 이후 정상 처리되는지 확인

  ③ HALF_OPEN에서 CLOSED 복귀 실패 반복
    → VASP가 간헐적 장애 → 임계값 조정 검토
```

#### 대체 VASP 전환 판단 기준

```
전환 검토 조건 (L4 판단):
  □ VASP 다운타임 > RTO 초과 (계약서 기준)
  □ Stuck 누적 건수 > 100건 이상
  □ 월렛원 공식 복구 예상 시간 미제시

전환 시 고려사항:
  □ S14 IVASPAdapter 교체로 기술적 전환은 가능
  □ 단, 계약·법적 절차 먼저 (임의 전환 계약 위반 가능)
  □ 전환 중 발생한 TX는 두 VASP에 중복 요청 금지 → requestId 격리 필수
```

---

## 실습 파트 (25분)

### 실습 1 — TX Stuck 모니터링 엔드포인트 (10분)

```typescript
// dmz/packages/vasp/src/admin/VASPMonitorService.ts

export interface StuckTx {
  id: string;
  requestId: string;
  txHash: string | null;
  status: 'SUBMITTED' | 'PENDING';
  pendingMinutes: number;
  userId: string;
  tokenId: string;
  amount: string;
}

export class VASPMonitorService {
  constructor(
    private readonly db: Database,
    private readonly vaspClient: IVASPClient,
    private readonly notifier: NotifierAdapter,
  ) {}

  async getStuckTxs(thresholdMinutes = 30): Promise<StuckTx[]> {
    const rows = await this.db.query<StuckTx>(
      `SELECT
         id, request_id, tx_hash, status, user_id, token_id, amount,
         EXTRACT(EPOCH FROM (NOW() - updated_at)) / 60 AS pending_minutes
       FROM mint_requests
       WHERE status IN ('PENDING', 'SUBMITTED')
         AND updated_at < NOW() - INTERVAL '${thresholdMinutes} minutes'
       ORDER BY pending_minutes DESC`,
    );
    return rows.rows;
  }

  async checkAndAlert(): Promise<void> {
    const stuck = await this.getStuckTxs(30);

    if (stuck.length === 0) return;

    const severity = stuck.length >= 30 ? 'P1'
                   : stuck.length >= 10 ? 'P2'
                   : 'P3';

    await this.notifier.sendAlert({
      title: `TX Stuck 감지 — ${stuck.length}건 PENDING 30분 초과`,
      severity,
      body: [
        `SUBMITTED: ${stuck.filter(t => t.status === 'SUBMITTED').length}건`,
        `PENDING  : ${stuck.filter(t => t.status === 'PENDING').length}건`,
        `최장 대기 : ${Math.round(stuck[0]?.pendingMinutes ?? 0)}분`,
        `조회: GET /admin/vasp/stuck`,
      ].join('\n'),
      metadata: { stuckCount: stuck.length },
    });
  }
}
```

라우터 등록:

```typescript
// admin/router.ts

router.get('/admin/vasp/stuck', async (req, res) => {
  const threshold = Number(req.query.threshold) || 30;
  const stuck = await vaspMonitor.getStuckTxs(threshold);
  res.json({ count: stuck.length, items: stuck });
});
```

테스트:

```bash
# 전체 조회 (기본 30분 임계값)
curl http://localhost:3000/admin/vasp/stuck

# 임계값 조정 (15분)
curl "http://localhost:3000/admin/vasp/stuck?threshold=15"
```

기대 응답:

```json
{
  "count": 3,
  "items": [
    {
      "id": "abc-123",
      "requestId": "req-xyz",
      "txHash": "0xabc...",
      "status": "PENDING",
      "pendingMinutes": 47.3,
      "userId": "user-001",
      "tokenId": "1001",
      "amount": "1"
    }
  ]
}
```

---

### 실습 2 — VASP 헬스체크 엔드포인트 (8분)

```typescript
// VASPMonitorService.ts 추가

export interface VASPHealth {
  available: boolean;
  responseTimeMs: number | null;   // null = 연결 실패
  checkedAt: Date;
  stuckCount: number;
  circuitBreakerStatus: 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'UNKNOWN';
}

async getHealth(): Promise<VASPHealth> {
  const start = Date.now();
  let available = false;
  let responseTimeMs: number | null = null;

  try {
    // VASP의 healthcheck 또는 가벼운 조회 API 호출
    await this.vaspClient.ping();
    responseTimeMs = Date.now() - start;
    available = true;
  } catch {
    responseTimeMs = null;
    available = false;
  }

  const [stuck, cbStatus] = await Promise.all([
    this.getStuckTxs(30),
    this.getCircuitBreakerStatus(),
  ]);

  return {
    available,
    responseTimeMs,
    checkedAt: new Date(),
    stuckCount: stuck.length,
    circuitBreakerStatus: cbStatus,
  };
}

private async getCircuitBreakerStatus(): Promise<VASPHealth['circuitBreakerStatus']> {
  // S17 RetryHandler가 Circuit Breaker 상태를 expose하면 조회
  // 구현에 따라 Redis 키 조회 또는 인메모리 상태 반환
  try {
    return await this.vaspClient.getCircuitBreakerState();
  } catch {
    return 'UNKNOWN';
  }
}
```

```typescript
// router.ts

router.get('/admin/vasp/health', async (req, res) => {
  const health = await vaspMonitor.getHealth();
  const statusCode = health.available ? 200 : 503;
  res.status(statusCode).json(health);
});
```

테스트:

```bash
curl http://localhost:3000/admin/vasp/health
```

정상 응답 (200):

```json
{
  "available": true,
  "responseTimeMs": 234,
  "checkedAt": "2026-05-04T01:30:00.000Z",
  "stuckCount": 0,
  "circuitBreakerStatus": "CLOSED"
}
```

장애 시 응답 (503):

```json
{
  "available": false,
  "responseTimeMs": null,
  "checkedAt": "2026-05-04T01:30:00.000Z",
  "stuckCount": 14,
  "circuitBreakerStatus": "OPEN"
}
```

---

### 실습 3 — 에스컬레이션 알림 트리거 cron 등록 (7분)

```typescript
// dmz/packages/vasp/src/admin/index.ts

// 5분마다 Stuck TX 체크 → 임계값 초과 시 자동 알림
cron.schedule('*/5 * * * *', async () => {
  await vaspMonitor.checkAndAlert();
});

// SLA 위반 기록 — 매시간 가용성 집계
cron.schedule('0 * * * *', async () => {
  const health = await vaspMonitor.getHealth();

  await db.query(
    `INSERT INTO vasp_sla_log (checked_at, available, response_time_ms, stuck_count)
     VALUES ($1, $2, $3, $4)`,
    [health.checkedAt, health.available, health.responseTimeMs, health.stuckCount],
  );
});
```

SLA 위반 집계 쿼리 (월말 페널티 청구 근거):

```typescript
// GET /admin/vasp/sla-report?from=2026-05-01&to=2026-05-31

router.get('/admin/vasp/sla-report', async (req, res) => {
  const { from, to } = req.query;

  const rows = await db.query(
    `SELECT
       COUNT(*) AS total_checks,
       SUM(CASE WHEN available THEN 1 ELSE 0 END) AS available_checks,
       ROUND(AVG(response_time_ms) FILTER (WHERE available)) AS avg_response_ms,
       PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY response_time_ms)
         FILTER (WHERE available) AS p99_response_ms,
       SUM(CASE WHEN NOT available THEN 1 ELSE 0 END) AS downtime_checks
     FROM vasp_sla_log
     WHERE checked_at BETWEEN $1 AND $2`,
    [from, to],
  );

  const r = rows.rows[0];
  const availabilityPct = (Number(r.available_checks) / Number(r.total_checks) * 100).toFixed(3);

  res.json({
    period: { from, to },
    availabilityPct,       // 99.850% 형태
    avgResponseMs: r.avg_response_ms,
    p99ResponseMs: r.p99_response_ms,
    downtimeChecks: r.downtime_checks,
    slaBreached: Number(availabilityPct) < 99.9,   // 계약 기준 99.9%
  });
});
```

---

## 완료 기준

- [ ] `GET /admin/vasp/stuck` — PENDING 30분 초과 목록 반환, threshold 파라미터 동작
- [ ] `GET /admin/vasp/health` — available·responseTimeMs·stuckCount·circuitBreakerStatus 포함
- [ ] VASP 연결 실패 시 `/admin/vasp/health` → 503 + `available: false` 반환 확인
- [ ] Stuck 건수 임계값(10건, 30건)별 P2/P1 알림 발송 확인
- [ ] 5분 cron — Stuck 체크 + 알림 트리거 동작 확인
- [ ] `GET /admin/vasp/sla-report` — 기간별 가용성 % 집계 동작

---

### 운영 체크리스트 — VASP 장애 알림 수신 시

```
□ /admin/vasp/health 조회 → available / responseTimeMs / CB 상태 파악
□ /admin/vasp/stuck 조회 → Stuck 건수·최장 대기 시간 파악

□ L1 — 자동 대응 확인 (5분 대기)
    RetryHandler 재시도 중인지 로그 확인
    5분 내 Stuck 건수 감소 추세 → 관찰 계속

□ L2 — 담당자 개입 (Stuck 5분 이상 지속)
    월렛원 상태 페이지 확인
    responseTimeMs 이상 여부 (/admin/vasp/health)
    CB OPEN이면 → 월렛원 장애 가능성

□ L3 — 월렛원 기술지원 접수 (30분 미해소)
    장애 티켓 접수 + SLA 위반 기록 시작
    CB 수동 리셋 검토 (/admin/vasp/circuitbreaker/reset)

□ L4 — 경영진 보고 (2시간 미해소)
    영향 고객 수 + 미처리 건수 집계
    대체 VASP 전환 법적·계약 검토 시작

□ 복구 후
    Stuck 건수 0 확인
    복구된 TX → pollStaleRequests가 자동 처리하는지 확인
    SLA 위반 기록 → 페널티 청구 여부 검토
```

---

## 워크시트

### VASP 장애 대응 워크시트

> 장애 알림 수신 시 이 시트를 순서대로 채운다.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VASP 장애 대응 시트
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[1단계: 초기 상태 확인]
  수신 시각: ____________________
  알림 내용: ____________________________________________

  GET /admin/vasp/health 결과:
    available          : ( ) true  ( ) false
    responseTimeMs     : ____  ms  (SLA p99 기준: ____ ms)
    stuckCount         : ____ 건
    circuitBreakerStatus: ( ) CLOSED  ( ) OPEN  ( ) HALF_OPEN

  GET /admin/vasp/stuck 결과:
    SUBMITTED 30분 초과: ____ 건
    PENDING 30분 초과  : ____ 건
    최장 대기           : ____ 분  (txHash: ____________________)

[2단계: 에스컬레이션 레벨 판정]
  현재 레벨 (해당 항목에 V):
  ( ) L1 — 자동 대응 중 (5분 대기)
  ( ) L2 — 담당자 개입 필요 (Stuck 5분+ 지속)
  ( ) L3 — 월렛원 기술지원 접수 (30분 미해소)
  ( ) L4 — 경영진 보고 (2시간 미해소)

[3단계: 원인 파악]
  월렛원 상태 페이지 확인: ( ) 장애 공지 있음  ( ) 없음
  CircuitBreaker 열린 시각: ____________________
  영향받는 이벤트 타입   : ____________________
  Stuck TX 중 txHash 있는 건: ____ 건 (채굴됐을 가능성)
  Stuck TX 중 txHash 없는 건: ____ 건 (전송 자체 실패)

[4단계: 조치 실행]
  실행 시각: ____________________
  실행자  : ____________________

  실행 내용:
  ( ) 관찰 계속 (L1)                            __:__
  ( ) 월렛원 상태 페이지 공유                    __:__
  ( ) CB 수동 리셋 시도                          __:__
  ( ) 월렛원 장애 티켓 접수  티켓 번호: ________ __:__
  ( ) SLA 위반 기록 시작                         __:__
  ( ) 경영진 보고                                __:__
  ( ) 대체 VASP 전환 검토 착수                   __:__

[5단계: SLA 위반 기록]  ← L3 이상 시 필수
  장애 시작 시각  : ____________________
  장애 종료 시각  : ____________________
  총 다운타임     : ____ 분
  영향 건수       : ____ 건 (미처리 mint_requests)
  SLA 기준 위반 여부: ( ) 위반  ( ) 미위반
  페널티 청구 예정: ( ) 예  ( ) 아니오

[6단계: 복구 확인]
  복구 시각: ____________________
  /admin/vasp/health → available: true 확인: ( ) 완료
  Stuck 건수 → 0 확인: ( ) 완료
  pollStaleRequests 자동 처리 확인: ( ) 완료 (__건 처리됨)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### 에스컬레이션 레벨 판단 카드

```
┌──────────────────────────────────────────────────────────┐
│  L1 → L2 전환 기준                                        │
│                                                           │
│  다음 중 하나라도 해당하면 L2로 이동:                     │
│  □ Stuck 건수가 5분 후에도 감소하지 않음                  │
│  □ responseTimeMs > SLA p99의 2배 이상                   │
│  □ circuitBreakerStatus = OPEN                           │
│  □ available = false                                     │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  L2 → L3 전환 기준                                        │
│                                                           │
│  □ L2 조치 후 30분 경과, 미해소                           │
│  □ Stuck 건수 10건 이상                                   │
│  □ 월렛원 상태 페이지에 장애 공지 없음 (자체 인지 못함)  │
│  □ SLA RTO 절반 경과                                     │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  L3 → L4 전환 기준                                        │
│                                                           │
│  □ 월렛원 기술지원 접수 후 2시간 경과, 미해소             │
│  □ Stuck 건수 30건 이상                                   │
│  □ 월렛원 복구 예상 시간 미제시                           │
│  □ SLA RTO 초과 확정                                      │
└──────────────────────────────────────────────────────────┘
```

---

### 월간 SLA 리뷰 시트

> 매월 말 `/admin/vasp/sla-report`로 집계 후 이 시트 작성.  
> 페널티 청구 또는 VASP 재계약 협상의 근거 자료.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
월간 VASP SLA 리뷰 — ____년 __월
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[가용성]
  실측 가용성      : _______ %
  SLA 계약 기준    : _______ %
  위반 여부        : ( ) 위반  ( ) 준수
  총 다운타임      : _____ 분  (허용: _____ 분)

[응답시간]
  실측 p99         : _____ ms
  SLA 계약 기준    : _____ ms
  위반 여부        : ( ) 위반  ( ) 준수

[장애 이력]
  총 L3+ 에스컬레이션: ____ 건
  최장 단일 장애     : ____ 분  발생일: ____
  Stuck 총 발생 건수 : ____ 건

[페널티]
  청구 대상 여부   : ( ) 예  ( ) 아니오
  청구 금액 추정   : __________ 원
  청구 근거 URL    : /admin/vasp/sla-report?from=____&to=____

[재계약 검토]
  현재 계약 만료일 : ____________________
  SLA 조정 요청 항목:
  □ ___________________________________
  □ ___________________________________
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 자동화 확장 — VASPIncidentService

> 위 워크시트의 디지털 버전. S51의 `IncidentService`를 VASP 장애에 특화해 확장한다.

### 설계 원칙

```
자동 수집 가능                   운영자 판단 필요
──────────────────────           ───────────────────────
/admin/vasp/health 스냅샷        에스컬레이션 레벨 결정
Stuck TX 목록                    월렛원 티켓 번호
CB 상태                          SLA 위반 인정 여부
장애 감지 시각                   대체 VASP 전환 결정
```

### 구현

```typescript
// dmz/packages/vasp/src/admin/VASPIncidentService.ts

export type EscalationLevel = 'L1' | 'L2' | 'L3' | 'L4';

export interface VASPIncident {
  id: string;
  status: 'OPEN' | 'INVESTIGATING' | 'RESOLVED';
  detectedAt: Date;
  resolvedAt?: Date;
  currentLevel: EscalationLevel;

  // 자동 스냅샷
  snapshot: {
    health: VASPHealth;
    stuckTxs: StuckTx[];
  };

  // 레벨별 에스컬레이션 기록
  escalations: Array<{
    at: Date;
    fromLevel: EscalationLevel;
    toLevel: EscalationLevel;
    operator: string;
    note: string;
  }>;

  // SLA 위반 기록
  slaViolation?: {
    startedAt: Date;
    endedAt?: Date;
    downtimeMinutes?: number;
    affectedTxCount: number;
  };

  walletoneTicketId?: string;
  resolutionNote?: string;
}

export class VASPIncidentService {
  constructor(
    private readonly db: Database,
    private readonly vaspMonitor: VASPMonitorService,
    private readonly notifier: NotifierAdapter,
  ) {}

  async create(detectedBy: string): Promise<VASPIncident> {
    const [health, stuckTxs] = await Promise.all([
      this.vaspMonitor.getHealth(),
      this.vaspMonitor.getStuckTxs(30),
    ]);

    const incident: VASPIncident = {
      id: crypto.randomUUID(),
      status: 'OPEN',
      detectedAt: new Date(),
      currentLevel: 'L1',
      snapshot: { health, stuckTxs },
      escalations: [],
    };

    await this.db.query(
      `INSERT INTO vasp_incidents
         (id, status, detected_at, current_level, snapshot, escalations)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [incident.id, incident.status, incident.detectedAt,
       incident.currentLevel, JSON.stringify(incident.snapshot),
       JSON.stringify(incident.escalations)],
    );

    await this.notifier.sendIncidentAlert(incident as unknown as Incident);
    return incident;
  }

  async escalate(
    incidentId: string,
    toLevel: EscalationLevel,
    operator: string,
    note: string,
    walletoneTicketId?: string,
  ): Promise<void> {
    const current = await this.getIncident(incidentId);
    const entry = {
      at: new Date(),
      fromLevel: current.currentLevel,
      toLevel,
      operator,
      note,
    };

    await this.db.query(
      `UPDATE vasp_incidents
       SET current_level     = $1,
           escalations       = escalations || $2::jsonb,
           walletone_ticket_id = COALESCE($3, walletone_ticket_id),
           status            = 'INVESTIGATING'
       WHERE id = $4`,
      [toLevel, JSON.stringify([entry]), walletoneTicketId ?? null, incidentId],
    );

    // L3 이상이면 SLA 위반 기록 시작
    if (toLevel === 'L3' || toLevel === 'L4') {
      await this.startSLAViolationTracking(incidentId, current.snapshot.stuckTxs.length);
    }

    await this.notifier.sendAlert({
      title: `VASP 인시던트 ${toLevel} 에스컬레이션`,
      severity: toLevel === 'L4' ? 'P1' : toLevel === 'L3' ? 'P1' : 'P2',
      body: `${entry.fromLevel} → ${toLevel}\n${note}`,
      metadata: { incidentId, operator },
    });
  }

  private async startSLAViolationTracking(incidentId: string, affectedTxCount: number): Promise<void> {
    await this.db.query(
      `UPDATE vasp_incidents
       SET sla_violation = jsonb_build_object(
         'startedAt', NOW(),
         'affectedTxCount', $1
       )
       WHERE id = $2 AND sla_violation IS NULL`,
      [affectedTxCount, incidentId],
    );
  }

  async resolve(incidentId: string, operator: string, note: string): Promise<void> {
    const resolvedAt = new Date();

    await this.db.query(
      `UPDATE vasp_incidents
       SET status          = 'RESOLVED',
           resolved_at     = $1,
           resolution_note = $2,
           sla_violation   = CASE
             WHEN sla_violation IS NOT NULL THEN
               jsonb_set(
                 jsonb_set(sla_violation, '{endedAt}', to_jsonb($1::text)),
                 '{downtimeMinutes}',
                 to_jsonb(
                   EXTRACT(EPOCH FROM ($1 - (sla_violation->>'startedAt')::timestamptz)) / 60
                 )
               )
             ELSE sla_violation
           END
       WHERE id = $3`,
      [resolvedAt, note, incidentId],
    );

    await this.notifier.sendIncidentResolved(incidentId, note);
  }

  private async getIncident(incidentId: string): Promise<VASPIncident> {
    const row = await this.db.query(
      `SELECT * FROM vasp_incidents WHERE id = $1`,
      [incidentId],
    );
    if (!row.rows.length) throw new Error(`인시던트 없음: ${incidentId}`);
    return row.rows[0] as VASPIncident;
  }
}
```

### API 엔드포인트

```typescript
// VASP 인시던트 생성 (장애 감지 시)
router.post('/admin/vasp/incidents', async (req, res) => {
  const { detectedBy } = req.body;
  const incident = await vaspIncidentService.create(detectedBy);
  res.json(incident);
});

// 에스컬레이션
router.post('/admin/vasp/incidents/:id/escalate', async (req, res) => {
  const { toLevel, operator, note, walletoneTicketId } = req.body;
  await vaspIncidentService.escalate(
    req.params.id, toLevel, operator, note, walletoneTicketId,
  );
  res.json({ ok: true });
});

// 종료
router.post('/admin/vasp/incidents/:id/resolve', async (req, res) => {
  const { operator, note } = req.body;
  await vaspIncidentService.resolve(req.params.id, operator, note);
  res.json({ ok: true });
});
```

### 사용 흐름 (워크시트 대응)

```
[워크시트 1단계: 초기 상태 확인]
  → POST /admin/vasp/incidents { detectedBy: 'monitor-bot' }
    응답에 health + stuckTxs 자동 스냅샷

[워크시트 2~4단계: 레벨 판정 + 조치]
  → POST /admin/vasp/incidents/:id/escalate
    { toLevel: 'L3', operator: 'kim@kyobo.com',
      note: '30분 미해소, 월렛원 티켓 접수',
      walletoneTicketId: 'WO-2026-0504-001' }

[워크시트 5단계: SLA 위반 기록]
  → L3 escalate 시 sla_violation 자동 시작
  → resolve 시 downtimeMinutes 자동 계산

[월간 SLA 리뷰]
  → GET /admin/vasp/sla-report + vasp_incidents 조회로 자동 집계
```

### 아날로그 워크시트 → 디지털 대응 요약

| 아날로그 (워크시트) | 디지털 (API/서비스) | 자동화 여부 |
|---|---|---|
| 초기 상태 확인 빈칸 | `POST /admin/vasp/incidents` 응답 `snapshot` | ✅ 자동 |
| Stuck TX 건수 | `snapshot.stuckTxs.length` | ✅ 자동 |
| CB 상태 확인 | `snapshot.health.circuitBreakerStatus` | ✅ 자동 |
| 에스컬레이션 레벨 기록 | `POST /admin/vasp/incidents/:id/escalate` | 운영자 입력 |
| SLA 위반 시작 시각 | `L3 escalate` 시 자동 기록 | ✅ 자동 |
| 다운타임 계산 | `resolve` 시 자동 계산 | ✅ 자동 |
| 월간 SLA 집계 | `GET /admin/vasp/sla-report` | ✅ 자동 |
| 알림 채널 | `NOTIFIER_TYPE` 환경변수 | 환경변수 1개 |
