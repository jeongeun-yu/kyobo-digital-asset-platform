# M3 S14 — 멀티체인 추상화 레이어 IBlockchainAdapter 설계

> Block C — VASP 연동 + 복구 + 멀티체인 추상화 · M3 S14 · 강의 55분  
> 대상: `dmz/packages/chain-adapters/src/interfaces/IBlockchainAdapter.ts`

---

## S14 — 멀티체인 추상화 레이어 — IBlockchainAdapter 설계

> **강의 55분** — 이론 중심 세션. 실습 없음.

### 1. EVM 고착화 리스크

아무 추상화 없이 EVMAdapter를 직접 호출하면:

```typescript
// ❌ EVM 고착 코드 — IssuerService 어딘가에서
const tx = await ethers.provider.sendTransaction({ ... });
const receipt = await tx.wait();                    // ← ethers.js 전용
const gasUsed = receipt.gasUsed;                    // ← EVM 개념
const log = receipt.logs[0];                        // ← EVM Log
const topic = log.topics[0];                        // ← EVM event topic
const decoded = iface.parseLog(log);                // ← ABI 디코딩 (EVM 전용)
```

이 코드를 XRPL로 교체하려면:

```
xrpl.js 사용법 전혀 다름
Offer 기반 전송 → EVM sendTransaction과 개념 다름
Log/Topic 없음 → Transaction Metadata로 파싱해야 함
ABI 없음 → 별도 파싱 로직 필요
→ IssuerService + LedgerService + AuditLog 전부 수정 필요
```

**결론: 체인 전용 개념이 비즈니스 로직에 스며들면 교체 비용이 폭발한다.**

### 2. IBlockchainAdapter 설계 원칙

```typescript
// IBlockchainAdapter.ts:73
export interface IBlockchainAdapter {
  readonly chainId:   string;
  readonly chainType: 'EVM' | 'XRPL' | 'UTXO' | 'BFT';

  isConnected():  Promise<boolean>;
  getBlockNumber(): Promise<number>;

  mintNFT(params: MintParams):        Promise<TransactionReceipt>;
  mintNFTBatch(params: MintBatchParams): Promise<TransactionReceipt>;
  burnNFT(params: BurnParams):        Promise<TransactionReceipt>;
  getBalance(contractAddr: string, owner: string, tokenId: bigint): Promise<bigint>;

  call(params: ContractCallParams):         Promise<unknown>;
  sendTransaction(params: ContractCallParams): Promise<TransactionReceipt>;
  getReceipt(txHash: string):               Promise<TransactionReceipt | null>;

  subscribeEvents(
    contractAddr: string, abi: unknown[], eventNames: string[],
    fromBlock: number, handler: (event: ChainEvent) => Promise<void>,
  ): Promise<() => void>;

  queryEvents(
    contractAddr: string, abi: unknown[], eventName: string,
    fromBlock: number, toBlock: number,
  ): Promise<ChainEvent[]>;
}
```

**의존 방향 — Strategy Pattern:**

```
IssuerService ──depends on──→ IBlockchainAdapter (interface)
                                      ↑
                              EVMAdapter (implements)
                              XRPLAdapter (implements)
                              CircleAdapter (implements)
```

IssuerService는 인터페이스만 안다. 어떤 어댑터가 주입되는지 관심 없다.

### 3. EVM vs XRPL vs Circle ARC 패러다임 비교

| 개념 | EVM (Ethereum) | XRPL | Circle ARC |
|---|---|---|---|
| 스마트컨트랙트 | Solidity (Turing-complete) | 없음 (Hooks는 실험적) | 프로그래머블 월렛 |
| NFT 표준 | ERC-1155 (tokenId+amount) | XLS-20 (NFToken, Offer 기반 전송) | ERC-1155 래핑 |
| 가스 체계 | Gas × GasPrice = ETH 지불 | Reserve(XRP 잠금) + fixed Fee | Gas 추상화 (Circle 내부 처리) |
| TX 서명 | EOA privateKey + nonce | 계정 Sequence 번호 | 서버 측 키 관리 (MPC) |
| 이벤트 | ABI-encoded Log (topics) | Transaction Metadata | WebHook / SDK 이벤트 |
| Finality | PoS Checkpoint (~12분) | 약 3–5초 (BFT 합의) | 체인 의존 |
| 1:1 매핑 불가 지점 | — | Offer 기반 전송, NFTokenID 구조 | Account Abstraction |

**EVM과 XRPL이 1:1 매핑 안 되는 핵심 지점:**

```
EVM: transfer(from, to, amount) → event Transfer(from, to, amount)
XRPL: NFTokenCreateOffer → NFTokenAcceptOffer 두 단계
      → 단순 "transfer" 개념 없음
      → 어댑터가 내부적으로 Offer 생성 + 수락을 묶어서 처리해야 함
```

### 4. TransactionReceipt 공통 추상화

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

`gasUsed`가 optional인 이유: XRPL은 가스 개념이 없다. 어댑터가 체인 특성에 맞게 채울 수 있는 필드만 채운다.

### 5. ChainEvent 공통 추상화

```typescript
// IBlockchainAdapter.ts:32
export interface ChainEvent {
  eventName:    string;
  contractAddr: string;
  txHash:       string;
  blockNumber:  number;
  logIndex:     number;
  args:         Record<string, unknown>;
  raw:          unknown;   // 체인별 원본 데이터 보존
}
```

`raw` 필드: 체인 전용 데이터(EVM EventLog, XRPL TransactionMetadata)를 그대로 보존한다. 어댑터 레이어를 벗어난 곳에서 `raw`를 직접 파싱하면 추상화가 무너진다.

### 6. 멀티체인 전환 전략 — 당사 적용 로드맵

```
Phase 1 (현재): EVMAdapter
  → ERC-1155 NFT 발행
  → Ethereum mainnet / Polygon

Phase 2 (국내 규제 대응): XRPLAdapter 병행
  → 국내 규제 환경에서 XRPL 활용 시
  → IssuerService 코드 무변경, 어댑터만 교체

Phase 3 (글로벌 확장): CircleAdapter
  → 글로벌 스테이블코인 정산
  → CCTP (Cross-Chain Transfer Protocol)
```

**핵심 원칙:**

> 비즈니스 로직·원장·감사 로그는 체인 무관하게 유지.  
> VASP가 어댑터 구현체를 선택하고 주입한다.

### 7. IVASPAdapter와의 관계

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

```
IVASPAdapter       — 비즈니스 추상화 (지갑 생성, 전송, AML 스크리닝)
                     규제 맥락: 특금법상 VASP 인가 없이 운영 불가
                     Phase 1: 외부 VASP (월렛원·코다) 위임
                     향후: 교보 자체 VASP 인가 취득 시 직접 구현

IBlockchainAdapter — 기술 추상화 (블록체인 직접 연결)
                     체인 프로토콜 레이어 캡슐화
                     VASP 내부에서 체인 연결에 사용
```

**완료 기준:**
- [ ] EVM·XRPL·Circle ARC 패러다임 핵심 차이 3가지 이상 설명 가능
- [ ] IBlockchainAdapter 설계 원칙 — Strategy Pattern 적용 이유 설명
- [ ] 당사 멀티체인 적용 순서 (Phase 1→2→3) 근거 제시
