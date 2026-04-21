# Day 02 — DMZ 설계: 블록체인 노드는 어디에 두는가

**시간**: 3시간 (180분)  
**핵심 질문**: 내부망 시스템이 블록체인 노드에 안전하게 접근하려면 네트워크 구조가 어떻게 되어야 하는가?

---

## 세션 구조

| 시간 | 내용 |
|---|---|
| 00:00~00:30 | 1부: 금융기관 DMZ 설계 원칙 |
| 00:30~01:10 | 실습 1: Nginx 설정 파일 분석 + 수정 |
| 01:10~01:50 | 2부: 블록체인 노드 RPC vs WebSocket |
| 01:50~02:40 | 실습 2: 로컬 환경 구동 + EVMAdapter 연결 확인 |
| 02:40~03:00 | 3부: 외부 VASP 연동 구조 + 마무리 |

---

## 1부: 금융기관 DMZ 설계 원칙 (00:00~00:30)

### 1-1. DMZ가 존재하는 이유 (15분)

**토킹포인트:**

> "DMZ(Demilitarized Zone)는 군사 용어에서 왔습니다. 내부망과 외부망 사이의 완충 지대입니다. 금융기관 ISMS-P 요건상 고객 데이터를 다루는 시스템은 외부와 직접 통신하면 안 됩니다. 근데 블록체인 노드는 외부 피어와 통신해야만 작동합니다. 이 모순을 DMZ로 해결합니다."

```
[인터넷 / 외부 피어]
        ↓
[방화벽 1] ← 허용: 블록체인 P2P 포트만
        ↓
[DMZ 서버]
  - 블록체인 노드 (외부 피어와 동기화)
  - Nginx 리버스 프록시
        ↓
[방화벽 2] ← 허용: 내부 서비스 요청만 (포트 8545/8546)
        ↓
[교보 내부망]
  - issuer-service
  - Core Banking
```

**왜 노드를 내부망에 두면 안 되는가:**
- 블록체인 노드는 수백 개의 외부 피어와 상시 통신
- 내부망 방화벽이 이를 전부 허용하면 내부망 보안 의미 없음
- ISMS-P 심사 시 지적 대상

**왜 노드를 외부망에 두면 안 되는가:**
- Public RPC 사용 시 트랜잭션 내용 외부 노출
- 내부 서비스에서 외부 RPC로 직접 트랜잭션 전송 = 외부 의존성
- 노드 운영자 신뢰 문제

### 1-2. 이 프로젝트의 DMZ 설계 (15분)

**토킹포인트:**

> "우리 레포의 `infrastructure/dmz/nginx/dmz.conf`를 보겠습니다. 3개의 서버 블록이 있습니다. 하나씩 보겠습니다."

**포트별 역할:**

| 포트 | 역할 | 허용 출처 |
|---|---|---|
| 8545 | EVM RPC (HTTP) | 내부망 IP만 |
| 8546 | EVM WebSocket | 내부망 IP만 |
| 443 | issuer-service Webhook 수신 | 내부망 IP만 |

> "모두 내부망에서만 접근 가능합니다. 외부에서 교보 노드 RPC에 직접 접근할 수 없습니다. 이게 Private Node의 핵심입니다."

---

## 실습 1: Nginx 설정 파일 분석 + 수정 (00:30~01:10)

### Step 1 — 설정 파일 정독 (15분)
```bash
cat infrastructure/dmz/nginx/dmz.conf
```

각 지시어의 역할을 직접 주석으로 달아본다:

```nginx
upstream blockchain_node {
    server 10.0.1.10:8545;  # ← 이 IP는 무엇인가?
    keepalive 32;           # ← keepalive가 없으면 어떤 성능 문제가 생기는가?
}

allow 10.0.0.0/8;  # ← 이 CIDR이 의미하는 IP 범위는?
deny  all;         # ← 이 순서가 바뀌면 어떻게 되는가?

proxy_read_timeout 3600s;  # ← 왜 1시간인가?
```

**질문 답 (강사 해설):**
- `10.0.1.10`: DMZ 내부에 있는 블록체인 노드 서버 IP
- `keepalive 32`: 커넥션 재사용. 없으면 매 RPC 요청마다 TCP 핸드쉐이크 반복
- `10.0.0.0/8`: 10.x.x.x 전체 (교보 내부망 대역)
- `proxy_read_timeout 3600s`: WebSocket 이벤트 구독은 연결을 1시간 이상 유지해야 함

### Step 2 — 설정 수정 시나리오 (25분)

**시나리오 A:** 교보 내부망 CIDR이 `172.16.0.0/12`로 변경되었다.
```nginx
# 수정 전
allow 10.0.0.0/8;

# 수정 후 — 직접 작성
allow ____________;
```

**시나리오 B:** 블록체인 노드 서버를 `10.0.1.20`으로 이전했다.
```nginx
# 어느 줄을 어떻게 수정하는가?
```

**시나리오 C:** 외부 VASP API 호출을 DMZ Nginx가 중계해야 한다.
- 새로운 upstream 블록 추가
- 어떤 보안 설정이 추가로 필요한가?

---

## 2부: 블록체인 노드 RPC vs WebSocket (01:10~01:50)

### 2-1. 두 가지 통신 방식의 차이 (20분)

**토킹포인트:**

> "블록체인 노드와 통신하는 방법이 두 가지입니다. HTTP RPC와 WebSocket입니다. 뭐가 다를까요?"

**HTTP RPC (포트 8545):**
```
요청: "현재 블록 번호가 뭐야?" POST /
응답: { "result": "0x1a3b5" }
연결: 요청-응답 후 종료
```

**WebSocket (포트 8546):**
```
연결 유지 → 서버가 이벤트 발생 시 즉시 push
"방금 Issued 이벤트 발생했어!" → 즉시 수신
연결: 끊을 때까지 유지
```

> "트랜잭션 전송(sendTransaction)은 RPC를 씁니다. 이벤트 구독(subscribeEvents)은 WebSocket을 씁니다. EVMAdapter가 두 방식을 내부에서 처리하기 때문에 상위 레이어는 신경 쓸 필요 없습니다."

### 2-2. EVMAdapter 코드 구조 (20분)

```bash
cat packages/chain-adapters/src/evm/EVMAdapter.ts
```

**토킹포인트:**

> "생성자를 보세요. `rpcUrl`과 `privateKey`를 받습니다. `privateKey`가 없으면 `wallet`이 null입니다. 이 상태에서 `sendTransaction()`을 호출하면?"

```typescript
constructor(config: {
  rpcUrl:     string;
  chainId:    string;
  privateKey?: string;  // 없으면 read-only 모드
}) {
  this.wallet = config.privateKey
    ? new Wallet(config.privateKey, this.provider)
    : null;
}
```

**중요:** 모니터링 서비스는 `privateKey` 없이 read-only 모드로 연결한다. 키 노출 최소화.

---

## 실습 2: 로컬 환경 구동 + EVMAdapter 연결 확인 (01:50~02:40)

### Step 1 — 환경 설정 (10분)
```bash
cp .env.example .env
# .env 열어서 로컬 값 확인 (RPC_URL, CHAIN_ID 등)
```

### Step 2 — 로컬 노드 구동 (10분)
```bash
docker compose -f infrastructure/docker/docker-compose.yml up hardhat-node -d

# 노드 응답 확인
curl -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# 응답: {"jsonrpc":"2.0","id":1,"result":"0x0"}
# 0x0을 10진수로: 0번 블록 (제네시스)
```

### Step 3 — EVMAdapter 직접 실행 (30분)

`scripts/test-adapter.ts` 파일을 직접 작성한다:
```typescript
import { EVMAdapter } from './packages/chain-adapters/src/evm/EVMAdapter';

async function main() {
  const adapter = new EVMAdapter({
    rpcUrl:  'http://localhost:8545',
    chainId: '31337',
    // privateKey 없음 → read-only 모드
  });

  console.log('연결 상태:', await adapter.isConnected());
  console.log('현재 블록:', await adapter.getBlockNumber());

  // read-only 모드에서 sendTransaction 호출 시도
  try {
    await adapter.sendTransaction({
      contractAddr: '0x0000000000000000000000000000000000000000',
      abi: [],
      method: 'test',
      args: [],
    });
  } catch (err: unknown) {
    console.log('예상된 에러:', (err as Error).message);
    // → "EVMAdapter: read-only mode, no private key"
  }
}

main();
```

**확인 포인트:**
- `isConnected(): true` 출력되는가?
- `getBlockNumber()` 값이 계속 증가하는가? (Hardhat은 트랜잭션마다 블록 생성)
- read-only 에러 메시지가 정확히 출력되는가?

---

## 3부: 외부 VASP 연동 구조 + 마무리 (02:40~03:00)

### 3-1. VASP가 DMZ에서 어떻게 통신하는가 (15분)

**토킹포인트:**

> "외부 VASP API는 인터넷에 있습니다. 교보 issuer-service는 내부망에 있습니다. 직접 통신이 안 됩니다. DMZ Nginx가 역방향 프록시로 중계합니다."

```
[issuer-service] (내부망)
      ↓ HTTP → DMZ:443/vasp/...
[DMZ Nginx] (DMZ)
      ↓ HTTPS → 외부 VASP API
[외부 VASP] (인터넷)
```

`ExternalVASPAdapter.ts`의 `_request()` 메서드:
```typescript
const res = await fetch(`${this.baseUrl}${path}`, {
  headers: { 'X-API-Key': this.apiKey },
});
```

> "`baseUrl`이 DMZ 주소를 가리키면 내부망에서 외부 VASP와 안전하게 통신할 수 있습니다. 코드는 직접 외부망을 알 필요 없습니다."

### 마무리 (05분)

**오늘의 핵심 3줄:**
1. DMZ는 "노드를 외부와 내부 사이에 안전하게 배치하기 위한" 구조다
2. RPC(8545)는 요청-응답, WebSocket(8546)은 이벤트 스트리밍 — 용도가 다르다
3. EVMAdapter는 두 방식을 추상화해 상위 레이어에서 신경 쓰지 않게 한다

**Day 03 예고:**  
실제로 NFT 이벤트를 발생시키고 `ChainEventListener`가 실시간으로 잡는 것을 눈으로 확인한다.

---

## 참조 파일

- `infrastructure/dmz/nginx/dmz.conf`
- `infrastructure/docker/docker-compose.yml`
- `packages/chain-adapters/src/interfaces/IChainAdapter.ts`
- `packages/chain-adapters/src/evm/EVMAdapter.ts`
- `packages/vasp/src/external/ExternalVASPAdapter.ts`
- `docs/adr/001-chain-abstraction-layer.md`
