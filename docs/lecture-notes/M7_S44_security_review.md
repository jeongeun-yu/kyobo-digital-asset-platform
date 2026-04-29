# M7 S44 — 업그레이드 시 데이터 손상 원인과 방어 패턴

> 모듈 7 · 세션 44 · 1시간  
> 스켈레톤: `blockchain/src/phase1/KyoboNFT.sol`

---

## 강의 파트 (15분)

### 1. 업그레이드 거버넌스 — 실무에서 어떻게 하는가

지금까지 배운 것: 코드 수정 → hardhat-upgrades로 배포. 

실제 금융 시스템에서는 훨씬 엄격한 절차가 필요하다.

```
1단계: 테스트넷 검증
   로컬 테스트 → Sepolia 배포 → 기존 데이터 보존 확인
   → 2주 이상 운영 → 문제 없음 확인

2단계: 코드 리뷰
   내부 리뷰 → 외부 감사 (선택적)
   → 변경사항 문서화

3단계: Gnosis Safe 제안 (M8에서 구현)
   upgradeToAndCall() 트랜잭션 제안
   → 서명자 3명에게 알림

4단계: 2-of-3 서명 수집
   VASP + 교보IT + 준법감시 중 2명 서명
   → threshold 도달

5단계: 실행
   Safe.execTransaction() → 업그레이드 실행
   → 감사 로그 자동 기록
```

개발자 혼자 `upgradeProxy()`를 실행할 수 없다. 반드시 2-of-3 승인이 필요하다.

---

### 2. 보안 감사 리포트 작성 — 필수 구성 요소

감사 리포트는 외부 감사인, 규제 기관, 내부 경영진에게 보여줄 문서다.

**필수 항목:**

```
1. 감사 범위
   - 감사한 파일 목록 + 커밋 해시
   - 사용한 도구 (Slither, Echidna 등)
   - 감사 기간

2. 발견된 취약점 목록
   - ID | 심각도 | 제목 | 위치 | 설명 | 수정 방법

3. 적용된 방어 패턴
   - ReentrancyGuard
   - CEI 패턴
   - AccessControl 역할 체계
   - Initializer 보호

4. 잔여 LOW 항목
   - False Positive로 판단한 항목 및 근거
   - 향후 대응 계획

5. 권장 사항
   - MPC 키 관리 전환
   - 퍼징(Fuzzing) 테스트 강화
   - 정기 재감사 주기
```

---

## 실습 파트 (40분)

### 슬롯 순서 변경 실험

```solidity
// KyoboNFTV2_SlotTest.sol — 학습용만, 프로덕션 사용 금지
contract KyoboNFTV2_SlotTest is KyoboNFT {
    // ❌ 기존 슬롯 앞에 변수 삽입 → 충돌 유발
    uint256 private _insertedFirst;
    string private _baseURI;
}
```

테스트:

```typescript
it('slotOrderChange_destroysBalances', async () => {
    const tokenId = await nft.encodeTokenId(1n, 1n);
    await nft.mint(user.address, tokenId, 10);

    // hardhat-upgrades가 슬롯 충돌 감지
    const V2Bad = await ethers.getContractFactory('KyoboNFTV2_SlotTest');
    await expect(
        upgrades.upgradeProxy(proxyAddr, V2Bad),
    ).to.be.rejectedWith(/incompatible/i);
    // → 배포 자체가 차단됨

    // 기존 잔액 보존 (업그레이드 실패했으므로)
    expect(await nft.balanceOf(user.address, tokenId)).to.equal(10n);
});
```

### reinitializer(2) 테스트

```typescript
it('v2 업그레이드 후 v1 initialize 재호출 → revert', async () => {
    const KyoboNFTV2 = await ethers.getContractFactory('KyoboNFTV2');
    const nftV2 = await upgrades.upgradeProxy(proxyAddr, KyoboNFTV2);

    // v2 초기화
    await nftV2.initializeV2("https://api.kyobo.com/", 1000);

    // v1 initialize 재호출 → revert
    await expect(nftV2.initialize(admin.address)).to.be.reverted;

    // v2 initializeV2 재호출 → revert
    await expect(
        nftV2.initializeV2("https://other.com/", 999),
    ).to.be.reverted;
});
```

### M7 보안 리포트 작성

```markdown
# KyoboNFT 보안 감사 리포트
감사 대상: blockchain/src/phase1/KyoboNFT.sol
커밋: [commit-hash]
감사 도구: Slither v0.10.x
감사 일자: 2026-04-28

## 발견된 취약점

### HIGH 항목 (수정 완료)

| ID | 항목 | 위치 | 수정 방법 |
|----|------|------|---------|
| H1 | Reentrancy | burn() | ReentrancyGuard + CEI 패턴 적용 |
| H2 | tx.origin | (없음 확인) | 해당 없음 |

### MEDIUM 항목 (수정 완료)

| ID | 항목 | 위치 | 수정 방법 |
|----|------|------|---------|
| M1 | 이벤트 누락 | updateMaxSupply() | emit 추가 |
| M2 | 가시성 실수 | (없음 확인) | 해당 없음 |

### LOW 항목 (검토)

| ID | 항목 | 위치 | 판단 |
|----|------|------|------|
| L1 | Floating pragma | 파일 헤더 | False Positive — 특정 버전 고정됨 |

## 적용된 방어 패턴

- ReentrancyGuardUpgradeable: burn() 재진입 차단
- CEI 패턴: 상태 변경 후 외부 호출
- AccessControl: MINTER/PAUSER/UPGRADER 역할 분리
- Initializer: 단일 초기화 보장, 직접 접근 차단
- UUPS + _authorizeUpgrade: UPGRADER_ROLE만 업그레이드 가능

## 잔여 LOW 항목

없음 (전부 False Positive로 판단 또는 수정 완료)

## 권장 사항

1. 정기 재감사: 주요 업그레이드 전마다 재실행
2. Fuzzing 테스트 (Echidna): 경계값 자동 탐색
3. MPC 키 관리: Phase 2에서 MINTER 키를 MPC로 전환 권장
4. 업그레이드 거버넌스: M8 Gnosis Safe 2-of-3 서명 절차 준수
```

---

## M7 완료 기준

- [ ] Slither HIGH/MEDIUM 최종 0건
- [ ] Storage layout 충돌 없음
- [ ] reinitializer 이중 호출 방지
- [ ] 보안 리포트 작성 완료
- [ ] 업그레이드 거버넌스 절차 설명 가능
