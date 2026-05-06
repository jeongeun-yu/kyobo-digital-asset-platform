# M7 S44 — 업그레이드 시 데이터 손상 원인과 방어 패턴

> 모듈 7 · 세션 44 · 1시간  
> 스켈레톤: `blockchain/src/phase1/KyoboNFT.sol`

> 🔵 **Phase 3 전환 준비** — Phase 1에서는 월렛원이 배포한 컨트랙트를 사용하므로 당사가 직접 감사할 대상이 아니다. 이 세션은 Phase 3에서 당사가 컨트랙트를 직접 배포·운영할 때 필요한 보안 감사 역량을 미리 확보하는 목적이다.

---

## 강의 파트 (25분)

### 0. M7 보안 세션 전체 흐름 요약

```
S41: 공격 벡터 파악 + Slither 실행
  └── HIGH/MEDIUM/LOW 항목 목록 확보

S42: HIGH 항목 제거
  └── tx.origin 제거, ReentrancyGuard 적용, CEI 패턴

S43: MEDIUM 항목 제거
  └── 접근 제어 보완, 이벤트 추가, 가시성 수정
  └── 보안 공격 테스트 전부 PASS

S44: 업그레이드 거버넌스 + 최종 감사 리포트  ← 이번 세션
  └── 다중 서명 절차 이해
  └── 잔여 항목 정리 + 리포트 작성
  └── M7 전체 완료
```

보안은 "한 번 완료"가 아니다. 업그레이드할 때마다 같은 프로세스를 반복한다.

---

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

### 1-1. Gnosis Safe 업그레이드 흐름 — 다이어그램

```
개발자
  │
  │  새 Implementation 배포 (Implementation만, Proxy 아님)
  │  → 새 impl 주소 확보
  ▼
Gnosis Safe UI
  │
  │  upgradeToAndCall(newImpl, initData) 트랜잭션 제안
  │  → Safe에 "pending TX" 등록
  ▼
서명자 1 (VASP 담당자)
  │  트랜잭션 내용 검토 → 서명
  ▼
서명자 2 (교보IT 담당자)
  │  트랜잭션 내용 검토 → 서명
  │  (2-of-3 threshold 도달)
  ▼
Safe.execTransaction() 자동 실행
  │
  ▼
Proxy → Implementation v2 교체 완료
  │
  ▼
온체인 로그: Upgraded(newImpl) 이벤트 기록
  (언제, 누가 서명했는지 영구 기록)
```

서명자 3명 중 2명이면 충분하다. 1명이 키를 분실해도 나머지 2명으로 업그레이드 가능. 1명이 악의적이어도 2명의 동의 없이 단독 실행 불가.

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

### 추가 테스트 — 전체 보안 회귀 테스트

보안 리포트를 작성하기 전에 전체 테스트 스위트를 한 번 더 실행한다.

```bash
# Forge 전체 테스트
forge test -vvv

# 또는 Hardhat
npx hardhat test

# 예상 결과 (M6 + M7 통합)
# ✅ S35: tokenId 인코딩/디코딩 (3건)
# ✅ S36: initialize 재호출 → revert (1건)
# ✅ S37: MINTER_ROLE 없음 → mint revert (2건)
# ✅ S37: mintBatch 500건 가스 측정 (1건)
# ✅ S38: Pause → mint revert (2건)
# ✅ S38: burn → 잔액 감소 (1건)
# ✅ S40: v2 upgrade → 기존 잔액 보존 (1건)
# ✅ S40: reinitializer(2) 이중 호출 → revert (1건)
# ✅ S41: Reentrancy 공격 → ReentrancyGuard 차단 (1건)
# ✅ S42: tx.origin 공격 → msg.sender 체크로 차단 (1건)
# ✅ S43: 전체 보안 공격 시나리오 (7건)
# ✅ S44: Storage Collision → upgradeProxy 에러 (1건)
# ✅ S44: v1 initialize 재호출 → revert (1건)
```

모든 테스트가 PASS한 상태에서 감사 리포트를 작성하고 커밋한다.

---

## M7 완료 기준

- [ ] M7 전체 흐름(S41→S42→S43→S44) 순서 설명 가능
- [ ] Gnosis Safe 2-of-3 업그레이드 흐름 다이어그램 설명 가능
- [ ] Slither HIGH/MEDIUM 최종 0건 확인
- [ ] Storage layout 충돌 없음 (hardhat-upgrades 체크 통과)
- [ ] `reinitializer` 이중 호출 방지 테스트 PASS
- [ ] 전체 테스트 스위트 PASS (M6 + M7 통합)
- [ ] 보안 감사 리포트 작성 완료 (5개 항목 모두 포함)
- [ ] 업그레이드 거버넌스 5단계 절차 설명 가능
- [ ] "왜 개발자 단독으로 upgradeProxy를 실행하면 안 되는가" 설명 가능
