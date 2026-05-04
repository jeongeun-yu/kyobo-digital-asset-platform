# Day 04 — M3: VASP 추상화 + TX 상태머신 전반부 (S13~S16)

**세션**: S13~S16 | **모듈**: M3 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: TX 상태머신 + IBlockchainAdapter 이론 + EVM 어댑터 구현 + Idempotency

---

## S13: 비동기 트랜잭션의 상태 관리와 전이 규칙 설계 (강의 25분 + 실습 30분)

### 강의

**TX 상태머신:**
```
REQUESTED → SUBMITTED → PENDING → MINED → CONFIRMED
                                        ↘ FAILED
                                        ↘ REORGED
```
각 전이 조건:
- `REQUESTED→SUBMITTED`: VASP API 호출 성공
- `SUBMITTED→PENDING`: VASP 수신 확인
- `PENDING→MINED`: 블록에 포함됨
- `MINED→FINALIZED`: PoS 2/3+ validator 동의 (약 12분, 절대 불변)
- `FINALIZED→CONFIRMED`: 원장 업데이트 완료 — 종단 상태
- `MINED→FAILED`: REVERT 발생
- `MINED→REORGED`: FINALIZED 이전 REORG 발생 (FINALIZED 이후 REORG 불가)

**상태머신 없이 단순 HTTP 호출만 하면:**
- 네트워크 에러 재시도 → 중복 발행
- 타임아웃 후 실제로 처리됐는지 모름 → 유실 or 중복
- 재시도 폭발 시나리오

**유효 전이 가드 원칙:**
- 허용되지 않은 전이는 예외 + DB 롤백
- 상태 불일치 방지

### 🔴 실습 (30분) — 수강생 직접 작성

**Step 1**: IVaspAdapter 인터페이스 정의
```typescript
// internal/packages/vasp/src/interfaces/IVaspAdapter.ts
// TODO: 아래 메서드를 포함하는 인터페이스 정의
// - submitMintRequest(userId, tokenId, amount): Promise<string> (requestId 반환)
// - submitBurnRequest(userId, tokenId, amount): Promise<string>
// - getRequestStatus(requestId): Promise<TxStatus>

export interface IVaspAdapter {
  // TODO: 각 메서드 시그니처 작성
}
```

**Step 2**: VALID_TRANSITIONS 맵 구현
```typescript
// internal/packages/vasp/src/TxStateMachine.ts
// TODO: 상태별 허용 전이 목록 정의

type TxStatus = 'REQUESTED' | 'SUBMITTED' | 'PENDING' | 'MINED' | 'FINALIZED' | 'CONFIRMED' | 'FAILED' | 'REORGED';

const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  // TODO: 각 상태에서 허용되는 다음 상태 목록
  REQUESTED: [],
  SUBMITTED: [],
  PENDING: [],
  MINED: [],
  FINALIZED: [],
  CONFIRMED: [],
  FAILED: [],
  REORGED: [],
};
```

**Step 3**: transitionStatus 구현
```typescript
// TODO: 허용되지 않은 전이는 예외 발생
async function transitionStatus(
  requestId: string,
  from: TxStatus,
  to: TxStatus,
  db: Knex,
): Promise<void> {
  // TODO: VALID_TRANSITIONS[from]에 to가 없으면 throw new Error
  // TODO: 허용된 전이면 DB 업데이트
}
```

### ✅ 답안

```typescript
// IVaspAdapter 완성
export interface IVaspAdapter {
  submitMintRequest(userId: string, tokenId: bigint, amount: number): Promise<string>;
  submitBurnRequest(userId: string, tokenId: bigint, amount: number): Promise<string>;
  getRequestStatus(requestId: string): Promise<TxStatus>;
}

// VALID_TRANSITIONS 완성
const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  REQUESTED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['PENDING',   'FAILED'],
  PENDING:   ['MINED',     'FAILED'],
  MINED:     ['FINALIZED', 'REORGED', 'FAILED'],
  FINALIZED: ['CONFIRMED'],
  CONFIRMED: [],                          // 종단 — 원장 업데이트 완료
  FAILED:    [],                          // 종단
  REORGED:   ['MINED',     'FAILED'],
};

// transitionStatus 완성
async function transitionStatus(
  requestId: string,
  from: TxStatus,
  to: TxStatus,
  db: Knex,
): Promise<void> {
  const allowed = VALID_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid transition: ${from} → ${to}`);
  }
  await db('mint_requests').where({ id: requestId, status: from }).update({
    status: to,
    updated_at: new Date(),
  });
}
```

### ✅ 완료 기준
- [ ] VALID_TRANSITIONS 맵 구현
- [ ] 허용 안 된 전이 → 예외 테스트 통과

---

## S14: 멀티체인 추상화 레이어 — IBlockchainAdapter 설계와 체인 패러다임 비교 (강의 55분)

### 강의 (이론 세션 — 실습 없음)

**EVM 고착화 리스크:**
- gas·Nonce·event log·ABI decode 등 EVM 전용 가정이 코드 전반에 묶임
- XRPL·ARC 전환 시 교체 범위 예측 불가 → IBlockchainAdapter로 격리 필요

**IBlockchainAdapter 설계 원칙:**
- 발행·소각·잔액 조회·TX 검증·이벤트 구독을 체인 무관하게 추상화
- IVaspAdapter와 동일한 Strategy Pattern 적용

**EVM vs XRPL 패러다임 비교:**
| 항목 | EVM | XRPL |
|---|---|---|
| 스마트컨트랙트 | ✓ | ✗ (XLS-20 NFT) |
| 수수료 | gas (Gwei) | fee + reserve |
| 전송 방식 | ABI encode TX | Offer 기반 |
| Account 모델 | EOA (nonce) | Account (sequence) |

**Circle ARC 개요:**
- 프로그래머블 월렛 기반
- 서버 측 키 관리, Account Abstraction 연계
- 서명 흐름이 EOA와 다름 → 어댑터 분리 필요

**멀티체인 전환 전략:**
- VASP가 체인 구현체 선택, 어댑터 주입
- **비즈니스 로직·원장·감사 로그는 체인 무관하게 유지** — 추상화 레이어 설계의 핵심 목적

**당사 적용 로드맵:**
- Phase 1: EVM(현재) → Phase 2: XRPL 병행(국내 규제 대응) → Phase 3: Circle ARC(글로벌)

### ✅ 완료 기준 (강의 이해 확인)
- [ ] EVM·XRPL·Circle ARC 패러다임 핵심 차이 설명 가능
- [ ] IBlockchainAdapter 설계 원칙 설명 가능
- [ ] 당사 멀티체인 적용 순서 근거 제시 가능

---

## S15: IBlockchainAdapter EVM 구현과 멀티체인 전환 시뮬레이션 (개요 10분 + 실습 50분)

### 개요 (10분)

IBlockchainAdapter 인터페이스 재확인 / EVM·XRPL·ARC 어댑터 구조 재확인

### 🔴 실습 (50분) — 수강생 직접 작성

**Step 1**: IBlockchainAdapter 인터페이스 정의
```typescript
// dmz/packages/chain-adapters/src/interfaces/IBlockchainAdapter.ts
// TODO: 체인 공통 작업 추상화

export interface IBlockchainAdapter {
  // TODO: mint(to, tokenId, amount): Promise<string>  (txHash)
  // TODO: burn(from, tokenId, amount): Promise<string>
  // TODO: balanceOf(address, tokenId): Promise<bigint>
  // TODO: verifyTx(txHash): Promise<TxVerifyResult>
  // TODO: subscribeEvents(contractAddr, abi, events, callback): Promise<() => void>
}
```

**Step 2**: EVM 어댑터 구현
```typescript
// dmz/packages/chain-adapters/src/evm/EVMBlockchainAdapter.ts
// TODO: IBlockchainAdapter 구현
// - ethers.js Contract 사용
// - 기존 VASP 연동 코드를 어댑터 인터페이스로 이관

export class EVMBlockchainAdapter implements IBlockchainAdapter {
  constructor(
    private readonly provider: ethers.Provider,
    private readonly signer: ethers.Signer,
    private readonly contractAddress: string,
  ) {}

  async mint(to: string, tokenId: bigint, amount: number): Promise<string> {
    // TODO: KyoboNFT.mint() 호출 → txHash 반환
  }

  async balanceOf(address: string, tokenId: bigint): Promise<bigint> {
    // TODO: KyoboNFT.balanceOf() 호출
  }

  // TODO: 나머지 메서드 구현
}
```

**Step 3**: XRPL·Circle ARC Mock 어댑터 스텁
```typescript
// TODO: XRPLMockAdapter 작성 — 인터페이스 충족, 실제 로직은 stub
export class XRPLMockAdapter implements IBlockchainAdapter {
  async mint(): Promise<string> { return 'xrpl-mock-txhash'; }
  async burn(): Promise<string> { return 'xrpl-mock-txhash'; }
  async balanceOf(): Promise<bigint> { return 1n; }
  async verifyTx(): Promise<TxVerifyResult> { return { confirmed: true }; }
  async subscribeEvents(): Promise<() => void> { return () => {}; }
}
```

**Step 4**: 체인 교체 테스트
```typescript
// TODO: VaspService에서 어댑터를 교체하는 테스트
// EVM 어댑터 → XRPL Mock으로 교체 후
// 비즈니스 로직·원장 코드 변경 없이 동작 확인

it('어댑터 교체 후 상위 로직 무변경', async () => {
  const xrplAdapter = new XRPLMockAdapter();
  const service = new VaspService(xrplAdapter, ledgerService);
  
  // TODO: service.submitMintRequest() 호출 → 성공 확인
  // (EVM이든 XRPL이든 VaspService 코드는 동일)
});
```

### ✅ 답안

```typescript
// IBlockchainAdapter 완성
export interface IBlockchainAdapter {
  mint(to: string, tokenId: bigint, amount: number): Promise<string>;
  burn(from: string, tokenId: bigint, amount: number): Promise<string>;
  balanceOf(address: string, tokenId: bigint): Promise<bigint>;
  verifyTx(txHash: string): Promise<{ confirmed: boolean; blockNumber: number }>;
  subscribeEvents(
    contractAddr: string,
    abi: string[],
    eventNames: string[],
    fromBlock: number,
    callback: (event: ChainEvent) => Promise<void>,
  ): Promise<() => void>;
}

// EVMBlockchainAdapter.mint() 완성
async mint(to: string, tokenId: bigint, amount: number): Promise<string> {
  const contract = new ethers.Contract(
    this.contractAddress,
    KYOBO_NFT_ABI,
    this.signer,
  );
  const tx = await contract.mint(to, tokenId, amount);
  return tx.hash;
}

async balanceOf(address: string, tokenId: bigint): Promise<bigint> {
  const contract = new ethers.Contract(
    this.contractAddress,
    KYOBO_NFT_ABI,
    this.provider,
  );
  return await contract.balanceOf(address, tokenId);
}
```

### ✅ 완료 기준
- [ ] EVM 어댑터 구현 + 인터페이스 통과
- [ ] XRPL Mock 교체 후 상위 레이어 코드 무변경 확인
- [ ] 어댑터 교체만으로 체인 전환 가능함 설명 가능

---

## S16: 분산 시스템에서의 멱등성 보장 원칙 (강의 20분 + 실습 35분)

### 강의

**Idempotency 원리:**
- UUID 기반 요청 식별자 (`requestId`)
- VASP에 같은 식별자 두 번 보내도 NFT 1개만 발행
- DB UNIQUE 제약으로 보장

**requestId가 없으면:**
- 네트워크 재시도 → 중복 발행
- Consumer 재처리 → 중복 발행
- 복구 불가

### 🔴 실습 (35분) — 수강생 직접 작성

**Step 1**: submitMintRequest 구현
```typescript
// internal/packages/vasp/src/VaspService.ts
// TODO: submitMintRequest 구현
// - UUID 기반 requestId 생성
// - mint_requests 테이블에 저장 (REQUESTED 상태)
// - VASP API 호출 → SUBMITTED 전이

async submitMintRequest(
  userId: string,
  tokenId: bigint,
  amount: number,
): Promise<string> {
  // TODO: requestId = uuid()
  // TODO: DB 저장 (status: REQUESTED)
  // TODO: adapter.mint(walletAddress, tokenId, amount)
  // TODO: transitionStatus(REQUESTED → SUBMITTED)
  // TODO: return requestId
}
```

**Step 2**: 중복 requestId 테스트
```typescript
// TODO: 같은 requestId로 2회 호출 → VASP Mock이 두 번째는 무시 → DB 1건만 확인

it('동일 requestId 재전송 → 중복 발행 없음', async () => {
  const requestId = 'test-idempotency-key';
  
  // 첫 번째 호출
  await vaspService.submitMintRequest('user-1', 1001n, 1);
  
  // 두 번째 호출 (같은 requestId를 VASP에 전달했을 때)
  // TODO: VASP Mock에서 중복 요청 감지 → 무시
  // TODO: mint_requests 테이블 1건만 존재 확인
});
```

**Step 3**: VASP Mock 서버 기초 구현
```typescript
// TODO: VaspMockServer — 정상 응답 시나리오
// POST /vasp/mint → requestId 기반 멱등성 처리

const processedRequests = new Set<string>();

app.post('/vasp/mint', (req, res) => {
  const { requestId } = req.body;
  
  // TODO: 이미 처리된 requestId → 200 but 새 발행 없음
  // TODO: 신규 requestId → 발행 처리 후 200
});
```

### ✅ 답안

```typescript
// submitMintRequest 완성
async submitMintRequest(userId: string, tokenId: bigint, amount: number): Promise<string> {
  const requestId = crypto.randomUUID();
  const walletAddress = await this.walletService.getWalletAddress(userId);

  await this.db('mint_requests').insert({
    id: requestId,
    user_id: userId,
    token_id: tokenId.toString(),
    amount,
    status: 'REQUESTED',
    created_at: new Date(),
  });

  const txHash = await this.adapter.mint(walletAddress, tokenId, amount);
  await transitionStatus(requestId, 'REQUESTED', 'SUBMITTED', this.db);

  return requestId;
}

// VaspMockServer 멱등성 처리
const processedRequests = new Map<string, object>();

app.post('/vasp/mint', (req, res) => {
  const { requestId, to, tokenId, amount } = req.body;

  if (processedRequests.has(requestId)) {
    // 중복 요청 → 이전 응답 반환 (무시가 아닌 멱등 응답)
    return res.json({ requestId, status: 'already_processed' });
  }

  processedRequests.set(requestId, { to, tokenId, amount });
  res.json({ requestId, txHash: `0x${Date.now().toString(16)}` });
});
```

### ✅ 완료 기준
- [ ] 동일 requestId 재전송 → 중복 발행 없음
- [ ] SUBMITTED 전이 확인
