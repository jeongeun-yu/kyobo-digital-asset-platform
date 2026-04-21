# Day 08 — 보안 필수 항목: 운용 가능한 수준의 체크리스트

**시간**: 3시간  
**핵심 질문**: ISMS-P 심사관이 이 시스템을 보면 뭘 물어볼 것인가?

---

## 목표

보안 감사를 "해야 하는 것"이 아니라 **운용자가 직접 실행하는 도구**로 만든다.  
`ISMSChecklist`를 직접 실행하고, 스마트컨트랙트 주요 취약점을 이 코드베이스 맥락에서 이해한다.

---

## 실습 시나리오

### 실습 1 — ISMSChecklist 실행 및 항목 이해 (40분)

```typescript
import { ISMSChecklist } from './packages/compliance/src/isms/ISMSChecklist';

const checklist = new ISMSChecklist();
const results   = await checklist.runAll();
const summary   = checklist.getSummary(results);

console.log('총', summary.total, '항목');
console.log('통과:', summary.passed);
console.log('실패:', summary.failed);
```

각 체크 항목의 `check()` 함수를 읽고 **실제 구현이 필요한 TODO**를 찾는다:

- `ISMS-ACCESS-001`: 어떤 API를 호출해서 권한 목록을 가져와야 하는가?
- `ISMS-CRYPTO-001`: KMS 연결 상태는 어떻게 확인하는가?
- `ISMS-INCIDENT-001`: `KyoboNFT.paused()` 를 어떻게 호출하는가?

### 실습 2 — 스마트컨트랙트 취약점 시나리오 (60분)

아래 취약점 코드를 보고 이 프로젝트에서 막혀 있는지 직접 찾는다:

**케이스 1 — Reentrancy:**
```solidity
// 취약한 코드
function withdraw(uint amount) public {
    payable(msg.sender).call{value: amount}("");  // 외부 호출 먼저
    balances[msg.sender] -= amount;               // 잔액 차감 나중
}
```
→ `NFTIssuer.sol`에서 이 패턴이 어떻게 방지되어 있는가?

**케이스 2 — 권한 없는 발행:**
```solidity
// 취약한 코드
function issue(address to) public {  // onlyRole 없음
    _safeMint(to, _nextTokenId++);
}
```
→ `KyoboNFT.issue()`에서 어떤 modifier가 이를 막는가?

**케이스 3 — Private Key 노출:**
```typescript
// 절대 금지 패턴
const wallet = new Wallet("0xabcd1234...", provider);  // 하드코딩
```
→ 이 프로젝트에서 private key는 어떻게 주입되는가? (`.env.example` 확인)

### 실습 3 — Private Key 관리 아키텍처 설계 토론 (40분)

교보생명 운영 환경에서 `OPERATOR_PRIVATE_KEY`를 어떻게 관리할 것인가?

| 방식 | 장점 | 단점 | 교보 적합성 |
|---|---|---|---|
| 환경 변수 (.env) | 간단 | 서버 탈취 시 노출 | X |
| AWS KMS | 키 메모리 미보관 | AWS 의존 | △ |
| 교보 자체 HSM | 완전 내재화 | 구축 비용 | Phase 4 목표 |
| MPC (Multi-Party) | 키 분산 | 복잡도 | Phase 2+ |

**결론:** Phase 1에서 현실적으로 선택 가능한 방식은?

---

## 참조 파일

- `packages/compliance/src/isms/ISMSChecklist.ts`
- `packages/contracts/src/phase1/NFTIssuer.sol` (ReentrancyGuard)
- `packages/contracts/src/base/BaseToken.sol` (RBAC)
- `.env.example`
- `docs/adr/002-vasp-external-first.md`
