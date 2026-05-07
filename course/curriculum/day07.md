# Day 07 — M4 마무리 + M5 전반부: 원장 완성 + 비즈니스 로직 진입 (S25~S28)

**세션**: S25~S28 | **모듈**: M4~M5 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: Reconcile + SHA-256 감사 체인 + 지갑 프로비저닝 + user-wallet 매핑

---

## S25: 온체인 상태와 내부 원장의 정합성 유지 원칙 (강의 20분 + 실습 35분)

### 강의

**Reconcile 원칙:**
- 온체인 `balanceOf()`가 항상 진실
- 원장이 불일치하면 원장을 온체인 기준으로 수정

**불일치 발생 시나리오:**
- Consumer 장애로 이벤트 미처리
- Reorg 후 원장 미업데이트

**역방향 금지 (절대 규칙):**
- 원장 값으로 온체인을 수정하는 코드는 절대 없어야 함
- ReconcileService는 읽기만 하고 온체인을 수정하지 않음

### 🔴 실습 (35분) — 수강생 직접 작성

**Step 1**: reconcile 구현
```typescript
// internal/packages/ledger/src/ReconcileService.ts
// TODO: 온체인 잔액 조회 → 원장 비교 → 불일치 시 보정

async reconcile(userId: string): Promise<ReconcileResult> {
  // TODO: 사용자의 모든 tokenId에 대해
  //   1. adapter.balanceOf(walletAddress, tokenId) 호출
  //   2. DB user_nft_holdings 조회
  //   3. 불일치 시: 원장을 온체인 값으로 덮어쓰기 + 감사 로그 + 알림

  const walletAddress = await this.walletService.getWalletAddress(userId);
  const holdings = await this.db('user_nft_holdings').where({ user_id: userId });

  const discrepancies: Discrepancy[] = [];

  for (const holding of holdings) {
    const onchain = await this.adapter.balanceOf(walletAddress, BigInt(holding.token_id));
    
    if (onchain !== BigInt(holding.amount)) {
      // TODO: 불일치 처리
    }
  }

  return { userId, discrepancies, checkedAt: new Date() };
}
```

**Step 2**: 강제 불일치 삽입 테스트
```typescript
it('강제 불일치 → Reconcile 감지 + 보정', async () => {
  // 1. user_nft_holdings에 amount = 5 강제 삽입
  await db('user_nft_holdings').insert({ user_id: 'alice', token_id: '1001', amount: 5 });
  
  // 2. 온체인 잔액은 3으로 설정 (Mock)
  mockAdapter.setBalance('alice-wallet', 1001n, 3n);
  
  // 3. reconcile 실행
  const result = await reconcileService.reconcile('alice');
  
  // TODO: discrepancies에 1건 포함 확인
  // TODO: DB amount가 3으로 수정됐는지 확인
});
```

### ✅ 답안

```typescript
// reconcile 완성
async reconcile(userId: string): Promise<ReconcileResult> {
  const walletAddress = await this.walletService.getWalletAddress(userId);
  const holdings = await this.db('user_nft_holdings').where({ user_id: userId });
  const discrepancies: Discrepancy[] = [];

  for (const holding of holdings) {
    const onchain = await this.adapter.balanceOf(walletAddress, BigInt(holding.token_id));
    const local = BigInt(holding.amount);

    if (onchain !== local) {
      discrepancies.push({
        tokenId: holding.token_id,
        onchain: Number(onchain),
        local: Number(local),
      });

      // 원장을 온체인 기준으로 보정 (역방향 금지 — 온체인 수정 없음)
      await this.db('user_nft_holdings')
        .where({ user_id: userId, token_id: holding.token_id })
        .update({ amount: Number(onchain), updated_at: new Date() });

      await this.ledger.appendAuditLog(
        'ReconcileService',
        'RECONCILE_CORRECTION',
        holding.token_id,
        { onchain: Number(onchain), local: Number(local) },
      );

      console.error(`[Reconcile] 불일치 감지: userId=${userId}, tokenId=${holding.token_id}, onchain=${onchain}, local=${local}`);
    }
  }

  return { userId, discrepancies, checkedAt: new Date() };
}
```

### ✅ 완료 기준
- [ ] 강제 불일치 → Reconcile 감지 + 보정
- [ ] 역방향 수정 코드 없음 확인

---

## S26: 금융 규제 대응 감사 로그 — SHA-256 체인과 불변성 보장 (강의 20분 + 실습 35분)

### 강의

**Append-only 원칙:**
- UPDATE/DELETE 금지
- 보정도 새 INSERT
- 규제 요건 충족: 5년 보관, 삭제 불가

**SHA-256 체인:**
```
checksum_n = SHA256(prev_checksum + event_time + actor + action + resourceId + afterState)
```
중간 1개 삭제 시 이후 전체 불일치 → 위변조 감지

### 🔴 실습 (35분) — 수강생 직접 작성

**Step 1**: appendAuditLog 구현
```typescript
// internal/packages/ledger/src/AuditLogService.ts
// TODO: SHA-256 체인 감사 로그 추가

async appendAuditLog(
  actor: string,
  action: string,
  resourceId: string,
  afterState: unknown,
): Promise<void> {
  // TODO: 직전 checksum 조회 (가장 최근 레코드)
  // TODO: 현재 checksum 계산: SHA256(prev + now + actor + action + resourceId + afterState)
  // TODO: INSERT INTO audit_log
}
```

**Step 2**: verifyChainIntegrity 구현
```typescript
// TODO: 전체 순회, checksum 재계산, 첫 번째 불일치 위치 반환

async verifyChainIntegrity(): Promise<{ valid: boolean; firstBadId?: number }> {
  const logs = await this.db('audit_log').orderBy('id', 'asc');
  
  let prevChecksum = '';
  
  for (const log of logs) {
    // TODO: checksum 재계산
    // TODO: log.checksum과 비교 → 불일치 시 { valid: false, firstBadId: log.id } 반환
  }
  
  return { valid: true };
}
```

**Step 3**: 무결성 훼손 테스트
```typescript
it('중간 레코드 DELETE → checksum 불일치 감지', async () => {
  // 감사 로그 5개 추가
  await auditLog.appendAuditLog('user', 'MINT', '1001', {});
  await auditLog.appendAuditLog('user', 'BURN', '1001', {});
  // ... 3개 더

  // 중간 레코드 삭제
  await db('audit_log').where({ id: 3 }).delete();

  // 무결성 검증 → 불일치 감지
  const result = await auditLog.verifyChainIntegrity();
  // TODO: result.valid === false 확인
});
```

### ✅ 답안

```typescript
// appendAuditLog 완성
import * as crypto from 'crypto';

async appendAuditLog(actor: string, action: string, resourceId: string, afterState: unknown): Promise<void> {
  const last = await this.db('audit_log').orderBy('id', 'desc').first();
  const prevChecksum = last?.checksum ?? '';

  const now = new Date().toISOString();
  const data = `${prevChecksum}|${now}|${actor}|${action}|${resourceId}|${JSON.stringify(afterState)}`;
  const checksum = crypto.createHash('sha256').update(data).digest('hex');

  await this.db('audit_log').insert({
    actor, action,
    resource_id: resourceId,
    after_state: afterState,
    checksum,
    created_at: now,
  });
}

// verifyChainIntegrity 완성
async verifyChainIntegrity(): Promise<{ valid: boolean; firstBadId?: number }> {
  const logs = await this.db('audit_log').orderBy('id', 'asc');
  let prevChecksum = '';

  for (const log of logs) {
    const data = `${prevChecksum}|${log.created_at}|${log.actor}|${log.action}|${log.resource_id}|${JSON.stringify(log.after_state)}`;
    const expected = crypto.createHash('sha256').update(data).digest('hex');

    if (expected !== log.checksum) {
      return { valid: false, firstBadId: log.id };
    }
    prevChecksum = log.checksum;
  }

  return { valid: true };
}
```

### ✅ M4 완료 기준
- [ ] 감사 로그 중간 삭제 → checksum 불일치 감지
- [ ] afterState 수정 → 감지
- [ ] chain integrity 검증 통과

---

## S27: 사용자 레이어 진입점 설계 — VASP별 지갑 프로비저닝 분기 (강의 20분 + 실습 35분)

### 강의

**사용자 레이어 → 내부망 진입 인터페이스:**
- `POST /api/wallet/provision` 단일 엔드포인트
- VASP별 분기: 월렛원(앱 서명) vs 코다(서버 생성)

**VASP별 분기:**
- 월렛원: 앱에서 `eth_sign` 후 signature 서버 전달 → 서명 검증 → DB 저장
- 코다: 서버가 Custody API 직접 호출 → 지갑 자동 생성 → DB 저장

### 🔴 실습 (35분) — 수강생 직접 작성

**Step 1**: POST /api/wallet/provision 컨트롤러
```typescript
// internal/src/routes/walletRoutes.ts
// TODO: 컨트롤러 + 라우트 등록

router.post('/api/wallet/provision', async (req, res) => {
  const { userId, vaspType, signature, walletAddress } = req.body;
  
  try {
    // TODO: WalletProvisioningService.provision() 호출
    // TODO: 성공 시 201 응답
  } catch (err) {
    // TODO: UnsupportedVaspError → 400
    // TODO: 기타 → 500
  }
});
```

**Step 2**: WalletProvisioningService.provision 구현
```typescript
// internal/packages/business/src/WalletProvisioningService.ts
// TODO: VASP 타입별 분기 구현

async provision(
  userId: string,
  vaspType: string,
  options: { signature?: string; walletAddress?: string },
): Promise<string> {
  if (vaspType === 'walleton') {
    // TODO: 서명 검증 → DB 저장
  } else if (vaspType === 'coda') {
    // TODO: Custody API 호출 → 지갑 자동 생성 → DB 저장
  } else {
    // TODO: UnsupportedVaspError throw
  }
}
```

**Step 3**: UnsupportedVaspError 테스트
```typescript
it('미지원 vaspType → UnsupportedVaspError', async () => {
  await expect(
    service.provision('user-1', 'unsupported-vasp', {}),
  ).rejects.toThrow(UnsupportedVaspError);
});
```

### ✅ 답안

```typescript
// WalletProvisioningService 완성
export class UnsupportedVaspError extends Error {
  constructor(vaspType: string) {
    super(`Unsupported VASP type: ${vaspType}`);
    this.name = 'UnsupportedVaspError';
  }
}

async provision(userId: string, vaspType: string, options: ProvisionOptions): Promise<string> {
  switch (vaspType) {
    case 'walleton': {
      if (!options.signature || !options.walletAddress) {
        throw new Error('월렛원: signature와 walletAddress 필요');
      }
      await this.registerWalletAddress(userId, options.walletAddress, options.signature);
      return options.walletAddress;
    }
    case 'coda': {
      const walletAddress = await this.codaClient.createWallet(userId);
      await this.db('user_wallet_mapping').insert({
        user_id: userId,
        wallet_address: walletAddress,
        vasp_type: 'coda',
        created_at: new Date(),
      });
      return walletAddress;
    }
    default:
      throw new UnsupportedVaspError(vaspType);
  }
}
```

### ✅ 완료 기준
- [ ] POST /api/wallet/provision 라우트 등록
- [ ] vaspType 분기 구조 확인
- [ ] UnsupportedVaspError 테스트 통과

---

## S28: 온체인 식별자와 내부 사용자 ID의 매핑 설계 (강의 25분 + 실습 30분)

### 강의

**user_id ↔ wallet_address 매핑 필요성:**
- 당사 내부 식별자와 블록체인 주소 분리
- 1:1(기본) vs 1:N(멀티 지갑 지원 시)

**VASP별 지갑 주소 종류:**
- 월렛원: 사용자 직접 Web3 연결(외부 지갑)
- 코다: Custody 시스템 생성(내부)

**지갑 주소 등록 흐름:**
```
앱 로그인 → 지갑 연결 → eth_sign → ecrecover 서명 검증 → DB 저장
```

### 🔴 실습 (30분) — 수강생 직접 작성

**Step 1**: user_wallet_mapping 테이블 마이그레이션
```typescript
// TODO: 마이그레이션 작성
await knex.schema.createTable('user_wallet_mapping', (t) => {
  // TODO: user_id, wallet_address, vasp_type, is_active, created_at
  // TODO: UNIQUE(user_id, wallet_address) — 중복 등록 방지
});
```

**Step 2**: 지갑 주소 등록 흐름 시퀀스 다이어그램 직접 그리기 (화이트보드)
```
월렛원 방식:
앱 → [eth_sign(nonce)] → 서버 → [ecrecover] → DB 저장

코다 방식:
서버 → [Custody API 호출] → 지갑 생성 → DB 저장
```

**Step 3**: WalletNotFoundError 예외 클래스
```typescript
// TODO: WalletNotFoundError 정의

export class WalletNotFoundError extends Error {
  constructor(userId: string) {
    // TODO: 메시지 + name 설정
  }
}

// getWalletAddress: 없으면 WalletNotFoundError throw
async getWalletAddress(userId: string): Promise<string> {
  const mapping = await this.db('user_wallet_mapping')
    .where({ user_id: userId, is_active: true })
    .first();
  
  if (!mapping) throw new WalletNotFoundError(userId);
  return mapping.wallet_address;
}
```

### ✅ 답안

```typescript
// 마이그레이션 완성
await knex.schema.createTable('user_wallet_mapping', (t) => {
  t.increments('id');
  t.string('user_id').notNullable();
  t.string('wallet_address').notNullable();
  t.string('vasp_type').notNullable(); // 'walleton' | 'coda'
  t.boolean('is_active').defaultTo(true);
  t.timestamp('created_at').defaultTo(knex.fn.now());
  t.unique(['user_id', 'wallet_address']);
  t.index('user_id');
});

// WalletNotFoundError 완성
export class WalletNotFoundError extends Error {
  constructor(userId: string) {
    super(`Wallet not found for user: ${userId}`);
    this.name = 'WalletNotFoundError';
  }
}
```

### ✅ 완료 기준
- [ ] user_wallet_mapping 마이그레이션 완성
- [ ] WalletNotFoundError 정의
