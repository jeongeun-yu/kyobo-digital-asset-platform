# S07 실습 — Redis Streams CLI 직접 실습

> 강의 노트: `M2_S7_redis_streams_cli.md`  
> 소요 시간: 약 50분 (단계 1~5)  
> 목표: S6에서 배운 PEL·Consumer Group·At-least-once를 redis-cli로 눈으로 직접 확인

---

## 단계 1: 환경 준비 (10분)

### 방법 A — Docker (권장)

```
# Redis 컨테이너 기동
docker run -d \
  --name kyobo-redis \
  -p 6380:6379 \
  redis:7-alpine \
  redis-server --requirepass redis_local_pw

# redis-cli 접속
docker exec -it kyobo-redis redis-cli -a redis_local_pw
```

> 이미 `kyobo-redis` 컨테이너가 있으면: `docker start kyobo-redis`

### 방법 B — Redis Cloud (Docker 사용 불가 시)

**1단계: redis-cli 설치 (Windows)**

1. https://github.com/microsoftarchive/redis/releases 접속
2. `Redis-x64-3.0.504.msi` 다운로드 후 설치
3. PowerShell 재시작 후 `redis-cli` 입력해서 명령어 인식 확인

**2단계: Redis Cloud DB 생성**

1. https://cloud.redis.io 접속 → 
2. **New database** → Try 30 MB for free 선택 → DB 생성
3. DB 화면에서 **Connect** 버튼 클릭 → **Redis CLI** 탭에서 접속 정보 확인

**3단계: 접속**

```powershell
# Connect 탭의 정보를 아래 형식으로 입력
redis-cli -h <host> -p <port> -a <password>

# 예시
redis-cli -h redis-19365.c245.us-east-1-3.ec2.cloud.redislabs.com -p 19365 -a <password>
```

> `-u redis://...` 형식은 구버전 redis-cli에서 지원 안 함 — 반드시 `-h`, `-p`, `-a` 로 분리해서 입력

```
# 접속 확인
PING
# PONG

# 버전 확인
INFO server | grep redis_version
```

### 실습 시작 전 클린업

```
DEL eventStream
KEYS *
```

> 공용 Redis 사용 시 `FLUSHDB` 금지 — `DEL eventStream`만 사용

완료 기준:
```
[ ] PING → PONG 확인
[ ] redis-cli 프롬프트 열려 있음
```

---

## 단계 2: XADD / XLEN / XRANGE — Streams 기초 (10분)

### XADD: 이벤트 적재

```
XADD eventStream * eventType NFT_ISSUED tokenId 1 txHash 0xaaa111 recipient 0xuser1
XADD eventStream * eventType NFT_ISSUED tokenId 2 txHash 0xaaa222 recipient 0xuser2
XADD eventStream * eventType NFT_BURNED tokenId 1 txHash 0xbbb111 recipient 0xuser1
XADD eventStream * eventType NFT_ISSUED tokenId 3 txHash 0xaaa333 recipient 0xuser3
XADD eventStream * eventType TRANSFER   tokenId 2 txHash 0xccc111 recipient 0xuser3
```

반환값 구조:
```
"1748000001234-0"
  │             │
  │             └── seq 번호 (같은 ms 내 순서)
  └── Unix 타임스탬프(ms) — Redis 서버 시각 기준
```

> 이 ID가 나중에 XACK, XPENDING에서 메시지 식별자로 사용됨 — 기억해두기

### 스트림 내용 확인

```
XLEN eventStream
# (integer) 5

XRANGE eventStream - +
# 전체 조회 (처음~끝). 읽어도 삭제 안 됨.

XRANGE eventStream - + COUNT 2
# 처음 2개만

XREVRANGE eventStream + -
# 역순 조회 (최신 → 오래된)
```

XRANGE 출력 구조:
```
1) "1748000001234-0"      ← Entry ID
2) 1) "eventType"
   2) "NFT_ISSUED"
   3) "tokenId"
   4) "1"
   5) "txHash"
   6) "0xaaa111"
   7) "recipient"
   8) "0xuser1"
```

> 첫 줄 = Entry ID (타임스탬프-seq) / 이후 = field-value 쌍

완료 기준:
```
[ ] XLEN → 5 확인
[ ] XRANGE로 5개 항목 내용 확인
[ ] XREVRANGE 출력은 역순 (마지막 추가 항목이 첫 번째) 확인
```

---

## 단계 3: Consumer Group + XREADGROUP + XACK (15분)

### Consumer Group 생성

```
XGROUP CREATE eventStream nftConsumers 0 MKSTREAM
# OK
# (이미 존재하면 BUSYGROUP → DEL eventStream 후 재생성)

XINFO GROUPS eventStream
```

XINFO GROUPS 필드 의미:
```
consumers:        0     → 아직 아무도 XREADGROUP 안 함
pending:          0     → PEL 비어있음
last-delivered-id: 0-0  → 아직 아무것도 전달 안 됨
lag:              5     → 미처리 메시지 5개 대기 중
```

```
XINFO CONSUMERS eventStream nftConsumers
# (empty array) — 아직 Consumer 없음
```

### XREADGROUP: 메시지 읽기

```
# 첫 번째 읽기 — 2개
XREADGROUP GROUP nftConsumers consumer-1 COUNT 2 STREAMS eventStream >

# PEL 확인 (2개 등록됨)
XPENDING eventStream nftConsumers - + 10

# 두 번째 읽기 — 나머지 3개
XREADGROUP GROUP nftConsumers consumer-1 COUNT 3 STREAMS eventStream >

# PEL 재확인 (총 5개)
XPENDING eventStream nftConsumers - + 10
```

XPENDING 출력 구조:
```
1) "1748000001234-0"   ← Entry ID
2) "consumer-1"        ← 소유 Consumer
3) (integer) 1500      ← idle time (ms)
4) (integer) 1         ← delivery_count (배달 횟수)
```

> `>` = 새 메시지만. 5개 다 읽은 후 다시 `>` 호출하면 empty array.

### XACK: 처리 완료 선언

```
# XPENDING 출력의 실제 ID 복사해서 사용
XACK eventStream nftConsumers <Entry ID 1>
# → 1

XPENDING eventStream nftConsumers - + 10
# → 4개로 줄어듦

# 2개 동시 ACK
XACK eventStream nftConsumers <Entry ID 2> <Entry ID 3>
# → 2

# 나머지 전부 ACK
XACK eventStream nftConsumers <Entry ID 4> <Entry ID 5>

XPENDING eventStream nftConsumers - + 10
# (empty array) ← PEL 비어있음 ✅
```

> XACK는 PEL에서만 제거 — 스트림 자체는 보존. XRANGE로 확인하면 5개 그대로.

완료 기준:
```
[ ] XGROUP CREATE → OK 확인
[ ] XREADGROUP > → 2개, 3개 순서로 수신 확인
[ ] XPENDING으로 5개 PEL 등록 확인
[ ] XACK 전체 완료 후 XPENDING → empty array 확인
[ ] XRANGE로 스트림 자체는 5개 그대로임 확인
```

---

## 단계 4: 미ACK 재수신 시뮬레이션 — At-least-once (15분)

### 준비: 스트림 초기화 + 이벤트 3개 추가

```
DEL eventStream
XGROUP CREATE eventStream nftConsumers 0 MKSTREAM

XADD eventStream * eventType NFT_ISSUED tokenId 10 txHash 0xddd001
XADD eventStream * eventType NFT_ISSUED tokenId 11 txHash 0xddd002
XADD eventStream * eventType NFT_BURNED tokenId 10 txHash 0xddd003

XLEN eventStream
# (integer) 3
```

### 읽기 + XACK 하지 않기 (크래시 시뮬레이션)

```
XREADGROUP GROUP nftConsumers consumer-1 COUNT 3 STREAMS eventStream >
# → 3개 메시지 반환 (Entry ID 메모해두기)
```

```
# ⛔ XACK 하지 말 것 — 프로세스 크래시 시뮬레이션
```

```
XPENDING eventStream nftConsumers - + 10
# → 3개가 PEL에 있음 (consumer-1, delivery_count=1)
```

### `>` 로 재호출하면?

```
XREADGROUP GROUP nftConsumers consumer-1 COUNT 10 STREAMS eventStream >
# (empty array) ← 이미 읽은 메시지는 > 로 재수신 안 됨
```

> `>` = 아직 아무도 읽지 않은 새 메시지만. 이미 읽고 PEL에 있는 것은 제외.

### `0` 으로 PEL 재수신 (재시작 시뮬레이션)

```
XREADGROUP GROUP nftConsumers consumer-1 COUNT 10 STREAMS eventStream 0
# → 동일한 3개 메시지 다시 수신됨!
```

> 이것이 At-least-once. 크래시 후 재시작해도 메시지 유실 없음.

```
XPENDING eventStream nftConsumers - + 10
# delivery_count: 1 → 2로 증가됨 확인
```

### delivery_count 추적 실습

```
# XACK 없이 0 으로 3회 반복 호출
XREADGROUP GROUP nftConsumers consumer-1 COUNT 3 STREAMS eventStream 0
# delivery_count = 2

XREADGROUP GROUP nftConsumers consumer-1 COUNT 3 STREAMS eventStream 0
# delivery_count = 3 → DLQ 대상 (S11에서 구현)

XPENDING eventStream nftConsumers - + 10
# delivery_count 값 확인
```

### 재수신 후 XACK 완료

```
XACK eventStream nftConsumers <Entry ID 1> <Entry ID 2> <Entry ID 3>
# → 3

XPENDING eventStream nftConsumers - + 10
# (empty array) ← PEL 비어있음 ✅
```

완료 기준:
```
[ ] XREADGROUP > → 3개 수신 후 XACK 안 함 확인
[ ] 두 번째 XREADGROUP > → empty array 확인
[ ] XREADGROUP 0 → 동일 3개 재수신 확인
[ ] delivery_count 증가 확인
[ ] 최종 XACK 후 PEL empty 확인
```

---

## 단계 5: Consumer 2개 동시 실행 → 메시지 분배 확인 (10분)

### 준비: 이벤트 6개 추가

```
DEL eventStream
XGROUP CREATE eventStream nftConsumers 0 MKSTREAM

XADD eventStream * eventType NFT_ISSUED tokenId 1 txHash 0xeee001
XADD eventStream * eventType NFT_ISSUED tokenId 2 txHash 0xeee002
XADD eventStream * eventType NFT_ISSUED tokenId 3 txHash 0xeee003
XADD eventStream * eventType NFT_BURNED tokenId 1 txHash 0xfff001
XADD eventStream * eventType TRANSFER   tokenId 2 txHash 0xfff002
XADD eventStream * eventType NFT_ISSUED tokenId 4 txHash 0xeee004

XLEN eventStream
# (integer) 6
```

### consumer-1 먼저 읽기 (터미널 1)

```
XREADGROUP GROUP nftConsumers consumer-1 COUNT 3 STREAMS eventStream >
# → Entry 1~3 (NFT_ISSUED tokenId=1,2,3)

XPENDING eventStream nftConsumers - + 10
# consumer-1에 3개 할당됨
```

### consumer-2 이어서 읽기 (터미널 2)

```
XREADGROUP GROUP nftConsumers consumer-2 COUNT 10 STREAMS eventStream >
# → Entry 4~6 (NFT_BURNED/TRANSFER/NFT_ISSUED)
# consumer-1 것과 중복 없음 ✅

XPENDING eventStream nftConsumers - + 10
# consumer-1: 3개, consumer-2: 3개 (총 6개 PEL)
```

### 독립적 XACK

```
# consumer-1
XACK eventStream nftConsumers <E1> <E2> <E3>

# consumer-2
XACK eventStream nftConsumers <E4> <E5> <E6>

XPENDING eventStream nftConsumers - + 10
# (empty array) ← 분산 처리 완료 ✅
```

완료 기준:
```
[ ] consumer-1이 Entry 1~3, consumer-2가 Entry 4~6 수신 확인
[ ] 중복 수신 없음 확인
[ ] XPENDING에서 소유자 구분 확인
[ ] 독립 XACK 후 PEL empty 확인
```

---

## 추가 실습: XAUTOCLAIM — Consumer 장애 자동 복구

```
# consumer-1이 3개 읽고 XACK 없이 종료 시뮬레이션
XREADGROUP GROUP nftConsumers consumer-1 COUNT 3 STREAMS eventStream >

XPENDING eventStream nftConsumers - + 10
# consumer-1 소유, idle time 확인

# consumer-2가 XAUTOCLAIM으로 인계 (1ms 이상 미ACK)
XAUTOCLAIM eventStream nftConsumers consumer-2 1 0-0

XPENDING eventStream nftConsumers - + 10
# consumer-1 → consumer-2 소유권 이전됨
# delivery_count 1 → 2 증가됨

XACK eventStream nftConsumers <E1> <E2> <E3>
```

---

## 추가 실습: XADD MAXLEN — 스트림 크기 관리

```
XADD eventStream MAXLEN = 5 * eventType NFT_ISSUED tokenId 100 txHash 0xzz001
# 스트림 크기를 정확히 5개로 유지 (초과 시 오래된 것 즉시 삭제)

XLEN eventStream
# 5개만 남아있음 확인
```

> `MAXLEN ~` (근사치)는 항목 수가 적을 때 거의 동작 안 함 — 실습에서는 `MAXLEN =` 사용

---

## 자주 하는 실수

| 함정 | 문제 | 해결 |
|------|------|------|
| `>` 대신 `$` 사용 | XREADGROUP에서 에러 | XREADGROUP은 `>` 사용 |
| Entry ID 잘못 복사 | XACK → 0 반환 | `timestamp-seq` 형식 정확히 복사 |
| BUSYGROUP 에러 | 그룹 이미 존재 | `DEL eventStream` 후 재생성 |
| XACK 전 `>` 재호출 | empty array 반환 | 재수신은 반드시 `0` 사용 |

---

## 핵심 명령 정리

| 명령 | 역할 | 기억할 것 |
|------|------|-----------|
| `XADD key * f v ...` | 스트림에 항목 추가 | `*` = ID 자동 생성 |
| `XLEN key` | 항목 수 조회 | |
| `XRANGE key - +` | 전체 항목 조회 | 읽어도 삭제 안 됨 |
| `XREVRANGE key + -` | 역순 조회 | |
| `XGROUP CREATE key group 0 MKSTREAM` | 그룹 생성, 처음부터 | `$` = 지금 이후만 |
| `XINFO GROUPS key` | 그룹 상태 요약 | lag = 미처리 수 |
| `XINFO CONSUMERS key group` | Consumer 목록 | |
| `XREADGROUP GROUP g c COUNT n STREAMS key >` | 새 메시지 읽기 + PEL 등록 | `>` 중요 |
| `XREADGROUP GROUP g c COUNT n STREAMS key 0` | 내 PEL 재읽기 | crash 복구용 |
| `XPENDING key group - + n` | PEL 상세 조회 | 소유자 + delivery_count |
| `XACK key group id` | 처리 완료 → PEL 제거 | 반드시 처리 후에 |
| `XAUTOCLAIM key group consumer ms 0-0 COUNT n` | idle 초과 메시지 인계 | ms=1 = 즉시 |
| `XADD key MAXLEN = n * f v` | 크기 제한하며 추가 | `=` = 정확히 n개 유지 |

---

## S6 이론 → S7 CLI 실습 대응표

| S6 이론 | S7 CLI 명령 | 확인 내용 |
|---------|------------|-----------|
| Append-only 로그 | XADD ... * | Entry ID 자동 생성 |
| Consumer Group | XGROUP CREATE | XINFO GROUPS로 확인 |
| `>` 심볼 | XREADGROUP ... > | 첫 번째: n개, 두 번째: 0개 |
| PEL 등록 | XREADGROUP 후 | XPENDING으로 목록 확인 |
| 처리 완료 선언 | XACK | XPENDING에서 제거 확인 |
| At-least-once | XREADGROUP 0 | 크래시 후 동일 메시지 재수신 |
| Consumer crash 복구 | XAUTOCLAIM | 소유자 변경 + delivery_count 증가 |
| 수평 확장 | 두 Consumer XREADGROUP | 메시지 분배 확인 |
