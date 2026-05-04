# M8 S46 — 다중 서명 기반 키 거버넌스 · Gnosis Safe와 EIP-712

> 모듈 8 · 세션 46 · 1시간  
> 스켈레톤: `dmz/packages/vasp/src/governance/KeyGovernanceService.ts`

> ⚠️ **Phase 구분** — **Phase 1 해당**: 당사 보조키를 활용한 멀티시그 서명 참여 (VASP 주키 + 당사 보조키 구조). **Phase 3 해당**: 완전 자체 Custody 인가 이후 당사가 주키까지 직접 보관·서명하는 구조. Phase 1에서 당사는 서명 참여자이지 키 보관 주체가 아니다.

---

## 강의 파트 (35분)

### 1. 단일 키의 위험 — "한 줄로 무너지는 시스템"

M6에서 KyoboNFT.sol에 `UPGRADER_ROLE`을 만들었다. 이 역할이 있는 지갑 주소 하나가 `upgradeToAndCall()`을 호출할 수 있다.

현재 구조:
```
VASP 서버 지갑 (HOT KEY) → UPGRADER_ROLE 보유
→ upgradeToAndCall(악성 구현체) 가능
```

이 HOT KEY가 탈취되면:
```
공격자 → upgradeToAndCall(악성 Implementation)
악성 컨트랙트: mint(attacker, 모든 tokenId, 무제한)
→ 전 가입자 NFT 잔액 탈취
→ 교보생명 고객 피해
→ 금융당국 제재
```

HOT KEY는 서버 메모리에 상주한다. 서버가 해킹되면 노출된다. 단 하나의 키가 전체 시스템을 장악할 수 있는 구조는 금융 시스템에서 허용되지 않는다.

---

### 2. 2-of-3 멀티시그 설계 — "혼자 할 수 없는 구조"

Gnosis Safe는 k-of-n 멀티시그 컨트랙트다. n명의 서명자 중 k명이 서명해야 TX가 실행된다.

**당사 구성 (2-of-3):**

| 서명자 | 소속 | 역할 | 키 보관 |
|--------|------|------|---------|
| 서명자 A | VASP | 기술 실행 | AWS KMS |
| 서명자 B | 교보 IT | 운영 승인 | 사내 HSM |
| 서명자 C | 준법감시팀 | 컴플라이언스 | 오프라인 HSM (비상용) |

3명 중 2명이 동의해야 실행된다. VASP 서버가 해킹되어 서명자 A의 키가 탈취되더라도, 서명자 B나 C의 서명 없이는 아무것도 실행할 수 없다.

**어떤 TX가 멀티시그를 요구하는가?**

```
일반 mint (MINTER_ROLE):
   VASP 서버 단독 서명 → OK (1명)
   이유: 실시간 발행 필요, 건별 서명은 비현실적

고위험 TX (UPGRADER_ROLE, 대형 이체):
   2-of-3 필수
   이유: 시스템 전체에 영향을 미치는 변경
```

업그레이드, MINTER_ROLE 변경, 대형 KRW 이체 등이 고위험 TX다.

---

### 3. EIP-712 SafeTx — 가스 없이 서명하는 방법

멀티시그를 단순하게 구현하면: 서명자 3명이 각자 on-chain TX를 보내야 한다 → 3번의 가스비 발생.

Gnosis Safe는 오프체인 서명을 활용한다:
```
1. 제안자: SafeTx 구조체 생성 → EIP-712 해시 계산
2. 서명자들: 오프체인에서 해시에 서명 (가스비 0)
3. 실행자: 서명들을 모아서 한 번의 on-chain TX로 제출
            → Safe 컨트랙트가 서명 검증 → 실행
```

서명자 A, B, C 각각 가스비를 낼 필요 없다. 마지막 실행자(보통 서명자 중 한 명)만 가스를 낸다.

**EIP-712란?**

일반 서명(eth_sign): 임의 바이트열에 서명. 어떤 의미인지 지갑 화면에 보이지 않음.

EIP-712 구조화 데이터 서명:
```
{
  "types": {
    "SafeTx": [
      { "name": "to",         "type": "address" },
      { "name": "value",      "type": "uint256" },
      { "name": "data",       "type": "bytes"   },
      { "name": "operation",  "type": "uint8"   },
      ...
    ]
  },
  "domain": {
    "chainId": 1,
    "verifyingContract": "0xSafe..."
  },
  "message": {
    "to": "0xKyoboNFT...",
    "value": "0",
    "data": "0xa9059cbb..."  // ABI-encoded upgradeToAndCall
  }
}
```

MetaMask 같은 지갑이 이 구조를 읽어서 사람이 이해할 수 있는 형태로 화면에 보여준다: "KyoboNFT 업그레이드 실행". 무엇에 서명하는지 명확하게 알 수 있다.

**재생 공격(Replay Attack) 방지:**

domain separator에 `chainId`와 `verifyingContract` 주소가 포함된다. 동일한 서명을 다른 체인이나 다른 Safe 컨트랙트에서 재사용할 수 없다.

---

### 4. MPC — Gnosis Safe 이후의 미래

Gnosis Safe는 온체인 멀티시그다. 각 서명자는 완전한 개인키를 보유한다. 서명자 B의 키가 탈취되면 B의 서명을 공격자가 만들 수 있다.

MPC(Multi-Party Computation, 다자 연산):

```
기존: 키 1개 → 사람 1명 보관
MPC:  키 파편 N개 → N명이 각자 보관
     → 어느 한 곳에도 완전한 키가 존재하지 않음
     → 파편만으로는 서명 불가
     → 서명 필요 시: N명이 연산에 참여 → 완전한 서명 생성
     → 완전한 개인키가 메모리에도 잠깐도 등장하지 않음
```

당사 MPC 적용 포인트:
- Phase 2: VASP HOT 키 → MPC 전환 (단일 서버 탈취로 키 노출 방지)
- Phase 3: 내부 서명자 키(교보 IT, 준법감시) → MPC 분산 보관

지금은 Gnosis Safe로 2-of-3 구조를 배우고, MPC는 이 구조의 진화형으로 이해한다.

---

### 5. 키 분실 복구 절차

서명자 1명이 키를 분실하면:

```
상황: 서명자 B(교보 IT) 퇴직 → 키 접근 불가

복구:
1. 서명자 A + C가 swapOwner TX 제안
   → "B(0xOld)를 D(0xNew)로 교체"
2. A + C가 오프체인 서명 (2-of-3 충족)
3. execTransaction 실행 → B → D로 교체
4. D의 키로 이후 서명 가능
```

2-of-3이기 때문에 1명이 없어도 나머지 2명이 복구할 수 있다. 1-of-1(단일 키)이면 키 분실 = 시스템 잠금이다.

---

## 실습 파트 (30분)

### Hardhat fork에서 Gnosis Safe 배포

```typescript
// test/gnosis/safe-deploy.test.ts
import { ethers } from 'hardhat';
import { Safe } from '@safe-global/protocol-kit';

describe('Gnosis Safe 배포', () => {
  let safeAddress: string;
  let signerA: ethers.Signer;
  let signerB: ethers.Signer;
  let signerC: ethers.Signer;

  before(async () => {
    [signerA, signerB, signerC] = await ethers.getSigners();
  });

  it('threshold=2, 서명자 3명으로 Safe 배포', async () => {
    // @safe-global/protocol-kit 사용
    const safeSdk = await Safe.create({
      ethAdapter: new EthersAdapter({ ethers, signerOrProvider: signerA }),
      safeAccountConfig: {
        owners: [
          await signerA.getAddress(),
          await signerB.getAddress(),
          await signerC.getAddress(),
        ],
        threshold: 2,  // 2-of-3
      },
    });

    safeAddress = await safeSdk.getAddress();
    console.log('Safe 배포 주소:', safeAddress);

    // 서명자 수 확인
    const owners = await safeSdk.getOwners();
    expect(owners).toHaveLength(3);

    // threshold 확인
    const threshold = await safeSdk.getThreshold();
    expect(threshold).toBe(2);
  });

  it('SafeTx 해시 계산 직접 확인', async () => {
    const safeSdk = await Safe.create({
      ethAdapter: new EthersAdapter({ ethers, signerOrProvider: signerA }),
      safeAddress,
    });

    // 예시: KyoboNFT.pause() 호출 TX
    const safeTransaction = await safeSdk.createTransaction({
      transactions: [
        {
          to: '0xKyoboNFT...',
          value: '0',
          data: '0x8456cb59',  // pause() selector
          operation: 0,         // CALL
        },
      ],
    });

    // EIP-712 기반 SafeTx 해시 계산
    const txHash = await safeSdk.getTransactionHash(safeTransaction);
    console.log('SafeTx 해시:', txHash);

    // 해시는 32바이트 hex
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('서명자 교체 시나리오 — swapOwner TX 구조 확인', async () => {
    const safeSdk = await Safe.create({
      ethAdapter: new EthersAdapter({ ethers, signerOrProvider: signerA }),
      safeAddress,
    });

    const newOwnerD = ethers.Wallet.createRandom().address;

    // swapOwner: 기존 B → 새 D로 교체
    const swapTx = await safeSdk.createSwapOwnerTx({
      oldOwnerAddress: await signerB.getAddress(),
      newOwnerAddress: newOwnerD,
    });

    // TX 제안 → 서명 A + C로 실행 (시나리오 확인)
    const txHash = await safeSdk.getTransactionHash(swapTx);
    expect(txHash).toBeTruthy();

    console.log('swapOwner TX 해시:', txHash);
    // 실제 실행은 S47에서 addSignature + executeTx 패턴으로
  });
});
```

---

## 완료 기준

- [ ] Gnosis Safe 배포 + threshold=2, 서명자 3명 설정 확인
- [ ] SafeTx 해시 계산 직접 확인
- [ ] swapOwner TX 구조 확인
- [ ] 단일 HOT 키 구조의 위험과 2-of-3의 해결 원리 설명 가능
- [ ] EIP-712 구조화 데이터 서명의 역할 설명 가능

---

> **📎 Phase 3 미리보기 연결:**  
> 이 세션의 Gnosis Safe는 거버넌스 TX용 다중서명이다.  
> Phase 3 직접 Custody 전환 시 **HSM vs MPC 키 관리 선택**, **Signer Input Contract 필드 명세**,  
> **출금 주소 화이트리스트 48시간 대기 모델**, **Available/Reserved/Pending/Settled 4단계 잔액**이 추가된다.  
> → [Phase3_S3_custody_security.md](./Phase3_S3_custody_security.md)
