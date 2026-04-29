# M3 S15 — IBlockchainAdapter EVM 구현과 멀티체인 전환 시뮬레이션

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S15 · 1시간  
> 대상: `dmz/packages/chain-adapters/src/evm/EVMAdapter.ts`

---

## S15 — IBlockchainAdapter EVM 구현과 멀티체인 전환 시뮬레이션

### 1. EVMAdapter 구조 개요

```
dmz/packages/chain-adapters/src/
├── interfaces/
│   └── IBlockchainAdapter.ts   ← 공통 인터페이스
├── evm/
│   └── EVMAdapter.ts           ← EVM 구현체 (ethers.js v6)
└── xrpl/
    └── XRPLAdapter.ts          ← XRPL stub (향후 구현)
```

### 2. EVMAdapter 생성자 — 보안 원칙

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

**보안 원칙:**
- `rpcUrl`에 **public RPC (infura.io 등) 절대 금지** — DMZ 내부 노드만
- `privateKey` 코드 하드코딩 금지 — 환경변수 주입
- `privateKey` 없으면 read-only → 이벤트 구독·잔액 조회만 가능

### 3. mintNFT — ERC-1155 발행

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
```

ERC-1155 최소 ABI (EVMAdapter.ts:19):

```typescript
const ERC1155_ABI = [
  'function mint(address to, uint256 id, uint256 amount)',
  'function mintBatch(address[] to, uint256[] ids, uint256[] amounts)',
  'function burn(address from, uint256 id, uint256 amount)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
];
```

### 4. sendTransaction — 저수준 TX 전송

```typescript
// EVMAdapter.ts:140
async sendTransaction(params: ContractCallParams): Promise<TransactionReceipt> {
  if (!this.wallet) throw new Error('EVMAdapter: read-only mode, no private key');

  const iface    = new Interface(params.abi as string[]);
  const contract = new Contract(params.contractAddr, iface, this.wallet);
  const tx       = await contract[params.method](...params.args);
  const receipt  = await tx.wait();    // ← 채굴될 때까지 대기

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

`tx.wait()` 주의: 채굴될 때까지 blocking으로 대기한다. PENDING 상태에서 TX를 추적하는 TxStateMachineService와 연계할 때 이 지점을 분리해야 한다.

### 5. subscribeEvents — 실시간 이벤트 구독

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
    listeners.push(() => contract.off(eventName, listener));
  }

  return () => listeners.forEach(off => off());  // unsubscribe 함수 반환
}
```

반환값이 `() => void` (unsubscribe 함수)인 이유: 서버 종료 시 리스너를 정리해야 한다. unsubscribe 안 하면 메모리 누수 + 이미 종료된 핸들러로 이벤트 전달 시도.

### 6. XRPLAdapter — Stub 구조

```typescript
// XRPLAdapter.ts:18
export class XRPLAdapter implements IChainAdapter {
  readonly chainId  = 'xrpl-mainnet';
  readonly chainType = 'XRPL' as const;

  constructor(_config: { wsUrl: string; seed?: string }) {}

  // 모든 메서드: throw new Error('XRPLAdapter: not implemented')
}
```

Stub이지만 `IChainAdapter`를 `implements`한다 — 인터페이스 충족 여부가 컴파일 타임에 검증된다.

### 7. 실습 — EVMAdapter 구현 + XRPL Mock 교체 테스트

#### Step 1: mintNFT + getBalance 구현 확인

```typescript
// 실습: EVMAdapter.mintNFT 호출 흐름 추적
const adapter = new EVMAdapter({
  rpcUrl:     process.env.EVM_RPC_URL!,
  chainId:    '1',
  privateKey: process.env.EVM_SIGNER_KEY,
});

const receipt = await adapter.mintNFT({
  contractAddr: '0xKyoboNFT...',
  to:           '0xAlice...',
  tokenId:      1001n,
  amount:       1n,
  requestId:    crypto.randomUUID(),
});
console.log(receipt.txHash, receipt.status);
```

#### Step 2: XRPL Mock 어댑터 작성 (인터페이스 충족)

```typescript
// 실습: XRPLMockAdapter — IBlockchainAdapter 구현 (테스트용)
export class XRPLMockAdapter implements IBlockchainAdapter {
  readonly chainId   = 'xrpl-testnet';
  readonly chainType = 'XRPL' as const;

  async isConnected() { return true; }
  async getBlockNumber() { return 12345678; }

  async mintNFT(params: MintParams): Promise<TransactionReceipt> {
    return {
      txHash:      `MOCK_${Date.now()}`,
      blockNumber: 12345679,
      blockHash:   `MOCKHASH_${Date.now()}`,
      status:      'success',
      timestamp:   Date.now(),
    };
  }

  // TODO: 나머지 메서드 구현 (burn, getBalance, subscribeEvents 등)
}
```

#### Step 3: 어댑터 교체 테스트

```typescript
// 어댑터 교체 — IssuerService 코드 변경 없음 확인
async function runIssuerTest(adapter: IBlockchainAdapter) {
  // IssuerService가 adapter만 주입받아 동작
  const receipt = await adapter.mintNFT({
    contractAddr: '0xNFT...',
    to:           '0xAlice...',
    tokenId:      1001n,
    amount:       1n,
    requestId:    crypto.randomUUID(),
  });
  console.log(`[${adapter.chainType}] TX: ${receipt.txHash}`);
}

await runIssuerTest(new EVMAdapter({ rpcUrl: '...', chainId: '1', privateKey: '...' }));
await runIssuerTest(new XRPLMockAdapter());  // ← IssuerService 코드 한 줄도 바뀌지 않음
```

**완료 기준:**
- [ ] `EVMAdapter.mintNFT` 호출 → `TransactionReceipt` 반환
- [ ] `XRPLMockAdapter` 작성 → `IBlockchainAdapter` 인터페이스 컴파일 통과
- [ ] 동일 `runIssuerTest` 함수로 EVM·XRPL Mock 모두 실행 확인
