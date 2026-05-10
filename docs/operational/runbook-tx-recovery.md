# Runbook: TX REORG·TIMEOUT 복구 — 블록체인 트랜잭션 비정상 종료 대응

**대상**: 운영팀, 온콜 담당자  
**관련 세션**: S19–S20  
**관련 코드**: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`, `dmz/apps/issuer-service/`

---

## TX 상태 전이 요약

```
PENDING → CONFIRMED → FINALIZED
        ↘ REORGED  (체인 재편 발생)
        ↘ TIMEOUT  (일정 시간 내 미채굴)
        ↘ FAILED   (컨트랙트 revert)
```

---

## REORG 복구 절차

### REORGED 상태 감지

```bash
# REORGED 상태 TX 목록 조회
GET /admin/issuance?status=REORGED
```

### 판단 기준

| 조건 | 조치 |
|---|---|
| REORGED 후 **5블록 이상 경과** | 아래 재확인 절차 실행 |
| REORGED 후 5블록 미만 | 대기 (자동 복구 가능) |

### REORGED → Finalized 재확인 절차

```bash
# Step 1 — TX 해시로 온체인 상태 직접 확인
GET /admin/issuance/:id
# txHash, blockNumber 확인

# Step 2 — 현재 블록 높이 확인 후 5블록 대기 여부 판단
# (blockNumber + 5 <= currentBlock) 이면 재확인 실행

# Step 3 — 재확인 트리거 (수동)
POST /admin/issuance/:id/recheck
# VASP에 TX 재조회 → CONFIRMED 또는 PENDING으로 전이

# Step 4 — 여전히 REORGED이면 재발행 처리
POST /admin/issuance/:id/reissue
```

> ⚠️ 재발행 전 반드시 원본 TX가 온체인에 없음을 확인. 중복 민팅 방지.

---

## TIMEOUT 복구 절차

### TIMEOUT 상태 감지

```bash
# TIMEOUT 상태 TX 목록 조회
GET /admin/issuance?status=TIMEOUT
```

### Gas Bump (Replace-by-Fee)

동일 Nonce, 가스비 1.2배 재전송:

```bash
# Step 1 — TIMEOUT TX 상세 확인 (txHash, nonce, gasPrice)
GET /admin/issuance/:id

# Step 2 — Gas Bump 재전송
POST /admin/issuance/:id/gas-bump
Body: { "gasPriceMultiplier": 1.2 }
# 동일 nonce로 새 TX 브로드캐스트 (기존 TX Replace-by-Fee)

# Step 3 — 새 txHash로 모니터링
GET /admin/issuance/:id
# status → PENDING (재전송 성공)
```

### Gas Bump 실패 시

```bash
# 1.5배 재시도
POST /admin/issuance/:id/gas-bump
Body: { "gasPriceMultiplier": 1.5 }
```

Gas Bump 2회 실패 시 → VASP (월렛원) 연락, 수동 처리 요청.

---

## 판단 플로우

```
TX 상태 확인
    ↓
REORGED?
    → 5블록 대기 → recheck → 여전히 REORGED → reissue
TIMEOUT?
    → gas-bump x1.2 → PENDING 전환 확인
    → 실패 → gas-bump x1.5 → 실패 → VASP 수동 처리
```

---

## P1 에스컬레이션 기준

| 상황 | 조치 |
|---|---|
| REORGED 건 10개 이상 동시 발생 | L2 팀 리드 즉시 호출 |
| Gas Bump 2회 연속 실패 | VASP (월렛원) 긴급 연락 |
| 재발행 후에도 REORGED 지속 | 네트워크 이상 — 발행 일시 중단 검토 ([runbook-contract-pause.md](runbook-contract-pause.md)) |

---

## 관련 런북

- [runbook-vasp-sla.md](runbook-vasp-sla.md) — TX Stuck 모니터링·SLA
- [runbook-contract-pause.md](runbook-contract-pause.md) — 긴급 컨트랙트 중단
