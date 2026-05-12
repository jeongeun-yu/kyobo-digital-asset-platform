# M2 S52 — Consumer 장애 Runbook · 유형별 대응 절차와 모니터링 설계

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.

> 모듈 2 · 세션 52 · 1시간 `운영`  
> 전제: S10에서 ConsumerGroupWorker 구현 완료, S11에서 DLQHandler 운영 중  
> 스켈레톤: `internal/packages/event-engine/src/admin/ConsumerMonitorService.ts`

> ⚠️ **운영 세션** — Consumer가 **정상 동작하는 방법**은 S10에서 배웠다. 이번 세션은 **Consumer가 비정상일 때 운영자가 어떻게 대응하는가**다. 장애 유형별로 증상·원인·조치가 다르다. Runbook은 야간 장애에서 생각할 시간 없을 때 쓰는 문서다.

---

## 강의 파트 (30분)

### 1. Consumer 장애 4가지 유형 (15분)

Consumer 장애는 증상이 비슷해 보여도 원인과 조치가 완전히 다르다. 유형을 잘못 판단하면 조치가 역효과를 낸다.

#### 유형 1 — 프로세스 크래시

```
증상: Consumer 프로세스가 완전히 종료됨
     PM2 status → stopped 또는 errored
     메시지 처리 전면 중단

원인:
  - 처리되지 않은 예외 (unhandledRejection)
  - OOM (메모리 초과)
  - 외부 종료 시그널

즉각 조치:
  pm2 restart issuer-consumer
  → PM2 자동 재시작이 작동했는지 확인
  → PEL 재수신: 이전에 처리 중이던 메시지 자동 재수신

확인 포인트:
  pm2 logs issuer-consumer --lines 100  ← 크래시 직전 로그
  pm2 show issuer-consumer               ← 재시작 횟수 확인
```

**PEL 재수신이 왜 자동인가:**

```
Redis Streams 보장:
  XREADGROUP으로 가져간 메시지 → PEL(Pending Entry List)에 등록
  XACK 전에 Consumer 죽음 → PEL 잔류
  다음 Consumer가 XAUTOCLAIM으로 PEL 메시지 재수신
  → 중복 없이 재처리 (멱등성 덕분)
```

S10에서 구현한 `XAUTOCLAIM` 로직이 이 시나리오를 자동으로 처리한다.

---

#### 유형 2 — Consumer Lag 증가

```
증상: Consumer 프로세스는 살아있음
     처리 속도가 메시지 적재 속도를 따라가지 못함
     모니터링: pending_messages 수 지속 증가
     DLQ는 없음 (처리 중이지만 느린 것)

원인:
  - DB 슬로우 쿼리 (처리 중 DB 병목)
  - 외부 API(VASP) 응답 지연
  - Consumer 인스턴스 수 부족

조치 순서:
  1. DB 슬로우 쿼리 확인
     SELECT * FROM pg_stat_activity WHERE state = 'active' ORDER BY duration DESC;
  2. VASP 응답시간 확인
     GET /admin/vasp/health → p99 응답시간 확인
  3. 원인이 외부 서비스 지연이면:
     - Consumer 인스턴스 수평 확장 (별도 프로세스 추가)
  4. 원인이 DB 병목이면:
     - 슬로우 쿼리 최적화 (인덱스, 쿼리 수정)
     - DB 연결 풀 크기 조정
```

**Lag 임계값 기준:**

```
정상:   pending_messages < 50
주의:   50 ≤ pending_messages < 200  → 슬랙 알림
경고:   200 ≤ pending_messages < 500 → 담당자 확인 필요
긴급:   pending_messages ≥ 500       → 즉시 대응
```

---

#### 유형 3 — 멱등성 실패 반복

```
증상: 동일 메시지가 반복 처리 시도됨
     DLQ로 이동 후 requeue해도 또 DLQ 진입
     로그: "duplicate key value violates unique constraint"
     또는: "VALID_TRANSITIONS 위반"

원인:
  - Consumer 코드 버그 (상태 전이 로직 오류)
  - 멱등성 키 설계 오류 (txHash+logIndex가 실제로 중복 가능한 구조)
  - 외부 시스템이 같은 이벤트를 다른 ID로 두 번 발행

조치 순서:
  1. DLQ 메시지 원본 확인 (listPending)
  2. processed_events 테이블 조회 → 이미 처리된 이벤트인지 확인
  3. 이미 처리됨 → drop (원장 반영 완료, 재처리 불필요)
  4. 미처리 + 코드 버그 → 코드 수정 배포 → requeue
  5. 외부 시스템 중복 발행 → 발신 시스템 팀에 오류 통보
```

---

#### 유형 4 — Redis 연결 끊김

```
증상: Consumer 로그에 Redis 연결 오류 반복
     "Error: connect ECONNREFUSED" 또는 "ETIMEDOUT"
     메시지 처리 중단 (Redis 없이 처리 불가)

원인:
  - Redis 서버 다운 또는 재시작
  - 네트워크 파티션
  - Redis 메모리 초과 → maxmemory-policy로 연결 거부

확인 순서:
  redis-cli ping                          ← Redis 응답 확인
  redis-cli info memory | grep used_memory ← 메모리 사용량
  redis-cli info clients | grep connected  ← 연결 수

조치:
  1. Redis 서버 정상이면 → Consumer 재시작 (재연결 시도)
  2. Redis 메모리 초과 → 긴급: 불필요 키 정리 or Redis 메모리 확장
  3. Redis 서버 다운 → 인프라팀 에스컬레이션
```

---

### 2. 모니터링 지표 설계 (15분)

Consumer 장애의 **4가지 유형을 조기에 감지**하는 지표 세트:

```
┌─────────────────────┬──────────────────────┬──────────────┐
│ 지표                │ 감지 대상 장애         │ 임계값       │
├─────────────────────┼──────────────────────┼──────────────┤
│ pending_messages    │ Lag 증가 (유형2)      │ > 200 경고   │
│ consumer_process_up │ 프로세스 크래시 (유형1)│ = 0 즉시     │
│ dlq_count           │ 멱등성 실패 (유형3)   │ > 0 알림     │
│ redis_connected     │ Redis 끊김 (유형4)    │ = false 즉시 │
│ processing_rate     │ Lag 증가 보조 지표    │ < 10/s 주의  │
│ pel_size            │ 미ACK 메시지 누적     │ > 100 경고   │
└─────────────────────┴──────────────────────┴──────────────┘
```

#### pending_messages 계산 방법

```
Redis Streams에서 Consumer Group의 대기 메시지 수:
  XLEN kyobo:events                          ← 전체 스트림 길이
  - (XINFO GROUPS kyobo:events의 last-delivered-id 이후 count)
  
또는 더 직접적으로:
  XPENDING kyobo:events kyobo-consumer-group - + 1000
  → PEL(처리 중 + 미ACK) 수

운영에서 의미 있는 것은 "아직 처리 안 된 메시지 수"
  = 스트림 전체 길이 - Consumer Group이 읽은 수
```

---

## 실습 파트 (25분)

### 실습 1 — Consumer Lag 모니터링 엔드포인트 (15분)

```typescript
// internal/packages/event-engine/src/admin/ConsumerMonitorService.ts

export interface ConsumerStats {
  streamLength: number;        // 전체 스트림 메시지 수
  pendingMessages: number;     // 미처리 (Lag)
  pelSize: number;             // PEL: 처리 중이지만 미ACK
  dlqCount: number;            // DLQ 적재 수
  consumerCount: number;       // 활성 Consumer 수
  redisConnected: boolean;
}

export class ConsumerMonitorService {
  constructor(
    private readonly redis: RedisClient,
    private readonly dlqHandler: DLQHandler,
    private readonly streamKey = 'kyobo:events',
    private readonly groupName = 'kyobo-consumer-group',
  ) {}

  async getStats(): Promise<ConsumerStats> {
    const [streamInfo, groupInfo, dlqItems] = await Promise.all([
      this.redis.xlen(this.streamKey),
      this.redis.xInfoGroups(this.streamKey),
      this.dlqHandler.listPending(),
    ]);

    const group = groupInfo.find(g => g.name === this.groupName);
    const pendingMessages = group?.pending ?? 0;   // PEL 크기 = 처리 중 미ACK
    const pelSize = pendingMessages;

    // 전체 스트림 길이 - 그룹이 읽은 메시지 수 = 아직 읽지도 않은 메시지
    // 여기서는 PEL을 Lag의 대리 지표로 사용 (단순화)
    const redisConnected = await this.redis.ping().then(() => true).catch(() => false);

    return {
      streamLength:   streamInfo,
      pendingMessages,
      pelSize,
      dlqCount:       dlqItems.length,
      consumerCount:  group?.consumers ?? 0,
      redisConnected,
    };
  }

  async checkAlerts(stats: ConsumerStats): Promise<string[]> {
    const alerts: string[] = [];

    if (!stats.redisConnected)         alerts.push('P1: Redis 연결 끊김');
    if (stats.consumerCount === 0)     alerts.push('P1: Consumer 프로세스 없음 (크래시 의심)');
    if (stats.dlqCount > 0)            alerts.push(`P2: DLQ ${stats.dlqCount}건 적재`);
    if (stats.pendingMessages >= 500)  alerts.push(`P1: Consumer Lag 긴급 (${stats.pendingMessages}건)`);
    else if (stats.pendingMessages >= 200) alerts.push(`P2: Consumer Lag 경고 (${stats.pendingMessages}건)`);

    return alerts;
  }
}
```

라우터 연결:

```typescript
// admin/router.ts

router.get('/admin/queue/stats', async (req, res) => {
  const stats = await consumerMonitor.getStats();
  const alerts = await consumerMonitor.checkAlerts(stats);

  res.json({ stats, alerts });
});
```

테스트:

```bash
curl http://localhost:3000/admin/queue/stats
```

기대 응답:

```json
{
  "stats": {
    "streamLength": 1523,
    "pendingMessages": 12,
    "pelSize": 12,
    "dlqCount": 0,
    "consumerCount": 2,
    "redisConnected": true
  },
  "alerts": []
}
```

Consumer를 강제로 중단하면:

```json
{
  "stats": { "consumerCount": 0, ... },
  "alerts": ["P1: Consumer 프로세스 없음 (크래시 의심)"]
}
```

---

### 실습 2 — Runbook 문서 작성 (10분)

운영 문서는 코드만큼 중요하다. 야간 장애 시 판단력이 떨어진 상태에서 읽을 문서이므로 **단계별 체크리스트 형식**으로 작성한다.

아래 템플릿을 `docs/runbooks/consumer-incident-runbook.md`에 작성:

```markdown
# Consumer 장애 대응 Runbook

> 최종 수정: 2026-05-04 | 담당: 이벤트 파이프라인 팀

## 0. 먼저 확인할 것

\`\`\`bash
# 1. Consumer 프로세스 상태
pm2 status issuer-consumer

# 2. Consumer 지표 전체 조회
curl http://localhost:3000/admin/queue/stats

# 3. DLQ 현황
curl http://localhost:3000/admin/dlq/pending
\`\`\`

## 유형 1 — Consumer 프로세스 다운

**증상**: pm2 status → stopped / errored, 메시지 처리 전면 중단

\`\`\`bash
# 조치
pm2 restart issuer-consumer
pm2 logs issuer-consumer --lines 100  # 크래시 원인 확인

# 확인
curl http://localhost:3000/admin/queue/stats
# → consumerCount >= 1, redisConnected: true 확인
\`\`\`

**주의**: PEL 메시지는 XAUTOCLAIM으로 자동 재수신. 수동 재큐잉 불필요.

---

## 유형 2 — Consumer Lag 증가

**증상**: pendingMessages 200+, 프로세스는 살아있음

\`\`\`bash
# 원인 탐색 순서
# 1. VASP 지연 확인
curl http://localhost:3000/admin/vasp/health

# 2. DB 슬로우 쿼리 확인 (DB 접속 필요)
psql -c "SELECT pid, duration, query FROM pg_stat_activity 
         WHERE state='active' ORDER BY duration DESC LIMIT 10;"

# 3. Lag가 계속 증가하면 Consumer 인스턴스 추가
pm2 start issuer-consumer --name issuer-consumer-2
\`\`\`

---

## 유형 3 — 멱등성 실패 반복 (DLQ 재진입)

**증상**: requeue 후 또 DLQ 진입

\`\`\`bash
# 1. DLQ 메시지 원인 확인
curl "http://localhost:3000/admin/dlq/pending"

# 2. 이미 원장에 반영됐는지 확인 (txHash로)
psql -c "SELECT * FROM processed_events WHERE tx_hash='0x...';"

# 3a. 이미 반영됨 → drop
curl -X DELETE http://localhost:3000/admin/dlq/drop \
  -d '{"dlqId":"...", "operator":"...", "reason":"이미 processed_events에 존재"}'

# 3b. 미반영 + 코드 버그 → 코드 수정 배포 후 requeue
\`\`\`

---

## 유형 4 — Redis 연결 끊김

**증상**: redisConnected: false, 모든 처리 중단

\`\`\`bash
# 1. Redis 응답 확인
redis-cli ping

# 2. Redis 메모리 확인
redis-cli info memory | grep used_memory_human

# 3. Redis 정상 → Consumer만 재시작
pm2 restart issuer-consumer

# 4. Redis 다운 → 인프라팀 에스컬레이션 (연락처: infra@kyobo.com)
\`\`\`

---

## 에스컬레이션 기준

| 상황 | 조치 | 연락처 |
|------|------|-------|
| Consumer 재시작으로 해소 | 자체 해결 후 리포트 | - |
| Lag 500+ + 30분 지속 | 서비스 관리자 호출 | 팀장 |
| Redis 다운 | 즉시 인프라팀 + 서비스 관리자 | infra 팀 |
| DLQ 20건 이상 | 서비스 관리자 호출 | 팀장 |

## 이 Runbook 문서화 이력

| 날짜 | 변경 내용 | 담당자 |
|------|---------|-------|
| 2026-05-04 | 최초 작성 | - |
```

---

## 완료 기준

- [ ] `GET /admin/queue/stats` — `stats` + `alerts` 필드 포함 응답 확인
- [ ] Consumer 강제 중단 → `consumerCount: 0` + `P1: Consumer 프로세스 없음` 알림 확인
- [ ] DLQ에 메시지 적재 → `dlqCount > 0` + `P2: DLQ N건 적재` 알림 확인
- [ ] `pendingMessages >= 200` → `P2: Consumer Lag 경고` 알림 확인
- [ ] Runbook 문서 `docs/runbooks/consumer-incident-runbook.md` 완성 (4가지 유형 모두 포함)

---

### 장애 대응 시 핵심 원칙

```
1. 먼저 /admin/queue/stats — 유형 확인 전에 조치 금지
2. 프로세스 재시작은 유형 1에만 — Lag에 재시작은 효과 없음
3. DLQ requeue 전 원장 확인 — 이미 반영됐으면 drop
4. Redis 다운은 자체 해결 시도 금지 — 즉시 인프라팀
5. 모든 운영 행위는 감사 로그 기록 (requeue/drop API가 자동 처리)
```

---

## 워크시트

### Consumer 장애 대응 워크시트

> 장애 알림 수신 시 이 시트를 순서대로 채운다. 빈칸 채우는 순서 = 진단 순서다.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Consumer 장애 대응 시트
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[1단계: 초기 상태 확인]  ← 무조건 여기서 시작
  수신 시각: ____________________
  알림 내용: ____________________________________________

  GET /admin/queue/stats 결과:
    consumerCount   : ____  (0이면 → 유형 1로 이동)
    pendingMessages : ____  (200+ 이면 → 유형 2로 이동)
    dlqCount        : ____  (0+ 이면 → 유형 3 병행 확인)
    redisConnected  : ( ) true  ( ) false  (false → 유형 4로 이동)

[2단계: 장애 유형 판정]
  해당 유형에 V:
  ( ) 유형 1 — 프로세스 크래시   (consumerCount = 0)
  ( ) 유형 2 — Lag 증가          (pendingMessages 200+, 프로세스 살아있음)
  ( ) 유형 3 — 멱등성 실패 반복  (DLQ 재진입 확인됨)
  ( ) 유형 4 — Redis 연결 끊김   (redisConnected = false)
  ( ) 복합   — 유형 ___ + 유형 ___

[3단계: 유형별 원인 파악]
  (유형 1) 크래시 원인:
    pm2 logs 마지막 에러: ______________________________
    크래시 직전 이벤트: ________________________________

  (유형 2) Lag 원인:
    VASP p99 응답시간: ____ ms  (정상: < 5000ms)
    DB 슬로우 쿼리 존재: ( ) 있음  ( ) 없음
    원인 특정: ( ) VASP 지연  ( ) DB 병목  ( ) 트래픽 급증

  (유형 3) 멱등성 실패:
    DLQ 재진입 메시지 ID: ____________________
    processed_events 확인: ( ) 이미 반영됨  ( ) 미반영
    원인: ( ) 코드 버그  ( ) 외부 중복 발행

  (유형 4) Redis 상태:
    redis-cli ping 결과: ( ) PONG  ( ) 연결 실패
    메모리 사용량: ____  / ____ (used / maxmemory)
    원인: ( ) Redis 재시작  ( ) 메모리 초과  ( ) 네트워크

[4단계: 조치 실행]
  실행 시각: ____________________
  실행자: ____________________

  실행 내용 (해당 항목에 V + 시각 기록):
  ( ) pm2 restart issuer-consumer          __:__
  ( ) Consumer 인스턴스 추가             __:__
  ( ) DLQ requeue                        __:__
  ( ) DLQ drop                           __:__
  ( ) 인프라팀 에스컬레이션              __:__  연락처: ____
  ( ) 기타: ____________________________  __:__

[5단계: 사후 확인 (10분 후)]
  GET /admin/queue/stats 재조회:
    consumerCount   : ____  (1 이상이어야 정상)
    pendingMessages : ____  (감소 추세여야 정상)
    dlqCount        : ____
    redisConnected  : ( ) true  ( ) false

  정상 복구 여부: ( ) 정상 ✅  ( ) 미해소 → 추가 에스컬레이션

[6단계: 사후 기록]
  장애 지속 시간: ____ 분
  영향받은 메시지 수: ____ 건
  재발 방지 과제: ______________________________________
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### 유형별 빠른 판단 카드

```
┌──────────────────────────────────────────────────────────┐
│  유형 1 — 프로세스 크래시 체크리스트                     │
│                                                           │
│  □ pm2 status → stopped/errored 확인                     │
│  □ pm2 logs --lines 100 → 크래시 원인 확인               │
│  □ pm2 restart issuer-consumer                              │
│  □ 재시작 후 pm2 status → online 확인                    │
│  □ /admin/queue/stats → consumerCount >= 1 확인          │
│  □ PEL 메시지 자동 재수신 확인 (5분 대기)                │
│  ※ 같은 크래시 3회 이상 반복 → 코드 버그, 배포팀 에스컬 │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  유형 2 — Lag 증가 체크리스트                            │
│                                                           │
│  □ /admin/vasp/health → VASP 응답시간 확인               │
│    └─ p99 > 10s → VASP 지연이 원인                       │
│  □ DB 슬로우 쿼리 확인 (pg_stat_activity)                │
│    └─ duration 긴 쿼리 있으면 → DBA 에스컬레이션         │
│  □ Lag 500+ & 원인 불명 → Consumer 인스턴스 추가         │
│       pm2 start issuer-consumer --name issuer-consumer-2       │
│  □ Lag 감소 추세 확인 (5분 모니터링)                     │
│  ※ Lag에 pm2 restart는 효과 없음. 오히려 PEL 재처리     │
│    부하 추가됨                                            │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  유형 3 — 멱등성 실패 반복 체크리스트                    │
│                                                           │
│  □ /admin/dlq/pending → 재진입 메시지 확인               │
│  □ txHash로 processed_events 조회                        │
│    └─ 이미 있으면 → drop (중복, 원장은 정상)             │
│    └─ 없으면 → 코드 버그 또는 외부 중복 발행             │
│  □ 코드 버그 → 수정 배포 후 requeue                      │
│  □ 외부 중복 발행 → 발신 시스템 팀 통보 + drop           │
│  ※ 원인 파악 없이 requeue 금지 — 무한 루프               │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  유형 4 — Redis 연결 끊김 체크리스트                     │
│                                                           │
│  □ redis-cli ping → PONG 여부 확인                       │
│    └─ PONG: Redis 정상 → Consumer만 재시작               │
│    └─ 연결 실패: Redis 문제 → 아래 진행                  │
│  □ redis-cli info memory → 메모리 사용량 확인            │
│    └─ 90% 이상 → 인프라팀 즉시 호출                      │
│  □ Redis 재시작 여부 → /var/log/redis/redis.log 확인     │
│  □ Redis 문제 자체 해결 시도 금지 → 인프라팀 에스컬레이션│
│  □ 복구 후 Consumer 재시작 → /admin/queue/stats 확인     │
└──────────────────────────────────────────────────────────┘
```

---

### 주간 Consumer 안정성 리뷰 시트

> 매주 금요일, 이번 주 Consumer 운영 현황을 기록한다.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
주간 Consumer 안정성 리뷰 — ____년 __월 __일 ~ __월 __일
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[처리량]
  총 처리 메시지 수: _________ 건
  평균 처리 속도   : _________ msg/s
  최대 Lag (최고점): _________ 건  발생 시각: ____

[장애 이력]
  총 장애 횟수: ____ 회
  유형별:
    유형 1(크래시): ____ 회 → 총 다운타임: ____ 분
    유형 2(Lag)   : ____ 회
    유형 3(멱등성): ____ 회
    유형 4(Redis) : ____ 회

[DLQ 현황]
  총 DLQ 적재: ____ 건
  requeue    : ____ 건
  drop       : ____ 건

[pm2 재시작 횟수]
  pm2 show issuer-consumer → restart count: ____
  (주간 10회 이상이면 코드 안정성 검토 필요)

[이번 주 주요 이슈]
  1. ___________________________________________________
  2. ___________________________________________________

[다음 주 개선 과제]
  □ ___________________________________ (담당: ____)
  □ ___________________________________ (담당: ____)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```


---

## 자동화 확장 — NotifierAdapter + WeeklyReportService

> 알림 채널(Slack·Teams·Email·Confluence 등)에 관계없이 동일한 코드로 동작하는 어댑터 설계.
> 교보 측이 어떤 협업 도구를 쓰는지 사전에 알 수 없으므로 출력 채널을 인터페이스 뒤에 숨긴다.

---

### NotifierAdapter 인터페이스

```typescript
// internal/packages/event-engine/src/admin/NotifierAdapter.ts

export interface AlertPayload {
  title: string;
  severity: 'P1' | 'P2' | 'P3';
  body: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface NotifierAdapter {
  // 즉시 알림 — 장애 감지 시
  sendAlert(payload: AlertPayload): Promise<void>;

  // 인시던트 생성 알림 (S51 IncidentService에서 호출)
  sendIncidentAlert(incident: Incident): Promise<void>;

  // 인시던트 종료 알림
  sendIncidentResolved(incidentId: string, note: string): Promise<void>;

  // 주간 리포트 (WeeklyReportService에서 호출)
  sendWeeklyReport(report: WeeklyReport): Promise<void>;
}
```

---

### Slack 구현체 (예시)

```typescript
// internal/packages/event-engine/src/admin/notifiers/SlackNotifierAdapter.ts

export class SlackNotifierAdapter implements NotifierAdapter {
  constructor(private readonly webhookUrl: string) {}

  async sendAlert(payload: AlertPayload): Promise<void> {
    const color = payload.severity === 'P1' ? '#ff0000'
                : payload.severity === 'P2' ? '#ff9900'
                : '#36a64f';

    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{
          color,
          title: `[${payload.severity}] ${payload.title}`,
          text: payload.body,
          fields: Object.entries(payload.metadata ?? {}).map(([k, v]) => ({
            title: k, value: String(v), short: true,
          })),
          ts: Math.floor(Date.now() / 1000),
        }],
      }),
    });
  }

  async sendIncidentAlert(incident: Incident): Promise<void> {
    const dlqCount = incident.snapshot.dlqItems.length;
    const autoDropCount = incident.snapshot.dlqItems
      .filter(i => i.alreadyInLedger).length;

    await this.sendAlert({
      title: `${incident.type} 인시던트 생성 — #${incident.id.slice(0, 8)}`,
      severity: incident.type === 'REDIS_DOWN' || incident.type === 'CONSUMER_CRASH'
        ? 'P1' : 'P2',
      body: [
        `*Consumer 수*: ${incident.snapshot.queueStats.consumerCount}`,
        `*Pending*: ${incident.snapshot.queueStats.pendingMessages}건`,
        `*DLQ*: ${dlqCount}건 (원장 중복 자동 감지: ${autoDropCount}건)`,
        `*조회*: GET /admin/incidents/${incident.id}`,
      ].join('\n'),
    });
  }

  async sendIncidentResolved(incidentId: string, note: string): Promise<void> {
    await this.sendAlert({
      title: `인시던트 해소 — #${incidentId.slice(0, 8)}`,
      severity: 'P3',
      body: note,
    });
  }

  async sendWeeklyReport(report: WeeklyReport): Promise<void> {
    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `*주간 Consumer 안정성 리포트 — ${report.weekLabel}*`,
        attachments: [{
          color: report.totalIncidents > 5 ? '#ff9900' : '#36a64f',
          fields: [
            { title: '총 인시던트', value: String(report.totalIncidents), short: true },
            { title: '평균 해소 시간', value: `${report.avgResolutionMinutes}분`, short: true },
            { title: 'DLQ 총계', value: String(report.dlqTotal), short: true },
            { title: 'drop 건수', value: String(report.dlqDropped), short: true },
            { title: '유형별 분포', value: report.typeBreakdown, short: false },
            { title: '반복 패턴', value: report.repeatPatterns || '없음', short: false },
          ],
        }],
      }),
    });
  }
}
```

---

### Teams / Email 구현체 스텁

```typescript
// 교보 측 협업 도구 확정 후 구현체만 교체

// TeamsNotifierAdapter.ts
export class TeamsNotifierAdapter implements NotifierAdapter {
  constructor(private readonly webhookUrl: string) {}

  async sendAlert(payload: AlertPayload): Promise<void> {
    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        '@type': 'MessageCard',
        themeColor: payload.severity === 'P1' ? 'FF0000' : 'FF9900',
        summary: payload.title,
        text: payload.body,
      }),
    });
  }

  async sendIncidentAlert(incident: Incident): Promise<void> { /* 동일 패턴 */ }
  async sendIncidentResolved(id: string, note: string): Promise<void> { /* 동일 패턴 */ }
  async sendWeeklyReport(report: WeeklyReport): Promise<void> { /* 동일 패턴 */ }
}

// EmailNotifierAdapter.ts
export class EmailNotifierAdapter implements NotifierAdapter {
  constructor(
    private readonly smtpConfig: SmtpConfig,
    private readonly recipients: string[],
  ) {}
  // 동일 인터페이스, SMTP로 발송
}
```

---

### 의존성 주입 — 채널 교체 지점

```typescript
// internal/packages/event-engine/src/admin/index.ts

function buildNotifier(): NotifierAdapter {
  switch (process.env.NOTIFIER_TYPE) {
    case 'slack':  return new SlackNotifierAdapter(process.env.SLACK_WEBHOOK_URL!);
    case 'teams':  return new TeamsNotifierAdapter(process.env.TEAMS_WEBHOOK_URL!);
    case 'email':  return new EmailNotifierAdapter(smtpConfig, recipients);
    default:       return new ConsoleNotifierAdapter();  // 개발 환경
  }
}

const notifier        = buildNotifier();
const incidentService = new IncidentService(db, consumerMonitor, dlqAdmin, notifier);
const weeklyReport    = new WeeklyReportService(db, notifier);
```

교보 측이 도구를 확정하면 `NOTIFIER_TYPE` 환경변수 하나만 바꾸면 된다. 코드 변경 없음.

---

### WeeklyReportService — 주간 리포트 자동 집계

```typescript
// internal/packages/event-engine/src/admin/WeeklyReportService.ts

export interface WeeklyReport {
  weekLabel: string;
  totalIncidents: number;
  avgResolutionMinutes: number;
  dlqTotal: number;
  dlqRequeued: number;
  dlqDropped: number;
  typeBreakdown: string;   // 'DLQ:3 / LAG:2 / CRASH:1'
  repeatPatterns: string;  // 동일 원인 3회+ 항목
}

export class WeeklyReportService {
  constructor(
    private readonly db: Database,
    private readonly notifier: NotifierAdapter,
  ) {}

  async generate(weekStart: Date): Promise<WeeklyReport> {
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    // 유형별 건수 + 평균 해소 시간
    const incidentRows = await this.db.query(
      `SELECT
         type,
         COUNT(*) AS count,
         AVG(EXTRACT(EPOCH FROM (resolved_at - detected_at)) / 60)
           FILTER (WHERE resolved_at IS NOT NULL) AS avg_minutes
       FROM incidents
       WHERE detected_at >= $1 AND detected_at < $2
       GROUP BY type`,
      [weekStart, weekEnd],
    );

    // DLQ requeue/drop 집계
    const actionRows = await this.db.query(
      `SELECT
         a.elem->>'action' AS action,
         COUNT(*) AS count
       FROM incidents,
            jsonb_array_elements(actions) AS a(elem)
       WHERE detected_at >= $1 AND detected_at < $2
         AND a.elem->>'action' IN ('REQUEUE', 'DROP')
       GROUP BY a.elem->>'action'`,
      [weekStart, weekEnd],
    );

    // 동일 rootCause 3회+ 반복 패턴
    const repeatRows = await this.db.query(
      `SELECT root_cause, COUNT(*) AS cnt
       FROM incidents
       WHERE detected_at >= $1 AND detected_at < $2
         AND root_cause IS NOT NULL
       GROUP BY root_cause
       HAVING COUNT(*) >= 3`,
      [weekStart, weekEnd],
    );

    const rows      = incidentRows.rows;
    const actions   = actionRows.rows;
    const repeats   = repeatRows.rows;

    const totalIncidents = rows.reduce((s, r) => s + Number(r.count), 0);
    const avgMinutes     = rows.length
      ? rows.reduce((s, r) => s + Number(r.avg_minutes ?? 0), 0) / rows.length
      : 0;
    const requeued = Number(actions.find(r => r.action === 'REQUEUE')?.count ?? 0);
    const dropped  = Number(actions.find(r => r.action === 'DROP')?.count ?? 0);

    return {
      weekLabel:             `${weekStart.toISOString().slice(0, 10)} ~ ${weekEnd.toISOString().slice(0, 10)}`,
      totalIncidents,
      avgResolutionMinutes:  Math.round(avgMinutes),
      dlqTotal:              requeued + dropped,
      dlqRequeued:           requeued,
      dlqDropped:            dropped,
      typeBreakdown:         rows.map(r => `${r.type}:${r.count}`).join(' / '),
      repeatPatterns:        repeats.map(r => `"${r.root_cause}" (${r.cnt}회)`).join(', '),
    };
  }

  // 매주 월요일 09:00 KST 자동 발송
  async sendWeeklyReport(): Promise<void> {
    const lastMonday = this.getLastMonday();
    const report = await this.generate(lastMonday);
    await this.notifier.sendWeeklyReport(report);
  }

  private getLastMonday(): Date {
    const now  = new Date();
    const day  = now.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon  = new Date(now);
    mon.setDate(now.getDate() + diff - 7);
    mon.setHours(0, 0, 0, 0);
    return mon;
  }
}
```

cron 등록:

```typescript
// 매주 월요일 09:00 KST
cron.schedule('0 9 * * 1', () => weeklyReportService.sendWeeklyReport(), {
  timezone: 'Asia/Seoul',
});
```

---

### 아날로그 워크시트 → 디지털 대응 요약

| 아날로그 (워크시트) | 디지털 (API/서비스) | 자동화 여부 |
|---|---|---|
| 초기 상태 확인 빈칸 | `POST /admin/incidents` 응답의 `snapshot` | ✅ 자동 |
| txHash 원장 중복 확인 | `snapshot.dlqItems[].alreadyInLedger` | ✅ 자동 |
| 조치 기록 | `POST /admin/incidents/:id/actions` | 운영자 입력 |
| 사후 확인 | `GET /admin/queue/stats` 재조회 | 운영자 확인 |
| 주간 리뷰 시트 집계 | `WeeklyReportService.generate()` | ✅ 자동 |
| 반복 패턴 분석 | `HAVING COUNT(*) >= 3` 쿼리 | ✅ 자동 |
| 알림 채널 | `NOTIFIER_TYPE` 환경변수 교체 | 환경변수 1개 |
