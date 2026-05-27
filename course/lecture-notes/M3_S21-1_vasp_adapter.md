# M3 S21-1 — VASP 추상화 구조: IVASPAdapter · ExternalVASPAdapter · Phase 3 전환 설계

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S21-1 · 강의 40분  
> 대상: `internal/packages/vasp/src/`

---

## S21-1 — VASP 추상화 레이어 전체 구조

> S14/S15가 `IBlockchainAdapter` → `EVMAdapter` 구조를 다뤘듯,
> S21-1은 VASP 쪽 동일한 추상화 — `IVASPAdapter` → `ExternalVASPAdapter` → `KyoboVASPAdapter` 구조를 다룬다.

---

### 1. 왜 VASP를 인터페이스로 추상화하는가

```
문제: Phase 1에서 외부 VASP(월렛원)를 직접 호출하면?

  IssuerService → 월렛원 REST API 직접 호출
  Phase 3에서 교보 자체 VASP 취득 시:
    → IssuerService 코드 전체 수정
    → 테스트 교체
    → 배포 리스크

해결: 인터페이스로 감싸기

  IssuerService → IVASPAdapter (인터페이스)
                      │
                 ┌────┴────────────────────┐
                 │                         │
         ExternalVASPAdapter        KyoboVASPAdapter
         (Phase 1 — 외부 VASP)     (Phase 3 — 자체 VASP)

  Phase 전환 = DI 컨테이너 바인딩 교체 1줄
  IssuerService 코드 수정 없음
```

**규제 맥락:**

```
특금법상 가상자산사업자(VASP) 신고/인가 없이는 직접 운영 불가
→ Phase 1: 인가받은 외부 VASP 파트너사(월렛원)에 TX 위탁
→ Phase 3: 교보생명이 직접 VASP 인가 취득 시 내재화
```

---

### 2. IVASPAdapter 인터페이스 — 선언 위치와 메서드

**파일:** `internal/packages/vasp/src/interfaces/IVASPAdapter.ts`

```typescript
export interface IVASPAdapter {
  // Phase 1 핵심 write 경로 — TX 서명·브로드캐스트 위탁
  // VASP가 완료 후 NFT_ISSUED Webhook으로 통보
  submitTransaction(params: SubmitTransactionParams): Promise<VASPTransactionReceipt>;

  // 사용자 수탁 지갑 생성/조회
  createWallet(userId: string): Promise<WalletInfo>;
  getWallet(userId: string): Promise<WalletInfo | null>;

  // 토큰 전송 (Travel Rule 데이터 포함)
  transfer(req: TransferRequest): Promise<TransferResult>;

  // TX 상태 조회 (pollStaleRequests에서 사용)
  getTransferStatus(txHash: string): Promise<TransferResult>;

  // AML 스크리닝 — 블랙리스트 주소 여부
  screenAddress(address: string): Promise<{ flagged: boolean; reason?: string }>;
}
```

**핵심 타입:**

```typescript
interface SubmitTransactionParams {
  contractAddr:   string;
  abi:            unknown[];
  method:         string;
  args:           unknown[];
  idempotencyKey: string;  // 중복 TX 방지 — activityId 등 비즈니스 고유 키
}

interface TravelRuleData {
  originator:  { name: string; accountId: string; vasp: string };
  beneficiary: { name: string; accountId: string; vasp: string };
}
// Travel Rule: 특금법 §8의4 — 100만원 이상 이체 시 수신자 정보 VASP 간 교환 의무
```

---

### 3. ExternalVASPAdapter — Phase 1 구현체

**파일:** `internal/packages/vasp/src/external/ExternalVASPAdapter.ts`

```
역할: 외부 인가 VASP(월렛원) REST API 호출

보안 요구사항:
  - API 키는 환경 변수 또는 KMS에서 주입 (코드 하드코딩 금지)
  - 모든 호출은 내부망 → 외부 VASP API 방화벽 경유
  - Travel Rule: 100만원 이상 이체 시 travelRuleData 필수
```

**핵심 메서드 흐름:**

```typescript
// Phase 1 write 경로
async submitTransaction(params): Promise<VASPTransactionReceipt> {
  // POST /transactions → 월렛원이 TX 서명·브로드캐스트
  // 완료 후 Webhook(NFT_ISSUED)으로 issuer-service에 통보
  const res = await this._request('POST', '/transactions', { ... });
  return { txHash, status, timestamp };
}

// pollStaleRequests에서 사용
async getTransferStatus(txHash): Promise<TransferResult> {
  // GET /transfers/:txHash → 월렛원 TX 상태 조회
  const res = await this._request('GET', `/transfers/${txHash}`);
  return { txHash, status, fee };
}
```

---

### 4. VaspTxClientAdapter — 브릿지 레이어

**파일:** `internal/packages/vasp/src/tx/VaspTxClientAdapter.ts`

```
역할: IVASPAdapter(비즈니스 추상화) → VaspTxClient(TX 실행 추상화) 변환

왜 필요한가:
  TxStateMachineService는 VaspTxClient 인터페이스(submitMint, getStatus, resubmitWithGasBump)를 요구
  IVASPAdapter는 비즈니스 언어(submitTransaction, getTransferStatus)를 사용
  → 두 인터페이스 사이의 언어 번역 역할
```

```typescript
class VaspTxClientAdapter implements VaspTxClient {
  constructor(
    private vasp:          IVASPAdapter,   // ExternalVASPAdapter 또는 KyoboVASPAdapter
    private nftIssuerAddr: string,
  ) {}

  // VaspTxClient.submitMint() → IVASPAdapter.submitTransaction() 변환
  async submitMint(params): Promise<{ txHash }> {
    const receipt = await this.vasp.submitTransaction({
      contractAddr:   this.nftIssuerAddr,
      abi:            NFT_ISSUER_ABI,
      method:         'mint',
      args:           [to, tokenId, amount, requestIdHex],
      idempotencyKey: params.requestId,
    });
    return { txHash: receipt.txHash };
  }

  // VaspTxClient.getStatus() → IVASPAdapter.getTransferStatus() 변환
  async getStatus(txHash): Promise<{ status, blockNumber?, revertReason? }> {
    const result = await this.vasp.getTransferStatus(txHash);
    // VASP 상태어 → 내부 상태어 변환
    // completed → confirmed / pending → pending / 기타 → failed
    return { status };
  }

  // Phase 3에서 구현 예정
  async resubmitWithGasBump(): Promise<{ txHash }> {
    throw new Error('Phase 3에서 구현 예정');
  }
}
```

**레이어 전체 조립도:**

```
IssuerService
    │
    ▼
IVASPAdapter (인터페이스)
    │
ExternalVASPAdapter.submitTransaction()
    │
    ▼ (VaspTxClientAdapter가 변환)
VaspTxClient (인터페이스)
    │
TxStateMachineService.submitMintRequest()
```

---

### 5. KyoboVASPAdapter — Phase 3 stub

**파일:** `internal/packages/vasp/src/internal/KyoboVASPAdapter.ts`

```
현재 상태: 모든 메서드 throw — 향후 내재화 시 구현

교체 범위:
  index.ts 한 줄:
    // Phase 1
    const vaspAdapter = new ExternalVASPAdapter({ baseUrl, apiKey });

    // Phase 3
    const vaspAdapter = new KyoboVASPAdapter({ hsmEndpoint, mpcConfig });

  IssuerService / TxStateMachineService 코드 수정 없음
```

**Phase 3 내재화 시 구현 항목:**

```
1. HSM/MPC 기반 지갑 생성·서명
   - Private key가 서버 메모리에 존재하지 않는 구조 필수
   - 금융보안원 전자금융기반시설 보안 요건 준수

2. Travel Rule 자체 처리
   - TRISA 또는 VerifyVASP 프로토콜 직접 구현
   - 상대방 VASP와 암호화 채널로 수신자 정보 교환

3. AML 자체 스크리닝
   - Chainalysis 또는 Elliptic API 직접 연동

4. 출금 한도·승인 워크플로우
   - 대규모 출금 다중 서명 승인 (M-of-N)
```

---

### 6. IBlockchainAdapter vs IVASPAdapter — 두 추상화 비교

```
                   IBlockchainAdapter          IVASPAdapter
                   ─────────────────           ────────────
선언 위치          chain-adapters/interfaces/  vasp/interfaces/
Phase 1 구현체     EVMAdapter (read-only)       ExternalVASPAdapter
Phase 3 구현체     EVMAdapter (write 활성화)    KyoboVASPAdapter
역할               블록체인 RPC 추상화          TX 위탁·지갑 관리 추상화
write 권한         Phase 3에서 활성화           Phase 1부터 위탁
교체 방법          DI 교체                      DI 교체

공통점:
  - 둘 다 Strategy Pattern
  - 상위 레이어(IssuerService, TxStateMachineService)는 구현체를 모름
  - Phase 전환 = DI 바인딩 교체 1줄
```

---

### 7. Phase 1 → Phase 3 전환 체크리스트

```
Phase 1 (현재):
  ✅ ExternalVASPAdapter — 월렛원 REST API 위탁
  ✅ chainAdapter — read-only (FINALIZED 확인, 이벤트 구독)
  ✅ VaspTxClientAdapter — IVASPAdapter → VaspTxClient 브릿지

Phase 3 전환 시 변경 사항:
  □ KyoboVASPAdapter 구현 (HSM/MPC + Travel Rule + AML)
  □ index.ts: ExternalVASPAdapter → KyoboVASPAdapter 교체 (1줄)
  □ chainAdapter.sendTransaction() 활성화 (privateKey 주입)
  □ VaspTxClientAdapter.resubmitWithGasBump() 구현
     (월렛원은 gas bump 미지원 → 자체 NonceManager + Broadcaster 필요)
  □ VASP 인가 취득 → 규제 준수 체계 구축

변경 불필요:
  ✅ IssuerService 비즈니스 로직
  ✅ TxStateMachineService 상태 머신
  ✅ IssuanceConfirmHandler
  ✅ TxTransitionBridge
  ✅ 모든 테스트 (인터페이스 기반 Mock 사용)
```

---

### 8. 실습 설계 문제

```
Q1. ExternalVASPAdapter를 KyoboVASPAdapter로 교체할 때
    수정해야 하는 파일은 어디인가?

Q2. VaspTxClientAdapter가 없다면 TxStateMachineService는
    어떻게 IVASPAdapter를 사용해야 하는가?
    이 방식의 문제점은?

Q3. pollStaleRequests()에서 vasp.getStatus(txHash)를 호출한다.
    이때 실제 호출 경로를 추적하면?
    (VaspTxClientAdapter → IVASPAdapter → 어디로 가는가)
```

**정답:**

```
A1. index.ts 1줄만 수정:
    new ExternalVASPAdapter({...}) → new KyoboVASPAdapter({...})

A2. TxStateMachineService가 IVASPAdapter를 직접 알아야 함
    → TxStateMachineService에 VASP 비즈니스 언어가 침투
    → 단일 책임 원칙(SRP) 위반
    VaspTxClientAdapter가 언어 번역 + 책임 분리를 담당

A3. pollStaleRequests → vasp.getStatus(txHash)
      [vasp: VaspTxClient = VaspTxClientAdapter]
    VaspTxClientAdapter.getStatus(txHash)
      → this.vasp.getTransferStatus(txHash)
      [this.vasp: IVASPAdapter = ExternalVASPAdapter]
    ExternalVASPAdapter.getTransferStatus(txHash)
      → GET /transfers/:txHash (월렛원 REST API)
```

---

**완료 기준:**
- [ ] IVASPAdapter가 선언된 위치와 포함된 메서드 6개 설명
- [ ] ExternalVASPAdapter Phase 1 역할 — 월렛원 REST API 위탁, Travel Rule, AML
- [ ] VaspTxClientAdapter 브릿지 역할 — 두 인터페이스 간 언어 번역
- [ ] KyoboVASPAdapter stub 구조 — 현재 throw, Phase 3 내재화 항목 4가지
- [ ] Phase 3 전환 시 변경 파일 vs 변경 불필요 파일 구분
- [ ] IBlockchainAdapter vs IVASPAdapter 비교 — 역할·Phase·교체 방법
- [ ] A3 경로 추적: pollStaleRequests → VaspTxClientAdapter → ExternalVASPAdapter → 월렛원 API
