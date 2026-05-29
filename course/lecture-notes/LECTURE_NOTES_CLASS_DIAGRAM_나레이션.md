# 클래스 다이어그램 해설 — 나레이션 스크립트
## Section 7: Bootstrap — 모든 것이 어떻게 연결되는가

> 발표용 낭독 스크립트입니다. 각 STEP은 슬라이드 전환 기준입니다.

---

### 도입

지금까지 각 패키지의 클래스를 개별로 살펴봤습니다.
이제 마지막으로, 이 모든 클래스가 실제로 어떻게 하나의 시스템으로 연결되는지를 보겠습니다.

연결이 일어나는 곳은 `index.ts`의 `bootstrap()` 함수입니다.
이 함수 한 곳에서 모든 클래스가 생성되고, 의존성이 주입되고, 이벤트 구독이 등록됩니다.

순서가 중요합니다.
**내가 의존하는 것이 먼저 만들어져야 나를 만들 수 있습니다.**
그래서 인프라 → 어댑터 → 유틸 → 서비스 → 파이프라인 순서로 조립됩니다.

---

### STEP 1 — 인프라 레이어

가장 먼저 만들어지는 건 외부 시스템 연결 객체입니다.

`Redis`는 ioredis 인스턴스이고, `Pool`은 PostgreSQL 연결 풀입니다.
이 둘은 클래스가 아닙니다. 그냥 연결 객체입니다.

중요한 건, 이 두 객체가 **여러 클래스에 공유**된다는 점입니다.
각 서비스가 DB 연결을 따로 열면 연결 수가 폭발합니다.
그래서 하나만 만들어서 주입합니다.

---

### STEP 2 — 어댑터 레이어

다음은 외부 시스템을 추상화하는 어댑터 네 개입니다.

첫 번째, `EVMAdapter`입니다.
이 클래스는 `IBlockchainAdapter` 인터페이스를 **구현**합니다.
내부에는 ethers.js의 `JsonRpcProvider`와 `Wallet`을 갖고 있습니다.
`RPC_URL`, `CHAIN_ID`, `OPERATOR_PRIVATE_KEY` 환경변수를 받습니다.

두 번째, `ExternalVASPAdapter`입니다.
`IVASPAdapter`를 **구현**합니다. 외부 VASP의 REST API를 호출합니다.

세 번째, `InternalGatewayClient`와 `KyoboCoreBankingAdapter`입니다.
이 둘은 세트입니다.

`InternalGatewayClient`는 Java 내부원장 서버에 HTTP 요청을 보내는 클라이언트입니다.
내부에 `CircuitBreaker`를 **컴포지션**으로 가지고 있습니다.
Java 서버가 연속으로 실패하면 회로를 열어서 추가 요청을 차단합니다.
외부에서는 Circuit Breaker의 존재를 전혀 모릅니다.

`KyoboCoreBankingAdapter`는 `ICoreBankingAdapter`를 **구현**하고,
`InternalGatewayClient`를 **컴포지션**으로 소유합니다.
상위 레이어는 `ICoreBankingAdapter` 인터페이스만 알면 됩니다.
Java를 쓰는지, HTTP를 쓰는지 몰라도 됩니다.

---

### STEP 3 — 공통 유틸: DB 클라이언트와 멱등성

`PgDatabaseClient`는 `DatabaseClient` 인터페이스를 **구현**합니다.
`Pool`을 주입받아 `query()`와 `transaction()`을 wrapping합니다.
`LedgerService`가 이 인터페이스를 통해 DB에 접근하므로,
테스트할 때는 인메모리 구현체로 바꿔 끼울 수 있습니다.

멱등성 체계는 두 클래스로 구성됩니다.

`RedisIdempotencyStore`가 `IdempotencyStore` 인터페이스를 **구현**하고,
`IdempotencyGuard`가 이 인터페이스를 **컴포지션**으로 소유합니다.

상위 코드는 `IdempotencyGuard.run(key, fn)`만 호출하면 됩니다.
Redis를 쓰는지, 메모리를 쓰는지 알 필요가 없습니다.

---

### STEP 4 — 조건 서비스: Strategy 패턴

이벤트 발행 조건 판단 로직은 Strategy 패턴으로 분리되어 있습니다.

`IConditionStrategy` 인터페이스를 `ActivityConditionStrategy`가 **구현**합니다.
`EventConditionService`가 이 전략들을 배열로 **컴포지션**해서 관리합니다.

`registerStrategy()`로 런타임에 전략을 추가할 수 있습니다.
Phase 1에서는 걸음수를 검사하는 `ActivityConditionStrategy` 하나만 등록됩니다.

나중에 `CouponConditionStrategy`를 추가해도
`IssuerService` 코드는 전혀 수정하지 않습니다.
새 전략 클래스를 만들어서 등록만 하면 됩니다.
이게 Strategy 패턴의 핵심입니다.

---

### STEP 5 — TokenIssuerFactory: 발행 서비스 조립

이 시스템에서 가장 복잡한 조립이 여기서 일어납니다.

`TokenIssuerFactory`는 `IBlockchainAdapter`, `IVASPAdapter`, `ICoreBankingAdapter`를
**컴포지션**으로 소유합니다.

`createNFTIssuer()`를 호출하면 내부에서 여러 서비스를 생성하고 연결한 뒤 반환합니다.
단계별로 따라가 보겠습니다.

**5-1. 리포지토리 계층**

먼저 DB 리포지토리 세 개가 만들어집니다.
`PgTxRepository`는 `TxRepository` 인터페이스를 구현하고 `tx_mint_requests` 테이블을 담당합니다.
`PgIssuanceRequestRepository`는 `IIssuanceRequestRepository`를 구현하고 `issuance_requests`를 담당합니다.
`PgIssuancePolicyRepository`는 `IIssuancePolicyRepository`를 구현하고 `issuance_policies`를 담당합니다.

세 가지 모두 인터페이스를 구현합니다.
상위 서비스는 인터페이스만 알고, 구체 클래스는 교체 가능합니다.

**5-2. 서비스 계층**

`IssuancePolicyService`는 `IIssuancePolicyRepository`를 **컴포지션**으로 소유합니다.
정책 조회가 필요하면 리포지토리에 위임합니다.

`LedgerService`는 `DatabaseClient`와 `ICoreBankingAdapter`를 **컴포지션**으로 소유합니다.
`mint_requests` 테이블에 직접 쓰고,
상태가 바뀔 때마다 `ICoreBankingAdapter.recordAuditLog()`를 호출해서
Java 내부원장에 감사 로그를 남깁니다.

**5-3. TX 상태머신**

`VaspTxClientAdapter`는 `VaspTxClient` 인터페이스를 **구현**하고,
`IVASPAdapter`를 **컴포지션**으로 소유합니다.

왜 `IVASPAdapter`를 직접 쓰지 않고 한 번 더 감쌌냐면,
`TxStateMachineService`에게 필요한 건 TX 제출과 조회뿐인데,
`IVASPAdapter`는 지갑 생성, 이체 등 훨씬 넓은 기능을 포함하기 때문입니다.
인터페이스 분리 원칙입니다.

`TxStateMachineService`는 중요한 특징이 있습니다.
Node.js `EventEmitter`를 **상속**합니다.

상태가 바뀔 때마다 `emit('transition', { requestId, from, to })`를 발생시킵니다.
다른 클래스는 이 이벤트를 **구독**해서 후속 처리를 합니다.
이것이 두 테이블 cascade 업데이트의 핵심입니다.

**5-4. TxTransitionBridge**

`TxTransitionBridge`는 `LedgerService`, `IIssuanceRequestRepository`, `ICoreBankingAdapter`를
**컴포지션**으로 소유합니다.

`.attach(txStateMachine)`을 호출하면
`txStateMachine.on('transition', this._handler)`로 이벤트를 **구독**합니다.

이후부터는 TxStateMachineService가 상태 전이를 emit할 때마다
Bridge가 자동으로 반응해서
`mint_requests`와 `issuance_requests` 두 테이블을 cascade 업데이트합니다.

한 가지 주의할 점이 있습니다.
PENDING 상태는 매핑에 없습니다.
Bridge가 PENDING 이벤트를 수신해도 아무 테이블도 건드리지 않습니다.
TX가 PENDING이 되면 `mint_requests`와 `issuance_requests`는 SUBMITTED 그대로 유지됩니다.

**5-5. IssuerService**

`IssuerService`는 `IActivityIssuer` 인터페이스를 **구현**합니다.
`ActivityProcessor`는 `IActivityIssuer`만 알고, `IssuerService`라는 구체 클래스는 모릅니다.

의존성이 일곱 개입니다. 이 시스템에서 가장 많은 의존성을 가집니다.

`IssuancePolicyService`로 발행 정책을 조회하고,
`EventConditionService`로 조건 충족 여부를 판단하고,
`IVASPAdapter`로 AML 스크리닝을 하고,
`ICoreBankingAdapter`로 사용자 계좌를 조회하고,
`IIssuanceRequestRepository`로 `issuance_requests`를 INSERT하고,
`LedgerService`로 `mint_requests`를 INSERT하고,
`TxStateMachineService`로 TX를 제출합니다.

모두 컴포지션입니다. 생성자에서 받아 필드에 저장합니다.

**5-6. IssuanceConfirmHandler**

`IssuanceConfirmHandler`는 `IEventHandler` 인터페이스를 **구현**합니다.
`ChainEventListener`가 온체인 `Issued` 이벤트를 감지하면 이 핸들러의 `handle()`을 **호출**합니다.

내부에 `TxStateMachineService`와 `TxRepository`를 **컴포지션**으로 소유합니다.
txHash로 tx_mint_request를 찾아야 하고(`TxRepository`),
찾은 뒤 MINED → CONFIRMED 전이를 수행해야 합니다(`TxStateMachineService`).
이 전이가 emit을 발생시키고, Bridge가 받아서 cascade 업데이트합니다.

---

### STEP 6 — NFT 원장과 Reconcile 서비스

`PgNFTLedgerService`는 Factory 밖에서 별도로 생성됩니다.
`NFT_CONTRACT_ADDR`과 `CHAIN_ID` 환경변수가 필요하기 때문에
Factory 내부보다 `index.ts` 레벨에서 생성하는 것이 더 자연스럽습니다.

`NFTLedgerService` 인터페이스를 **구현**하고,
`ICoreBankingAdapter`를 **컴포지션**으로 소유합니다.

`creditNFT()`가 호출되면 로컬 DB에 직접 쓰지 않습니다.
`ICoreBankingAdapter.recordNftHolding()`을 통해 Java 내부원장에 전달합니다.
Java가 `user_nft_holdings` 테이블을 소유합니다.
Node.js가 직접 INSERT하면 Java의 중복 방지 로직이 우회됩니다. 절대 안 됩니다.

`ReconcileService`는 `IReconcileService`를 **구현**하고,
`ICoreBankingAdapter`와 `PgNftHoldingRepository`를 **컴포지션**으로 소유합니다.

온체인 NFT 잔액과 DB 보유 현황을 대조합니다.
불일치가 있으면 `NotifierAdapter`로 알림을 보냅니다.

`ReconcileAdminService`는 `ReconcileService`를 **컴포지션**으로 소유하며
Admin HTTP 엔드포인트를 제공합니다.
발행 파이프라인과 완전히 독립되어 있습니다.
실패해도 발행 파이프라인에 영향이 없습니다.

---

### STEP 7 — 스트림 파이프라인 조립

스트림 파이프라인은 세 단계로 흐릅니다.
Webhook 수신 → Redis 적재 → Consumer 처리입니다.

`WebhookPublishHandler`는 `RedisStreamPublisher`와 `IdempotencyGuard`를
**컴포지션**으로 소유합니다.
`createHandler()`가 반환하는 함수가
"멱등 체크 후 Redis에 적재"를 하나로 묶은 클로저입니다.

`WebhookServer`는 이 핸들러를 **직접 소유하지 않습니다.**
`.on(eventType, handler)`로 등록받을 뿐입니다.
느슨한 연결입니다.

`ProcessedEventHandler`는 `LedgerService`를 **컴포지션**으로 소유합니다.
`IEventHandler`를 **구현**하고, `ChainEventListener`에 등록됩니다.
온체인 이벤트가 이미 처리됐는지 마킹해서 중복 처리를 막습니다.

Consumer 쪽을 보면,
`ConsumerGroupWorker`는 `RedisConsumerClient`, `EventProcessor[]`, `DLQHandler`를
**컴포지션**으로 소유합니다.
`XREADGROUP`으로 메시지를 꺼내 `EventProcessor.process()`를 **호출**합니다.

`NFTIssuedProcessor`와 `ActivityProcessor`는 모두 `EventProcessor`를 **구현**합니다.
Worker는 어떤 Processor인지 모릅니다. 인터페이스를 통해서만 호출합니다.

`NFTIssuedProcessor`는 `IdempotencyGuard`와 `NFTLedgerService`를 컴포지션으로 소유합니다.
`ActivityProcessor`는 `IdempotencyGuard`와 `IActivityIssuer`를 컴포지션으로 소유합니다.

---

### STEP 8 — 이벤트 수신 서버 기동

마지막으로 두 이벤트 수신 채널이 기동됩니다.

`ChainEventListener`는 `IBlockchainAdapter`와 `IEventHandler[]`를
**컴포지션**으로 소유합니다.
폴링 루프를 돌면서 새 블록을 감지하면 등록된 핸들러의 `handle()`을 순서대로 **호출**합니다.
`IssuanceConfirmHandler`와 `ProcessedEventHandler` 두 핸들러가 등록됩니다.

`WebhookServer`는 세 가지 이벤트 타입을 처리합니다.

`ACTIVITY_ACHIEVED`와 `NFT_ISSUED`는 Redis Stream 경로입니다.
멱등성 체크 후 Redis에 적재하고, Consumer가 처리합니다.

`VASP_TX_FAILED`는 다릅니다.
Redis를 우회해서 `IssuerService.handleVaspTxFailed()`를 즉시 **호출**합니다.
TX 실패는 재시도 대기 없이 즉각 처리해야 하기 때문입니다.

---

### 세 경로 — 클래스 연결 전체 조망

Bootstrap이 완료되면 발행·확인 경로가 세 개 작동합니다.

**경로 1 — Phase 1: 동기 발행 구간**

시작은 `ActivityProcessor`입니다.
`ConsumerGroupWorker`가 Redis에서 메시지를 꺼내 `process()`를 **호출**합니다.

`ActivityProcessor`는 `IActivityIssuer` 인터페이스를 통해 `IssuerService.issueActivityNFT()`를 **호출**합니다.
`IssuerService`는 컴포지션으로 소유한 일곱 개 의존성을 순서대로 호출합니다.
정책 조회 → 조건 판단 → AML 스크리닝 → 계좌 조회 → DB INSERT → TX 제출.

TX 제출이 완료되면 `issuance_requests`는 SUBMITTED 상태입니다.
이 시점에서 동기 구간이 끝납니다.
이후 상태 전이는 이벤트 기반으로 진행됩니다.

**경로 2 — Phase 2A: VASP 콜백 → NFT 원장 갱신**

외부 VASP가 NFT_ISSUED 웹훅을 보냅니다.
`WebhookServer`가 HMAC 서명을 검증하고 202를 즉시 응답합니다.
그리고 비동기로 `WebhookPublishHandler`가 멱등 체크 후 Redis에 적재합니다.

`nft-consumers` Worker가 메시지를 꺼내 `NFTIssuedProcessor.process()`를 **호출**합니다.
`NFTIssuedProcessor`는 `PgNFTLedgerService.creditNFT()`를 **호출**합니다.
`PgNFTLedgerService`는 `ICoreBankingAdapter.recordNftHolding()`을 **호출**합니다.
HTTP를 통해 Java 내부원장에 전달되고, Java가 `user_nft_holdings`에 INSERT합니다.

**경로 3 — Phase 2B: 체인 직접 폴링 → issuance_requests CONFIRMED**

`ChainEventListener`가 폴링 루프를 돌다가 온체인 `Issued` 이벤트를 감지합니다.
`IssuanceConfirmHandler.handle()`을 **호출**합니다.

핸들러는 `TxRepository.findByTxHash()`로 레코드를 찾고,
`TxStateMachineService.handleMined()` → `handleConfirmed()`를 순서대로 **호출**합니다.

`handleConfirmed()`가 `emit('transition', CONFIRMED)`를 발행합니다.
`TxTransitionBridge`가 이 이벤트를 **구독**하고 있어서 자동으로 반응합니다.
`LedgerService.updateMintRequest()`와 `IIssuanceRequestRepository.updateStatus('CONFIRMED')`를 **호출**합니다.
`ICoreBankingAdapter.recordNftHolding()`과 `recordAuditLog()`도 **호출**합니다.

동시에 `ProcessedEventHandler.handle()`도 호출되어
`LedgerService.recordProcessedEvent()`로 처리 완료를 마킹합니다.

**두 경로가 동시에 완주해도 괜찮습니다.**
`TxStateMachineService`의 상태 전이 가드가
이미 CONFIRMED된 요청에 대한 재전이를 `InvalidStateTransitionError`로 차단합니다.
Bridge는 이 예외를 catch하고 무시합니다. 멱등합니다.

---

### 통합 테스트가 증명하는 것들

클래스 다이어그램을 다 봤으니, 이제 이 구조가 **실제로 동작한다는 걸 어떻게 확인하는지** 보겠습니다.
`issuer-service-mock-vasp.integration.test.ts` 파일 하나에 11개 시나리오가 있습니다.
각 시나리오가 무엇을 증명하는지 설명하겠습니다.

---

#### 세 레이어 상태머신 — 이름을 명확히 하겠습니다

먼저 테이블 이름부터 정리하겠습니다.

`tx_mint_requests` 테이블은 **TxStatus** 레이어입니다.
TX 자체의 상태입니다: REQUESTED → SUBMITTED → PENDING → MINED → CONFIRMED → FINALIZED.

`mint_requests` 테이블은 **MintStatus** 레이어입니다.
발행 작업 단위 상태입니다. TxStatus와 거의 동일하게 따라갑니다.

`issuance_requests` 테이블은 **IssuanceStatus** 레이어입니다.
비즈니스 관점 상태입니다: SUBMITTED → CONFIRMED → COMPLETED.

TxTransitionBridge가 'transition' 이벤트를 받아서 이 세 레이어를 cascade 업데이트합니다.
**한 이벤트에 세 테이블이 한꺼번에 갱신됩니다.**

---

#### 테스트 환경 전용 클래스 — PgHybridCoreBankingAdapter

테스트 코드에 `PgHybridCoreBankingAdapter`라는 클래스가 있습니다.
이 클래스는 **운영 코드에 없습니다.** 테스트 환경 전용입니다.

`KyoboCoreBankingAdapter`를 **상속**합니다.
`getUserAccount()`만 오버라이드합니다.
운영에서는 Java에서 계좌를 조회하지만, 테스트에서는 Java 서버가 없으니
로컬 DB의 `user_wallet_mapping` 테이블에서 직접 읽습니다.

나머지 — `recordNftHolding()`, `recordAuditLog()` — 는 부모 클래스 그대로 씁니다.
Java 컨테이너를 통해 씁니다.

이게 핵심입니다.
**테스트도 실제 Java 컨테이너를 거칩니다.**
`getUserAccount()`만 로컬 DB로 우회할 뿐, 나머지는 운영과 동일한 경로입니다.

---

#### beforeEach — 왜 vaspServer.resetNonce()가 필요한가

각 테스트 시작 전 `beforeEach`에서 반드시 `vaspServer.resetNonce()`를 호출합니다.

이유가 있습니다.

`VASPServer` 내부에 `NonceManager`가 있습니다.
`NonceManager`는 내부 카운터로 nonce를 추적합니다.
TX를 보낼 때마다 `0, 1, 2, 3...` 자동 증가합니다.

REORG 시나리오에서 `evm_revert`를 호출하면
체인의 nonce는 스냅샷 시점으로 롤백됩니다.
하지만 `NonceManager` 내부 카운터는 그대로입니다.

다음 TX를 보낼 때 카운터가 `5`를 가리키는데 체인 nonce는 `2`라면
"nonce too high" 에러가 납니다.

`resetNonce()`가 내부 카운터를 리셋해서 체인에서 실제 nonce를 다시 조회합니다.
테스트 격리의 기본 전제입니다.

---

#### [1] NORMAL — 무엇을 확인하는가

정상 발행 시나리오입니다.

테스트가 끝나고 DB에서 직접 검증합니다.
`issuance_requests.status = 'COMPLETED'`인지 확인합니다.

더 중요한 게 있습니다.
`processed_events` 테이블에 `(txHash, logIndex)` 쌍이 기록됐는지 확인합니다.
`ProcessedEventHandler`가 제대로 동작했다는 증거입니다.
중복 처리 방지 마킹이 실제로 DB에 남습니다.

`audit_log`에 `ISSUANCE_CONFIRMED` 이벤트가 기록됐는지도 확인합니다.
TxTransitionBridge가 CONFIRMED 전이를 처리할 때
`ICoreBankingAdapter.recordAuditLog()`를 자동 호출합니다.
Java 컨테이너가 `audit_log`에 씁니다.

이 검증 세 가지가 통과하면
스트림 파이프라인부터 체인 이벤트 수신까지 전체 경로가 정상이라는 뜻입니다.

---

#### [2] REVERT — TX 실패 처리

MockVASP 컨트랙트를 REVERT 모드로 설정합니다.
`issueActivityNFT()` 호출 시 `eth_estimateGas` 단계에서 revert됩니다.

`VASPServer`의 `_handleSubmit`이 `try-catch`에 걸려 500을 반환합니다.
`ExternalVASPAdapter`가 이 500을 받고 예외를 던집니다.
`IssuerService`가 예외를 catch해서 `issuance_requests.status = 'FAILED'`로 기록합니다.

이 시나리오가 확인하는 것은 **TX 실패가 조용히 묻히지 않는다**는 것입니다.
예외가 FAILED 상태로 정확히 전파됩니다.

---

#### [3] NO_EMIT — 이벤트 없는 민팅

컨트랙트가 민팅은 성공하지만 `Issued` 이벤트를 발행하지 않는 시나리오입니다.
`ChainEventListener`는 이벤트가 없으니 반응하지 않습니다.
`IssuanceConfirmHandler`도 호출되지 않습니다.
상태가 SUBMITTED에서 멈춥니다.

이 시나리오는 `[poll-1]`과 연결됩니다.

---

#### [poll-1] pollStaleRequests — 폴백 메커니즘

NO_EMIT 상태에서 `pollStaleRequests()`가 개입하는 시나리오입니다.

정확한 흐름을 보겠습니다.

먼저 NO_EMIT 모드로 TX를 제출합니다. `issuance_requests`는 SUBMITTED 상태입니다.
테스트에서 DB의 `updated_at`을 직접 조작해서 11분 전으로 설정합니다.
그런 다음 `pollStaleRequests()`를 명시적으로 호출합니다.

`pollStaleRequests()`가 SUBMITTED 상태 TX 중 `updated_at`이 10분 이상 된 것을 찾습니다.
찾으면 `vasp.getStatus(txHash)`를 호출합니다.

`ExternalVASPAdapter`가 HTTP로 `VASPServer GET /transfers/:txHash`를 요청합니다.
`VASPServer`는 내부 `txStatuses` 맵에서 해당 txHash의 상태를 찾아 반환합니다.
TX는 브로드캐스트됐으니 'completed'입니다.

`pollStaleRequests()`가 'completed'를 받으면 `handleMined()` → `handleConfirmed()`를 호출합니다.
이후 Bridge가 cascade 업데이트합니다.

결론: **이벤트를 못 받아도 폴링으로 복구합니다.**
이게 `VASPServer`의 `txStatuses` 맵이 존재하는 이유입니다.

---

#### [4] PENDING — 블록 채굴 중단

`AnvilVASPAdapter.freezeMining()`으로 자동 채굴을 중단합니다.
TX를 제출하면 mempool에 체류합니다. `issuance_requests`는 SUBMITTED 그대로입니다.

앞서 설명한 대로 Bridge는 PENDING 이벤트에 반응하지 않습니다.
PENDING이 돼도 테이블은 바뀌지 않습니다.

`mineBlock(1)`을 호출하면 블록이 생성되고 TX가 확정됩니다.
그 이후는 정상 경로와 동일합니다.

이 시나리오가 확인하는 것은 **mempool 체류 상황에서 시스템이 무너지지 않는다**는 것입니다.

---

#### [5] REORG — 체인 롤백

`snapshot()`으로 현재 체인 상태를 저장합니다.
정상 발행을 진행합니다. SUBMITTED 전이까지 확인합니다.
그런 다음 `revertToSnapshot(snapshotId)`으로 체인을 스냅샷 시점으로 롤백합니다.

롤백 이후 블록은 존재하지 않습니다.
TxTransitionBridge가 REORGED 처리를 합니다.

이때 `vaspServer.resetNonce()`가 필수입니다.
체인이 롤백됐으니 nonce도 롤백됐습니다.
NonceManager 내부 카운터를 리셋해야 다음 TX가 정상 nonce로 전송됩니다.

---

#### [stream-2] 멱등성 — 같은 메시지 두 번

같은 이벤트를 두 번 전송합니다.
`IdempotencyGuard`가 두 번째 메시지를 Redis에 적재하지 않습니다.
`NFTIssuedProcessor`가 한 번만 실행됩니다.
`user_nft_holdings`에 중복 INSERT가 발생하지 않습니다.

---

#### [stream-3] DLQ — 실패 메시지 격리

`AlwaysFailProcessor`라는 테스트 전용 Processor가 있습니다.
`process()`가 항상 예외를 던집니다.

`ConsumerGroupWorker`가 재시도 횟수를 추적합니다.
`retryCount >= 3`이 되면 `DLQHandler`로 메시지를 이동합니다.
메시지가 무한 재시도 루프에 빠지지 않습니다.

정상 메시지와 실패 메시지가 같은 Consumer에서 처리될 때,
실패 메시지가 DLQ로 빠진 뒤 정상 메시지는 계속 처리됩니다.
이게 DLQ가 있는 이유입니다.

---

#### [stream-4] XAUTOCLAIM — Consumer 크래시 복구

가장 복잡한 시나리오입니다.

배경: Redis XREADGROUP으로 메시지를 꺼냈는데 Consumer가 XACK를 보내지 않으면
메시지가 PEL(Pending Entries List)에 남습니다.

`CRASH_CONSUMER`가 메시지를 XREADGROUP으로 꺼냅니다.
처리하다가 크래시합니다. XACK를 보내지 않습니다.
메시지가 PEL에 잔류합니다.

`minIdleTime`을 200ms로 설정해서 빠른 테스트가 가능하게 합니다.
200ms가 지나면 해당 메시지는 "오래된 PEL 항목"이 됩니다.

`NEW_CONSUMER`가 `XAUTOCLAIM`을 호출합니다.
200ms 이상 방치된 PEL 항목을 NEW_CONSUMER가 소유권을 가져옵니다.
정상 처리하고 XACK를 보냅니다.

Sepolia 환경에서는 `minIdleTime`이 300,000ms (5분)입니다.
실제 네트워크에서 Consumer가 재시작하는 시간을 고려한 값입니다.

---

#### [reconcile-1] 불일치 감지와 감사 로그

정상 발행을 합니다. `user_nft_holdings`에 기록됩니다.

그런 다음 테스트에서 `user_nft_holdings` 레코드를 직접 DELETE합니다.
이제 온체인에는 NFT가 있는데 DB에는 없는 상태입니다.

`runManualReconcile()`을 호출합니다.
`ReconcileService`가 온체인 잔액과 DB 현황을 대조합니다.
불일치 유형이 `ONCHAIN_ONLY`입니다. 온체인에만 있고 DB에는 없습니다.

`reconcile_history` 테이블에 기록됩니다.
`runType = 'MANUAL'`, `mismatch_count = 1`.

`audit_log`에도 두 개 항목이 기록됩니다.
`RECONCILE_MANUAL_TRIGGER` — 재조정이 수동으로 트리거됐다.
`RECONCILE_MISMATCH_DETECTED` — 불일치가 발견됐다.

중요: `audit_log`는 Node.js가 직접 쓰지 않습니다.
Java 컨테이너를 통해 씁니다.
Java가 `audit_log`에 쓸 때 이전 레코드의 SHA-256 해시를 체인으로 연결합니다.
누군가 중간 레코드를 수정하면 해시 체인이 끊깁니다. 탐지 가능합니다.

---

#### [burst] — 동시 5개 발행

5개 요청을 동시에 보냅니다.
`Promise.all()`로 병렬 실행합니다.

`VASPServer` 내부 `NonceManager`가 nonce를 직렬화합니다.
TX가 동시에 들어와도 nonce 0, 1, 2, 3, 4가 순서대로 배정됩니다.
"nonce too low" 또는 "nonce already used" 에러가 발생하지 않습니다.

5개 모두 `issuance_requests.status = 'COMPLETED'`로 완료됩니다.

이 시나리오가 증명하는 것:
**NonceManager 없이는 동시 발행이 불가합니다.**

---

#### Walkthrough 테스트 — 내부 호출 흔적 추적

`walkthrough` 테스트가 있습니다.
prototype-patch 계측을 사용합니다.

실제 서비스 메서드를 감싸서 호출 여부와 호출 순서를 추적합니다.
`IssuerService.issueActivityNFT()` 내부에서 어떤 메서드가, 어떤 순서로, 몇 번 호출됐는지
테스트 코드가 직접 확인합니다.

클래스 다이어그램에서 보이는 의존성이 **실제로 그 순서로 호출된다는 것을 실증**합니다.
다이어그램과 코드의 일치성 검증입니다.

---

#### Sepolia vs Anvil — 환경 차이

마지막으로 두 환경의 차이를 정리합니다.

Anvil에서는 `evm_setAutomine`, `evm_snapshot`, `evm_revert`를 쓸 수 있습니다.
채굴을 멈추고, 체인 상태를 저장하고, 롤백할 수 있습니다.
테스트가 체인을 완전히 제어합니다.

Sepolia에서는 이 RPC들이 지원되지 않습니다.
REORG 시나리오는 DB 상태를 직접 주입하는 방식으로 대체합니다.

Sepolia에서 `TOKEN_ID`는 `Date.now()`를 사용합니다.
여러 테스트가 같은 tokenId를 쓰면 컨트랙트에서 충돌이 납니다.
타임스탬프를 써서 매번 다른 ID를 생성합니다.

Sepolia는 Alchemy API를 씁니다.
이벤트 조회 범위가 10블록으로 제한됩니다.
그래서 `ChainEventListener`의 폴링 범위를 최대 10블록으로 잘라야 합니다.

`XAUTOCLAIM`의 `minIdleTime`도 다릅니다.
Anvil은 200ms, Sepolia는 300,000ms (5분).
실제 네트워크에서 Consumer 재시작 시간을 충분히 잡아야 오탐이 나지 않습니다.

---

### 마무리 — 관계 타입이 중요한 이유

클래스 다이어그램에서 관계 타입을 구분하는 이유가 있습니다.

**구현**은 교체 가능하다는 뜻입니다. `IVASPAdapter`를 구현한 `ExternalVASPAdapter` 대신
다른 구현체로 바꿔도 상위 코드는 수정할 필요가 없습니다.

**컴포지션**은 생명주기를 함께한다는 뜻입니다. 소유자가 생성될 때 소유물도 생성되고,
소유자가 사라질 때 소유물도 사라집니다.

**이벤트 구독**은 런타임 연결입니다. Bootstrap 시 `.attach()`나 `.on()`으로 연결하고,
이후부터는 emit이 발생할 때마다 자동으로 반응합니다.

이 세 가지를 구분할 수 있으면, 코드를 수정할 때 어떤 클래스가 영향을 받는지
다이어그램만 보고도 예측할 수 있습니다.

이상으로 클래스 다이어그램 전체 해설을 마칩니다.

---

*총 분량 기준 낭독 시간: 약 40~55분 (질의응답 제외)*
