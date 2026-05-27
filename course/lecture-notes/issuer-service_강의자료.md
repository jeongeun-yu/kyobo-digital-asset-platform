# issuer-service 강의 자료

실행 방법은 `issuer-service_가이드.md`를 참고한다.  
이 문서는 시스템이 **어떻게 설계되었고 왜 그렇게 동작하는지**를 설명한다.

---

## 목차

1. [전체 파이프라인 아키텍처](#1-전체-파이프라인-아키텍처)
2. [시나리오별 동작 원리](#2-시나리오별-동작-원리)
3. [DB 테이블 역할](#3-db-테이블-역할)
4. [상태 전이표](#4-상태-전이표)
5. [TX 이벤트 구조](#5-tx-이벤트-구조)
6. [설계 포인트](#6-설계-포인트)
7. [Redis Stream 아키텍처](#7-redis-stream-아키텍처)
8. [환경별 비교](#8-환경별-비교)

---

## 1. 전체 파이프라인 아키텍처

```
교보 앱 서버
ACTIVITY_ACHIEVED (인바운드)
      │
      ▼
 WebhookServer (:19877)
      │ HMAC-SHA256 서명 검증
      ▼
WebhookPublishHandler
      │ XADD "kyobo:events"
      ▼
 Redis Stream
      │
 ┌────┴────────────────┐
 │ XREADGROUP          │ XREADGROUP
 ▼                     ▼
activity-consumers    nft-consumers
(ActivityProcessor)   (NFTIssuedProcessor)
 │                     │
 ▼                     ▼
IssuerService        PgNFTLedgerService
 │                   (user_nft_holdings 기록)
 ▼
ExternalVASPAdapter
(아웃바운드: POST /transactions)
 │
 ▼
VASPServer (:19876)
서명 · 브로드캐스트
 │
 ▼
MockVASP 컨트랙트 (Hardhat / Sepolia)
 │
 ├─→ TX 확정
 │       │
 │       ▼
 │   VASPServer → NFT_ISSUED 콜백 → WebhookServer (:19877)
 │       └── HMAC 서명 포함
 │
 ▼
ChainEventListener (Issued 이벤트 폴링)
 │
 ┌──┴──────────────────────┐
 ▼                         ▼
IssuanceConfirmHandler  ProcessedEventHandler
issuance_requests        processed_events 기록
CONFIRMED 전이            (중복 이벤트 방지)
 │
 ▼
Java internal-ledger (TxTransitionBridge 경유)
 ┌──────┴──────┐
 ▼             ▼
user_nft_holdings  audit_log
```

**핵심 구조: WebhookServer는 두 종류의 요청을 동일한 경로로 처리한다.**

- 교보 앱 서버 → `ACTIVITY_ACHIEVED` → `activity-consumers`
- VASPServer 콜백 → `NFT_ISSUED` → `nft-consumers`

두 이벤트 모두 `WebhookServer → WebhookPublishHandler → Redis Stream` 경로를 거친다.  
입구는 다르지만 처리 메커니즘은 동일하다.

**NFT_ISSUED는 아웃바운드 호출의 비동기 응답이다.**

issuer-service가 `POST /transactions`(아웃바운드)를 VASPServer에 보내면,  
VASPServer가 체인 확정 후 `POST http://localhost:19877`(인바운드)로 결과를 돌려준다.  
WebhookServer 입장에서는 수신이지만, 성격은 "비동기 콜백"이다.

---

## 2. 시나리오별 동작 원리

### NORMAL — 황금 경로 (Golden Path)

```
웹훅 수신 → Redis Stream XADD
→ ActivityProcessor: IssuerService.issueActivityNFT()
  → user_wallet_mapping 조회 → 지갑 주소 획득
  → KYC / AML 확인
  → VASPServer POST /transactions → issuance_requests: REQUESTED → SUBMITTED
→ VASPServer: MockVASP.issueActivityNFT() TX 브로드캐스트
→ TX 채굴 → Issued 이벤트 emit
→ VASPServer: NFT_ISSUED 콜백 → WebhookServer
→ NFTIssuedProcessor: user_nft_holdings UPSERT
→ ChainEventListener: Issued 이벤트 감지
  → IssuanceConfirmHandler: issuance_requests CONFIRMED
  → TxTransitionBridge: Java internal-ledger 기록
→ audit_log: ISSUANCE_REQUESTED → ISSUANCE_SUBMITTED → ISSUANCE_CONFIRMED 3건 기록
```

8개 테이블 전부가 연동되는 검증 경로이므로 "황금 경로"라고 부른다.

### REVERT — one-shot revert + Redis retry

```
MockVASP.setMode(REVERT) → 웹훅 전송
  [1차 시도] estimateGas 단계에서 on-chain revert
           → VASPServer: VASP API 500
           → issuance_requests: FAILED (attempt=1)

  [Redis 재시도] MockVASP 자동 NORMAL 복귀 (one-shot 동작)
           → 2차 시도 정상 처리 → SUBMITTED → CONFIRMED
```

**REVERT는 영구 실패가 아니다.** MockVASP의 REVERT 모드는 한 번만 revert한 뒤 자동으로 NORMAL로 돌아온다. Redis Stream의 at-least-once 재시도 덕분에 최종적으로 CONFIRMED에 도달한다.

DB에서 FAILED row와 CONFIRMED row가 동시에 보이는 것이 정상이다.  
이 시나리오는 "일시적 장애 발생 후 retry로 자동 복구"를 검증한다.

### NO_EMIT — ChainEventListener 폴백 경로

```
MockVASP.setMode(NO_EMIT) → 웹훅 전송
→ mint() TX 성공 — 토큰은 발행됨
→ Issued 이벤트 미발행 → VASPServer 콜백 없음
→ tx_mint_requests: SUBMITTED 유지 (CONFIRMED 전이 없음)
```

실제 서비스에서 VASP 콜백 누락, 네트워크 단절, 이벤트 누락 등을 시뮬레이션한다.  
`poll-stale` 시나리오로 수동 복구 가능.

### PENDING — TX mempool 체류

| 환경 | 구현 방법 |
|---|---|
| Hardhat | `evm_setAutomine(false)` → TX 체류 → 30초 후 `evm_setAutomine(true)` + `evm_mine()` |
| Sepolia | nonce 블로커 TX(maxFeePerGas=1 wei) → 30초 후 replacement TX |

가스 부족, 네트워크 혼잡 등으로 TX가 mempool에서 대기하는 상황.  
issuer-service의 타임아웃·가스 범프 처리 로직을 검증한다.

### REORG — 체인 롤백

| 환경 | 구현 방법 |
|---|---|
| Hardhat | `evm_snapshot` 저장 → 발행 → `evm_revert(snapshotId)` |
| Sepolia | 정상 발행 후 DB에 `status='REORGED'` 직접 주입 |

온체인에서 이미 CONFIRMED된 TX가 롤백으로 사라지는 상황.  
`tx_mint_requests.status → REORGED` 전이를 검증한다.

### poll-stale — PENDING 초과 강제 복구

```
NO_EMIT 모드 → TX 채굴 성공 + Issued 이벤트 없음
→ DB 조작: SUBMITTED → PENDING + created_at -11분
→ POST :19870/admin/poll-stale
  → pollStaleRequests() → getTransferStatus() → MINED → CONFIRMED
→ issuance_requests CONFIRMED
```

ChainEventListener가 이벤트를 놓쳤을 때 폴링으로 복구하는 경로.

---

## 3. DB 테이블 역할

| 테이블 | 담당 서비스 | 역할 |
|---|---|---|
| `issuance_policies` | issuer-service | 이벤트 타입별 발행 정책. 시드 데이터. |
| `issuance_requests` | issuer-service | 발행 요청 라이프사이클 추적 (REQUESTED→SUBMITTED→CONFIRMED/FAILED) |
| `mint_requests` | core-banking | LedgerService 레벨의 민팅 기록 |
| `tx_mint_requests` | vasp | 온체인 TX 상태 머신 (REQUESTED→SUBMITTED→MINED→CONFIRMED) |
| `user_wallet_mapping` | issuer-service | userId ↔ 지갑 주소 매핑 |
| `processed_events` | core-banking | 체인 이벤트 중복 처리 방지 (txHash + logIndex로 멱등성 보장) |
| `user_nft_holdings` | Java internal-ledger | NFT 보유 현황 영구 원장 |
| `audit_log` | Java internal-ledger | 모든 상태 전이 감사 로그 (hash chain 무결성) |

---

## 4. 상태 전이표

### tx_mint_requests (온체인 TX 상태 머신)

```
REQUESTED ──→ SUBMITTED ──→ PENDING ──→ MINED ──→ CONFIRMED ──→ FINALIZED
                               │           │
                               └──→ FAILED ┘     MINED ──→ REORGED ──→ MINED 또는 FAILED
```

- **REQUESTED**: VASPServer에 TX 위탁 직후
- **SUBMITTED**: TX 브로드캐스트 완료 (txHash 획득)
- **PENDING**: mempool에 있지만 블록에 미포함 (가스 부족 등)
- **MINED**: 블록 포함됨, 최종 확정 대기
- **CONFIRMED**: 충분한 블록 확정 완료
- **REORGED**: 체인 롤백으로 TX 무효화

### issuance_requests / mint_requests

```
REQUESTED ──→ SUBMITTED ──(Issued 이벤트)──→ CONFIRMED
                        ──(TX 실패)─────────→ FAILED
```

데모 정상 흐름: `REQUESTED → SUBMITTED → CONFIRMED`  
(Hardhat은 즉시 채굴이므로 PENDING 생략)

---

## 5. TX 이벤트 구조

NORMAL 시나리오에서 `issueActivityNFT` 호출 하나가 이벤트 2개를 발생시킨다.

```
logs[0] TransferSingle (ERC-1155 표준)
  operator : 컨트랙트 호출자
  from     : 0x0000...  ← zero address = 신규 발행 (mint)
  to       : 수령 주소
  id       : tokenId
  value    : 발행 수량 (1)

logs[1] Issued (교보 비즈니스 이벤트)
  to       : 수령 주소
  tokenId  : 토큰 ID
  reason   : WALK_GOAL_MET  ← ChainEventListener 구독 대상
```

`TransferSingle`은 ERC-1155 스펙이 보장하는 표준 이벤트.  
`Issued`는 비즈니스 컨텍스트(reason)를 얹은 issuer-service 전용 이벤트.

ChainEventListener는 `Issued` 이벤트만 구독한다.  
`TransferSingle`은 ERC-1155 호환 지갑·마켓플레이스가 사용한다.

### Java internal-ledger API 호출 흐름 (NORMAL)

```typescript
// ① NFT 보유 기록
POST /api/internal/users/{userId}/nft-holdings
{ tokenId, contractAddr, chainId, amount, acquiredAt, onChainTx }

// ② 리워드 알림 (fire-and-forget — 실패해도 발행 결과에 영향 없음)
POST /api/internal/rewards/notify
{ userId, rewardType: "ACTIVITY_NFT", tokenId, txHash }

// ③ 감사 로그 — 상태 전이마다 기록
POST /api/internal/audit-log
{ actor, action, resourceType, resourceId, beforeState, afterState }
// action 종류: ISSUANCE_REQUESTED / ISSUANCE_SUBMITTED / ISSUANCE_CONFIRMED / ISSUANCE_FAILED
```

---

## 6. 설계 포인트

### 6-1. Signer 분리 (Nonce 충돌 방지)

**문제**: `setMode` TX (DEPLOYER_KEY)와 `issueActivityNFT` TX (OPERATOR_KEY)가 같은 키를 사용하면 nonce가 충돌한다.

ethers v6 JsonRpcProvider는 `eth_getTransactionCount('pending')` 결과를 블록 단위로 캐싱한다. 동일 블록 안에서 같은 signer가 TX를 두 번 보내면 두 번째 TX가 stale nonce를 받아 실패한다.

```
NONCE_EXPIRED: Expected nonce to be 4 but got 3
```

**해결**: 역할별로 signer를 분리한다.

```
controlVasp  ── DEPLOYER_KEY ──→ setMode / snapshot / revert
vasp         ── OPERATOR_KEY ──→ issueActivityNFT
```

두 signer가 독립적인 nonce 공간을 가지므로 충돌이 원천 차단된다.

**배포 시 NonceManager**: deploy TX 직후 grantRole TX를 연속 전송할 때 동일 signer가 사용된다. 이 경우 `ethers.NonceManager`로 래핑해 로컬에서 nonce를 순서대로 추적한다.

```typescript
const deployer = new ethers.NonceManager(new ethers.Wallet(DEPLOYER_KEY, provider));
// deploy (nonce 0) → grantRole (nonce 1) — NonceManager가 순서 보장
```

### 6-2. BigInt JSON 직렬화

ethers v6는 ERC-1155 tokenId(uint256)를 JavaScript `BigInt`로 디코딩한다.  
`JSON.stringify`는 BigInt를 직렬화하지 못하고 `TypeError`를 던진다.

PostgreSQL JSONB 컬럼 저장 전 반드시 변환해야 한다:

```typescript
const safePayload = JSON.parse(
  JSON.stringify(ev.args, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
);
```

### 6-3. audit_log hash chain 무결성

Java `AuditLogService`는 감사 로그를 append-only로 관리하며, 레코드마다 SHA-256 hash chain을 유지한다.

```
checksum_N = SHA-256(checksum_(N-1) + eventTime + actor + action + resourceId + afterState)
```

- 첫 레코드의 `prev_checksum`: `"000...0"` (64자리 genesis 값)
- 레코드 사후 수정 → 이후 모든 레코드의 checksum 불일치 → 변조 탐지
- DB 수준 RLS(Row Level Security) INSERT-only 정책으로 이중 보호

**schema.sql에서 `audit_log_seq` 시퀀스를 명시적으로 생성하는 이유**:  
JPA 엔티티가 `@SequenceGenerator(sequenceName = "audit_log_seq")`를 지정하는데,  
`BIGSERIAL`이 자동 생성하는 `audit_log_id_seq`와 이름이 달라서 JPA 기동 시 오류가 발생한다.

### 6-4. Consumer ID 로깅

각 메시지 처리 시작 시 어느 consumer instance가 담당하는지 로그로 확인할 수 있다.

```json
{"consumer":"activity-1","group":"activity-consumers","messageId":"1779920914446-0","eventType":"ACTIVITY_ACHIEVED","attempt":1}
```

수평 확장 시 여러 consumer instance 중 어느 쪽이 처리했는지 추적할 수 있다.

### 6-5. DEMO_MODE — Core Banking 없이 데모 실행

Java internal-ledger는 Core Banking 미연결 상태에서도 동작한다.

```yaml
kyobo:
  demo:
    mode: ${DEMO_MODE:false}
    users: ${DEMO_USERS:}   # "userId:walletAddr,..." 형식
```

`DEMO_MODE=true`이면 `CoreBankingClient.getUserAccount()`가 Core Banking API 대신 `DEMO_USERS` 환경변수에서 사용자 정보를 반환한다.

---

## 7. Redis Stream 아키텍처

### 전체 구조

```
이벤트 발행자
    │ XADD "kyobo:events"
    ▼
Redis Stream ──────────────────────────────────────────┐
    │                                                  │
    │ XREADGROUP                                       │ XAUTOCLAIM
    ▼                                                  │ (PEL 재수신)
ConsumerGroupWorker                                    │
    │ process(msg)                                     │
    ├── 성공 → XACK                                    │
    ├── 실패 (<3회) → PEL 잔류 ──────────────────────────┘
    └── 실패 (≥3회) → DLQHandler → XADD "kyobo:events:dlq"
```

### At-least-once 처리 보장

메시지를 `XREADGROUP`으로 읽으면 PEL(Pending Entry List)에 등록된다.  
`XACK` 전에 Consumer가 죽으면 PEL에 잔류하며, `XAUTOCLAIM`으로 다른 Consumer가 재수신한다.

정확히 1번 처리(exactly-once)는 불가능하지만, **멱등성 보장으로 보완**한다.  
`processed_events` 테이블이 `(txHash, logIndex)` 유니크 제약으로 중복 처리를 차단한다.

### XAUTOCLAIM 상세 흐름

```
① XADD → 메시지 스트림에 추가
② CRASH_CONSUMER: XREADGROUP → 메시지 수신 (XACK 없이 중단 → PEL 잔류)
③ minIdleMs 초과 대기
④ NEW_CONSUMER: _reclaimPending() → XAUTOCLAIM → PEL 메시지 회수 → process() → XACK
```

**테스트 격리**: Consumer Group 이름에 `Date.now()`를 포함해 테스트 간 PEL 오염 차단.

### DLQ (Dead Letter Queue)

3회 연속 실패 → `DLQHandler.move()` → `kyobo:events:dlq` 스트림으로 이동.  
수동 재처리: DLQ 스트림에서 읽어 `kyobo:events`에 다시 `XADD`.

### InMemoryRedis 폴백

`REDIS_URL` 미설정 시 자동으로 `InMemoryRedis`를 사용한다.  
ioredis와 동일한 메서드 시그니처(`xadd`, `xreadgroup`, `xack`, `xautoclaim`, `xrange`, `xgroup CREATE`)를 구현해 4가지 시나리오 모두 동일하게 동작한다.

---

## 8. 환경별 비교

### 데모 vs 통합 테스트

| 항목 | 시나리오 데모 | 자동화 통합 테스트 |
|---|---|---|
| 실행 방식 | `demo:start` + `demo:scenario` (인터랙티브) | `test:mock-vasp` (자동화) |
| 목적 | 동작 확인, 강의 시연 | 코드 변경 후 회귀 검증 |
| 컨테이너 관리 | 수동 (Ctrl+C로 종료) | testcontainers 자동 관리 |
| DB 상태 | 세션 간 유지 | 테스트마다 초기화 |
| 시나리오 수 | 9가지 (CLI로 선택) | 9가지 (자동 순차 실행) |

### Hardhat vs Sepolia

| 항목 | Hardhat 로컬 | Sepolia 테스트넷 |
|---|---|---|
| 블록 확정 | 즉시 | ~12초 |
| 가스비 | 무료 | Sepolia ETH 필요 |
| PENDING 시나리오 | `evm_setAutomine` | nonce 블로커 TX |
| REORG 시나리오 | `evm_snapshot/revert` | DB 직접 주입 |
| Etherscan 확인 | ❌ | ✅ |
| 컨트랙트 주소 | 매 실행 fresh deploy | 고정 주소 |
| TOKEN_ID | `'1001'` 고정 | `Date.now()` 동적 생성 |
| ChainEventListener 폴링 | 300ms | 3,000ms |
| CONFIRMED 대기 | 최대 40초 | 최대 3분 |

**Hardhat의 강점**: 블록체인을 완전히 제어할 수 있다. 실서비스에서는 불가능한 극단 시나리오(블록 중단, 체인 롤백)를 재현할 수 있다.

**Sepolia의 강점**: 실제 퍼블릭 노드에서 TX가 브로드캐스트되고 블록에 포함된다. Etherscan에서 TX를 직접 확인할 수 있어 실운영 환경에 가장 가까운 검증이 가능하다.

**TOKEN_ID를 동적 생성하는 이유**: Sepolia의 고정 컨트랙트에는 이전 실행에서 발행된 토큰이 누적된다. 실행마다 `Date.now()` 기반의 새 TOKEN_ID를 쓰면 이전 잔액과 무관하게 `balanceOf` 증분(+1)만 검증할 수 있다.

### 전체 환경별 기능 비교

| 항목 | Hardhat 스크립트 | mock-vasp 통합 | Sepolia 스크립트 | Sepolia 통합 | Redis Stream 통합 |
|---|---|---|---|---|---|
| 대상 | 컨트랙트 동작 | 파이프라인 전체 | 온체인 TX 시각화 | 파이프라인 + Sepolia | 이벤트 버스 레이어 |
| PostgreSQL | ❌ | ✅ | ❌ | ✅ | ❌ |
| Java 컨테이너 | ❌ | ✅ | ❌ | ✅ | ❌ |
| Redis | ❌ | ✅ | ❌ | ✅ | ✅ |
| PENDING / REORG | ✅ | ✅ | ❌ | ❌ | ❌ |
| Redis Stream (멱등·DLQ·XAUTOCLAIM) | ❌ | ✅ | ❌ | ✅ | ✅ |
| Etherscan 확인 | ❌ | ❌ | ✅ | ✅ | ❌ |
| 오프라인 실행 | ✅ | ❌ | ❌ | ❌ | ✅ (InMemory) |
| 총 시나리오 수 | 5 | 9 | 3 | 6 | 4 |
| 강의 용도 | 컨트랙트 설명 | 서비스 설계 전체 | 실운영 TX 시각화 | 실운영 유사 E2E | 이벤트 버스 신뢰성 |
