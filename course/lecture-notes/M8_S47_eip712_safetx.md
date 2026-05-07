# M8 S47 — 다중 서명 트랜잭션 생명주기 · 제안·서명 수집·실행 프로토콜 설계

> 모듈 8 · 세션 47 · 1시간  
> 스켈레톤: `dmz/packages/vasp/src/governance/KeyGovernanceService.ts`

> ⚠️ **Phase 구분** — **Phase 1 해당**: 당사 보조키를 활용한 멀티시그 서명 참여 (VASP 주키 + 당사 보조키 구조). **Phase 3 해당**: 완전 자체 Custody 인가 이후 당사가 주키까지 직접 보관·서명하는 구조. Phase 1에서 당사는 서명 참여자이지 키 보관 주체가 아니다.

---

## 강의 파트 (55분)

### 1. 단일 HOT 키의 취약점 — "한 줄짜리 업그레이드"

S46에서 2-of-3 구조의 필요성을 개념적으로 배웠다. 이번에는 실제로 어떤 코드 흐름으로 구현되는지 설계한다.

단일 HOT 키로 업그레이드가 가능한 현재 구조:

```
VASP 서버 키 → UPGRADER_ROLE → upgradeToAndCall(newImpl)
```

코드 한 줄:
```typescript
await nft.upgradeToAndCall(maliciousImpl, "0x");
// 실행 주체: VASP 서버 지갑 (단독 서명)
```

이 구조의 문제:
- VASP 서버 탈취 1회 → 컨트랙트 업그레이드 가능
- 컨트랙트 교체 → 전 가입자 NFT 잔액 조작 가능
- 금융기관에서 "한 명이 시스템 전체를 변경할 수 있는 구조"는 내부 통제 위반

Gnosis Safe를 도입하면:
```
upgradeToAndCall() 실행 주체 → Safe 컨트랙트
Safe 컨트랙트 실행 조건 → 2-of-3 서명 충족
→ 어느 단일 주체도 혼자 업그레이드 불가
```

---

### 2. SafeTx 생명주기 4단계

```
[1단계] proposeTx
  → 실행하고 싶은 TX 내용 기술 (to, value, data, operation)
  → SafeTx 해시 계산 (EIP-712)
  → DB에 PENDING_SIGNATURES 상태로 저장
  → 서명자들에게 알림

[2단계] addSignature (반복)
  → 각 서명자: 오프체인에서 SafeTx 해시에 EIP-712 서명
  → 서명을 DB에 추가
  → 수집된 서명 수 >= threshold → READY_TO_EXECUTE

[3단계] executeTx
  → DB에서 모인 서명들 조회
  → Safe.execTransaction(params, 서명들) 온체인 실행
  → Safe 컨트랙트: 서명 검증 → 실행 → 결과

[4단계] 완료
  → 온체인 TX 해시 기록
  → 상태 → EXECUTED
  → 감사 로그 기록
```

각 단계가 분리된 이유: 서명자들은 시간대, 위치, 조직이 다르다. 동시에 온라인일 필요가 없다.

---

### 3. 오프체인 서명의 의미

"오프체인 서명"이란 블록체인에 TX를 보내지 않고 서명한다는 의미다.

```
일반 on-chain TX:
  서명자 → eth_sendTransaction(서명된TX) → 블록체인 → 채굴 → 확정
  비용: 가스비 (매번 발생)

오프체인 서명 (EIP-712):
  서명자 → eth_signTypedData(구조체) → 서명값(bytes) → DB 저장
  비용: 없음 (서명만)
```

3명이 각자 서명할 때 가스를 낼 필요가 없다. 마지막 execTransaction 한 번만 on-chain TX다.

**EIP-712 서명의 구체적 흐름:**

```
1. SafeTx 해시 = keccak256(
     "\x19\x01"
     + domainSeparator    // chainId + Safe 주소 포함
     + structHash         // to + value + data + operation + ... 해시
   )

2. 서명자의 개인키로 safeTxHash에 서명
   signature = ecdsaSign(safeTxHash, privateKey)

3. 나중에 Safe 컨트랙트가 ecrecover로 서명자 주소 복원
   recoveredAddress = ecrecover(safeTxHash, signature)
   assert(recoveredAddress in owners)
```

M5 S29에서 EIP-191로 지갑 소유권을 증명한 것과 같은 원리다. 차이는 서명 대상이 임의 바이트(EIP-191)가 아닌 구조화된 SafeTx 데이터(EIP-712)라는 점이다.

---

### 4. threshold 미달 시 왜 revert가 발생하는가

```
실행자가 1개 서명만으로 execTransaction 호출:

Safe 컨트랙트 내부:
  1. 서명들 파싱
  2. 각 서명에서 ecrecover → 주소 복원
  3. 복원된 주소가 owners에 있는지 확인
  4. 유효한 서명 수 카운트
  5. count < threshold → revert("GS020")  // Safe error code

→ TX 실행 안 됨, 가스비만 소모
```

Safe 컨트랙트 코드가 온체인에서 검증한다. 서버 코드가 몇 개 모였는지 체크하는 것이 아니라, 블록체인 자체가 강제한다.

---

### 5. KeyGovernanceService 설계 — DB와 Safe 사이의 조율자

```typescript
// KeyGovernanceService의 역할
//   DB: SafeTx의 상태, 서명 수집 현황 관리 (오프체인)
//   Safe: 서명 검증 + 실행 (온체인)

proposeTx:
  DB에 PENDING_SIGNATURES로 저장 (아직 온체인 아님)
  서명자들에게 알림

addSignature:
  DB에 서명 추가 (아직 온체인 아님)
  threshold 도달 시 → READY_TO_EXECUTE

executeTx:
  DB에서 서명들 꺼내 → Safe.execTransaction 온체인 전송
  온체인 결과 받아 → DB에 EXECUTED + txHash 기록
```

DB 상태와 온체인 상태가 분리되어 있다. DB는 "현재 서명이 몇 개 모였는가"를 관리하는 대기열이고, 온체인은 "실제로 실행되었는가"를 결정한다.

---

## 완료 기준

이번 세션은 개념 이해가 핵심이다. 구현은 S48에서 진행한다.

- [ ] SafeTx 생명주기 4단계 흐름도 그리기
- [ ] 오프체인 서명의 의미와 EIP-712 역할 설명 가능
- [ ] threshold 미달 시 revert 이유 설명 가능 (Safe 컨트랙트 온체인 검증)
- [ ] DB 상태(오프체인)와 Safe 실행(온체인) 분리 구조 설명 가능
- [ ] 단일 HOT 키 구조와 2-of-3 구조의 차이 설명 가능

---

## 실습 파트 (30분)

### 실습 1: EIP-712 SafeTx 해시 직접 계산

EIP-712 해시를 라이브러리 없이 직접 계산해 본다. 내부 원리를 이해하면 디버깅과 서명 검증에서 정확성이 높아진다.

```typescript
// test/eip712/safetx-hash.test.ts
import { ethers } from 'ethers';

describe('EIP-712 SafeTx 해시 수동 계산', () => {
  // Safe 컨트랙트 배포 주소 (테스트용)
  const SAFE_ADDRESS = '0x1234567890123456789012345678901234567890';
  const CHAIN_ID = 31337;  // hardhat local

  // SafeTx 타입 해시 (Gnosis Safe 스펙)
  const SAFE_TX_TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes(
      'SafeTx(address to,uint256 value,bytes data,uint8 operation,' +
      'uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,' +
      'address gasToken,address refundReceiver,uint256 nonce)'
    )
  );

  it('도메인 분리자(domainSeparator) 계산', () => {
    // TODO: EIP-712 DOMAIN_SEPARATOR 계산
    // keccak256(DOMAIN_TYPEHASH + chainId + verifyingContract)
    //
    // 힌트:
    //   DOMAIN_TYPEHASH = keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
    //   domainSeparator = keccak256(abi.encode(DOMAIN_TYPEHASH, chainId, safeAddress))

    const DOMAIN_TYPEHASH = ethers.keccak256(
      ethers.toUtf8Bytes('EIP712Domain(uint256 chainId,address verifyingContract)')
    );

    const domainSeparator = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256', 'address'],
        [DOMAIN_TYPEHASH, CHAIN_ID, SAFE_ADDRESS]
      )
    );

    // domainSeparator는 항상 32바이트 hex
    expect(domainSeparator).toMatch(/^0x[0-9a-f]{64}$/);
    console.log('domainSeparator:', domainSeparator);
  });

  it('structHash(SafeTx) 계산 — pause() 호출', () => {
    // KyoboNFT.pause() 호출을 담은 SafeTx
    const safeTx = {
      to:             '0xKyoboNFTContractAddress0000000000000000',
      value:          0n,
      data:           '0x8456cb59',  // pause() 함수 selector
      operation:      0,             // CALL
      safeTxGas:      0n,
      baseGas:        0n,
      gasPrice:       0n,
      gasToken:       ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
      nonce:          0n,
    };

    // TODO: structHash 계산
    // keccak256(abi.encode(SAFE_TX_TYPEHASH, to, value, keccak256(data), ...))
    //
    // 힌트: bytes 타입은 keccak256으로 먼저 해시해야 한다

    const dataHash = ethers.keccak256(safeTx.data);

    const structHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32','address','uint256','bytes32','uint8',
         'uint256','uint256','uint256','address','address','uint256'],
        [
          SAFE_TX_TYPEHASH,
          safeTx.to,
          safeTx.value,
          dataHash,            // bytes → keccak256
          safeTx.operation,
          safeTx.safeTxGas,
          safeTx.baseGas,
          safeTx.gasPrice,
          safeTx.gasToken,
          safeTx.refundReceiver,
          safeTx.nonce,
        ]
      )
    );

    expect(structHash).toMatch(/^0x[0-9a-f]{64}$/);
    console.log('structHash:', structHash);
  });

  it('최종 SafeTx 해시 = "\\x19\\x01" + domainSeparator + structHash', () => {
    // TODO: 최종 safeTxHash 계산
    // "\x19\x01" prefix + domainSeparator + structHash
    //
    // 힌트: ethers.solidityPackedKeccak256 또는 수동 concat

    const DOMAIN_TYPEHASH = ethers.keccak256(
      ethers.toUtf8Bytes('EIP712Domain(uint256 chainId,address verifyingContract)')
    );
    const domainSeparator = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32','uint256','address'],
        [DOMAIN_TYPEHASH, CHAIN_ID, SAFE_ADDRESS]
      )
    );

    const dataHash = ethers.keccak256('0x8456cb59');
    const structHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32','address','uint256','bytes32','uint8',
         'uint256','uint256','uint256','address','address','uint256'],
        [SAFE_TX_TYPEHASH, '0xKyoboNFTContractAddress0000000000000000',
         0n, dataHash, 0, 0n, 0n, 0n,
         ethers.ZeroAddress, ethers.ZeroAddress, 0n]
      )
    );

    // EIP-712 최종 해시: keccak256(0x1901 + domainSeparator + structHash)
    const safeTxHash = ethers.keccak256(
      ethers.concat(['0x1901', domainSeparator, structHash])
    );

    expect(safeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    console.log('safeTxHash (최종):', safeTxHash);
  });
});
```

---

### 실습 2: 오프체인 서명 + ecrecover 검증

서명자가 SafeTx 해시에 서명하고, 검증자가 ecrecover로 서명자 주소를 복원하는 흐름을 구현한다.

```typescript
// test/eip712/signature-verify.test.ts
describe('EIP-712 서명 생성 + ecrecover 검증', () => {
  it('개인키로 safeTxHash에 서명 → ecrecover로 주소 복원', async () => {
    // 테스트용 지갑 (실제 운영에서는 HSM/AWS KMS 사용)
    const signerWallet = ethers.Wallet.createRandom();

    // safeTxHash (이전 테스트에서 계산된 값 사용)
    const safeTxHash = '0x' + 'ab'.repeat(32);  // 테스트용 더미 해시

    // TODO: safeTxHash에 EIP-712 서명
    // 힌트: ethers Wallet의 signMessage는 EIP-191 서명이므로
    //       EIP-712 해시에는 직접 ECDSA 서명 필요
    //
    // wallet.signingKey.sign(safeTxHash) 또는
    // Safe SDK: safeSdk.signTransactionHash(safeTxHash)

    const signingKey = signerWallet.signingKey;
    const sig = signingKey.sign(safeTxHash);

    // 서명 직렬화 (r + s + v)
    const signature = ethers.Signature.from(sig).serialized;
    console.log('서명값:', signature);

    // TODO: ecrecover로 서명자 주소 복원
    // 힌트: ethers.recoverAddress(safeTxHash, signature)
    const recovered = ethers.recoverAddress(safeTxHash, signature);

    // 복원된 주소 = 서명자 지갑 주소
    expect(recovered.toLowerCase()).toBe(signerWallet.address.toLowerCase());
    console.log('복원된 주소:', recovered);
    console.log('서명자 주소:', signerWallet.address);
  });

  it('다른 해시에 서명 → ecrecover가 다른 주소 반환', async () => {
    const signerWallet = ethers.Wallet.createRandom();
    const correctHash = '0x' + 'ab'.repeat(32);
    const wrongHash   = '0x' + 'cd'.repeat(32);  // 다른 해시

    const sig = signerWallet.signingKey.sign(correctHash);
    const signature = ethers.Signature.from(sig).serialized;

    // 잘못된 해시로 ecrecover
    const recovered = ethers.recoverAddress(wrongHash, signature);

    // 복원 주소가 서명자와 다름 → 서명 위조 감지
    expect(recovered.toLowerCase()).not.toBe(signerWallet.address.toLowerCase());
    console.log('해시 불일치 시 복원 주소 (다름):', recovered);
  });

  it('replay attack — 다른 chainId Safe에서 동일 서명 재사용 불가', () => {
    // domainSeparator에 chainId가 포함되므로
    // mainnet(1) 서명을 testnet(31337)에서 재사용하면 ecrecover 결과가 달라진다

    const DOMAIN_TYPEHASH = ethers.keccak256(
      ethers.toUtf8Bytes('EIP712Domain(uint256 chainId,address verifyingContract)')
    );
    const SAFE_ADDRESS = '0x1234567890123456789012345678901234567890';

    const mainnetDomain = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32','uint256','address'], [DOMAIN_TYPEHASH, 1, SAFE_ADDRESS]
      )
    );
    const testnetDomain = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32','uint256','address'], [DOMAIN_TYPEHASH, 31337, SAFE_ADDRESS]
      )
    );

    // chainId가 다르면 domainSeparator가 다름 → safeTxHash가 다름
    expect(mainnetDomain).not.toBe(testnetDomain);
    console.log('mainnet domainSeparator:', mainnetDomain);
    console.log('testnet domainSeparator:', testnetDomain);
  });
});
```

---

### 실습 3: SafeTx 제안 → 서명 수집 → 실행 전체 흐름

S48에서 구현할 KeyGovernanceService의 흐름을 Gnosis Safe SDK로 직접 검증한다.

```typescript
// test/eip712/safetx-flow.test.ts
import { ethers } from 'hardhat';
import Safe, { EthersAdapter } from '@safe-global/protocol-kit';

describe('SafeTx 전체 흐름 — 제안 → 서명 수집 → 실행', () => {
  let safeAddress: string;
  let signerA: ethers.Signer;
  let signerB: ethers.Signer;
  let signerC: ethers.Signer;

  before(async () => {
    [signerA, signerB, signerC] = await ethers.getSigners();

    // Safe 배포 (S46에서 완료)
    const sdkA = await Safe.create({
      ethAdapter: new EthersAdapter({ ethers, signerOrProvider: signerA }),
      safeAccountConfig: {
        owners: [
          await signerA.getAddress(),
          await signerB.getAddress(),
          await signerC.getAddress(),
        ],
        threshold: 2,
      },
    });
    safeAddress = await sdkA.getAddress();
  });

  it('proposeTx → safeTxHash 계산 → 2-of-3 서명 → execTransaction', async () => {
    // [1] Safe SDK로 SafeTx 생성
    const sdkA = await Safe.create({
      ethAdapter: new EthersAdapter({ ethers, signerOrProvider: signerA }),
      safeAddress,
    });

    const safeTransaction = await sdkA.createTransaction({
      transactions: [{
        to: safeAddress,          // self-call 테스트
        value: '0',
        data: '0x',               // 빈 호출
        operation: 0,
      }],
    });

    // [2] safeTxHash 계산
    const safeTxHash = await sdkA.getTransactionHash(safeTransaction);
    expect(safeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    console.log('safeTxHash:', safeTxHash);

    // [3] 서명자 A 서명 (오프체인)
    const signedTxA = await sdkA.signTransaction(safeTransaction);
    console.log('서명자 A 서명 완료 (오프체인)');

    // [4] 서명자 B 서명 (오프체인)
    const sdkB = await Safe.create({
      ethAdapter: new EthersAdapter({ ethers, signerOrProvider: signerB }),
      safeAddress,
    });
    const signedTxB = await sdkB.signTransaction(signedTxA);
    console.log('서명자 B 서명 완료 (오프체인)');

    // threshold = 2 충족 → 실행 가능

    // [5] execTransaction (on-chain TX — 가스 1회)
    const executeTxResponse = await sdkA.executeTransaction(signedTxB);
    await executeTxResponse.transactionResponse?.wait();

    console.log('execTransaction 성공, txHash:', executeTxResponse.hash);
    expect(executeTxResponse.hash).toMatch(/^0x/);
  });

  it('서명자 1명만으로 execTransaction → revert (GS020)', async () => {
    const sdkA = await Safe.create({
      ethAdapter: new EthersAdapter({ ethers, signerOrProvider: signerA }),
      safeAddress,
    });

    const safeTransaction = await sdkA.createTransaction({
      transactions: [{ to: safeAddress, value: '0', data: '0x', operation: 0 }],
    });

    // TODO: 서명자 A만 서명 후 실행 시도 → revert 확인
    // 힌트: Safe 컨트랙트가 GS020 에러로 revert
    const signedTx = await sdkA.signTransaction(safeTransaction);

    // execTransaction은 Safe 컨트랙트에서 revert
    await expect(
      sdkA.executeTransaction(signedTx)
    ).rejects.toThrow();  // GS020: threshold not met
  });
});
```

---

## 완료 기준

```typescript
// dmz/packages/vasp/src/governance/KeyGovernanceService.ts
// S48에서 구현할 스켈레톤

export class KeyGovernanceService {
  async proposeTx(proposer: string, params: SafeTxParams): Promise<PendingTx> {
    // 1. Travel Rule 검증 (S49)
    // 2. SafeTx 해시 계산 (EIP-712)
    // 3. DB 저장 (PENDING_SIGNATURES)
    // 4. 감사 로그 + 알림
    throw new Error('Not implemented');
  }

  async addSignature(txId: string, signer: string, sig: string): Promise<SignatureStatus> {
    // 1. DB 조회 + 상태 확인
    // 2. 중복 서명 방지
    // 3. Safe 서명 검증
    // 4. DB 업데이트
    // 5. threshold 도달 시 READY_TO_EXECUTE
    throw new Error('Not implemented');
  }

  async executeTx(txId: string, executor: string): Promise<{ onChainTxHash: string }> {
    // 1. READY_TO_EXECUTE 상태 확인
    // 2. Safe.execTransaction
    // 3. EXECUTED 기록
    throw new Error('Not implemented');
  }
}
```

각 함수의 책임과 흐름을 이해한 후 S48 실습에서 구현한다.
