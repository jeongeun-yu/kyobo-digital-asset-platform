# M2 S5 — 온체인 이벤트를 오프체인으로 잡는 법

> Block B — 이벤트 파이프라인 · Day 03 전반 · 90분  
> 대상: `dmz/packages/chain-adapters/src/evm/EVMAdapter.ts`, `dmz/packages/event-engine/src/listener/ChainEventListener.ts`

---

# 이 세션이 답하는 질문

**"블록체인은 push가 없다. 그러면 Core Banking은 NFT 발행 완료를 어떻게 아는가?"**

교보생명 앱 사용자가 걷기 10,000보를 달성한다.  
`NFTIssuer` 컨트랙트가 `mint()`를 실행한다.  
트랜잭션이 블록에 포함된다.  
이 사실을 내부망 Core Banking은 어떻게 알 수 있는가?

이 질문이 이 세션 전체를 관통한다.

---

# 전체 흐름 — 세션 지도

## 사용자 관점: 무슨 일이 벌어지는가

먼저 사용자가 경험하는 흐름부터 본다. 시스템이 왜 이렇게 생겼는지는 이 흐름에서 출발한다.

```
① 교보생명 앱 사용자가 걷기 10,000보를 달성한다.
   앱이 "보상 NFT 발행 요청"을 서버로 전송한다.

② DMZ 서버가 ActivityOracle에 "이 사람이 정말 10,000보 걸었나?" 검증을 요청한다.
   ← 왜? 교보생명 서버가 마음대로 "NFT 줘" 라고 하면 블록체인이 그냥 발행해버리면
      누구나 위조 요청을 보낼 수 있다. 오라클 서명이 "교보 공식 서버가 검증했다"는 증명이다.

③ 검증 통과 → NFTIssuer.issueActivityNFT() 호출
   컨트랙트가 KyoboNFT.mint()를 실행한다.
   이때 NFTIssuer는 Issued 이벤트를 emit한다.
   ← 왜? mint()가 실행됐다는 사실이 블록체인에 기록되지 않으면 나중에 "발행됐나?"를
      확인할 방법이 없다. EVM Log는 변조 불가능한 영수증이다.

④ 블록체인 노드가 이 트랜잭션을 블록에 채굴한다.
   이 순간 Issued 이벤트 Log가 블록체인에 영구히 기록된다.
   ← 여기서 중요한 사실: 블록체인은 이 사실을 누구에게도 "알려주지 않는다."
      노드는 묻는 사람에게만 답한다. 먼저 연락하지 않는다.

⑤ 그렇다면 Core Banking은 어떻게 아는가?
   DMZ 서버가 WebSocket으로 노드에 연결해 "Issued 이벤트 생기면 알려줘" 구독을 걸어놨다.
   ← 이것은 블록체인이 push하는 게 아니다.
      DMZ가 먼저 WebSocket 연결을 열고, 노드가 그 연결을 통해 알린다.
      블록체인 프로토콜에는 push 개념이 없다. WebSocket은 우리가 만든 구독 채널이다.

⑥ EVMAdapter가 이벤트를 수신 → NFTIssuedHandler가 Core Banking에 Webhook으로 알림
   Core Banking이 원장에 기록한다. 사용자가 앱에서 보상을 확인한다.
```

한 줄 요약: **블록체인은 기록만 한다. 읽는 것, 구독하는 것, 알리는 것은 전부 우리 코드가 한다.**

---

## 설계자 관점: 어떤 컴포넌트가 무엇을 하는가

```
[교보생명 앱]
      │ 10,000보 달성 → 발행 요청
      ▼
[DMZ issuer-service]
      │
      ├─ ActivityOracle.verify() ── 오라클 서명 검증
      │                              (위조 요청 차단)
      ▼
[NFTIssuer.issueActivityNFT()]
      │ KyoboNFT.mint() 호출
      │ emit Issued(to, tokenId, activityId)
      ▼
[블록체인 노드]
      │ 블록 채굴 → EVM Log 영구 기록
      │ ← 여기서 블록체인의 역할 끝
      │
      │ (WebSocket 구독 채널 — 우리가 연 것)
      ▼
[EVMAdapter.subscribeEvents()]   ← S5 핵심 구간
      │ Issued 이벤트 수신 + ChainEvent 객체 변환
      ▼
[ChainEventListener._dispatch()]
      │ 매칭 핸들러 호출
      ▼
[NFTIssuedHandler.handle()]      ← S6에서 상세히
      │ 멱등성 확인 → retry → Webhook
      ▼
[Core Banking]
      원장 기록 완료
```

**S5가 답하는 구간**: 블록체인 노드 → EVMAdapter  
"이벤트가 어떤 구조로 기록되는가" + "어떻게 구독해서 받는가"

---

# 1부 — 폴링 vs 이벤트 구독 (25분)

## 1-1. 직관적으로 생각하면 — 폴링

> **강사 멘트**: "블록체인이 push를 못 한다면 우리가 주기적으로 물어보면 되지 않나요? 1초마다 '새 이벤트 있어?'라고 묻는 방식입니다. 코드로 쓰면 이렇습니다."

```typescript
// ──────────────────────────────────────────────
// 절대로 이렇게 구현하지 말 것 — 교육 목적 예시
// ──────────────────────────────────────────────
let lastBlock = 0;

setInterval(async () => {
  const latest = await provider.getBlockNumber();
  if (latest <= lastBlock) return;

  const events = await contract.queryFilter(
    contract.filters.Issued(),
    lastBlock + 1,
    latest,
  );

  for (const event of events) {
    await processEvent(event);  // Core Banking 알림
  }

  lastBlock = latest;
}, 1000);  // 1초마다
```

이 코드가 무엇을 하는지 읽어보자.

1. 1초마다 실행된다.
2. 현재 블록 번호를 가져온다.
3. `lastBlock`보다 새 블록이 있으면 이벤트를 조회한다.
4. 이벤트가 있으면 처리하고, `lastBlock`을 갱신한다.

직관적이다. 그런데 왜 쓰면 안 되는가. 4가지 구체적인 이유가 있다.

---

## 1-2. 폴링의 4가지 문제

### 문제 1 — 지연 (Latency)

Ethereum Sepolia 기준 블록 생성 주기는 **12초**다.  
1초마다 폴링해도 이벤트를 최대 12초 늦게 발견한다.

```
블록  100 생성 (t=0)    → Issued 이벤트 기록
폴링  (t=1초)           → 아직 처리 안 됨
폴링  (t=2초)           → 아직 처리 안 됨
...
폴링  (t=12초)          → 드디어 발견, Core Banking에 알림

고객은 t=0에 NFT를 받았다.
Core Banking이 아는 시점은 t=12초.
이 12초 동안 앱에서는 NFT가 있는데 포인트 시스템엔 없다.
```

> **강사 멘트**: "금융 서비스에서 데이터가 일치하지 않는 시간은 곧 잠재적 민원입니다. '저 NFT 발행됐는데 왜 포인트가 안 들어왔어요?' 고객센터에 전화합니다."

### 문제 2 — 낭비 (Waste)

이벤트가 없을 때도 1초마다 RPC를 호출한다.

```
1초마다 2회 RPC 호출:
  - provider.getBlockNumber()   ← 블록 높이 확인
  - contract.queryFilter(...)   ← 이벤트 조회

24시간 = 86,400초 = 172,800번 RPC 호출

하루에 실제로 발행되는 NFT가 100건이라면:
  - 유효한 호출: 이벤트 포함된 블록 조회 몇 번
  - 낭비 호출: 172,800번 - 실제 호출 = 거의 전부
```

프라이빗 RPC 노드를 운영하더라도 이 트래픽은 불필요한 부하다.

### 문제 3 — 누락 (Missed Events)

**서버가 재시작된다.** 재시작 중인 20초 동안 `setInterval`이 멈춘다.

```
t=0:   서버 종료 (배포, 장애, 재시작)
t=5:   KyoboNFT Issued 이벤트 발생
t=10:  Issued 이벤트 발생
t=15:  Issued 이벤트 발생
t=20:  서버 재시작 완료

→ setInterval 재시작
→ lastBlock이 초기화됨 (메모리에 있었으므로)
→ t=5~15 구간 이벤트는 영원히 처리되지 않는다
```

폴링 방식에는 이 복구 로직이 없다.

> **강사 멘트**: "서버가 재시작하면 `lastBlock` 변수가 사라집니다. DB에 저장하지 않는 한, 재시작 시점의 블록 번호를 다시 알 방법이 없습니다. 이게 폴링의 가장 치명적인 문제입니다."

### 문제 4 — 확장 불가 (Non-scalable)

컨트랙트가 늘어날수록 폴링 횟수가 선형으로 증가한다.

```
Phase 1: KyoboNFT만 감시          → 폴링 2회/초
Phase 2: StablecoinMint 추가      → 폴링 4회/초
Phase 3: STOTransfer 추가         → 폴링 6회/초
Phase 4: ActivityOracle 추가      → 폴링 8회/초
```

사업이 성장할수록 RPC 부하가 직선으로 증가한다.

---

## 1-3. 이벤트 구독 — 노드가 먼저 알려준다

폴링이 "우리가 물어보는 것"이라면, 이벤트 구독은 "노드가 알려주는 것"이다.

```
[블록체인 노드]    [DMZ 서버]
      │               │
      │  WebSocket 연결 수립
      │◄──────────────│
      │               │
      │  "Issued 이벤트 생기면 알려줘"
      │◄──────────────│
      │               │
      │  (이벤트 없는 동안 침묵)
      │               │
      │  이벤트 발생!  │
      │──────────────►│  즉시 push
      │               │  → handler 실행
      │               │  → Core Banking 알림
```

핵심 차이:
- **폴링**: 우리가 1초마다 "새 이벤트 있어?" 요청 → 이벤트 없어도 트래픽 발생
- **구독**: 노드가 이벤트 발생 시 즉시 push → 이벤트 없으면 트래픽 없음

이것을 `EVMAdapter.subscribeEvents()`가 구현한다.

```typescript
// EVMAdapter.ts (172~195줄)
async subscribeEvents(
  contractAddr: string,
  abi: unknown[],
  eventNames: string[],       // 여러 이벤트 동시 구독 가능
  _fromBlock: number,
  handler: (event: ChainEvent) => Promise<void>,
): Promise<() => void> {      // 반환값: unsubscribe 함수

  const iface    = new Interface(abi as string[]);
  const contract = new Contract(contractAddr, iface, this.provider);

  const listeners: Array<() => void> = [];

  for (const eventName of eventNames) {
    const listener = async (...args: unknown[]) => {
      const log = args[args.length - 1] as EventLog;  // 마지막 인자가 Log 객체
      await handler(this._toChainEvent(eventName, contractAddr, log, args));
    };
    contract.on(eventName, listener);  // ← WebSocket 기반 구독
    listeners.push(() => contract.off(eventName, listener));
  }

  // unsubscribe 함수 반환 — 구독 해제 시 호출
  return () => listeners.forEach(off => off());
}
```

`contract.on(eventName, listener)`가 핵심이다.  
ethers.js가 WebSocket을 통해 노드에 `eth_subscribe` 요청을 보낸다.  
이후 이벤트가 발생하면 노드가 WebSocket으로 push하고, `listener`가 즉시 호출된다.

이벤트가 없으면 아무것도 호출되지 않는다. 네트워크 트래픽도 없다.

---

## 1-4. 비교 요약

| 항목 | 폴링 | 이벤트 구독 |
|---|---|---|
| 지연 | 폴링 주기만큼 (최대 12초) | 거의 즉시 (수백 ms) |
| 트래픽 | 이벤트 없어도 발생 | 이벤트 발생 시에만 |
| 재시작 복구 | 불가 (메모리 소실) | 가능 (stateStore + queryEvents) |
| 확장성 | 컨트랙트 수에 비례 | 추가 부하 없음 |
| 구현 복잡도 | 단순 | 약간 복잡 |

폴링은 프로토타입에서나 쓸 수 있다. 운영 금융 시스템에서는 이벤트 구독이 필수다.

---

# 2부 — EVM Log 구조 완전 해부 (30분)

## 2-1. Solidity 이벤트가 블록체인에 기록되는 방법

```bash
cat blockchain/src/phase1/KyoboNFT.sol
```

KyoboNFT.sol에서 Issued 이벤트를 찾는다:

```solidity
// blockchain/src/phase1/KyoboNFT.sol

event Issued(
    address indexed to,       // ← indexed
    uint256 indexed tokenId,  // ← indexed
    bytes32 reason            // ← non-indexed
);

// NFT 발행 시:
function _issue(address to, uint256 tokenId, bytes32 reason) internal {
    _mint(to, tokenId, 1, "");
    emit Issued(to, tokenId, reason);  // ← 이 줄이 EVM Log를 생성한다
}
```

`emit Issued(to, tokenId, reason)`이 실행되면 EVM은 **Log(로그)**를 생성해 해당 블록의 트랜잭션 영수증(Receipt)에 기록한다.

Log는 블록체인에 영구히 보존된다. 삭제할 수 없다. 수정할 수 없다.

---

## 2-2. Log의 물리적 구조

EVM Log는 다음 두 영역으로 구성된다.

```
┌─────────────────────────────────────────────────────────┐
│  Log                                                    │
│                                                         │
│  Topics (배열, 최대 4개)                                 │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Topics[0]: 이벤트 시그니처 해시 (32 bytes)        │   │
│  │ Topics[1]: indexed 파라미터 #1  (32 bytes)        │   │
│  │ Topics[2]: indexed 파라미터 #2  (32 bytes)        │   │
│  │ Topics[3]: indexed 파라미터 #3  (32 bytes)        │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  Data (가변 길이)                                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │ non-indexed 파라미터들 ABI 인코딩 직렬화           │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

`Issued(address indexed to, uint256 indexed tokenId, bytes32 reason)` 이벤트의 실제 Log:

```
Topics[0]: 0x3d4a04291c66b06f39a4ecb817875b12b5485a05ec1ba0a8b623073e3668a8b3
           = keccak256("Issued(address,uint256,bytes32)")
           ← 이 Log가 어떤 이벤트인지 식별하는 고유 ID

Topics[1]: 0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266
           ← to 주소 (20바이트를 32바이트로 왼쪽 제로 패딩)
           ← 실제 값: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

Topics[2]: 0x0000000000000000000000000000000000000000000000000000000000000001
           ← tokenId = 1 (uint256을 32바이트로 빅엔디안 표현)

Data:      0x574f524b494e470000000000000000000000000000000000000000000000000000
           ← reason = bytes32("WALKING")
           ← 0x574f524b494e47 = "WALKING" ASCII
```

---

## 2-3. Topics[0] — 이벤트 식별자의 원리

어떻게 노드는 이 Log가 `Issued` 이벤트임을 아는가?

```
keccak256("Issued(address,uint256,bytes32)")
= 0x3d4a04291c66b06f39a4ecb817875b12b5485a05ec1ba0a8b623073e3668a8b3
```

이것이 Topics[0]에 들어간다.

> **함수 셀렉터와의 차이**:  
> 함수 셀렉터는 `keccak256` 해시의 앞 4바이트만 쓴다.  
> 이벤트 시그니처는 32바이트 전부를 쓴다. 충돌 가능성을 더 낮추기 위해서다.

**실제로 계산해보자:**

```bash
# Node.js에서 검증
node -e "
const { keccak256, toUtf8Bytes } = require('ethers');
console.log(keccak256(toUtf8Bytes('Issued(address,uint256,bytes32)')));
"
# 출력: 0x3d4a04291c66b06f39a4ecb817875b12b5485a05ec1ba0a8b623073e3668a8b3
```

이벤트 이름이 같아도 파라미터 타입이 다르면 Topics[0]이 달라진다:

```solidity
// 다른 컨트랙트의 이벤트
event Issued(address indexed to, uint256 amount);  // 파라미터 다름
// keccak256("Issued(address,uint256)") → 다른 해시
```

노드는 Topics[0]으로 이벤트를 정확히 구별한다.

---

## 2-4. indexed vs non-indexed — 설계 결정

```solidity
event Issued(
    address indexed to,       // ← Topics에 들어감 → 인덱싱됨
    uint256 indexed tokenId,  // ← Topics에 들어감 → 인덱싱됨
    bytes32 reason            // ← Data에 들어감 → 인덱싱 안 됨
);
```

**`indexed`의 의미**: 노드가 해당 필드를 인덱싱한다. 특정 값으로 필터링해서 조회할 수 있다.

```typescript
// indexed 필드로 필터링: "내 주소로 발행된 NFT만 조회"
const myEvents = await contract.queryFilter(
  contract.filters.Issued(myAddress),  // to = myAddress인 이벤트만
);

// indexed이므로 노드가 인덱스를 사용해 빠르게 반환한다
```

**`indexed`가 아닌 필드**: Data 영역에 들어간다. 필터링 불가.

```typescript
// reason으로 필터링하고 싶다면?
// → 불가능. 전체 이벤트를 가져온 후 직접 비교해야 한다.
const all = await contract.queryFilter(contract.filters.Issued());
const walking = all.filter(e => e.args.reason === ethers.keccak256(...));
// → 이벤트가 1,000,000개면 전부 가져온다. 성능 문제 발생.
```

**`indexed` 한계**: 이벤트 하나에 indexed 파라미터는 최대 **3개**다.

```
Topics[0]: 이벤트 시그니처 (예약됨)
Topics[1]: indexed 파라미터 #1  ← 여기까지가 실질적 한계
Topics[2]: indexed 파라미터 #2
Topics[3]: indexed 파라미터 #3
```

Topics는 4개뿐이고, Topics[0]은 시그니처가 차지하므로 나머지 3개가 indexed 파라미터의 상한이다.

**설계 원칙**: 검색·필터링 키로 쓸 필드만 indexed. 조회할 일 없는 데이터는 non-indexed.

```solidity
// 좋은 설계
event Issued(
    address indexed to,       // 수신자로 조회 필요 → indexed
    uint256 indexed tokenId,  // tokenId로 조회 필요 → indexed
    bytes32 reason            // 이유 데이터, 조회 기준 아님 → non-indexed
);

// 나쁜 설계
event Issued(
    address indexed to,
    uint256 indexed tokenId,
    bytes32 indexed reason,   // reason으로 필터링할 일이 없는데 indexed → 낭비
    uint256 amount            // 검색 기준이 될 수도 있는데 non-indexed → 검색 불가
);
```

---

## 2-5. ABI — Log를 읽는 열쇠

노드에서 받은 raw Log를 보면:

```javascript
{
  address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  topics: [
    "0x3d4a04291c66b06f39a4ecb817875b12b5485a05ec1ba0a8b623073e3668a8b3",
    "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "0x0000000000000000000000000000000000000000000000000000000000000001"
  ],
  data: "0x574f524b494e470000000000000000000000000000000000000000000000000000",
  blockNumber: 6,
  transactionHash: "0xabc123...",
  logIndex: 0
}
```

사람이 읽을 수 없다. `0xf39fd6e5...`가 누구인지, `0x574f524b...`가 무엇인지 모른다.

**ABI(Application Binary Interface)**가 있으면:

```typescript
const ABI = [
  "event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason)"
];

// ethers.js의 Interface 클래스가 ABI를 파싱
const iface = new Interface(ABI);
const decoded = iface.decodeEventLog("Issued", log.data, log.topics);

console.log(decoded);
// {
//   to:      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",  ← 주소
//   tokenId: 1n,                                             ← BigInt
//   reason:  "0x574f524b494e4700..."                         ← bytes32 hex
// }
```

ABI는 "이 컨트랙트의 이 이벤트는 이런 필드들을 이 타입으로 가진다"는 설명서다.  
ABI 없이는 Log의 raw 바이트를 해석할 수 없다.

---

## 2-6. EVMAdapter._toChainEvent() — 내부 파싱 로직

```bash
cat dmz/packages/chain-adapters/src/evm/EVMAdapter.ts
# 216~237줄 확인
```

```typescript
// EVMAdapter.ts 216~237줄
private _toChainEvent(
  eventName: string,
  contractAddr: string,
  log: EventLog,      // ethers.js EventLog 객체 (이미 파싱됨)
  args: unknown[],
): ChainEvent {

  const named: Record<string, unknown> = {};

  if (log.fragment) {
    // log.fragment = ABI에서 파싱된 이벤트 정의
    // log.fragment.inputs = [{name: "to", type: "address"}, {name: "tokenId", type: "uint256"}, ...]
    log.fragment.inputs.forEach((input, i) => {
      named[input.name] = log.args?.[i];
      //       ↑ "to"         ↑ "0xf39..."
    });
  }

  return {
    eventName,                  // "Issued"
    contractAddr,               // "0xe7f1725..."
    txHash:      log.transactionHash,  // "0xabc123..."
    blockNumber: log.blockNumber,      // 6
    logIndex:    log.index,            // 0 (같은 TX에서 여러 Log 중 몇 번째)
    args:        Object.keys(named).length ? named : { raw: args },
    //           named가 있으면 {to, tokenId, reason} / 없으면 위치 기반 배열
    raw:         log,           // 원본 Log 객체 (디버깅용)
  };
}
```

**`log.fragment`가 있는 경우와 없는 경우**:

```
contract.on()으로 이벤트 구독 → ethers가 ABI로 자동 파싱 → log.fragment 있음
                                 → named args 사용 가능: event.args.to, event.args.tokenId

ABI 없이 raw log 수신 → log.fragment 없음
                          → { raw: args }로 폴백
                          → event.args[0], event.args[1] (위치 기반)
```

스켈레톤 프로젝트에서는 항상 ABI를 제공하므로 `log.fragment`가 있는 케이스만 다룬다.

---

## 2-7. 전체 파싱 흐름 요약

```
[블록체인 노드] → [raw Log]
                    │
                    │ ethers.js Contract 객체 (ABI 포함)
                    │
                    ▼
              Topics[0] → 이벤트 종류 식별 ("Issued")
              Topics[1] → to 주소 디코드 → "0xf39..."
              Topics[2] → tokenId 디코드 → 1n
              Data      → reason 디코드  → "0x574f..."
                    │
                    │ _toChainEvent()
                    ▼
              ChainEvent {
                eventName:   "Issued",
                contractAddr: "0xe7f1...",
                txHash:       "0xabc...",
                blockNumber:  6,
                logIndex:     0,
                args: {
                  to:      "0xf39...",
                  tokenId: 1n,
                  reason:  "0x574f..."
                }
              }
                    │
                    ▼
              [ChainEventListener._dispatch()]
              [NFTIssuedHandler.handle()]
```

---

# 3부 — EVMAdapter 이벤트 메서드 전체 해부 (15분)

## 3-1. subscribeEvents() — 실시간 구독

```bash
cat dmz/packages/chain-adapters/src/evm/EVMAdapter.ts
# 172~195줄
```

```typescript
// EVMAdapter.ts 172~195줄 전체

async subscribeEvents(
  contractAddr: string,
  abi: unknown[],
  eventNames: string[],   // ["Issued", "Burned"] 복수 구독 가능
  _fromBlock: number,     // 현재는 미사용 (subscribeEvents는 지금부터 구독)
  handler: (event: ChainEvent) => Promise<void>,
): Promise<() => void> {  // unsubscribe 함수를 돌려준다

  // 1. ABI로 Interface 객체 생성
  const iface = new Interface(abi as string[]);

  // 2. Contract 객체 생성 (provider만 있음 → read-only)
  //    ethers가 내부적으로 WebSocket 연결 유지
  const contract = new Contract(contractAddr, iface, this.provider);

  const listeners: Array<() => void> = [];

  // 3. 각 이벤트 이름마다 리스너 등록
  for (const eventName of eventNames) {
    const listener = async (...args: unknown[]) => {
      // args의 마지막 요소가 EventLog 객체
      // 앞의 요소들은 이벤트 파라미터 (to, tokenId, reason, log)
      const log = args[args.length - 1] as EventLog;

      // ChainEvent로 변환 후 핸들러 호출
      await handler(this._toChainEvent(eventName, contractAddr, log, args));
    };

    // 4. ethers.js: eth_subscribe → 노드에 WebSocket 구독 요청
    contract.on(eventName, listener);

    // 5. off 함수를 모아둔다 (나중에 구독 해제 시 사용)
    listeners.push(() => contract.off(eventName, listener));
  }

  // 6. 호출자에게 unsubscribe 함수 반환
  //    ChainEventListener.stop() 시 이것을 호출한다
  return () => listeners.forEach(off => off());
}
```

**`args[args.length - 1]`인 이유**:

ethers.js v6에서 `contract.on('Issued', (to, tokenId, reason, log) => {...})`을 쓰면 파라미터 뒤에 EventLog 객체가 추가로 붙는다. 가변 인자로 받아 마지막 요소를 꺼내는 패턴이다.

**`contract.on()`이 내부에서 하는 일**:

```
1. WebSocket 연결이 없으면 새로 연다 (JsonRpcProvider가 관리)
2. 노드에 eth_subscribe 요청:
   {
     "method": "eth_subscribe",
     "params": ["logs", {
       "address": "0xe7f1...",
       "topics":  ["0x3d4a..."]  ← Topics[0] = 이벤트 시그니처
     }]
   }
3. 노드가 "eth_subscription" 응답으로 구독 ID 반환
4. 이후 노드가 매칭되는 Log를 WebSocket으로 push
```

---

## 3-2. queryEvents() — 과거 이벤트 조회

```typescript
// EVMAdapter.ts 197~214줄

async queryEvents(
  contractAddr: string,
  abi: unknown[],
  eventName: string,   // 한 번에 하나의 이벤트 이름만 (subscribeEvents와 다름)
  fromBlock: number,   // 조회 시작 블록
  toBlock: number,     // 조회 종료 블록
): Promise<ChainEvent[]> {

  const iface    = new Interface(abi as string[]);
  const contract = new Contract(contractAddr, iface, this.provider);

  // eth_getLogs RPC 호출
  // fromBlock~toBlock 범위에서 이 이벤트가 포함된 모든 Log 반환
  const logs = await contract.queryFilter(
    contract.getEvent(eventName),  // 이벤트 필터 객체 생성
    fromBlock,
    toBlock,
  );

  // 각 Log를 ChainEvent로 변환
  return (logs as EventLog[]).map(log =>
    this._toChainEvent(eventName, contractAddr, log, []),
  );
}
```

**`queryFilter` 내부 RPC 호출**:

```
eth_getLogs({
  address: "0xe7f1...",
  topics:  ["0x3d4a..."],  ← Topics[0] 필터
  fromBlock: 100,
  toBlock:   1100,
})
```

**`subscribeEvents` vs `queryEvents` 비교**:

| | subscribeEvents | queryEvents |
|---|---|---|
| 대상 | 미래 이벤트 | 과거 이벤트 |
| 방식 | WebSocket push | HTTP RPC 요청 |
| 호출 시점 | 서버 시작 시 한 번 | 재시작 후 복구 시 반복 |
| 블록 범위 | 지금부터 무한 | 명시적 fromBlock~toBlock |
| 사용처 | 실시간 처리 | Missed Event 복구 |

---

# 실습 1 — 로컬 노드 배포 + 이벤트 실시간 수신 (55분)

## 준비 확인

```bash
# 1. Docker 실행 중인지 확인
docker ps

# 2. 스켈레톤 루트에서 의존성 설치됐는지 확인
ls node_modules 2>/dev/null || echo "npm install 필요"

# 3. blockchain 패키지 의존성
ls blockchain/node_modules 2>/dev/null || echo "blockchain npm install 필요"

# 4. DMZ 패키지 빌드 확인
ls dmz/packages/chain-adapters/dist 2>/dev/null || echo "DMZ 빌드 필요"
```

---

## Step 1 — Hardhat 로컬 노드 구동 (5분)

**터미널 1:**

```bash
docker compose -f infrastructure/docker/docker-compose.yml up hardhat-node
```

출력 예시:
```
hardhat-node_1  | Started HTTP and WebSocket JSON-RPC server at http://0.0.0.0:8545/
hardhat-node_1  |
hardhat-node_1  | Accounts
hardhat-node_1  | ========
hardhat-node_1  | Account #0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (10000 ETH)
hardhat-node_1  | Private Key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
hardhat-node_1  | ...
```

노드가 포트 8545에서 HTTP와 WebSocket을 모두 서비스한다.

> **강사 멘트**: "실제 운영 환경에서는 Sepolia testnet을 사용합니다. 로컬 Hardhat 노드는 트랜잭션을 즉시 채굴하므로 12초 기다릴 필요 없이 블록이 즉시 생성됩니다."

---

## Step 2 — KyoboNFT 컨트랙트 배포 (15분)

**터미널 2:**

```bash
cd blockchain
npm install  # 아직 안 했다면
npx hardhat run scripts/deploy/deploy-phase1.ts --network localhost
```

출력 예시:
```
Deploying with: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

ActivityOracle:       0x5FbDB2315678afecb367f032d93F642f64180aa3
PermissiveCompliance: 0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
KyoboNFT (proxy):    0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
NFTIssuer:           0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
MINTER_ROLE granted to NFTIssuer

── 배포 완료 ────────────────────────────────────────
KYOBO_NFT_PROXY_ADDR=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
NFT_ISSUER_ADDR=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
ORACLE_ADDR=0x5FbDB2315678afecb367f032d93F642f64180aa3

→ .env에 위 주소 기록 후 issuer-service 재시작
```

`.env` 파일에 기록:
```bash
# .env (스켈레톤 루트)
KYOBO_NFT_PROXY_ADDR=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
NFT_ISSUER_ADDR=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
ORACLE_ADDR=0x5FbDB2315678afecb367f032d93F642f64180aa3
EVM_RPC_URL=http://localhost:8545
CHAIN_ID=31337
```

> **강사 멘트**: "배포할 때마다 컨트랙트 주소가 바뀝니다. 새로 배포했으면 반드시 .env도 업데이트해야 합니다. 주소가 틀리면 이벤트를 잡을 수 없습니다."

---

## Step 3 — 이벤트 리스너 직접 작성 (20분)

**터미널 3:**

스켈레톤에는 `scripts/` 폴더가 있다. 여기에 리스너를 작성한다.

```bash
# 스켈레톤 루트에서
cat scripts/listen-events.ts
```

> 파일이 없으면 직접 작성한다:

```typescript
// scripts/listen-events.ts
import { EVMAdapter } from '../dmz/packages/chain-adapters/src/evm/EVMAdapter';
import * as dotenv from 'dotenv';
dotenv.config();

// KyoboNFT Issued 이벤트 ABI
// 컨트랙트 소스에서 정의한 것과 정확히 일치해야 한다
const NFT_ABI = [
  "event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason)"
];

async function main() {
  // 1. EVMAdapter 초기화 (privateKey 없으면 read-only, 구독만 가능)
  const adapter = new EVMAdapter({
    rpcUrl:  process.env.EVM_RPC_URL  ?? 'http://localhost:8545',
    chainId: process.env.CHAIN_ID     ?? '31337',
    // privateKey 없음 → 이벤트 구독만 (트랜잭션 서명 불가)
  });

  // 2. 노드 연결 확인
  const connected = await adapter.isConnected();
  if (!connected) {
    console.error('노드에 연결할 수 없습니다. docker compose 확인.');
    process.exit(1);
  }

  // 3. 현재 블록 번호 확인
  const currentBlock = await adapter.getBlockNumber();
  console.log(`현재 블록: ${currentBlock}`);
  console.log(`컨트랙트: ${process.env.NFT_CONTRACT_ADDR}`);
  console.log('이벤트 리스닝 시작... (Ctrl+C로 종료)\n');

  // 4. 이벤트 구독
  const unsubscribe = await adapter.subscribeEvents(
    process.env.KYOBO_NFT_PROXY_ADDR!,
    NFT_ABI,
    ['Issued'],     // 구독할 이벤트 이름 목록
    currentBlock,   // 지금 블록부터 구독
    async (event) => {
      // 이벤트 발생 시 이 콜백이 호출된다
      console.log('━'.repeat(50));
      console.log('[이벤트 수신!]', new Date().toISOString());
      console.log('  이벤트:      ', event.eventName);
      console.log('  txHash:      ', event.txHash);
      console.log('  blockNumber: ', event.blockNumber);
      console.log('  logIndex:    ', event.logIndex);
      console.log('  수신자(to):  ', event.args.to);
      console.log('  tokenId:     ', event.args.tokenId);
      console.log('  reason:      ', event.args.reason);
      console.log('━'.repeat(50) + '\n');

      // 실제로는 여기서 Core Banking에 알림을 보낸다
      // await notifyCoreBanking(event);
    },
  );

  // 5. 종료 시 구독 해제
  process.on('SIGINT', () => {
    console.log('\n리스너 종료 중...');
    unsubscribe();
    process.exit(0);
  });
}

main().catch(console.error);
```

실행:
```bash
npx ts-node scripts/listen-events.ts
```

출력 (이벤트 발생 전):
```
현재 블록: 3
컨트랙트: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
이벤트 리스닝 시작... (Ctrl+C로 종료)

```

> **학습 포인트**: `unsubscribe` 함수를 받는다. `stop()` 시 반드시 호출해야 WebSocket 연결이 닫힌다. 안 닫으면 프로세스가 종료되지 않거나 메모리 누수가 생긴다.

---

## Step 4 — NFT 발행 트랜잭션 실행 (10분)

리스너(터미널 3)를 켜둔 채로, **터미널 4**에서 NFT를 발행한다.

```bash
# 터미널 4
cd blockchain
npx hardhat run scripts/test-issue.ts --network localhost
```

`scripts/test-issue.ts` 내용:

```typescript
// blockchain/scripts/test-issue.ts
import { ethers } from 'hardhat';

async function main() {
  // Hardhat 기본 계정 2개 사용
  const [deployer, oracleSigner] = await ethers.getSigners();

  console.log('발행 계정:', deployer.address);

  // ActivityOracle 서명 생성
  // (실제 앱에서는 Oracle 서비스가 생성)
  const dataType  = ethers.keccak256(ethers.toUtf8Bytes('ACTIVITY'));
  const value     = 10000n;  // 10,000 걸음
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  const hash = ethers.solidityPackedKeccak256(
    ['bytes32', 'uint256', 'uint256'],
    [dataType, value, timestamp],
  );
  const signature = await oracleSigner.signMessage(ethers.getBytes(hash));

  // NFTIssuer 컨트랙트 호출
  const issuer = await ethers.getContractAt(
    'NFTIssuer',
    process.env.NFT_ISSUER_ADDR!,
  );

  // tokenId 생성 — KyoboNFT.encodeTokenId(productCode, eventCode)
  // ACTIVITY product code = 0x01, eventCode는 임의 시퀀스
  const nft = await ethers.getContractAt('KyoboNFT', process.env.KYOBO_NFT_PROXY_ADDR!);
  const tokenId   = await nft.encodeTokenId(1n, BigInt(Date.now() % 100000));
  const activityId = ethers.keccak256(ethers.toUtf8Bytes(`activity-${Date.now()}`));

  console.log('NFT 발행 중...');
  const tx = await issuer.issueActivityNFT(
    deployer.address,  // 수신자
    tokenId,           // KyoboNFT.encodeTokenId()로 생성
    activityId,        // activityId (bytes32) — reason으로 Issued 이벤트에 포함
    { dataType, value, timestamp, signature },
  );

  const receipt = await tx.wait();
  console.log('발행 완료!');
  console.log('  txHash:      ', tx.hash);
  console.log('  blockNumber: ', receipt.blockNumber);
}

main().catch(console.error);
```

**터미널 4 출력:**
```
발행 계정: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
NFT 발행 중...
발행 완료!
  txHash:      0x7c9b3e2a...
  blockNumber: 4
```

**터미널 3에서 즉시 이벤트 출력:**
```
══════════════════════════════════════════════════
[이벤트 수신!] 2026-04-26T09:30:15.432Z
  이벤트:       Issued
  txHash:       0x7c9b3e2a...
  blockNumber:  4
  logIndex:     0
  수신자(to):   0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  tokenId:      0n
  reason:       0x616374697669747900000000000000000000000000000000000000000000000000
══════════════════════════════════════════════════
```

> **강사 멘트**: "터미널 4에서 `tx.wait()`이 완료되는 순간(블록 채굴), 터미널 3의 리스너가 즉시 이벤트를 받습니다. 폴링이라면 1초 간격으로 확인했겠지만, 구독은 노드가 바로 push합니다."

> **학습 포인트**: `reason`이 hex로 출력된다. `0x616374697669747900...`를 decode하면 `activity`가 나온다. ABI에서 bytes32 타입이므로 hex 그대로 온다. 실제 코드에서 `ethers.toUtf8String(reason)`으로 읽을 수 있다.

---

## Step 5 — Missed Event 복구 확인 (5분)

**리스너(터미널 3)를 종료한다** (Ctrl+C).

**터미널 4에서 NFT 3개 더 발행:**
```bash
npx hardhat run scripts/test-issue.ts --network localhost
npx hardhat run scripts/test-issue.ts --network localhost
npx hardhat run scripts/test-issue.ts --network localhost
```

현재 상황:
- 리스너가 꺼져있는 동안 Issued 이벤트 3개 발생
- 이 이벤트들은 놓쳤다

**`queryEvents`로 복구:**

```bash
cat scripts/recover-events.ts
```

```typescript
// scripts/recover-events.ts
import { EVMAdapter } from '../dmz/packages/chain-adapters/src/evm/EVMAdapter';
import * as dotenv from 'dotenv';
dotenv.config();

const NFT_ABI = [
  "event Issued(address indexed to, uint256 indexed tokenId, bytes32 reason)"
];

async function main() {
  const adapter = new EVMAdapter({
    rpcUrl:  process.env.EVM_RPC_URL ?? 'http://localhost:8545',
    chainId: process.env.CHAIN_ID    ?? '31337',
  });

  // 리스너를 껐던 블록 번호 (이전 실습에서 확인한 값)
  const lastProcessedBlock = 4;
  const currentBlock       = await adapter.getBlockNumber();

  console.log(`스캔 범위: 블록 ${lastProcessedBlock} ~ ${currentBlock}`);
  console.log(`총 ${currentBlock - lastProcessedBlock}블록 스캔 중...\n`);

  const missed = await adapter.queryEvents(
    process.env.KYOBO_NFT_PROXY_ADDR!,
    NFT_ABI,
    'Issued',
    lastProcessedBlock,
    currentBlock,
  );

  if (missed.length === 0) {
    console.log('놓친 이벤트 없음.');
    return;
  }

  console.log(`놓친 이벤트 ${missed.length}개 발견:`);
  missed.forEach((event, i) => {
    console.log(`\n[${i + 1}] 복구된 이벤트`);
    console.log('  txHash:     ', event.txHash);
    console.log('  blockNumber:', event.blockNumber);
    console.log('  to:         ', event.args.to);
    console.log('  tokenId:    ', event.args.tokenId);
  });
}

main().catch(console.error);
```

```bash
npx ts-node scripts/recover-events.ts
```

출력:
```
스캔 범위: 블록 4 ~ 7
총 3블록 스캔 중...

놓친 이벤트 3개 발견:

[1] 복구된 이벤트
  txHash:      0xaaa...
  blockNumber: 5
  to:          0xf39...
  tokenId:     1n

[2] 복구된 이벤트
  txHash:      0xbbb...
  blockNumber: 6
  to:          0xf39...
  tokenId:     2n

[3] 복구된 이벤트
  txHash:      0xccc...
  blockNumber: 7
  to:          0xf39...
  tokenId:     3n
```

> **강사 멘트**: "`queryEvents`가 블록체인 장부에서 과거 이벤트를 정확히 찾아냅니다. 블록체인 데이터는 영구 보존되므로 어떤 시점의 이벤트도 조회할 수 있습니다. `ChainEventListener`는 이것을 자동화합니다."

이것이 `ChainEventListener._recoverMissedEvents()`가 하는 일이다. 직접 손으로 해본 것과 정확히 같은 로직이 내부에 있다.

---

# 핵심 정리

| 개념 | 요점 |
|---|---|
| 폴링 | 지연·낭비·누락·확장불가. 프로토타입에서나 쓴다. |
| 이벤트 구독 | WebSocket push. 이벤트 없을 때 비용 없음. 실시간. |
| `subscribeEvents()` | `contract.on()` → WebSocket `eth_subscribe`. unsubscribe 함수 반환. |
| `queryEvents()` | `contract.queryFilter()` → HTTP `eth_getLogs`. 블록 범위 스캔. |
| Topics[0] | `keccak256(이벤트시그니처)`. 이벤트 종류 식별자. |
| Topics[1~3] | `indexed` 파라미터. 노드가 인덱싱. 필터 조회 가능. |
| Data | non-indexed 파라미터. ABI로만 해석 가능. 필터 불가. |
| ABI | Log의 raw 바이트를 사람이 읽을 형태로 변환하는 설명서. |
| `_toChainEvent()` | `log.fragment.inputs`로 이름 매핑. `ChainEvent` 표준 객체 반환. |

---

# 예상 질문 & 답변

**Q: `subscribeEvents`와 `queryEvents` 둘 다 `Interface`와 `Contract` 객체를 만드는데 중복 아닌가요?**

A: 맞다. 최적화한다면 `Contract` 객체를 캐싱해서 재사용할 수 있다. 스켈레톤에서는 교육적 명확성을 위해 각 메서드에서 새로 만들도록 했다. 운영 코드에서는 생성자에서 `Contract` 맵을 만들어두는 것이 좋다.

---

**Q: `indexed` 파라미터를 3개 다 쓰면 안 되나요? 더 많이 필터링할 수 있잖아요.**

A: 모든 파라미터를 indexed로 만들면 저장 비용이 증가한다. indexed 파라미터는 Topics에 들어가고, Topics는 블룸 필터에도 포함된다. 가스 비용이 non-indexed보다 비싸다. 검색 기준으로 쓸 필드만 indexed로 설계하는 것이 맞다.

---

**Q: WebSocket이 끊기면 어떻게 됩니까?**

A: ethers.js의 `JsonRpcProvider`는 기본적으로 자동 재연결을 시도한다. 그러나 재연결 중에 발생한 이벤트는 구독으로 받지 못한다. 이것이 `stateStore`와 `_recoverMissedEvents()`가 필요한 이유다. 재연결 후 start()를 다시 호출하면 끊긴 구간의 이벤트를 queryEvents로 복구한다.

---

**Q: `logIndex`는 왜 필요한가요?**

A: 하나의 트랜잭션에서 여러 이벤트가 발생할 수 있다. 예를 들어 `mintBatch(100명)`을 호출하면 하나의 TX에서 Issued 이벤트가 100개 나온다. 이 경우 `txHash`는 같고 `logIndex`로 구분된다. `NFTIssuedHandler`의 멱등성 키가 `nft-issued:${txHash}:${logIndex}`인 이유가 여기 있다. txHash만으로는 같은 TX의 이벤트를 구별할 수 없다.

---

**Q: raw Log의 `data` 필드가 16진수인데, `reason: "WALKING"`을 어떻게 인코딩하나요?**

A:
```solidity
// Solidity에서
bytes32 reason = keccak256(abi.encodePacked("WALKING"));
// 또는 직접 문자열을 bytes32로:
bytes32 reason = "WALKING";  // 오른쪽 제로 패딩
```

```typescript
// TypeScript에서 읽을 때
const reasonHex = event.args.reason as string;  // "0x574f524b494e4700..."
const reasonText = ethers.toUtf8String(
  ethers.getBytes(reasonHex).filter(b => b !== 0)  // 오른쪽 zero padding 제거
);
// → "WALKING"
```

스켈레톤의 `NFTIssuedHandler`는 reason을 hex 그대로 Core Banking에 전달한다. Core Banking이 필요에 따라 해석하도록 책임을 넘긴다.

---

**Q: Hardhat 로컬 노드는 블록을 즉시 채굴하는데, 실제 Sepolia는 12초가 걸립니다. 이 차이가 코드에 영향을 줍니까?**

A: 아니다. `contract.on()`과 `contract.queryFilter()`는 블록 생성 속도에 무관하다. Sepolia에서도 블록이 채굴되면 즉시 이벤트를 받는다. 차이는 `tx.wait()`의 대기 시간뿐이다 (로컬: 즉시, Sepolia: ~12초). 이벤트 처리 로직은 동일하다.

---

# 다음 세션 예고 (S6)

S6에서는 `ChainEventListener` 내부 구조를 해부한다.

- `start()`: stateStore에서 마지막 처리 블록 조회 → `_recoverMissedEvents` → `subscribeEvents`
- `_recoverMissedEvents()`: CHUNK=1000 청크 스캔, 각 청크 후 stateStore 갱신
- `_dispatch()`: IEventHandler 필터링, Promise.all 병렬 실행
- stateStore가 왜 메모리가 아닌 DB여야 하는가

그리고 `ChainEventListener`와 `EVMAdapter`를 직접 연결해 실습한다.

---

# 참조 파일

| 파일 | 내용 |
|---|---|
| `blockchain/src/phase1/KyoboNFT.sol` | `Issued` 이벤트 정의 |
| `dmz/packages/chain-adapters/src/interfaces/IBlockchainAdapter.ts` | `ChainEvent`, `subscribeEvents`, `queryEvents` 인터페이스 |
| `dmz/packages/chain-adapters/src/evm/EVMAdapter.ts` | `subscribeEvents`, `queryEvents`, `_toChainEvent` 구현 |
| `dmz/packages/event-engine/src/listener/ChainEventListener.ts` | `start`, `_recoverMissedEvents`, `_dispatch` |
| `dmz/packages/event-engine/src/handlers/NFTIssuedHandler.ts` | 이벤트 → Core Banking 알림 |
| `docs/adr/004-event-driven-architecture.md` | 설계 결정 근거 |
| `scripts/listen-events.ts` | 실습 1 리스너 스크립트 |
| `scripts/recover-events.ts` | 실습 1 복구 스크립트 |
