# Runbook: 컨트랙트 업그레이드 거버넌스 — Safe 제안·승인·실행 실전 절차

**대상**: 컨트랙트 담당 개발자, Safe 서명자 3인  
**관련 세션**: S57  
**관련 코드**: `blockchain/`, `internal/packages/vasp/src/` (MultisigService — M8 구현 예정)

---

## 서명자 구성 (2-of-3 Gnosis Safe)

| 역할 | 담당 | 책임 |
|---|---|---|
| VASP (월렛원) | 기술 실행 | TX 서명·브로드캐스트 |
| 당사 IT | 운영 승인 | 내부 기술 검토 |
| 준법감시 | 컴플라이언스 확인 | 규제 적합성 |

서명자 부재 시: 각 역할별 대리인 사전 지정 필수. 변경 시 [runbook-contract-upgrade.md](runbook-contract-upgrade.md) 업데이트.

---

## ⚠️ 업그레이드 전 필수 확인

- [ ] **Storage layout 충돌 없음** — `npx hardhat run scripts/check-storage-layout.ts`
- [ ] **reinitializer 버전 확인** — v2이면 `reinitializer(2)`, v3이면 `reinitializer(3)`
- [ ] **Sepolia 테스트넷 동작 확인** — 동일 스크립트로 테스트넷 먼저 배포 및 검증
- [ ] **롤백 불가 인지** — 업그레이드 후 되돌릴 수 없음을 서명자 전원 인지
- [ ] **Slither HIGH/MEDIUM 0건** 확인

```bash
# Storage layout 검사
npx hardhat run scripts/check-storage-layout.ts --network mainnet

# Slither 보안 분석
slither blockchain/src/ --filter-paths "node_modules"
```

---

## 업그레이드 전체 절차

### Step 1 — 코드 변경 및 내부 검토

- PR 생성 → 코드 리뷰 (최소 2인)
- 테스트 커버리지 확인
- 감사 리포트 작성 (변경 범위·취약점·적용 방어)

### Step 2 — 테스트넷 검증

```bash
# Sepolia 배포
npx hardhat run scripts/deploy-upgrade.ts --network sepolia

# 기존 tokenId 보존 확인
npx hardhat run scripts/verify-upgrade.ts --network sepolia

# 신규 기능 동작 확인
npx hardhat test --network sepolia
```

### Step 3 — Safe 제안 생성

```bash
# 업그레이드 SafeTx 제안
POST /admin/governance/propose-upgrade
Body: {
  "newImplementation": "0x...",
  "initData": "0x...",
  "description": "v2: EIP-1559 수수료 최적화 + tokenId 인코딩 수정"
}

# 진행 중 제안 목록
GET /admin/governance/proposals
```

### Step 4 — 서명 수집 (2-of-3 오프체인 서명)

서명자별 서명 방법:
```bash
# 각 서명자가 개별 실행
POST /admin/governance/sign
Body: { "proposalId": "...", "signature": "0x..." }

# 서명 현황 확인
GET /admin/governance/proposals/:proposalId
# { "signatureCount": 1, "threshold": 2, "signers": [...] }
```

### Step 5 — 프로덕션 실행

threshold(2) 도달 확인 후 실행:

```bash
# Safe execTransaction 온체인 실행
POST /admin/governance/execute
Body: { "proposalId": "..." }
```

### Step 6 — 업그레이드 후 검증

```bash
# 기존 tokenId 보존 확인
npx hardhat run scripts/verify-upgrade.ts --network mainnet

# 신규 기능 동작 확인
# 감사 로그에 CONTRACT_UPGRADE 기록 확인
GET /admin/audit/export?action=CONTRACT_UPGRADE
```

- [ ] 기존 토큰 보존 확인
- [ ] 신규 기능 정상 동작
- [ ] 감사 로그 기록됨

---

## 서명자 키 분실 복구

서명자 1명 키 분실 시:
1. 남은 2명이 `swapOwner` TX 제안
2. 2-of-3 서명 수집
3. Safe 온체인 실행으로 서명자 교체
4. 신규 서명자 키 생성 및 안전 보관 확인

```bash
# swapOwner 제안 (인프라팀 + 법무팀 승인 후)
POST /admin/governance/swap-owner
Body: { "oldOwner": "0x...", "newOwner": "0x..." }
```

---

## MPC 전환 계획 (Phase 2)

현재 Gnosis Safe 온체인 멀티시그 → Phase 2에서 MPC/TSS 전환 검토:
- **차이**: Safe는 완전한 키가 각자에게 존재 / MPC는 키 파편만 존재(완전한 키 없음)
- **장점**: 키 탈취 자체 불가능 구조
- **적용 포인트**: VASP HOT 키, 내부 서명자 키 관리
