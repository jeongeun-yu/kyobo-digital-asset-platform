# M6 S56 — 배포·롤백 운영 · 파이프라인 설계와 무중단 배포 절차

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.

> 모듈 6 · 세션 56 · 1시간 `운영`
> 전제: M6 KyoboNFT.sol 배포 완료, Sepolia 운영 중
> 스켈레톤: `internal/packages/vasp/src/admin/DeployAdminService.ts`

> ⚠️ **운영 세션** — M6(S35~S43)에서 컨트랙트 작성·배포·업그레이드 방법을 배웠다. 이번 세션은 **그 배포가 운영 환경에서 어떻게 이루어지는가**, **배포 후 이상 징후가 감지됐을 때 언제 롤백을 결정하는가**다. 특히 컨트랙트 롤백이 왜 불가능한지, 그래서 어떻게 대응하는지가 핵심이다.

---

## 강의 파트 (25분)

### 1. 배포 파이프라인 설계 (10분)

배포는 단순히 "코드를 올리는 것"이 아니다. 금융 시스템에서 배포는 내부 통제 절차가 필요한 이벤트다.

**배포 파이프라인 전체 흐름:**

```
┌───────────────────────────────────────────────────────────────┐
│  배포 파이프라인 (단계별 게이트)                                 │
│                                                               │
│  [1] 코드 변경 + PR 리뷰                                       │
│       게이트: 리뷰어 2인 승인                                   │
│          ↓                                                    │
│  [2] CI 자동 검증                                              │
│       - 빌드 통과                                              │
│       - 단위 테스트 100% 통과                                  │
│       - Slither 정적 분석 HIGH/CRITICAL 0건                   │
│       - Storage Layout 충돌 없음 (hardhat-upgrades 검증)      │
│       게이트: 모든 CI 항목 통과                                │
│          ↓                                                    │
│  [3] 스테이징 배포 (Sepolia)                                   │
│       - 기존 tokenId 보존 확인                                 │
│       - 신규 기능 동작 확인                                    │
│       - VASP 연동 테스트                                       │
│       게이트: 스테이징 검증 기간 최소 2일~7일                  │
│          ↓                                                    │
│  [4] 프로덕션 배포 (2인 승인 필수)                             │
│       - 배포 당일 체크리스트 서명                              │
│       - 배포 후 15분 모니터링 윈도우                           │
│       게이트: 2인 승인 + 체크리스트 완료                       │
└───────────────────────────────────────────────────────────────┘
```

**스테이징 검증 체크리스트 (최소 항목):**

```
□ 기존 tokenId 보존: balanceOf(기존 사용자) = 배포 전과 동일
□ Storage Layout: hardhat-upgrades validateUpgrade() 통과
□ 신규 기능 동작: E2E 테스트 통과
□ VASP 연동: mint/burn 이벤트 → Consumer 처리 → 원장 반영 확인
□ reinitializer 버전: v2 배포 시 reinitializer(2) 설정 확인
```

**Blue/Green vs Rolling — 컨트랙트는 Blue/Green 필수:**

```
컨트랙트 업그레이드:
  → Blue/Green 필수
  → 이유: UUPS proxy upgradeToAndCall() 실행 후 되돌릴 수 없음
  → Blue(v1)를 유지하다가 Green(v2)으로 전환 = 컨트랙트에서는 의미 없음
  → 실제로는 "신중하게 한 번만" 의미 (단계별 검증이 Blue/Green의 역할)

API 서버 (stateless):
  → Rolling Update 가능
  → 한 번에 1/N씩 교체
  → 상태가 없으므로 이전 버전 인스턴스와 혼재해도 OK
  → Consumer는 별도 판단 필요 (메시지 처리 중 버전 혼재 위험)
```

**배포 게이트 — 왜 각 단계가 필요한가:**

| 게이트 | 통과 조건 | 실패 시 |
|--------|----------|---------|
| CI 빌드 | 컴파일 오류 없음 | PR 머지 차단 |
| Slither HIGH 0건 | 고위험 취약점 없음 | 자동 배포 차단 |
| Storage Layout | 충돌 없음 | 배포 불가 (데이터 파괴 위험) |
| 스테이징 검증 기간 | 최소 2일 | 운영 배포 차단 |
| 2인 승인 | 담당자 + 준법감시 | 배포 불가 |

---

### 2. 롤백 판단 기준 (8분)

배포 후 처음 15분이 가장 중요하다. 이 시간에 이상 징후가 없으면 안정적이라고 판단한다.

**배포 후 15분 모니터링 윈도우:**

```
[0분] 배포 완료
[0~5분]  에러율 기준선 수집 (배포 전 비교값 준비)
[5~10분] 핵심 지표 모니터링
[10~15분] 트렌드 판단 — 개선 중인가, 악화 중인가
[15분]   롤백 여부 최종 판단
```

**롤백 트리거 — 다음 중 하나라도 해당하면 즉시 롤백 검토:**

```
□ 에러율 1% 초과 (배포 전 대비)
□ P99 응답시간 2배 초과
□ DLQ 급증 (배포 전 0이었는데 5건+ 발생)
□ Consumer Lag 급증 (200건+)
□ Stuck TX 급증 (10건+)
□ 핵심 기능 실패: mint/burn API 503 응답
```

**⚠️ 컨트랙트 롤백 불가 원칙:**

S40에서 배운 Storage Layout 규칙을 운영 관점에서 재확인한다.

```
upgradeToAndCall(newImpl) 실행 완료
  → 온체인에 영구 기록
  → 새 Implementation이 즉시 적용됨
  → 이전 Implementation 주소는 있지만 롤백 시 Storage 해석 방식이 다름
  → 롤백하면 Storage Collision 위험 = 데이터 파괴
```

따라서:

```
컨트랙트 문제 발생 시 대응 전략:
  → API 서버에서 컨트랙트 호출 차단 (Circuit Breaker 수동 OPEN)
  → 문제 없는 상태의 API 서버 버전으로 롤백 (백엔드만)
  → 컨트랙트 자체는 v3를 빠르게 준비해서 재업그레이드

⚠️ upgradeToAndCall() 실행은 취소 불가. 실행 전 반드시 스테이징 검증.
```

**긴급 롤백 절차 (API 서버):**

```
1. 롤백 판단 (1인)      → 이상 징후 확인 후 즉시
2. 승인 (2인)           → 담당자 + 서비스 관리자
3. 이전 버전 재배포      → PM2 또는 K8s 롤백 명령
4. 검증 (5분)           → 에러율 정상화 확인
5. 감사 로그 기록        → 롤백 이유, 판단자, 승인자
```

---

### 3. 무중단 배포 운영 (7분)

API 서버 Rolling Update 중 운영이 중단되지 않으려면 몇 가지 조건이 필요하다.

**헬스체크 엔드포인트의 역할:**

```
배포 중 흐름:
  1. 새 인스턴스 시작
  2. 로드밸런서가 GET /health 호출 (30초 간격)
  3. /health → 200 + { status: 'ok' }
  4. 로드밸런서가 새 인스턴스를 트래픽 대상에 추가
  5. 이전 인스턴스에 SIGTERM 전송
  6. 이전 인스턴스 graceful shutdown (처리 중인 요청 완료 후 종료)

헬스체크가 없으면:
  → 초기화 중인 인스턴스에 트래픽 → 503 대량 발생
```

**Graceful Shutdown:**

```typescript
// 배포 중 데이터 손실 방지
process.on('SIGTERM', async () => {
  console.log('SIGTERM 수신. Graceful shutdown 시작...');

  // 새 요청 차단 (로드밸런서가 이 인스턴스를 빼줌)
  server.close();

  // 처리 중인 요청 완료 대기 (최대 30초)
  await new Promise(resolve => setTimeout(resolve, 30_000));

  // Consumer 안전 종료 (PEL 메시지가 orphan되지 않도록)
  await consumerWorker.gracefulStop();

  process.exit(0);
});
```

**배포 중 Consumer 판단:**

```
Consumer를 배포 중 일시 중단해야 하는 경우:
  → 메시지 처리 로직이 변경된 경우
  → 이전 버전 Consumer + 새 버전 DB 스키마 불일치 가능성

Consumer를 계속 운영해도 되는 경우:
  → API 레이어만 변경 (Consumer 로직 unchanged)
  → 멱등성 보장되어 재처리해도 안전한 경우
```

---

## 실습 파트 (30분)

### 실습 1 — 헬스체크 엔드포인트 구현 (10분)

```typescript
// internal/packages/vasp/src/admin/DeployAdminService.ts

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptime: number;
  checks: {
    db:    { ok: boolean; responseTimeMs: number | null };
    redis: { ok: boolean; responseTimeMs: number | null };
    vasp:  { ok: boolean; responseTimeMs: number | null };
  };
  timestamp: string;
}

export class DeployAdminService {
  constructor(
    private readonly db: Database,
    private readonly redis: RedisClient,
    private readonly vaspClient: IVASPClient,
    private readonly version: string,  // package.json version
  ) {}

  async getHealth(): Promise<HealthStatus> {
    const [dbCheck, redisCheck, vaspCheck] = await Promise.all([
      this._checkDb(),
      this._checkRedis(),
      this._checkVasp(),
    ]);

    const allOk = dbCheck.ok && redisCheck.ok && vaspCheck.ok;
    const anyFailed = !dbCheck.ok || !redisCheck.ok || !vaspCheck.ok;

    return {
      status:   allOk ? 'ok' : anyFailed ? 'error' : 'degraded',
      version:  this.version,
      uptime:   process.uptime(),
      checks: {
        db:    dbCheck,
        redis: redisCheck,
        vasp:  vaspCheck,
      },
      timestamp: new Date().toISOString(),
    };
  }

  private async _checkDb(): Promise<{ ok: boolean; responseTimeMs: number | null }> {
    const start = Date.now();
    try {
      await this.db.query('SELECT 1');
      return { ok: true, responseTimeMs: Date.now() - start };
    } catch {
      return { ok: false, responseTimeMs: null };
    }
  }

  private async _checkRedis(): Promise<{ ok: boolean; responseTimeMs: number | null }> {
    const start = Date.now();
    try {
      await this.redis.ping();
      return { ok: true, responseTimeMs: Date.now() - start };
    } catch {
      return { ok: false, responseTimeMs: null };
    }
  }

  private async _checkVasp(): Promise<{ ok: boolean; responseTimeMs: number | null }> {
    const start = Date.now();
    try {
      await this.vaspClient.ping();
      return { ok: true, responseTimeMs: Date.now() - start };
    } catch {
      return { ok: false, responseTimeMs: null };
    }
  }
}
```

```typescript
// router.ts

router.get('/health', async (req, res) => {
  const health = await deployAdmin.getHealth();
  const statusCode = health.status === 'ok' ? 200
                   : health.status === 'degraded' ? 200
                   : 503;
  res.status(statusCode).json(health);
});
```

테스트:

```bash
# 정상 응답
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "version": "1.4.2",
  "uptime": 3600.5,
  "checks": {
    "db":    { "ok": true,  "responseTimeMs": 8 },
    "redis": { "ok": true,  "responseTimeMs": 3 },
    "vasp":  { "ok": true,  "responseTimeMs": 234 }
  },
  "timestamp": "2026-05-03T09:00:00.000Z"
}
```

```bash
# DB 연결 실패 시 → 503 반환
curl -o /dev/null -w "%{http_code}" http://localhost:3000/health
# → 503
```

---

### 실습 2 — 배포 체크리스트 문서 작성 (10분)

```markdown
# 배포 체크리스트 — KyoboNFT 시스템

> 파일: docs/deploy-checklist.md
> 모든 프로덕션 배포 시 이 체크리스트를 출력하여 서명한다.

## 배포 전 체크리스트

### 코드 검증
- [ ] PR 리뷰어 2인 승인 완료
- [ ] CI 빌드 통과 (최신 커밋)
- [ ] 단위 테스트 100% 통과
- [ ] Slither HIGH/CRITICAL 0건

### 컨트랙트 업그레이드 (해당 시)
- [ ] Storage Layout 충돌 없음
      `npx hardhat test --grep "Storage Layout"`
- [ ] reinitializer 버전 확인 (v2 업그레이드 시 reinitializer(2))
- [ ] Sepolia 스테이징 2일+ 검증 완료
- [ ] 기존 tokenId 보존 확인 (스테이징)
- [ ] upgradeToAndCall() 실행 후 롤백 불가 인지 (서명)
      확인자 서명: ____________________

### API 서버 배포
- [ ] /health 엔드포인트 스테이징에서 정상 확인
- [ ] Consumer 일시 중단 필요 여부 판단
      ( ) 필요 — 이유: ____________________
      ( ) 불필요

### 승인
- [ ] 1차 승인: ____________________  (담당 개발자)
- [ ] 2차 승인: ____________________  (서비스 관리자)

배포 예정 시각: ____________________

---

## 배포 후 15분 모니터링 체크리스트

> 배포 완료 즉시 시작. 5분 간격으로 확인.

### [+5분]
- [ ] GET /health → status: ok
- [ ] GET /admin/queue/stats → consumerCount >= 1
- [ ] GET /admin/vasp/stuck → stuckCount: 0

### [+10분]
- [ ] GET /admin/deploy/metrics → errorRate < 1%
- [ ] GET /admin/deploy/metrics → p99 배포 전 대비 2배 이하
- [ ] GET /admin/dlq/pending → 신규 DLQ 없음

### [+15분]
- [ ] 위 모든 지표 정상 → 배포 완료 선언
- [ ] 이상 징후 있으면 → 롤백 판단 카드 사용

---

## 롤백 판단 체크포인트

롤백 트리거 (하나라도 해당 시 즉시 롤백 검토):
- [ ] errorRate > 1%
- [ ] P99 응답시간 2배+ 초과
- [ ] DLQ 5건+ 신규 발생
- [ ] Stuck TX 10건+
- [ ] mint/burn API 503 응답

롤백 실행:
- [ ] 롤백 판단: ____________________  시각: ____
- [ ] 승인 1: ____________________
- [ ] 승인 2: ____________________
- [ ] 이전 버전 재배포: ____  시각: ____
- [ ] 검증 완료: ____  시각: ____
```

---

### 실습 3 — 에러율 모니터링 엔드포인트 (10분)

```typescript
// DeployAdminService.ts 추가

export interface DeployMetrics {
  windowMinutes: number;
  requestCount:  number;
  errorCount:    number;
  errorRate:     number;    // 0~100 (%)
  p99ResponseMs: number | null;
  alerts:        string[];
}

// 슬라이딩 윈도우 메트릭 저장 (인메모리, 실제 운영에서는 Redis)
const requestLog: Array<{ ts: number; durationMs: number; error: boolean }> = [];

export function recordRequest(durationMs: number, error: boolean) {
  requestLog.push({ ts: Date.now(), durationMs, error });
  // 10분 이상 오래된 항목 정리
  const cutoff = Date.now() - 10 * 60 * 1000;
  while (requestLog.length > 0 && requestLog[0].ts < cutoff) {
    requestLog.shift();
  }
}

// DeployAdminService에 추가
async getMetrics(windowMinutes = 5): Promise<DeployMetrics> {
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const recent = requestLog.filter(r => r.ts >= cutoff);

  const requestCount = recent.length;
  const errorCount   = recent.filter(r => r.error).length;
  const errorRate    = requestCount > 0
    ? (errorCount / requestCount) * 100
    : 0;

  // P99 계산 (슬라이딩 윈도우)
  let p99ResponseMs: number | null = null;
  if (recent.length > 0) {
    const sorted = [...recent].sort((a, b) => a.durationMs - b.durationMs);
    const p99Index = Math.floor(sorted.length * 0.99);
    p99ResponseMs = sorted[p99Index]?.durationMs ?? null;
  }

  const alerts: string[] = [];
  if (errorRate > 1) alerts.push(`P1: 에러율 ${errorRate.toFixed(2)}% > 1% — 롤백 검토`);
  if (p99ResponseMs && p99ResponseMs > 10_000) alerts.push(`P2: P99 ${p99ResponseMs}ms 초과`);

  return { windowMinutes, requestCount, errorCount, errorRate, p99ResponseMs, alerts };
}
```

```typescript
// router.ts

router.get('/admin/deploy/metrics', async (req, res) => {
  const windowMinutes = Number(req.query.window) || 5;
  const metrics = await deployAdmin.getMetrics(windowMinutes);
  res.json(metrics);
});
```

테스트:

```bash
# 최근 5분 메트릭
curl http://localhost:3000/admin/deploy/metrics

# 최근 15분 메트릭
curl "http://localhost:3000/admin/deploy/metrics?window=15"
```

```json
{
  "windowMinutes": 5,
  "requestCount": 1024,
  "errorCount": 3,
  "errorRate": 0.293,
  "p99ResponseMs": 842,
  "alerts": []
}
```

에러율 1% 초과 시:

```json
{
  "errorRate": 2.14,
  "alerts": ["P1: 에러율 2.14% > 1% — 롤백 검토"]
}
```

---

## 완료 기준

- [ ] `GET /health` — DB·Redis·VASP 연결 상태 + 버전 정보 포함, 하나라도 실패 시 503 반환
- [ ] `GET /health` — VASP 연결 차단 후 `status: error` + HTTP 503 확인
- [ ] 배포 체크리스트 `docs/deploy-checklist.md` 완성 (컨트랙트 업그레이드 항목 포함)
- [ ] `GET /admin/deploy/metrics` — errorRate, p99, alerts 포함 응답
- [ ] errorRate > 1% → `P1: 에러율 N% — 롤백 검토` 알림 포함 확인
- [ ] 롤백 불가 원칙 설명 가능: 컨트랙트 문제 시 API 서버 롤백으로 대응하는 이유

---

### 운영 체크리스트 — 배포 당일

```
□ 배포 전 2인 승인 확인
□ Consumer 일시 중단 필요 여부 결정

배포 중:
□ 로드밸런서 헬스체크 정상 확인 (GET /health → 200)
□ 이전 인스턴스 graceful shutdown 완료 확인

배포 후 15분 모니터링:
□ +5분: /health, /admin/queue/stats, /admin/vasp/stuck
□ +10분: /admin/deploy/metrics (errorRate < 1%, P99 정상)
□ +10분: /admin/dlq/pending (신규 DLQ 없음)
□ +15분: 정상 → 배포 완료 선언 + 감사 로그 기록
□ +15분: 이상 → 롤백 판단 카드 즉시 사용

롤백 시:
□ 컨트랙트 롤백 불가 원칙 재확인 (API 서버만 롤백)
□ 2인 승인 획득
□ 이전 버전 재배포 → /health 정상 확인
□ 롤백 감사 로그 기록 (이유·판단자·승인자·시각)
```

---

## 워크시트

### 배포 당일 체크리스트 시트

> 배포 당일 이 시트를 출력하여 단계별로 체크한다.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
배포 당일 시트 — YYYY-MM-DD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[배포 정보]
  배포 버전   : ____________________
  배포 유형   : ( ) API 서버  ( ) 컨트랙트 업그레이드  ( ) 둘 다
  배포 담당자 : ____________________
  승인자 1   : ____________________
  승인자 2   : ____________________
  컨트랙트 업그레이드 시 롤백 불가 인지: ( ) 확인

[배포 전 확인]
  Slither CRITICAL/HIGH: ____ 건  (0이어야 배포 가능)
  Storage Layout 충돌  : ( ) 없음  ( ) 있음(배포 불가)
  스테이징 검증 기간   : ____ 일  (2일 이상이어야 배포 가능)

[배포 실행]
  배포 시작 시각: __:__
  배포 완료 시각: __:__

[+5분 확인] 시각: __:__
  /health status       : ( ) ok  ( ) degraded  ( ) error
  consumerCount        : ____
  stuckCount           : ____

[+10분 확인] 시각: __:__
  errorRate            : ____  %  (1% 이상이면 → 롤백 검토)
  P99 응답시간         : ____ ms  (배포 전 P99: ____ ms)
  신규 DLQ             : ____ 건  (0이어야 정상)

[+15분 확인] 시각: __:__
  최종 판정: ( ) 배포 완료 선언 ✅  ( ) 롤백 결정 → 아래 기입

[롤백 기록 (해당 시)]
  롤백 이유        : ____________________________________
  롤백 판단자      : ____________________  시각: __:__
  롤백 승인자 1    : ____________________
  롤백 승인자 2    : ____________________
  이전 버전 배포 완료: __:__
  /health 정상 확인 : __:__
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### 롤백 판단 카드

```
┌─────────────────────────────────────────────────────────┐
│  지금 롤백해야 하는가?                                    │
│                                                          │
│  다음 중 하나라도 해당하면 즉시 롤백 검토:               │
│                                                          │
│  □ errorRate > 1%                               Y / N   │
│  □ P99 응답시간 배포 전 대비 2배 초과            Y / N   │
│  □ 신규 DLQ 5건+ 발생                            Y / N   │
│  □ Stuck TX 10건+ 발생                           Y / N   │
│  □ mint/burn API 503 응답                        Y / N   │
│  □ Consumer 크래시 반복 (3회+)                   Y / N   │
│                                                          │
│  하나라도 Y → 2인 승인 후 즉시 롤백 실행                 │
│                                                          │
│  ⚠️ 컨트랙트 업그레이드였다면:                           │
│    → 컨트랙트 자체 롤백 불가                             │
│    → API 서버 이전 버전으로 롤백 (컨트랙트 호출 차단)    │
│    → 컨트랙트 v(n+1) 긴급 패치 준비 착수               │
└─────────────────────────────────────────────────────────┘
```

---

### 배포 사후 리뷰 시트

> 배포 후 1주일 내 작성.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
배포 사후 리뷰 — ____년 __월 __일 배포
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[결과]
  배포 결과: ( ) 성공  ( ) 롤백 발생
  롤백 발생 시 원인: ____________________________________
  실제 배포 소요 시간: ____ 분

[배포 후 48시간 지표]
  에러율 (평균)  : ____  %
  P99 응답시간   : ____ ms
  DLQ 발생 건수  : ____ 건
  Stuck TX 건수  : ____ 건

[프로세스 개선]
  체크리스트에서 놓친 항목: ____________________________
  다음 배포 시 추가할 사항: ____________________________

[스테이징 검증 충분했는가?]
  ( ) 충분 — 운영 환경 이슈 없음
  ( ) 부족 — 스테이징에서 발견 못한 이슈: ______________
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 자동화 확장 — DeployMonitorService

> 배포 후 자동 모니터링, 임계값 초과 시 자동 알림.

### TypeScript 서비스 클래스 구현

```typescript
// internal/packages/vasp/src/admin/DeployMonitorService.ts

export interface DeployEvent {
  id: string;
  deployedAt: Date;
  version: string;
  deployedBy: string;
  type: 'API' | 'CONTRACT_UPGRADE';
  status: 'MONITORING' | 'STABLE' | 'ROLLED_BACK';
  rollbackAt?: Date;
  rollbackReason?: string;
}

export class DeployMonitorService {
  private monitoringIntervalId: NodeJS.Timer | null = null;

  constructor(
    private readonly deployAdmin: DeployAdminService,
    private readonly db: Database,
    private readonly notifier: NotifierAdapter,
    private readonly auditLog: AuditLogService,
  ) {}

  // 배포 완료 시 호출 — 15분 자동 모니터링 시작
  async startMonitoring(deployEvent: Omit<DeployEvent, 'status'>): Promise<string> {
    const event: DeployEvent = { ...deployEvent, status: 'MONITORING' };

    await this.db.query(
      `INSERT INTO deploy_events (id, deployed_at, version, deployed_by, type, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [event.id, event.deployedAt, event.version, event.deployedBy, event.type, event.status],
    );

    // 5분마다 3회 (15분간) 자동 체크
    let checkCount = 0;
    this.monitoringIntervalId = setInterval(async () => {
      checkCount++;
      await this._runMonitoringCheck(event.id, checkCount);

      if (checkCount >= 3) {
        clearInterval(this.monitoringIntervalId!);
        await this._finalizeMonitoring(event.id);
      }
    }, 5 * 60 * 1000);

    return event.id;
  }

  private async _runMonitoringCheck(deployId: string, round: number): Promise<void> {
    const metrics = await this.deployAdmin.getMetrics(5);
    const health  = await this.deployAdmin.getHealth();

    const alerts = [
      ...metrics.alerts,
      ...(health.status === 'error' ? ['P1: 헬스체크 실패'] : []),
    ];

    if (alerts.length > 0) {
      await this.notifier.sendAlert({
        title:    `[배포 모니터링] 이상 감지 (+${round * 5}분)`,
        severity: 'P1',
        body: [
          `배포 ID: ${deployId}`,
          ...alerts,
          `즉각 롤백 판단 필요`,
        ].join('\n'),
      });
    }
  }

  private async _finalizeMonitoring(deployId: string): Promise<void> {
    await this.db.query(
      `UPDATE deploy_events SET status = 'STABLE' WHERE id = $1`,
      [deployId],
    );
    console.log(`[DeployMonitor] 배포 ${deployId} 15분 모니터링 완료 — STABLE`);
  }

  async recordRollback(deployId: string, operator: string, reason: string): Promise<void> {
    const rollbackAt = new Date();

    await this.db.query(
      `UPDATE deploy_events
       SET status = 'ROLLED_BACK', rollback_at = $1, rollback_reason = $2
       WHERE id = $3`,
      [rollbackAt, reason, deployId],
    );

    await this.auditLog.log({
      actor:      operator,
      action:     'DEPLOY_ROLLBACK',
      resourceId: deployId,
      afterState: { reason, rollbackAt: rollbackAt.toISOString() },
    });
  }
}
```

### 아날로그↔디지털 대응 요약 테이블

| 아날로그 (체크리스트) | 디지털 (API/서비스) | 자동화 여부 |
|---|---|---|
| +5분 지표 확인 | `_runMonitoringCheck(id, 1)` 자동 | ✅ 자동 |
| +10분 지표 확인 | `_runMonitoringCheck(id, 2)` 자동 | ✅ 자동 |
| +15분 최종 판단 | `_finalizeMonitoring(id)` 자동 | ✅ 자동 |
| errorRate 계산 | `GET /admin/deploy/metrics` | 운영자 참조 |
| 롤백 판단·승인 | `recordRollback()` 기록 | 운영자 결정 |
| 헬스체크 확인 | `GET /health` | 운영자 확인 |
| 배포 사후 기록 | `deploy_events` 테이블 자동 저장 | ✅ 자동 |
