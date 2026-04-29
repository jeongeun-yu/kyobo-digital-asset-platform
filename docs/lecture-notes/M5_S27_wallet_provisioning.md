# M5 S27 — 사용자 레이어 진입점 설계 · VASP별 지갑 프로비저닝 분기

> 모듈 5 · 세션 27 · 1시간  
> 스켈레톤: `dmz/apps/issuer-service/src/services/WalletProvisioningService.ts`

---

## 강의 파트 (20분)

### 1. NFT를 발행하기 전에 반드시 필요한 것

M4에서 원장과 감사 로그를 완성했다. 이제 실제 비즈니스 로직이다.

사용자에게 NFT를 발행하려면 두 가지가 필요하다:

1. **누구에게 발행할 것인가**: 교보 내부 userId (예: K-20240001)
2. **어느 주소로 발행할 것인가**: 블록체인 지갑 주소 (예: 0xABCD...)

이 두 가지가 연결되지 않으면 발행 불가능하다. 이 연결이 "지갑 프로비저닝"이다.

---

### 2. VASP 유형에 따라 지갑 획득 방식이 다르다

교보생명이 협력하는 VASP에 따라 지갑 획득 방법이 달라진다.

| VASP 유형 | 예시 | 지갑 관리 주체 | 서버 처리 방식 |
|---|---|---|---|
| EXTERNAL | 월렛원, KorbitCustody | VASP Custody 시스템 | VASP API 호출 → 지갑 주소 조회 |
| KYOBO | Phase 4 내재화 | 교보 내부 HSM | 직접 생성 → DB 저장 |

**EXTERNAL 방식**: VASP(예: 월렛원)가 사용자를 위한 Custody 지갑을 관리한다. 서버는 VASP API를 호출해서 userId에 해당하는 지갑 주소를 가져온다.

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

## 완료 기준

- [ ] POST /api/wallet/provision 라우트 등록
- [ ] vaspType 분기 구조 확인
- [ ] UnsupportedVaspError 테스트 통과
- [ ] saveMapping 호출 확인
