# M2 S51 — DLQ 운영 절차 · 재큐잉 판단 기준과 드랍 정책 설계

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(월렛원) 위탁 아키텍처를 기반으로 합니다.

> 모듈 2 · 세션 51 · 1시간 `운영`  
> 전제: S11에서 DLQHandler 구현 완료, `kyobo:events:dlq` 스트림 운영 중  
> 스켈레톤: `internal/packages/event-engine/src/admin/DLQAdminService.ts`

> ⚠️ **운영 세션** — 코드 구현이 아닌 운영 판단 기준과 절차를 다룬다. S11에서 DLQ가 왜 필요한지, 어떻게 작동하는지는 이미 배웠다. 이번 세션은 **운영자가 실제로 DLQ 앞에 섰을 때 무엇을 어떻게 결정하는가**다.

---

## 강의 파트 (25분)

### 1. "DLQ에 메시지가 왔다" — 운영자의 첫 질문 (8분)

S11에서 배운 DLQ 사이클:

```
3회 실패 → DLQ 격리 → 운영팀 알림
```

알림을 받은 운영자는 세 가지 행동 중 하나를 선택해야 한다.

```
┌─────────────────────────────────────────────────────────┐
│  DLQ 도착 시 운영자 판단 트리                            │
│                                                          │
│  메시지 수신                                             │
│       │                                                  │
│       ▼                                                  │
│  원인 파악 (listPending + 로그 조회)                     │
│       │                                                  │
│       ├── 일시적 외부 장애 (VASP 다운, DB 일시 불가)    │
│       │     → 장애 복구 확인 후 requeue ✅              │
│       │                                                  │
│       ├── 영구 실패 (코드 버그, 스키마 불일치)           │
│       │     → 코드 수정 + 배포 후 requeue ✅            │
│       │                                                  │
│       └── 드랍 대상 (파싱 불가, 이미 처리됨, TTL 초과)  │
│             → drop (감사 로그 기록 후 삭제) ❌           │
└─────────────────────────────────────────────────────────┘
```

**핵심 원칙: DLQ는 "일단 requeue"가 아니다.**  
원인을 모른 채 requeue하면 → 또 실패 → 또 DLQ → 무한 루프.  
반드시 원인 파악 → 조치 → requeue 순서를 지킨다.

---

### 2. 재큐잉 vs 드랍 판단 기준 (10분)

#### 재큐잉 (requeue) 대상

| 조건 | 판단 근거 | 조치 순서 |
|------|----------|----------|
| 일시적 외부 장애 | `_reason`에 timeout/connection refused | 장애 복구 확인 → requeue |
| 코드 버그 수정됨 | 배포 이력 확인 + 테스트 통과 | 배포 완료 후 requeue |
| 데이터 정정 완료 | DM or 관련 시스템 확인 | 정정 확인 후 requeue |

#### 드랍 (drop) 대상

| 조건 | 판단 근거 | 주의사항 |
|------|----------|---------|
| 파싱 불가 메시지 | `_reason`에 JSON parse error / unknown field | 발신 시스템에 포맷 오류 통보 |
| 이미 원장에 반영됨 | `processed_events` 테이블에 동일 txHash+logIndex 존재 | 멱등성 처리 완료된 것 — 드랍 안전 |
| TTL 초과 (비즈니스) | 이벤트 발생 시각 기준 N시간 초과, 처리해도 무의미 | 금융 이벤트는 TTL 길게 설정 권장 |
| 테스트/장애 주입 데이터 | `eventType`에 test_ prefix 등 | 운영 환경 유입 방지 프로세스 점검 |

**드랍은 되돌릴 수 없다.** 드랍 전 반드시:
1. 감사 로그에 드랍 이유 기록
2. 드랍 대상 메시지 전체 내용 별도 백업 (S3 또는 별도 DB)
3. 2인 확인 원칙 적용 (금융 시스템 내부 통제)

---

### 3. 알림 설계 — 언제 누구에게 무엇을 (7분)

DLQ는 알림이 없으면 무용지물이다. 메시지가 격리됐는데 아무도 모르면 원장이 계속 틀린 상태로 유지된다.

#### 알림 단계

```
1건 DLQ 적재
  → 담당자 Slack DM + 채널 알림
  → 내용: 메시지 ID, 이벤트 타입, 실패 원인

5건 이상 누적 (10분 내)
  → 팀 채널 @ 채널 태그
  → 의미: 단발성이 아닌 반복 장애 가능성

20건 이상 누적
  → 서비스 관리자 즉시 호출 (PagerDuty 또는 전화)
  → 의미: 대량 장애, 시스템 전반 영향 가능성
```

#### 알림 메시지 필수 항목

```
[DLQ 알림] 처리 실패 메시지 격리
────────────────────────────────
DLQ ID     : 1714320000000-0
이벤트 타입 : NFT_MINTED
원인        : VASP timeout after 30s
발생 시각   : 2026-05-04T01:23:45Z
현재 DLQ 수 : 3건
────────────────────────────────
조회: GET /admin/dlq/pending
```

원인과 현재 누적 건수를 함께 보내야 운영자가 즉시 심각도를 판단할 수 있다.

---

## 실습 파트 (30분)

### 실습 1 — DLQ 조회 CLI (10분)

`DLQAdminService.listPending()`은 S11의 `DLQHandler.listPending()`을 그대로 사용한다. 이번 실습은 **운영자가 실제로 쓸 수 있는 출력 형식**을 만드는 것이다.

```typescript
// internal/packages/event-engine/src/admin/DLQAdminService.ts

export class DLQAdminService {
  constructor(
    private readonly dlqHandler: DLQHandler,
    private readonly db: Database,
    private readonly auditLog: AuditLogService,
  ) {}

  async listPending(options?: { eventType?: string; limit?: number }) {
    const all = await this.dlqHandler.listPending(options?.limit ?? 100);

    const filtered = options?.eventType
      ? all.filter(item => item.event['eventType'] === options.eventType)
      : all;

    return filtered.map(item => ({
      dlqId:     item.messageId,
      eventType: item.event['eventType'] ?? 'unknown',
      reason:    item.reason,
      failedAt:  item.failedAt,
      // 이미 원장에 반영됐는지 힌트
      txHash:    item.event['txHash'] ?? null,
    }));
  }
}
```

CLI 테스트:

```bash
# 전체 조회
curl http://localhost:3000/admin/dlq/pending

# 이벤트 타입 필터
curl "http://localhost:3000/admin/dlq/pending?eventType=NFT_MINTED"
```

기대 출력:

```json
[
  {
    "dlqId": "1714320000000-0",
    "eventType": "NFT_MINTED",
    "reason": "VASP timeout after 30s",
    "failedAt": "2026-05-04T01:23:45.000Z",
    "txHash": "0xabc123..."
  }
]
```

---

### 실습 2 — 수동 재큐잉 명령 (10분)

```typescript
// DLQAdminService.ts

async requeue(
  dlqId: string,
  operator: string,
  reason: string,
): Promise<{ newMessageId: string }> {
  // 1. 이미 원장에 반영됐는지 확인 (드랍해야 할 케이스 방어)
  const items = await this.dlqHandler.listPending();
  const target = items.find(i => i.messageId === dlqId);
  if (!target) throw new Error(`DLQ 메시지 없음: ${dlqId}`);

  const txHash = target.event['txHash'];
  if (txHash) {
    const alreadyProcessed = await this.db.query(
      `SELECT 1 FROM processed_events WHERE tx_hash = $1 LIMIT 1`,
      [txHash],
    );
    if (alreadyProcessed.rows.length > 0) {
      throw new Error(
        `이미 원장에 반영된 이벤트입니다. requeue 대신 drop을 사용하세요. txHash: ${txHash}`,
      );
    }
  }

  // 2. 재큐잉 실행
  const result = await this.dlqHandler.requeueMessage(dlqId);

  // 3. 감사 로그 기록 (운영 행위는 반드시 추적)
  await this.auditLog.append(
    operator,
    'DLQ_REQUEUE',
    dlqId,
    { newMessageId: result.newMessageId, reason },
  );

  return result;
}
```

테스트:

```bash
curl -X POST http://localhost:3000/admin/dlq/requeue \
  -H "Content-Type: application/json" \
  -d '{
    "dlqId": "1714320000000-0",
    "operator": "kim@kyobo.com",
    "reason": "VASP 장애 복구 확인 후 재처리"
  }'
```

---

### 실습 3 — 드랍 명령 (감사 로그 필수) (10분)

```typescript
// DLQAdminService.ts

async drop(
  dlqId: string,
  operator: string,
  reason: string,
): Promise<void> {
  const items = await this.dlqHandler.listPending();
  const target = items.find(i => i.messageId === dlqId);
  if (!target) throw new Error(`DLQ 메시지 없음: ${dlqId}`);

  // 드랍 전: 메시지 전체 내용 감사 로그에 백업
  await this.auditLog.append(
    operator,
    'DLQ_DROP',
    dlqId,
    {
      reason,
      originalEvent: target.event,    // 전체 페이로드 보존
      originalReason: target.reason,
      failedAt: target.failedAt,
    },
  );

  // 실제 삭제
  await this.dlqHandler.drop(dlqId);
}
```

`DLQHandler.drop()` 추가 (S11 스켈레톤에 미구현):

```typescript
// DLQHandler.ts에 추가
async drop(dlqMessageId: string): Promise<void> {
  const deleted = await this.redis.xdel(this.dlqStreamKey, dlqMessageId);
  if (deleted === 0) throw new DLQMessageNotFoundError(dlqMessageId);
}
```

드랍 테스트:

```bash
curl -X DELETE http://localhost:3000/admin/dlq/drop \
  -H "Content-Type: application/json" \
  -d '{
    "dlqId": "1714320000000-0",
    "operator": "kim@kyobo.com",
    "reason": "이미 원장에 반영됨 (processed_events 확인)"
  }'
```

감사 로그에서 확인:

```typescript
// drop 후 감사 로그 조회로 드랍 근거 추적 가능
const log = await auditLog.query({ action: 'DLQ_DROP', resourceId: dlqId });
console.log(log[0].afterState); // 전체 원본 페이로드 포함
```

---

## 완료 기준

- [ ] `GET /admin/dlq/pending` — 전체 목록 및 이벤트 타입 필터 동작
- [ ] `POST /admin/dlq/requeue` — 재큐잉 후 DLQ 건수 1 감소 확인
- [ ] `POST /admin/dlq/requeue` — 이미 원장에 반영된 txHash → 에러 응답 확인
- [ ] `DELETE /admin/dlq/drop` — 드랍 후 DLQ 건수 1 감소 + 감사 로그에 원본 페이로드 기록 확인
- [ ] 재큐잉·드랍 모두 감사 로그에 operator 필드 포함 확인

---

### 운영 체크리스트 — DLQ 알림 수신 시

```
□ /admin/dlq/pending 조회 → 건수·이벤트 타입·원인 파악
□ _reason 분석
    ├── timeout/connection → 외부 장애 여부 확인 (/admin/vasp/health)
    ├── parse error → 발신 시스템 포맷 오류
    └── business rule → 코드 버그 또는 데이터 이상
□ txHash 있으면 → processed_events 조회 → 이미 처리됐으면 drop
□ 원인 미해소 → requeue 금지. 원인 해소 후 requeue
□ drop 시 반드시 감사 로그에 이유 기록 (2인 확인 권장)
□ requeue 후 Consumer 처리 결과 5분 내 확인
    ├── XACK → 정상 ✅
    └── 또 DLQ → 즉시 에스컬레이션 (원인 파악 불충분)
```

---

## 워크시트

### DLQ 메시지 분석 워크시트

> DLQ 알림 수신 시 이 시트를 채우면서 판단한다. 채우는 과정 자체가 원인 분석이다.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DLQ 메시지 분석 시트
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[기본 정보]
  수신 시각  : ____________________
  DLQ ID    : ____________________
  이벤트 타입: ____________________
  실패 시각  : ____________________
  현재 DLQ 수: ____ 건

[원인 분석]
  _reason 내용:
  ____________________________________________

  원인 분류 (해당 항목에 V):
  ( ) 일시적 외부 장애  → 외부 서비스명: ________________
  ( ) 코드 버그         → 버그 위치 추정: ________________
  ( ) 스키마/파싱 오류  → 어떤 필드: ____________________
  ( ) 비즈니스 규칙 위반→ 어떤 규칙: ____________________
  ( ) 기타             → 설명: __________________________

[원장 중복 확인]
  txHash 존재 여부: ( ) 있음  ( ) 없음
  txHash 값: ____________________
  processed_events 조회 결과:
  ( ) 이미 반영됨 → drop 대상
  ( ) 미반영     → 재처리 대상

[조치 결정]
  결정 (해당 항목에 V):
  ( ) requeue
      - 조치 완료 내용: ______________________________
      - 재처리 가능한 이유: __________________________
  ( ) drop
      - drop 이유: ___________________________________
      - 2차 확인자: ___________________________________

[실행 기록]
  실행 시각: ____________________
  실행자 ID: ____________________
  실행 명령: ( ) POST /admin/dlq/requeue
             ( ) DELETE /admin/dlq/drop
  결과:
  ( ) requeue 성공 → 새 메시지 ID: ________________
  ( ) drop 성공
  ( ) 실패 → 에러 내용: __________________________

[사후 확인 (5분 후)]
  Consumer 처리 결과:
  ( ) XACK 정상 완료 ✅
  ( ) 또 DLQ 진입 → 에스컬레이션 필요 ⚠️
  ( ) drop이어서 확인 불필요 ✅
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### requeue vs drop 판단 카드 (빠른 참조)

> 분석 시간이 없을 때 아래 카드만 보고 결정한다.

```
┌─────────────────────────────────────────────────────────┐
│  REQUEUE 해도 되는가?                                    │
│                                                          │
│  다음을 모두 확인하라:                                   │
│                                                          │
│  ① processed_events에 같은 txHash가 없다          Y / N │
│  ② 실패 원인이 해소됐다 (장애 복구 / 코드 배포)   Y / N │
│  ③ requeue하면 성공할 것이라는 근거가 있다        Y / N │
│                                                          │
│  셋 다 Y → requeue 가능                                  │
│  하나라도 N → drop 검토 또는 원인 해소 후 재판단         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  DROP 해도 되는가?                                       │
│                                                          │
│  다음 중 하나라도 해당하면 drop 가능:                    │
│                                                          │
│  ① processed_events에 같은 txHash가 이미 있다      Y / N│
│  ② 파싱 불가 메시지 (원본 데이터 자체 손상)        Y / N│
│  ③ TTL 초과 — 처리해도 비즈니스 효과 없음          Y / N│
│  ④ 테스트/장애주입 데이터가 운영에 유입됨          Y / N│
│                                                          │
│  drop 전 필수:                                           │
│  □ 감사 로그에 이유 기록 (API가 자동 처리)              │
│  □ 2차 확인자 서명                                       │
└─────────────────────────────────────────────────────────┘
```

---

### 주간 DLQ 리뷰 시트

> 매주 월요일 오전, 지난주 DLQ 패턴을 리뷰한다. 반복 패턴은 코드/인프라 개선 신호다.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
주간 DLQ 리뷰 — ____년 __월 __일(월) ~ __월 __일(일)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[집계]
  총 DLQ 적재 건수: ____ 건
  requeue 건수    : ____ 건
  drop 건수       : ____ 건
  2회 이상 DLQ 진입 건수: ____ 건  ← 이게 많으면 코드 문제

[원인 분포]
  외부 장애(timeout/conn): ____ 건  (____ %)
  코드 버그              : ____ 건  (____ %)
  파싱 오류              : ____ 건  (____ %)
  멱등성(이미 반영됨)    : ____ 건  (____ %)
  기타                   : ____ 건  (____ %)

[반복 패턴]
  이번 주 동일 원인으로 3회 이상 발생한 케이스:
  ____________________________________________
  ____________________________________________

[개선 과제]
  □ ______________________________________ (담당: ____)
  □ ______________________________________ (담당: ____)

[다음 주 모니터링 포인트]
  ____________________________________________
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 자동화 확장 — IncidentService

> 위 워크시트의 디지털 버전. 아날로그 시트는 개념 학습용으로 유지하고, 실제 운영은 아래 API로 처리한다.

### 설계 원칙

워크시트에서 **운영자가 직접 채워야 했던 항목**을 두 종류로 분리한다.

```
자동 수집 가능 (API 조회로 채움)    운영자 판단 필요 (직접 입력)
────────────────────────────────    ──────────────────────────────
queueStats 스냅샷                   원인 분류
dlqItems 목록                       requeue / drop 결정
processed_events 중복 여부          drop 이유
인시던트 감지 시각                  2차 확인자
```

운영자는 판단이 필요한 부분만 입력하면 된다. 나머지는 시스템이 채운다.

---

### 인터페이스 설계

```typescript
// internal/packages/event-engine/src/admin/IncidentService.ts

export type IncidentType = 'DLQ' | 'CONSUMER_CRASH' | 'LAG' | 'REDIS_DOWN' | 'IDEMPOTENCY';
export type IncidentStatus = 'OPEN' | 'INVESTIGATING' | 'RESOLVED';
export type DLQDecision = 'REQUEUE' | 'DROP' | 'PENDING';

export interface IncidentAction {
  at: Date;
  operator: string;
  action: string;          // 'REQUEUE' | 'DROP' | 'RESTART_CONSUMER' | 'ESCALATE' | ...
  targetId?: string;       // dlqId 또는 대상 리소스
  note: string;
}

export interface Incident {
  id: string;              // UUID
  type: IncidentType;
  status: IncidentStatus;
  detectedAt: Date;
  resolvedAt?: Date;

  // 인시던트 생성 시 자동 스냅샷
  snapshot: {
    queueStats: ConsumerStats;
    dlqItems: Array<{
      dlqId: string;
      eventType: string;
      reason: string;
      failedAt: Date;
      txHash?: string;
      alreadyInLedger?: boolean;   // processed_events 조회 결과 자동 채움
    }>;
  };

  // 운영자 입력
  rootCause?: string;
  actions: IncidentAction[];
  resolvedBy?: string;
  resolutionNote?: string;
}
```

---

### IncidentService 구현

```typescript
// internal/packages/event-engine/src/admin/IncidentService.ts

export class IncidentService {
  constructor(
    private readonly db: Database,
    private readonly consumerMonitor: ConsumerMonitorService,
    private readonly dlqAdmin: DLQAdminService,
    private readonly notifier: NotifierAdapter,   // S52에서 정의
  ) {}

  // 인시던트 생성 — 현재 상태 자동 스냅샷
  async create(type: IncidentType, detectedBy: string): Promise<Incident> {
    // 1. 현재 상태 자동 수집
    const [queueStats, rawDlqItems] = await Promise.all([
      this.consumerMonitor.getStats(),
      this.dlqAdmin.listPending(),
    ]);

    // 2. DLQ 항목별 원장 중복 여부 자동 확인
    const dlqItems = await Promise.all(
      rawDlqItems.map(async item => {
        let alreadyInLedger = false;
        if (item.txHash) {
          const row = await this.db.query(
            `SELECT 1 FROM processed_events WHERE tx_hash = $1 LIMIT 1`,
            [item.txHash],
          );
          alreadyInLedger = row.rows.length > 0;
        }
        return { ...item, alreadyInLedger };
      }),
    );

    // 3. DB 저장
    const incident: Incident = {
      id: crypto.randomUUID(),
      type,
      status: 'OPEN',
      detectedAt: new Date(),
      snapshot: { queueStats, dlqItems },
      actions: [{
        at: new Date(),
        operator: detectedBy,
        action: 'INCIDENT_OPENED',
        note: `${type} 인시던트 자동 감지`,
      }],
    };

    await this.db.query(
      `INSERT INTO incidents (id, type, status, detected_at, snapshot, actions)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [incident.id, incident.type, incident.status,
       incident.detectedAt, JSON.stringify(incident.snapshot),
       JSON.stringify(incident.actions)],
    );

    // 4. 알림 발송 (채널은 NotifierAdapter가 결정)
    await this.notifier.sendIncidentAlert(incident);

    return incident;
  }

  // 조치 기록 — requeue/drop 등 모든 운영 행위를 인시던트에 연결
  async addAction(
    incidentId: string,
    action: Omit<IncidentAction, 'at'>,
  ): Promise<void> {
    const entry: IncidentAction = { ...action, at: new Date() };

    await this.db.query(
      `UPDATE incidents
       SET actions = actions || $1::jsonb,
           status  = 'INVESTIGATING'
       WHERE id = $2`,
      [JSON.stringify([entry]), incidentId],
    );
  }

  // 인시던트 종료
  async resolve(
    incidentId: string,
    operator: string,
    resolutionNote: string,
  ): Promise<void> {
    const resolvedAt = new Date();

    await this.db.query(
      `UPDATE incidents
       SET status           = 'RESOLVED',
           resolved_at      = $1,
           resolved_by      = $2,
           resolution_note  = $3
       WHERE id = $4`,
      [resolvedAt, operator, resolutionNote, incidentId],
    );

    await this.notifier.sendIncidentResolved(incidentId, resolutionNote);
  }
}
```

---

### API 엔드포인트

```typescript
// admin/router.ts 추가

// 인시던트 생성 (알림 수신 시 즉시 호출)
router.post('/admin/incidents', async (req, res) => {
  const { type, detectedBy } = req.body;
  const incident = await incidentService.create(type, detectedBy);
  res.json(incident);
  // 응답에 snapshot.dlqItems[].alreadyInLedger 포함
  // → 운영자가 drop/requeue 판단을 즉시 내릴 수 있는 정보 제공
});

// 조치 추가
router.post('/admin/incidents/:id/actions', async (req, res) => {
  const { operator, action, targetId, note } = req.body;
  await incidentService.addAction(req.params.id, { operator, action, targetId, note });
  res.json({ ok: true });
});

// 종료
router.post('/admin/incidents/:id/resolve', async (req, res) => {
  const { operator, resolutionNote } = req.body;
  await incidentService.resolve(req.params.id, operator, resolutionNote);
  res.json({ ok: true });
});

// 목록 조회 (주간 리뷰용)
router.get('/admin/incidents', async (req, res) => {
  const { from, to, type, status } = req.query;
  // DB 조회 후 반환 (WeeklyReportService에서도 사용)
  ...
});
```

---

### 사용 흐름 (기존 워크시트와 대응)

```
[워크시트 1단계: 초기 상태 확인]
  → POST /admin/incidents { type: 'DLQ', detectedBy: 'alert-bot' }
    응답에 queueStats + dlqItems (alreadyInLedger 포함) 자동 채워짐

[워크시트 3단계: 원인 파악 + 4단계: 조치]
  → POST /admin/incidents/:id/actions
    { operator: 'kim@kyobo.com', action: 'DROP', targetId: '1714320-0',
      note: 'alreadyInLedger=true 확인. 원장 정상, 중복 이벤트 드랍' }

[워크시트 5단계: 사후 확인 + 6단계: 기록]
  → POST /admin/incidents/:id/resolve
    { operator: 'kim@kyobo.com', resolutionNote: '중복 이벤트 드랍 완료. 재발 방지: 발신 시스템 중복 발행 원인 조사 중' }
```

