# S57 운영 실습 — 업그레이드 거버넌스 운영: Safe 제안·서명·실행 절차 관리

강의 노트: `M8_S57_upgrade_governance_ops.md`
소요 시간: 60 분

---

## 목표

- 업그레이드 제안 생성 API 호출 및 사전 검증 게이트 확인
- 서명자별 역할과 서명 수집 흐름 실습
- 업그레이드 전·후 필수 체크리스트 작성
- READY_TO_EXECUTE 도달 후 실행자 알림 흐름 확인

---

## 배경 (S46~S48 복습)

S46에서 2-of-3 Gnosis Safe가 필요한 이유를 배웠다. S47에서 EIP-712 SafeTx 서명 방식을, S48에서 KeyGovernanceService(proposeTx → addSignature → executeTx)를 구현했다.

이번 세션은 **그 코드가 실제 운영 환경에서 어떻게 돌아가는가** 다. 사람이 개입해야 하는 지점, 서명자 부재 시 대응, 업그레이드 후 반드시 확인해야 할 것을 다룬다.

---

## Step 1 — 업그레이드 제안 생성

### 1-1. 사전 게이트 확인 (제안 생성 전 필수)

```bash
# Storage Layout 충돌 검증
npx hardhat run scripts/validate-storage-layout.ts --network sepolia
# 출력: "No storage layout issues detected" 확인

# Slither 정적 분석
slither contracts/KyoboNFTV2.sol --json slither-report.json
cat slither-report.json | jq '.results.detectors[] | select(.impact == "High" or .impact == "Critical")'
# 출력: [] (CRITICAL/HIGH 0건이어야 진행 가능)

# 스테이징 검증 기간 확인 (최소 14일)
STAGING_DATE="2026-04-15"
DAYS=$(( ($(date +%s) - $(date -d "$STAGING_DATE" +%s)) / 86400 ))
echo "스테이징 기간: $DAYS 일"
# 14 이상이어야 한다
```

### 1-2. 제안 API 호출

```bash
curl -X POST http://localhost:3000/admin/governance/proposals \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "newImplementationAddress": "0xNewImplAddress0000000000000000000000000",
    "initData": "0x",
    "proposedBy": "dev-kim@kyobo.com",
    "description": "KyoboNFT v2 — 배당금 이벤트 타입 추가",
    "stagingVerifiedAt": "2026-04-15T00:00:00Z",
    "slitherReportId": "SLITHER-2026-042"
  }'
```

기대 응답:

```json
{
  "proposalId": "uuid-001",
  "txHash": "0xSafeTxHash..."
}
```

### 1-3. 스테이징 기간 미달 시 에러 확인

```bash
# stagingVerifiedAt을 어제 날짜로 설정 → 에러 응답 확인
curl -X POST http://localhost:3000/admin/governance/proposals \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "newImplementationAddress": "0xNewImpl...",
    "initData": "0x",
    "proposedBy": "dev-kim@kyobo.com",
    "description": "테스트",
    "stagingVerifiedAt": "2026-05-09T00:00:00Z",
    "slitherReportId": "SLITHER-TEST"
  }'
# 기대: 400 에러, "스테이징 검증 기간 부족: 1일. 최소 14일 필요."
```

---

## Step 2 — 제안 목록 조회 + 서명 현황 확인

```bash
# 전체 진행 중 제안 목록
curl "http://localhost:3000/admin/governance/proposals" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 특정 상태 필터
curl "http://localhost:3000/admin/governance/proposals?status=PENDING_SIGNATURES" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 단건 조회 (서명 현황 확인)
PROPOSAL_ID="uuid-001"
curl "http://localhost:3000/admin/governance/proposals/$PROPOSAL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

기대 응답 (서명 1명 완료 상태):

```json
{
  "id": "uuid-001",
  "status": "PENDING_SIGNATURES",
  "requiredSignatures": 2,
  "collectedSignatures": 1,
  "signers": [
    { "address": "0xVASP...", "signedAt": "2026-05-03T09:00:00Z" },
    { "address": "0xKyoboIT...", "signedAt": null },
    { "address": "0xCompli...", "signedAt": null }
  ],
  "description": "KyoboNFT v2 — 배당금 이벤트 타입 추가"
}
```

---

## Step 3 — 서명자 역할 이해와 서명 절차

각 서명자가 서명 전 확인해야 할 항목:

| 서명자 | 역할 | 검토 항목 |
|--------|------|-----------|
| 서명자 A (VASP) | 기술 실행 | 코드 변경 일치, Storage Layout, calldata 정확성 |
| 서명자 B (교보 IT) | 운영 승인 | 배포 시각(저트래픽), 예상 다운타임, 롤백 계획 |
| 서명자 C (준법감시) | 컴플라이언스 | 가상자산법 준수, 이용자 공지 필요 여부, 감독원 보고 여부 |

```bash
# 서명 추가 (각 서명자가 호출)
curl -X POST "http://localhost:3000/admin/governance/proposals/$PROPOSAL_ID/sign" \
  -H "Authorization: Bearer $SIGNER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "signer": "0xSignerA...",
    "signature": "0xSig_A_EIP712..."
  }'

# threshold 도달 확인 (2-of-3 완료)
curl "http://localhost:3000/admin/governance/proposals/$PROPOSAL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# status: "READY_TO_EXECUTE" 확인
```

### 서명자 부재 시 대응

```
일반 케이스: C 부재 (평일 야간, 주말)
  → A + B로 2-of-3 달성 → 진행 가능

비상 케이스: B + C 동시 부재
  → swapOwner TX 필요 (대리인 지정)
  → 사전 대리인 지정 절차 필수
  → swapOwner도 2-of-3 서명 필요 → 닭이 먼저냐 달걀이 먼저냐 방지를 위해 사전 준비 필수

절대 금지:
  → 키 공유(임시 위임) — 멀티시그의 보안 의미 소멸
  → 이메일로 서명값 전달 — 키 탈취와 동일한 위험
```

---

## Step 4 — 업그레이드 전 최종 확인

```bash
# Storage Layout 최종 검증
npx hardhat run scripts/validate-storage-layout.ts --network mainnet

# 새 Implementation 주소 Etherscan 확인
# https://etherscan.io/address/0xNewImpl#code
# "Contract Source Code Verified" 확인

# 기존 사용자 tokenId 보존 확인 (배포 전 스냅샷)
npx hardhat run scripts/check-balances.ts --network mainnet \
  --snapshot snapshots/pre-upgrade.json

# READY_TO_EXECUTE 상태 최종 확인
curl "http://localhost:3000/admin/governance/proposals/$PROPOSAL_ID" | jq '.status'
# "READY_TO_EXECUTE" 확인
```

**롤백 불가 인지 (실행 전 서명 필수):**

```
upgradeToAndCall(newImpl, initData) 실행 직전:
  → 이 TX가 블록에 포함되면 즉시 적용
  → 이전 Implementation으로 되돌릴 수 없음
  → 문제 발생 시 v(n+1)을 빠르게 준비해서 재업그레이드
  → 실행 담당자 2인 서명 확인 후 진행
```

---

## Step 5 — 업그레이드 실행

```bash
# 저트래픽 시간대 (새벽 2~4시) 실행
curl -X POST "http://localhost:3000/admin/governance/proposals/$PROPOSAL_ID/execute" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "executor": "dev-kim@kyobo.com" }'

# 기대 응답
# { "onChainTxHash": "0xExecTxHash..." }
```

---

## Step 6 — 업그레이드 후 15분 내 검증

```bash
# [1] 기존 사용자 tokenId 보존 확인 (10명 샘플)
npx hardhat run scripts/check-balances.ts --network mainnet \
  --snapshot snapshots/pre-upgrade.json
# 출력: "All balances match. 0 mismatches."

# [2] 신규 기능 테스트 TX 실행
npx hardhat run scripts/test-new-feature.ts --network mainnet

# [3] Consumer 신규 이벤트 처리 확인
curl http://localhost:3000/admin/queue/stats | jq '.pendingMessages'
# 0 또는 소수 → Consumer 정상

# [4] Stuck TX 없음 확인
curl http://localhost:3000/admin/vasp/stuck | jq '.stuckCount'
# 0

# [5] 감사 로그 업그레이드 기록 확인
curl "http://localhost:3000/admin/audit/logs?action=TX_EXECUTED&limit=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# [6] Etherscan 새 Implementation 주소 등록 (S39 절차)
npx hardhat verify --network mainnet 0xNewImplAddress...
```

---

## 업그레이드 체크리스트 — 작성 실습

> 아래 체크리스트를 이번 업그레이드 기준으로 직접 작성한다.

### 사전 체크

| 항목 | 결과 | 확인자 |
|------|------|-------|
| Storage Layout 충돌 없음 | ( ) 없음 | |
| Slither CRITICAL/HIGH 0건 | __건 | |
| reinitializer 버전 올바름 | ( ) v__ | |
| 단위 테스트 100% 통과 | ( ) 통과 | |
| Sepolia 스테이징 검증 시작일 | __________ | |
| 스테이징 기간 14일 이상 | __일 | |
| 기존 사용자 balanceOf 변화 없음 | ( ) 없음 | |
| VASP(월렛원) 검토 완료 | ( ) 예 | |
| 롤백 불가 인지 서명 | __________ | |

### 서명 수집

| 서명자 | 서명 완료 | 시각 |
|--------|---------|------|
| 서명자 A (VASP) | ( ) 완료 | |
| 서명자 B (교보 IT) | ( ) 완료 | |
| 서명자 C (준법감시) | ( ) 완료 / ( ) 부재 | |
| READY_TO_EXECUTE 확인 | ( ) 확인 | |

### 실행 후 검증 (15분)

| 항목 | 결과 |
|------|------|
| balanceOf 10명 샘플 — 변화 없음 | ( ) 없음 |
| 신규 기능 테스트 TX 성공 | ( ) 성공 |
| Consumer 신규 이벤트 처리 정상 | ( ) 정상 |
| Stuck TX: 0건 | ( ) 0건 |
| 감사 로그 TX_EXECUTED 기록 | ( ) 기록 |
| Etherscan Implementation 등록 | ( ) 완료 |

---

## 토론 포인트

1. Safe 제안 생성 시 스테이징 기간 14일 최소화의 근거는 무엇인가? Phase 3(직접 Custody)에서는 이 기간을 어떻게 조정할 것인가?

2. 서명자 C(준법감시)가 장기 부재 시 swapOwner TX 자체가 2-of-3를 요구한다. 이 닭-달걀 문제를 사전에 방지하기 위한 운영 정책은 무엇인가?

3. 업그레이드 후 15분 내 기존 tokenId 불일치가 발견되면 어떻게 하는가? "롤백 불가" 전제 하에 v(n+1) 패치 배포까지 예상 시간은?

4. 감독원이 업그레이드 이력을 요청할 때 어떤 데이터를 제출해야 하는가? (audit_logs + upgrade_proposals 테이블 조합)

---

## 완료 기준

- [ ] `POST /admin/governance/proposals` — 스테이징 기간 14일 미만 시 에러 응답 확인
- [ ] `POST /admin/governance/proposals` — 정상 제안 생성 + 서명자 알림 발송 확인
- [ ] `GET /admin/governance/proposals` — 진행 중 제안 목록 (signers 배열, signedAt null 포함)
- [ ] `GET /admin/governance/proposals/:id` — 단건 조회 성공
- [ ] 업그레이드 체크리스트 작성 완료 (사전 체크 + 서명 수집 + 실행 후 검증)
- [ ] 감사 로그 UPGRADE_PROPOSAL_CREATED + TX_EXECUTED 기록 확인
- [ ] 토론 포인트 3개 이상 답변 준비
