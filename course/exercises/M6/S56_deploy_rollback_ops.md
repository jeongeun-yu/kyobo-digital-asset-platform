# S56 운영 실습 — 배포·롤백 운영 · 파이프라인 설계와 무중단 배포 절차

강의 노트: `M6_S56_deploy_rollback_ops.md`
소요 시간: 60분

---

## 목표

- 배포 파이프라인의 4단계 게이트 구조를 이해하고 단계별 통과 조건을 설명할 수 있다
- 배포 후 15분 모니터링 윈도우를 운영하고 롤백 트리거를 판단할 수 있다
- 컨트랙트 롤백 불가 원칙을 이해하고 API 서버 롤백으로 대응하는 절차를 실행할 수 있다
- `/health` 엔드포인트와 `/admin/deploy/metrics`를 구현하고 테스트한다

---

## 배경 — 왜 이 절차가 필요한가

스마트컨트랙트 업그레이드는 되돌릴 수 없다. `upgradeToAndCall()` 실행이 완료되면 이전 Implementation으로 되돌아갈 때 Storage Layout이 다를 수 있어 데이터 파괴 위험이 있다. 따라서 배포 전 검증을 충분히 하고, 배포 후 15분 모니터링으로 조기 이상 징후를 잡는 것이 유일한 대응 수단이다.

---

## Step 1 — 배포 파이프라인 게이트 구조 이해 (10분)

```
[1] 코드 변경 + PR 리뷰
     게이트: 리뷰어 2인 승인
        ↓
[2] CI 자동 검증
     - 빌드 통과
     - 단위 테스트 100% 통과
     - Slither 정적 분석 HIGH/CRITICAL 0건
     - Storage Layout 충돌 없음 (hardhat-upgrades)
     게이트: 모든 CI 항목 통과
        ↓
[3] 스테이징 배포 (Sepolia)
     - 기존 tokenId 보존 확인
     - 신규 기능 동작 확인
     - VASP 연동 테스트
     게이트: 스테이징 검증 최소 2일
        ↓
[4] 프로덕션 배포
     - 배포 당일 체크리스트 서명
     - 배포 후 15분 모니터링 윈도우
     게이트: 2인 승인 + 체크리스트 완료
```

### 실습 1-A — 게이트 실패 시나리오 분석

다음 시나리오 각각에서 배포가 어느 게이트에서 차단되는지 답하라.

```
시나리오 A: Slither가 CRITICAL 취약점 1건 탐지
  → 차단 게이트: _____________
  → 해결 방법:  _____________

시나리오 B: hardhat-upgrades가 "New storage layout is incompatible" 에러 반환
  → 차단 게이트: _____________
  → 해결 방법:  _____________

시나리오 C: 스테이징 배포 후 1일 만에 프로덕션 배포 요청
  → 차단 게이트: _____________
  → 해결 방법:  _____________

시나리오 D: 담당자 1인만 승인한 상태로 프로덕션 배포 시도
  → 차단 게이트: _____________
  → 해결 방법:  _____________
```

---

## Step 2 — `/health` 엔드포인트 구현 (10분)

`dmz/packages/vasp/src/admin/DeployAdminService.ts`에 아래 `getHealth()` 메서드를 구현한다.

### 완성 코드

```typescript
export interface HealthStatus {
  status:    'ok' | 'degraded' | 'error';
  version:   string;
  uptime:    number;
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
    private readonly version: string,
  ) {}

  async getHealth(): Promise<HealthStatus> {
    const [dbCheck, redisCheck, vaspCheck] = await Promise.all([
      this._checkDb(),
      this._checkRedis(),
      this._checkVasp(),
    ]);

    const allOk     = dbCheck.ok && redisCheck.ok && vaspCheck.ok;
    const anyFailed = !dbCheck.ok || !redisCheck.ok || !vaspCheck.ok;

    return {
      status:    allOk ? 'ok' : anyFailed ? 'error' : 'degraded',
      version:   this.version,
      uptime:    process.uptime(),
      checks:    { db: dbCheck, redis: redisCheck, vasp: vaspCheck },
      timestamp: new Date().toISOString(),
    };
  }

  private async _checkDb() {
    const start = Date.now();
    try {
      await this.db.query('SELECT 1');
      return { ok: true, responseTimeMs: Date.now() - start };
    } catch {
      return { ok: false, responseTimeMs: null };
    }
  }

  private async _checkRedis() {
    const start = Date.now();
    try {
      await this.redis.ping();
      return { ok: true, responseTimeMs: Date.now() - start };
    } catch {
      return { ok: false, responseTimeMs: null };
    }
  }

  private async _checkVasp() {
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
  const statusCode = health.status === 'error' ? 503 : 200;
  res.status(statusCode).json(health);
});
```

### 테스트 실행

```bash
# 정상 응답 확인
curl http://localhost:3000/health
# 기대 응답:
# { "status": "ok", "version": "1.x.x", "uptime": ..., "checks": { ... } }

# HTTP 상태 코드 확인
curl -o /dev/null -w "%{http_code}" http://localhost:3000/health
# → 200

# VASP 연결 차단 후 503 확인
# (VASP mock을 실패 상태로 설정 후)
curl -o /dev/null -w "%{http_code}" http://localhost:3000/health
# → 503
```

---

## Step 3 — 에러율 모니터링 엔드포인트 구현 (10분)

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

const requestLog: Array<{ ts: number; durationMs: number; error: boolean }> = [];

export function recordRequest(durationMs: number, error: boolean) {
  requestLog.push({ ts: Date.now(), durationMs, error });
  const cutoff = Date.now() - 10 * 60 * 1000;
  while (requestLog.length > 0 && requestLog[0]!.ts < cutoff) requestLog.shift();
}

// DeployAdminService에 추가
async getMetrics(windowMinutes = 5): Promise<DeployMetrics> {
  const cutoff      = Date.now() - windowMinutes * 60 * 1000;
  const recent      = requestLog.filter(r => r.ts >= cutoff);
  const requestCount = recent.length;
  const errorCount   = recent.filter(r => r.error).length;
  const errorRate    = requestCount > 0 ? (errorCount / requestCount) * 100 : 0;

  let p99ResponseMs: number | null = null;
  if (recent.length > 0) {
    const sorted  = [...recent].sort((a, b) => a.durationMs - b.durationMs);
    const p99Idx  = Math.floor(sorted.length * 0.99);
    p99ResponseMs = sorted[p99Idx]?.durationMs ?? null;
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

### 테스트 실행

```bash
curl http://localhost:3000/admin/deploy/metrics
# 기대 응답:
# { "windowMinutes": 5, "requestCount": ..., "errorRate": ..., "alerts": [] }

# 에러율 1% 초과 시 알림 확인
# (에러 요청 주입 후)
curl http://localhost:3000/admin/deploy/metrics
# 기대: alerts 배열에 "P1: 에러율 N% > 1% — 롤백 검토" 포함
```

---

## Step 4 — 배포 체크리스트 문서 작성 (10분)

`docs/deploy-checklist.md` 파일 생성:

```markdown
# 배포 체크리스트 — KyoboNFT 시스템

> 모든 프로덕션 배포 시 이 체크리스트를 출력하여 서명한다.

## 배포 전

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

## 배포 후 15분 모니터링

### [+5분]
- [ ] GET /health → status: ok
- [ ] GET /admin/queue/stats → consumerCount >= 1
- [ ] GET /admin/vasp/stuck → stuckCount: 0

### [+10분]
- [ ] GET /admin/deploy/metrics → errorRate < 1%
- [ ] GET /admin/deploy/metrics → p99 배포 전 대비 2배 이하
- [ ] GET /admin/dlq/pending → 신규 DLQ 없음

### [+15분]
- [ ] 위 지표 정상 → 배포 완료 선언
- [ ] 이상 징후 → 롤백 판단 카드 사용

---

## 롤백 판단 트리거

다음 중 하나라도 해당하면 즉시 롤백 검토:
- [ ] errorRate > 1%
- [ ] P99 응답시간 배포 전 대비 2배+ 초과
- [ ] DLQ 5건+ 신규 발생
- [ ] Stuck TX 10건+
- [ ] mint/burn API 503 응답

롤백 실행:
- [ ] 롤백 판단: ____________________  시각: ____
- [ ] 승인 1:    ____________________
- [ ] 승인 2:    ____________________
- [ ] 이전 버전 재배포: ____  시각: ____
- [ ] 검증 완료: ____  시각: ____
```

---

## Step 5 — 컨트랙트 롤백 불가 원칙 시뮬레이션 (10분)

### 시나리오: 컨트랙트 v2 배포 후 버그 발견

```
배포 완료: upgradeToAndCall(v2Impl) 실행 → 온체인 기록
버그 발견: +7분, mint() 함수에서 특정 조건에서 amount 2배 발행

잘못된 대응 ❌:
  upgradeToAndCall(v1Impl) 호출
  → v2에서 새 변수(_baseTokenURI)가 slot 6에 기록됨
  → v1으로 되돌리면 slot 6 해석 방식이 달라질 수 있음
  → Storage Collision 위험 → 데이터 파괴 가능

올바른 대응 ✅:
  1. API 서버에서 mint API를 Circuit Breaker OPEN → 컨트랙트 호출 차단
  2. API 서버를 이전 버전으로 롤백 (컨트랙트는 그대로 유지)
  3. 컨트랙트 v3 긴급 패치 준비 → 스테이징 최소 검증 후 재업그레이드
```

### Circuit Breaker 수동 OPEN 예시

```bash
# Redis에 Circuit Breaker 강제 OPEN 설정
redis-cli SET "cb:kyobo-nft-mint" "OPEN" EX 3600

# 또는 환경변수로 제어 (즉시 적용)
curl -X POST http://localhost:3000/admin/circuit-breaker/mint/open \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### API 서버 롤백 (PM2)

```bash
# 현재 버전 확인
pm2 list

# 이전 버전으로 롤백
pm2 reload kyobo-vasp --update-env

# 또는 특정 버전 지정
npm install kyobo-vasp@1.4.1
pm2 restart kyobo-vasp

# 롤백 후 헬스체크 확인
curl http://localhost:3000/health
# → status: ok 확인
```

---

## Step 6 — Graceful Shutdown 구현 확인 (5분)

```typescript
// 무중단 배포를 위한 SIGTERM 핸들러
process.on('SIGTERM', async () => {
  console.log('SIGTERM 수신. Graceful shutdown 시작...');

  // 로드밸런서에서 이 인스턴스 제거 (새 요청 차단)
  server.close();

  // 처리 중인 요청 완료 대기 (최대 30초)
  await new Promise(resolve => setTimeout(resolve, 30_000));

  // Consumer 안전 종료
  await consumerWorker.gracefulStop();

  process.exit(0);
});
```

### 테스트

```bash
# 프로세스에 SIGTERM 전송
kill -TERM $(pgrep -f kyobo-vasp)

# 30초 이내 처리 중인 요청이 완료되는지 확인
# 새 요청이 차단되는지 확인 (로드밸런서 로그)
```

---

## 완료 기준

- [ ] `GET /health` — DB·Redis·VASP 연결 상태 + 버전 정보 포함, VASP 차단 시 503 반환
- [ ] `GET /admin/deploy/metrics` — errorRate, p99, alerts 포함 응답
- [ ] errorRate > 1% → `P1: 에러율 N% — 롤백 검토` 알림 포함 확인
- [ ] `docs/deploy-checklist.md` 완성 (컨트랙트 업그레이드 항목 포함)
- [ ] 롤백 불가 원칙 구두 설명 가능: "컨트랙트 문제 시 API 서버 롤백 + v3 긴급 패치"
- [ ] 배포 파이프라인 4단계 게이트와 통과 조건 설명 가능
- [ ] 배포 후 15분 모니터링 절차 설명 가능
- [ ] Step 1-A 시나리오 4개 답 작성 완료

---

## 롤백 판단 카드

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
│  컨트랙트 업그레이드였다면:                              │
│    → 컨트랙트 자체 롤백 불가                             │
│    → API 서버 이전 버전으로 롤백 (컨트랙트 호출 차단)    │
│    → 컨트랙트 v(n+1) 긴급 패치 준비 착수               │
└─────────────────────────────────────────────────────────┘
```

---

## 아날로그 ↔ 디지털 대응

| 아날로그 (체크리스트) | 디지털 (API/서비스) |
|---|---|
| +5분 지표 확인 | `GET /health` + `GET /admin/queue/stats` |
| +10분 에러율 확인 | `GET /admin/deploy/metrics?window=5` |
| +15분 최종 판단 | 운영자 판단 → `recordRollback()` 기록 |
| 롤백 판단·승인 | 2인 서명 → PM2 롤백 명령 |
| 감사 로그 기록 | `deploy_events` 테이블 자동 저장 |
