# 실습 파일 안내

## 시작 전 체크

```bash
# 루트에서 의존성 설치
npm install

# 로컬 Hardhat 노드 + Docker(PostgreSQL/Redis) 기동
npx hardhat node &
docker-compose -f infrastructure/docker/docker-compose.yml up -d
```

`.env.example` → `.env` 복사 후 값 채우기

---

## 모듈별 실습 순서

### M2 — 이벤트 파이프라인 (Redis Streams · Webhook)

| 순서 | 파일 | 주제 |
|------|------|------|
| 1 | `M2/S05_webhook.ts` | WebhookServer 기동 · 서명 생성 |
| 2 | `M2/S05_make_sig.ts` | HMAC-SHA256 서명 직접 생성 |
| 3 | `M2/S06_hmac_webhook.ts` | HMAC 검증 로직 구현 |
| 4 | `M2/S07_redis_stream.ts` | Redis Streams XADD / XREAD |
| 5 | `M2/S09_atleastonce.ts` | At-least-once 보장 (XREADGROUP + XACK) |
| 6 | `M2/S10_handle_with_retry.ts` | 지수 백오프 재시도 핸들러 |
| 7 | `M2/S11_dlq.ts` | Dead Letter Queue 이동 |
| 8 | `M2/S12_e2e.ts` | 전체 파이프라인 E2E 통합 |

참고 구현체: `dmz/packages/event-engine/src/`

---

### M3 — TX 상태머신 · 멀티체인

| 순서 | 파일 | 주제 |
|------|------|------|
| 1 | `M3/S13_tx_statemachine.ts` | TxStatus 전이 + `transitionStatus()` 구현 |
| 2 | `M3/S14_multichain_adapter.ts` | IBlockchainAdapter Strategy 패턴 교체 |
| 3 | `M3/S15_evm_lab.ts` | EVMAdapter `mintNFT()` 직접 구현 |
| 4 | `M3/S16_idempotency.ts` | requestId 기반 Idempotency 구현 |

참고 구현체: `dmz/packages/vasp/src/tx/TxStateMachineService.ts`
            `dmz/packages/chain-adapters/src/evm/EVMAdapter.ts`

---

### M4 — Stale 폴링 · 비정상 TX 복구

| 순서 | 파일 | 주제 |
|------|------|------|
| 1 | `M4/S22_pollstale_lab.ts` | `pollStaleRequests()` + TIMEOUT·REORG·REVERT 복구 |

참고 구현체: `dmz/packages/vasp/src/tx/TxStateMachineService.ts` (handleTimeout / handleReorg)

---

### M5 — 배포 유틸리티 (실습 아님, 도구 파일)

| 파일 | 용도 |
|------|------|
| `M5/_deploy_mock.ts` | MockERC1155 Sepolia 배포 (hardhat 없이 ethers.js 직접) |
| `M5/_check_mint.ts` | 발행 결과 온체인 확인 |
| `M5/_check_balance.ts` | ERC-1155 잔액 조회 |

실행: `npx ts-node course/exercises/M5/_deploy_mock.ts`
배포 후 `MOCK_CONTRACT_ADDR` 를 `.env`에 기록

---

## 파일 구조 규칙

- `S##_이름.ts` — 실습 파일 (여기에 코드 작성)
- `S##_이름.answer.ts` — 정답 파일 (막힐 때만 참고)
- `__tests__/` — 실습 검증 테스트

```bash
# 특정 실습 테스트 실행
npx jest course/exercises/__tests__/atleastonce.test.ts
```

---

## 참고 구현체 vs 실습 파일

| 구분 | 위치 | 역할 |
|------|------|------|
| **참고 구현체** | `dmz/packages/*/src/` | 완성된 프로덕션 코드 — 읽고 이해 |
| **실습 파일** | `course/exercises/M*/` | 교육생이 직접 구현 |

참고 구현체를 수정하지 않는다. 실습 파일에서만 코드를 작성한다.
