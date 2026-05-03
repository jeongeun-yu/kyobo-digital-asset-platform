# M3 S14 — 멀티체인 추상화 레이어 IBlockchainAdapter 설계

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S14 · 강의 55분  
> 대상: `dmz/packages/chain-adapters/src/interfaces/IBlockchainAdapter.ts`

---

## S13 → S14 연결

S13에서 `TxStateMachineService`가 `VaspTxClient` 인터페이스에만 의존하는 것을 배웠다. S14에서는 한 레이어 아래로 내려간다. 실제 블록체인과 연결되는 `IBlockchainAdapter` — 체인을 교체해도 위쪽 코드가 변하지 않게 만드는 추상화 레이어다.

```
TxStateMachineService
        │ depends on
        ▼
VaspTxClient (interface)  ← S13
        │ depends on
        ▼
IBlockchainAdapter (interface)  ← S14 ← EVMAdapter / XRPLAdapter
```

---

## 1. EVM 고착화 리스크

#### 고착화(Vendor Lock-in)란 무엇인가

특정 기술·벤더의 개념이 비즈니스 코드 깊숙이 침투해, 나중에 그 기술을 바꾸려면 비즈니스 코드까지 전부 뜯어고쳐야 하는 상황.

```
비유: 전용 충전 케이블

  A사 노트북 전용 케이블을 쓰면
  → 노트북 브랜드 바꿀 때 케이블도 전부 교체
  → 책상, 가방, 차량용 거치대까지 다 교체

  USB-C 표준을 쓰면
  → 어떤 노트북이든 같은 케이블 사용
  → 브랜드 교체해도 케이블 그대로
```

소프트웨어도 같다. 비즈니스 코드에 `ethers.js`, `gasUsed`, `topics` 같은 EVM 전용 개념이 직접 들어가면 — 체인을 바꿀 때 비즈니스 코드까지 수정해야 한다.

추상화 없이 EVMAdapter를 직접 호출하면:

```typescript
// ❌ EVM 고착 코드
const tx      = await ethers.provider.sendTransaction({ ... });
const receipt = await tx.wait();                 // ← ethers.js 전용
const gasUsed = receipt.gasUsed;                 // ← EVM 개념
const log     = receipt.logs[0];                 // ← EVM Log
const topic   = log.topics[0];                   // ← EVM event topic
const decoded = iface.parseLog(log);             // ← ABI 디코딩 (EVM 전용)
```

이 코드를 XRPL로 교체하면:

```
xrpl.js 사용법 전혀 다름
Offer 기반 전송 → EVM sendTransaction과 개념 다름
Log / Topic 없음 → Transaction Metadata로 파싱 필요
ABI 없음 → 별도 파싱 로직 필요
→ IssuerService + LedgerService + AuditLog 전부 수정
```

**결론: 체인 전용 개념이 비즈니스 로직에 스며들면 교체 비용이 폭발한다.**

---

## 2. IBlockchainAdapter 설계 원칙 — Strategy Pattern

#### Strategy Pattern이란

같은 목적을 수행하는 **여러 구현체를 인터페이스 뒤에 감추고, 런타임에 교체 가능하게 만드는 패턴**.

```
비유: 결제 수단

  쇼핑몰 결제 시스템은 "결제"라는 행위만 안다.
  카드로 결제하든, 카카오페이로 결제하든, 무통장으로 결제하든
  → 결제 시스템 코드 변경 없음
  → 결제 수단(구현체)만 바뀜

  ┌──────────────┐
  │  쇼핑몰 코드  │ → pay(amount)  ← 인터페이스만 호출
  └──────────────┘
         │
   ┌─────┼─────┐
   ▼     ▼     ▼
 카드  카카오  무통장   ← 구현체 (런타임에 선택)
```

블록체인 어댑터도 동일하다:

```
┌─────────────────────────────────────────────────────┐
│                  비즈니스 레이어                      │
│  IssuerService / LedgerService / AuditLog           │
│                                                     │
│  알고 있는 것: IBlockchainAdapter 인터페이스          │
│  모르는 것:    EVM인지 XRPL인지 Circle인지            │
└──────────────────────┬──────────────────────────────┘
                       │ implements
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    EVMAdapter    XRPLAdapter  CircleAdapter
    (ethers.js)   (xrpl.js)   (Circle SDK)
         │            │            │
    Ethereum       XRPL        USDC/CCTP
    Polygon        Ledger
```

**어댑터 교체 = DI 설정 한 줄 변경**:

```typescript
// 환경변수로 어댑터 선택
const adapter: IBlockchainAdapter =
  process.env.CHAIN === 'XRPL'
    ? new XRPLAdapter({ wsUrl: '...', seed: '...' })
    : new EVMAdapter({ rpcUrl: '...', chainId: '1', privateKey: '...' });

// IssuerService는 어떤 어댑터가 들어오는지 모름 — 신경 안 씀
const issuer = new IssuerService(adapter);
```

IssuerService는 인터페이스만 안다. 어떤 어댑터가 주입되는지 관심 없다. 어댑터 교체는 DI(의존성 주입) 한 줄이면 끝난다.

```
IssuerService ──depends on──→ IBlockchainAdapter (interface)
                                       ↑
                               EVMAdapter (implements)
                               XRPLAdapter (implements)
                               CircleAdapter (implements)
```

---

## 3. 파라미터 인터페이스 — 왜 별도로 분리하는가

체인마다 발행에 필요한 파라미터 구성이 다를 수 있다. 하나의 인터페이스로 묶어두면 어댑터가 필요한 필드만 쓰고 나머지는 무시하면 된다.

```typescript
// IBlockchainAdapter.ts:50
export interface MintParams {
  contractAddr: string;
  to:           string;
  tokenId:      bigint;
  amount:       bigint;
  requestId:    string;  // Idempotency key — UUID (S13 연계)
}

export interface MintBatchParams {
  contractAddr: string;
  to:           string[];
  tokenIds:     bigint[];
  amounts:      bigint[];
  requestId:    string;
}

export interface BurnParams {
  contractAddr: string;
  from:         string;
  tokenId:      bigint;
  amount:       bigint;
}

export interface ContractCallParams {
  contractAddr: string;
  abi:          unknown[];
  method:       string;
  args:         unknown[];
  signerKey?:   string;  // 없으면 read-only call
}
```

**`requestId`가 MintParams에 있는 이유:**

S13에서 `TxStateMachineService`가 UUID requestId를 생성해 VASP에 전달했다. 그 requestId가 여기까지 내려온다. EVMAdapter가 컨트랙트 호출 시 이 requestId를 calldata에 포함하면 REVERT 이후에도 동일 requestId로 재시도해도 컨트랙트 레벨에서 중복 차단이 가능하다.

---

## 4. IBlockchainAdapter 전체 인터페이스

```typescript
// IBlockchainAdapter.ts:73
export interface IBlockchainAdapter {
  readonly chainId:   string;
  readonly chainType: 'EVM' | 'XRPL' | 'UTXO' | 'BFT';

  // ── 연결 ─────────────────────────────────────────────────────────
  isConnected():    Promise<boolean>;
  getBlockNumber(): Promise<number>;

  // ── NFT 발행·소각·잔액 ──────────────────────────────────────────
  mintNFT(params: MintParams):           Promise<TransactionReceipt>;
  mintNFTBatch(params: MintBatchParams): Promise<TransactionReceipt>;
  burnNFT(params: BurnParams):           Promise<TransactionReceipt>;
  getBalance(contractAddr: string, owner: string, tokenId: bigint): Promise<bigint>;

  // ── 저수준 TX ────────────────────────────────────────────────────
  call(params: ContractCallParams):            Promise<unknown>;
  sendTransaction(params: ContractCallParams): Promise<TransactionReceipt>;
  getReceipt(txHash: string):                  Promise<TransactionReceipt | null>;

  // ── 이벤트 ───────────────────────────────────────────────────────
  subscribeEvents(
    contractAddr: string, abi: unknown[], eventNames: string[],
    fromBlock: number, handler: (event: ChainEvent) => Promise<void>,
  ): Promise<() => void>;                // ← unsubscribe 함수 반환

  queryEvents(
    contractAddr: string, abi: unknown[], eventName: string,
    fromBlock: number, toBlock: number,
  ): Promise<ChainEvent[]>;
}
```

**`subscribeEvents`의 `Promise<() => void>` 반환:**

```typescript
// 사용 예시
const unsubscribe = await adapter.subscribeEvents(
  contractAddr, abi, ['NFTIssued'], latestBlock, handler,
);

// 서비스 종료 시
process.on('SIGTERM', () => unsubscribe());
```

구독 취소 함수를 직접 반환하는 패턴 — EventEmitter 방식보다 간결하고 GracefulShutdown에 바로 연결된다.

**`getReceipt`가 null을 반환할 수 있는 이유:**

```
TX를 전송했지만 아직 블록에 포함되지 않은 상태 (PENDING)
→ getReceipt = null
→ TxStateMachineService는 이 null을 PENDING으로 해석
→ TIMEOUT 처리로 연결
```

---

## 5. 공통 데이터 추상화

### TransactionReceipt

```typescript
// IBlockchainAdapter.ts:23
export interface TransactionReceipt {
  txHash:      string;
  blockNumber: number;
  blockHash:   string;
  status:      'success' | 'failed' | 'pending';
  gasUsed?:    bigint;   // EVM만 유효, XRPL은 undefined
  timestamp:   number;
}
```

`gasUsed`가 optional인 이유: XRPL은 가스 개념이 없다. 어댑터가 체인 특성에 맞게 채울 수 있는 필드만 채운다. 상위 레이어는 `gasUsed`에 의존하지 않아야 한다.

### ChainEvent

```typescript
// IBlockchainAdapter.ts:32
export interface ChainEvent {
  eventName:    string;
  contractAddr: string;
  txHash:       string;
  blockNumber:  number;
  logIndex:     number;
  args:         Record<string, unknown>;  // 체인 무관 공통 필드
  raw:          unknown;                  // 체인별 원본 데이터 보존
}
```

**`raw` 필드 사용 원칙:**

```
✅ 어댑터 내부에서 raw를 파싱해 args로 변환
❌ 어댑터 외부(IssuerService 등)에서 raw를 직접 파싱
   → raw를 직접 쓰면 추상화가 무너짐
   → raw는 디버깅·감사 기록 전용
```

#### 왜 raw를 외부에서 파싱하면 안 되는가 — 추상화 붕괴 시나리오

```
❌ IssuerService가 raw를 직접 파싱하는 경우:

  ChainEvent.raw → (EVM EventLog 구조)
                      ↓ IssuerService에서 직접 파싱
  const topic = (event.raw as EthersEventLog).topics[0]
  const from  = ethers.AbiCoder.decode(['address'], topic)

  → IssuerService에 ethers.js 의존성 침투
  → XRPL로 교체 시 topics 없음 → IssuerService 수정 필요
  → 추상화 레이어가 의미 없어짐


✅ 어댑터 내부에서 파싱해 args로 변환하는 경우:

  체인 이벤트 원본
       │
       ▼ EVMAdapter._toChainEvent() 내부 파싱
  ChainEvent.args = { from: '0x...', tokenId: 1001n, amount: 1n }
  ChainEvent.raw  = <EthersEventLog 원본 보존>
       │
       ▼ IssuerService는 args만 사용
  const { from, tokenId, amount } = event.args

  → IssuerService에 체인 전용 코드 없음
  → XRPL로 교체해도 args 구조는 동일 → IssuerService 변경 없음 ✅
```

---

## 6. EVM vs XRPL vs Circle ARC 패러다임 비교

| 개념 | EVM (Ethereum) | XRPL | Circle ARC |
|---|---|---|---|
| 스마트컨트랙트 | Solidity (Turing-complete) | 없음 (Hooks 실험적) | 프로그래머블 월렛 |
| NFT 표준 | ERC-1155 (tokenId + amount) | XLS-20 (Offer 기반 전송) | ERC-1155 래핑 |
| 가스 체계 | Gas × GasPrice = ETH | Reserve(XRP 잠금) + fixed Fee | 가스 추상화 (Circle 처리) |
| TX 서명 | EOA privateKey + nonce | 계정 Sequence 번호 | MPC (서버 측 키 관리) |
| 이벤트 | ABI-encoded Log (topics) | Transaction Metadata | WebHook / SDK 이벤트 |
| Finality | PoS Checkpoint (~12분) | 약 3~5초 (BFT 합의) | 체인 의존 |

**EVM과 XRPL이 1:1 매핑 안 되는 핵심 지점:**

```
EVM:  transfer(from, to, amount) → event Transfer(from, to, amount)
       단일 TX로 완결

XRPL: NFTokenCreateOffer + NFTokenAcceptOffer — 두 단계
       단순 "transfer" 개념 없음
       → XRPLAdapter가 내부적으로 두 단계를 묶어서 하나의 mintNFT()로 표현
       → IssuerService는 이 차이를 모름
```

이 차이가 추상화 레이어가 필요한 근본 이유다.

---

## 7. subscribeEvents vs queryEvents — 두 채널의 역할

#### 왜 두 채널이 필요한가

실시간 구독(subscribeEvents)만 있으면:

```
서비스 실행 중: 이벤트 정상 수신
서비스 재시작:  재시작하는 동안 발생한 이벤트 유실
              → 온체인에는 NFT 발행 기록 있는데 DB엔 없음 🚨
```

배치 조회(queryEvents)만 있으면:

```
5분마다 블록 조회 → 실시간성 없음
              → 사용자가 발행 확인까지 최대 5분 대기
```

두 채널 조합:

```
┌──────────────────────────────────────────────────────────┐
│               이벤트 수신 이중 채널                        │
│                                                          │
│  채널 A: subscribeEvents (실시간, Push)                   │
│  ┌──────────────┐                                        │
│  │ 서비스 실행  │── WebSocket ──→ 이벤트 즉시 수신        │
│  └──────────────┘   (연결 중)                            │
│                                                          │
│  채널 B: queryEvents (복구, Pull)                         │
│  ┌──────────────┐                                        │
│  │ 서비스 시작  │── eth_getLogs ──→ 마지막 처리 블록부터  │
│  │ (재시작 직후)│    (Finalized)    현재까지 누락 이벤트  │
│  └──────────────┘                  배치 재처리            │
└──────────────────────────────────────────────────────────┘

두 채널 모두 동일 파이프라인으로 주입:
  이벤트 → ChainEventListener → RedisStreamPublisher → ConsumerGroupWorker
```

```
정상 운영 (서비스 실행 중):
  subscribeEvents() → WebSocket/Polling으로 실시간 이벤트 수신
        │
        ▼
  ChainEventListener → RedisStreamPublisher → ConsumerGroupWorker

재시작 후 missed event 복구:
  queryEvents(fromBlock=마지막처리블록, toBlock=현재Finalized블록)
        │
        ▼
  누락된 이벤트를 배치로 재처리 → 동일 파이프라인으로 주입
```

**왜 Finalized 블록 범위만 queryEvents 하는가:**

```
MINED 블록 기준으로 queryEvents 하면 → REORG 발생 시 이미 처리한 이벤트가 사라짐
                                        → 원장 불일치 (S12 Finalized 개념 연계)
Finalized 블록 기준으로만 조회 → 절대 불변 → 안전하게 배치 처리 가능
```

---

## 8. IVASPAdapter와의 관계

```typescript
// IVASPAdapter.ts:43
export interface IVASPAdapter {
  createWallet(userId: string): Promise<WalletInfo>;
  getWallet(userId: string):    Promise<WalletInfo | null>;
  transfer(req: TransferRequest): Promise<TransferResult>;
  getTransferStatus(txHash: string): Promise<TransferResult>;
  screenAddress(address: string): Promise<{ flagged: boolean; reason?: string }>;
}
```

**IVASPAdapter vs IBlockchainAdapter 역할 구분:**

| | IVASPAdapter | IBlockchainAdapter |
|---|---|---|
| **레벨** | 비즈니스 추상화 | 기술 추상화 |
| **관심사** | 지갑 생성, 전송, AML 스크리닝 | 블록체인 프로토콜 연결 |
| **규제** | 특금법상 VASP 인가 필요 | 기술 레이어 (인가 무관) |
| **Phase 1** | 외부 VASP(월렛원·코다) 위임 | EVMAdapter 직접 구현 |
| **향후** | 교보 자체 VASP 인가 시 직접 구현 | XRPLAdapter 추가 |

> **📌 M5에서 이어서:** `IVASPAdapter`의 실제 구현체(`ExternalVASPAdapter`, `WalletProvisioningService`)와 외부 VASP API 연동 패턴은 **M5 S27~S28**에서 상세히 다룬다. 여기서는 "IBlockchainAdapter와 다른 레이어"라는 역할 구분에 집중한다.

---

## 9. 멀티체인 전환 전략 — 당사 적용 로드맵

```
Phase 1 (현재): EVMAdapter
  ERC-1155 NFT 발행 / Ethereum mainnet / Polygon

Phase 2 (국내 규제 대응): XRPLAdapter 병행
  국내 규제 환경에서 XRPL 활용 시
  → IssuerService 코드 무변경, 어댑터만 교체

Phase 3 (글로벌 확장): CircleAdapter
  글로벌 스테이블코인 정산 / CCTP
```

**핵심 원칙:**

> 비즈니스 로직·원장·감사 로그는 체인 무관하게 유지.  
> VASP가 어댑터 구현체를 DI로 선택·주입한다.

---

## S14 핵심 요약

| 개념 | 핵심 |
|---|---|
| EVM 고착화 리스크 | 체인 전용 개념(gasUsed, Log, topics)이 비즈니스 로직에 스며들면 교체 비용 폭발 |
| Strategy Pattern | IssuerService → 인터페이스만 의존, 구현체는 DI |
| TransactionReceipt | `gasUsed?` optional — XRPL 등 가스 없는 체인 대응 |
| ChainEvent.raw | 원본 보존용, 어댑터 외부에서 파싱 금지 |
| subscribeEvents | `Promise<() => void>` 반환 — unsubscribe 함수 직접 반환 |
| queryEvents | Finalized 범위만 — REORG 안전한 missed event 복구 |
| XRPL 1:1 매핑 불가 | NFTokenCreateOffer + NFTokenAcceptOffer → 어댑터가 내부에서 묶음 |

**S15 예고:** 인터페이스를 배웠으니 이제 실제 EVMAdapter 구현을 분석한다. ethers.js v6 기반으로 sendTransaction이 TransactionReceipt로 어떻게 변환되는지, subscribeEvents가 어떻게 unsubscribe 함수를 반환하는지, 그리고 XRPLAdapter stub과 직접 교체 시뮬레이션을 실습한다.

---

**완료 기준:**
- [ ] EVM·XRPL·Circle ARC 패러다임 핵심 차이 3가지 이상 설명 가능
- [ ] IBlockchainAdapter 설계 원칙 — Strategy Pattern 적용 이유 설명
- [ ] `subscribeEvents`가 `Promise<() => void>`를 반환하는 이유 설명
- [ ] `queryEvents`에서 Finalized 범위만 사용하는 이유 설명 (S12 연계)
- [ ] `raw` 필드를 어댑터 외부에서 파싱하면 안 되는 이유 설명
- [ ] 당사 멀티체인 전환 Phase 1→2→3 순서와 근거 제시
