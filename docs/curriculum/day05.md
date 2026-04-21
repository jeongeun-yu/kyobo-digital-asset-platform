# Day 05 — 스마트컨트랙트 실행 모델 해부

**시간**: 3시간  
**핵심 질문**: 금융사가 스마트컨트랙트를 운용하기 전에 반드시 이해해야 할 것들은 무엇인가?

---

## 목표

"스마트컨트랙트란?" 설명 없음.  
`KyoboNFT.sol`과 `BaseToken.sol`을 직접 읽으면서 **운용 책임자 관점**에서 알아야 할 것을 파악한다.  
배포된 컨트랙트는 수정이 불가능하다. 그 무게를 이해하는 날이다.

---

## 실습 시나리오

### 실습 1 — BaseToken.sol 역할 기반 접근 제어 분석 (40분)

```bash
cat packages/contracts/src/base/BaseToken.sol
```

4개의 Role을 찾고 각각 답한다:

| Role | 이 키를 잃으면? | 이 키가 탈취되면? |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | | |
| `ISSUER_ROLE` | | |
| `REVOKER_ROLE` | | |
| `PAUSER_ROLE` | | |

**핵심 질문:** `PAUSER_ROLE` 키는 교보생명 내부에서 누가 가지고 있어야 하는가?  
야간·주말에 컨트랙트 이상이 발생했을 때 누가 pause()를 호출할 수 있어야 하는가?

### 실습 2 — KyoboNFT.sol 전송 제어 흐름 추적 (50분)

NFT가 A → B로 전송될 때의 실행 경로를 직접 추적한다:

```
transferFrom(A, B, tokenId)
  → _update(B, tokenId, A)        ← KyoboNFT override
    → _checkCompliance(A, B, tokenId)
      → compliance.canTransfer(A, B, tokenId)
    → super._update(B, tokenId, A) ← ERC-721 원본
```

**질문:**
1. `compliance` 주소를 `address(0)`으로 배포하면 어떻게 되는가?
2. Phase 3 STO에서 "투자자 미등록 계정으로 전송 차단"을 구현하려면 무엇을 바꾸는가?  
   (컨트랙트 재배포 없이 가능한가?)

### 실습 3 — 컨트랙트 취약점 시나리오 분석 (50분)

아래 시나리오 중 이 프로젝트에서 막혀 있는 것과 막혀 있지 않은 것을 분류한다:

| 취약점 시나리오 | 막혀 있는가? | 어디서? |
|---|---|---|
| 아무나 NFT를 발행한다 | | |
| 발행된 NFT를 발행자가 회수한다 | | |
| 컨트랙트 일시 중단 | | |
| 동일 activityId로 NFT 2번 발행 | | |
| 컨트랙트 업그레이드 (로직 변경) | | |

**마지막 항목 토론:**  
배포된 컨트랙트는 불변이다. Phase 2에서 토큰 로직을 바꾸려면?  
→ Proxy 패턴 (ERC-1967) — Phase 2+ 도입 예정

---

## 참조 파일

- `packages/contracts/src/base/BaseToken.sol`
- `packages/contracts/src/phase1/KyoboNFT.sol`
- `packages/contracts/src/interfaces/ICompliance.sol`
- `docs/adr/003-token-standard-evolution.md`
