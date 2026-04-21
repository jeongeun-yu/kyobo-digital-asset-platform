# Day 02 — DMZ 설계: 블록체인 노드는 어디에 두는가

**시간**: 3시간  
**핵심 질문**: 내부망 시스템이 블록체인 노드에 안전하게 접근하려면 네트워크 구조가 어떻게 되어야 하는가?

---

## 목표

DMZ 개념을 이론으로 배우지 않는다.  
이 프로젝트의 실제 Nginx 설정 파일을 읽고, **왜 이렇게 설계했는지**를 이해하고, **직접 수정**해본다.

---

## 실습 시나리오

### 실습 1 — DMZ 설정 파일 분석 (50분)

```bash
cat infrastructure/dmz/nginx/dmz.conf
```

아래 질문에 답한다:

1. 포트 8545와 8546이 하는 역할의 차이는?
2. `allow 10.0.0.0/8; deny all;` 이 두 줄이 없으면 어떤 공격이 가능한가?
3. WebSocket 프록시 설정에서 `proxy_read_timeout 3600s`가 필요한 이유는?
   *(힌트: ChainEventListener는 연결을 얼마나 유지하는가?)*
4. 외부 VASP API를 역방향 프록시하는 블록이 없다면 어떻게 통신해야 하는가?

### 실습 2 — 로컬 환경 구동 (40분)

```bash
# .env.example → .env 복사 후 로컬 값 입력
cp .env.example .env

# 로컬 EVM 노드 + Redis + PostgreSQL 구동
docker compose -f infrastructure/docker/docker-compose.yml up hardhat-node redis postgres

# 노드 연결 확인
curl -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

응답의 `result` 값을 16진수에서 10진수로 변환해본다.

### 실습 3 — EVMAdapter 연결 확인 (50분)

```typescript
// 아래 코드를 직접 실행
import { EVMAdapter } from './packages/chain-adapters/src/evm/EVMAdapter';

const adapter = new EVMAdapter({
  rpcUrl:  'http://localhost:8545',
  chainId: '31337',
});

const connected = await adapter.isConnected();
const block     = await adapter.getBlockNumber();

console.log('connected:', connected);
console.log('blockNumber:', block);
```

**질문:**
- `EVMAdapter` 생성자에서 `privateKey`를 넣지 않으면 어떤 메서드가 실패하는가?
- `IChainAdapter` 인터페이스에 있는 메서드 중 이 프로젝트에서 가장 중요한 것은 무엇이고 이유는?

### 실습 4 — 방화벽 규칙 수정 시나리오 (20분)

> 시나리오: 교보 내부망 CIDR이 `192.168.10.0/24`로 변경되었다.  
> `dmz.conf`에서 어떤 줄을 어떻게 바꿔야 하는가?

직접 수정하고 변경 이유를 주석으로 남긴다.

---

## 참조 파일

- `infrastructure/dmz/nginx/dmz.conf`
- `infrastructure/docker/docker-compose.yml`
- `packages/chain-adapters/src/interfaces/IChainAdapter.ts`
- `packages/chain-adapters/src/evm/EVMAdapter.ts`
- `docs/adr/001-chain-abstraction-layer.md`
