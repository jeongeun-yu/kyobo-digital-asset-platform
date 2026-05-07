# M6 S36 — 업그레이드 가능한 컨트랙트 설계 · UUPS 패턴과 Storage Collision

> 모듈 6 · 세션 36 · 1시간  
> 스켈레톤: `blockchain/src/rewards/KyoboNFT.sol` → `initialize()`, `_authorizeUpgrade()`

> 🔵 **Phase 3 전환 준비** — Phase 1에서 스마트 컨트랙트(Solidity 코드 작성·배포·운영)는 **월렛원(VASP)이 담당**한다. 이 세션은 Phase 3에서 당사가 직접 대체할 코드를 미리 학습하는 목적이다. **오너십(Owner Role)은 당사 보유** — 코드를 월렛원이 작성하더라도 컨트랙트 소유권은 당사가 갖는다. 스켈레톤은 최종 Phase 기준으로 설계되어 있다.

---

## 강의 파트 (25분)

### 1. 왜 컨트랙트를 업그레이드해야 하는가

"블록체인 코드는 불변이라고 배웠는데, 왜 업그레이드를 논하는가?"

정확히 말하면: **배포된 컨트랙트의 코드는 변경 불가능하다.** 하지만 Proxy 패턴을 사용하면 "로직 컨트랙트"를 교체하면서 "상태(데이터)는 유지"하는 것이 가능하다.

실제 필요성:

```
시나리오 1: 버그 발견
  KyoboNFT에서 특정 조건에서 NFT가 2배 발행되는 버그 발견
  → 기존 컨트랙트에 사용자 토큰 데이터 있음
  → 새 주소에 재배포하면 기존 토큰이 모두 사라짐
  → Proxy로 로직만 교체 → 데이터 유지

시나리오 2: 규정 변경
  2026년 가상자산 규정이 개정됨 → NFT 전송에 새 검증 단계 추가
  → 기존 사용자 토큰은 그대로 유지하면서 로직 추가
```

---

### 2. Proxy 패턴 동작 원리

```
사용자가 0xPROXY 주소로 mint() 호출
         │
         ▼
    [Proxy Contract]
    ─ 상태(storage) 보관: _balances, _roles, ...
    ─ delegatecall → Implementation 주소로 전달
         │ delegatecall
         ▼
    [Implementation Contract v1]
    ─ 코드(logic)만 있음
    ─ 실행은 Proxy의 storage context에서 이뤄짐
```

`delegatecall`의 핵심: **코드는 Implementation에서 가져오지만, 상태 변경은 Proxy의 storage에 일어난다.**

업그레이드 시:
```
Proxy → Implementation v1 (버그 있음)

        ↓ upgradeToAndCall()

Proxy → Implementation v2 (버그 수정)
```

Proxy 주소는 변경 없다. 사용자는 아무것도 바꾸지 않아도 된다.

---

### 3. 투명 프록시 vs UUPS — 어디에 업그레이드 함수가 있는가

| 구분 | 투명 프록시 (Transparent) | UUPS |
|---|---|---|
| 업그레이드 함수 위치 | Proxy Contract | Implementation Contract |
| 가스 오버헤드 | 높음 (모든 호출마다 admin 체크) | 낮음 |
| 배포 비용 | 높음 | 낮음 |
| 주요 위험 | ProxyAdmin 키 분실 | `_authorizeUpgrade` 누락 → 누구나 업그레이드 가능 |

OZ는 UUPS를 권장한다. KyoboNFT는 UUPS 사용.

---

### 4. Storage Collision — 가장 위험한 함정

업그레이드 시 발생할 수 있는 치명적 오류다.

**Proxy는 슬롯(slot) 기반으로 상태를 저장한다:**

```solidity
contract KyoboNFT v1 {
    // OZ ERC1155의 내부 변수들이 slot 0, 1, 2...에 저장됨
    // 직접 선언한 변수는 그 다음 슬롯에 위치
}
```

**잘못된 업그레이드:**

```solidity
contract KyoboNFTV2_WRONG {
    address private newFeature;  // slot 0에 새 변수 삽입
    // 기존 OZ ERC1155 변수들은 slot 1, 2, 3...으로 밀림
}
```

결과:

```
slot 0: 원래 _balances 매핑 → 이제 newFeature(address)로 해석됨
모든 잔액 정보 파괴
```

토큰을 가지고 있던 사용자의 잔액이 0이 되거나 이상한 값이 된다. 이것은 복구 불가능하다.

**안전한 업그레이드 규칙:**

```
✅ 기존 슬롯 레이아웃 완전 유지
✅ 새 변수는 오직 끝에만 추가
❌ 기존 변수 삭제 → 슬롯 번호 변경 → 충돌
❌ 기존 변수 순서 변경 → 충돌
❌ 기존 변수 타입 변경 → 충돌
```

---

### 5. `initialize()` — constructor를 대신하는 이유

일반 컨트랙트에서 초기화:
```solidity
constructor() {
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
}
```

UUPS 프록시에서는 constructor가 문제다:

```
deployProxy 과정:
1. Implementation 컨트랙트 배포 → constructor 실행 (Implementation의 storage)
2. Proxy 컨트랙트 배포
3. Proxy가 Implementation.initialize() 호출 → Proxy의 storage에 초기화

constructor는 Implementation의 storage에 실행됨
Proxy는 아무 초기화 없는 상태
→ Proxy의 DEFAULT_ADMIN_ROLE이 설정 안 됨
```

그래서 `initialize()` 함수를 만들고 `initializer` modifier를 붙인다:

```solidity
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers();  // Implementation을 직접 초기화하는 공격 차단
}

function initialize(address admin) public initializer {
    __ERC1155_init("");
    __AccessControl_init();
    __Pausable_init();
    __UUPSUpgradeable_init();

    _grantRole(DEFAULT_ADMIN_ROLE, admin);
    _grantRole(MINTER_ROLE,        admin);
    _grantRole(PAUSER_ROLE,        admin);
    _grantRole(UPGRADER_ROLE,      admin);
}
```

`initializer` modifier는 **한 번만 실행**을 보장한다. 두 번째 호출 시 revert.

---

### 6. `initializer` 누락 공격 시뮬레이션

```solidity
// ❌ 취약한 컨트랙트
function initialize(address admin) public {  // initializer 없음!
    _grantRole(DEFAULT_ADMIN_ROLE, admin);
}
```

공격 순서:
1. 배포 후 `initialize(deployer)` 호출 완료
2. 공격자: `initialize(attacker)` 재호출
3. 공격자가 `DEFAULT_ADMIN_ROLE` 획득
4. `grantRole(MINTER_ROLE, attacker)` → NFT 무제한 발행 가능

이것이 UUPS에서 가장 흔한 보안 사고 중 하나다.

---

## 실습 파트 (30분)

### `initializer` 누락 공격 테스트

```solidity
function test_initializerProtection() public {
    // initialize는 이미 setUp()에서 호출됨

    // 공격 시도: 다시 initialize 호출
    vm.expectRevert(); // InvalidInitialization
    nft.initialize(address(0xAttacker));
}
```

`modifier` 제거 → 재호출 가능 확인:

```bash
# KyoboNFT.sol에서 initializer 제거
# function initialize(address admin) public {  ← modifier 없음
# npx hardhat test test/KyoboNFT.test.ts
# test_initializerProtection → 실패 (재호출 가능해졌으므로)
# → initializer modifier 다시 추가 → 테스트 통과
```

### 업그레이드 가능 프록시 로컬 배포 확인

```typescript
// test/deploy.test.ts
it('UUPS 프록시 배포 성공', async () => {
  const [admin] = await ethers.getSigners();

  const KyoboNFT = await ethers.getContractFactory('KyoboNFT');
  const nft = await upgrades.deployProxy(KyoboNFT, [admin.address], {
    kind: 'uups',
    initializer: 'initialize',
  });
  await nft.waitForDeployment();

  const proxyAddr = await nft.getAddress();
  const implAddr  = await upgrades.erc1967.getImplementationAddress(proxyAddr);

  console.log('Proxy:', proxyAddr);
  console.log('Implementation:', implAddr);

  // 초기화 확인
  expect(await nft.hasRole(await nft.DEFAULT_ADMIN_ROLE(), admin.address)).toBe(true);
  expect(await nft.hasRole(await nft.MINTER_ROLE(), admin.address)).toBe(true);
});
```

---

## 완료 기준

- [ ] initialize() initializer 적용 확인
- [ ] 재호출 → revert 확인
- [ ] 로컬 프록시 배포 성공
- [ ] Storage Collision 발생 원인 설명 가능
