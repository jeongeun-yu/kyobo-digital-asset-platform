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

### 참고: KeyGovernanceService 스켈레톤 미리 보기

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
