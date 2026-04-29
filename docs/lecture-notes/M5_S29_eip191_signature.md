# M5 S29 — 블록체인 서명 기반 지갑 소유권 증명 원리

> 모듈 5 · 세션 29 · 1시간  
> 스켈레톤: `dmz/apps/issuer-service/src/services/WalletMappingService.ts` → `verifyOwnership()`

---

## 강의 파트 (20분)

### 1. "내 지갑 주소입니다"라는 말만으로는 부족하다

S28에서 사용자가 지갑 주소를 서버에 전달한다고 배웠다. 그런데 문제가 있다.

**Sybil 공격 시나리오:**

```
1. 공격자가 인터넷에서 피해자의 지갑 주소 0xVICTIM을 알아냄
   (블록체인은 공개다. 누구나 주소를 볼 수 있다)
   
2. 공격자가 서버에 요청: "내 userId=K-ATTACKER의 지갑 주소는 0xVICTIM입니다"

3. 서버가 이 매핑을 그대로 저장

4. 교보가 K-ATTACKER에게 NFT 발행 → 0xVICTIM 주소로 발행됨

5. 공격자는 0xVICTIM을 제어하지 못하지만, 피해자의 지갑에 엉뚱한 NFT가 꽂힘
   또는: 진짜 피해자는 자기 지갑이 이미 등록돼 있어서 재등록 불가
```

이런 공격을 막으려면 "이 지갑의 private key를 실제로 소유하고 있음"을 증명해야 한다.

---

### 2. EIP-191 서명 — 개인키 소유 증명의 표준

EIP-191은 Ethereum 개인 서명(personal_sign)의 표준 메시지 포맷이다.

```
서명 메시지 = "\x19Ethereum Signed Message:\n" + len(message) + message
```

이 접두사가 있는 이유: 일반 트랜잭션 서명과 구분하기 위해서다. 피싱 사이트가 "메시지 서명"으로 트랜잭션 서명을 유도하는 공격을 막는다.

**서명 원리:**

```
클라이언트에서:
  message = "Kyobo Digital Asset Wallet: K-20240001:a3f2b9c1"
  sig = eth_sign(privateKey, message)
  → 서버에 전송

서버에서:
  recovered = ecrecover(message, sig)
  recovered == 0xABCD...? (사용자가 주장하는 주소)
    YES → 소유 증명 완료 → DB 저장
    NO  → 403 거부
```

**ecrecover 수학적 원리:**

```
서명 = ECDSA.sign(privKey, hash(message))
  → r, s, v 값 (65바이트)
  
복원:
  pubKey = ECDSA.recover(hash(message), r, s, v)
  address = keccak256(pubKey[1:])[12:]  ← 뒤 20바이트
```

private key 없이는 올바른 `(r, s, v)` 쌍을 만들 수 없다. 서명을 위조하려면 private key가 필요하고, private key에서 public key와 주소가 결정된다. 따라서 올바른 서명 = 해당 주소의 private key 소유 증명.

---

### 3. Nonce — 서명 재사용 공격 방지

서명 검증이 있어도 한 가지 공격이 남는다.

**재생(Replay) 공격:**

```
1. 정상 사용자가 어느 날 서명 등록: message="Kyobo: K-001:nonce1", sig=0xAAA
2. 공격자가 이 (message, sig)을 저장해둠
3. 이후 공격자가 같은 (message, sig)를 서버에 재전송
4. 서버가 또 검증 통과 → 이미 다른 주소로 교체된 사용자의 지갑을 원복시킴
```

해결: 메시지에 **nonce(일회성 값)** 포함

```typescript
// 서버: 요청 시마다 새 nonce 생성
generateNonce(userId: string): string {
  const raw = `${userId}:${Date.now()}:${Math.random()}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  // 예: "a3f2b9c1d4e5f601"
}
```

nonce를 DB에 저장하고, 서명 검증 후 해당 nonce를 무효화한다:

```
1. GET /wallet/nonce → 서버가 nonce 발급 + DB 저장
2. 클라이언트: eth_sign("Kyobo: K-001:a3f2b9c1")
3. POST /wallet/verify → 서버 검증
4. 검증 성공 → nonce 무효화 (DB에서 삭제 또는 used=true)
5. 같은 nonce로 재전송 → "이미 사용된 nonce" 거부
```

---

### 4. 주소 비교 시 주의사항 — lowercase 정규화

Ethereum 주소는 checksum encoding(EIP-55)으로 대소문자가 혼용된다:

```
0xAbCd1234EF...  (EIP-55 checksum encoding)
0xabcd1234ef...  (lowercase)
```

두 형식은 같은 주소지만 문자열 비교 시 다르게 나온다. 반드시 lowercase로 정규화 후 비교:

```typescript
if (recovered.toLowerCase() !== walletAddr.toLowerCase()) {
  return false;
}
```

---

## 실습 파트 (35분)

### `verifyOwnership()` 구현

```typescript
// WalletMappingService.ts
async verifyOwnership(params: {
  userId:     string;
  walletAddr: string;
  signature:  string;
  nonce:      string;
}): Promise<boolean> {
  const { userId, walletAddr, signature, nonce } = params;

  // 1. nonce 유효성 확인
  const storedNonce = await this.nonceRepo.find(userId);
  if (!storedNonce || storedNonce !== nonce) {
    return false;  // 유효하지 않은 nonce
  }

  // 2. 서명 검증 — 서명에서 주소 복원
  const message = `Kyobo Digital Asset Wallet: ${userId}:${nonce}`;
  const recovered = await this.sigVerifier.recoverAddress(message, signature);

  // 3. 복원 주소 == 사용자 주장 주소?
  if (recovered.toLowerCase() !== walletAddr.toLowerCase()) {
    return false;  // 서명자 ≠ 지갑 소유자
  }

  // 4. nonce 무효화 (재생 공격 방지)
  await this.nonceRepo.delete(userId);

  // 5. 소유 증명 완료 → DB 저장
  await this.repo.upsert({
    userId,
    walletAddr,
    vaspType:  'EXTERNAL',
    verified:  true,      // 서명 검증 완료
    createdAt: new Date(),
  });

  return true;
}
```

### SignatureVerifier 인터페이스

```typescript
export interface SignatureVerifier {
  recoverAddress(message: string, signature: string): Promise<string>;
}

// 실제 구현 (ethers.js)
import { ethers } from 'ethers';

class EthersSignatureVerifier implements SignatureVerifier {
  async recoverAddress(message: string, signature: string): Promise<string> {
    // ethers.js가 EIP-191 접두사 자동 처리
    return ethers.verifyMessage(message, signature);
  }
}

// 테스트용 Mock
const mockVerifier: SignatureVerifier = {
  async recoverAddress(message, signature) {
    if (signature === VALID_SIG) return EXPECTED_ADDR;
    return '0x0000000000000000000000000000000000000000';  // 잘못된 서명
  },
};
```

### 테스트 케이스

```typescript
describe('verifyOwnership', () => {
  const WALLET_ADDR = '0xAbCd1234EF5678901234567890abcdef01234567';
  const VALID_SIG   = '0xValidSignature';
  const NONCE       = 'a3f2b9c1';

  it('올바른 서명 → verified=true DB 저장', async () => {
    const mockVerifier = {
      async recoverAddress() { return WALLET_ADDR.toLowerCase(); },
    };
    // ...
    const result = await service.verifyOwnership({
      userId: 'user1', walletAddr: WALLET_ADDR, signature: VALID_SIG, nonce: NONCE,
    });
    expect(result).toBe(true);
    // DB에 verified=true로 저장됐는지 확인
  });

  it('잘못된 서명 → false 반환 (HTTP 403)', async () => {
    const mockVerifier = {
      async recoverAddress() { return '0x0000000000000000000000000000000000000000'; },
    };
    // ...
    const result = await service.verifyOwnership({
      userId: 'user1', walletAddr: WALLET_ADDR, signature: 'INVALID_SIG', nonce: NONCE,
    });
    expect(result).toBe(false);
  });

  it('이미 등록된 주소 재등록 → 기존 레코드 업데이트', async () => {
    // 첫 번째 등록
    await service.verifyOwnership({ userId: 'user1', walletAddr: WALLET_ADDR, ... });
    // 두 번째 등록 (지갑 교체 시나리오)
    await service.verifyOwnership({ userId: 'user1', walletAddr: NEW_ADDR, ... });
    // 최신 주소만 남아야 함
    const addr = await service.getWalletAddr('user1');
    expect(addr).toBe(NEW_ADDR);
  });

  it('사용된 nonce 재사용 → false 반환', async () => {
    // 첫 번째 검증 성공 → nonce 무효화됨
    await service.verifyOwnership({ ..., nonce: NONCE });
    // 같은 nonce로 재시도
    const result = await service.verifyOwnership({ ..., nonce: NONCE });
    expect(result).toBe(false);
  });
});
```

### 전체 등록 플로우 시퀀스

```
클라이언트              서버
     │                   │
     ├─GET /wallet/nonce─▶│
     │                   │ generateNonce(userId) → DB 저장
     │◀─nonce────────────┤
     │                   │
     │ eth_sign("Kyobo: userId:nonce")
     │                   │
     ├─POST /wallet/verify▶│
     │  { walletAddr,    │ 1. nonce 유효성 확인
     │    signature,     │ 2. verifyOwnership()
     │    nonce }        │    → ecrecover
     │                   │    → 주소 일치?
     │                   │ 3. nonce 무효화
     │◀─200 OK / 403─────┤ 4. DB 저장 (verified=true)
```

---

## 완료 기준

- [ ] eth_sign 서명 검증 통과
- [ ] 잘못된 서명 → false 반환 (HTTP 403)
- [ ] 중복 등록 처리 테스트
- [ ] nonce 재사용 방지 테스트
