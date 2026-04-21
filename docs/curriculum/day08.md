# Day 08 — 보안: ISMS-P와 스마트컨트랙트 운용 보안

**시간**: 3시간 (180분)  
**핵심 질문**: ISMS-P 심사관이 이 시스템을 보면 뭘 물어볼 것인가? 그 질문에 코드로 답할 수 있는가?

---

## 세션 구조

| 시간 | 내용 |
|---|---|
| 00:00~00:35 | 1부: 블록체인 시스템과 ISMS-P |
| 00:35~01:10 | 실습 1: ISMSChecklist 실행 + TODO 구현 |
| 01:10~01:45 | 2부: 스마트컨트랙트 주요 취약점 운용 관점 재해석 |
| 01:45~02:25 | 실습 2: 취약점 시나리오 분석 심화 |
| 02:25~03:00 | 3부: Private Key 관리 아키텍처 설계 |

---

## 1부: 블록체인 시스템과 ISMS-P (00:00~00:35)

### 1-1. ISMS-P 범위에 블록체인이 포함될 때 (20분)

**토킹포인트:**

> "교보생명은 ISMS-P 인증을 보유하고 있습니다. 새 IT 시스템을 도입하면 ISMS-P 인증 범위에 포함시켜야 합니다. 심사관이 블록체인 시스템을 보면 어떤 질문을 할까요?"

**예상 심사 질문:**

| 심사 영역 | 예상 질문 | 이 프로젝트의 답 |
|---|---|---|
| 접근통제 | 블록체인 노드 RPC에 인가된 계정만 접근하는가? | DMZ Nginx IP 화이트리스트 |
| 암호화 | Private Key는 어디에 저장되는가? | KMS (코드에 없음) |
| 로그 관리 | 발행·전송 이력을 감사할 수 있는가? | 온체인 이벤트 + DB 이중 기록 |
| 가용성 | 노드 다운 시 서비스 영향은? | 이벤트 복구 메커니즘 |
| 취약점 관리 | 스마트컨트랙트 보안 검토를 했는가? | 코드 리뷰 + 감사 이력 |
| 사고 대응 | 보안 사고 시 즉각 차단 가능한가? | pause() 기능 + PAUSER_ROLE |

### 1-2. ISMSChecklist 설계 철학 (15분)

```bash
cat packages/compliance/src/isms/ISMSChecklist.ts
```

**토킹포인트:**

> "ISMS 체크리스트를 문서로 관리하면 심사 때 '우리가 했습니다'라고 말만 할 수 있습니다. 이 프로젝트는 체크리스트를 코드로 구현합니다. 1시간마다 자동으로 실행되고, 실패 항목은 즉시 알람이 갑니다. 심사관에게 실행 로그를 보여줄 수 있습니다."

```typescript
// issuer-service/src/index.ts에서
setInterval(async () => {
  const results = await isms.runAll();
  const summary = isms.getSummary(results);
  if (summary.failed.length > 0) {
    console.error('[ISMS] 점검 실패 항목:', summary.failed);
    // TODO: Slack/SMS 알람 발송
  }
}, 60 * 60 * 1000);  // 1시간마다
```

---

## 실습 1: ISMSChecklist 실행 + TODO 구현 (00:35~01:10)

### Step 1 — 현재 상태 실행 (10분)

```typescript
// scripts/run-isms-check.ts
import { ISMSChecklist } from '../packages/compliance/src/isms/ISMSChecklist';

async function main() {
  const checklist = new ISMSChecklist();
  const results   = await checklist.runAll();
  const summary   = checklist.getSummary(results);

  console.log('\n=== ISMS-P 자동 점검 결과 ===');
  console.log(`총 ${summary.total}개 항목`);
  console.log(`통과: ${summary.passed}개`);
  console.log(`실패: ${summary.failed.length}개`);

  if (summary.failed.length > 0) {
    console.log('\n실패 항목:');
    summary.failed.forEach(id => {
      const r = results.find(r => r.itemId === id)!;
      console.log(`  ✗ ${id}: ${r.detail ?? '구현 필요'}`);
    });
  }

  console.log('\n상세 결과:');
  results.forEach(r => {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.itemId}`);
  });
}

main();
```

### Step 2 — ISMS-INCIDENT-001 실제 구현 (25분)

`ISMSChecklist.ts`의 ISMS-INCIDENT-001 체크를 실제로 동작하게 구현한다:

```typescript
{
  id: 'ISMS-INCIDENT-001',
  category: 'INCIDENT',
  description: '스마트컨트랙트 비상정지(pause) 기능 작동 가능 여부',
  check: async () => {
    // TODO를 실제 구현으로 교체
    const { EVMAdapter } = await import('../../../chain-adapters/src/evm/EVMAdapter');
    const adapter = new EVMAdapter({
      rpcUrl:  process.env.RPC_URL ?? 'http://localhost:8545',
      chainId: process.env.CHAIN_ID ?? '31337',
    });

    const ABI = ["function paused() view returns (bool)"];
    const paused = await adapter.call({
      contractAddr: process.env.NFT_CONTRACT_ADDR ?? '',
      abi: ABI,
      method: 'paused',
      args: [],
    });

    // paused가 false여야 정상 (서비스 중)
    // PAUSER_ROLE 보유 계정이 존재하는지도 확인 필요
    return paused === false;
  },
},
```

구현 후 재실행해서 ISMS-INCIDENT-001이 통과되는지 확인.

---

## 2부: 스마트컨트랙트 취약점 운용 관점 재해석 (01:10~01:45)

### 2-1. 취약점과 운용 위험을 연결하기 (25분)

**토킹포인트:**

> "스마트컨트랙트 취약점은 기술 문제가 아닙니다. 운용 위험입니다. 각 취약점이 교보생명에게 어떤 실제 피해를 만드는지 생각해보겠습니다."

**취약점별 운용 위험:**

**1. Access Control 취약점**
```solidity
// 취약: 권한 체크 없음
function issue(address to) public { ... }

// 실제 피해: 공격자가 무제한 NFT 발행
// 비즈니스 영향: 포인트 시스템 오염, 고객 신뢰 파괴
// 이 프로젝트: onlyRole(ISSUER_ROLE) + NFTIssuer만 보유
```

**2. Integer Overflow (Solidity ^0.8.0 이전)**
```solidity
// 취약: uint256 overflow
uint256 balance = type(uint256).max;
balance + 1;  // → 0 (overflow)

// 실제 피해: 잔액 계산 오류
// 이 프로젝트: Solidity ^0.8.20 사용 → 자동 revert on overflow
```

**3. Timestamp Dependency**
```solidity
// 취약: block.timestamp를 난수로 사용
uint256 random = uint256(keccak256(abi.encodePacked(block.timestamp)));
// 마이너가 타임스탬프 조작 가능

// 이 프로젝트: 오라클 timestamp는 검증용 (서명으로 위변조 방지)
//             무작위성이 필요한 로직 없음
```

**4. Uninitialized Storage Pointer**
```solidity
// 취약: 초기화되지 않은 구조체가 storage slot 0을 덮어씀
// 이 프로젝트: 모든 state variable은 constructor에서 초기화
```

### 2-2. 이 프로젝트에서 의도적으로 남긴 위험 (20분)

**토킹포인트:**

> "완벽한 보안은 없습니다. 이 프로젝트에서 의도적으로 남긴 위험과 그 이유를 솔직하게 설명하겠습니다."

| 위험 요소 | 내용 | 수용 이유 | Phase에서 해결 |
|---|---|---|---|
| Centralized Oracle | 교보 키 하나가 오라클 서명 | Phase 1 단순성 | Phase 2에서 멀티시그 오라클 |
| InMemory IdempotencyStore | 재시작 시 중복 처리 가능 | 교육용 | Phase 1 운영 시 Redis로 교체 |
| Single PAUSER_ROLE | 담당자 1인 키 분실 시 pause 불가 | Phase 1 단순성 | Phase 2에서 멀티시그 |
| No Rate Limiting | 발행 요청 폭주 대응 없음 | Phase 1 규모 작음 | Phase 2에서 API Gateway 추가 |

---

## 실습 2: 취약점 시나리오 분석 심화 (01:45~02:25)

### 시나리오 A — Front-Running 가능성 검토 (15분)

**개념:**
```
1. 공격자가 mempool에서 issueActivityNFT() 트랜잭션을 발견
2. 더 높은 gas price로 같은 activityId를 먼저 발행 시도
3. 정상 트랜잭션보다 먼저 블록에 포함

결과: 공격자 트랜잭션이 먼저 실행 → 공격자가 NFT 수령?
```

**이 프로젝트에서의 방어 분석:**
```solidity
function issueActivityNFT(
  address to,         // ← 수신자가 함수 파라미터로 고정
  bytes32 activityId,
  ...
) external onlyRole(OPERATOR_ROLE) {
```

> "수신자 주소가 파라미터로 고정되어 있고, `OPERATOR_ROLE`(교보 운영 계정)만 호출 가능합니다. 공격자가 mempool에서 발견해도 자신의 주소로 변경해서 호출할 수 없습니다. 단, 교보 운영 계정이 탈취된 경우는 다른 문제입니다."

### 시나리오 B — Metadata URI 조작 (20분)

**개념:**
```
NFT 메타데이터 URI: ipfs://Qm.../metadata.json
이 JSON에 이미지, 속성 등이 들어있음

취약 케이스: URI가 교보 중앙 서버를 가리키는 경우
→ 서버 관리자가 메타데이터를 임의 변경 가능
→ "걷기 10,000보 달성" NFT가 갑자기 다른 내용으로 변경
```

**이 프로젝트의 현재 방식:**
```typescript
BASE_METADATA_URI=https://meta.kyobo-da.internal/nft
// → 중앙 서버 방식 (Phase 1)
```

**Phase 2+ 개선 방향:**
```
IPFS (분산 저장) 또는 Arweave (영구 저장)
→ URI 변경 불가 → 메타데이터 영구 보존
→ 단점: 발행 후 내용 수정 불가 (버그 수정 어려움)
```

---

## 3부: Private Key 관리 아키텍처 설계 (02:25~03:00)

### 3-1. 키 종류별 관리 방법 (20분)

**토킹포인트:**

> "이 프로젝트에 사용되는 키가 몇 가지인지 파악해봅시다."

```
1. DEPLOYER_PRIVATE_KEY    - 컨트랙트 배포자 (1회성)
2. OPERATOR_PRIVATE_KEY    - NFTIssuer 운영 계정 (상시 사용)
3. ORACLE_SIGNER_ADDRESS   - 오라클 서명 계정 (상시 사용, 교보 백엔드)
4. DEFAULT_ADMIN_ROLE 키   - Role 관리자 (비상시만 사용)
5. PAUSER_ROLE 키          - 비상 정지 담당자 (비상시만 사용)
```

**키별 관리 방식:**

| 키 | 사용 빈도 | 권장 관리 방식 |
|---|---|---|
| DEPLOYER | 1회성 | 배포 후 폐기 또는 Cold Storage |
| OPERATOR | 매 트랜잭션 | KMS (AWS/Azure) → Phase 4: HSM |
| ORACLE | 매 서명 | KMS (교보 백엔드 서버에 주입) |
| ADMIN | 비상시 | 멀티시그 (M-of-N) + Cold Storage |
| PAUSER | 비상시 | 24시간 접근 가능한 담당자 Hot Wallet |

### 3-2. Phase 1 현실적 구현안 (15분)

**토킹포인트:**

> "이상적인 방법은 HSM + MPC지만 Phase 1에서는 현실적인 방법을 써야 합니다."

**Phase 1 현실적 구성:**
```
OPERATOR_PRIVATE_KEY → AWS KMS (Key Management Service)
  - issuer-service가 KMS API로 서명 요청
  - Private key가 서버 메모리에 존재하지 않음
  - AWS CloudTrail로 사용 이력 자동 기록

PAUSER_ROLE → 교보 보안팀 담당자 하드웨어 지갑 (Ledger)
  - 비상 시 담당자가 직접 서명
  - 24시간 연락 가능한 on-call 담당자

ADMIN → 3-of-5 멀티시그 (Gnosis Safe)
  - 5명 중 3명이 서명해야 역할 변경 가능
  - 단독 실수/탈취 방지
```

---

## 마무리

**오늘의 핵심 3줄:**
1. ISMS-P 요건은 문서가 아닌 코드로 구현해야 지속 가능하다
2. 취약점은 기술 문제가 아니라 운용 위험이다 — 비즈니스 영향으로 이해해야 한다
3. Phase 1에서는 KMS, Phase 2+에서 HSM/MPC로 진화하는 로드맵을 가져야 한다

**Day 09 예고:**  
ARC/XRP Ledger 개요와 9일 전체 아키텍처 리뷰. Sharon이 Phase 2를 위해 무엇을 먼저 결정해야 하는지.

---

## 참조 파일

- `packages/compliance/src/isms/ISMSChecklist.ts`
- `packages/contracts/src/phase1/NFTIssuer.sol` (ReentrancyGuard)
- `packages/contracts/src/base/BaseToken.sol` (RBAC)
- `.env.example` (키 관리 주석)
- `docs/adr/002-vasp-external-first.md`
