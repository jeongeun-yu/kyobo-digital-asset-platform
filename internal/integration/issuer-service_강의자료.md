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
9. [테스트 파일 구성](#9-테스트-파일-구성)
10. [mock-vasp 통합 테스트 — beforeAll 상세](#10-mock-vasp-통합-테스트--beforeall-상세)
11. [비즈니스 로직 조립 방식](#11-비즈니스-로직-조립-방식)
12. [테스트 전용 클래스 해설](#12-테스트-전용-클래스-해설)
13. [Sepolia 통합 테스트 — Hardhat과의 차이](#13-sepolia-통합-테스트--hardhat과의-차이)
14. [InMemoryRedis 구현 원리](#14-inmemoryredis-구현-원리)
15. [Reconcile 설계 — DB ↔ 온체인 정합성 검증](#15-reconcile-설계--db--온체인-정합성-검증)

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

### Reconcile — ONCHAIN_ONLY 불일치 감지

```
정상 발행 완료 (user_nft_holdings에 tokenId 기록됨)
→ DB 조작: user_nft_holdings 해당 row 삭제 (ONCHAIN_ONLY 상태 인위 생성)
→ POST :19870/admin/reconcile/run (body: { userId, operator })
  → ReconcileAdminService.runManualReconcile()
  → ReconcileService.reconcileNftHoldings(userId)
     ├── DB: PgNftHoldingRepository.getHoldings() → [] (삭제했으므로 없음)
     └── 온체인: EVMAdapter.getNftHoldings() → [tokenId] (여전히 보유 중)
  → 불일치 감지: { tokenId, dbAmount: 0, onChainAmount: 1, type: 'ONCHAIN_ONLY' }
→ reconcile_history INSERT (mismatch_count=1)
→ audit_log INSERT: action='RECONCILE_MISMATCH_DETECTED'
→ GET :19870/admin/reconcile/history → 불일치 이력 확인
```

**ONCHAIN_ONLY**: 온체인에는 NFT가 있지만 DB에는 없는 상태. 발행 파이프라인 일부 실패나 DB 장애 시 발생할 수 있다.

**ReconcileService 설계 원칙**:
- `ReconcileService`: 단일 userId에 대한 DB ↔ 온체인 비교 로직만 담당
- `ReconcileAdminService`: 언제·누구를·어떻게 실행할지 담당 (HOURLY/DAILY/MANUAL)
- `EVMAdapter.getNftHoldings()`: ERC-1155는 tokenId 열거 API가 없으므로 `TransferSingle` 이벤트를 스캔해 tokenId 목록을 수집한 뒤 `balanceOf > 0` 필터로 실제 보유분만 추린다.

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
| `reconcile_history` | ReconcileAdminService | Reconcile 실행 이력 (runType, mismatchCount, 소요시간) |

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
| PENDING / REORG | ✅ | ✅ | ❌ | ✅ | ❌ |
| Redis Stream (멱등·DLQ·XAUTOCLAIM) | ❌ | ✅ | ❌ | ✅ | ✅ |
| Reconcile (DB ↔ 온체인 정합성) | ❌ | ✅ | ❌ | ✅ | ❌ |
| Etherscan 확인 | ❌ | ❌ | ✅ | ✅ | ❌ |
| 오프라인 실행 | ✅ | ❌ | ❌ | ❌ | ✅ (InMemory) |
| 총 시나리오 수 | 5 | 11 | 3 | 10 | 4 |
| 강의 용도 | 컨트랙트 설명 | 서비스 설계 전체 | 실운영 TX 시각화 | 실운영 유사 E2E | 이벤트 버스 신뢰성 |

---

## 9. 테스트 파일 구성

### 전체 파일 맵

```
internal/integration/__tests__/
├── issuer-service-mock-vasp.integration.test.ts   ← 메인 (11 시나리오, Hardhat)
├── issuer-service-sepolia.integration.test.ts     ← Sepolia E2E (10 시나리오)
├── stream-consumer.integration.test.ts            ← Redis Stream 레이어 독립 검증
├── issuer-service-walkthrough.integration.test.ts ← 워크스루 (메서드 추적 로그)
├── issuance-status.integration.test.ts            ← 상태 전이 단위 (IssuanceStatus)
└── tx-status.integration.test.ts                  ← TX 상태머신 단위 (TxStateMachineService)
```

### 각 파일의 목적과 역할

| 파일 | 레이어 | 인프라 | 목적 |
|---|---|---|---|
| mock-vasp | 파이프라인 전체 | Hardhat + PG + Redis + Java | 11개 비즈니스 시나리오 E2E 검증 |
| sepolia | 파이프라인 전체 | Sepolia + PG + Redis + Java | 실운영 환경 유사 E2E 검증 (10개) |
| stream-consumer | 이벤트 버스 | Redis (또는 InMemory) | ConsumerGroupPool 신뢰성 독립 검증 |
| walkthrough | 파이프라인 전체 | PG + Redis (InMemory 폴백) | 메서드 호출 흐름 교육용 추적 |
| issuance-status | issuer-service 레이어 | PG | IssuanceStatus 상태 전이 규칙 검증 |
| tx-status | vasp 레이어 | PG | TxStateMachineService 상태머신 검증 |

### 테스트 계층 구조

```
┌─────────────────────────────────────────────┐
│   mock-vasp / sepolia (E2E, 파이프라인 전체) │  ← 모든 레이어 통합
└──────────────────┬──────────────────────────┘
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
 stream-consumer  walkthrough  issuance-status / tx-status
 (이벤트 버스)    (교육 추적)  (도메인 레이어 단위)
```

**설계 원칙**: 파이프라인 전체가 통과하는 E2E 테스트는 시간이 오래 걸린다. 레이어별 단위 테스트를 함께 두어 회귀 속도를 높인다.

---

## 10. mock-vasp 통합 테스트 — beforeAll 상세

`issuer-service-mock-vasp.integration.test.ts`의 `beforeAll`은 테스트가 실행되기 전 완전한 서비스 환경을 인메모리에 조립한다. 7단계로 나뉜다.

### 단계 ① — Hardhat 노드 컨테이너 기동

```typescript
hardhatContainer = await new GenericContainer('kyobo/hardhat-node:test')
  .withExposedPorts(8545)
  .withWaitStrategy(Wait.forLogMessage('Started HTTP and WebSocket JSON-RPC server'))
  .start();
hardhatRpc = `http://${hardhatContainer.getHost()}:${hardhatContainer.getMappedPort(8545)}`;
await new ethers.JsonRpcProvider(hardhatRpc).send('hardhat_reset', []);
```

**포인트**:
- `testcontainers`의 `GenericContainer`로 Docker 이미지를 프로그래매틱하게 기동한다.
- `Wait.forLogMessage()`는 컨테이너 stdout에서 특정 문자열이 보일 때까지 블로킹한다. 포트 바인딩만으로는 부족하다 — RPC 서버가 실제 처리 가능 상태인지를 로그로 판단한다.
- `hardhat_reset`으로 이전 테스트 잔류 상태(계정 nonce, 컨트랙트)를 초기화한다. 각 `beforeAll`이 깨끗한 체인에서 시작하도록 보장.
- `getMappedPort(8545)`: Docker는 호스트 포트를 동적으로 할당한다. 고정 포트를 사용하면 병렬 테스트 실행 시 충돌이 발생한다.

### 단계 ② — MockVASP 컨트랙트 배포

```typescript
async function deployMockVASP(rpcUrl: string): Promise<string> {
  const artifact   = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8'));
  const deployer   = new ethers.NonceManager(new ethers.Wallet(DEPLOYER_KEY, provider));
  const factory    = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const contract   = await factory.deploy(OPERATOR_ADDR);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();

  // deployer에게 OPERATOR_ROLE 부여 — controlVasp(DEPLOYER_KEY) setMode 전용
  const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes('OPERATOR_ROLE'));
  const mockVasp = new ethers.Contract(addr, artifact.abi, deployer);
  await (await mockVasp['grantRole'](OPERATOR_ROLE, DEPLOYER_ADDR)).wait();
}
```

**포인트**:
- `ARTIFACT_PATH`: 컴파일된 MockVASP ABI + bytecode JSON. `blockchain/artifacts/` 하위에 Hardhat이 자동 생성한다.
- `NonceManager`로 deployer를 래핑하는 이유: `deploy` TX와 `grantRole` TX가 연속으로 전송된다. 같은 키로 TX를 두 번 보내면 두 번째 TX가 stale nonce를 받을 수 있다. `NonceManager`는 nonce를 로컬에서 순서대로 추적해 이를 방지한다.
- `waitForDeployment()`: TX 브로드캐스트 후 채굴 확인까지 대기. 이후 `getAddress()`가 실제 배포 주소를 반환한다.
- `OPERATOR_ROLE` 부여: `controlVasp`(DEPLOYER_KEY)가 `setMode()`를 호출할 수 있도록 컨트랙트 Role을 부여한다. 배포자가 자동으로 Admin Role을 가지므로 `grantRole`이 가능하다.

### 단계 ③ — PostgreSQL + Java internal-ledger 컨테이너

```typescript
dockerNetwork = await new Network().start();

pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
  .withDatabase('kyobo_test')
  .withUsername('kyobo')
  .withPassword('kyobo')
  .withNetwork(dockerNetwork)
  .withNetworkAliases('postgres')   // ← Java 컨테이너가 'postgres'로 접근
  .start();

pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
await pool.query(readFileSync(SCHEMA_PATH, 'utf-8'));  // 스키마 적용

javaContainer = await new GenericContainer('kyobo/internal-ledger:test')
  .withNetwork(dockerNetwork)
  .withEnvironment({
    DB_URL: 'jdbc:postgresql://postgres:5432/kyobo_test',  // 네트워크 별칭 사용
  })
  .withWaitStrategy(Wait.forHttp('/api/internal/health', 8080).forStatusCode(200))
  .start();
```

**포인트**:
- `Network()`: Docker 네트워크를 생성해 PostgreSQL과 Java 컨테이너가 같은 가상 네트워크 안에 있도록 한다. 호스트 포트를 통하지 않고 컨테이너 간 직접 통신이 가능해진다.
- `withNetworkAliases('postgres')`: Java 컨테이너의 `DB_URL`이 `jdbc:postgresql://postgres:5432/...`를 사용할 수 있도록 DNS 별칭을 부여한다. 동적 호스트 포트와 무관하게 연결이 가능하다.
- `Wait.forHttp('/api/internal/health', 8080).forStatusCode(200)`: Spring Boot의 `/health` 엔드포인트가 200을 반환할 때까지 블로킹. 포트가 열렸더라도 JVM이 완전히 부팅되기 전에 테스트가 요청을 보내면 500이 반환된다.
- 스키마는 `@testcontainers`가 DB를 생성한 직후 `pool.query(schema)`로 직접 적용한다. JPA `ddl-auto` 대신 수동 적용하는 이유: 테스트 DB가 운영 DB와 완전히 동일한 스키마인지 보장하기 위해.

### 단계 ④ — Redis 컨테이너

```typescript
redisContainer = await new GenericContainer('redis:7-alpine')
  .withExposedPorts(6379)
  .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
  .start();
redis = new Redis(`redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`);
```

**포인트**:
- Redis는 PostgreSQL과 달리 Java 컨테이너와 동일 네트워크일 필요가 없다. issuer-service(Node.js 프로세스)가 호스트에서 직접 연결하기 때문.
- `ioredis` 클라이언트를 직접 생성해 이후 `IoRedisAdapter`로 래핑한다.

### 단계 ⑤ — VASPServer + controlVasp 기동

```typescript
vaspServer = new VASPServer({
  port:            VASP_PORT,           // 19876
  rpcUrl:          hardhatRpc,
  signerKey:       OPERATOR_KEY,        // 발행 TX 서명
  contractAddr:    mockVaspAddr,
  callbackUrl:     `http://localhost:${WEBHOOK_PORT}`,
  callbackSecret:  WEBHOOK_SECRET,
  pollingInterval: 100,                 // Hardhat은 빠른 폴링 가능
});
await vaspServer.start();

// controlVasp: DEPLOYER_KEY 사용 — nonce를 OPERATOR_KEY와 분리
controlVasp = new AnvilVASPAdapter({
  rpcUrl:       hardhatRpc,
  privateKey:   DEPLOYER_KEY,
  mockVaspAddr: mockVaspAddr,
  confirmations: 1,
});
(controlVasp as any).provider.pollingInterval = 100;
```

**포인트**:
- `VASPServer`는 실제 HTTP 서버다. `ExternalVASPAdapter`가 `POST /transactions`를 보내면 VASPServer가 받아서 온체인 TX를 브로드캐스트하고, TX 확정 후 콜백을 보낸다.
- `controlVasp`는 `VASPServer`와 별도로 MockVASP 컨트랙트를 직접 제어한다. `setMode()`, `freezeMining()`, `snapshot()` 등 시나리오 조작 전용이다.
- **핵심**: 두 어댑터가 서로 다른 키를 사용한다. `VASPServer`는 OPERATOR_KEY, `controlVasp`는 DEPLOYER_KEY. 같은 키를 쓰면 nonce 충돌이 발생한다 (설계 포인트 6-1 참조).
- `pollingInterval = 100`: ethers v6의 기본 폴링 주기는 4000ms다. Hardhat은 즉시 채굴하므로 100ms로 낮춰 테스트 속도를 높인다.
- `resetNonce()`: `VASPServer`는 내부적으로 `ethers.NonceManager`로 signer를 래핑해 nonce를 로컬에서 추적한다. Sepolia 통합 테스트에서 각 테스트 케이스의 `beforeEach`에서 `vaspServer.resetNonce()`를 호출해 NonceManager의 로컬 카운터를 체인 실제 nonce와 재동기화한다. 이전 테스트의 REVERT PEL 메시지가 XAUTOCLAIM으로 재시도되면서 추가 Sepolia TX를 브로드캐스트하면, NonceManager 카운터가 체인보다 뒤처져 후속 테스트에서 "nonce has already been used" 오류가 발생한다. `resetNonce()` 호출이 이를 방지한다.

### 단계 ⑥ — 정적 데이터 시드 + 서비스 인스턴스 생성

```typescript
coreBanking = new PgHybridCoreBankingAdapter(pool);

for (let i = 1; i <= 5; i++) {
  await pool.query(
    `INSERT INTO user_wallet_mapping (user_id, wallet_addr, vasp_type, verified)
     VALUES ($1, $2, 'ANVIL', true) ON CONFLICT (user_id) DO NOTHING`,
    [`user-mock-${String(i).padStart(3, '0')}`, OPERATOR_ADDR],
  );
}
await pool.query(
  `INSERT INTO issuance_policies (event_type, token_id, amount)
   VALUES ($1, $2, 1) ON CONFLICT (event_type) DO NOTHING`,
  [TEST_EVENT_TYPE, TOKEN_ID],
);

ledgerService = new LedgerService(new PgDatabaseClient(pool), coreBanking);
```

**포인트**:
- `user_wallet_mapping`에 `user-mock-001` ~ `user-mock-005`를 시드한다. 모두 `OPERATOR_ADDR`(Hardhat #1 계정)로 매핑된다. 실제 서비스에서는 각 userId마다 다른 지갑이지만, 테스트는 단일 계정에서 `balanceOf`를 검증하므로 같은 주소를 써도 무방하다.
- `issuance_policies`는 `WALK_GOAL_MET` 이벤트에 `TOKEN_ID='1001'`, `amount=1`을 매핑한다. `IssuerService`가 발행 조건을 판단할 때 이 테이블을 조회한다.
- `ON CONFLICT DO NOTHING`: 테스트가 여러 번 실행될 때 중복 삽입 오류를 방지한다.

### 단계 ⑦ — 서비스 조립 (TokenIssuerFactory)

```typescript
chainAdapter = new EVMAdapter({ rpcUrl: hardhatRpc, chainId: '31337' });
(chainAdapter as any).provider.pollingInterval = 100;

const externalVasp = new ExternalVASPAdapter({
  baseUrl: `http://localhost:${VASP_PORT}`,
  apiKey:  'test-api-key',
});

const conditionSvc  = new EventConditionService([new ActivityConditionStrategy()]);
const factory       = new TokenIssuerFactory({
  chainAdapter,
  vaspAdapter:           externalVasp,
  coreBanking,
  pool,
  internalLedgerClient:  new HttpInternalLedgerClient(javaBaseUrl),
});

const factoryResult = factory.createNFTIssuer(mockVaspAddr, conditionSvc);
const { issuerService } = factoryResult;
confirmHandler  = factoryResult.confirmHandler;
txStateMachine  = factoryResult.txStateMachine;
```

이 단계가 핵심이다. 각 컴포넌트가 어떤 역할을 하는지는 다음 섹션에서 자세히 설명한다.

---

## 11. 비즈니스 로직 조립 방식

### TokenIssuerFactory — 의존성 주입 컨테이너 역할

```
TokenIssuerFactory.createNFTIssuer(contractAddr, conditionSvc)
        │
        ├── PgIssuanceRequestRepository(pool)     ← issuance_requests CRUD
        ├── IssuancePolicyService(pool)            ← 정책 조회 (어떤 tokenId?)
        ├── PgTxRepository(pool)                  ← tx_mint_requests CRUD
        │
        ├── TxStateMachineService(txRepo, externalVasp)
        │       └── ExternalVASPAdapter            ← VASPServer HTTP 클라이언트
        │
        ├── TxTransitionBridge(issuanceRepo, internalLedgerClient)
        │       └── HttpInternalLedgerClient       ← Java API 클라이언트
        │
        ├── IssuerService(issuanceRepo, policyService, conditionSvc,
        │                 txStateMachine, bridge, coreBanking)
        │
        └── IssuanceConfirmHandler(issuanceRepo, bridge, contractAddr)
                └── ChainEventListener에 등록 (Issued 이벤트 구독)
```

`factory.createNFTIssuer()`가 반환하는 객체:
- `issuerService`: `ActivityProcessor`가 호출하는 진입점
- `confirmHandler`: `ChainEventListener`가 Issued 이벤트를 감지했을 때 호출
- `txStateMachine`: `pollStaleRequests()`를 외부에서 트리거할 때 사용

### IssuerService — 핵심 비즈니스 로직

```typescript
// ActivityProcessor → IssuerService.issueActivityNFT() 호출 흐름
async issueActivityNFT(userId, eventType, data) {
  // 1. 발행 정책 조회 (어떤 tokenId, 수량?)
  const policy = await policyService.findByEventType(eventType);

  // 2. 이벤트 조건 검증 (걸음 수 15,000 이상?)
  conditionSvc.check(policy, data);

  // 3. 지갑 주소 조회 (Core Banking → user_wallet_mapping)
  const account = await coreBanking.getUserAccount(userId);

  // 4. 중복 요청 검사 (REQUESTED/SUBMITTED 상태 이미 존재?)
  const pending = await issuanceRepo.findPending(userId, eventType);
  if (pending) return;  // 멱등성 보장

  // 5. issuance_requests REQUESTED 생성
  const request = await issuanceRepo.create({ userId, eventType, ... });

  // 6. VASPServer에 TX 위탁 (ExternalVASPAdapter → POST /transactions)
  //    → tx_mint_requests SUBMITTED (txHash 획득)
  await txStateMachine.submitMintRequest({ ... });

  // 7. issuance_requests SUBMITTED 전이
  await issuanceRepo.updateStatus(request.id, 'SUBMITTED', { txHash });

  // 8. audit_log ISSUANCE_SUBMITTED 기록 (TxTransitionBridge 경유)
  await bridge.onSubmitted(request.id, txHash);
}
```

### ConsumerGroupPool — Consumer 오케스트레이터

```typescript
consumerPool = new ConsumerGroupPool(
  redisAdapter,
  streamDlq,
  { streamKey: 'kyobo:events', batchSize: 10, blockMs: 500, minIdleMs: 1_000 },
  [
    { groupName: 'nft-consumers',      consumerId: 'nft-1',      processors: [nftIssuedProcessor] },
    { groupName: 'activity-consumers', consumerId: 'activity-1', processors: [activityProcessor] },
  ],
);
consumerPool.start();
```

`ConsumerGroupPool.start()`는 각 Consumer Group에 대해 독립적인 폴링 루프를 시작한다.

```
ConsumerGroupPool
    ├── ConsumerGroupWorker(nft-consumers, nft-1)
    │       ├── _reclaimPending()  ← XAUTOCLAIM (minIdleMs 초과 PEL 회수)
    │       └── _processNewMessages()  ← XREADGROUP('>')
    │               └── processor.process(msg)
    │                       ├── 성공 → XACK
    │                       └── 실패 → _retryCount++ → DLQ (≥3회)
    │
    └── ConsumerGroupWorker(activity-consumers, activity-1)
            └── (동일 구조)
```

**두 Consumer Group이 같은 스트림(`kyobo:events`)을 구독하는 이유**:

Consumer Group은 독립적인 offset을 가진다. 같은 메시지가 `activity-consumers`와 `nft-consumers` 모두에게 전달된다. `ACTIVITY_ACHIEVED`는 `ActivityProcessor`가, `NFT_ISSUED`는 `NFTIssuedProcessor`가 처리한다. 상대방 이벤트는 `eventType` 필터로 무시한다.

### ChainEventListener — 폴링 기반 체인 이벤트 구독

```typescript
chainListener = new ChainEventListener(
  chainAdapter,
  [confirmHandler, new ProcessedEventHandler(mockVaspAddr, ledgerService)],
  [{ addr: mockVaspAddr, abi: MOCK_VASP_ABI, eventNames: ['Issued'] }],
  {
    async getLastProcessedBlock() { return inMemoryBlockStore.block; },
    async setLastProcessedBlock(b) { inMemoryBlockStore.block = b; },
  },
);
await chainListener.start();
```

- `handlers`: 이벤트가 감지되면 순서대로 호출된다.
  - `confirmHandler.handle()` → `issuance_requests` CONFIRMED 전이
  - `ProcessedEventHandler.handle()` → `processed_events` 멱등성 기록
- `BlockStore`: 마지막으로 처리한 블록 번호를 저장한다. 재기동 시 이 번호 이후 블록부터 폴링을 재개해 누락을 방지한다. 테스트에서는 인메모리 객체를 사용한다.
- `pollingInterval`: Hardhat 100ms, Sepolia 3000ms. 블록 확정 속도에 맞게 조정.

### WebhookServer — 인바운드 통합 지점

```typescript
const idempotency      = new IdempotencyGuard(new RedisIdempotencyStore(redis));
const webhookPublisher = new WebhookPublishHandler(streamPublisher, idempotency);

webhookServer = new WebhookServer({ port: WEBHOOK_PORT, secret: WEBHOOK_SECRET });
webhookServer.on('ACTIVITY_ACHIEVED', webhookPublisher.createHandler());
webhookServer.on('NFT_ISSUED',        webhookPublisher.createHandler());
await webhookServer.listen();
```

`WebhookServer`는 이벤트 라우터다. 수신된 웹훅 페이로드를 `eventType`으로 분기해 등록된 핸들러를 호출한다.

`WebhookPublishHandler`는 두 가지 일을 한다:
1. `IdempotencyGuard`로 `requestId` 중복 여부를 확인한다 (Redis `SET NX`).
2. 중복이 아니면 `RedisStreamPublisher.xadd()`로 `kyobo:events` 스트림에 발행한다.

즉, **WebhookServer는 교보 앱 서버의 인바운드와 VASPServer의 콜백 모두 동일한 경로로 처리한다**. 처리 로직의 차이는 각 Consumer Group의 `processor`가 담당한다.

---

## 12. 테스트 전용 클래스 해설

### PgHybridCoreBankingAdapter

```typescript
class PgHybridCoreBankingAdapter extends StubCoreBankingAdapter {
  constructor(private readonly pool: Pool) { super(); }

  override async getUserAccount(userId: string) {
    const { rows } = await this.pool.query(
      'SELECT wallet_addr FROM user_wallet_mapping WHERE user_id = $1',
      [userId],
    );
    if (!rows[0]) return null;
    return { userId, accountId: `acc-${userId}`, walletAddr: rows[0].wallet_addr, status: 'active' };
  }
}
```

**왜 이 클래스가 필요한가?**

실제 Core Banking 시스템은 테스트 환경에 없다. `StubCoreBankingAdapter`는 모든 메서드를 stub으로 구현해 `null`이나 빈 값을 반환한다. 여기서는 `getUserAccount()`만 오버라이드해 실제 PostgreSQL의 `user_wallet_mapping` 테이블에서 지갑 주소를 조회한다.

이 패턴이 중요한 이유: 테스트에서 Core Banking을 완전히 모킹하면 실제 DB 매핑 구조가 검증되지 않는다. `PgHybridCoreBankingAdapter`는 필요한 부분만 실제 DB로 연결하고 나머지는 stub을 유지한다.

### AlwaysFailProcessor

```typescript
class AlwaysFailProcessor extends NFTIssuedProcessor {
  async process(_msg: StreamMessage): Promise<void> {
    throw new Error('강제 실패 — DLQ 테스트용');
  }
}
```

`ConsumerGroupWorker`가 `_retryCount >= MAX_RETRIES(3)` 조건을 판단하는 경로를 테스트한다. 이 Processor는 항상 예외를 던지므로, 메시지에 `_retryCount: '3'`을 주입하면 첫 수신 즉시 DLQ로 라우팅된다.

### ProcessedEventHandler

```typescript
class ProcessedEventHandler implements IEventHandler {
  readonly eventName    = 'Issued';
  readonly contractAddr: string;

  async handle(event: ChainEvent): Promise<void> {
    const safePayload = JSON.parse(
      JSON.stringify(event.args, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
    await this.ledger.recordProcessedEvent(
      event.txHash, event.logIndex, event.eventName, BigInt(event.blockNumber), safePayload,
    );
  }
}
```

`ChainEventListener`에 두 번째 핸들러로 등록된다. `Issued` 이벤트가 감지되면 `processed_events` 테이블에 `(txHash, logIndex)` 쌍을 기록한다.

**BigInt 직렬화 문제**: ethers v6가 ERC-1155 tokenId를 `BigInt`로 디코딩하는데, `JSON.stringify`는 `BigInt`를 처리하지 못한다. replacer 함수로 `bigint → string` 변환을 명시적으로 처리한다. 이 한 줄이 없으면 PostgreSQL JSONB 저장 시 `TypeError: Do not know how to serialize a BigInt` 오류가 발생한다.

### waitFor 헬퍼

```typescript
async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`);
    await new Promise(r => setTimeout(r, 200));
  }
}
```

비동기 상태 변화를 폴링으로 기다린다. DB 조회나 잔액 확인을 조건 함수로 전달하면, 200ms마다 재시도하다가 타임아웃이 되면 테스트를 실패시킨다.

`label` 파라미터: 어떤 조건에서 타임아웃됐는지 에러 메시지에 포함된다. `waitFor timeout: CONFIRMED`처럼 출력되어 디버깅에 도움이 된다.

---

## 13. Sepolia 통합 테스트 — Hardhat과의 차이

Sepolia 테스트(`issuer-service-sepolia.integration.test.ts`)는 mock-vasp 테스트와 구조가 거의 동일하다. 차이점만 정리한다.

### beforeAll 차이

| 항목 | mock-vasp (Hardhat) | sepolia |
|---|---|---|
| 블록체인 | `GenericContainer('kyobo/hardhat-node:test')` | `SEPOLIA_RPC_URL` 환경변수 |
| MockVASP | 매 실행 신규 배포 | `SEPOLIA_MOCK_VASP_ADDR` 고정 주소 |
| TOKEN_ID | `'1001'` 고정 | `String(Date.now())` 동적 생성 |
| controlVasp | `AnvilVASPAdapter` | `SepoliaVASPAdapter` |
| pollingInterval | 100ms | 3000ms (기본값) |
| CHAIN_START_BLOCK | 0 (reset 후 0번 블록) | `chainAdapter.getBlockNumber()` 현재 블록 |

**TOKEN_ID를 동적 생성하는 이유**: Sepolia는 고정 컨트랙트이므로 이전 실행에서 발행된 토큰이 누적된다. 실행마다 새 tokenId를 쓰면 `balanceOf` 증분(+1)만 검증할 수 있어 이전 잔액과 무관하다.

**CHAIN_START_BLOCK을 현재 블록으로 설정하는 이유**: `ChainEventListener`가 블록 0부터 폴링하면 수십만 개의 과거 로그를 스캔한다. Alchemy 무료 플랜은 `eth_getLogs` 범위를 제한하므로 즉시 에러가 발생한다. 현재 블록부터 폴링을 시작해 신규 이벤트만 감지한다.

### 시나리오별 구현 차이

**PENDING 시나리오**:
- Hardhat: `evm_setAutomine(false)`로 블록 생성을 완전히 중단한다.
- Sepolia: `evm_setAutomine`을 지원하지 않는다. 대신 Sepolia TX 브로드캐스트 직후 `eth_getTransactionByHash`를 즉시 조회해 `blockNumber=null`인 구간(mempool pending)을 포착한다. Sepolia 블록 확정이 ~12s이므로 `SUBMITTED` 직후 조회하면 대부분 pending 상태다.

**REORG 시나리오**:
- Hardhat: `evm_snapshot` / `evm_revert`로 체인 상태를 정확히 롤백한다.
- Sepolia: 실제 체인 롤백은 불가능하다. 대신 `UPDATE tx_mint_requests SET status = 'REORGED'`로 DB에 직접 주입한다. `TxTransitionBridge`가 이 상태를 어떻게 처리하는지 — `issuance_requests`를 FAILED로 전이하는지, 재발행을 시도하는지 — 를 30초간 관찰한다.

**waitFor 타임아웃 차이**:
- Hardhat: 20~40초
- Sepolia: 60~300초 (블록 확정 ~12s + 네트워크 지연 고려)

---

## 14. InMemoryRedis 구현 원리

`stream-consumer.integration.test.ts`에 `InMemoryRedis` 클래스가 내장되어 있다. `REDIS_URL`이 없거나 Redis 연결에 실패하면 자동으로 이 구현체로 폴백한다.

```typescript
class InMemoryRedis {
  private streams = new Map<string, Array<{ id: string; fields: string[] }>>();
  private groups  = new Map<string, {
    lastId: string;
    pel:    Map<string, { consumer: string; deliveredAt: number; fields: string[] }>;
  }>();
}
```

**핵심 자료구조**:
- `streams`: 스트림 키별 메시지 배열. 메시지는 `{ id, fields }` 형태.
- `groups`: `스트림키:그룹명` 복합 키로 Consumer Group 상태 추적.
  - `lastId`: 이 그룹이 마지막으로 읽은 메시지 ID (새 메시지 필터링 기준)
  - `pel`: Pending Entry List. XREADGROUP으로 읽혔지만 XACK 안 된 메시지들.

**메시지 ID 생성**: `Date.now()` + 순번으로 Redis ID 형식(`타임스탬프-시퀀스`)을 흉내낸다.

```typescript
private genId(): string {
  return `${Date.now()}-${String(this.seq++).padStart(4, '0')}`;
}
```

**ID 비교**: Redis 스트림 ID 비교는 숫자적 대소 비교다. `'1000-0' < '1001-0'`처럼 타임스탬프 먼저, 같으면 시퀀스로 비교한다.

```typescript
private cmpId(a: string, b: string): number {
  const parse = (s: string) => s.split('-').map(Number) as [number, number];
  const [at, as_] = parse(a);
  const [bt, bs]  = parse(b);
  return at !== bt ? at - bt : as_ - bs;
}
```

**XAUTOCLAIM 구현**: PEL을 순회하며 `deliveredAt`이 `minIdleMs`를 초과한 항목을 새 consumer에게 재할당한다.

```typescript
async xautoclaim(key, group, consumer, minIdleMs, startId, _kw, count) {
  const now = Date.now();
  for (const [id, entry] of gs.pel) {
    if (this.cmpId(id, startId) >= 0 && now - entry.deliveredAt >= minIdleMs) {
      entry.consumer    = consumer;   // 소유자 변경
      entry.deliveredAt = now;        // 전달 시간 갱신
      claimed.push([id, entry.fields]);
    }
  }
}
```

**테스트 격리 전략**: Consumer Group 이름에 `Date.now()`를 포함한다.

```typescript
const CLAIM_GROUP = `${GROUP}-autoclaim-${Date.now()}`;
```

같은 스트림을 여러 테스트가 공유할 때, 각 테스트의 PEL이 다른 테스트에 영향을 주지 않도록 그룹 이름을 고유하게 만든다. PEL은 그룹 단위로 관리되므로 그룹이 다르면 완전히 독립적이다.

---

## 15. Reconcile 설계 — DB ↔ 온체인 정합성 검증

### 왜 Reconcile이 필요한가

NFT 발행 파이프라인은 여러 단계로 구성된다. 어느 단계에서든 장애가 발생하면 DB와 온체인 상태가 어긋날 수 있다.

| 불일치 유형 | 원인 예시 |
|---|---|
| `ONCHAIN_ONLY` | DB 기록 중 장애 → 온체인에는 있지만 DB에 없음 |
| `DB_ONLY` | 이중 발행 방지 로직 버그 → DB에는 있지만 온체인에 없음 |
| `AMOUNT_MISMATCH` | DB 수량과 온체인 잔액 불일치 |

Reconcile은 이 상태를 주기적으로 감지하고 알림을 보낸다. **자동 수정은 하지 않는다** — 원인 분석 후 운영자가 수동 보정한다.

### ReconcileService — 단일 사용자 비교 로직

```typescript
async reconcileNftHoldings(userId: string): Promise<ReconcileResult> {
  const dbHoldings     = await this.holdingRepo.getHoldings(userId);   // user_nft_holdings
  const chainHoldings  = await this.chainAdapter.getNftHoldings(       // TransferSingle 스캔
    this.contractAddr, walletAddr, this.fromBlock
  );

  const dbSet    = new Set(dbHoldings.map(String));
  const chainSet = new Set(chainHoldings.map(String));

  const discrepancies: Discrepancy[] = [];
  for (const id of chainSet) {
    if (!dbSet.has(id)) discrepancies.push({ tokenId: BigInt(id), type: 'ONCHAIN_ONLY' });
  }
  for (const id of dbSet) {
    if (!chainSet.has(id)) discrepancies.push({ tokenId: BigInt(id), type: 'DB_ONLY' });
  }
  return { isHealthy: discrepancies.length === 0, discrepancies };
}
```

**ERC-1155 열거 문제**: ERC-1155는 `tokenIds()` 같은 열거 API가 없다. `EVMAdapter.getNftHoldings()`는 `TransferSingle` 이벤트 로그를 스캔해 이 지갑이 관련된 tokenId 집합을 수집하고, `balanceOf(addr, id) > 0`인 것만 보유 중으로 판단한다.

### ReconcileAdminService — 실행 오케스트레이터

```
HOURLY  → user_nft_holdings WHERE updated_at >= NOW() - 1h → 변경된 사용자만
DAILY   → user_nft_holdings 전체 순회 → 누적 오차 감지
MANUAL  → 특정 userId 즉시 실행 → 보정 후 재검증용
```

실행 결과는 `reconcile_history` 테이블에 기록된다:

```sql
run_at, run_type, target_count, mismatch_count, mismatch_user_ids (JSONB), duration_ms
```

불일치 발생 시 심각도별 알림:
- **P3**: 1~4건
- **P2**: 5~9건
- **P1**: 10건 이상

### Admin HTTP 엔드포인트

```
POST :19870/admin/reconcile/run
Body: { "userId": "user-001", "operator": "admin-kim" }
→ runManualReconcile() 실행

GET  :19870/admin/reconcile/history?limit=10&runType=MANUAL
→ reconcile_history 조회
```

### JSONB auto-parse 주의사항

pg(node-postgres)는 JSONB 컬럼을 자동으로 JS 객체로 파싱한다. `mismatch_user_ids`가 JSONB이므로 조회 결과를 `JSON.parse()`로 다시 파싱하면 안 된다.

```typescript
// ❌ 잘못된 방법 — array.toString()이 호출되어 "[object Object]" 오류
const ids = JSON.parse(row.mismatch_user_ids);

// ✅ 올바른 방법 — pg가 이미 파싱한 배열 그대로 사용
const ids = row.mismatch_user_ids as string[];
```
