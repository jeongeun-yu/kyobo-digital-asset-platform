# Day 09 — 엔터프라이즈 체인 선택 + 전체 아키텍처 리뷰

**시간**: 3시간  
**핵심 질문**: Phase 1을 마쳤다. Phase 2로 가려면 무엇을 결정해야 하는가?

---

## 목표

ARC / XRP Ledger를 단순 소개가 아닌 **"이 프로젝트에서 언제, 어떤 조건에서 도입할 것인가"** 맥락으로 본다.  
9일의 마지막은 지식 확인이 아니라 **Phase 2 설계의 출발점**이다.

---

## 실습 시나리오

### 실습 1 — XRP Ledger 특성 vs 이 프로젝트 요구사항 (40분)

`XRPLAdapter.ts`의 stub 주석을 읽고 아래를 채운다:

| 요구사항 | EVM (현재) | XRP Ledger | 결론 |
|---|---|---|---|
| NFT 발행 | ERC-721 | XLS-20 | |
| 스마트컨트랙트 | Solidity | Hooks (제한적) | |
| KRW 스테이블코인 | ERC-20 | IOU (Issued Currency) | |
| 거래 속도 | ~2초 (Polygon) | ~3-5초 | |
| Travel Rule | 별도 구현 | Memo 필드 | |
| 한국 VASP 지원 | 多 | 제한적 | |

**결론:** Phase 2 KRW 스테이블코인에서 XRP Ledger를 선택한다면 무엇을 먼저 해결해야 하는가?

### 실습 2 — XRPLAdapter 인터페이스 구현 시작 (50분)

`IChainAdapter` 인터페이스를 보고 `XRPLAdapter`에서 가장 먼저 구현해야 할 메서드를 선택한다:

```typescript
// packages/chain-adapters/src/xrpl/XRPLAdapter.ts
// xrpl.js 라이브러리를 사용해 isConnected()만 실제 구현해본다

import { Client } from 'xrpl';

export class XRPLAdapter implements IChainAdapter {
  private client: Client;

  constructor(config: { wsUrl: string }) {
    this.client = new Client(config.wsUrl);
  }

  async isConnected(): Promise<boolean> {
    try {
      await this.client.connect();
      return this.client.isConnected();
    } catch {
      return false;
    }
  }
  // 나머지는 여전히 stub...
}
```

**핵심 관찰:** `EVMAdapter`를 `XRPLAdapter`로 교체할 때 `ChainEventListener`나 `IssuerService`는 코드가 바뀌는가?

### 실습 3 — 전체 아키텍처 리뷰 (50분)

9일 동안 다룬 레이어를 화이트보드에 직접 그린다.  
Sharon(강사)이 각 레이어의 **설계 결정 이유**를 설명한다. 수강자는 질문한다.

```
[교보 앱] ──→ [WebhookServer] ──→ [IssuerService]
                                        │
                              [KYC] [AML 스크리닝]
                                        │
                             [IChainAdapter] ──→ [EVMAdapter]
                                        │         (XRPLAdapter 교체 가능)
                             [NFTIssuer Contract]
                                        │
                              [KyoboNFT Contract]
                                        │ emit Issued
                             [ChainEventListener]
                                        │
                             [NFTIssuedHandler]
                                        │ retry
                             [Core Banking Webhook]
```

**최종 질문 시리즈:**
1. Phase 2에서 `KRWStablecoin.sol`을 배포하려면 이 다이어그램에서 무엇이 추가되는가?
2. 교보생명이 VASP 인가를 취득했을 때 코드에서 바꿔야 하는 것은 단 하나다. 무엇인가?
3. STO를 도입할 때 `ICompliance` 구현체를 교체하는 것만으로 충분한가? 부족하다면 무엇이 더 필요한가?

---

## 참조 파일

- `packages/chain-adapters/src/xrpl/XRPLAdapter.ts`
- `packages/contracts/src/phase2/KRWStablecoin.sol`
- `packages/contracts/src/phase3/SecurityToken.sol`
- `packages/vasp/src/internal/KyoboVASPAdapter.ts`
- `docs/adr/` (전체)
- `docs/architecture/overview.md`
