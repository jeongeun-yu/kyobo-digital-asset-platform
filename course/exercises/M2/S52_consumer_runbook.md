# S52 운영 실습 — Consumer 장애 Runbook · 유형별 대응 절차와 모니터링 설계

강의 노트: `M2_S52_consumer_runbook.md`
소요 시간: 25분

---

## 목표

- `GET /admin/queue/stats` 응답으로 Consumer 장애 유형을 판별한다
- 유형별 Runbook 절차를 직접 수행하고 사후 확인까지 완료한다
- Runbook 문서를 작성해 야간 장애 시 판단 없이 실행 가능한 상태로 만든다

---

## 사전 조건

`ConsumerMonitorService`가 `/admin/queue/stats`에 연결되어 있어야 한다.

---

## Step 1 — Consumer Lag 모니터링 엔드포인트 확인 (10분)

### 1-1. 기본 조회

```bash
curl http://localhost:3000/admin/queue/stats
```

정상 응답 예시:

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

응답 필드별 의미:

| 필드 | 의미 | 이상 기준 |
|------|------|----------|
| `pendingMessages` | 미처리 메시지 수 (Lag) | 200 이상 경고, 500 이상 긴급 |
| `consumerCount` | 활성 Consumer 수 | 0이면 즉시 대응 |
| `dlqCount` | DLQ 적재 수 | 0 초과 시 알림 |
| `redisConnected` | Redis 연결 상태 | false이면 즉시 대응 |

### 1-2. 시나리오별 응답 확인

**시나리오 A: Consumer 강제 중단**

```bash
# Consumer 프로세스 중단 (테스트 환경에서)
pm2 stop issuer-consumer

# 즉시 확인
curl http://localhost:3000/admin/queue/stats
```

예상 응답:

```json
{
  "stats": { "consumerCount": 0, "redisConnected": true, ... },
  "alerts": ["P1: Consumer 프로세스 없음 (크래시 의심)"]
}
```

**시나리오 B: DLQ 메시지 적재**

```bash
# DLQ에 테스트 메시지를 강제로 넣은 후
curl http://localhost:3000/admin/queue/stats
```

예상 응답:

```json
{
  "stats": { "dlqCount": 1, ... },
  "alerts": ["P2: DLQ 1건 적재"]
}
```

완료 기준:
```
[ ] GET /admin/queue/stats — stats + alerts 필드 포함 응답 확인
[ ] Consumer 강제 중단 → consumerCount: 0 + "P1: Consumer 프로세스 없음" 확인
[ ] DLQ 메시지 적재 → dlqCount > 0 + "P2: DLQ N건 적재" 확인
[ ] pendingMessages >= 200 → "P2: Consumer Lag 경고" 알림 확인
```

---

## Step 2 — 장애 유형 판별 흐름 실습 (5분)

아래 워크시트를 `GET /admin/queue/stats` 응답으로 채운다.

```
[1단계: 초기 상태 확인]
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
```

---

## Step 3 — 유형별 Runbook 적용 (10분)

### 유형 1 — Consumer 프로세스 크래시

```bash
# 1. 상태 확인
pm2 status issuer-consumer

# 2. 크래시 원인 확인
pm2 logs issuer-consumer --lines 100

# 3. 재시작
pm2 restart issuer-consumer

# 4. 복구 확인
curl http://localhost:3000/admin/queue/stats
# → consumerCount >= 1, redisConnected: true 확인
```

주의: PEL 메시지는 XAUTOCLAIM으로 자동 재수신된다. 수동 requeue 불필요.

---

### 유형 2 — Consumer Lag 증가

```bash
# 1. VASP 지연 확인
curl http://localhost:3000/admin/vasp/health

# 2. DB 슬로우 쿼리 확인 (DB 접속 필요)
psql -c "SELECT pid, EXTRACT(EPOCH FROM now() - query_start) AS duration, query
         FROM pg_stat_activity
         WHERE state = 'active'
         ORDER BY duration DESC LIMIT 10;"

# 3. Lag 500+ 이상이고 원인 불명이면 Consumer 인스턴스 추가
pm2 start issuer-consumer --name issuer-consumer-2

# 4. Lag 감소 추세 확인 (5분 모니터링)
curl http://localhost:3000/admin/queue/stats
```

주의: Lag에 `pm2 restart`는 효과 없음. 오히려 PEL 재처리 부하 추가됨.

---

### 유형 3 — 멱등성 실패 반복 (DLQ 재진입)

```bash
# 1. DLQ 메시지 원인 확인
curl http://localhost:3000/admin/dlq/pending

# 2. 이미 원장에 반영됐는지 확인 (txHash 기준)
psql -c "SELECT * FROM processed_events WHERE tx_hash='<txHash>';"

# 3a. 이미 반영됨 → drop
curl -X DELETE http://localhost:3000/admin/dlq/drop \
  -H "Content-Type: application/json" \
  -d '{"dlqId":"<dlqId>", "operator":"<이메일>", "reason":"이미 processed_events에 존재"}'

# 3b. 미반영 + 코드 버그 → 코드 수정 배포 후 requeue
```

주의: 원인 파악 없이 requeue 금지 — 무한 루프 발생.

---

### 유형 4 — Redis 연결 끊김

```bash
# 1. Redis 응답 확인
redis-cli ping

# 2. Redis 메모리 확인
redis-cli info memory | grep used_memory_human

# 3. Redis 정상 → Consumer만 재시작
pm2 restart issuer-consumer

# 4. Redis 다운 → 인프라팀 에스컬레이션 (infra@kyobo.com)
# Redis 문제 자체 해결 시도 금지
```

---

## Step 4 — Runbook 문서 작성 (추가 과제)

`docs/runbooks/consumer-incident-runbook.md`를 작성한다. 아래 구조를 따른다:

```markdown
# Consumer 장애 대응 Runbook

> 최종 수정: YYYY-MM-DD | 담당: 이벤트 파이프라인 팀

## 0. 먼저 확인할 것
# pm2 status, /admin/queue/stats, /admin/dlq/pending

## 유형 1 — Consumer 프로세스 다운
# 증상, 조치 명령, 주의사항

## 유형 2 — Consumer Lag 증가
# 증상, 원인 탐색 명령, 조치

## 유형 3 — 멱등성 실패 반복 (DLQ 재진입)
# 증상, 확인 쿼리, 조치

## 유형 4 — Redis 연결 끊김
# 증상, 확인 명령, 에스컬레이션 기준

## 에스컬레이션 기준
# 상황별 연락처 + 기준
```

완료 기준:
```
[ ] Runbook에 4가지 유형 모두 포함 확인
[ ] 각 유형에 bash 명령어 포함 확인
[ ] 에스컬레이션 기준 명시 확인
```

---

## 에스컬레이션 기준

| 상황 | 조치 | 연락처 |
|------|------|-------|
| Consumer 재시작으로 해소 | 자체 해결 후 리포트 | — |
| Lag 500+ + 30분 지속 | 서비스 관리자 호출 | 팀장 |
| Redis 다운 | 즉시 인프라팀 + 서비스 관리자 | infra 팀 |
| DLQ 20건 이상 | 서비스 관리자 호출 | 팀장 |

---

## 토론 포인트

1. 유형 1(크래시)과 유형 2(Lag) 모두 "처리가 느려진다"는 증상이 있다. `consumerCount`와 `pendingMessages`만으로 두 유형을 구분할 수 있는가?
2. 유형 2에서 Consumer 인스턴스를 추가해도 Lag가 줄지 않는다면 어떤 원인을 의심해야 하는가?
3. 유형 3에서 "외부 시스템이 같은 이벤트를 두 번 발행"한 경우, drop이 맞는 처리인가? 발신 시스템에는 어떤 조치를 요청해야 하는가?
4. 유형 4에서 Redis 메모리가 90% 이상이면 Consumer를 재시작해도 의미 없는 이유는 무엇인가?

---

## 장애 대응 5대 원칙

```
1. 먼저 /admin/queue/stats — 유형 확인 전에 조치 금지
2. 프로세스 재시작은 유형 1에만 — Lag에 재시작은 효과 없음
3. DLQ requeue 전 원장 확인 — 이미 반영됐으면 drop
4. Redis 다운은 자체 해결 시도 금지 — 즉시 인프라팀
5. 모든 운영 행위는 감사 로그 기록 (requeue/drop API가 자동 처리)
```
