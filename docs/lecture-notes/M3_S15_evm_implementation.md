# M3 S15 — EVMAdapter 구현 분석 + XRPL Mock 교체 시뮬레이션

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S15 · 강의 55분  
> 대상: `dmz/packages/chain-adapters/src/evm/EVMAdapter.ts`

---

## S14 → S15 연결

S14에서 `IBlockchainAdapter` 인터페이스를 설계했다. S15에서는 그 인터페이스를 **실제로 구현한 EVMAdapter**를 분석한다. 구현체를 보면서 인터페이스 설계 결정이 왜 그렇게 됐는지 역으로 이해한다.

```
IBlockchainAdapter (interface) — S14
        ↑
EVMAdapter (implements) — S15 ← 오늘 분석
XRPLAdapter (stub)     — S15 ← 교체 시뮬레이션
```

---

## 1. 파일 구조

```
dmz/packages/chain-adapters/src/
├── interfaces/
│   └── IBlockchainAdapter.ts   ← 공통 인터페이스 (S14)
├── evm/
│   └── EVMAdapter.ts           ← 오늘 분석 대상
└── xrpl/
    └── XRPLAdapter.ts          ← stub (향후 구현 대상)
```

---

## 2. ethers.js Provider vs Wallet — 역할 구분

EVMAdapter는 ethers.js의 두 핵심 객체를 사용한다.

```
Provider: 블록체인 "읽기 전용" 연결
  ┌────────────────────────────────────┐
  │  JsonRpcProvider                   │
  │  → 블록 조회, 잔액 조회, 이벤트 구독│
  │  → TX 서명 불가 (키 없음)           │
  └────────────────────────────────────┘
           │
           │ 서명 추가
           ▼
Wallet: Provider + 개인키 결합 → "쓰기" 가능
  ┌────────────────────────────────────┐
  │  Wallet(privateKey, provider)      │
  │  → TX 서명 후 전송 가능            │
  │  → Provider의 모든 기능 포함       │
  └────────────────────────────────────┘
```

**왜 Provider와 Wallet을 분리하는가:**

이벤트 구독 인스턴스(read-only)와 TX 전송 인스턴스(write)를 분리할 수 있다.
이벤트 리스너 서버에는 개인키를 주지 않아도 된다 — 키 노출 범위 최소화.

## 3. 생성자 — 보안 원칙

```typescript
// EVMAdapter.ts:49
constructor(config: {
  rpcUrl:      string;   // 환경변수: EVM_RPC_URL
  chainId:     string;
  privateKey?: string;   // 환경변수: EVM_SIGNER_KEY — 없으면 read-only
}) {
  this.chainId  = config.chainId;
  this.provider = new JsonRpcProvider(config.rpcUrl);
  this.wallet   = config.privateKey
    ? new Wallet(config.privateKey, this.provider)
    : null;
}
```

**3가지 보안 원칙:**

| 원칙 | 이유 |
|---|---|
| DMZ 내부 RPC 노드만 사용 | public RPC(infura.io 등)는 TX 내용 외부 노출 위험 |
| privateKey 환경변수 주입 | 코드 하드코딩 → git 이력에 키 유출 |
| privateKey 없으면 read-only | 이벤트 구독·잔액 조회 전용 인스턴스 분리 가능 |

`this.wallet = null` 상태에서 `sendTransaction` 호출 시:

```typescript
if (!this.wallet) throw new Error('EVMAdapter: read-only mode, no private key');
```

read-only 인스턴스가 실수로 TX를 전송하려 할 때 즉시 명시적 에러 — 조용히 실패하지 않는다.

---

## 4. ABI란 무엇인가

ABI(Application Binary Interface)는 **스마트컨트랙트와 외부 코드가 소통하는 방식을 정의한 명세서**다.

```
비유: 레스토랑 메뉴판

  메뉴판(ABI): "파스타 주문 시 → 이름, 수량 필요"
  주문(TX 호출): mint(address to, uint256 id, uint256 amount)
  주방(컨트랙트): 파라미터를 받아서 처리

  메뉴판 없이 주문하면?
  → "파스타 주세요" → 주방이 파라미터를 어떻게 해석해야 할지 모름
  → ABI 없이 TX 호출 = 컨트랙트가 calldata를 해석 불가
```

**Human-readable ABI (ethers.js 형식):**

```typescript
// 전체 JSON ABI 대신 함수 시그니처 문자열로 표현 가능
'function mint(address to, uint256 id, uint256 amount)'

// ethers.js가 이를 파싱해서 calldata 인코딩/디코딩
```

최소 ABI를 쓰는 이유: 어댑터가 호출하는 함수만 선언 → 나머지는 관심 없음.
컨트랙트 전체 ABI를 가져오면 불필요한 의존성이 생긴다.

## 5. ERC-1155 최소 ABI

```typescript
// EVMAdapter.ts:19
const ERC1155_ABI = [
  'function mint(address to, uint256 id, uint256 amount)',
  'function mintBatch(address[] to, uint256[] ids, uint256[] amounts)',
  'function burn(address from, uint256 id, uint256 amount)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
];
```

**왜 최소 ABI인가:**
- 전체 ABI를 넣으면 불필요한 의존성 — 어댑터가 호출하는 함수만 선언
- ethers.js의 Human-readable ABI 형식 — JSON ABI보다 가독성 좋음
- 컨트랙트 업그레이드 시 영향 범위 최소화

---

## 4. mintNFT / mintNFTBatch / burnNFT

```typescript
// EVMAdapter.ts:82
async mintNFT(params: MintParams): Promise<TransactionReceipt> {
  return this.sendTransaction({
    contractAddr: params.contractAddr,
    abi:          ERC1155_ABI,
    method:       'mint',
    args:         [params.to, params.tokenId, params.amount],
  });
}

async mintNFTBatch(params: MintBatchParams): Promise<TransactionReceipt> {
  // 500건 초과 시 BulkIssuerService가 청크로 분할 후 호출
  return this.sendTransaction({
    contractAddr: params.contractAddr,
    abi:          ERC1155_ABI,
    method:       'mintBatch',
    args:         [params.to, params.tokenIds, params.amounts],
  });
}

async burnNFT(params: BurnParams): Promise<TransactionReceipt> {
  return this.sendTransaction({
    contractAddr: params.contractAddr,
    abi:          ERC1155_ABI,
    method:       'burn',
    args:         [params.from, params.tokenId, params.amount],
  });
}
```

모두 `sendTransaction()`으로 위임한다. 고수준 메서드(mint/burn)는 **파라미터를 ABI 호출 형식으로 변환**하는 역할만 한다. 실제 TX 전송 로직은 `sendTransaction()` 한 곳에만 있다.

**`requestId`가 args에 없는 이유:**
S13에서 설계한 `requestId`는 컨트랙트 calldata에 포함시키는 것이 이상적이지만, 컨트랙트 시그니처가 `mint(address, uint256, uint256)`으로 고정된 경우 args에 추가할 수 없다. 실제 중복 차단은 DB 레벨 requestId unique constraint로 수행한다.

---

## 5. sendTransaction — TX 전송의 핵심

```typescript
// EVMAdapter.ts:140
async sendTransaction(params: ContractCallParams): Promise<TransactionReceipt> {
  if (!this.wallet) throw new Error('EVMAdapter: read-only mode, no private key');

  const iface    = new Interface(params.abi as string[]);
  const contract = new Contract(params.contractAddr, iface, this.wallet);
  const tx       = await contract[params.method](...params.args);
  const receipt  = await tx.wait();   // ← 채굴될 때까지 blocking 대기

  return {
    txHash:      receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash:   receipt.blockHash,
    status:      receipt.status === 1 ? 'success' : 'failed',
    gasUsed:     receipt.gasUsed,
    timestamp:   Date.now(),
  };
}
```

### tx.wait() 문제 — S13 TxStateMachineService와의 관계

#### tx.wait()가 왜 문제인가

```
동기 방식 (tx.wait() 사용):

  Worker ──TX 전송──→ 블록체인
         ←─────────── (대기 중...)
         ←─────────── (대기 중...)   ← 네트워크 혼잡 시 수분
         ←── 완료 ─── 

  Worker는 이 TX 하나가 끝날 때까지 다른 일을 못 함
  → 100건 배치 → 첫 번째가 막히면 나머지 99건 대기
  → Worker 하나가 사실상 멈춤
```

```
비동기 방식 (txHash 저장 + getReceipt 폴링):

  Worker ──TX 전송──→ 블록체인
         ←── txHash ─ (즉시 반환)
         
  Worker: "txHash DB에 저장하고 다음 건 처리"
  
  별도 폴링 루프: getReceipt(txHash) 주기적으로 확인
  → null이면 아직 PENDING → 다음 주기에 다시 확인
  → 결과 오면 → TxStateMachineService에 상태 전이 알림
```

```
tx.wait() → 블록에 포함될 때까지 blocking 대기
           → 네트워크 혼잡 시 몇 분씩 대기 가능
           → 타임아웃 없으면 Worker가 영원히 block
```

**해결 방향:**
```
sendTransaction()  → TX 전송만 하고 txHash 반환 (wait 없이)
         ↓
TxStateMachineService → SUBMITTED 상태 기록
         ↓
getReceipt(txHash) → 주기적으로 polling → null이면 PENDING 유지
         ↓
MINED 감지 시 → CONFIRMED 전이
```

현재 구현은 `tx.wait()`으로 blocking하는 단순 구조다. 실제 운영에서는 TxStateMachineService의 pollStale 루프와 `getReceipt()`를 조합해야 한다.

---

## 6. getReceipt — PENDING 상태 추적

```typescript
// EVMAdapter.ts:158
async getReceipt(txHash: string): Promise<TransactionReceipt | null> {
  const receipt = await this.provider.getTransactionReceipt(txHash);
  if (!receipt) return null;          // ← 아직 블록 미포함 → PENDING
  return {
    txHash:      receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash:   receipt.blockHash,
    status:      receipt.status === 1 ? 'success' : 'failed',
    gasUsed:     receipt.gasUsed,
    timestamp:   Date.now(),
  };
}
```

**null 반환 의미:**

```
TX 전송 완료 (mempool 진입)
        ↓
getReceipt(txHash) = null   ← 블록 미포함 (PENDING)
        ↓ (채굴 후)
getReceipt(txHash) = { status: 'success' | 'failed' }
```

S13의 `TxStateMachineService`가 이 null을 PENDING으로 해석하고 TIMEOUT 타이머를 관리한다 (S14 설계 연계).

### sendTransaction vs getReceipt 비교

| | `sendTransaction` | `getReceipt` |
|---|---|---|
| **언제** | TX를 처음 전송할 때 | 이미 전송된 TX 상태를 확인할 때 |
| **blocking** | tx.wait()로 대기 | 즉시 반환 (null or receipt) |
| **S13 연계** | SUBMITTED 상태 진입 | PENDING → CONFIRMED/FAILED 전이 판단 |

---

## 7. 이벤트 구독 패턴 — 어떻게 온체인 이벤트를 실시간으로 받는가

블록체인은 이벤트를 "push"하지 않는다. 우리가 WebSocket으로 연결해서 "pull"하거나 폴링한다.

```
ethers.js WebSocket 구독 흐름:

  EVMAdapter ──WebSocket 연결──→ RPC 노드
                                    │
                            블록체인 새 블록 생성
                            컨트랙트 이벤트 발생
                                    │
              ←── 이벤트 push ──── RPC 노드가 알림
                                    
  EVMAdapter: listener 함수 호출 → handler(ChainEvent)
```

구독을 취소하지 않으면 어떻게 되는가:

```
서비스 종료 시 unsubscribe 안 하면:
  → WebSocket 연결이 살아있음
  → 이미 종료된 handler가 이벤트를 받으려 함
  → 메모리 누수 / 에러 로그 폭발
  → GracefulShutdown 시간 초과
```

## 7. subscribeEvents — 실시간 구독 + unsubscribe 반환

```typescript
// EVMAdapter.ts:173
async subscribeEvents(
  contractAddr: string,
  abi: unknown[],
  eventNames: string[],
  _fromBlock: number,
  handler: (event: ChainEvent) => Promise<void>,
): Promise<() => void> {
  const iface    = new Interface(abi as string[]);
  const contract = new Contract(contractAddr, iface, this.provider);
  const listeners: Array<() => void> = [];

  for (const eventName of eventNames) {
    const listener = async (...args: unknown[]) => {
      const log = args[args.length - 1] as EventLog;
      await handler(this._toChainEvent(eventName, contractAddr, log, args));
    };
    contract.on(eventName, listener);
    listeners.push(() => contract.off(eventName, listener));   // ← unsubscribe 클로저
  }

  return () => listeners.forEach(off => off());   // ← 모든 구독 일괄 해제
}
```

**여러 이벤트를 한 번에 구독하는 패턴:**

```
eventNames = ['NFTIssued', 'NFTBurned', 'TransferSingle']
        ↓
각 이벤트마다 listener 등록
listeners = [unsubNFTIssued, unsubNFTBurned, unsubTransferSingle]
        ↓
반환: () => listeners.forEach(off => off())
        ↓
호출 한 번으로 모든 구독 해제
```

**GracefulShutdown 연결:**

```typescript
const unsubscribe = await adapter.subscribeEvents(
  contractAddr, abi, ['NFTIssued', 'NFTBurned'], latestBlock, handler,
);

process.on('SIGTERM', async () => {
  unsubscribe();        // ← 구독 해제
  await server.close(); // ← 서버 종료
});
```

`_fromBlock` 파라미터가 `_`로 시작하는 이유: ethers.js WebSocket 방식에서는 `fromBlock`을 직접 지정할 수 없다 (WebSocket 연결 시점부터 수신). missed event 복구는 `queryEvents()`가 담당한다.

---

## 8. queryEvents — Finalized 범위 missed event 복구

```typescript
// EVMAdapter.ts:197
async queryEvents(
  contractAddr: string,
  abi: unknown[],
  eventName: string,
  fromBlock: number,
  toBlock: number,
): Promise<ChainEvent[]> {
  const iface    = new Interface(abi as string[]);
  const contract = new Contract(contractAddr, iface, this.provider);
  const logs     = await contract.queryFilter(
    contract.getEvent(eventName),
    fromBlock,
    toBlock,
  );
  return (logs as EventLog[]).map(log =>
    this._toChainEvent(eventName, contractAddr, log, []),
  );
}
```

**`contract.queryFilter()` 동작:**
- 지정된 블록 범위에서 이벤트 로그를 배치 조회
- ethers.js가 내부적으로 `eth_getLogs` RPC 호출
- 반환값: `EventLog[]` — 각각 `_toChainEvent()`로 변환

**Finalized 범위만 queryEvents하는 이유 (S12 연계):**

```
MINED 블록 기준 queryEvents
  → REORG 발생 시 이미 처리한 이벤트가 사라짐
  → 원장 불일치

Finalized 블록 기준 queryEvents
  → 절대 불변 → 안전하게 배치 처리 가능
  → 호출 예시: queryEvents(lastProcessedBlock, finalizedBlock)
```

---

## 9. _toChainEvent — 체인 원본 → ChainEvent 변환

```typescript
// EVMAdapter.ts:216
private _toChainEvent(
  eventName: string,
  contractAddr: string,
  log: EventLog,
  args: unknown[],
): ChainEvent {
  const named: Record<string, unknown> = {};
  if (log.fragment) {
    log.fragment.inputs.forEach((input, i) => {
      named[input.name] = log.args?.[i];   // ← ABI 파라미터명으로 named args 구성
    });
  }
  return {
    eventName,
    contractAddr,
    txHash:      log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex:    log.index,
    args:        Object.keys(named).length ? named : { raw: args },
    raw:         log,   // ← 원본 EventLog 보존
  };
}
```

**`log.fragment.inputs`가 하는 일:**

```
EVM Event: NFTIssued(address indexed to, uint256 indexed tokenId, uint256 amount)
        ↓ fragment.inputs
inputs[0].name = 'to'
inputs[1].name = 'tokenId'
inputs[2].name = 'amount'
        ↓
named = { to: '0xAlice...', tokenId: 1001n, amount: 1n }
        ↓
ChainEvent.args = { to: '0xAlice...', tokenId: 1001n, amount: 1n }
```

**raw 필드 사용 원칙 (S14 복습):**

```
✅ _toChainEvent() 내부에서 raw(EventLog) → args 변환
❌ 어댑터 외부(IssuerService 등)에서 ChainEvent.raw 직접 파싱
   → raw를 직접 쓰면 EVM 전용 코드가 비즈니스 로직에 침투
   → XRPL 교체 시 ChainEvent.raw 구조가 완전히 달라짐
```

---

## 10. XRPLAdapter Stub + 교체 시뮬레이션

### Stub 구조

```typescript
// XRPLAdapter.ts:18
export class XRPLAdapter implements IBlockchainAdapter {
  readonly chainId   = 'xrpl-mainnet';
  readonly chainType = 'XRPL' as const;

  constructor(_config: { wsUrl: string; seed?: string }) {}

  async isConnected() { return false; }
  async getBlockNumber() { return 0; }
  async mintNFT(_p: MintParams): Promise<TransactionReceipt> {
    throw new Error('XRPLAdapter: not implemented');
  }
  // ... 나머지 메서드 동일
}
```

Stub이지만 `implements IBlockchainAdapter` — 인터페이스 충족 여부가 **컴파일 타임에 검증**된다.
메서드를 하나라도 빠뜨리면 TypeScript 컴파일 에러 → 구현 누락을 런타임 전에 잡는다.

### 교체 시뮬레이션 — IssuerService 코드 무변경 확인

```typescript
// 실습: 두 어댑터를 동일 함수로 실행
async function runIssuerTest(adapter: IBlockchainAdapter) {
  const receipt = await adapter.mintNFT({
    contractAddr: '0xKyoboNFT...',
    to:           '0xAlice...',
    tokenId:      1001n,
    amount:       1n,
    requestId:    crypto.randomUUID(),
  });
  console.log(`[${adapter.chainType}] TX: ${receipt.txHash}`);
}

// 어댑터만 교체 — runIssuerTest 코드 한 줄도 변경 없음
await runIssuerTest(new EVMAdapter({ rpcUrl: '...', chainId: '1', privateKey: '...' }));
await runIssuerTest(new XRPLMockAdapter());
```

**확인 포인트:**
- `IssuerService`는 `IBlockchainAdapter` 타입만 알고, 구현체를 모른다
- `adapter.chainType` 출력이 다를 뿐 — 함수 로직은 동일
- 실제 DI에서는 환경변수로 어댑터를 선택한다

### XRPLMockAdapter 작성 실습

```typescript
export class XRPLMockAdapter implements IBlockchainAdapter {
  readonly chainId   = 'xrpl-testnet';
  readonly chainType = 'XRPL' as const;

  async isConnected() { return true; }
  async getBlockNumber() { return 12345678; }

  async mintNFT(_params: MintParams): Promise<TransactionReceipt> {
    return {
      txHash:      `XRPL_MOCK_${Date.now()}`,
      blockNumber: 12345679,
      blockHash:   `XRPLHASH_${Date.now()}`,
      status:      'success',
      // gasUsed 없음 — XRPL은 가스 개념 없음 (S14 TransactionReceipt.gasUsed? 연계)
      timestamp:   Date.now(),
    };
  }

  async mintNFTBatch(_params: MintBatchParams): Promise<TransactionReceipt> {
    throw new Error('XRPLMockAdapter: mintNFTBatch not implemented');
  }

  async burnNFT(_params: BurnParams): Promise<TransactionReceipt> {
    throw new Error('XRPLMockAdapter: burnNFT not implemented');
  }

  async getBalance(_contractAddr: string, _owner: string, _tokenId: bigint): Promise<bigint> {
    return 1n;
  }

  async call(_params: ContractCallParams): Promise<unknown> { return null; }
  async sendTransaction(_params: ContractCallParams): Promise<TransactionReceipt> {
    throw new Error('XRPLMockAdapter: sendTransaction not supported');
  }
  async getReceipt(_txHash: string): Promise<TransactionReceipt | null> { return null; }

  async subscribeEvents(
    _contractAddr: string, _abi: unknown[], _eventNames: string[],
    _fromBlock: number, _handler: (e: ChainEvent) => Promise<void>,
  ): Promise<() => void> {
    return () => {};  // no-op unsubscribe
  }

  async queryEvents(
    _contractAddr: string, _abi: unknown[], _eventName: string,
    _fromBlock: number, _toBlock: number,
  ): Promise<ChainEvent[]> {
    return [];
  }
}
```

**XRPL gasUsed가 undefined인 이유 재확인:**
```
TransactionReceipt.gasUsed?: bigint   ← optional
→ XRPLMockAdapter.mintNFT 반환값에 gasUsed 없음 → TypeScript 컴파일 통과
→ 상위 레이어에서 gasUsed에 의존하면 undefined 오류 → 의존 금지
```

---

## S15 핵심 요약

| 개념 | 핵심 |
|---|---|
| read-only 모드 | privateKey 없으면 wallet=null → sendTransaction throw |
| tx.wait() 문제 | blocking 대기 → TxStateMachineService pollStale + getReceipt 조합으로 분리 |
| getReceipt null | 블록 미포함 → PENDING → TxStateMachineService TIMEOUT 처리로 연결 |
| subscribeEvents | listeners 배열 + 클로저 → 단일 unsubscribe 함수로 전체 해제 |
| _fromBlock 무시 | WebSocket은 연결 시점부터 수신 → missed event는 queryEvents 담당 |
| _toChainEvent | fragment.inputs → named args 구성 → raw는 원본 보존용 |
| XRPLAdapter stub | implements 강제 → 메서드 누락 컴파일 에러 → 구현 누락 조기 발견 |
| gasUsed optional | XRPL mock에서 생략 → 상위 레이어 gasUsed 의존 금지 재확인 |

**S16 예고:** EVMAdapter를 통해 TX를 전송하면 네트워크/컨트랙트 에러가 발생할 수 있다. S16에서는 VASP 재전송 방어 — Idempotency Guard 설계를 다룬다. requestId 기반으로 중복 TX 전송을 어떻게 차단하는지, DB와 체인 양쪽에서 idempotency를 어떻게 보장하는지 분석한다.

---

**완료 기준:**
- [ ] `sendTransaction`의 `tx.wait()` 문제점과 `getReceipt()`와의 역할 분리 설명
- [ ] `getReceipt()` null 반환 → TxStateMachineService PENDING 해석 연결
- [ ] `subscribeEvents`가 `listeners` 배열 + 클로저로 unsubscribe를 구현하는 이유
- [ ] `_fromBlock`이 무시되는 이유 — missed event 복구 책임이 `queryEvents`에 있는 이유
- [ ] `_toChainEvent()`에서 `fragment.inputs` → named args 변환 설명
- [ ] `XRPLMockAdapter` 직접 작성 → `IBlockchainAdapter` 컴파일 통과 확인
- [ ] `gasUsed?` optional이 mock에서 어떻게 나타나는지 설명
