# Day 09 — 엔터프라이즈 체인 선택 + 전체 아키텍처 리뷰

**시간**: 3시간 (180분)  
**핵심 질문**: Phase 1을 마쳤다. Phase 2로 가려면 무엇을 결정해야 하는가?

---

## 세션 구조

| 시간 | 내용 |
|---|---|
| 00:00~00:30 | 1부: Phase 2 결정의 출발점 — 지금 열린 질문들 |
| 00:30~01:10 | 실습 1: XRP Ledger vs EVM — 요구사항 매핑 |
| 01:10~02:00 | 실습 2: XRPLAdapter 연결 실습 + 추상화 레이어 검증 |
| 02:00~02:50 | 실습 3: 전체 아키텍처 화이트보드 리뷰 |
| 02:50~03:00 | 마무리: Sharon의 최종 질문 시리즈 |

---

## 1부: Phase 2 결정의 출발점 (00:00~00:30)

### 1-1. 9일 동안 우리가 만든 것 (10분)

**토킹포인트:**

> "9일 27시간이 지났습니다. 우리는 단순히 코드를 배운 게 아닙니다. 교보생명 디지털 자산 플랫폼의 첫 번째 버전 아키텍처를 직접 설계했습니다. 오늘은 Phase 1을 닫고 Phase 2의 출발점을 정의하는 날입니다."

**Phase 1에서 우리가 결정한 것들:**

| 결정 | 선택 | ADR |
|---|---|---|
| 체인 추상화 | IChainAdapter 인터페이스 | ADR-001 |
| VASP 연동 | 외부 VASP 우선 | ADR-002 |
| 토큰 표준 진화 | BaseToken 공통 기반 | ADR-003 |
| 이벤트 처리 | 구독 + missed 복구 | ADR-004 |

> "이 네 가지 결정이 Phase 2, 3, 4에서도 살아있습니다. 오늘 우리가 Phase 2 설계를 시작하면 이 결정들이 얼마나 잘 버티는지 확인하게 됩니다."

### 1-2. Phase 2가 열어야 할 질문들 (20분)

**토킹포인트:**

> "Phase 2에서 KRW 스테이블코인을 발행한다는 결정은 났습니다. 그런데 그 말 하나에 수십 개의 미결정 사항이 들어있습니다."

**미결정 사항 목록:**

```
체인 레이어
  □ EVM 계속? XRP Ledger 도입? 멀티체인?
  □ Polygon Mainnet 그대로? 다른 L2?
  □ 퍼블릭 체인 vs 컨소시엄 체인?

컨트랙트 레이어
  □ ERC-20 그대로? 또는 ERC-2612(Permit)?
  □ 담보 1:1 KRW → 어디에 예치?
  □ 오라클 KRW/USD → Chainlink? 자체?
  □ Upgrade 패턴 도입? (UUPS Proxy)

VASP 레이어
  □ 교보생명 VASP 인가 취득 시점?
  □ 취득 전까지 어떤 외부 VASP와 계약?
  □ Travel Rule 100만원 기준 구현 방식?

규제 레이어
  □ 가상자산이용자보호법 준수 요건 충족?
  □ ISMS-P 범위에 스테이블코인 포함 시 추가 요건?
```

> "오늘 세션에서 이 모든 걸 결정할 수는 없습니다. 그러나 어떤 질문이 먼저 답해져야 하는지는 정리할 수 있습니다. 그게 오늘의 목표입니다."

---

## 실습 1: XRP Ledger vs EVM — 요구사항 매핑 (00:30~01:10)

### Step 1 — XRPLAdapter stub 읽기 (10분)

```bash
cat dmz/packages/chain-adapters/src/xrpl/XRPLAdapter.ts
```

**토킹포인트:**

> "Phase 1에서 XRPLAdapter는 모든 메서드가 throw('not implemented')입니다. 이 stub가 무엇을 의미하는가? 우리가 Phase 1에서 'XRP Ledger는 아직'이라는 결정을 내렸다는 기록입니다. 오늘은 그 결정을 검토합니다."

### Step 2 — 요구사항 매핑 테이블 직접 채우기 (30분)

아래 표를 직접 채운다. 각 셀에 기술적 사실과 비즈니스 판단을 같이 쓴다:

| 요구사항 | EVM / Polygon | XRP Ledger | 판단 |
|---|---|---|---|
| NFT 발행 | ERC-721 ✓ 성숙 | XLS-20 (2022 도입, 성장 중) | |
| 스마트컨트랙트 | Solidity ✓ 에코시스템 풍부 | Hooks (C, 제한적, 실험 단계) | |
| KRW 스테이블코인 | ERC-20 ✓ 표준 | IOU (신뢰 기반, 게이트웨이 필요) | |
| 거래 속도 | ~12초 (Ethereum L1) / ~1-2초 (L2) | ~3-5초 (XRPL) | |
| 거래 비용 | ~$1-3/tx (L1) / ~$0.01-0.1/tx (L2) | ~$0.00001/tx | |
| Travel Rule | 별도 구현 필요 | Memo 필드 활용 가능 | |
| 한국 VASP 파트너 | 多 (두나무, 빗썸 등) | 제한적 | |
| 개발 인력 | Solidity 개발자 多 | XRPL 전문가 희소 | |
| 교보 기존 파트너 | Polygon 기반 VASP 多 | ? | |

**답 해설 (강사):**

```
NFT: ERC-721이 압도적 성숙도. XLS-20은 가능하지만 도구·감사 생태계 부족.
     → Phase 1 선택 유지 타당

스마트컨트랙트: Hooks는 C 기반이고 상태 관리 방식이 달라서 IssuerService 전면 재설계 필요.
               → 기존 NFTIssuer.sol 같은 복잡한 로직은 XRP Ledger에서 구현 어려움

KRW 스테이블코인:
  - ERC-20: 교보 스마트컨트랙트에서 직접 제어 가능
  - IOU: 게이트웨이(중개자)가 개입해야 함. 교보가 게이트웨이가 되려면 추가 규제 요건

Travel Rule:
  - EVM: 솔리디티 없음, 오프체인에서 자체 구현해야 함
  - XRPL: Memo 필드에 여행자 규칙 데이터 삽입 가능, 그러나 표준화 미흡

결론: Phase 2 KRW 스테이블코인 = EVM(Polygon) 유지가 현실적
      XRP Ledger 도입을 검토할 시점 = Phase 4에서 글로벌 결제 네트워크 연동 시
```

### Step 3 — 체인 선택 프레임워크 정리 (20분)

**토킹포인트:**

> "체인 선택은 기술만의 문제가 아닙니다. 아래 세 가지 축으로 판단해야 합니다."

**세 가지 판단 축:**

```
1. 기술 성숙도
   - 원하는 기능이 안정적으로 동작하는가?
   - 감사 도구, 개발 도구, 문서가 충분한가?
   - 버그 발생 시 커뮤니티 지원이 있는가?

2. 생태계 적합성
   - 한국 VASP/거래소 연동이 가능한가?
   - 개발 인력 채용이 가능한가?
   - 교보 파트너사들이 지원하는 체인인가?

3. 규제 호환성
   - 한국 가상자산이용자보호법 준수 가능한가?
   - ISMS-P 범위 포함 시 추가 부담이 크지 않은가?
   - Travel Rule 구현이 현실적인가?
```

> "XRP Ledger는 1번(기술)은 나쁘지 않지만 2번(생태계)이 한국 시장에서 약합니다. Phase 4에서 글로벌 결제가 목표가 될 때 재검토하는 것이 맞습니다."

---

## 부록: Circle ARC — 체인이 아닌 정산 레이어로 (10분 선택)

> **언제 꺼낼까:** 수강자 중 "교보생명이 Circle과 MOU를 맺었다고 들었는데 이 아키텍처와 어떤 관계인가요?"라는 질문이 나올 경우 활용.

### Circle ARC란?

Circle ARC(Automated Real-time Clearing)는 Circle이 금융기관에 제공하는 **스테이블코인 기반 정산 인프라**다. USDC를 결제 수단으로 사용하는 기관 간 실시간 청산·결제 레이어다.

```
전통 구조:          교보 앱 → Core Banking → 계좌 이체 (T+1~2)
Circle ARC 구조:    교보 앱 → Core Banking → Circle ARC → USDC 정산 (실시간)
```

### 이 아키텍처에서 어디에 들어오는가?

**핵심: Circle ARC는 IChainAdapter가 아니라 IVASPAdapter 레이어다.**

```
현재 Phase 1:
  IssuerService → ExternalVASPAdapter → 외부 VASP API

Circle ARC 도입 시:
  IssuerService → CircleARCAdapter (implements IVASPAdapter)
                → Circle ARC API (USDC 정산 + Travel Rule)

변경되는 것:
  - CircleARCAdapter 신규 구현 (IVASPAdapter 구현체)
  - index.ts에서 vaspAdapter 교체 (한 줄)

변경 없는 것:
  - IChainAdapter (EVMAdapter 그대로)
  - IssuerService 비즈니스 로직
  - WebhookServer, ChainEventListener 등 전체 인프라
```

### XRPL과의 비교

| 항목 | XRP Ledger | Circle ARC |
|---|---|---|
| 역할 | 체인 레이어 (IChainAdapter) | 정산 레이어 (IVASPAdapter) |
| 진입 시점 | Phase 4 글로벌 결제 | Phase 2 KRW 스테이블코인 |
| 교보 관계 | 기술 옵션 | MOU 체결 (직접 관계) |
| 구현 대상 | XRPLAdapter 완성 | CircleARCAdapter 신규 |
| 표준 | XLS-20, Hooks | USDC + CCTP |
| Travel Rule | Memo 필드 (비표준) | 내장 지원 |

### 토킹포인트

> "Circle ARC는 블록체인을 바꾸는 게 아닙니다. 결제 정산 파트너를 Circle로 선택하는 겁니다. ADR-002에서 '외부 VASP 우선' 결정을 내렸을 때 이미 이 선택지를 열어뒀습니다. 교보생명이 Circle과 MOU를 맺었다는 건, Phase 2에서 ExternalVASPAdapter의 상대방이 Circle이 될 가능성이 있다는 뜻입니다. 코드는 이미 준비돼 있습니다."

---

## 실습 2: XRPLAdapter 연결 실습 + 추상화 레이어 검증 (01:10~02:00)

### Step 1 — xrpl.js 설치 및 Testnet 연결 (20분)

```bash
cd packages/chain-adapters
npm install xrpl
```

`dmz/packages/chain-adapters/src/xrpl/XRPLAdapter.ts` 의 `isConnected()`만 실제 구현:

```typescript
import { Client } from 'xrpl';
import type { IChainAdapter, ChainEvent, TransactionRequest } from '../interfaces/IChainAdapter';

export class XRPLAdapter implements IChainAdapter {
  private client: Client;

  constructor(private readonly config: { wsUrl: string }) {
    this.client = new Client(config.wsUrl);
  }

  async isConnected(): Promise<boolean> {
    try {
      if (!this.client.isConnected()) {
        await this.client.connect();
      }
      return this.client.isConnected();
    } catch {
      return false;
    }
  }

  async getBlockNumber(): Promise<number> {
    if (!this.client.isConnected()) await this.client.connect();
    const response = await this.client.request({ command: 'ledger', ledger_index: 'validated' });
    return response.result.ledger_index;
  }

  // Phase 2+에서 구현 — XRP Ledger는 EVM과 달리 Hooks 기반
  async call(_req: any): Promise<unknown> {
    throw new Error('XRPLAdapter.call: Hooks not implemented — Phase 2+');
  }

  async sendTransaction(_req: TransactionRequest): Promise<string> {
    throw new Error('XRPLAdapter.sendTransaction: not implemented — Phase 2+');
  }

  subscribeEvents(_contractAddr: string, _abi: unknown[], _eventName: string,
    _handler: (event: ChainEvent) => void): () => void {
    throw new Error('XRPLAdapter.subscribeEvents: not implemented — Phase 2+');
  }

  async queryEvents(_contractAddr: string, _abi: unknown[], _eventName: string,
    _fromBlock: number, _toBlock: number): Promise<ChainEvent[]> {
    throw new Error('XRPLAdapter.queryEvents: not implemented — Phase 2+');
  }
}
```

```typescript
// scripts/test-xrpl-connect.ts
import { XRPLAdapter } from '../dmz/packages/chain-adapters/src/xrpl/XRPLAdapter';

async function main() {
  console.log('=== XRP Ledger Testnet 연결 테스트 ===\n');

  const adapter = new XRPLAdapter({
    wsUrl: 'wss://s.altnet.rippletest.net:51233',  // XRPL Testnet
  });

  console.log('연결 시도 중...');
  const connected = await adapter.isConnected();
  console.log('연결 결과:', connected);

  if (connected) {
    const ledger = await adapter.getBlockNumber();
    console.log('최신 Ledger Index:', ledger);
    console.log('\n→ XRPL Testnet에 성공적으로 연결됨');
    console.log('→ EVMAdapter와 동일한 IChainAdapter 인터페이스로 동작');
  }
}

main().catch(console.error);
```

```bash
npx ts-node scripts/test-xrpl-connect.ts
```

### Step 2 — 추상화 레이어 검증 (25분)

**핵심 관찰:**

`ChainEventListener.ts`를 열고 확인한다:

```bash
cat dmz/packages/event-engine/src/listener/ChainEventListener.ts
```

**질문:**

```
Q: ChainEventListener가 EVMAdapter를 직접 참조하는 코드가 있는가?
   → 없다. IChainAdapter 인터페이스만 참조한다.

Q: XRPLAdapter로 교체하려면 무엇을 바꿔야 하는가?
   → dmz/apps/issuer-service/src/index.ts에서 어댑터 인스턴스 생성 부분 하나만
   → ChainEventListener, IssuerService 코드는 변경 없음

Q: 이것이 ADR-001의 목표였는가?
   → 맞다. "체인 교체 시 비즈니스 로직 변경 없음"이 목표였다.
```

**코드 비교:**

```typescript
// dmz/apps/issuer-service/src/index.ts — 교체 전 (Phase 1)
const chainAdapter = new EVMAdapter({
  rpcUrl:     process.env.RPC_URL!,
  chainId:    process.env.CHAIN_ID!,
  privateKey: process.env.OPERATOR_PRIVATE_KEY,
});

// Phase 2에서 XRP Ledger로 교체 시
const chainAdapter = new XRPLAdapter({
  wsUrl: process.env.XRPL_WS_URL!,
});

// ChainEventListener는 그대로 — 코드 한 줄 변경
const listener = new ChainEventListener(chainAdapter, stateStore);
```

**토킹포인트:**

> "ADR-001을 작성할 때 '체인 교체 시 비즈니스 로직 변경 없음'이 목표라고 했습니다. 오늘 실습에서 그 목표가 달성됐음을 확인했습니다. 단, XRPLAdapter의 subscribeEvents가 구현되어야 합니다. XRP Ledger는 이벤트 구독 방식이 EVM의 contract.on()과 다릅니다. 이 구현이 Phase 2의 첫 번째 기술 과제입니다."

### Step 3 — XRP Ledger 이벤트 구독 방식 차이 (15분)

**EVM vs XRP Ledger 이벤트 구독 비교:**

```
EVM (ethers.js):
  contract.on('Issued', (to, tokenId, activityId) => { ... })
  → 컨트랙트 ABI + 이벤트 이름으로 필터링
  → LogBloom으로 효율적 필터링

XRP Ledger:
  client.request({ command: 'subscribe', streams: ['ledger'] })
  → 모든 트랜잭션 수신 후 오프체인에서 필터링
  → XLS-20 NFT 트랜잭션: NFTokenMint, NFTokenBurn, NFTokenCreateOffer
  → Hooks 트랜잭션: 별도 파싱 필요
```

**이 차이가 ChainEventListener에 미치는 영향:**

```typescript
// IChainAdapter.subscribeEvents 시그니처
subscribeEvents(
  contractAddr: string,  // ← XRP에서는 '계정 주소'로 해석
  abi: unknown[],        // ← XRP에서는 의미 없음 (타입 파싱 필요)
  eventName: string,     // ← XRP에서는 tx type으로 매핑
  handler: (event: ChainEvent) => void,
): () => void;

// XRPLAdapter에서는 이 인터페이스를 어떻게 구현할 것인가?
// → 내부적으로 XRPL 네이티브 방식으로 구독
// → ChainEvent 형태로 변환해서 handler 호출
// → ChainEventListener는 모름 — 그냥 ChainEvent만 받음
```

> "인터페이스 설계의 성공과 한계가 동시에 보입니다. 대부분은 추상화됩니다. 그러나 abi 파라미터는 XRP에서 무의미합니다. Phase 2 설계 시 이 인터페이스를 더 유연하게 수정할지 논의가 필요합니다."

---

## 실습 3: 전체 아키텍처 화이트보드 리뷰 (02:00~02:50)

### Step 1 — 레이어 다이어그램 직접 그리기 (20분)

9일 동안 다룬 레이어를 수강자가 화이트보드에 직접 그린다. 강사 없이 먼저 시도.

**정답 다이어그램:**

```
┌─────────────────────────────────────────────────────────┐
│                    교보 앱 / Core Banking                │
└─────────────────────────┬───────────────────────────────┘
                          │ Webhook (HMAC-SHA256)
┌─────────────────────────▼───────────────────────────────┐
│                    DMZ (Nginx)                           │
│            IP 화이트리스트 + 포트 분리                    │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                  issuer-service                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │              IssuerService                       │    │
│  │  KYC (Core Banking) → AML (VASP) → 온체인 발행  │    │
│  └─────────────────────┬───────────────────────────┘    │
│                        │                                  │
│  ┌─────────────────────▼───────────────────────────┐    │
│  │           IChainAdapter                          │    │
│  │     EVMAdapter (Phase 1) / XRPLAdapter (stub)   │    │
│  └─────────────────────┬───────────────────────────┘    │
└────────────────────────┼────────────────────────────────┘
                         │ RPC / WebSocket
┌────────────────────────▼────────────────────────────────┐
│                블록체인 노드 (Hardhat / Polygon)          │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ ActivityOracle│  │  NFTIssuer  │  │  KyoboNFT    │   │
│  │ (ecrecover)  │  │ (OPERATOR)  │  │ (ERC-721)    │   │
│  └──────────────┘  └──────────────┘  └──────┬───────┘   │
│                                              │ emit Issued│
└──────────────────────────────────────────────┼───────────┘
                                               │
┌──────────────────────────────────────────────▼───────────┐
│                  ChainEventListener                        │
│   subscribeEvents + queryEvents(missed 복구)              │
│                         │                                  │
│               IdempotencyGuard                             │
│                         │                                  │
│               NFTIssuedHandler                             │
│                         │                                  │
│            RetryHandler + DLQ                              │
│                         │                                  │
│           Core Banking Webhook                             │
└────────────────────────────────────────────────────────────┘
         ┌───────────────────────────────┐
         │     ISMSChecklist (1h cron)   │
         │  ACCESS / CRYPTO / LOG / ...  │
         └───────────────────────────────┘
```

### Step 2 — 각 레이어의 설계 결정 이유 질문 (20분)

강사(Sharon)가 아래 질문을 받고 각 결정의 이유를 설명한다. 수강자가 이해가 안 되는 부분을 질문한다.

**예상 질문과 답변:**

**Q: 왜 issuer-service와 ChainEventListener가 같은 프로세스에 있는가?**
> "Phase 1에서는 단순성이 우선입니다. Phase 2에서 규모가 커지면 이벤트 처리를 별도 서비스로 분리합니다. 현재 코드는 분리를 고려해 DI 방식으로 설계되어 있어 분리가 어렵지 않습니다."

**Q: IdempotencyStore를 InMemory로 쓰는 것은 위험하지 않은가?**
> "맞습니다. Phase 1 교육용입니다. 프로덕션에서는 Redis로 교체해야 합니다. `InMemoryIdempotencyStore` 클래스가 `IIdempotencyStore` 인터페이스를 구현하므로 Redis 구현체로 교체하면 나머지 코드는 변경 없습니다."

**Q: ActivityOracle 서명 키가 하나인 것은 SPOF 아닌가?**
> "맞습니다. 의도적으로 남긴 Phase 1 위험입니다. Phase 2에서 멀티시그 오라클로 교체합니다. Day 08에서 설명한 '의도적으로 남긴 위험' 테이블에 기록되어 있습니다."

**Q: KyoboNFT의 ICompliance.canTransfer()가 Phase 1에서 항상 true인데 의미가 있는가?**
> "훅이 연결되어 있다는 것 자체가 의미입니다. Phase 3 STO에서 `STOCompliance`로 교체할 때 `KyoboNFT` 코드를 건드리지 않습니다. 인터페이스만 구현하면 됩니다."

### Step 3 — Phase 2 설계의 출발점 질문 시리즈 (10분)

**최종 질문 시리즈:**

**질문 1:**
> "Phase 2에서 `KRWStablecoin.sol`을 배포하려면 이 다이어그램에서 무엇이 추가되는가?"

```
추가 필요:
  - KRWStablecoin.sol (ERC-20 + BaseToken 상속)
  - KRWIssuer.sol (ERC-20 발행 게이트웨이)
  - 오라클: KRW/USD 환율 (Chainlink 또는 자체)
  - VASP 연동: 입출금 브릿지 (외부 VASP or 교보 VASP)
  - ChainEventListener: Transfer 이벤트 핸들러 추가
  - ISMSChecklist: 스테이블코인 담보 비율 점검 항목 추가

변경 없는 것:
  - IChainAdapter (EVMAdapter 그대로)
  - WebhookServer, RetryHandler, IdempotencyGuard
  - DMZ Nginx 구조
  - ISMSChecklist 프레임워크
```

**질문 2:**
> "교보생명이 VASP 인가를 취득했을 때 코드에서 바꿔야 하는 것은 단 하나다. 무엇인가?"

```
답: dmz/apps/issuer-service/src/index.ts의 어댑터 인스턴스 생성 부분

// 현재 (외부 VASP)
const vaspAdapter = new ExternalVASPAdapter({
  baseUrl: process.env.VASP_API_URL!,
  apiKey:  process.env.VASP_API_KEY!,
});

// 인가 취득 후 (교보 VASP)
const vaspAdapter = new KyoboVASPAdapter({
  hsmEndpoint: process.env.HSM_ENDPOINT!,
  // ...
});

// IssuerService, IVASPAdapter 코드 변경 없음 — ADR-002 목표 달성
```

**질문 3:**
> "STO를 도입할 때 ICompliance 구현체를 교체하는 것만으로 충분한가? 부족하다면 무엇이 더 필요한가?"

```
ICompliance 교체로 해결되는 것:
  - canTransfer(): KYC 검증 + AML 필터 + 보유 한도 체크
  - transferred(): 이전 완료 후 콜백

ICompliance 교체만으로 부족한 것:
  - SecurityToken.sol 자체: ERC-1400 Partition 구조 필요
    (KyoboNFT의 ERC-721과는 토큰 구조 자체가 다름)
  - 결제 결제 결제: 증권 결제를 위한 한국예탁결제원(KSD) 연동
  - 투자자 등록: 적격 투자자 화이트리스트 관리
  - 배당: 배당 지급 스마트컨트랙트 (ERC-1400 기능)

결론:
  Phase 3 STO는 ICompliance 교체 + SecurityToken.sol 신규 배포 필요
  그러나 BaseToken RBAC + Pause 구조는 그대로 재사용
  IChainAdapter, WebhookServer, ChainEventListener 등 인프라 레이어는 변경 없음
```

---

## 마무리 (02:50~03:00)

**9일 전체 핵심 메시지:**

```
Day 01: IT 시스템 충돌을 먼저 이해해야 설계가 가능하다
Day 02: DMZ는 방화벽이 아니라 신뢰 경계다
Day 03: 폴링은 확인이고 이벤트 구독은 신뢰다 — Missed Event 복구가 핵심
Day 04: 금융 Webhook은 HMAC + 멱등성 + DLQ 세 가지가 다 있어야 한다
Day 05: 배포된 컨트랙트는 수정 불가 — RBAC, Pause, Compliance 훅은 처음부터 설계돼야 한다
Day 06: 발행은 오프체인(KYC/AML)과 온체인(오라클/중복) 이중 검증이다
Day 07: 테스트넷 배포 후 Etherscan Sepolia가 공개 감사 로그다 — 비상 정지는 30초 안에
Day 08: ISMS-P는 문서가 아닌 코드로 구현해야 지속 가능하다
Day 09: 추상화 레이어가 제대로 설계됐다면 체인 교체는 한 줄이다
```

**Phase 2 시작 전 Sharon(강사)에게 먼저 결정을 받아야 할 것:**

```
우선순위 1: VASP 파트너사 선정
  → 외부 VASP 연동 계약 없이 KRW 스테이블코인 발행 불가
  → ExternalVASPAdapter의 baseUrl, apiKey 스펙이 결정되어야 개발 시작 가능

우선순위 2: Core Banking 연동 방식
  → REST API vs Kafka — KyoboCoreBankingAdapter 구현 방향
  → 교보DTS IT 담당자와 Sharon이 협의해야 하는 사항

우선순위 3: Upgrade 패턴 도입 여부
  → Phase 2에서 KyoboNFT에 기능 추가 필요 시 UUPS Proxy 도입
  → 결정 늦으면 재배포 비용 발생
```

**Sharon의 마지막 메시지:**

> "오늘로 Phase 1 교육이 끝났습니다. 그러나 이 코드는 Phase 1 운영 코드입니다. 교보생명이 Phase 2로 가려면 세 가지 결정이 필요합니다. 그 결정을 Sharon이 주도합니다. 이게 이 설계의 구조적 의도입니다."

---

## 참조 파일

- `dmz/packages/chain-adapters/src/xrpl/XRPLAdapter.ts`
- `dmz/packages/chain-adapters/src/interfaces/IChainAdapter.ts`
- `blockchain/src/phase2/KRWStablecoin.sol`
- `blockchain/src/phase3/SecurityToken.sol`
- `dmz/packages/vasp/src/internal/KyoboVASPAdapter.ts`
- `dmz/packages/vasp/src/external/ExternalVASPAdapter.ts`
- `dmz/packages/compliance/src/isms/ISMSChecklist.ts`
- `docs/adr/001-chain-abstraction.md`
- `docs/adr/002-vasp-external-first.md`
- `docs/adr/003-token-standard-evolution.md`
- `docs/adr/004-event-driven-architecture.md`
- `docs/architecture/overview.md`
