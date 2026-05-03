# M8 S57 — 업그레이드 거버넌스 운영 · Safe 제안·서명·실행 절차 관리

> 모듈 8 · 세션 57 · 1시간 `운영`
> 전제: S46 Gnosis Safe 배포 완료, S48 KeyGovernanceService 구현 완료
> 스켈레톤: `dmz/packages/vasp/src/admin/UpgradeGovernanceAdminService.ts`
> ⚠️ Phase 구분 — Phase 1: 보조키로 서명 참여. Phase 3: 주키까지 직접 보관

> ⚠️ **운영 세션** — S46에서 Gnosis Safe가 왜 필요한지, S47에서 EIP-712 SafeTx 서명 방식을, S48에서 KeyGovernanceService 전체 구현을 배웠다. 이번 세션은 **그 코드가 실제 운영 환경에서 어떻게 돌아가는가**다. 제안부터 실행까지 사람이 개입해야 하는 지점, 서명자가 부재일 때 어떻게 하는가, 업그레이드 후 무엇을 반드시 확인해야 하는가를 다룬다.

---

## 강의 파트 (25분)

### 1. 업그레이드 거버넌스 전체 절차 (10분)

S48에서 구현한 KeyGovernanceService는 제안 → 서명 → 실행의 기술 레이어다. 운영은 그 위에 사람이 개입하는 레이어를 추가한다.

**전체 절차 (코드 변경부터 프로덕션 실행까지):**

```
┌───────────────────────────────────────────────────────────────┐
│  업그레이드 거버넌스 전체 흐름                                  │
│                                                               │
│  [1] 코드 변경 + PR 리뷰 (개발팀)                             │
│       게이트: 리뷰어 2인 승인                                  │
│          ↓                                                    │
│  [2] 보안 감사                                                 │
│       - Slither 정적 분석 CRITICAL/HIGH 0건                   │
│       - Storage Layout 충돌 없음                              │
│       - reinitializer 버전 확인                               │
│       게이트: 감사 보고서 발행                                 │
│          ↓                                                    │
│  [3] 테스트넷 검증 (Sepolia) — 최소 2주                       │
│       - 기존 데이터 보존 확인                                  │
│       - 신규 기능 동작 확인                                    │
│       - 연동 테스트 (Consumer, VASP, 원장)                    │
│       게이트: 검증 기간 2주 이상 + 이슈 없음                  │
│          ↓                                                    │
│  [4] Safe 제안 생성                                           │
│       - KeyGovernanceService.proposeTx() 호출                │
│       - upgradeToAndCall(newImpl, data) TX 제안               │
│       - DB 저장 + 서명자 3인 알림                             │
│          ↓                                                    │
│  [5] 서명 수집 (2-of-3)                                       │
│       서명자 A (VASP): 기술 검토 + AWS KMS 서명               │
│       서명자 B (교보 IT): 운영 승인 + HSM 서명                │
│       서명자 C (준법감시): 컴플라이언스 확인 + 오프라인 HSM   │
│       상태: PENDING_SIGNATURES → READY_TO_EXECUTE             │
│          ↓                                                    │
│  [6] 프로덕션 실행                                             │
│       - Safe.execTransaction() 온체인 전송                    │
│       - 업그레이드 완료 확인 (기존 tokenId, 신규 기능)         │
│       - 감사 로그 기록                                         │
└───────────────────────────────────────────────────────────────┘
```

**각 단계의 게이트 조건 — 조건 미충족 시 다음 단계 진행 불가:**

| 단계 | 게이트 조건 | 위반 시 |
|------|-----------|---------|
| [2] 보안 감사 | Slither HIGH 0건, Storage 충돌 없음 | [4] 제안 생성 불가 |
| [3] 스테이징 | 2주 이상 + 이슈 없음 | [4] 제안 생성 불가 |
| [5] 서명 | 2-of-3 (threshold=2) | [6] 실행 불가 |
| [6] 실행 | READY_TO_EXECUTE 상태 | TX 실행 불가 |

**SafeTx 생명주기 — S47 재확인:**

```typescript
// S48에서 구현한 상태 전이
PENDING_SIGNATURES
  → 서명 1개 수집 (1/2)
  → 서명 2개 수집 (2/2, threshold 도달)
READY_TO_EXECUTE
  → executeTx() 호출
EXECUTED
```

**제안 생성부터 실행까지 예상 시간:**

```
[4] 제안 생성:           즉시 (API 호출)
[5] 서명 수집:           1~5 영업일
     → 서명자 A: 기술 검토 시간 (하루)
     → 서명자 B: 운영 승인 절차 (1~2 영업일)
     → 2-of-3이므로 C 부재 시 A+B로 진행 가능
[6] 실행:                서명자 중 한 명이 가스 부담
총 예상: 최소 2~3 영업일
```

---

### 2. 서명자 역할 운영 (8분)

S46에서 서명자 구성을 배웠다. 운영에서는 각 서명자의 실제 절차와 부재 시 대응이 중요하다.

**서명자별 실제 운영 절차:**

```
서명자 A — VASP (기술 실행)
  역할: 기술적 타당성 검토 + 서명
  키 보관: AWS KMS (Phase 1: VASP 측)
  서명 방식: 자동화 가능 (AWS KMS API로 서명)
  검토 기준:
    □ 코드 변경이 제안 내용과 일치하는가
    □ Storage Layout 충돌 없는가
    □ 실행 calldata가 올바른가 (upgradeToAndCall 파라미터)

서명자 B — 교보 IT (운영 승인)
  역할: 운영 영향 검토 + 서명
  키 보관: 사내 HSM
  서명 방식: 검토 후 수동 서명
  검토 기준:
    □ 배포 시각이 저트래픽 시간대인가 (새벽 2~4시)
    □ 예상 다운타임 및 영향 범위 확인
    □ 롤백 계획 수립 여부

서명자 C — 준법감시 (컴플라이언스)
  역할: 규제 준수 확인 + 서명
  키 보관: 오프라인 HSM (비상용)
  서명 방식: 물리적 접근 후 수동 서명
  검토 기준:
    □ 변경 내용이 가상자산법 요건 충족하는가
    □ 이용자 영향 공지 필요한가
    □ 금융당국 사전 보고 대상인가
```

**서명자 부재 시 대응:**

```
일반 케이스: C 부재 (평일 야간, 주말)
  → A + B로 2-of-3 달성 가능
  → 진행 가능

비상 케이스: B + C 동시 부재 (사고, 여행)
  → swapOwner 필요 (대리인 지정)
  → swapOwner 자체가 Safe TX → 2-of-3 필요
  → 사전 대리인 지정 절차 필수 (운영 정책)

Phase 1 특이사항:
  → 서명자 A의 키는 VASP(월렛원)가 보관
  → Phase 3 전환 시 당사가 주키 직접 보관
  → 현재는 VASP 협조 없이 A 서명 불가
```

**swapOwner가 필요한 경우와 임시 위임의 차이:**

```
swapOwner TX:
  → Safe 컨트랙트의 소유자 교체
  → 온체인 영구 반영
  → 본인이 서명자에서 제외됨

임시 위임 (키 공유):
  → 운영 정책상 금지
  → 개인 키 공유 = 멀티시그 의미 없음
  → 비상 시에도 swapOwner TX를 사용해야 함
```

---

### 3. 업그레이드 전·후 필수 체크리스트 (7분)

업그레이드는 온체인에 영구 기록된다. 실수는 되돌릴 수 없다.

**업그레이드 전:**

```typescript
// 1. Storage Layout 충돌 검증 (S40에서 배운 내용)
// hardhat-upgrades가 이전 버전과 새 버전 비교
await upgrades.validateUpgrade(proxyAddress, KyoboNFTV2Factory);
// 통과하면 충돌 없음, 실패하면 배포 절대 금지

// 2. reinitializer 버전 확인
// v1 → v2 업그레이드: @reinitializer(2) 어노테이션 확인
// 이미 실행된 initializer 재실행 방지

// 3. Sepolia 스테이징에서 실제 테스트
// - 기존 사용자 tokenId 보존 확인
// - 신규 기능 (예: 새 eventType) 동작 확인
// - Consumer가 새 이벤트 처리 가능한지 확인
```

**⚠️ 롤백 불가 인지:**

```
upgradeToAndCall(newImpl, initData) 실행 직전 최종 확인:
  → 이 TX가 블록에 포함되면 즉시 적용됨
  → 이전 Implementation으로 되돌릴 수 없음
  → Storage 데이터는 새 Implementation 기준으로 해석됨
  → 문제 발생 시 v(n+1)을 빠르게 준비해서 재업그레이드

서명자 3인 모두 이 사실을 인지하고 서명해야 함
```

**업그레이드 후:**

```
□ 기존 tokenId 보존: balanceOf(기존 사용자) 배포 전과 동일
□ 신규 기능 동작: 신규 eventType mint/burn 테스트 TX 실행
□ VASP 연동: Consumer가 신규 이벤트 정상 처리 확인
□ 감사 로그: S26 AuditLogService에 업그레이드 완료 기록
□ Etherscan 검증: 새 Implementation 주소 등록 (S39 절차)
```

---

## 실습 파트 (30분)

### 실습 1 — Safe 제안 생성 스크립트 구현 (10분)

```typescript
// dmz/packages/vasp/src/admin/UpgradeGovernanceAdminService.ts

export class UpgradeGovernanceAdminService {
  constructor(
    private readonly governance: KeyGovernanceService,  // S48 구현체
    private readonly db: Database,
    private readonly auditLog: AuditLogService,
    private readonly notifier: NotifierAdapter,
  ) {}

  // 업그레이드 제안 생성
  async proposeUpgrade(params: {
    newImplementationAddress: string;
    initData: string;            // upgradeToAndCall의 두 번째 파라미터
    proposedBy: string;
    description: string;
    stagingVerifiedAt: Date;     // 스테이징 검증 완료 시각
    slitherReportId: string;     // Slither 감사 보고서 ID
  }): Promise<{ proposalId: string; txHash: string }> {

    // 스테이징 검증 기간 확인 (최소 2주)
    const verificationDays =
      (Date.now() - params.stagingVerifiedAt.getTime()) / (86400 * 1000);
    if (verificationDays < 14) {
      throw new Error(
        `스테이징 검증 기간 부족: ${Math.floor(verificationDays)}일. 최소 14일 필요.`,
      );
    }

    // KeyGovernanceService.proposeTx() 호출 (S48 구현)
    const pendingTx = await this.governance.proposeTx(params.proposedBy, {
      to:    process.env.KYOBO_NFT_PROXY_ADDRESS!,
      value: 0n,
      data:  this._buildUpgradeCalldata(
        params.newImplementationAddress,
        params.initData,
      ),
    });

    // 제안 메타데이터 별도 저장 (감사 추적용)
    await this.db.query(
      `INSERT INTO upgrade_proposals
         (id, pending_tx_id, new_impl, description,
          staging_verified_at, slither_report_id, proposed_by, proposed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        crypto.randomUUID(), pendingTx.id,
        params.newImplementationAddress, params.description,
        params.stagingVerifiedAt, params.slitherReportId, params.proposedBy,
      ],
    );

    // 서명자 3인에게 알림
    await this.notifier.sendAlert({
      title: '[업그레이드 제안] 서명 요청',
      severity: 'P3',
      body: [
        `제안자: ${params.proposedBy}`,
        `새 Implementation: ${params.newImplementationAddress}`,
        `설명: ${params.description}`,
        `스테이징 검증: ${params.stagingVerifiedAt.toISOString()}`,
        `필요 서명: 3명 중 2명 (2-of-3)`,
        `제안 조회: GET /admin/governance/proposals/${pendingTx.id}`,
        ``,
        `⚠️ 서명 전 반드시 확인:`,
        `1. 새 Implementation 주소 Etherscan 검증`,
        `2. Storage Layout 충돌 없음 (Slither 보고서: ${params.slitherReportId})`,
        `3. 실행 후 롤백 불가`,
      ].join('\n'),
    });

    // 감사 로그 기록
    await this.auditLog.log({
      actor:      params.proposedBy,
      action:     'UPGRADE_PROPOSAL_CREATED',
      resourceId: pendingTx.id,
      afterState: {
        newImpl:   params.newImplementationAddress,
        txHash:    pendingTx.txHash,
        threshold: pendingTx.requiredSignatures,
      },
    });

    return { proposalId: pendingTx.id, txHash: pendingTx.txHash };
  }

  // upgradeToAndCall calldata 생성
  private _buildUpgradeCalldata(newImpl: string, initData: string): string {
    // ITransparentUpgradeableProxy.upgradeToAndCall(address,bytes) selector
    // 실제 구현에서는 ethers.js Interface.encodeFunctionData 사용
    return `0x4f1ef286${newImpl.slice(2).padStart(64, '0')}${initData}`;
  }
}
```

테스트:

```bash
curl -X POST http://localhost:3000/admin/governance/proposals \
  -H "Content-Type: application/json" \
  -d '{
    "newImplementationAddress": "0xNewImpl...",
    "initData": "0x",
    "proposedBy": "dev-kim@kyobo.com",
    "description": "KyoboNFT v2 — 배당금 이벤트 타입 추가",
    "stagingVerifiedAt": "2026-04-15T00:00:00Z",
    "slitherReportId": "SLITHER-2026-042"
  }'
```

---

### 실습 2 — 제안 목록 API 구현 (10분)

```typescript
// UpgradeGovernanceAdminService.ts 추가

async listProposals(filter?: { status?: 'PENDING_SIGNATURES' | 'READY_TO_EXECUTE' | 'EXECUTED' }): Promise<Array<{
  id: string;
  txHash: string;
  status: string;
  requiredSignatures: number;
  collectedSignatures: number;
  signers: Array<{ address: string; signedAt: Date | null }>;
  proposedBy: string;
  proposedAt: Date;
  description: string;
}>> {
  const rows = await this.db.query(
    `SELECT
       pt.id, pt.tx_hash, pt.status,
       pt.required_signatures, pt.proposed_by, pt.proposed_at,
       pt.collected_signatures,
       up.description
     FROM pending_txs pt
     LEFT JOIN upgrade_proposals up ON up.pending_tx_id = pt.id
     ${filter?.status ? `WHERE pt.status = '${filter.status}'` : `WHERE pt.status != 'EXECUTED'`}
     ORDER BY pt.proposed_at DESC`,
  );

  return rows.rows.map(row => {
    const collected = JSON.parse(row.collected_signatures as string) as Array<{
      signer: string;
      signedAt: string;
    }>;

    return {
      id:                  row.id as string,
      txHash:              row.tx_hash as string,
      status:              row.status as string,
      requiredSignatures:  row.required_signatures as number,
      collectedSignatures: collected.length,
      signers:             collected.map(s => ({
        address:  s.signer,
        signedAt: s.signedAt ? new Date(s.signedAt) : null,
      })),
      proposedBy:  row.proposed_by as string,
      proposedAt:  new Date(row.proposed_at as string),
      description: row.description as string ?? '',
    };
  });
}
```

```typescript
// router.ts

// 제안 목록 조회
router.get('/admin/governance/proposals', async (req, res) => {
  const { status } = req.query;
  const proposals = await upgradeGovernanceAdmin.listProposals(
    status ? { status: status as any } : undefined,
  );
  res.json({ proposals });
});

// 단건 조회
router.get('/admin/governance/proposals/:id', async (req, res) => {
  const proposals = await upgradeGovernanceAdmin.listProposals();
  const proposal  = proposals.find(p => p.id === req.params.id);
  if (!proposal) return res.status(404).json({ error: '제안 없음' });
  res.json(proposal);
});
```

기대 응답:

```json
{
  "proposals": [
    {
      "id": "uuid-001",
      "txHash": "0xSafeTxHash...",
      "status": "PENDING_SIGNATURES",
      "requiredSignatures": 2,
      "collectedSignatures": 1,
      "signers": [
        { "address": "0xVASP...",   "signedAt": "2026-05-03T09:00:00Z" },
        { "address": "0xKyoboIT...", "signedAt": null },
        { "address": "0xCompli...",  "signedAt": null }
      ],
      "proposedBy": "dev-kim@kyobo.com",
      "proposedAt": "2026-05-03T08:00:00Z",
      "description": "KyoboNFT v2 — 배당금 이벤트 타입 추가"
    }
  ]
}
```

---

### 실습 3 — 업그레이드 체크리스트 문서 작성 (10분)

```markdown
# 업그레이드 체크리스트 — KyoboNFT 컨트랙트

> 파일: docs/upgrade-checklist.md
> 모든 컨트랙트 업그레이드 시 이 체크리스트를 준수한다.
> Safe 제안 생성 전 [사전 체크]를 완료해야 한다.

## 사전 체크 (제안 생성 전 필수)

### 코드 품질
- [ ] Storage Layout 충돌 없음
      `npx hardhat run scripts/validate-storage-layout.ts --network sepolia`
- [ ] Slither CRITICAL/HIGH 0건
      감사 보고서 ID: ____________________
- [ ] reinitializer 버전 올바름 (v2 → @reinitializer(2))
- [ ] 단위 테스트 100% 통과
- [ ] 기존 tokenId 보존 테스트 통과

### 스테이징 검증
- [ ] Sepolia 배포 완료
      스테이징 Implementation 주소: ____________________
- [ ] 검증 시작일: ____________________  (최소 14일 전)
- [ ] 기존 사용자 balanceOf 변화 없음 확인
- [ ] 신규 기능 E2E 테스트 통과
- [ ] Consumer + VASP 연동 테스트 통과
- [ ] VASP(월렛원) 검토 완료: ( ) 예

### 롤백 불가 인지 (서명 필수)
- [ ] 확인: 업그레이드 후 이전 버전으로 되돌릴 수 없음
      개발팀 서명: ____________________
      서비스관리자 서명: ____________________

### 승인
- [ ] 개발팀 리뷰: ____________________
- [ ] 보안 감사 완료: ____________________
- [ ] 서비스 관리자 승인: ____________________

---

## Safe 서명 수집

### 서명자 현황
| 서명자 | 소속 | 서명 완료 | 서명 시각 |
|--------|------|----------|---------|
| 서명자 A (VASP) | 월렛원 | ( ) 완료 | ______ |
| 서명자 B (IT)   | 교보 IT | ( ) 완료 | ______ |
| 서명자 C (준법)  | 준법감시 | ( ) 완료 | ______ |

- [ ] READY_TO_EXECUTE 상태 확인
      GET /admin/governance/proposals/:id → status: READY_TO_EXECUTE

---

## 실행 전 최종 확인 (실행 담당자 체크)

- [ ] 프로덕션 배포 시각: ________ (저트래픽 시간대 권장)
- [ ] Consumer 일시 중단 필요 여부: ( ) 필요  ( ) 불필요
- [ ] 인프라팀 대기 확인
- [ ] 롤백 계획 준비 (v(n+1) 코드 준비 여부): ( ) 준비됨

### 비상 연락처
| 역할 | 이름 | 연락처 |
|------|------|-------|
| 서명자 A (VASP) | ____ | ____ |
| 서명자 B (IT)   | ____ | ____ |
| 서명자 C (준법)  | ____ | ____ |
| 인프라팀        | ____ | ____ |
| 서비스 관리자   | ____ | ____ |

---

## 실행 후 검증 (15분 이내)

- [ ] balanceOf(기존 사용자 10명 샘플) — 업그레이드 전과 동일
- [ ] 신규 기능 테스트 TX 실행 성공
- [ ] Consumer가 신규 이벤트 처리 확인 (DLQ 없음)
- [ ] GET /admin/vasp/stuck → stuckCount: 0
- [ ] S26 AuditLogService 업그레이드 기록 확인
- [ ] Etherscan 새 Implementation 주소 등록 (S39 절차)
```

테스트 파일 작성 확인:

```bash
# 체크리스트 파일 생성 확인
cat docs/upgrade-checklist.md | wc -l
# → 70줄 이상이어야 완성

# 제안 목록 API 테스트
curl "http://localhost:3000/admin/governance/proposals?status=PENDING_SIGNATURES"
```

---

## 완료 기준

- [ ] `POST /admin/governance/proposals` — 스테이징 검증 14일 미만 시 에러 반환 확인
- [ ] `POST /admin/governance/proposals` — 제안 생성 + 서명자 3인 알림 발송 확인
- [ ] `GET /admin/governance/proposals` — 진행 중 제안 목록 (서명 현황 포함) 확인
- [ ] `GET /admin/governance/proposals/:id` — 단건 조회 + signers 배열 signedAt null 포함
- [ ] 업그레이드 체크리스트 `docs/upgrade-checklist.md` 완성 (사전 체크 15개+, 비상 연락처 포함)
- [ ] 감사 로그에 UPGRADE_PROPOSAL_CREATED 기록 확인

---

### 운영 체크리스트 — 업그레이드 제안 수신 시

```
□ GET /admin/governance/proposals 조회 → 진행 중 제안 확인
□ 제안 내용 검토
    ├── 새 Implementation 주소 Etherscan 소스 코드 확인
    ├── 변경 내용이 설명과 일치하는지 확인
    ├── Storage Layout 충돌 없음 확인 (Slither 보고서)
    └── 스테이징 검증 기간 14일+ 확인

□ 서명 전 롤백 불가 인지 재확인
□ 서명자 B (교보 IT): 운영 영향 검토 후 HSM 서명
□ READY_TO_EXECUTE 상태 확인 → 실행 담당자에게 통보

□ 실행 후 15분:
    balanceOf 샘플 체크 → 변화 없음 확인
    신규 기능 테스트 TX 실행
    GET /admin/vasp/stuck → 0 확인
    감사 로그 기록 확인
```

---

## 워크시트

### 업그레이드 제안-서명-실행 워크시트

> 업그레이드 제안 수신부터 실행까지 전 과정 추적.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
업그레이드 거버넌스 추적 시트
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[제안 정보]
  제안 ID       : ____________________
  제안 시각     : ____________________
  제안자        : ____________________
  새 Implementation: ____________________
  변경 내용     : ____________________________________
  스테이징 검증 시작일: __________  (14일 경과: ______)
  Slither 보고서: ____________________

[사전 체크]
  Storage Layout: ( ) 충돌 없음  ( ) 충돌 있음(진행 불가)
  Slither HIGH  : ____ 건  (0이어야 진행 가능)
  스테이징 기간 : ____ 일  (14 이상이어야 진행 가능)
  롤백 불가 인지: ( ) 확인 (서명: ____________________)

[서명 수집]
  서명자 A (VASP):
    서명 완료: ( ) 예  ( ) 아니오
    완료 시각: ____________________

  서명자 B (교보 IT):
    검토 내용: ____________________________________
    서명 완료: ( ) 예  ( ) 아니오
    완료 시각: ____________________

  서명자 C (준법감시):
    서명 완료: ( ) 예  ( ) 아니오  ( ) 부재(A+B로 진행)
    완료 시각: ____________________

  READY_TO_EXECUTE 상태: ( ) 확인

[실행]
  실행 예정 시각: ____________________
  Consumer 중단: ( ) 예  ( ) 아니오
  실행 담당자   : ____________________
  온체인 TX 해시: ____________________
  블록 확인 시각: ____________________

[실행 후 검증 (15분)]
  balanceOf 샘플 체크: ( ) 변화 없음  ( ) 변화 있음 ⚠️
  신규 기능 테스트    : ( ) 성공  ( ) 실패
  DLQ 신규 발생       : ____ 건
  감사 로그 기록      : ( ) 완료
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### 서명자 역할 판단 카드

```
┌─────────────────────────────────────────────────────────┐
│  서명하기 전 확인할 사항 (서명자 공통)                    │
│                                                          │
│  □ 새 Implementation 주소 Etherscan에서 소스 코드 확인  │
│  □ 변경 내용이 설명과 일치하는가                        │
│  □ Storage Layout 충돌 없음 (Slither 보고서 확인)       │
│  □ 스테이징 검증 14일 이상 완료                         │
│  □ 실행 후 롤백 불가 인지                               │
│                                                          │
│  하나라도 확인 안 되면 → 서명 보류, 담당자에게 문의     │
│                                                          │
│  서명자 부재 시:                                         │
│  □ A + B 서명으로 2-of-3 달성 가능 (C 부재 OK)          │
│  □ A만 서명 → 진행 불가 (1-of-3)                        │
│  □ 장기 부재 예정 → swapOwner TX 사전 준비 필요         │
└─────────────────────────────────────────────────────────┘
```

---

### 분기별 거버넌스 리뷰 시트

> 분기 말, 업그레이드 거버넌스 운영 현황 점검.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
분기별 거버넌스 리뷰 — ____년 __분기
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[업그레이드 현황]
  총 제안 건수: ____  건
  실행 완료   : ____  건
  취소/폐기   : ____  건
  평균 제안→실행 소요일: ____ 일

[서명자 참여율]
  서명자 A: ____ / ____ 서명 (참여율 ___%)
  서명자 B: ____ / ____ 서명 (참여율 ___%)
  서명자 C: ____ / ____ 서명 (참여율 ___%)

[부재 발생]
  부재 발생 횟수: ____ 회
  대응 방식: ( ) A+B로 진행  ( ) swapOwner  ( ) 대기
  부재로 인한 지연: ____ 건

[이슈]
  업그레이드 후 이상 발생: ____ 건
  내용: ____________________________________

[개선 과제]
  □ _______________________________ (담당: ____)
  □ _______________________________ (담당: ____)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 자동화 확장 — UpgradeGovernanceAdminService

> 제안 생성·서명자 알림·임계값 도달 감지·실행자 알림 자동화.

### TypeScript 서비스 클래스 구현

```typescript
// 서명 수집 후 threshold 도달 감지 → 자동 READY_TO_EXECUTE 전환 + 알림

export class UpgradeGovernanceAdminService {
  // ... (기존 코드)

  // 서명 추가 후 threshold 체크 (S48 addSignature 후 호출)
  async onSignatureAdded(pendingTxId: string, signer: string): Promise<void> {
    const proposal = await this.governance.getPendingTx(pendingTxId);

    // 감사 로그
    await this.auditLog.log({
      actor:      signer,
      action:     'UPGRADE_SIGNATURE_COLLECTED',
      resourceId: pendingTxId,
      afterState: {
        collectedCount: proposal.collectedSignatures.length,
        required:       proposal.requiredSignatures,
      },
    });

    // threshold 도달 시 자동 알림 + 실행자 통보
    if (proposal.collectedSignatures.length >= proposal.requiredSignatures) {
      await this.notifier.sendAlert({
        title: '✅ 업그레이드 서명 완료 — 실행 준비됨',
        severity: 'P3',
        body: [
          `제안 ID: ${pendingTxId}`,
          `상태: READY_TO_EXECUTE`,
          `수집된 서명: ${proposal.collectedSignatures.length}/${proposal.requiredSignatures}`,
          `실행 가능: POST /admin/governance/proposals/${pendingTxId}/execute`,
          ``,
          `⚠️ 실행 전 upgrade-checklist.md "실행 전 최종 확인" 완료 필수`,
        ].join('\n'),
      });
    } else {
      // 아직 서명 수집 중 — 나머지 서명자에게 리마인드
      const remaining = proposal.requiredSignatures - proposal.collectedSignatures.length;
      await this.notifier.sendAlert({
        title: `[업그레이드 제안] 서명 ${proposal.collectedSignatures.length}/${proposal.requiredSignatures}`,
        severity: 'P3',
        body: `아직 ${remaining}명의 서명이 필요합니다. 제안 ID: ${pendingTxId}`,
      });
    }
  }

  // 업그레이드 이력 조회
  async getUpgradeHistory(): Promise<Array<{
    id: string;
    newImpl: string;
    description: string;
    proposedBy: string;
    proposedAt: Date;
    executedAt: Date | null;
    status: string;
  }>> {
    const rows = await this.db.query(
      `SELECT up.id, up.new_impl, up.description, up.proposed_by, up.proposed_at,
              pt.status, pt.executed_at
       FROM upgrade_proposals up
       JOIN pending_txs pt ON pt.id = up.pending_tx_id
       ORDER BY up.proposed_at DESC`,
    );
    return rows.rows as any[];
  }
}
```

### 아날로그↔디지털 대응 요약 테이블

| 아날로그 (워크시트) | 디지털 (API/서비스) | 자동화 여부 |
|---|---|---|
| 스테이징 검증 기간 확인 | `proposeTx()` 내부 자동 검증 | ✅ 자동 |
| 서명자 알림 발송 | `notifier.sendAlert()` 자동 | ✅ 자동 |
| 서명 현황 조회 | `GET /admin/governance/proposals/:id` | 운영자 조회 |
| threshold 도달 감지 | `onSignatureAdded()` 자동 감지 | ✅ 자동 |
| 실행자 통보 | `READY_TO_EXECUTE` 알림 자동 | ✅ 자동 |
| 업그레이드 이력 | `getUpgradeHistory()` DB 조회 | ✅ 자동 |
| 실행 결정 | 사람이 직접 판단 후 실행 | 운영자 결정 |
| 롤백 불가 인지 서명 | 체크리스트 물리적 서명 | 운영자 서명 |
