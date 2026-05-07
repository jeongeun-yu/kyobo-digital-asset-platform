# M7 S41 — 스마트컨트랙트 주요 공격 벡터와 정적 분석 방법론

> 모듈 7 · 세션 41 · 1시간  
> 스켈레톤: `blockchain/src/rewards/KyoboNFT.sol`

> 🔵 **Phase 3 전환 준비** — Phase 1에서는 월렛원이 배포한 컨트랙트를 사용하므로 당사가 직접 감사할 대상이 아니다. 이 세션은 Phase 3에서 당사가 컨트랙트를 직접 배포·운영할 때 필요한 보안 감사 역량을 미리 확보하는 목적이다.

---

## 강의 파트 (25분)

### 1. 왜 스마트컨트랙트 보안 감사가 일반 소프트웨어보다 중요한가

일반 백엔드 코드에 버그가 있으면: 패치 배포 → 버그 수정.

스마트컨트랙트에 버그가 있으면:
```
배포된 코드는 수정 불가 (UUPS 업그레이드 전까지)
버그를 악용하기 전에 발견하지 못하면 → 실제 자산 손실 발생
피해를 입은 후 복구 방법: 없음 (블록체인 불가역성)
```

2016년 The DAO 해킹: 재진입 공격으로 이더 360만 개($5,000만) 탈취. 이 사건으로 이더리움이 하드포크됐다.

금융 시스템에서는 더욱 엄격하다. 배포 전에 반드시 보안 감사를 통과해야 한다.

---

### 2. Reentrancy(재진입) 공격 — 가장 고전적이고 위험한 취약점

**원리:**

```
공격 컨트랙트가 KyoboNFT.burn()을 호출
→ KyoboNFT가 외부 컨트랙트(환불 주소)에 이더 전송
→ 전송 중 공격 컨트랙트의 receive() 자동 실행
→ receive() 안에서 KyoboNFT.burn() 재호출
→ 아직 상태가 업데이트 안 됨 → 또 인출 가능
→ 루프 반복 → 자산 전량 탈취
```

구체적 시나리오:

```solidity
// 취약한 컨트랙트 패턴 (KyoboNFT와 같은 구조의 예시)
function burnAndRefund(uint256 tokenId) external {
    uint256 amount = balanceOf(msg.sender, tokenId);

    // ❌ 잘못된 순서: 외부 호출 먼저
    (bool success,) = msg.sender.call{value: amount * PRICE}("");

    // 이 시점에 공격자 컨트랙트가 재진입하면 위의 amount는 아직 차감 안 됨
    _burn(msg.sender, tokenId, amount);  // 너무 늦음
}
```

---

### 3. CEI 패턴 — 재진입 공격의 근본적 해결

**Check-Effects-Interactions 순서:**

```solidity
// ✅ CEI 패턴 적용
function burnAndRefund(uint256 tokenId) external {
    // 1. Check: 잔액 확인
    uint256 amount = balanceOf(msg.sender, tokenId);
    require(amount > 0, "No tokens to burn");

    // 2. Effects: 상태 변경 먼저 (외부 호출 전에)
    _burn(msg.sender, tokenId, amount);  // 잔액 차감

    // 3. Interactions: 외부 호출 나중에
    (bool success,) = msg.sender.call{value: amount * PRICE}("");
    require(success, "Refund failed");
}
```

상태를 먼저 변경한 후 외부를 호출하면, 재진입 시 이미 잔액이 0이므로 추가 인출이 불가능하다.

---

### 4. tx.origin vs msg.sender — 피싱 공격 취약점

```solidity
// ❌ 취약한 코드
function sensitiveOperation() external {
    require(tx.origin == owner, "Not owner");  // tx.origin 사용
    // ...
}
```

`tx.origin`: TX를 최초로 시작한 EOA (항상 사람)
`msg.sender`: 현재 함수를 호출한 주소 (컨트랙트일 수 있음)

**피싱 공격:**

```
1. 피해자가 공격자 컨트랙트의 무관한 함수를 호출 (에어드롭 주장)
2. 공격자 컨트랙트가 내부적으로 KyoboNFT.sensitiveOperation() 호출
3. tx.origin = 피해자 (EOA), 조건 통과
4. 공격자 컨트랙트가 피해자 권한으로 작업 수행
```

`msg.sender`를 써야 하는 이유: 직접 호출한 주체만 확인하면 된다. 중간 컨트랙트를 통한 간접 호출은 `msg.sender`로 차단된다.

---

### 5. Slither — 정적 분석 도구

Slither는 Trail of Bits가 만든 Solidity 정적 분석 도구다. 코드를 실행하지 않고 분석해서 잠재적 취약점을 찾는다.

**심각도 분류:**

| 레벨 | 의미 | 대응 |
|---|---|---|
| HIGH | 자산 손실 가능한 취약점 | 반드시 수정 |
| MEDIUM | 비정상 동작 가능 | 수정 권장 |
| LOW | 모범 사례 위반 | 검토 후 수정 |
| INFORMATIONAL | 스타일, 최적화 제안 | 선택적 |

---

## 실습 파트 (30분)

### Slither 설치

```bash
# Python 환경 필요
pip install slither-analyzer

# 또는 Docker
docker pull trailofbits/eth-security-toolbox
```

### KyoboNFT 정적 분석 실행

```bash
cd blockchain
slither src/phase1/KyoboNFT.sol --config-file slither.config.json

# 예상 출력:
# INFO: Compilation artifacts:
# ...
# [HIGH] ... reentrancy ...
# [MEDIUM] ... access control ...
# [LOW] ... ...
```

### Slither 결과 분류

```bash
# HIGH 항목만 보기
slither src/phase1/KyoboNFT.sol --filter-paths "openzeppelin" --exclude-low

# JSON 형식으로 저장
slither src/phase1/KyoboNFT.sol --json slither-report.json
```

### HIGH 항목 공격 테스트 케이스 작성

```solidity
// test/SecurityTests.sol
contract ReentrancyAttacker {
    KyoboNFT public target;
    uint256 public attackCount;

    constructor(address _target) {
        target = KyoboNFT(_target);
    }

    // burn 호출 후 환불을 받으면 이 함수가 실행됨
    receive() external payable {
        if (attackCount < 3) {
            attackCount++;
            // 재진입 시도
            target.burn(address(this), TARGET_TOKEN_ID, 1);
        }
    }

    function attack(uint256 tokenId) external {
        target.burn(address(this), tokenId, 1);
    }
}

contract SecurityTest is Test {
    function test_reentrancy_burn() public {
        // KyoboNFT에 ReentrancyGuard 없다면 이 테스트가 공격 성공을 보여줌
        ReentrancyAttacker attacker = new ReentrancyAttacker(address(nft));

        // 공격자에게 NFT 발행
        nft.mint(address(attacker), tokenId, 5);

        // 공격 실행 → ReentrancyGuard 없으면 여러 번 burn됨
        attacker.attack(tokenId);

        // ReentrancyGuard 있으면 1회만 burn, 재진입 시도는 revert
        assertEq(nft.balanceOf(address(attacker), tokenId), 4);  // 1개만 소각됨
    }
}
```

---

## 완료 기준

- [ ] Slither 설치 + 실행 완료
- [ ] HIGH/MEDIUM/LOW 분류 결과 정리
- [ ] Reentrancy 공격 원리 설명 가능 (CEI 패턴 포함)
- [ ] HIGH 항목 공격 테스트 케이스 작성
