# Day 12 — M8: 키 거버넌스 (S45~S48)

**세션**: S45~S48 | **모듈**: M8 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: Admin API + Gnosis Safe 배포 + SafeTx 이론 + MultisigService(proposeTx/addSignature/executeTx)

---

## S45: 운영 관리 API 설계 — 컨트랙트 제어와 시스템 운영 인터페이스 (강의 15분 + 실습 40분)

### 강의

**Admin API 레이어 필요성:**
- 컨트랙트 함수(M6)·ReconcileService(M4)는 완성됐으나 운영 진입점 없음
- 대시보드·모니터링 툴이 호출할 REST 엔드포인트 필요

**Admin API 보안 원칙:**
- `ADMIN_ROLE` 검증
- IP 허용 목록 (내부망 전용)
- 감사 로그 의무 기록 (모든 Admin 행위)

### 🔴 실습 (40분) — 수강생 직접 작성

**Step 1**: Admin API 엔드포인트 구현
```typescript
// internal/src/routes/adminRoutes.ts
// TODO: 아래 4개 엔드포인트 구현

// POST /admin/contract/pause
router.post('/admin/contract/pause', requireAdminRole, async (req, res) => {
  // TODO: PAUSER_ROLE 검증
  // TODO: 컨트랙트 pause() 호출
  // TODO: 감사 로그 기록
  // TODO: 201 응답
});

// POST /admin/contract/unpause
router.post('/admin/contract/unpause', requireAdminRole, async (req, res) => {
  // TODO
});

// POST /admin/reconcile
router.post('/admin/reconcile', requireAdminRole, async (req, res) => {
  // TODO: ReconcileService 트리거
  // TODO: 불일치 건수 응답 반환
});

// GET /admin/issuance/stats
router.get('/admin/issuance/stats', requireAdminRole, async (req, res) => {
  // TODO: 상태별 발행 현황 집계
  // { REQUESTED: N, SUBMITTED: N, PENDING: N, CONFIRMED: N, FAILED: N }
});

// POST /admin/roles/grant
router.post('/admin/roles/grant', requireAdminRole, async (req, res) => {
  // TODO: MINTER_ROLE 또는 PAUSER_ROLE 부여
  // TODO: 감사 로그 기록
});
```

**Step 2**: 테스트
```typescript
// TODO: pause/unpause → 컨트랙트 상태 변경 확인
it('pause API → 컨트랙트 pause 상태 확인', async () => {
  await request(app).post('/admin/contract/pause').expect(201);
  // TODO: nft.paused() === true 확인
});

// TODO: reconcile API → 불일치 건수 반환
it('reconcile API → 불일치 건수 반환', async () => {
  const res = await request(app).post('/admin/reconcile').expect(200);
  expect(res.body).toHaveProperty('discrepancies');
});

// TODO: role grant → 감사 로그 기록
it('role grant → audit_log 기록 확인', async () => {
  await request(app).post('/admin/roles/grant').send({ address: '0xNew', role: 'MINTER_ROLE' });
  // TODO: audit_log에 ROLE_GRANTED 항목 확인
});
```

### ✅ 답안

```typescript
// pause 엔드포인트 완성
router.post('/admin/contract/pause', requireAdminRole, async (req, res) => {
  const requester = req.user!.address;

  // PAUSER_ROLE 검증
  const hasPauserRole = await nftContract.hasRole(PAUSER_ROLE, requester);
  if (!hasPauserRole) {
    return res.status(403).json({ error: 'PAUSER_ROLE 없음' });
  }

  await nftContract.connect(signer).pause();
  await auditLog.appendAuditLog(requester, 'CONTRACT_PAUSED', 'KyoboNFT', {});

  res.status(201).json({ paused: true });
});

// reconcile 엔드포인트 완성
router.post('/admin/reconcile', requireAdminRole, async (req, res) => {
  const { userId } = req.body;
  const result = await reconcileService.reconcile(userId);
  res.json({ discrepancies: result.discrepancies.length, details: result.discrepancies });
});

// stats 엔드포인트 완성
router.get('/admin/issuance/stats', requireAdminRole, async (req, res) => {
  const stats = await db('mint_requests')
    .select('status')
    .count('id as count')
    .groupBy('status');
  res.json(Object.fromEntries(stats.map((s) => [s.status, Number(s.count)])));
});
```

### ✅ 완료 기준
- [ ] pause/unpause → 컨트랙트 상태 변경 확인
- [ ] reconcile API → 불일치 건수 반환
- [ ] role grant/revoke → 감사 로그 기록

---

## S46: 다중 서명 기반 키 거버넌스 — Gnosis Safe와 EIP-712 (강의 35분 + 실습 30분)

### 강의

**TX 분류:**
- 일반 mint → VASP 단독 서명 (빠른 처리 필요)
- 업그레이드·대형 TX → **2-of-3 필수** (서명자: VASP, 교보 IT, 준법감시)

**EIP-712 SafeTx:**
- 오프체인 서명으로 온체인 TX 승인
- 구조화된 데이터 해시 + 도메인 분리자
- 재생 공격 방지: 도메인 분리자에 chainId + verifyingContract 포함

**키 분실 복구 절차:**
- 서명자 1명 분실 시 → 남은 2명이 `swapOwner` TX 제안 → 2-of-3 서명 → 서명자 교체

**MPC 향후 거버넌스 진화:**
- Gnosis Safe: 온체인 멀티시그 (완전한 키가 각자에게 있음)
- MPC/TSS: 키 파편 분산 생성 → **완전한 개인키가 어디에도 존재하지 않음**
- 당사 MPC 적용 포인트: VASP HOT 키 / 내부 서명자 키

### 🔴 실습 (30분) — 수강생 직접 작성

**Step 1**: Hardhat fork에서 Gnosis Safe 배포
```typescript
// blockchain/scripts/deploy-gnosis-safe.ts
// TODO: Gnosis Safe 배포 — threshold=2, 서명자 3개 등록

import { ethers } from 'hardhat';

async function main() {
  const [signer1, signer2, signer3] = await ethers.getSigners();
  
  // TODO: Safe Factory 사용하여 Safe 배포
  // Safe 배포 주소: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' (mainnet)
  // 로컬 fork에서 이 주소에 Safe Factory가 배포되어 있어야 함
  
  // threshold = 2
  // owners = [signer1, signer2, signer3]
  console.log('Safe 주소:', safeAddress);
}
```

**Step 2**: SafeTx 해시 계산 확인
```typescript
// TODO: 업그레이드 TX에 대한 SafeTx 해시 계산

const safeTxHash = await safe.getTransactionHash(
  to,        // 컨트랙트 주소
  value,     // ETH 금액 (업그레이드는 0)
  data,      // upgradeTo() 호출 데이터
  operation, // 0 = CALL
  safeTxGas, // 0
  baseGas,   // 0
  gasPrice,  // 0
  gasToken,  // address(0)
  refundReceiver, // address(0)
  nonce,     // await safe.nonce()
);
console.log('SafeTx 해시:', safeTxHash);
```

**Step 3**: 서명자 교체 시나리오 확인
```typescript
// TODO: swapOwner 트랜잭션 구조 확인 (실제 실행 X)
const swapOwnerData = safeInterface.encodeFunctionData('swapOwner', [
  prevOwner,   // 교체할 서명자의 이전 서명자
  oldOwner,    // 제거할 서명자
  newOwner,    // 새 서명자
]);
console.log('swapOwner TX 데이터:', swapOwnerData);
```

### ✅ 답안

```typescript
// Gnosis Safe 배포 (Safe Factory 사용)
import { SafeFactory, Safe } from '@safe-global/protocol-kit';

async function main() {
  const [signer1, signer2, signer3] = await ethers.getSigners();

  const safeFactory = await SafeFactory.create({ provider, signer: signer1.address });
  
  const safeAccountConfig = {
    owners: [signer1.address, signer2.address, signer3.address],
    threshold: 2,
  };
  
  const safe = await safeFactory.deploySafe({ safeAccountConfig });
  console.log('Safe 주소:', await safe.getAddress());
  console.log('threshold:', await safe.getThreshold()); // 2
  console.log('owners:', await safe.getOwners()); // 3명
}
```

### ✅ 완료 기준
- [ ] Safe 배포 + threshold=2 설정
- [ ] SafeTx 해시 계산 확인

---

## S47: 다중 서명 트랜잭션 생명주기 — 제안·서명 수집·실행 프로토콜 설계 (강의 55분)

### 강의 (이론 세션 — 실습 없음)

**단일 HOT 키의 취약점:**
- 키 1개 탈취 시 업그레이드·대형 TX 전권 가능
- **키 하나로 시스템 전체 장악 가능한 구조는 금융 시스템에 부적합**

**k-of-n 멀티시그 설계:**
- threshold 의미: k명 이상이 동의해야 실행 가능
- 당사 구성: VASP(기술 실행) / 당사IT(운영 승인) / 준법감시(컴플라이언스) — 3자 중 2자 동의

**SafeTx 생명주기 전체:**
```
1. proposeTx: SafeTx 해시 계산 + DB 저장
2. addSignature: 각 서명자가 오프체인 서명 → DB 저장
3. threshold 도달 확인
4. executeTx: Safe.execTransaction 온체인 실행
```

**오프체인 서명의 의미:**
- EIP-712 구조화 데이터 서명
- 가스비 없이 각자 서명 가능
- 충분한 서명이 모이면 한 번의 온체인 TX로 실행

**EIP-712 vs 평문 서명 차이:**
- 구조화 데이터 해시 + 도메인 분리자
- 다른 컨트랙트에서 동일 서명 재사용(재생 공격) 방지

**1-of-3 실행 시 revert하는 이유:**
- threshold 검증은 Safe 컨트랙트가 온체인에서 직접 수행
- 서명 수 미달 시 revert

### ✅ 완료 기준 (강의 이해 확인)
- [ ] SafeTx 생명주기 4단계 설명 가능
- [ ] 오프체인 서명의 의미와 EIP-712 역할 설명 가능
- [ ] 1-of-3 revert 이유 설명 가능

---

## S48: MultisigService 구현과 2-of-3 서명 실행 검증 (개요 10분 + 실습 50분)

### 개요 (10분)

SafeTx 생명주기 재확인 / proposeTx → addSignature → executeTx 함수 설계 재확인

### 🔴 실습 (50분) — 수강생 직접 작성

**Step 1**: proposeTx 구현
```typescript
// internal/packages/multisig/src/MultisigService.ts
// TODO: SafeTx 해시 계산 + DB 저장

async proposeTx(
  to: string,
  data: string,
  proposer: string,
): Promise<string> {
  // TODO: nonce 조회 (safe.nonce())
  // TODO: SafeTx 해시 계산
  // TODO: safetx_proposals 테이블에 저장
  // TODO: safeTxHash 반환
}
```

**Step 2**: addSignature 구현
```typescript
// TODO: 오프체인 서명 수집 저장

async addSignature(
  safeTxHash: string,
  signer: string,
  signature: string,
): Promise<void> {
  // TODO: safetx_signatures 테이블에 (safeTxHash, signer, signature) 저장
  // TODO: 중복 서명 방지 (동일 signer 재서명 불가)
}
```

**Step 3**: executeTx 구현
```typescript
// TODO: threshold 확인 후 온체인 실행

async executeTx(safeTxHash: string, executor: string): Promise<string> {
  // TODO: 서명 수 조회 → threshold 미달 시 throw
  // TODO: 서명 목록 정렬 (Safe 요구사항: 주소 오름차순)
  // TODO: safe.execTransaction 호출
  // TODO: txHash 반환
}
```

**Step 4**: 1-of-3 vs 2-of-3 테스트
```typescript
it('1-of-3 서명으로 대형 TX → revert', async () => {
  const safeTxHash = await multisig.proposeTx(target, data, proposer);
  await multisig.addSignature(safeTxHash, signer1.address, await signer1.signMessage(safeTxHash));
  
  // TODO: 1개 서명으로 executeTx → revert 확인
});

it('2-of-3 서명 → 정상 실행', async () => {
  const safeTxHash = await multisig.proposeTx(target, data, proposer);
  await multisig.addSignature(safeTxHash, signer1.address, await signer1.signMessage(...));
  await multisig.addSignature(safeTxHash, signer2.address, await signer2.signMessage(...));
  
  // TODO: 2개 서명으로 executeTx → 성공 확인
});
```

### ✅ 답안

```typescript
// proposeTx 완성
async proposeTx(to: string, data: string, proposer: string): Promise<string> {
  const nonce = await this.safe.getNonce();
  
  const safeTxHash = await this.safe.getTransactionHash({
    to, data,
    value: '0',
    operation: OperationType.Call,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce: nonce.toString(),
  });

  await this.db('safetx_proposals').insert({
    safe_tx_hash: safeTxHash,
    to, data,
    nonce: nonce.toString(),
    proposer,
    created_at: new Date(),
  });

  return safeTxHash;
}

// addSignature 완성
async addSignature(safeTxHash: string, signer: string, signature: string): Promise<void> {
  await this.db('safetx_signatures')
    .insert({ safe_tx_hash: safeTxHash, signer, signature })
    .onConflict(['safe_tx_hash', 'signer'])
    .ignore(); // 중복 서명 무시
}

// executeTx 완성
async executeTx(safeTxHash: string): Promise<string> {
  const signatures = await this.db('safetx_signatures')
    .where({ safe_tx_hash: safeTxHash })
    .orderBy('signer', 'asc'); // Safe: 주소 오름차순 필수

  const threshold = await this.safe.getThreshold();
  if (signatures.length < threshold) {
    throw new Error(`서명 미달: ${signatures.length}/${threshold}`);
  }

  // 서명 연결 (Safe 형식: bytes 연결)
  const signatureBytes = signatures.map((s) => s.signature).join('').replace(/^0x/g, '');
  const combinedSignature = '0x' + signatureBytes;

  const proposal = await this.db('safetx_proposals').where({ safe_tx_hash: safeTxHash }).first();
  const txResponse = await this.safe.executeTransaction({
    ...proposal,
    signatures: combinedSignature,
  });

  return txResponse.hash;
}
```

### ✅ M8 전반부 완료 기준
- [ ] 1-of-3 서명으로 대형 TX → revert
- [ ] 2-of-3 서명 → 정상 실행
