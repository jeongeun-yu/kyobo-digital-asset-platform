# M9 S47 — MultisigService 구현 + Travel Rule 컴플라이언스

> 모듈 9 · 세션 47 · 개요 10분 + 실습 50분
> 스켈레톤: `internal/packages/vasp/src/governance/MultisigService.ts`

> **선수 지식** — S46: Gnosis Safe 2-of-3 배포 완료, SafeTx 구조 이해 / S46~S47(M8): EIP-712 오프체인 서명 → 온체인 실행 흐름 이해

---

## 세션 목표

| 목표 | 내용 |
|------|------|
| 구현 완성 | MultisigService(proposeTx / addSignature / executeTx / checkTravelRule) 전체 동작 |
| 검증 1 | 1-of-3 서명으로 executeTx → Safe 컨트랙트 revert(GS020) 확인 |
| 검증 2 | 2-of-3 서명으로 executeTx → 정상 온체인 실행 확인 |
| 검증 3 | checkTravelRule — 999,999원 통과 / 1,000,000원 TravelRuleRequired 확인 |

---

---

# [강사 배경]

> 수업 슬라이드에 직접 등장하지 않지만, 강사가 반드시 숙지해야 할 깊이 있는 내용이다.
> 수강생의 질문에 즉답하고, 설명의 근거를 갖추기 위한 배경 지식이다.

---

## 배경 1: Travel Rule 법률 완전 이해

### FATF Recommendation 16 원문 의도

FATF(Financial Action Task Force, 국제자금세탁방지기구)는 1989년 G7에 의해 설립된 정부간 기구다. 자금세탁·테러자금조달 방지를 위한 국제 표준을 제정하고 각국의 이행을 심사한다.

Recommendation 16 (R16, "Wire Transfer Rule"):

```
"Countries should ensure that financial institutions include required and
accurate originator information, and required beneficiary information,
on wire transfers and related messages, and that the information
remains with the wire transfer or related message throughout the
payment chain."

— FATF Recommendation 16 (2012, Updated 2023)
```

핵심 의도: 자금이 이동할 때 발신자·수신자 정보가 함께 "여행(travel)"해야 한다. 자금세탁범이 중간 기관을 통해 추적을 끊는 것을 방지한다.

2019년 FATF는 가상자산(Virtual Asset, VA) 및 가상자산 사업자(Virtual Asset Service Provider, VASP)에 동일한 규칙을 적용하는 개정안을 발표했다. 이것이 "Crypto Travel Rule"의 시작이다.

```
FATF R16 적용 대상 (2019 개정 이후):
  기존: 은행, 증권사, 환전업자
  추가: VASP (가상자산 거래소, 수탁업자, 지갑 서비스 등)

임계값: 1,000 USD / EUR 또는 동등한 자국 통화
```

### 한국 특금법 §8의4 전문 해석

정식 명칭: 특정 금융거래정보의 보고 및 이용 등에 관한 법률 제8조의4

**조문 핵심 내용 (2022년 3월 25일 시행 — 2021년 3월은 특금법 전체 개정 시행일, 트래블룰 정보제공 의무는 업계 유예 후 2022년 3월 25일부터):**

```
제8조의4(가상자산사업자의 가상자산 이전에 관한 정보제공)

① 가상자산사업자는 다른 가상자산사업자에게 100만원(외화의 경우
   미화 1천달러에 상당하는 금액을 말한다. 이하 이 조에서 같다)
   이상의 가상자산을 이전하는 경우 다음 각 호의 정보를 해당
   가상자산사업자에게 제공하여야 한다.

   1. 송신인의 성명
   2. 송신인의 가상자산주소
   3. 수신인의 성명
   4. 수신인의 가상자산주소

② 가상자산사업자는 다른 가상자산사업자로부터 100만원 이상의
   가상자산을 이전받은 경우 제1항 각 호의 정보를 제공받아
   수신인이 실제 고객인지 여부를 확인하여야 한다.
```

**해석 포인트:**

1. **"이전"의 정의**: 거래소→개인지갑도 "이전". 새 NFT 발행도 당국 해석에 따라 "이전"으로 볼 수 있다.

2. **100만원 기준**: 단일 거래 기준. 누적 합산이 아니다. 1회 이전 금액이 100만원 이상이면 적용.
   - 단, 동일 고객과 분할 거래가 명백한 경우 합산 적용 가능 (시행령 해석)

3. **VASP 간 의무**: 교보생명(발신 VASP) → 월렛원(수신 VASP)에 정보 전달. 교보→개인 직접이면 수신 VASP가 없어 적용 해석이 달라질 수 있음. 법령 해석은 KoFIU에 유권해석 요청 필요.

4. **제재**: 과태료(3천만원 이하), 영업정지, 형사처벌(3년 이하 징역 또는 3천만원 이하 벌금). 위반 횟수·금액에 따라 가중.

### 임계값 - 단일 거래 vs 누적

**단일 거래 기준이 원칙이다.**

```
가입자 A에게 하루 3번 발행:
  - 1차: 400,000원 → Travel Rule 불요
  - 2차: 400,000원 → Travel Rule 불요 (누적 800,000원이지만 단건 기준)
  - 3차: 400,000원 → Travel Rule 불요 (누적 1,200,000원이지만 단건 기준)

단건이 100만원 이상인 경우에만 적용:
  - 1,000,000원 단건 → Travel Rule 필요
```

단, "명백한 분할 거래(Structuring)"는 자금세탁방지법 위반으로 별도 제재 대상이다. 합산 100만원을 의도적으로 피하는 분할은 더 큰 위반이다.

### 송신인/수신인 정보 제출 의무 상세

```typescript
// IVMS101 국제 표준 메시지 구조 (InterVASP Messaging Standard 101)
interface IVMS101Message {
  originator: {
    originatorPersons: {
      naturalPerson?: {
        name: { nameIdentifier: [{ primaryIdentifier: string; secondaryIdentifier: string }] };
        nationalIdentification?: { nationalIdentifier: string; nationalIdentifierType: string };
        dateAndPlaceOfBirth?: { dateOfBirth: string; placeOfBirth: string };
      };
      legalPerson?: {
        name: { legalPersonNameIdentifier: [{ legalPersonName: string }] };
        legalPersonRegistrationNumber?: string;
      };
    }[];
    accountNumber: string[];  // 가상자산 주소
  };
  beneficiary: {
    beneficiaryPersons: { /* 동일 구조 */ }[];
    accountNumber: string[];  // 수신 가상자산 주소
  };
  transferredAmount: {
    amount: string;
    currency: string;
  };
}
```

교보생명 Phase 1에서는 단순화된 버전을 사용한다:

```typescript
interface TravelRuleData {
  originatorName: string;   // 성명 (또는 법인명)
  originatorVasp: string;   // VASP 등록번호
  beneficiaryName: string;  // 수신인 실명 (KYC 완료 고객)
  beneficiaryVasp: string;  // 수신 VASP (자체보관이면 동일)
  amount: bigint;           // KRW 단위
  currency: 'KRW';
}
```

### 한국 Travel Rule 솔루션 현황

| 솔루션 | 설명 | 주요 고객 |
|--------|------|-----------|
| CODE (COINONE) | 국내 1위 VASP 연합 솔루션. IVMS101 기반 | 업비트, 빗썸, 코인원 |
| VerifyVASP | 싱가포르 기반, 글로벌 네트워크 | 글로벌 거래소 |
| Notabene | 뉴욕 기반, API 중심 | 기관 고객 |
| 자체 구현 | 소규모 VASP 또는 B2B 특수 케이스 | Phase 1 교보 방식 |

Phase 1에서는 월렛원(VASP)이 CODE에 가입되어 있다면 자동 처리된다. 교보생명이 직접 구현하는 것은 월렛원 API에 `travelRuleData` 필드를 포함해 전달하는 것까지다.

### Travel Rule 미이행 시 실제 제재 사례

- 2022년: 국내 A 거래소, Travel Rule 미이행 → KoFIU 제재 (과태료 + 업무 일부 정지)
- 2023년: FATF 블랙리스트 등재국 → 해당국 VASP와 거래 자체 금지 의무 발생
- Binance: 2023년 미국 FinCEN과 43억 달러 합의 — 주요 위반 중 하나가 Travel Rule 미이행

**강사 코멘트 포인트**: "컴플라이언스 위반은 기술 버그보다 훨씬 비싸다. 버그는 패치하면 되지만 제재는 영업정지다."

---

## 배경 2: EIP-712 SafeTx 해시 계산 완전 이해

### DOMAIN_SEPARATOR 계산 공식

```
DOMAIN_TYPEHASH = keccak256(
  "EIP712Domain(uint256 chainId,address verifyingContract)"
)

DOMAIN_SEPARATOR = keccak256(
  abi.encode(
    DOMAIN_TYPEHASH,
    block.chainid,       // 1=mainnet, 11155111=Sepolia, 31337=hardhat
    address(this)        // Safe 컨트랙트 주소
  )
)
```

`chainId`와 `verifyingContract`가 Domain에 포함되기 때문에:
- 동일 Safe 서명을 다른 체인에서 재사용 불가 (Replay Attack 방지)
- 동일 체인의 다른 Safe에서 재사용 불가

### SafeTx TypeHash 정의

```
SAFE_TX_TYPEHASH = keccak256(
  "SafeTx("
    "address to,"
    "uint256 value,"
    "bytes data,"
    "uint8 operation,"
    "uint256 safeTxGas,"
    "uint256 baseGas,"
    "uint256 gasPrice,"
    "address gasToken,"
    "address refundReceiver,"
    "uint256 nonce"
  ")"
)
```

10개 필드 전부 포함된다. `nonce`가 포함되기 때문에 같은 TX를 Safe의 다른 nonce로 재실행하면 해시가 달라진다.

### 최종 서명 대상 해시 계산 과정

```
Step 1: dataHash = keccak256(safeTx.data)
        // bytes 타입은 먼저 해시한다 (EIP-712 규칙)

Step 2: structHash = keccak256(
          abi.encode(
            SAFE_TX_TYPEHASH,
            safeTx.to,
            safeTx.value,
            dataHash,          // bytes → keccak256
            safeTx.operation,
            safeTx.safeTxGas,
            safeTx.baseGas,
            safeTx.gasPrice,
            safeTx.gasToken,
            safeTx.refundReceiver,
            safeTx.nonce
          )
        )

Step 3: safeTxHash = keccak256(
          abi.encodePacked(
            bytes1(0x19),      // EIP-712 prefix
            bytes1(0x01),      // version
            DOMAIN_SEPARATOR,
            structHash
          )
        )
        // = keccak256("\x19\x01" + domainSeparator + structHash)
```

Safe 컨트랙트는 `execTransaction` 시 이 계산을 온체인에서 재현하고 ecrecover로 서명자 주소를 복원해서 owners 목록과 대조한다.

### ethers.js로 EIP-712 서명하는 방법

```typescript
// 방법 1: ethers v6 _signTypedData (권장)
const signature = await signer.signTypedData(
  // domain
  {
    chainId: 31337,
    verifyingContract: safeAddress,
  },
  // types
  {
    SafeTx: [
      { name: 'to',             type: 'address' },
      { name: 'value',          type: 'uint256' },
      { name: 'data',           type: 'bytes'   },
      { name: 'operation',      type: 'uint8'   },
      { name: 'safeTxGas',      type: 'uint256' },
      { name: 'baseGas',        type: 'uint256' },
      { name: 'gasPrice',       type: 'uint256' },
      { name: 'gasToken',       type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'nonce',          type: 'uint256' },
    ],
  },
  // value (message)
  {
    to:             safeTx.to,
    value:          safeTx.value,
    data:           safeTx.data,
    operation:      safeTx.operation,
    safeTxGas:      safeTx.safeTxGas,
    baseGas:        safeTx.baseGas,
    gasPrice:       safeTx.gasPrice,
    gasToken:       safeTx.gasToken,
    refundReceiver: safeTx.refundReceiver,
    nonce:          safeTx.nonce,
  }
);

// 방법 2: 해시 직접 계산 후 원시 ECDSA 서명
const safeTxHash = computeSafeTxHash(safeTx, safeAddress, chainId);
const sig = wallet.signingKey.sign(safeTxHash);
const signature = ethers.Signature.from(sig).serialized;
```

---

## 배경 3: MultisigService 설계 패턴 깊이

### DB 스키마 완전 버전

```sql
-- MultisigService가 사용하는 핵심 테이블
CREATE TABLE pending_txs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  safe_tx_hash         VARCHAR(66) NOT NULL UNIQUE,  -- EIP-712 SafeTx 해시
  safe_address         VARCHAR(42) NOT NULL,          -- 어느 Safe 컨트랙트
  params               JSONB NOT NULL,                -- SafeTxParams
  status               VARCHAR(32) NOT NULL
                         DEFAULT 'PENDING_SIGNATURES'
                         CHECK (status IN (
                           'PENDING_SIGNATURES',
                           'READY_TO_EXECUTE',
                           'EXECUTED',
                           'CANCELLED'
                         )),
  required_signatures  SMALLINT NOT NULL,            -- Safe threshold
  collected_signatures JSONB NOT NULL DEFAULT '[]',  -- 수집된 서명 배열
  proposed_by          VARCHAR(128) NOT NULL,
  proposed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_tx_hash     VARCHAR(66),                  -- 온체인 TX 해시
  executed_at          TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 빠른 조회 인덱스
CREATE UNIQUE INDEX idx_pending_txs_safe_tx_hash ON pending_txs (safe_tx_hash);
CREATE INDEX idx_pending_txs_status ON pending_txs (status)
  WHERE status IN ('PENDING_SIGNATURES', 'READY_TO_EXECUTE');
CREATE INDEX idx_pending_txs_safe_address ON pending_txs (safe_address);

-- collected_signatures JSONB 구조:
-- [
--   {
--     "signer": "0xAddress...",
--     "signature": "0xrsv...",
--     "signedAt": "2024-01-01T00:00:00Z"
--   }
-- ]
```

### 서명 순서 정렬 — Gnosis Safe의 숨겨진 요구사항

**Safe 컨트랙트는 서명자 주소를 오름차순으로 정렬해야 한다.** 이것을 모르면 실제 실행 시 revert된다.

```
Safe 컨트랙트 내부 checkNSignatures():
  1. 서명들을 순서대로 파싱
  2. 각 서명에서 ecrecover → 서명자 주소 복원
  3. 이전 서명자 주소보다 크야 함 (오름차순 검증)
  4. 위반 시 → revert("GS026: Invalid owner provided")
```

ethers.js에서 정렬하는 방법:

```typescript
function sortSignaturesByAddress(
  signatures: Array<{ signer: string; signature: string }>
): Array<{ signer: string; signature: string }> {
  return [...signatures].sort((a, b) =>
    a.signer.toLowerCase() < b.signer.toLowerCase() ? -1 : 1
  );
}

// execTransaction 직전에 반드시 정렬
const sortedSigs = sortSignaturesByAddress(collectedSigs);
const packedSigs = sortedSigs.map(s => s.signature).join('').replace(/0x/g, '');
const signatureBytes = '0x' + packedSigs;
```

**이것이 실습에서 흔히 발생하는 함정 1번이다.** 2-of-3 서명 모두 모아도 주소 순서가 틀리면 GS026으로 revert된다.

### nonce 관리 — 동시 TX 충돌

```
문제 시나리오:
  TX-A: proposeTx() → nonce=0으로 SafeTx 생성
  TX-B: proposeTx() → nonce=0으로 SafeTx 생성 (동시에)
  
  → 둘 다 nonce=0을 사용하면 해시가 달라짐
  → 먼저 실행된 것이 온체인 확정 → Safe의 nonce가 1이 됨
  → 나중에 실행된 TX는 nonce=0으로 생성됐지만 체인 nonce=1 → revert
```

해결: proposeTx에서 Safe 컨트랙트의 현재 nonce를 조회하고 DB에 락을 걸거나 단조 증가 시퀀스를 사용한다.

```typescript
// proposeTx 내부 nonce 관리
async proposeTx(proposer: string, params: SafeTxParams): Promise<string> {
  // Safe 컨트랙트에서 현재 nonce 조회 (온체인)
  const nonce = await this.safeClient.getNonce();
  
  // DB 트랜잭션으로 atomic하게 처리 (동시 요청 충돌 방지)
  return await this.db.transaction(async (trx) => {
    // nonce 중복 확인
    const existing = await trx.query(
      'SELECT id FROM pending_txs WHERE nonce = $1 AND safe_address = $2 AND status != $3',
      [nonce, this.safeAddress, 'CANCELLED']
    );
    if (existing.rows.length > 0) {
      throw new Error(`Nonce ${nonce} already in use`);
    }
    
    // SafeTx 해시 계산 + DB 저장
    // ...
  });
}
```

### webhook 패턴 — 서명자 알림 발송

서명자들은 각기 다른 조직(교보 IT, 준법감시팀)에 있다. 서명 요청 알림을 보내야 한다.

```typescript
interface SignatureRequestNotification {
  type: 'SIGNATURE_REQUESTED';
  txId: string;
  safeTxHash: string;
  proposer: string;
  requiredSignatures: number;
  collectedSignatures: number;
  txDetails: {
    to: string;
    value: string;     // KRW 환산 표시용
    data: string;      // 디코딩된 함수 이름 포함
    description: string;  // "KyoboNFT upgradeToAndCall 실행 요청"
  };
  deadline?: string;  // ISO 날짜 (선택적 기한)
}

// 알림 채널: 이메일, Slack, SMS, 내부 포털
class Notifier {
  async send(notification: SignatureRequestNotification): Promise<void> {
    await Promise.all([
      this.emailService.send(notification),
      this.slackService.send(notification),
    ]);
  }
}
```

### gasLimit 계산 — Safe 오버헤드

Safe.execTransaction에서 gasLimit을 잘못 설정하면 on-chain 실행 도중 Out of Gas로 revert된다.

```
총 필요 가스 = 내부 TX 실행 가스 + Safe 컨트랙트 오버헤드

오버헤드 구성:
  - 서명 파싱: ~10,000 가스
  - ecrecover (서명자당): ~3,000 가스
  - 스토리지 업데이트 (nonce 등): ~20,000 가스
  - 기본 트랜잭션 비용: ~21,000 가스

Safe SDK가 자동 추정하지만, 복잡한 내부 TX는 수동으로 여유분(+20%)을 더한다.

실제 계산:
  estimatedGas = await provider.estimateGas(safeTxCall);
  safeTxGas = estimatedGas * 120n / 100n;  // 20% 여유
```

---

## 배경 4: 실제 구현 시 함정 목록

### 함정 1: 서명 순서 오류 (GS026)

증상: 2-of-3 서명 모두 완료 후 execTransaction → revert("GS026")
원인: Safe 컨트랙트가 서명자 주소 오름차순 정렬을 요구하는데 무작위 순서로 전달
해결: `sortSignaturesByAddress()` 함수로 execTransaction 직전 정렬

### 함정 2: nonce 충돌

증상: TX-A 실행 후 TX-B 실행 시 revert
원인: 두 TX 모두 같은 nonce로 생성됨
해결: proposeTx 시 Safe.getNonce() 조회 후 DB 락으로 중복 방지

### 함정 3: threshold 미달 시 가스 낭비

증상: 서명 1개로 executeTx 호출 → 가스 낭비 후 revert(GS020)
원인: 서비스 레이어 검증 없이 바로 Safe.execTransaction 호출
해결: executeTx 내부에서 DB status를 먼저 확인하고 READY_TO_EXECUTE가 아니면 즉시 에러

### 함정 4: bytes 타입 이중 해시

증상: SafeTx 해시가 Safe SDK와 다르게 계산됨
원인: EIP-712에서 bytes 타입은 keccak256(data) 후 abi.encode에 넣어야 하는데 raw bytes를 직접 넣음
해결: `dataHash = keccak256(data)` 후 structHash encode에 포함

### 함정 5: 중복 서명자 가중 카운팅

증상: 서명자 A가 두 번 서명 → threshold 2 충족으로 판정 → READY_TO_EXECUTE
원인: 중복 서명 체크 로직 부재
해결: addSignature 시 기존 서명자 목록에 동일 주소 있으면 DuplicateSignatureError

---

---

# [강의]

---

## 개요 (10분)

### 지금까지 배운 것과 오늘 할 것

```
S46 (M8): Gnosis Safe 2-of-3 배포
          └─ threshold=2, 서명자 3명 설정
          └─ SafeTx 구조 이해

S47 (M8): EIP-712 오프체인 서명 원리
          └─ domainSeparator + structHash + "\x19\x01" prefix
          └─ 서명자별 오프체인 서명 → DB 저장 → 온체인 실행 흐름

S48 (M8): MultisigService 구현 (DB 레이어 + 상태머신)
          └─ PENDING_SIGNATURES → READY_TO_EXECUTE → EXECUTED

M9 S47 [오늘]:
          └─ MultisigService 인터페이스 재확인
          └─ proposeTx / addSignature / executeTx 구현 완성
          └─ checkTravelRule 구현 (100만원 임계값)
          └─ 완료 기준 테스트 전체 통과
```

### 오늘 완성해야 하는 인터페이스

```typescript
interface IMultisigService {
  // SafeTx 해시 계산 + DB 저장 → safeTxHash 반환
  proposeTx(to: string, data: string, value: bigint): Promise<string>;
  
  // 오프체인 서명 수집 → DB 저장
  addSignature(safeTxHash: string, signature: string): Promise<void>;
  
  // 서명 수 threshold 확인 → Safe 온체인 실행
  executeTx(safeTxHash: string): Promise<TransactionReceipt>;
  
  // 100만원 이상 시 TravelRuleRequired throw
  checkTravelRule(amount: bigint): Promise<void>;
}
```

### 완료 기준 (오늘 수업 끝날 때 반드시 통과)

| 기준 | 방법 |
|------|------|
| 1-of-3 서명 → executeTx → revert | 서비스 레이어 차단 + Safe revert 모두 확인 |
| 2-of-3 서명 → executeTx → 정상 실행 | Safe.execTransaction 호출 성공 |
| 999,999원 → checkTravelRule 통과 | 에러 없음 |
| 1,000,000원 → TravelRuleRequired | 정확한 에러 타입 throw |

---

## 실습 (50분)

### 실습 구성

```
실습 A (15분): proposeTx + addSignature 구현
실습 B (15분): executeTx 구현 + 1-of-3 revert / 2-of-3 실행 확인
실습 C (10분): checkTravelRule 구현 + 경계값 테스트
실습 D (10분): 전체 통합 흐름 실행 + 완료 기준 통과 확인
```

---

### 실습 A: proposeTx + addSignature 구현 (15분)

**목표**: SafeTx 해시 계산 → DB 저장 → 서명 수집

**시간표 (15분)**:
- 0~3분: 코드 스켈레톤 확인 + 의존성 확인
- 3~10분: proposeTx 구현
- 10~15분: addSignature 구현

#### 전체 타입 정의 먼저 확인

```typescript
// src/governance/MultisigService.ts

import { ethers, TransactionReceipt } from 'ethers';
import Safe, { EthersAdapter } from '@safe-global/protocol-kit';

// ── 타입 정의 ─────────────────────────────────────────────────────

export interface SafeTxParams {
  to: string;      // 실행 대상 컨트랙트 주소
  data: string;    // ABI-encoded 함수 호출 데이터 (0x...)
  value: bigint;   // ETH 전송량 (KRW 환산용으로도 사용)
  operation: 0 | 1;  // 0=CALL, 1=DELEGATECALL
}

export interface SignatureEntry {
  signer: string;     // 서명자 지갑 주소 (소문자 정규화)
  signature: string;  // 0x + r(32) + s(32) + v(1) = 65바이트 hex
  signedAt: Date;
}

export type PendingTxStatus =
  | 'PENDING_SIGNATURES'
  | 'READY_TO_EXECUTE'
  | 'EXECUTED'
  | 'CANCELLED';

export interface PendingTxRecord {
  id: string;
  safeTxHash: string;
  params: SafeTxParams;
  status: PendingTxStatus;
  requiredSignatures: number;
  collectedSignatures: SignatureEntry[];
  proposedAt: Date;
  executedTxHash?: string;
}

export class TravelRuleRequiredError extends Error {
  constructor(public readonly amount: bigint) {
    super(
      `Travel Rule 이행 필요: ${amount.toLocaleString()}원` +
      ` (기준: 1,000,000원 이상)`
    );
    this.name = 'TravelRuleRequiredError';
  }
}

export class DuplicateSignatureError extends Error {
  constructor(signer: string) {
    super(`이미 서명한 주소입니다: ${signer}`);
    this.name = 'DuplicateSignatureError';
  }
}

export class ThresholdNotMetError extends Error {
  constructor(collected: number, required: number) {
    super(
      `서명 부족: ${collected}/${required} — ` +
      `executeTx는 threshold 충족 후에만 가능합니다`
    );
    this.name = 'ThresholdNotMetError';
  }
}
```

#### proposeTx 구현

```typescript
// ── 내부 인메모리 DB (실습용) ─────────────────────────────────────

// 실제 운영에서는 PostgreSQL. 실습에서는 Map으로 대체한다.
// 핵심 로직 이해에 집중.
const db = new Map<string, PendingTxRecord>();

// ── MultisigService 구현 ──────────────────────────────────────────

export class MultisigService implements IMultisigService {
  private static readonly TRAVEL_RULE_THRESHOLD = BigInt(1_000_000);

  constructor(
    private readonly safe: Safe,           // @safe-global/protocol-kit
    private readonly threshold: number,    // Safe 컨트랙트 threshold (2)
    private readonly owners: string[],     // Safe 서명자 주소 목록
  ) {}

  // ── [A-1] proposeTx ────────────────────────────────────────────

  async proposeTx(
    to: string,
    data: string,
    value: bigint,
  ): Promise<string> {
    // [1] Safe SDK로 SafeTx 구조체 생성
    //     Safe SDK가 내부적으로:
    //     - Safe 컨트랙트의 현재 nonce 조회 (온체인)
    //     - SafeTx 구조체 조립
    const safeTransaction = await this.safe.createTransaction({
      transactions: [{
        to,
        value: value.toString(),
        data,
        operation: 0,  // CALL
      }],
    });

    // [2] EIP-712 SafeTx 해시 계산
    //     내부적으로: keccak256("\x19\x01" + domainSeparator + structHash)
    const safeTxHash = await this.safe.getTransactionHash(safeTransaction);

    // [3] DB에 PENDING_SIGNATURES 상태로 저장
    const record: PendingTxRecord = {
      id: safeTxHash,          // safeTxHash를 ID로 사용 (이미 유일함)
      safeTxHash,
      params: { to, data, value, operation: 0 },
      status: 'PENDING_SIGNATURES',
      requiredSignatures: this.threshold,
      collectedSignatures: [],
      proposedAt: new Date(),
    };

    // 중복 제안 방지 (같은 내용 + nonce → 같은 해시)
    if (db.has(safeTxHash)) {
      throw new Error(`이미 제안된 TX입니다: ${safeTxHash}`);
    }
    db.set(safeTxHash, record);

    console.log(`[proposeTx] TX 제안 완료`);
    console.log(`  safeTxHash : ${safeTxHash}`);
    console.log(`  to         : ${to}`);
    console.log(`  value      : ${value.toLocaleString()}원`);
    console.log(`  threshold  : ${this.threshold}-of-${this.owners.length}`);
    console.log(`  status     : PENDING_SIGNATURES`);

    return safeTxHash;
  }

  // ── [A-2] addSignature ──────────────────────────────────────────

  async addSignature(
    safeTxHash: string,
    signature: string,
  ): Promise<void> {
    // [1] DB에서 pending TX 조회
    const record = db.get(safeTxHash);
    if (!record) {
      throw new Error(`TX를 찾을 수 없습니다: ${safeTxHash}`);
    }

    // [2] 상태 확인: PENDING_SIGNATURES만 서명 가능
    if (record.status !== 'PENDING_SIGNATURES') {
      throw new Error(
        `서명 불가 상태: ${record.status}. PENDING_SIGNATURES 상태에서만 가능합니다.`
      );
    }

    // [3] ecrecover로 서명자 주소 복원
    //     서명이 실제로 어떤 주소의 서명인지 확인
    const recoveredSigner = ethers.recoverAddress(safeTxHash, signature);
    const signerNormalized = recoveredSigner.toLowerCase();

    // [4] 서명자가 Safe owners 목록에 있는지 확인
    const isOwner = this.owners
      .map(o => o.toLowerCase())
      .includes(signerNormalized);

    if (!isOwner) {
      throw new Error(
        `서명자가 Safe owners에 없습니다: ${recoveredSigner}`
      );
    }

    // [5] 중복 서명 방지
    const isDuplicate = record.collectedSignatures.some(
      s => s.signer.toLowerCase() === signerNormalized
    );
    if (isDuplicate) {
      throw new DuplicateSignatureError(recoveredSigner);
    }

    // [6] 서명 추가
    record.collectedSignatures.push({
      signer: recoveredSigner,
      signature,
      signedAt: new Date(),
    });

    // [7] threshold 도달 여부 확인 → 상태 전이
    const collected = record.collectedSignatures.length;
    const required = record.requiredSignatures;

    if (collected >= required) {
      record.status = 'READY_TO_EXECUTE';
      console.log(`[addSignature] threshold 도달! → READY_TO_EXECUTE`);
      console.log(`  서명자: ${recoveredSigner}`);
      console.log(`  서명 수: ${collected}/${required}`);
    } else {
      console.log(`[addSignature] 서명 추가됨 (${collected}/${required})`);
      console.log(`  서명자: ${recoveredSigner}`);
    }

    db.set(safeTxHash, record);
  }
```

---

### 실습 B: executeTx 구현 + 실행 검증 (15분)

**목표**: 서명 수 확인 → 서명 정렬 → Safe.execTransaction 온체인 실행

**시간표 (15분)**:
- 0~8분: executeTx 구현 (서명 정렬 포함)
- 8~12분: 1-of-3 서명 → revert 확인
- 12~15분: 2-of-3 서명 → 정상 실행 확인

```typescript
  // ── [B] executeTx ──────────────────────────────────────────────

  async executeTx(safeTxHash: string): Promise<TransactionReceipt> {
    // [1] DB 조회
    const record = db.get(safeTxHash);
    if (!record) {
      throw new Error(`TX를 찾을 수 없습니다: ${safeTxHash}`);
    }

    // [2] 상태 확인 — 서비스 레이어에서 먼저 차단
    //     이유: 온체인 TX는 가스비가 발생한다.
    //     READY_TO_EXECUTE가 아니면 어차피 Safe가 GS020으로 revert하지만,
    //     서비스에서 먼저 막아서 불필요한 가스 낭비를 방지한다.
    if (record.status !== 'READY_TO_EXECUTE') {
      const collected = record.collectedSignatures.length;
      const required = record.requiredSignatures;
      throw new ThresholdNotMetError(collected, required);
    }

    // [3] 서명 정렬 (중요!)
    //     Gnosis Safe 컨트랙트는 서명자 주소를 오름차순으로 정렬해야 한다.
    //     어기면 → revert("GS026: Invalid owner provided")
    const sortedSigs = [...record.collectedSignatures].sort((a, b) =>
      a.signer.toLowerCase() < b.signer.toLowerCase() ? -1 : 1
    );

    console.log(`[executeTx] 서명 정렬 완료 (주소 오름차순)`);
    sortedSigs.forEach((s, i) => {
      console.log(`  [${i}] ${s.signer}`);
    });

    // [4] Safe SDK로 SafeTx 재구성 + 서명 첨부
    const safeTransaction = await this.safe.createTransaction({
      transactions: [{
        to:        record.params.to,
        value:     record.params.value.toString(),
        data:      record.params.data,
        operation: record.params.operation,
      }],
    });

    // 정렬된 서명들을 Safe 트랜잭션에 첨부
    for (const sig of sortedSigs) {
      safeTransaction.addSignature({
        signer: sig.signer,
        data:   sig.signature,
        isContractSignature: false,
      });
    }

    // [5] 온체인 실행 (가스 발생 — 이 시점에서만 블록체인과 통신)
    console.log(`[executeTx] Safe.execTransaction 호출 중...`);
    const executeTxResponse = await this.safe.executeTransaction(safeTransaction);
    const receipt = await executeTxResponse.transactionResponse?.wait();

    if (!receipt) {
      throw new Error('트랜잭션 receipt를 받지 못했습니다');
    }

    // [6] DB 상태 업데이트
    record.status = 'EXECUTED';
    record.executedTxHash = receipt.hash;
    db.set(safeTxHash, record);

    console.log(`[executeTx] 온체인 실행 성공!`);
    console.log(`  onChainTxHash : ${receipt.hash}`);
    console.log(`  blockNumber   : ${receipt.blockNumber}`);
    console.log(`  status        : EXECUTED`);

    return receipt;
  }
```

#### 1-of-3 서명 → revert 확인 테스트

```typescript
// test/multisig/executeTx.test.ts

describe('executeTx — threshold 검증', () => {
  let service: MultisigService;
  let safe: Safe;
  let signerA: ethers.Wallet;
  let signerB: ethers.Wallet;
  let signerC: ethers.Wallet;

  before(async () => {
    // S46에서 배포한 Safe 사용 (2-of-3)
    const [accountA, accountB, accountC] = await ethers.getSigners();
    signerA = accountA as ethers.Wallet;
    signerB = accountB as ethers.Wallet;
    signerC = accountC as ethers.Wallet;

    safe = await Safe.create({
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

    service = new MultisigService(
      safe,
      2,  // threshold
      [
        await signerA.getAddress(),
        await signerB.getAddress(),
        await signerC.getAddress(),
      ],
    );
  });

  // ── 케이스 1: 1-of-3 서명 → revert ─────────────────────────────

  it('1-of-3 서명으로 executeTx → ThresholdNotMetError (서비스 레이어 차단)', async () => {
    // proposeTx: 빈 TX 제안 (테스트용)
    const safeTxHash = await service.proposeTx(
      await signerA.getAddress(),  // to: self
      '0x',                        // data: empty
      0n,                          // value: 0
    );

    // signerA만 서명 (1-of-3)
    const sigA = signerA.signingKey.sign(safeTxHash);
    await service.addSignature(
      safeTxHash,
      ethers.Signature.from(sigA).serialized
    );

    // executeTx 시도 → ThresholdNotMetError (서비스 레이어에서 차단)
    // Safe.execTransaction 호출조차 되지 않음 → 가스 낭비 없음
    await expect(
      service.executeTx(safeTxHash)
    ).rejects.toThrow(ThresholdNotMetError);

    console.log('1-of-3 서명: ThresholdNotMetError 발생 확인 (서비스 레이어 차단)');
    console.log('Safe.execTransaction은 호출되지 않음 (가스 절약)');
  });

  // ── 케이스 2: 2-of-3 서명 → 정상 실행 ──────────────────────────

  it('2-of-3 서명으로 executeTx → 정상 온체인 실행', async () => {
    const safeTxHash = await service.proposeTx(
      await signerA.getAddress(),
      '0x',
      0n,
    );

    // signerA 서명
    const sigA = signerA.signingKey.sign(safeTxHash);
    await service.addSignature(
      safeTxHash,
      ethers.Signature.from(sigA).serialized
    );

    // signerB 서명 (2-of-3 충족 → READY_TO_EXECUTE)
    const sigB = signerB.signingKey.sign(safeTxHash);
    await service.addSignature(
      safeTxHash,
      ethers.Signature.from(sigB).serialized
    );

    // executeTx → 온체인 실행
    const receipt = await service.executeTx(safeTxHash);

    // 검증
    expect(receipt.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receipt.status).toBe(1);  // 1=성공

    console.log('2-of-3 서명: 정상 실행 확인');
    console.log('onChainTxHash:', receipt.hash);
    console.log('blockNumber:', receipt.blockNumber);
  });

  // ── 케이스 3: 서명 0개로 executeTx → revert ────────────────────

  it('서명 없이 executeTx → ThresholdNotMetError', async () => {
    const safeTxHash = await service.proposeTx(
      await signerA.getAddress(),
      '0x',
      0n,
    );

    // 서명 수집 없이 바로 실행 시도
    await expect(
      service.executeTx(safeTxHash)
    ).rejects.toThrow(ThresholdNotMetError);
  });

  // ── 케이스 4: 이미 EXECUTED → 재실행 불가 ──────────────────────

  it('EXECUTED 상태 TX 재실행 → 에러', async () => {
    const safeTxHash = await service.proposeTx(
      await signerA.getAddress(),
      '0x',
      0n,
    );

    const sigA = signerA.signingKey.sign(safeTxHash);
    await service.addSignature(safeTxHash, ethers.Signature.from(sigA).serialized);
    const sigB = signerB.signingKey.sign(safeTxHash);
    await service.addSignature(safeTxHash, ethers.Signature.from(sigB).serialized);

    await service.executeTx(safeTxHash);

    // 같은 TX 재실행 시도
    await expect(
      service.executeTx(safeTxHash)
    ).rejects.toThrow(/EXECUTED/);
  });
});
```

---

### 실습 C: checkTravelRule 구현 + 경계값 테스트 (10분)

**목표**: 100만원 임계값 검증 함수 구현 + 경계값 테스트 전부 통과

**시간표 (10분)**:
- 0~4분: checkTravelRule 구현
- 4~10분: 경계값 테스트 실행 + 결과 확인

#### checkTravelRule 구현

```typescript
  // ── [C] checkTravelRule ─────────────────────────────────────────

  async checkTravelRule(amount: bigint): Promise<void> {
    // 특금법 §8의4: 100만원(1,000,000 KRW) 이상 이전 시 Travel Rule 적용
    //
    // 경계값 분석:
    //   amount < 1,000,000   → 통과 (Travel Rule 불요)
    //   amount >= 1,000,000  → TravelRuleRequired throw
    //
    // ">=" 이유: 법령 문언 "100만원 이상" → 100만원 포함
    //           "초과(>)"가 아님

    if (amount >= MultisigService.TRAVEL_RULE_THRESHOLD) {
      throw new TravelRuleRequiredError(amount);
    }

    // 100만원 미만: 정상 반환 (에러 없음)
    console.log(
      `[checkTravelRule] ${amount.toLocaleString()}원 — ` +
      `Travel Rule 불필요 (100만원 미만)`
    );
  }
```

#### 경계값 테스트

```typescript
// test/multisig/travelRule.test.ts

import { MultisigService, TravelRuleRequiredError } from '../../src/governance/MultisigService';

describe('checkTravelRule — 특금법 §8의4 100만원 임계값', () => {

  let service: MultisigService;

  before(() => {
    // checkTravelRule은 Safe에 의존하지 않으므로 mock으로 생성
    service = new MultisigService(
      null as any,  // Safe mock (checkTravelRule에서 미사용)
      2,
      [],
    );
  });

  // ── 임계값 미만: 통과 ─────────────────────────────────────────

  it('0원 → 통과', async () => {
    await expect(service.checkTravelRule(0n)).resolves.toBeUndefined();
  });

  it('1원 → 통과', async () => {
    await expect(service.checkTravelRule(1n)).resolves.toBeUndefined();
  });

  it('500,000원 → 통과', async () => {
    await expect(service.checkTravelRule(500_000n)).resolves.toBeUndefined();
  });

  it('999,999원 → 통과 (임계값 직전)', async () => {
    // 핵심 경계값: 1원 차이로 Travel Rule 미적용
    await expect(service.checkTravelRule(999_999n)).resolves.toBeUndefined();
  });

  // ── 임계값: TravelRuleRequired ────────────────────────────────

  it('1,000,000원 → TravelRuleRequired (임계값 정확히)', async () => {
    // 핵심 경계값: >= 이므로 100만원 정확히도 해당
    await expect(
      service.checkTravelRule(1_000_000n)
    ).rejects.toThrow(TravelRuleRequiredError);
  });

  it('1,000,001원 → TravelRuleRequired', async () => {
    await expect(
      service.checkTravelRule(1_000_001n)
    ).rejects.toThrow(TravelRuleRequiredError);
  });

  it('5,000,000원 → TravelRuleRequired', async () => {
    await expect(
      service.checkTravelRule(5_000_000n)
    ).rejects.toThrow(TravelRuleRequiredError);
  });

  it('MaxBigInt → TravelRuleRequired', async () => {
    await expect(
      service.checkTravelRule(BigInt(Number.MAX_SAFE_INTEGER))
    ).rejects.toThrow(TravelRuleRequiredError);
  });

  // ── 에러 메시지 검증 ──────────────────────────────────────────

  it('TravelRuleRequiredError 메시지에 금액 포함', async () => {
    try {
      await service.checkTravelRule(1_500_000n);
      throw new Error('에러가 발생해야 합니다');
    } catch (e) {
      expect(e).toBeInstanceOf(TravelRuleRequiredError);
      expect((e as TravelRuleRequiredError).amount).toBe(1_500_000n);
      expect((e as Error).message).toContain('1,500,000');
    }
  });

  // ── 경계값 표 (강사용 설명 자료) ─────────────────────────────

  /*
  ┌──────────────┬──────────────────────┬─────────────────────────────┐
  │    금액       │      결과             │          이유                │
  ├──────────────┼──────────────────────┼─────────────────────────────┤
  │          0원 │ 통과                  │ 0 < 1,000,000               │
  │    500,000원 │ 통과                  │ 500,000 < 1,000,000         │
  │    999,999원 │ 통과 (임계값 직전)    │ 999,999 < 1,000,000         │
  │  1,000,000원 │ TravelRuleRequired    │ 1,000,000 >= 1,000,000 (포함)│
  │  1,000,001원 │ TravelRuleRequired    │ 1,000,001 >= 1,000,000      │
  │  5,000,000원 │ TravelRuleRequired    │ 5,000,000 >= 1,000,000      │
  └──────────────┴──────────────────────┴─────────────────────────────┘

  핵심 질문: 왜 1,000,000원도 포함인가?
  답: 법령 문언 "100만원 이상" → 수학적으로 amount >= 1,000,000
      "초과(>)"가 아니라 "이상(>=)". 100만원 딱 맞으면 적용.
  */
});
```

---

### 실습 D: 전체 통합 흐름 실행 (10분)

**목표**: 제안 → 서명 → 실행 → Travel Rule 전체 흐름을 한 번에 실행해서 완료 기준 통과 확인

```typescript
// test/multisig/integration.test.ts

describe('MultisigService 완료 기준 통합 확인', () => {

  // ── [완료 기준 1] 1-of-3 서명 대형 TX → revert ────────────────

  it('[완료기준 1] 1-of-3 서명으로 executeTx → ThresholdNotMetError', async () => {
    const service = await setupMultisigService();
    const { signerA, signerB, signerC } = await getSigners();

    // 대형 TX: KyoboNFT upgradeToAndCall (고위험 거버넌스 TX)
    const upgradeData = kyoboNFT.interface.encodeFunctionData(
      'upgradeToAndCall',
      [newImplementationAddress, '0x']
    );

    const safeTxHash = await service.proposeTx(
      await kyoboNFT.getAddress(),
      upgradeData,
      0n,
    );

    // signerA만 서명
    const sigA = signerA.signingKey.sign(safeTxHash);
    await service.addSignature(
      safeTxHash,
      ethers.Signature.from(sigA).serialized
    );

    // 실행 시도 → ThresholdNotMetError
    await expect(
      service.executeTx(safeTxHash)
    ).rejects.toThrow(ThresholdNotMetError);

    // Safe.execTransaction은 호출되지 않음 (온체인 확인)
    // → 업그레이드 실행 안 됨, 이전 구현 그대로 유지
    const currentImpl = await upgrades.erc1967.getImplementationAddress(
      await kyoboNFT.getAddress()
    );
    expect(currentImpl).not.toBe(newImplementationAddress);
    console.log('[완료기준 1] 1-of-3 서명 → revert 확인');
  });

  // ── [완료 기준 2] 2-of-3 서명 → 정상 실행 ─────────────────────

  it('[완료기준 2] 2-of-3 서명으로 executeTx → 정상 실행', async () => {
    const service = await setupMultisigService();
    const { signerA, signerB } = await getSigners();

    // 동일 TX 제안
    const upgradeData = kyoboNFT.interface.encodeFunctionData(
      'upgradeToAndCall',
      [newImplementationAddress, '0x']
    );

    const safeTxHash = await service.proposeTx(
      await kyoboNFT.getAddress(),
      upgradeData,
      0n,
    );

    // signerA 서명
    const sigA = signerA.signingKey.sign(safeTxHash);
    await service.addSignature(safeTxHash, ethers.Signature.from(sigA).serialized);

    // signerB 서명 (2-of-3 충족)
    const sigB = signerB.signingKey.sign(safeTxHash);
    await service.addSignature(safeTxHash, ethers.Signature.from(sigB).serialized);

    // 실행 → 정상
    const receipt = await service.executeTx(safeTxHash);

    expect(receipt.status).toBe(1);
    expect(receipt.hash).toMatch(/^0x/);
    console.log('[완료기준 2] 2-of-3 서명 → 정상 실행 확인');
    console.log('  txHash:', receipt.hash);
  });

  // ── [완료 기준 3] checkTravelRule 경계값 ──────────────────────

  it('[완료기준 3] 999,999원 → checkTravelRule 통과', async () => {
    const service = await setupMultisigService();

    await expect(
      service.checkTravelRule(999_999n)
    ).resolves.toBeUndefined();

    console.log('[완료기준 3-a] 999,999원 → 통과 확인');
  });

  it('[완료기준 3] 1,000,000원 → TravelRuleRequired', async () => {
    const service = await setupMultisigService();

    await expect(
      service.checkTravelRule(1_000_000n)
    ).rejects.toThrow(TravelRuleRequiredError);

    console.log('[완료기준 3-b] 1,000,000원 → TravelRuleRequired 확인');
  });

  // ── [전체 흐름] proposeTx → addSignature×2 → executeTx ────────

  it('[전체 흐름] 제안 → 2-of-3 서명 → Travel Rule 체크 → 실행', async () => {
    const service = await setupMultisigService();
    const { signerA, signerB } = await getSigners();

    // 1. 100만원 이상 TX → Travel Rule 확인 먼저
    const amount = 1_500_000n;
    await expect(service.checkTravelRule(amount)).rejects.toThrow(TravelRuleRequiredError);
    // → 실제 시스템에서는 여기서 travelRuleData를 첨부하고 진행

    // 2. proposeTx (value는 0 — ETH 이전 없이 함수 호출만)
    const pauseData = kyoboNFT.interface.encodeFunctionData('pause', []);
    const safeTxHash = await service.proposeTx(
      await kyoboNFT.getAddress(),
      pauseData,
      0n,
    );

    // 3. 2-of-3 서명 수집
    const sigA = signerA.signingKey.sign(safeTxHash);
    await service.addSignature(safeTxHash, ethers.Signature.from(sigA).serialized);

    const sigB = signerB.signingKey.sign(safeTxHash);
    await service.addSignature(safeTxHash, ethers.Signature.from(sigB).serialized);

    // 4. 실행
    const receipt = await service.executeTx(safeTxHash);
    expect(receipt.status).toBe(1);

    // 5. KyoboNFT pause 상태 확인
    const paused = await kyoboNFT.paused();
    expect(paused).toBe(true);

    console.log('[전체 흐름] 완료');
    console.log('  safeTxHash:', safeTxHash);
    console.log('  onChainTx:', receipt.hash);
    console.log('  KyoboNFT.paused():', paused);
  });
});
```

---

## 50분 수업 시간표

| 시간 | 내용 | 강사 행동 |
|------|------|-----------|
| 0~10분 | 개요: 지금까지 흐름 정리 + 오늘 목표 + 완료 기준 | 슬라이드 없이 칠판/화이트보드에 흐름 그리기 |
| 10~15분 | proposeTx 구현 설명 + Safe SDK getTransactionHash 원리 | 코드 라이브 설명 |
| 15~20분 | proposeTx 구현 실습 | 수강생 타이핑 |
| 20~22분 | addSignature 설계 설명: ecrecover + 중복 방지 | 설명 |
| 22~27분 | addSignature 구현 실습 | 수강생 타이핑 |
| 27~32분 | executeTx 구현: 서명 정렬(GS026 함정) + 온체인 실행 | 함정 강조하며 설명 |
| 32~37분 | 1-of-3 서명 → revert 테스트 실행 확인 | 수강생 테스트 실행 |
| 37~42분 | 2-of-3 서명 → 정상 실행 테스트 확인 | 수강생 테스트 실행 |
| 42~47분 | checkTravelRule 구현 + 경계값 테스트 (999,999 / 1,000,000) | 법적 근거 1분 설명 후 구현 |
| 47~50분 | 전체 통합 테스트 실행 + 완료 기준 확인 | 테스트 결과 화면 공유 |

---

## 완료 기준

```
실습 종료 시 아래 3가지를 모두 통과해야 세션 완료:
```

| # | 기준 | 확인 방법 |
|---|------|-----------|
| 1 | 1-of-3 서명 대형 TX → ThresholdNotMetError 발생 | 테스트 통과 |
| 2 | 2-of-3 서명 → Safe.execTransaction 정상 실행 (status=1) | 테스트 통과 |
| 3 | 999,999원 → 통과 / 1,000,000원 → TravelRuleRequired | 경계값 테스트 통과 |

```bash
# Hardhat 테스트 실행 명령
npx hardhat test test/multisig/executeTx.test.ts
npx hardhat test test/multisig/travelRule.test.ts
npx hardhat test test/multisig/integration.test.ts

# 전체 통합 실행
npx hardhat test test/multisig/ --reporter verbose
```

---

## 설계 원리 요약 (수업 중 구두 설명용)

```
왜 서명을 오프체인 DB에 저장하는가?
→ Safe 컨트랙트는 execTransaction 시점에만 서명을 받는다.
→ 서명자들이 각자 서명하는 동안 서명을 모아둘 장소가 DB다.
→ DB가 없으면 서명자들이 동시에 온라인이어야 한다 — 비현실적.

왜 서비스 레이어에서 threshold를 먼저 확인하는가?
→ 온체인 TX는 가스비가 발생한다.
→ READY_TO_EXECUTE가 아닌 상태에서 Safe.execTransaction을 호출하면
   Safe가 GS020으로 revert — 가스만 낭비된다.
→ 서비스 레이어에서 먼저 막으면 온체인 호출 자체가 없다.

왜 서명 순서를 정렬해야 하는가?
→ Safe 컨트랙트의 checkNSignatures() 함수가 오름차순을 가정한다.
→ 정렬 안 하면 GS026으로 revert.
→ 실제 버그로 많이 발생한다. 2-of-3 서명 모두 모았는데 실행 안 된다면
   먼저 서명 순서를 의심하라.

왜 100만원 이상이 "이상(>=)"인가?
→ 특금법 §8의4 문언: "100만원에 상당하는 가상자산을 이전하는 경우"
→ "이상" = 100만원 포함. 정확히 100만원도 Travel Rule 적용.
→ ">="로 구현해야 법령 준수.
```

---

> **다음 세션 (S48)**: 미니프로젝트 설계 발표  
> S47에서 완성한 MultisigService를 기반으로, 각자 Phase 1 시스템에 추가할 기능을 설계 발표한다.  
> 예시 주제: NFT 전송 제한 컨트랙트 / Merkle-drop 발행 / 감사 로그 온체인 앵커
