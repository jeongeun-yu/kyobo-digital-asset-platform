# Day 12 — 키 거버넌스 심화 + 전체 시스템 완성

**시간**: 3시간 (180분)  
**핵심 질문**: 교보생명이 VASP와 키를 어떻게 나눠 갖는가? MPC와 멀티시그 중 무엇을 선택하는가?

---

## 세션 구조

| 시간 | 내용 |
|---|---|
| 00:00~00:40 | 1부: 키 거버넌스 요구사항 — 규제·운영·보안 |
| 00:40~01:25 | 실습 1: Gnosis Safe 멀티시그 설정 + 트랜잭션 |
| 01:25~02:10 | 실습 2: KeyGovernanceService 구현 |
| 02:10~02:50 | 실습 3: 전체 시스템 end-to-end 시뮬레이션 |
| 02:50~03:00 | 마무리: Phase 1 완성 + Phase 2·3 로드맵 |

---

## 1부: 키 거버넌스 요구사항 (00:00~00:40)

### 1-1. 왜 키 거버넌스가 핵심인가 (15분)

**토킹포인트:**

> "교보생명이 직접 키를 갖지 않으면 VASP에 모든 것을 의존하게 됩니다. VASP가 키를 독점하면 교보생명은 자신의 자산에 대한 통제권이 없습니다. 반대로 교보생명이 단독으로 키를 관리하면 HSM 구축, 키 관리 인프라, 24/7 운영이 필요합니다. 현실적인 Phase 1 답은 균형입니다."

**키 거버넌스 3가지 모델:**

| 모델 | 설명 | 장점 | 단점 |
|---|---|---|---|
| VASP 단독 보관 | 외부 VASP가 모든 키 관리 | 빠른 구현, 낮은 비용 | 교보 통제권 없음, VASP 의존도 최대 |
| MPC (Multi-Party Computation) | 키 샤드를 여러 주체가 분산 보관 | 단일 실패점 없음, 복구 가능 | 구현 복잡, Phase 3 수준 |
| Gnosis Safe 멀티시그 | m-of-n 서명으로 TX 승인 | 투명한 온체인 거버넌스, 즉시 구현 가능 | 서명자 관리 오버헤드 |

> "Phase 1에서는 Gnosis Safe 2-of-3 멀티시그를 선택합니다. 교보생명 1키 + VASP 1키 + Cold Key 1키. Phase 3에서 VASP 인가를 취득하면 MPC로 전환합니다."

### 1-2. 특금법·가상자산법 키 관리 요건 (25분)

**규제 요건 정리:**

| 규제 | 조항 | 요건 |
|---|---|---|
| 특금법 시행령 | §10의2 | 콜드월렛 80% 이상 보관 |
| 가상자산이용자보호법 | §6 | 이용자 자산과 고유 자산 분리 보관 |
| ISMS-P | 자산관리 통제 | 암호 키 생성·배포·폐기 절차 문서화 |
| 전자금융감독규정 | §34 | 키 접근 이력 1년 이상 보존 |

**Phase 1 키 구조:**

```
교보생명 키 구조 (Phase 1)
├── Hot Wallet (20% 한도)
│   └── Gnosis Safe 2-of-3
│       ├── 서명자 A: 교보 운영키 (AWS KMS)
│       ├── 서명자 B: VASP 운영키 (VASP HSM)
│       └── 서명자 C: 교보 Cold Key (HSM, 비상용)
│
└── Cold Wallet (80% 이상)
    └── 교보생명 단독 관리 (오프라인 HSM)
        └── 분기별 감사 + 이중 잠금 절차
```

---

## 실습 1: Gnosis Safe 멀티시그 (00:40~01:25)

### Step 1 — Gnosis Safe 배포 확인 (10분)

```bash
cat packages/contracts/src/phase1/KyoboSafe.sol
```

> "KyoboSafe는 Gnosis Safe의 GnosisSafe 컨트랙트를 래핑합니다. 우리가 추가한 것은 감사 로그 훅과 Travel Rule 검증뿐입니다."

### Step 2 — 멀티시그 트랜잭션 흐름 (25분)

**3단계 흐름:**

```
1. 제안 (Propose)
   교보 운영자 → proposeTransaction(to, value, data, operation)
   → Safe에 pending TX로 기록

2. 서명 수집 (Collect Signatures)
   서명자 A (교보) → signTransaction(txHash)
   서명자 B (VASP) → signTransaction(txHash)
   → 2-of-3 충족

3. 실행 (Execute)
   누구든 → execTransaction(to, value, data, operation, signatures)
   → Safe가 실제 TX 실행
```

**실습 과제:**
```bash
# Testnet 배포된 KyoboSafe 주소로 실습
KYOBO_SAFE_ADDR=$(cat .env.test | grep SAFE_ADDR | cut -d= -f2)

# 1. NFT 발행 TX 제안
pnpm ts-node scripts/proposeMint.ts --safe $KYOBO_SAFE_ADDR --to $NFT_CONTRACT --tokenId 101

# 2. 서명 추가 (서명자 B로 전환)
pnpm ts-node scripts/signTx.ts --txHash <pending-tx-hash> --signer vasp

# 3. 실행
pnpm ts-node scripts/executeTx.ts --txHash <pending-tx-hash>
```

### Step 3 — 비상 키 (Cold Key) 사용 시나리오 (15분)

**토킹포인트:**

> "서명자 A(교보 운영키)와 서명자 B(VASP 운영키)가 모두 사용 불가능한 상황. VASP 폐업, 사이버 침해, 재해. 이때 서명자 C(Cold Key)를 꺼냅니다."

```typescript
// Cold Key 활성화 프로세스 (절차서 발췌)
// 1. CEO + CIO + 외부 감사인 3인 동석
// 2. 물리적 금고에서 Cold Key USB 2개 중 1개 꺼내기
// 3. 오프라인 서명 장비에서 TX 서명
// 4. 서명된 TX → 온라인 환경으로 이관 후 브로드캐스트
// 5. 감사 로그 즉시 기록 + 이사회 보고
```

---

## 실습 2: KeyGovernanceService (01:25~02:10)

### Step 1 — 스켈레톤 확인 (10분)

```bash
cat packages/vasp/src/governance/KeyGovernanceService.ts
```

**구현할 메서드:**
- `proposeTx()` — Safe에 TX 제안 + 내부 pending_txs 테이블 기록
- `addSignature()` — 서명 수집 + 임계값 충족 여부 확인
- `executeTx()` — 임계값 충족 시 Safe.execTransaction() 호출
- `getSigningStatus()` — 현재 서명 현황 조회

### Step 2 — proposeTx 구현 (25분)

```typescript
// packages/vasp/src/governance/KeyGovernanceService.ts
async proposeTx(params: ProposeTxParams): Promise<PendingTx> {
  // TODO:
  // 1. Safe SDK로 TX 데이터 인코딩
  // 2. TX 해시 계산 (EIP-712 SafeTx struct hash)
  // 3. DB pending_txs INSERT
  //    - tx_hash, to, value, data, operation, status='PENDING_SIGNATURES'
  //    - required_signatures = safe.threshold (2)
  //    - collected_signatures = [] (JSON array)
  // 4. audit_log: TX_PROPOSED 기록
  // 5. 서명자들에게 알림 발송
  throw new Error('Not implemented');
}
```

**실습 과제:**
1. `// TODO` 5단계 모두 구현
2. Travel Rule: `params.value >= 1_000_000` (100만원) 이면 `travelRuleData` 필수 검증 추가
3. 단위 테스트: `pnpm test --filter=vasp -- --grep "KeyGovernanceService"`

### Step 3 — 서명 임계값 알림 (20분)

```typescript
// 서명이 임계값에 도달했을 때 자동 실행 옵션
async addSignature(txHash: string, signer: string, signature: string): Promise<SignatureStatus> {
  // TODO:
  // 1. pending_txs에서 txHash 조회
  // 2. collected_signatures에 signer + signature 추가
  // 3. collected_signatures.length >= required_signatures 이면
  //    → auto_execute 플래그 확인
  //    → true: executeTx() 자동 호출
  //    → false: 운영자에게 "실행 준비됨" 알림
  throw new Error('Not implemented');
}
```

---

## 실습 3: End-to-End 시뮬레이션 (02:10~02:50)

### Step 1 — 전체 시나리오 정의 (10분)

**시나리오: 보험 계약 체결 → NFT 발행 → 이벤트 수신 → 원장 기록 → 감사 로그**

```
[외부] 보험 계약 체결
   ↓
[API] POST /api/mint-requests { userId, policyId }
   ↓
[LedgerService] PENDING 기록 + audit_log: MINT_REQUESTED
   ↓
[KeyGovernanceService] Safe TX 제안 → 서명 수집 → 실행
   ↓
[Chain] KyoboNFT.mint() 실행 → Transfer 이벤트 발생
   ↓
[WebhookServer] VASP Webhook 수신 → IdempotencyGuard 통과
   ↓
[EventConsumer] Redis Streams 소비 → CONFIRMED 상태 전이
   ↓
[LedgerService] user_nft_holdings INSERT + mint_requests CONFIRMED
   ↓
[AuditLogService] TX_CONFIRMED 기록 (checksum 포함)
   ↓
[API] GET /api/nft-holdings/:userId → 보유 NFT 확인
```

### Step 2 — 시뮬레이션 실행 (25분)

```bash
# 전체 스택 실행 (Docker Compose)
docker-compose up -d postgres redis

# 마이그레이션 실행
pnpm db:migrate

# 개발 서버 실행
pnpm dev

# 다른 터미널에서 e2e 시뮬레이션
pnpm ts-node scripts/e2e-simulation.ts \
  --userId "user-kyobo-001" \
  --policyId "policy-life-2026-001"
```

**시뮬레이션 관찰 포인트:**
1. `pending_txs` 테이블에 Safe TX 생성 확인
2. 서명 2개 수집 후 자동 실행 확인
3. `processed_events` 테이블에 Transfer 이벤트 idempotency 확인
4. `audit_log` 테이블에 전체 흐름 추적 확인

### Step 3 — 장애 주입 테스트 (15분)

```bash
# Webhook 중단 시뮬레이션
# (WebhookServer 포트 막기 → Polling이 대신 처리하는지 확인)
pnpm ts-node scripts/inject-fault.ts --type webhook-down --duration 60s

# Reorg 시뮬레이션
pnpm ts-node scripts/inject-fault.ts --type reorg --txHash <submitted-tx>

# 결과: REORGED 상태 전이 + 재제출 로그 확인
```

---

## 마무리: Phase 1 완성 + 로드맵 (02:50~03:00)

### Phase 1에서 우리가 만든 것

| 레이어 | 구현 내용 |
|---|---|
| 체인 추상화 | IChainAdapter — EVM·XRPL·UTXO 공통 인터페이스 |
| VASP 추상화 | IVASPAdapter — Phase 1 외부 VASP, Phase 4 직접 인가 |
| 이벤트 파이프라인 | WebhookServer + IdempotencyGuard + Redis Streams |
| 스마트 컨트랙트 | KyoboNFT (ERC-721) + BaseToken (RBAC + Compliance) |
| 내부 원장 | LedgerService + 상태머신 + 4개 핵심 테이블 |
| 감사 로그 | AuditLogService + checksum 무결성 + 금융 규제 대응 |
| VASP 변동 처리 | VaspRecoveryService + 이중 채널 동기화 |
| 키 거버넌스 | Gnosis Safe 2-of-3 + KeyGovernanceService |

### Phase 2·3 로드맵

```
Phase 2 (6~12개월)
├── Circle Arc 연동: EVM 네이티브 USDC + CCTP 크로스체인
├── KRW1 스테이블코인 발행 (ERC-20 + 담보 관리)
└── XRPL 어댑터 완성: AMM + DEX 연동

Phase 3 (12~24개월)
├── XRPL RWA 토큰화: 부동산·채권 온체인 등록
├── 교보생명 VASP 인가 취득
├── MPC 키 관리로 전환 (VASP 의존도 제거)
└── 보험금 자동 지급 스마트 컨트랙트 (Parametric Insurance)
```

**마지막 토킹포인트:**

> "12일 36시간 동안 여러분은 교보생명 디지털 자산 플랫폼의 Phase 1 전체를 직접 설계하고 구현했습니다. 이 코드는 이 교육이 끝난 후에도 교보생명의 실제 시스템 설계 논의의 출발점이 됩니다. Phase 2를 향해 가는 여정에서 오늘 여기서 내린 결정들을 기억하십시오."
