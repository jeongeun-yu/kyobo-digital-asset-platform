# 실습 파일 안내

## 시작 전 체크

```powershell
# 루트에서 의존성 설치 (1회만)
npm install

# 환경 변수 파일 복사
Copy-Item .env.example .env
```

`.env.example` → `.env` 복사 후 강사 안내에 따라 필요한 값 채우기  
(M2 실습은 Mock 환경이므로 `.env` 없이도 동작)

---

## 실습 실행 — 모두 루트에서 `npm run exercise:s##`

### M1 — 개발 환경 셋업

| 명령 | 파일 | 주제 |
|------|------|------|
| `npm run exercise:s04` | `M1/S04_check_networks.ts` | 로컬 노드·Sepolia·Mainnet Fork 블록 번호·잔액 조회 |

> 전제 조건: `blockchain/` 폴더에서 `npx hardhat node` 기동 중  
> 환경 3(Mainnet Fork)은 `.env`에 `MAINNET_RPC_URL` 추가 후 파일 내 주석 해제

---

### M2 — 이벤트 파이프라인 (Redis Streams · Webhook)

| 명령 | 파일 | 주제 |
|------|------|------|
| `npm run exercise:s05` | `M2/S05_webhook.ts` | WebhookServer 기동 |
| `npm run exercise:s05-sig` | `M2/S05_make_sig.ts` | HMAC-SHA256 서명 직접 생성 |
| `npm run exercise:s06` | `M2/S06_hmac_webhook.ts` | HMAC 검증 로직 구현 |
| `npm run exercise:s07` | `M2/S07_redis_stream.ts` | Redis Streams XADD / XREAD (Mock) |
| `npm run exercise:s07:docker` | `M2/S07_redis_stream_docker.ts` | Redis Streams — 실제 Redis 연동 (Docker 필요) |
| `npm run exercise:s09` | `M2/S09_atleastonce.ts` | At-least-once 보장 (XREADGROUP + XACK) |
| `npm run exercise:s10` | `M2/S10_handle_with_retry.ts` | 지수 백오프 재시도 핸들러 |
| `npm run exercise:s11` | `M2/S11_dlq.ts` | Dead Letter Queue 이동 |
| `npm run exercise:s12` | `M2/S12_e2e.ts` | 전체 파이프라인 E2E 통합 |

> 참고 구현체: `dmz/packages/event-engine/src/`

#### S07 Docker 버전 사용법

```powershell
# 1. Redis 기동
docker compose -f docker-compose.redis.yml up -d

# 2. 실습 실행
npm run exercise:s07:docker

# 3. 실시간 확인 (다른 터미널)
docker exec kyobo-redis redis-cli XRANGE kyobo:events - +
docker exec kyobo-redis redis-cli XPENDING kyobo:events issuer-consumers - + 10

# 4. 정리
docker compose -f docker-compose.redis.yml down
```

---

### M3 — TX 상태머신 · 멀티체인 · 디자인 패턴

| 명령 | 파일 | 주제 |
|------|------|------|
| `npm run exercise:s13` | `M3/S13_tx_statemachine.ts` | TxStatus 전이 + `transitionStatus()` 구현 |
| `npm run exercise:s14` | `M3/S14_multichain_adapter.ts` | IBlockchainAdapter Strategy 패턴 교체 |
| `npm run exercise:s15` | `M3/S15_evm_lab.ts` | EVMAdapter `mintNFT()` 직접 구현 |
| `npm run exercise:s16` | `M3/S16_idempotency.ts` | requestId 기반 Idempotency 구현 |
| `npm run exercise:s17` | `M3/S17_decorator_patterns.ts` | Logging·Retry Decorator + Circuit Breaker |

> 참고 구현체: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`  
> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`dmz/packages/chain-adapters/src/evm/EVMAdapter.ts`

---

### M4 — Stale 폴링 · 비정상 TX 복구

| 명령 | 파일 | 주제 |
|------|------|------|
| `npm run exercise:s22` | `M3/S22_pollstale_lab.ts` | `pollStaleRequests()` + TIMEOUT·REORG·REVERT 복구 |

> 참고 구현체: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`

---

### M5 — 배포 유틸리티 (실습 아님, 도구 파일)

| 파일 | 용도 |
|------|------|
| `M5/_deploy_mock.ts` | MockERC1155 Sepolia 배포 |
| `M5/_check_mint.ts` | 발행 결과 온체인 확인 |
| `M5/_check_balance.ts` | ERC-1155 잔액 조회 |

```powershell
npx ts-node --project dmz/packages/event-engine/tsconfig.json course/exercises/M5/_deploy_mock.ts
```

배포 후 `MOCK_CONTRACT_ADDR` 를 `.env`에 기록

---

## 채점 (자동화 테스트)

```powershell
# 특정 세션만
npm run test:exercises -- S04
npm run test:exercises -- S09

# 전체
npm run test:exercises
```

> 채점 테스트는 `course/exercises/__tests__/` 에 있으며 실제 네트워크 없이 로직을 검증한다.  
> S04는 Mock Provider로 JsonRpcProvider API 패턴을 채점한다.

---

## 정답 결과 먼저 확인하기

실습 전에 어떤 결과가 나와야 하는지 확인하고 싶다면 `:answer` 를 붙여 실행한다.

```powershell
npm run exercise:s04:answer
npm run exercise:s13:answer
# ...
```

---

## 파일 구조 규칙

| 파일 | 역할 |
|------|------|
| `S##_이름.ts` | 실습 파일 — 여기에 코드 작성 |
| `S##_이름.answer.ts` | 정답 파일 — 막힐 때만 참고 |
| `__tests__/` | 자동 채점 테스트 |

참고 구현체(`dmz/packages/*/src/`)는 수정하지 않는다. 실습 파일에서만 코드를 작성한다.
