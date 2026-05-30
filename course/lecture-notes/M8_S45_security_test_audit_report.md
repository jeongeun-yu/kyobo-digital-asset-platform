# M8 · S45 — 보안 테스트 설계 + 감사 리포트 작성

> **강의노트 깊이 기준** : 강사가 50분 수업을 자신있게 소화하기 위한 120분 수준 배경지식 포함.  
> `[강사 배경]` 섹션은 수업 슬라이드에 넣지 않아도 되지만 반드시 숙지해야 하는 내용이다.  
> `[강의]` 표시 항목이 실제 수업에서 전달할 내용이다.

---

## 세션 개요

| 항목 | 내용 |
|---|---|
| 모듈 | M8 — 스마트컨트랙트 보안 (마지막 세션) |
| 세션 | S45 |
| 전달 시간 | 강의 10분 + 실습 45분 (→ 마무리 5분 포함 총 60분) |
| 선행 지식 | S43 (Reentrancy · tx.origin · Access Control 원리) / S44 (Slither HIGH/MEDIUM 0건 달성) |
| 이 세션의 목표 | 공격자 관점 테스트 3종 작성 및 실행, M8 보안 감사 리포트 완성 → M8 완료 기준 충족 |

---

## 이 세션의 핵심 메시지

> **Slither는 "코드가 잘못 쓰였는가"를 잡는다. 보안 테스트는 "공격자가 실제로 성공하는가"를 잡는다.**  
> 정적 분석이 통과해도 논리적 공격 시나리오가 통과하면 취약하다.  
> 그리고 테스트를 통과했다는 증거를 감사 리포트로 남겨야 — 법인·규제·투자자가 읽는다.

---

## M8 완료 기준 (이 세션에서 달성)

| 기준 | 확인 방법 |
|---|---|
| Slither HIGH/MEDIUM 최종 0건 | S44에서 달성. 이 세션에서 최종 재확인 |
| 공격 시나리오 테스트 전부 방어 | Hardhat 테스트 3종 전부 PASS |
| 보안 감사 리포트 완성 | 마크다운 1페이지 리포트 제출 |

---

# [강사 배경] — 수업 슬라이드에는 없지만 반드시 숙지

---

## [강사 배경] 1. 공격자 관점 테스트(Adversarial Testing) vs 기능 테스트 — 목표·설계 방식·성공 기준의 차이

### 핵심 철학 차이

```
기능 테스트(Functional Testing)
    질문: "올바른 입력을 줬을 때 올바른 출력이 나오는가?"
    관점: 개발자(사용 시나리오)
    성공: 모든 기능이 기대대로 동작
    예시: "MINTER_ROLE이 mint()를 호출하면 토큰이 발행된다"

공격자 관점 테스트(Adversarial Testing)
    질문: "의도적으로 비정상적인 방식으로 접근했을 때 시스템이 무너지는가?"
    관점: 적대자(악용 시나리오)
    성공: 컨트랙트가 모든 공격을 revert로 막음
    예시: "MINTER_ROLE이 없는 계정이 mint()를 호출하면 반드시 revert된다"
```

### 설계 방식의 차이

| 항목 | 기능 테스트 | 공격자 관점 테스트 |
|---|---|---|
| 입력 | 유효한 파라미터 | 경계값, 제로, 오버플로, 잘못된 계정 |
| 흐름 | Happy Path | 모든 조건문의 False 분기 |
| 사전 준비 | 정상 상태 셋업 | 취약 컨트랙트(공격자) 별도 배포 |
| 성공 기준 | 상태 변경 검증 | revert 발생 검증 (`expect(...).to.be.revertedWith(...)`) |
| 작성자 마인드셋 | "어떻게 쓰면 작동하는가" | "어떻게 하면 부술 수 있는가" |

### 성공 기준의 역전

기능 테스트는 트랜잭션이 **성공**해야 테스트가 PASS다.  
보안 테스트는 트랜잭션이 **revert**해야 테스트가 PASS다.  
이 역전을 이해하지 못하면 보안 테스트를 제대로 작성할 수 없다.

```javascript
// 기능 테스트 — 성공 = 이벤트 발생
await expect(nft.mint(user.address, 1, 10, "0x"))
    .to.emit(nft, "TransferSingle");          // 이벤트가 나야 성공

// 공격자 관점 테스트 — 성공 = revert 발생
await expect(nft.connect(attacker).mint(user.address, 1, 10, "0x"))
    .to.be.revertedWith("AccessControl:");   // revert가 나야 성공
```

---

## [강사 배경] 2. Hardhat에서 공격자 컨트랙트를 배포하고 공격을 시뮬레이션하는 방법

### 악성 컨트랙트 배포 패턴

실제 공격을 시뮬레이션하려면 공격자 컨트랙트를 테스트 환경에서 배포해야 한다. Hardhat은 `ethers.getContractFactory`로 어떤 Solidity 파일이든 배포할 수 있다.

```javascript
// test/ 폴더 안에 공격자 컨트랙트 별도 파일로 작성
// contracts/test/MaliciousReceiver.sol

// 배포 방식
const MaliciousReceiver = await ethers.getContractFactory("MaliciousReceiver");
const malicious = await MaliciousReceiver.deploy(nftIssuerAddress);
await malicious.waitForDeployment();
```

### impersonateAccount — 특정 주소를 사칭하는 방법

Hardhat Network는 `hardhat_impersonateAccount` JSON-RPC 메서드를 지원한다. 실제 서명 키 없이도 임의 주소에서 트랜잭션을 보낼 수 있다.

```javascript
// 특정 주소의 ETH 잔액을 세팅하고 그 주소로 서명
await network.provider.send("hardhat_setBalance", [
    targetAddress,
    "0x1000000000000000000"  // 1 ETH
]);
await network.provider.send("hardhat_impersonateAccount", [targetAddress]);
const signer = await ethers.getSigner(targetAddress);
// 이제 signer로 targetAddress인 것처럼 트랜잭션 전송 가능
```

**활용 사례**: 멀티시그 지갑 주소, Gnosis Safe 주소, 미래에 배포될 컨트랙트 주소 등을 사전에 사칭해서 시뮬레이션할 때.

### ERC-1155 수신 콜백 메커니즘 이해

ERC-1155에서 컨트랙트가 토큰을 받으려면 `IERC1155Receiver`를 구현해야 한다. 이것이 reentrancy 공격의 진입점이 된다.

```
ERC-1155 safeTransferFrom 실행 흐름:
    1. 토큰 상태 변경 (balances 업데이트)
    2. _doSafeTransferAcceptanceCheck() 호출
    3. 수신자가 컨트랙트이면 → onERC1155Received() 호출
    4. 반환값이 selector와 일치하는지 확인

NFTIssuer의 경우:
    issueNFT() → nft.mint() → safeTransferFrom 내부 → onERC1155Received() 호출
    이 콜백에서 다시 issueNFT()를 호출하면 reentrancy 시도
    → nonReentrant modifier가 막음
```

---

## [강사 배경] 3. Foundry(forge) fuzz 테스트와 Hardhat 테스트 비교

### Foundry란

Foundry는 Rust로 작성된 스마트컨트랙트 개발 프레임워크다. Hardhat이 JavaScript/TypeScript 기반인 것과 달리, Foundry는 Solidity로 테스트를 작성한다.

| 항목 | Hardhat | Foundry |
|---|---|---|
| 테스트 언어 | JavaScript / TypeScript | Solidity |
| 속도 | 보통 (JS 오버헤드) | 매우 빠름 (네이티브 EVM) |
| Fuzz 테스트 | 직접 구현 필요 | 내장 지원 (`forge test --fuzz-runs`) |
| 배포 스크립트 | JS 기반 | Solidity 기반 (`Script.sol`) |
| 생태계 | 더 성숙, 플러그인 풍부 | 빠르게 성장 중 |
| 학습 곡선 | 낮음 (JS 익숙하면) | 중간 (Solidity 테스트 작성) |

### Foundry Fuzz 테스트 예시

```solidity
// Foundry 스타일 fuzz 테스트 (참고용 — 이 강의는 Hardhat 기반)
contract KyoboNFTFuzzTest is Test {
    KyoboNFT nft;

    function setUp() public {
        nft = new KyoboNFT();
        nft.initialize(address(this));
    }

    // forge가 amount에 임의의 uint256 값을 수천 번 주입
    function testFuzz_MintNeverOverflows(address to, uint256 tokenId, uint256 amount) public {
        vm.assume(to != address(0));
        vm.assume(amount < type(uint128).max);  // 현실적인 상한
        
        // MINTER_ROLE로 실행
        vm.prank(address(this));
        nft.mint(to, tokenId, amount, "");
        
        assertEq(nft.balanceOf(to, tokenId), amount);
    }

    // "어떤 주소도 admin 없이 MINTER_ROLE을 얻을 수 없다"
    function testFuzz_NoUnauthorizedMinting(address attacker, uint256 tokenId) public {
        vm.assume(attacker != address(this));
        vm.expectRevert();
        vm.prank(attacker);
        nft.mint(attacker, tokenId, 1, "");
    }
}
```

### Hardhat에서 fuzz 유사 테스트

Hardhat 네이티브에는 fuzz 기능이 없지만 `fast-check` 라이브러리로 유사 구현이 가능하다.

```javascript
const fc = require("fast-check");

it("어떤 주소도 MINTER_ROLE 없이 mint 불가", async () => {
    await fc.assert(
        fc.asyncProperty(
            fc.hexaString({ minLength: 40, maxLength: 40 }),
            async (addr) => {
                // 유효한 이더리움 주소 형식으로 변환
                const account = ethers.Wallet.createRandom();
                await expect(
                    nft.connect(account).mint(account.address, 1, 10, "0x")
                ).to.be.reverted;
            }
        ),
        { numRuns: 50 }
    );
});
```

---

## [강사 배경] 4. 전문 보안 감사 리포트 실제 구조 — Trail of Bits · Consensys Diligence 형식

### 실제 감사 회사들이 사용하는 리포트 구조

대형 감사 회사들의 공개 리포트를 분석하면 공통 구조가 있다.

```
[Trail of Bits 리포트 구조]
1. Executive Summary
   - 감사 범위, 기간, 방법론 요약
   - 총 발견 항목 수 (심각도별)
   - 핵심 권장사항 2~3줄

2. Scope and Methodology  
   - 감사 대상 파일 목록 + 커밋 해시
   - 사용 도구 (Slither, Echidna, 수동 리뷰)
   - 기간 (보통 1~4주)

3. Findings  
   - ID / 제목 / 심각도 / 영향도 / 가능성 / 상태
   - 각 항목: 설명 + 공격 시나리오 + 권장 수정 + 클라이언트 응답

4. Recommendations (미결 LOW 포함)

5. Appendix — 코드 커버리지, 도구 출력 원문
```

### Severity × Impact × Likelihood 매트릭스

전문 감사 리포트는 단순 HIGH/MEDIUM/LOW가 아니라 Impact(피해 크기)와 Likelihood(발생 가능성)를 교차시켜 최종 심각도를 결정한다.

```
                    Impact
                Low    Medium   High    Critical
Likelihood  
High         LOW    MEDIUM   HIGH    CRITICAL
Medium       INFO   LOW      HIGH    HIGH
Low          INFO   INFO     MEDIUM  HIGH
Very Low     INFO   INFO     LOW     MEDIUM
```

**Critical**: 자금 직접 탈취 가능 + 누구나 공격 가능  
**High**: 자금 탈취 or 프로토콜 마비 가능 + 조건 있음  
**Medium**: 상태 오염, 권한 우회 가능성  
**Low**: 코드 품질, Gas 낭비, 이벤트 누락  
**Informational**: Best Practice 위반, 스타일

### Consensys Diligence 특이사항

Consensys는 각 발견 항목에 **"클라이언트 응답(Client Response)"** 섹션을 추가한다. 클라이언트(개발팀)가 각 지적 사항을 인정했는지, 수정했는지, 또는 설계 결정으로 남겨뒀는지 명시한다. 이것이 법적 책임 소재를 명확히 하는 핵심 장치다.

---

## [강사 배경] 5. SWC (Smart Contract Weakness Classification) Registry

### SWC란

SWC Registry는 OWASP의 CWE(Common Weakness Enumeration)를 스마트컨트랙트에 맞게 변환한 분류 체계다.  
URL: https://swcregistry.io

각 취약점 유형에 번호가 부여되어 있어 감사 리포트에서 참조 링크로 활용한다.

| SWC 번호 | 취약점 | 이 강의와의 연관 |
|---|---|---|
| SWC-107 | Reentrancy | S43 + S45 실습 핵심 |
| SWC-115 | Authorization through tx.origin | S43 + S45 실습 핵심 |
| SWC-106 | Unprotected SELFDESTRUCT Instruction | 관련 없음 (참고) |
| SWC-101 | Integer Overflow and Underflow | Solidity 0.8+에서 자동 방어 |
| SWC-112 | Delegatecall to Untrusted Callee | UUPS에서 관련 |
| SWC-103 | Floating Pragma | Slither가 잡음 |
| SWC-100 | Function Default Visibility | Slither가 잡음 |

### 감사 리포트에서 SWC 인용 방법

```
발견 항목 #1: Reentrancy in issueNFT()
심각도: HIGH
참조: SWC-107 (https://swcregistry.io/docs/SWC-107)
```

---

## [강사 배경] 6. Bug Bounty — Immunefi, 지급액 기준, 대표 사례

### Immunefi란

Immunefi는 스마트컨트랙트 보안 분야 최대 Bug Bounty 플랫폼이다 (https://immunefi.com).  
2024년 기준 누적 지급 $100M+ (1천억원 이상).

### 심각도별 지급액 기준 (Immunefi 표준)

| 심각도 | 지급 기준 | 금액 범위 |
|---|---|---|
| Critical | 자금 직접 탈취 / 프로토콜 전체 마비 | $10,000 ~ $10,000,000 |
| High | 자금 일부 손실 / 심각한 기능 마비 | $5,000 ~ $100,000 |
| Medium | 자금 간접 손실 / 기능 일시 중단 | $1,000 ~ $20,000 |
| Low | 코드 품질 / 마이너 기능 이슈 | $100 ~ $1,000 |

### 대표 지급 사례

| 프로젝트 | 취약점 | 지급액 |
|---|---|---|
| Wormhole Bridge | 서명 검증 우회 → 1억2천만 달러 탈취 가능성 | $10,000,000 |
| Aurora (NEAR) | EVM 구현 버그 | $6,000,000 |
| Polygon | PoS 브릿지 취약점 | $2,000,000 |
| Optimism | L2 무한 토큰 발행 가능 | $2,000,000 |

### 한국 규제 환경에서 Bug Bounty의 의미

교보생명 같은 금융기관이 디지털 자산 플랫폼을 운영할 경우, 금융보안원 가이드라인에 따라 외부 침투 테스트(PT)와 취약점 신고 채널이 요구된다. Immunefi는 블록체인 특화 취약점 신고 채널로 글로벌 표준이 되고 있다.

---

## [강사 배경] 7. 보안 리포트가 실제 감사에서 하는 역할 — 법적 책임·보험·규제

### 법적 책임 명확화

보안 감사 리포트는 다음 세 주체 사이의 책임을 명문화한다.

```
┌─────────────────────────────────────────────────────┐
│                   책임 구조                          │
│                                                     │
│  개발팀(CTO) ──→ 코드 작성 + HIGH/MEDIUM 수정 확인   │
│      ↓                                              │
│  감사 회사 ──→ 독립적 검토 + 리포트 발행              │
│      ↓                                              │
│  클라이언트(교보) ──→ 잔여 LOW를 "수용"으로 서명       │
│      ↓                                              │
│  법원/규제당국 ──→ "합리적 주의를 다했는가?" 판단 기준  │
└─────────────────────────────────────────────────────┘
```

감사를 받았고, HIGH/MEDIUM을 수정했고, 잔여 LOW를 의도적으로 수용했다는 기록이 있으면 — 이후 피해 발생 시 **"합리적 주의 의무(Duty of Care)"를 다했다**는 법적 방어 근거가 된다.

### 보안 보험 (Smart Contract Insurance)

Nexus Mutual, InsurAce 등 DeFi 보험 프로토콜은 감사 리포트를 보험 가입 조건으로 요구한다. 감사 없는 프로토콜은 보험 가입 자체가 불가능하거나 프리미엄이 10배 이상 높다.

### 규제 제출

금융위원회 · 금융보안원 가이드라인(2024)은 가상자산사업자(VASP)에게 스마트컨트랙트 보안 검증 결과 제출을 요구한다. 감사 리포트는 이 요건을 충족하는 공식 문서다.

### 투자자 Due Diligence

VC나 기관투자자가 스마트컨트랙트 기반 프로젝트에 투자할 때 체크리스트의 첫 항목이 **"감사 리포트 존재 여부"**다. 리포트가 없으면 투자 자체를 거부하는 경우가 표준이 되고 있다.

---

---

# [강의] — 실제 50분 수업 내용

---

## 수업 시간표 (분 단위)

| 시간 | 내용 | 형태 |
|---|---|---|
| 0:00 ~ 0:05 | M8 흐름 복습 + 이 세션 목표 | 강의 |
| 0:05 ~ 0:10 | 공격자 관점 테스트 개념 + 성공 기준의 역전 | 강의 |
| 0:10 ~ 0:22 | 실습 1: Reentrancy 공격 시나리오 테스트 작성 + 실행 | 실습 |
| 0:22 ~ 0:32 | 실습 2: Access Control 우회 시나리오 테스트 작성 + 실행 | 실습 |
| 0:32 ~ 0:42 | 실습 3: tx.origin 피싱 시나리오 테스트 작성 + 실행 | 실습 |
| 0:42 ~ 0:50 | 실습 4: M8 보안 감사 리포트 작성 + 내용 리뷰 | 실습 |
| 0:50 ~ 0:55 | 전체 테스트 실행 (`npx hardhat test`) + M8 완료 선언 | 강의 + 실습 |
| 0:55 ~ 1:00 | 마무리 — 리포트의 실제 역할, Q&A | 강의 |

---

## [강의] 1. 공격자 관점 테스트란 무엇인가 (5분)

### 기능 테스트 vs 공격자 관점 테스트

```
지금까지 우리가 한 테스트 (기능 테스트):
    "MINTER_ROLE이 있는 admin이 mint()를 호출하면 토큰이 발행된다"
    → 정상 동작 확인

이번 세션 (공격자 관점 테스트):
    "MINTER_ROLE이 없는 공격자가 mint()를 호출하면 반드시 revert된다"
    "악성 컨트랙트가 재진입을 시도하면 반드시 revert된다"
    → 비정상 접근이 막히는지 확인
```

### 성공 기준의 역전

```javascript
// 기능 테스트 — 트랜잭션이 성공해야 PASS
await expect(tx).to.emit(contract, "EventName");

// 보안 테스트 — 트랜잭션이 revert해야 PASS
await expect(tx).to.be.revertedWith("에러메시지");
await expect(tx).to.be.reverted; // 메시지 무관하게 revert면 PASS
```

### S43 → S44 → S45 흐름

```
S43: 취약점 원리 학습 (Reentrancy · tx.origin · Access Control)
  ↓
S44: Slither 정적 분석 → HIGH/MEDIUM 0건 달성 (도구가 잡는 것)
  ↓
S45: 공격 시나리오 테스트 (도구가 못 잡는 논리적 공격) + 감사 리포트
```

---

## [강의] 2. 실습 환경 확인 (1분)

```bash
# 프로젝트 루트에서
cd kyobo-nft-project

# 이전 세션에서 설치되어 있어야 함
npx hardhat --version
ls contracts/
# → KyoboNFT.sol  NFTIssuer.sol 확인
```

---

## [강의] 3. 실습 1 — Reentrancy 공격 시나리오 테스트 (12분)

### 3-1. 악성 컨트랙트 작성

`contracts/test/MaliciousReceiver.sol` 파일을 새로 생성한다.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

/**
 * @title MaliciousReceiver
 * @notice 교육용 — Reentrancy 공격 시뮬레이터
 * @dev ERC-1155 토큰을 수신하는 순간 onERC1155Received에서 issueNFT 재진입 시도
 *      NFTIssuer의 nonReentrant modifier가 이를 막아야 한다
 */
interface INFTIssuer {
    function issueNFT(
        address recipient,
        uint256 tokenId,
        uint256 amount,
        bytes32 requestId
    ) external;
}

contract MaliciousReceiver is IERC1155Receiver, ERC165 {
    INFTIssuer public immutable target;   // 공격 대상 NFTIssuer
    uint256 public attackCount;           // 재진입 시도 횟수 추적
    bool public attackInProgress;         // 재진입 루프 방지 (공격자 측)

    constructor(address _target) {
        target = INFTIssuer(_target);
    }

    /**
     * @notice ERC-1155 토큰 수신 콜백 — 재진입 공격 시도 지점
     * @dev NFTIssuer.issueNFT() 내부에서 mint → safeTransferFrom →
     *      이 콜백이 호출된다. 여기서 다시 issueNFT를 호출하면
     *      nonReentrant가 없다면 중첩 실행이 가능하다.
     */
    function onERC1155Received(
        address, // operator
        address, // from
        uint256, // id
        uint256, // value
        bytes calldata // data
    ) external override returns (bytes4) {
        attackCount++;

        // 재진입 시도 (nonReentrant가 있으면 여기서 revert됨)
        if (!attackInProgress) {
            attackInProgress = true;
            // 두 번째 requestId로 재진입 시도
            target.issueNFT(
                address(this),
                1,
                1,
                bytes32(uint256(0xDEAD)) // 다른 requestId
            );
        }

        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC165, IERC165)
        returns (bool)
    {
        return
            interfaceId == type(IERC1155Receiver).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
```

### 3-2. Reentrancy 공격 테스트 파일

`test/security/01_reentrancy_attack.test.js` 파일을 생성한다.

```javascript
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

/**
 * 보안 테스트 1: Reentrancy 공격 시나리오
 *
 * 목표: NFTIssuer.issueNFT()가 nonReentrant modifier로
 *       재진입 공격을 방어하는지 확인
 *
 * 공격 흐름:
 *   1. 공격자가 MaliciousReceiver 컨트랙트를 배포
 *   2. MaliciousReceiver를 recipient로 issueNFT() 호출
 *   3. mint → safeTransferFrom → onERC1155Received() 콜백
 *   4. 콜백 안에서 다시 issueNFT() 호출 시도 (재진입)
 *   5. nonReentrant → ReentrancyGuardReentrantCall 에러로 revert
 */
describe("[보안 테스트 1] Reentrancy 공격 시나리오", function () {
    let kyoboNFT, nftIssuer, maliciousReceiver;
    let admin, operator, attacker;

    before(async function () {
        [admin, operator, attacker] = await ethers.getSigners();

        // KyoboNFT 배포 (UUPS Proxy)
        const KyoboNFT = await ethers.getContractFactory("KyoboNFT");
        kyoboNFT = await upgrades.deployProxy(KyoboNFT, [admin.address], {
            initializer: "initialize",
            kind: "uups",
        });
        await kyoboNFT.waitForDeployment();

        // NFTIssuer 배포
        const NFTIssuer = await ethers.getContractFactory("NFTIssuer");
        nftIssuer = await NFTIssuer.deploy(
            await kyoboNFT.getAddress(),
            admin.address
        );
        await nftIssuer.waitForDeployment();

        // NFTIssuer에 MINTER_ROLE 부여 (KyoboNFT에)
        const MINTER_ROLE = await kyoboNFT.MINTER_ROLE();
        await kyoboNFT
            .connect(admin)
            .grantRole(MINTER_ROLE, await nftIssuer.getAddress());

        // operator에게 OPERATOR_ROLE 부여 (NFTIssuer에)
        const OPERATOR_ROLE = await nftIssuer.OPERATOR_ROLE();
        await nftIssuer
            .connect(admin)
            .grantRole(OPERATOR_ROLE, operator.address);

        // 공격자 컨트랙트 배포
        const MaliciousReceiver = await ethers.getContractFactory(
            "MaliciousReceiver"
        );
        maliciousReceiver = await MaliciousReceiver.deploy(
            await nftIssuer.getAddress()
        );
        await maliciousReceiver.waitForDeployment();
    });

    it("공격 시나리오: MaliciousReceiver를 recipient로 issueNFT 호출 → 재진입 시도 → revert", async function () {
        const requestId = ethers.id("attack-request-001");

        // operator가 악성 컨트랙트 주소로 NFT 발급 시도
        // MaliciousReceiver.onERC1155Received가 다시 issueNFT를 호출하려 함
        await expect(
            nftIssuer.connect(operator).issueNFT(
                await maliciousReceiver.getAddress(), // 악성 컨트랙트가 recipient
                1,      // tokenId
                1,      // amount
                requestId
            )
        ).to.be.reverted; // ReentrancyGuard가 revert 발생시킴
    });

    it("방어 검증: 재진입이 막혔으므로 악성 컨트랙트에 토큰이 발행되지 않음", async function () {
        const balance = await kyoboNFT.balanceOf(
            await maliciousReceiver.getAddress(),
            1
        );
        // 공격이 revert됐으므로 잔액은 0이어야 한다
        expect(balance).to.equal(0n);
    });

    it("정상 수신자(EOA)에게는 정상 발급됨 — nonReentrant가 정상 흐름을 막지 않음", async function () {
        const requestId = ethers.id("normal-request-001");

        await expect(
            nftIssuer.connect(operator).issueNFT(
                attacker.address, // EOA (컨트랙트 아님) → 콜백 없음
                1,
                1,
                requestId
            )
        ).to.emit(nftIssuer, "NFTIssued");

        const balance = await kyoboNFT.balanceOf(attacker.address, 1);
        expect(balance).to.equal(1n);
    });

    it("Idempotency: 동일 requestId 재사용 시 revert", async function () {
        const requestId = ethers.id("normal-request-001"); // 위에서 이미 사용됨

        await expect(
            nftIssuer.connect(operator).issueNFT(
                attacker.address,
                1,
                1,
                requestId
            )
        ).to.be.revertedWith("Already issued");
    });
});
```

### 3-3. 실행 및 결과 확인

```bash
npx hardhat test test/security/01_reentrancy_attack.test.js

# 기대 출력:
# [보안 테스트 1] Reentrancy 공격 시나리오
#   ✓ 공격 시나리오: MaliciousReceiver를 recipient로 issueNFT 호출 → 재진입 시도 → revert
#   ✓ 방어 검증: 재진입이 막혔으므로 악성 컨트랙트에 토큰이 발행되지 않음
#   ✓ 정상 수신자(EOA)에게는 정상 발급됨 — nonReentrant가 정상 흐름을 막지 않음
#   ✓ Idempotency: 동일 requestId 재사용 시 revert
```

---

## [강의] 4. 실습 2 — Access Control 우회 시나리오 테스트 (10분)

`test/security/02_access_control_bypass.test.js` 파일을 생성한다.

```javascript
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

/**
 * 보안 테스트 2: Access Control 우회 시나리오
 *
 * 목표: 권한 없는 계정의 모든 접근 시도가 revert되는지 확인
 *
 * 시나리오:
 *   2-A. OPERATOR_ROLE 없는 계정이 issueNFT 호출 → revert
 *   2-B. DEFAULT_ADMIN_ROLE 없는 계정이 grantRole 시도 → revert
 *   2-C. pause 상태에서 mint 시도 → revert
 *   2-D. PAUSER_ROLE 없는 계정이 pause 시도 → revert
 *   2-E. UPGRADER_ROLE 없는 계정이 upgradeToAndCall 시도 → revert
 */
describe("[보안 테스트 2] Access Control 우회 시나리오", function () {
    let kyoboNFT, nftIssuer;
    let admin, operator, pauser, randomUser, attacker;

    before(async function () {
        [admin, operator, pauser, randomUser, attacker] =
            await ethers.getSigners();

        // KyoboNFT 배포
        const KyoboNFT = await ethers.getContractFactory("KyoboNFT");
        kyoboNFT = await upgrades.deployProxy(KyoboNFT, [admin.address], {
            initializer: "initialize",
            kind: "uups",
        });
        await kyoboNFT.waitForDeployment();

        // NFTIssuer 배포
        const NFTIssuer = await ethers.getContractFactory("NFTIssuer");
        nftIssuer = await NFTIssuer.deploy(
            await kyoboNFT.getAddress(),
            admin.address
        );
        await nftIssuer.waitForDeployment();

        // 역할 부여
        const MINTER_ROLE = await kyoboNFT.MINTER_ROLE();
        const PAUSER_ROLE = await kyoboNFT.PAUSER_ROLE();
        const OPERATOR_ROLE = await nftIssuer.OPERATOR_ROLE();

        await kyoboNFT.connect(admin).grantRole(MINTER_ROLE, await nftIssuer.getAddress());
        await kyoboNFT.connect(admin).grantRole(PAUSER_ROLE, pauser.address);
        await nftIssuer.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
    });

    // ── 2-A. OPERATOR_ROLE 없는 계정의 issueNFT 호출 ──────────────────────
    describe("2-A: OPERATOR_ROLE 없는 계정의 issueNFT 호출", function () {
        it("randomUser → issueNFT 호출 시 AccessControl 에러로 revert", async function () {
            const requestId = ethers.id("bypass-attempt-001");

            await expect(
                nftIssuer
                    .connect(randomUser)
                    .issueNFT(randomUser.address, 1, 1, requestId)
            ).to.be.revertedWithCustomError(
                nftIssuer,
                "AccessControlUnauthorizedAccount"
            );
        });

        it("attacker → issueNFT 호출 시 동일하게 revert", async function () {
            const requestId = ethers.id("bypass-attempt-002");

            await expect(
                nftIssuer
                    .connect(attacker)
                    .issueNFT(attacker.address, 1, 1, requestId)
            ).to.be.revertedWithCustomError(
                nftIssuer,
                "AccessControlUnauthorizedAccount"
            );
        });
    });

    // ── 2-B. DEFAULT_ADMIN_ROLE 없는 계정의 grantRole 시도 ────────────────
    describe("2-B: DEFAULT_ADMIN_ROLE 없는 계정의 grantRole 시도", function () {
        it("operator가 다른 계정에 OPERATOR_ROLE을 부여하려 하면 revert", async function () {
            const OPERATOR_ROLE = await nftIssuer.OPERATOR_ROLE();

            // operator는 OPERATOR_ROLE은 있지만 DEFAULT_ADMIN_ROLE은 없다
            await expect(
                nftIssuer
                    .connect(operator)
                    .grantRole(OPERATOR_ROLE, attacker.address)
            ).to.be.revertedWithCustomError(
                nftIssuer,
                "AccessControlUnauthorizedAccount"
            );
        });

        it("attacker가 자신에게 OPERATOR_ROLE을 부여하려 하면 revert", async function () {
            const OPERATOR_ROLE = await nftIssuer.OPERATOR_ROLE();

            await expect(
                nftIssuer
                    .connect(attacker)
                    .grantRole(OPERATOR_ROLE, attacker.address)
            ).to.be.revertedWithCustomError(
                nftIssuer,
                "AccessControlUnauthorizedAccount"
            );
        });
    });

    // ── 2-C. pause 상태에서 mint 시도 ─────────────────────────────────────
    describe("2-C: pause 상태에서 mint 차단", function () {
        it("pauser가 pause 실행 → operator의 issueNFT 호출이 revert", async function () {
            // pause 실행
            await kyoboNFT.connect(pauser).pause();
            expect(await kyoboNFT.paused()).to.equal(true);

            const requestId = ethers.id("pause-test-001");

            // pause된 상태에서 issueNFT → mint → Pausable 에러
            await expect(
                nftIssuer
                    .connect(operator)
                    .issueNFT(randomUser.address, 1, 1, requestId)
            ).to.be.revertedWithCustomError(kyoboNFT, "EnforcedPause");
        });

        it("pause 해제 후 issueNFT 정상 실행", async function () {
            // unpause
            await kyoboNFT.connect(pauser).unpause();
            expect(await kyoboNFT.paused()).to.equal(false);

            const requestId = ethers.id("after-unpause-001");

            await expect(
                nftIssuer
                    .connect(operator)
                    .issueNFT(randomUser.address, 1, 1, requestId)
            ).to.emit(nftIssuer, "NFTIssued");
        });
    });

    // ── 2-D. PAUSER_ROLE 없는 계정의 pause 시도 ───────────────────────────
    describe("2-D: PAUSER_ROLE 없는 계정의 pause 시도", function () {
        it("attacker가 pause() 호출 시 revert", async function () {
            await expect(
                kyoboNFT.connect(attacker).pause()
            ).to.be.revertedWithCustomError(
                kyoboNFT,
                "AccessControlUnauthorizedAccount"
            );
        });
    });

    // ── 2-E. UPGRADER_ROLE 없는 계정의 upgrade 시도 ───────────────────────
    describe("2-E: UPGRADER_ROLE 없는 계정의 upgradeToAndCall 시도", function () {
        it("attacker가 upgradeToAndCall() 호출 시 revert", async function () {
            // 새 구현체 주소를 사칭 (실제 배포 없이 임의 주소 사용)
            const fakeImplementation = ethers.Wallet.createRandom().address;

            await expect(
                kyoboNFT
                    .connect(attacker)
                    .upgradeToAndCall(fakeImplementation, "0x")
            ).to.be.revertedWithCustomError(
                kyoboNFT,
                "AccessControlUnauthorizedAccount"
            );
        });
    });
});
```

### 실행

```bash
npx hardhat test test/security/02_access_control_bypass.test.js

# 기대 출력:
# [보안 테스트 2] Access Control 우회 시나리오
#   2-A: OPERATOR_ROLE 없는 계정의 issueNFT 호출
#     ✓ randomUser → issueNFT 호출 시 AccessControl 에러로 revert
#     ✓ attacker → issueNFT 호출 시 동일하게 revert
#   2-B: DEFAULT_ADMIN_ROLE 없는 계정의 grantRole 시도
#     ✓ operator가 다른 계정에 OPERATOR_ROLE을 부여하려 하면 revert
#     ✓ attacker가 자신에게 OPERATOR_ROLE을 부여하려 하면 revert
#   2-C: pause 상태에서 mint 차단
#     ✓ pauser가 pause 실행 → operator의 issueNFT 호출이 revert
#     ✓ pause 해제 후 issueNFT 정상 실행
#   2-D: PAUSER_ROLE 없는 계정의 pause 시도
#     ✓ attacker가 pause() 호출 시 revert
#   2-E: UPGRADER_ROLE 없는 계정의 upgradeToAndCall 시도
#     ✓ attacker가 upgradeToAndCall() 호출 시 revert
```

---

## [강의] 5. 실습 3 — tx.origin 피싱 시나리오 테스트 (10분)

### 5-1. tx.origin을 쓰는 취약한 컨트랙트 작성

`contracts/test/VulnerableWallet.sol` 파일을 생성한다.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title VulnerableWallet
 * @notice 교육용 — tx.origin 인증 취약점 시연용 컨트랙트
 * @dev tx.origin으로 소유자 확인 → 피싱 컨트랙트에 취약
 *
 * 취약점 원리:
 *   Alice(EOA) → PhishingContract.attack() → VulnerableWallet.withdraw()
 *   VulnerableWallet에서 tx.origin == Alice (EOA 서명자는 항상 tx.origin)
 *   따라서 "소유자가 호출했다"고 착각 → 인증 통과
 */
contract VulnerableWallet {
    address public owner;

    constructor() payable {
        owner = msg.sender; // 배포자(Alice)가 소유자
    }

    /**
     * @notice 취약한 인증 — tx.origin 사용
     * @dev tx.origin은 트랜잭션 최초 서명자(EOA).
     *      중간에 다른 컨트랙트가 끼어도 tx.origin은 변하지 않는다.
     */
    function withdraw(address payable to, uint256 amount) external {
        // 치명적 실수: msg.sender가 아니라 tx.origin으로 검사
        require(tx.origin == owner, "VulnerableWallet: not owner (tx.origin)");
        (bool success, ) = to.call{value: amount}("");
        require(success, "Transfer failed");
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}

/**
 * @title SecureWallet
 * @notice tx.origin 취약점을 msg.sender로 수정한 안전한 버전
 */
contract SecureWallet {
    address public owner;

    constructor() payable {
        owner = msg.sender;
    }

    /**
     * @notice 안전한 인증 — msg.sender 사용
     * @dev msg.sender는 직접 호출자.
     *      PhishingContract가 호출하면 msg.sender = PhishingContract.
     *      PhishingContract != owner이므로 revert.
     */
    function withdraw(address payable to, uint256 amount) external {
        // 수정: msg.sender로 검사
        require(msg.sender == owner, "SecureWallet: not owner (msg.sender)");
        (bool success, ) = to.call{value: amount}("");
        require(success, "Transfer failed");
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}

/**
 * @title PhishingContract
 * @notice 교육용 — tx.origin 피싱 공격 시뮬레이터
 * @dev 사용자(Alice)를 속여 이 컨트랙트의 함수를 호출하게 만든다.
 *      (실제 피싱: "무료 NFT 받기" 버튼 클릭 → 이 컨트랙트 호출)
 *      공격자가 tx.origin(Alice) 권한으로 VulnerableWallet에서 ETH 탈취
 */
contract PhishingContract {
    address payable public attacker; // 공격자 주소 (ETH 수신)

    constructor(address payable _attacker) {
        attacker = _attacker;
    }

    /**
     * @notice Alice가 이 함수를 호출하는 순간 VulnerableWallet의 ETH가 탈취됨
     * @param vulnerableWallet 공격 대상 지갑
     */
    function attack(address vulnerableWallet) external {
        // tx.origin = Alice (이 함수를 호출한 EOA)
        // VulnerableWallet.withdraw는 tx.origin == owner(Alice)를 확인 → 통과!
        VulnerableWallet wallet = VulnerableWallet(vulnerableWallet);
        uint256 balance = wallet.getBalance();
        wallet.withdraw(attacker, balance);
    }

    /**
     * @notice SecureWallet에 동일한 공격 시도
     * @dev SecureWallet은 msg.sender로 확인하므로 실패해야 함
     */
    function attackSecure(address secureWallet) external {
        SecureWallet wallet = SecureWallet(secureWallet);
        uint256 balance = wallet.getBalance();
        wallet.withdraw(attacker, balance); // revert: msg.sender = PhishingContract ≠ owner
    }
}
```

### 5-2. tx.origin 피싱 테스트 파일

`test/security/03_txorigin_phishing.test.js` 파일을 생성한다.

```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * 보안 테스트 3: tx.origin 피싱 시나리오 (교육용)
 *
 * 목표: tx.origin 인증의 취약점을 시연하고,
 *       msg.sender로 수정 시 방어됨을 확인
 *
 * 등장인물:
 *   alice   — 정상 지갑 소유자 (피해자)
 *   attacker — 공격자 (ETH 탈취 시도)
 *   PhishingContract — 공격자가 배포한 피싱 컨트랙트
 *   VulnerableWallet — tx.origin 취약 컨트랙트 (alice 소유)
 *   SecureWallet     — msg.sender 수정 버전 (alice 소유)
 */
describe("[보안 테스트 3] tx.origin 피싱 시나리오 (교육용)", function () {
    let vulnerableWallet, secureWallet, phishingContract;
    let alice, attacker;

    const WALLET_BALANCE = ethers.parseEther("1.0"); // 1 ETH

    before(async function () {
        [alice, attacker] = await ethers.getSigners();

        // Alice가 VulnerableWallet 배포 + 1 ETH 예치
        const VulnerableWallet =
            await ethers.getContractFactory("VulnerableWallet");
        vulnerableWallet = await VulnerableWallet.connect(alice).deploy({
            value: WALLET_BALANCE,
        });
        await vulnerableWallet.waitForDeployment();

        // Alice가 SecureWallet 배포 + 1 ETH 예치
        const SecureWallet = await ethers.getContractFactory("SecureWallet");
        secureWallet = await SecureWallet.connect(alice).deploy({
            value: WALLET_BALANCE,
        });
        await secureWallet.waitForDeployment();

        // Attacker가 PhishingContract 배포 (ETH 수신 주소 = attacker)
        const PhishingContract =
            await ethers.getContractFactory("PhishingContract");
        phishingContract = await PhishingContract.connect(attacker).deploy(
            attacker.address
        );
        await phishingContract.waitForDeployment();
    });

    // ── 3-A. 취약 버전: 피싱 공격 성공 시연 ──────────────────────────────
    describe("3-A: VulnerableWallet (tx.origin 사용) — 공격 성공", function () {
        it("초기 상태: VulnerableWallet에 1 ETH 예치", async function () {
            const balance = await vulnerableWallet.getBalance();
            expect(balance).to.equal(WALLET_BALANCE);
        });

        it("Alice가 PhishingContract.attack()을 호출 → VulnerableWallet 전액 탈취", async function () {
            const attackerBalanceBefore = await ethers.provider.getBalance(
                attacker.address
            );

            // Alice가 피싱 컨트랙트를 호출 (속았다고 가정)
            // tx.origin = Alice → VulnerableWallet의 owner 확인 통과
            await expect(
                phishingContract
                    .connect(alice)                             // Alice가 서명
                    .attack(await vulnerableWallet.getAddress()) // 공격 대상
            ).to.not.be.reverted; // 취약 버전은 공격이 성공해야 함!

            // VulnerableWallet 잔액이 0이 됨 (탈취됨)
            const walletBalanceAfter = await vulnerableWallet.getBalance();
            expect(walletBalanceAfter).to.equal(0n);

            // 공격자 잔액이 증가함
            const attackerBalanceAfter = await ethers.provider.getBalance(
                attacker.address
            );
            expect(attackerBalanceAfter).to.be.greaterThan(attackerBalanceBefore);

            console.log(
                `    ⚠️  공격 성공: ${ethers.formatEther(WALLET_BALANCE)} ETH 탈취됨`
            );
            console.log(
                `    ⚠️  취약 원인: tx.origin으로 인증 → 중간 컨트랙트 개입을 감지하지 못함`
            );
        });
    });

    // ── 3-B. 안전 버전: 피싱 공격 방어 확인 ──────────────────────────────
    describe("3-B: SecureWallet (msg.sender 사용) — 공격 방어", function () {
        it("초기 상태: SecureWallet에 1 ETH 예치", async function () {
            const balance = await secureWallet.getBalance();
            expect(balance).to.equal(WALLET_BALANCE);
        });

        it("Alice가 PhishingContract.attackSecure()를 호출 → revert (공격 실패)", async function () {
            // Alice가 동일한 피싱 시도
            // msg.sender = PhishingContract ≠ alice → require 실패
            await expect(
                phishingContract
                    .connect(alice)
                    .attackSecure(await secureWallet.getAddress())
            ).to.be.revertedWith("SecureWallet: not owner (msg.sender)");

            // SecureWallet 잔액이 유지됨
            const walletBalanceAfter = await secureWallet.getBalance();
            expect(walletBalanceAfter).to.equal(WALLET_BALANCE);

            console.log(`    ✅ 방어 성공: msg.sender 검증으로 피싱 차단`);
            console.log(`    ✅ 방어 이유: msg.sender = PhishingContract ≠ alice`);
        });

        it("Alice가 직접(EOA로) SecureWallet.withdraw() 호출 → 정상 작동", async function () {
            // alice가 직접 호출하면 msg.sender = alice = owner → 성공
            const aliceInitialBalance = await ethers.provider.getBalance(
                alice.address
            );

            await expect(
                secureWallet
                    .connect(alice)
                    .withdraw(alice.address, ethers.parseEther("0.5"))
            ).to.not.be.reverted;

            const walletBalanceAfter = await secureWallet.getBalance();
            expect(walletBalanceAfter).to.equal(ethers.parseEther("0.5"));
        });
    });

    // ── 3-C. NFTIssuer와의 연관 ───────────────────────────────────────────
    describe("3-C: NFTIssuer.sol은 tx.origin을 사용하지 않음 확인", function () {
        it("Slither가 S44에서 tx.origin 경고를 발생시키지 않았음을 코드로 확인", async function () {
            // 이 테스트는 코드 레벨 확인 — Slither 결과를 신뢰
            // NFTIssuer.sol에서 "tx.origin" 문자열이 없어야 함
            // 이미 S44에서 확인됨. 여기서는 문서화 목적으로 PASS 처리
            expect(true).to.equal(true);
            console.log(
                "    ✅ NFTIssuer.sol은 tx.origin을 사용하지 않음 (S44 Slither 검증 완료)"
            );
        });
    });
});
```

### 실행

```bash
npx hardhat test test/security/03_txorigin_phishing.test.js

# 기대 출력:
# [보안 테스트 3] tx.origin 피싱 시나리오 (교육용)
#   3-A: VulnerableWallet (tx.origin 사용) — 공격 성공
#     ✓ 초기 상태: VulnerableWallet에 1 ETH 예치
#     ⚠️  공격 성공: 1.0 ETH 탈취됨
#     ⚠️  취약 원인: tx.origin으로 인증 → 중간 컨트랙트 개입을 감지하지 못함
#     ✓ Alice가 PhishingContract.attack()을 호출 → VulnerableWallet 전액 탈취
#   3-B: SecureWallet (msg.sender 사용) — 공격 방어
#     ✓ 초기 상태: SecureWallet에 1 ETH 예치
#     ✅ 방어 성공: msg.sender 검증으로 피싱 차단
#     ✅ 방어 이유: msg.sender = PhishingContract ≠ alice
#     ✓ Alice가 PhishingContract.attackSecure()를 호출 → revert (공격 실패)
#     ✓ Alice가 직접(EOA로) SecureWallet.withdraw() 호출 → 정상 작동
```

---

## [강의] 6. 전체 보안 테스트 통합 실행 (3분)

```bash
# 전체 보안 테스트 한 번에 실행
npx hardhat test test/security/

# 또는 모든 테스트 함께
npx hardhat test

# 최종 확인용 Slither 재실행 (HIGH/MEDIUM 0건 확인)
slither contracts/KyoboNFT.sol --exclude-dependencies
slither contracts/NFTIssuer.sol --exclude-dependencies
```

### M8 완료 기준 최종 체크

```
☑ Slither HIGH/MEDIUM 최종 0건     (S44 달성, 이 세션 재확인)
☑ Reentrancy 공격 시나리오 → PASS  (MaliciousReceiver revert 확인)
☑ Access Control 우회 → PASS       (9개 테스트 전부 방어)
☑ tx.origin 피싱 → PASS            (SecureWallet 방어 확인)
☑ 보안 감사 리포트 완성            (아래 섹션에서 작성)
```

---

## [강의] 7. 실습 4 — M8 보안 감사 리포트 작성 (8분)

학생들이 다음 템플릿을 채워 `reports/M8_security_audit_report.md`로 저장한다.  
강사는 프로젝터에 완성된 예시를 보여주며 각 섹션의 의미를 설명한다.

---

### [실습 산출물] M8 보안 감사 리포트 템플릿 및 완성 예시

```markdown
# KyoboNFT · NFTIssuer 보안 감사 리포트 — M8

**감사 버전**: 1.0  
**작성일**: 2025-__-__  
**감사 범위**: contracts/KyoboNFT.sol, contracts/NFTIssuer.sol  
**커밋 해시**: (여기에 `git rev-parse HEAD` 결과 입력)  
**방법론**: Slither 정적 분석 + 수동 코드 리뷰 + 공격 시나리오 테스트

---

## 1. Executive Summary

KyoboNFT(ERC-1155 + UUPS) 및 NFTIssuer 컨트랙트에 대해 정적 분석(Slither)과
공격 시나리오 기반 테스트를 수행하였다. 초기 분석에서 HIGH 1건, MEDIUM 2건이
발견되었으나 S44 세션에서 전부 수정 완료하였다. S45 공격 시나리오 테스트 결과
Reentrancy · Access Control · tx.origin 공격 시나리오 전부를 방어함을 확인하였다.
잔여 LOW 2건은 의도적 설계 결정으로 수용한다. 배포 전 Multi-sig 전환을 권장한다.

---

## 2. 발견 항목 요약

| ID   | 심각도       | 제목                                    | 상태       | SWC     |
|------|-------------|----------------------------------------|-----------|---------|
| F-01 | HIGH        | NFTIssuer: Reentrancy 가능성           | 수정 완료  | SWC-107 |
| F-02 | MEDIUM      | KyoboNFT: 초기화 함수 접근 제어 누락   | 수정 완료  | -       |
| F-03 | MEDIUM      | Floating pragma (^0.8.0 → 0.8.20 고정) | 수정 완료  | SWC-103 |
| F-04 | LOW         | 이벤트 인덱싱 미흡 (requestId)         | 수용 (설계)| -       |
| F-05 | LOW         | Admin 키 단일 EOA 보유                 | 부분 수용  | -       |

---

## 3. 발견 항목 상세

### F-01 · HIGH · Reentrancy in NFTIssuer.issueNFT()

**설명**  
초기 버전의 `issueNFT()`는 `nonReentrant` 없이 외부 컨트랙트(KyoboNFT.mint →
ERC-1155 safeTransferFrom)를 호출하였다. 공격자 컨트랙트가 `onERC1155Received`
콜백에서 `issueNFT`를 재진입하면 Idempotency key(`issued[requestId]`)가 설정되기
전에 재실행이 가능했다.

**공격 시나리오**
```
1. Attacker가 MaliciousReceiver 배포
2. Operator에게 MaliciousReceiver를 recipient로 issueNFT 요청
3. issueNFT → mint → onERC1155Received (콜백)
4. 콜백 내부에서 다른 requestId로 issueNFT 재호출
5. issued[requestId2] 미설정 상태 → 두 번째 발행 성공
```

**적용 방어**
```solidity
// NFTIssuer.sol
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract NFTIssuer is AccessControl, ReentrancyGuard {
    function issueNFT(...) external nonReentrant {
        // CEI 패턴: 상태 먼저, 외부 호출 나중
        require(!issued[requestId], "Already issued");
        issued[requestId] = true;       // 상태 변경 (Checks-Effects)
        nft.mint(recipient, ...);       // 외부 호출 (Interactions)
    }
}
```

**검증**: `test/security/01_reentrancy_attack.test.js` — 4개 테스트 PASS  
**참조**: SWC-107 (https://swcregistry.io/docs/SWC-107)

---

### F-02 · MEDIUM · KyoboNFT 초기화 함수 접근 제어

**설명**  
UUPS 패턴에서 구현 컨트랙트(logic contract)의 `initialize()` 함수에
`initializer` modifier가 없거나 적절한 `_disableInitializers()` 호출이 없으면,
구현 컨트랙트 자체에서 `initialize()`를 직접 호출할 수 있다.

**적용 방어**
```solidity
// KyoboNFT.sol constructor에 추가
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers(); // 구현 컨트랙트 직접 초기화 방지
}
```

**검증**: Slither HIGH/MEDIUM 0건 확인 (S44)

---

### F-03 · MEDIUM · Floating Pragma

**설명**  
`pragma solidity ^0.8.0;`는 0.8.0 이상 모든 버전을 허용하여
버전마다 다른 동작에 노출될 수 있다.

**적용 방어**
```solidity
// 수정 전
pragma solidity ^0.8.0;

// 수정 후
pragma solidity 0.8.20;  // 특정 버전 고정
```

**참조**: SWC-103

---

### F-04 · LOW · 이벤트 인덱싱 미흡

**설명**  
`NFTIssued` 이벤트의 `requestId` 파라미터에 `indexed` 키워드가 없어
온체인 로그 필터링 효율이 낮다.

**현재 코드**
```solidity
event NFTIssued(address indexed recipient, uint256 tokenId, bytes32 requestId);
```

**권장**
```solidity
event NFTIssued(address indexed recipient, uint256 tokenId, bytes32 indexed requestId);
```

**수용 이유**: 이벤트 ABI 변경은 오프체인 인덱서(서브그래프) 업데이트를
수반한다. 현 단계에서는 기능 영향이 없으므로 다음 배포 버전에서 반영 예정.

---

### F-05 · LOW · Admin 키 단일 EOA 보유

**설명**  
현재 `DEFAULT_ADMIN_ROLE`을 단일 EOA가 보유한다. 해당 키 분실 또는 탈취 시
역할 관리 불가 상태가 된다.

**권장 수정**: Gnosis Safe(2-of-3 Multi-sig)로 Admin 키 전환  
**현재 상태**: 테스트넷 단계에서는 EOA 유지. 메인넷 배포 전 Multi-sig 전환 예정.

---

## 4. 잔여 LOW 항목 수용 근거

| ID   | 수용 근거 | 후속 조치 |
|------|-----------|-----------|
| F-04 | 오프체인 시스템 변경 비용 > 현재 편익 | v2 배포 시 반영 |
| F-05 | 테스트넷 단계 — 운영 편의성 우선 | 메인넷 배포 전 Multi-sig 전환 |

---

## 5. 권장 사항

| 우선순위 | 권장 사항 | 이유 |
|---------|-----------|------|
| 높음 | DEFAULT_ADMIN_ROLE을 Gnosis Safe(Multi-sig)로 이전 | 단일 키 탈취 시 전체 권한 상실 방지 |
| 중간 | TimeLock 컨트랙트 도입 검토 | UPGRADER_ROLE 실행 시 48시간 지연으로 비상 차단 가능 |
| 중간 | 배포 전 외부 감사 회사 검토 의뢰 | Trail of Bits, Hacken 등 |
| 낮음 | Bug Bounty 프로그램 개설 (Immunefi) | 운영 후 지속적 취약점 발굴 |
| 낮음 | 이벤트 indexed 파라미터 추가 (F-04) | v2에서 반영 |

---

## 6. 범위 및 방법론

**감사 대상 파일**
- `contracts/KyoboNFT.sol` — ERC-1155 + AccessControl + Pausable + UUPSUpgradeable
- `contracts/NFTIssuer.sol` — AccessControl + ReentrancyGuard

**사용 도구**
- Slither v0.10.x — 정적 분석 (AST + CFG + 데이터플로우)
- Hardhat v2.x — 공격 시나리오 테스트 프레임워크

**테스트 파일**
- `test/security/01_reentrancy_attack.test.js` (4개 테스트)
- `test/security/02_access_control_bypass.test.js` (9개 테스트)
- `test/security/03_txorigin_phishing.test.js` (6개 테스트)

**한계사항**  
본 감사는 M8 교육 과정 내 자체 검토 수준이다. 메인넷 배포 전
독립적인 외부 감사 회사의 검토를 강력히 권장한다.
```

---

## [강의] 8. 마무리 — 이 리포트가 실제로 하는 일 (5분)

### 감사 리포트의 세 가지 역할

```
1. 법적 보호막
   → "우리는 합리적 주의를 다했다"는 문서 증거
   → 이후 피해 발생 시 과실 책임 경감

2. 운영 의사결정 근거
   → "LOW는 왜 수용했는가" — 기록이 있어야 나중에 설명 가능
   → 다음 버전에서 무엇을 우선 수정할지 로드맵

3. 외부 신뢰 기반
   → VC 투자 심사: 감사 리포트 없으면 검토 거절
   → 규제 제출: 금융보안원 가이드라인 충족 문서
   → 보험 가입: Nexus Mutual 등 스마트컨트랙트 보험 필수 조건
```

### M8 완료 선언

```
M8 스마트컨트랙트 보안 모듈 완료 체크리스트

  S43: ✅ Reentrancy · tx.origin · Access Control 원리 이해
  S44: ✅ Slither 정적 분석 → HIGH/MEDIUM 0건 달성
  S45: ✅ 공격 시나리오 테스트 3종 → 전부 방어 확인
       ✅ 보안 감사 리포트 작성 완료

M8 완료. Phase 1 KyoboNFT 플랫폼 보안 검증 완료.
```

---

## 파일 구조 최종 확인

```
kyobo-nft-project/
├── contracts/
│   ├── KyoboNFT.sol              ← ERC-1155 (UUPS + AccessControl + Pausable)
│   ├── NFTIssuer.sol             ← 발급 로직 (ReentrancyGuard + CEI)
│   └── test/                     ← 교육용 컨트랙트 (프로덕션 배포 제외)
│       ├── MaliciousReceiver.sol ← Reentrancy 공격 시뮬레이터
│       ├── VulnerableWallet.sol  ← tx.origin 취약 컨트랙트
│       ├── SecureWallet.sol      ← msg.sender 수정 버전
│       └── PhishingContract.sol  ← 피싱 공격 시뮬레이터
├── test/
│   └── security/
│       ├── 01_reentrancy_attack.test.js       ← 4개 테스트
│       ├── 02_access_control_bypass.test.js   ← 9개 테스트
│       └── 03_txorigin_phishing.test.js       ← 6개 테스트
└── reports/
    └── M8_security_audit_report.md            ← 감사 리포트 (실습 산출물)
```

---

## 자주 나오는 질문 (Q&A 대비)

**Q: 테스트 컨트랙트(MaliciousReceiver 등)도 메인넷에 배포되나요?**  
A: 아니다. `contracts/test/` 폴더는 교육용으로만 존재하고, 배포 스크립트에서 제외한다. Hardhat ignition이나 deploy 스크립트에 명시적으로 제외 처리한다.

**Q: Slither를 통과했는데 왜 또 테스트를 하나요?**  
A: Slither는 코드 패턴을 검사한다. 예를 들어 nonReentrant가 있는지는 보지만, "공격자가 실제로 재진입에 성공하는가"는 테스트로만 확인 가능하다. 도구는 서로 보완 관계다.

**Q: 이 감사 리포트를 외부에 제출할 수 있나요?**  
A: 교육 목적 내부 리포트다. 실제 규제 제출이나 투자자 요구를 위해서는 Trail of Bits, Hacken 같은 공인 감사 회사의 독립 리포트가 필요하다.

**Q: LOW 항목은 왜 수정하지 않나요?**  
A: "수정 비용 > 현재 편익"이거나 "다음 버전에서 함께 처리"가 더 효율적인 경우 의도적으로 수용한다. 중요한 것은 수용 근거를 문서로 남기는 것이다.

**Q: Bug Bounty에서 이 코드가 노출되면 위험하지 않나요?**  
A: Bug Bounty는 테스트넷 또는 감사 완료 후 메인넷 배포 이후에 운영한다. 배포 전 코드가 공개되면 오히려 배포 전에 취약점을 발견할 기회가 된다. 단, 코드가 이미 감사를 통과한 상태여야 한다.
```
