# M5 S27 — 사용자 레이어 진입점 설계 · VASP별 지갑 프로비저닝 분기

> **[Phase 1 — 현재 구현]** 이 모듈은 VASP(VASP) 위탁 아키텍처를 기반으로 합니다.  
> **Phase 1 맥락:** 지갑 생성은 `vaspAdapter.createWallet()`을 통해 VASP에 위탁합니다. Phase 3에서 교보생명이 직접 VASP 인가를 취득한 이후에는 자체 HSM/MPC로 지갑을 생성하는 `KyoboVASPAdapter`로 교체됩니다.

> 모듈 5 · 세션 27 · 1시간  
> 스켈레톤: `internal/apps/issuer-service/src/services/WalletProvisioningService.ts`

---

## 강의 파트 (20분)

### 1. NFT를 발행하기 전에 반드시 필요한 것

M4에서 원장과 감사 로그를 완성했다. 이제 실제 비즈니스 로직이다.

사용자에게 NFT를 발행하려면 두 가지가 필요하다:

1. **누구에게 발행할 것인가**: 교보 내부 userId (예: K-20240001)
2. **어느 주소로 발행할 것인가**: 블록체인 지갑 주소 (예: 0xABCD...)

이 두 가지가 연결되지 않으면 발행 불가능하다. 이 연결이 "지갑 프로비저닝"이다.

---

### 2. 지갑 등록 방식은 두 가지로 나뉜다

Phase 1에서 사용자의 지갑 주소를 시스템에 등록하는 방식은 크게 두 가지다.

| 방식 | private key 위치 | 지갑 주소 출처 | verified 저장 |
|---|---|---|---|
| **수탁 (Custodial)** — Phase 1 기본 | VASP(VASP) 서버 | VASP API 응답 | `true` 즉시 — VASP가 소유권 보장 |
| **비수탁 (Non-Custodial)** — 선택적 지원 | 사용자 본인 | 사용자가 직접 제출 | `false` → EIP-191 서명 후 `true` (S29) |

그리고 교보 내재화(Phase 4):

| VASP 유형 | 예시 | 지갑 관리 주체 | 서버 처리 방식 |
|---|---|---|---|
| EXTERNAL 수탁 | VASP, KorbitCustody | VASP Custody 시스템 | VASP API 호출 → 지갑 주소 조회 → `verified: true` |
| KYOBO | Phase 4 내재화 | 교보 내부 HSM | 직접 생성 → DB 저장 → `verified: true` |

**수탁(Custodial) 방식 — Phase 1 현재:**
VASP(VASP)가 사용자를 위한 Custody 지갑을 생성하고 private key를 보관한다. 서버는 VASP API를 호출해 지갑 주소를 받아온다. VASP가 직접 생성한 지갑이므로 소유권이 자명하다 — 별도 서명 검증 없이 `verified: true`로 저장한다.

**비수탁(Non-Custodial) 방식 — Phase 1 선택적:**
사용자가 MetaMask 같은 자가관리 지갑을 직접 교보 시스템에 등록하는 경우다. 이때는 사용자가 해당 주소의 private key를 실제로 보유하고 있는지 증명해야 한다. 주소만 제출하는 것만으로는 소유권을 알 수 없다 — EIP-191 서명 검증이 필요하다(S29).

**KYOBO 방식**: Phase 4에서 교보가 직접 HSM(Hardware Security Module)으로 키를 관리하는 내재화 단계. Phase 1에서는 미구현이지만 코드 구조는 지금부터 준비해둔다.

---

### 3. 단일 진입점 설계 — 컨트롤러는 분기하지 않는다

만약 컨트롤러에서 VASP 유형에 따라 분기한다면:

```typescript
// ❌ 나쁜 설계 — VASP가 바뀔 때마다 컨트롤러 수정 필요
app.post('/api/wallet/provision', async (req, res) => {
  if (req.body.vaspType === 'EXTERNAL') {
    const addr = await vaspClient.getWalletAddr(req.body.userId);
    await walletMapping.save(req.body.userId, addr, 'EXTERNAL');
  } else if (req.body.vaspType === 'KYOBO') {
    const addr = await vaspClient.createWallet(req.body.userId);
    await walletMapping.save(req.body.userId, addr, 'KYOBO');
  }
  // VASP 추가할 때마다 여기를 수정해야 함
});
```

`POST /api/wallet/provision` 단일 엔드포인트 → `WalletProvisioningService.provision(userId, vaspType)`에서 내부 분기:

```
[Controller]
    POST /api/wallet/provision { userId, vaspType }
         ↓
[WalletProvisioningService.provision(userId, vaspType)]
    ├─ EXTERNAL → vaspClient.getWalletAddr(userId)
    ├─ KYOBO    → vaspClient.createWallet(userId)
    └─ 기타     → UnsupportedVaspError
         ↓
[WalletMappingService.saveMapping(userId, walletAddr, vaspType)]
```

컨트롤러는 요청을 받아서 서비스에 위임하기만 한다. VASP가 새로 추가돼도 컨트롤러는 건드리지 않는다.

---

### 4. WalletProvisioningService 역할 범위

```
WalletProvisioningService (S27)
    → 지갑 주소를 "획득"하는 역할 (VASP API 호출)
    → 최초 등록 시에만 호출됨

WalletMappingService (S28~S29)
    → 획득한 주소를 "관리"하는 역할
    → userId ↔ walletAddr 매핑 DB 조회/저장
    → 이후 모든 발행 요청에서 getWalletAddr() 사용
```

`provision()` 이후에는 `WalletMappingService.getWalletAddr(userId)`만 호출한다. 매번 VASP API를 호출하지 않는다.

---

### 5. M5 전체 의존 관계 아키텍처

S27~S29가 완성되면 아래 구조가 된다.

```
[컨트롤러]
  POST /api/wallet/provision
         │
         ▼
[WalletProvisioningService]         ← S27 실습
  ├── ExternalVaspClient (인터페이스)
  │       └── 구현체: WalletWon HTTP 클라이언트
  │            → getWalletAddr(userId): 기존 custodial 지갑 조회
  │            → createWallet(userId):  신규 지갑 생성 (Phase 4)
  │
  └── WalletMappingService           ← S28~S29 실습
            ├── WalletMappingRepository (인터페이스)
            │       └── 구현체: PgWalletMappingRepository → PostgreSQL
            ├── ExternalVaspWalletClient (인터페이스)
            └── SignatureVerifier (인터페이스)
                     └── 구현체: EthersSignatureVerifier (S29)
```

`WalletProvisioningService`는 두 가지에만 의존한다.

1. `ExternalVaspClient` — VASP API 호출 (지갑 주소 획득)
2. `WalletMappingService` — 획득한 주소를 DB에 저장·조회

S27은 이 두 의존성이 어떻게 연결되는지를 다루고, S28~S29는 `WalletMappingService` 내부를 완성한다.

---

### 6. ExternalVaspClient 인터페이스 — Phase 전환을 위한 추상화

실제 코드의 인터페이스 정의:

```typescript
export interface ExternalVaspClient {
  getWalletAddr(userId: string): Promise<string>;  // 기존 custodial 지갑 조회
  createWallet(userId: string):  Promise<string>;  // 내부 신규 생성 (Phase 4)
}
```

`WalletProvisioningService`가 **인터페이스**에 의존하는 이유:

| Phase | 구현체 | 내용 |
|---|---|---|
| Phase 1 (현재) | `WalletWonAdapter` | VASP REST API 호출 |
| Phase 3 | `KyoboCustodyAdapter` | 교보 자체 HSM/MPC |

Phase 1 → Phase 3 전환 시 `WalletProvisioningService` 코드는 한 글자도 바뀌지 않는다. 생성자에 주입하는 구현체만 교체한다.

```typescript
// Phase 1 — 현재
new WalletProvisioningService(new WalletWonAdapter(apiKey), walletMapping);

// Phase 3 — 교체 후 (이 줄만 바뀜)
new WalletProvisioningService(new KyoboCustodyAdapter(hsm), walletMapping);
```

M4에서 배운 의존성 역전(DIP)이 M5에서도 동일하게 적용된다. 서비스는 "어떻게 지갑을 가져오는지"를 모르고, "지갑을 가져올 수 있다"는 계약(인터페이스)만 안다.

---

## 실습 파트 (35분)

### 스켈레톤 코드

```typescript
// WalletProvisioningService.ts
export class WalletProvisioningService {
  constructor(
    private readonly vaspClient: ExternalVaspClient,
    private readonly walletMapping: WalletMappingService,
  ) {}

  async provision(userId: string, vaspType: VaspType): Promise<ProvisionResult> {
    // TODO: VASP 타입별 분기 구현
    throw new Error('TODO: implement provision()');
  }
}

export interface ExternalVaspClient {
  getWalletAddr(userId: string): Promise<string>;   // 기존 custodial 지갑 조회
  createWallet(userId: string): Promise<string>;    // 내부 신규 생성 (Phase 4)
}
```

### `provision()` 구현

```typescript
async provision(userId: string, vaspType: VaspType): Promise<ProvisionResult> {
  let walletAddress: string;

  if (vaspType === 'EXTERNAL') {
    // VASP API 호출 → 기존 Custody 지갑 주소 조회
    walletAddress = await this.vaspClient.getWalletAddr(userId);
  } else if (vaspType === 'KYOBO') {
    // Phase 4: 교보 내부 HSM으로 지갑 생성
    walletAddress = await this.vaspClient.createWallet(userId);
  } else {
    // 지원하지 않는 VASP 타입 → 명시적 예외
    throw new UnsupportedVaspError(vaspType);
  }

  // 획득한 주소를 매핑 DB에 저장
  await this.walletMapping.saveMapping(userId, walletAddress, vaspType);

  return {
    userId,
    walletAddress,
    vaspType,
    provisionedAt: new Date(),
  };
}
```

### 컨트롤러 라우트 등록

```typescript
// controller.ts
app.post('/api/wallet/provision', async (req, res) => {
  try {
    const { userId, vaspType } = req.body;
    const result = await walletProvisioningService.provision(userId, vaspType);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof UnsupportedVaspError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});
```

### UnsupportedVaspError 에러 클래스

```typescript
export class UnsupportedVaspError extends Error {
  constructor(vaspType: string) {
    super(`지원하지 않는 VASP 타입: ${vaspType}`);
    this.name = 'UnsupportedVaspError';
  }
}
```

### 테스트 케이스

```typescript
describe('WalletProvisioningService', () => {
  const mockVaspClient: ExternalVaspClient = {
    async getWalletAddr(userId) { return `0xExternal-${userId}`; },
    async createWallet(userId) { return `0xKyobo-${userId}`; },
  };

  const mockMapping = { saveMapping: jest.fn() };
  const service = new WalletProvisioningService(mockVaspClient, mockMapping as any);

  it('EXTERNAL → vaspClient.getWalletAddr() 호출', async () => {
    const result = await service.provision('user1', 'EXTERNAL');
    expect(result.walletAddress).toBe('0xExternal-user1');
    expect(mockMapping.saveMapping).toHaveBeenCalledWith('user1', '0xExternal-user1', 'EXTERNAL');
  });

  it('KYOBO → vaspClient.createWallet() 호출', async () => {
    const result = await service.provision('user1', 'KYOBO');
    expect(result.walletAddress).toBe('0xKyobo-user1');
  });

  it('알 수 없는 vaspType → UnsupportedVaspError', async () => {
    await expect(
      service.provision('user1', 'UNKNOWN' as VaspType),
    ).rejects.toThrow(UnsupportedVaspError);
  });
});
```

---

### 5. 중복 프로비저닝 처리 — 이미 등록된 userId가 다시 요청하면?

> **[권장 패턴 / 실습 과제]** 현재 에는 중복 체크가 없다. 아래는 멱등성을 보장하는 권장 구현이다.

`provision()`은 최초 1회만 호출되어야 한다. 그런데 동일 userId로 두 번 요청이 오면 어떻게 해야 하는가?

**선택지 두 가지:**

| 방식 | 동작 | 문제 |
|---|---|---|
| 덮어쓰기 | 항상 VASP API 재호출 → 새 주소 저장 | VASP가 매번 새 주소를 생성하면 이전 지갑과 불일치 |
| 멱등 처리 | 이미 등록된 경우 기존 주소 그대로 반환 | **올바른 선택** |

멱등 처리가 정답이다. 프로비저닝은 "있으면 조회, 없으면 생성" 패턴으로 만든다:

```typescript
async provision(userId: string, vaspType: VaspType): Promise<ProvisionResult> {
  // 이미 등록된 경우 → 기존 주소 반환 (VASP API 재호출 없음)
  const existing = await this.walletMapping.getMapping(userId);
  if (existing) {
    return {
      userId,
      walletAddress: existing.walletAddr,
      vaspType:      existing.vaspType,
      provisionedAt: existing.createdAt,
    };
  }

  // 최초 등록
  let walletAddress: string;
  if (vaspType === 'EXTERNAL') {
    walletAddress = await this.vaspClient.getWalletAddr(userId);
  } else if (vaspType === 'KYOBO') {
    walletAddress = await this.vaspClient.createWallet(userId);
  } else {
    throw new UnsupportedVaspError(vaspType);
  }

  await this.walletMapping.saveMapping(userId, walletAddress, vaspType);
  return { userId, walletAddress, vaspType, provisionedAt: new Date() };
}
```

컨트롤러에서 중복을 별도 처리하지 않는다. 서비스 레이어가 멱등성을 보장하므로 같은 요청을 몇 번 보내도 결과가 동일하다.

---

### 6. VASP API 실패 시 안전성 분석

`vaspClient.getWalletAddr()`가 네트워크 오류로 실패하면 어떻게 되는가?

```
VASP API 호출 실패 → 예외 throw
                   → DB 저장 미실행
                   → user_wallet_mapping 행 없음 (일관된 상태)
```

이 흐름은 안전하다. **VASP 호출이 성공하고 DB 저장이 실패**하는 경우가 문제다:

```
VASP API 호출 성공 → walletAddr 획득
                  → DB INSERT 실패 (네트워크 단절 등)
                  → walletAddr는 VASP에 이미 생성됐지만 DB에 없음
```

재시도 시 `getWalletAddr(userId)`를 VASP에 다시 호출하면 같은 주소를 돌려주므로 실질적 문제는 없다. VASP Custody 시스템은 userId당 지갑이 고정이기 때문이다. 단, VASP가 매번 새 주소를 생성하는 방식이라면 이 가정이 깨진다 — 계약서에서 반드시 확인해야 한다.

---

### 7. 감사 로그 연동 — M4 AuditLog와 연결

> **[권장 패턴 / 실습 과제]** 현재 코드에는 감사 로그 연동이 없다. M4에서 만든 를 주입해 아래와 같이 확장한다.

지갑 프로비저닝은 금융 규제상 기록 대상이다. M4에서 만든 `ICoreBankingAdapter.recordAuditLog()`를 연동한다.

```typescript
export class WalletProvisioningService {
  constructor(
    private readonly vaspClient:    ExternalVaspClient,
    private readonly walletMapping: WalletMappingService,
    private readonly coreBanking:   ICoreBankingAdapter,  // M4 연결
  ) {}

  async provision(userId: string, vaspType: VaspType): Promise<ProvisionResult> {
    const existing = await this.walletMapping.getMapping(userId);
    if (existing) {
      return { userId, walletAddress: existing.walletAddr, vaspType: existing.vaspType, provisionedAt: existing.createdAt };
    }

    let walletAddress: string;
    if (vaspType === 'EXTERNAL') {
      walletAddress = await this.vaspClient.getWalletAddr(userId);
    } else if (vaspType === 'KYOBO') {
      walletAddress = await this.vaspClient.createWallet(userId);
    } else {
      throw new UnsupportedVaspError(vaspType);
    }

    await this.walletMapping.saveMapping(userId, walletAddress, vaspType);

    // 감사 로그 — Java internal-ledger에 기록
    await this.coreBanking.recordAuditLog({
      actor:        'system',
      action:       'WALLET_PROVISIONED',
      resourceType: 'USER',
      resourceId:   userId,
      afterState:   { walletAddress, vaspType },
    });

    return { userId, walletAddress, vaspType, provisionedAt: new Date() };
  }
}
```

`recordAuditLog()`는 `provision()` 완료 후 호출한다. 감사 로그 실패가 프로비저닝 자체를 롤백해서는 안 된다 — 지갑은 이미 등록됐고, 감사 로그는 별도 트랜잭션(`REQUIRES_NEW`)으로 처리되기 때문이다.

---

### 8. 실습 추가 테스트 케이스

> **[실습 과제]** 위 5번·7번 구현 후 아래 테스트를 추가한다.

```typescript
it('이미 프로비저닝된 userId → VASP API 재호출 없음', async () => {
  const vaspSpy = jest.spyOn(mockVaspClient, 'getWalletAddr');

  await service.provision('user1', 'EXTERNAL');  // 최초 등록
  await service.provision('user1', 'EXTERNAL');  // 재요청

  // VASP는 1번만 호출됐어야 함
  expect(vaspSpy).toHaveBeenCalledTimes(1);
});

it('VASP API 실패 → DB 저장 안 됨 (일관 상태)', async () => {
  jest.spyOn(mockVaspClient, 'getWalletAddr').mockRejectedValue(new Error('VASP timeout'));

  await expect(service.provision('user1', 'EXTERNAL')).rejects.toThrow('VASP timeout');

  // DB에 아무것도 저장되지 않았어야 함
  expect(mockMapping.saveMapping).not.toHaveBeenCalled();
});

it('WALLET_PROVISIONED 감사 로그 기록 확인', async () => {
  await service.provision('user1', 'EXTERNAL');

  expect(mockCoreBanking.recordAuditLog).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'WALLET_PROVISIONED', resourceId: 'user1' }),
  );
});
```

---

## 완료 기준

- [ ] POST /api/wallet/provision 라우트 등록
- [ ] vaspType 분기 구조 확인
- [ ] UnsupportedVaspError 테스트 통과
- [ ] 중복 프로비저닝 → VASP API 재호출 없이 기존 주소 반환
- [ ] VASP 실패 시 DB 미저장 테스트 통과
- [ ] WALLET_PROVISIONED 감사 로그 기록 확인
