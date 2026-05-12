# 기술 스택 의사결정 문서

**작성**: CoinCraft (EJ Kim)  
**작성일**: 2026-04-24  
**업데이트**: 2026-04-24 (교보DTS 유선 확인 반영)  
**상태**: **런타임·아키텍처 방향 확인됨 — 세부 항목 추가 협의 필요**

---

## 확인된 사항 (2026-04-24 유선)

```
[교보생명 내부망]       Java — 확정
  Core Banking, 내부 DB, 감사 로그
        ↕ REST API
[내부망 (Node.js 서비스)]  Node.js / TypeScript 마이크로서비스 — 확정
  블록체인 인터페이스, VASP 연동, 이벤트 파이프라인
        ↕
[외부 VASP / 블록체인]
```

| 항목 | 상태 | 내용 |
|---|---|---|
| 내부망 런타임 | ✅ **확정** | Java |
| 내부망 Node.js 런타임 | ✅ **확정** | Node.js / TypeScript |
| 데이터베이스 | 🔲 **유력** | Oracle (사내 고성능 Oracle 사용 중 — 유선 언급) |
| 프레임워크 | 🔲 미결정 | — |
| 메시지 큐 | 🔲 미결정 | — |
| 보안점검 Node.js 허용 여부 | ⚠️ **확인 필요** | Java 외 허용 여부 서면 확인 필요 |

> **보안점검 관련**: Node.js가 사내 보안점검 허용 목록에 있는지 공식 확인 필요. 내부망에 배치되지만 보안정책상 런타임 허용 범위 서면 확인이 필요하다.

---

## 결정 항목 요약

| # | 항목 | 상태 | 내용 |
|---|---|---|---|
| 1 | 내부망 런타임 | ✅ **확정** | Java |
| 2 | 내부망 Node.js 런타임 | ✅ **확정** | Node.js / TypeScript |
| 3 | 데이터베이스 | 🔲 **유력** | Oracle (사내 사용 중) |
| 4 | Node.js 프레임워크 | 🔲 미결정 | — |
| 5 | 메시지 큐 | 🔲 미결정 | — |
| 6 | 스마트컨트랙트 언어 | ⚪ 고정 | Solidity |
| 7 | 블록체인 (Phase 1) | ✅ **확정** | Ethereum Mainnet (월렛원 연동) |
| 7-2 | 블록체인 (Phase 2+) | 🔲 추상화 대비 | XRPL, Circle ARC |
| 8 | VASP 파트너 | ✅ **내부 확정** | 월렛원 (WalletOne) |
| 9 | 보안점검 Node.js 허용 | ⚠️ 확인 필요 | 서면 확인 전 리스크 열려있음 |

---

## 1. 백엔드 런타임 — Node.js(TypeScript) vs Java

### 현재 스켈레톤

Node.js + TypeScript

### 비교

| 항목 | Node.js / TypeScript | Java |
|---|---|---|
| 블록체인 생태계 | ethers.js, viem, Hardhat 모두 네이티브 지원 | web3j (기능 격차 있음, 커뮤니티 작음) |
| 국내 금융권 표준 | 비표준 | 사실상 표준 (대부분 Java Spring) |
| 교보 기존 개발팀 숙련도 | 낮을 가능성 높음 | 높을 가능성 높음 |
| 장기 유지보수 | 교보 팀이 학습 필요 | 기존 역량 활용 가능 |
| 블록체인 인터페이스 개발 속도 | 빠름 | 느림 (web3j 래핑 비용) |
| 외부 벤더 연동 SDK | 대부분 JS/TS 우선 제공 | 이후 제공되거나 없는 경우 많음 |

### 고려사항

교보의 기존 백엔드 스택이 Java Spring이라면, TypeScript 서비스를 **독립 마이크로서비스**로 운영하고 기존 시스템과 REST API로 통신하는 구조가 현실적이다. 이 경우 교보 내부 Java 팀이 TypeScript 서비스를 직접 유지보수해야 한다는 점을 감안해야 한다.

반대로 Java로 전환하면 블록체인 인터페이스 레이어(ethers.js → web3j 전환) 작업이 추가로 필요하다.

### CoinCraft 추천

**Node.js / TypeScript 유지** — 단, 독립 마이크로서비스로 격리 운영

블록체인 인터페이스 레이어(VASP 연동, 체인 이벤트 처리, 컨트랙트 호출)는 ethers.js 생태계에 직접 의존한다. 이 레이어를 Java로 전환하면 web3j의 기능 공백을 직접 메워야 하는 리스크가 생기고, 외부 VASP SDK가 JS/TS만 제공하는 경우 대응이 불가능해진다.

대신 **기존 Java Spring 시스템과의 연동은 REST API 경계**로 명확히 분리한다. 블록체인 플랫폼 서비스가 독립된 마이크로서비스로 운영되면, 교보 내부 Java 팀이 Java 영역을 유지하면서 블록체인 서비스는 별도로 관리할 수 있다.

교육 과정에서 수강자들이 이 TypeScript 코드베이스를 직접 구현하게 되므로, 과정 종료 후 그대로 인수인계가 가능하다는 점도 장점이다.

### Java Spring 선택 시 예상 이슈

Java Spring이 교보DTS 표준이고 이 방향으로 결정된다면, 아래 이슈들을 사전에 인지하고 대응 계획을 수립해야 한다.

**① web3j의 기능 격차**

ethers.js는 블록체인 업계 표준 JS 라이브러리다. Java의 대응 라이브러리인 web3j는 기본 기능은 동작하지만, 다음 기능들이 누락되거나 불안정하다:

- EIP-1559 트랜잭션 수수료 모델 지원 불완전
- UUPS Proxy 컨트랙트 자동 감지 및 ABI 연결 미지원
- TypeChain(ABI → 타입 자동 생성) 상당 도구 없음 — ABI 연동 코드를 수동 작성해야 함
- WebSocket 기반 실시간 이벤트 구독 안정성 낮음 (폴링으로 대체해야 하는 경우 발생)

**② Hardhat은 JS/TS 전용**

스마트컨트랙트 컴파일·배포·테스트 환경(Hardhat)은 JS/TS 기반이다. Java Spring으로 전환해도 **컨트랙트 개발 환경은 반드시 Node.js가 필요**하다. 결과적으로 두 개의 언어 환경을 동시에 유지해야 한다:

```
컨트랙트 개발·배포: Node.js (Hardhat) — 불가피
백엔드 서비스:     Java Spring (web3j)
```

두 환경 사이의 ABI 파일 동기화, 컨트랙트 주소 관리를 별도로 처리해야 한다.

**③ VASP SDK 호환성 리스크**

외부 VASP 파트너사(월렛원, 코다, EQBR 등)가 제공하는 SDK가 JS/TS만 지원하는 경우, Java에서는 REST API를 직접 호출하는 클라이언트를 처음부터 작성해야 한다. SDK가 없으면 Travel Rule 데이터 구조, 서명 방식 등 세부 스펙을 문서만 보고 구현해야 하므로 개발 기간과 오류 가능성이 증가한다.

**④ 이 교육 과정과의 단절**

현재 50시간 교육 과정에서 수강자들이 직접 구현하는 코드베이스가 TypeScript다. Java Spring으로 전환하면 교육 산출물(스켈레톤 코드)을 그대로 프로덕션에 가져갈 수 없고, 전환 작업이 별도로 필요하다. 교육 → 프로덕션 연속성이 끊긴다.

**⑤ 하이브리드 옵션의 현실**

"블록체인 인터페이스는 TS, Core Banking 연동은 Java" 하이브리드는 언뜻 좋아 보이지만 운영 복잡도가 두 배가 된다. 두 언어 스택의 빌드·배포·모니터링·온콜 대응을 모두 유지해야 한다. 팀 규모가 충분히 크지 않다면 오히려 리스크다.

---

### 결정

> ⚠️ **보안점검 Java 한정 여부 확인 전까지 결정 보류**

- [ ] Node.js / TypeScript (내부망) + Java (내부망) 하이브리드 ← CoinCraft 추천, **단 보안점검 통과 가능 여부 선확인 필수**
- [ ] Java Spring 전체 전환 (보안점검 Java 한정이 확정될 경우)
- [ ] Node.js 승인 신청 후 진행 (예외 승인 프로세스 있는 경우)

**결정 주체**: 교보DTS 아키텍처팀 + 보안팀  
**선행 조건**: 내부 보안점검 런타임 허용 범위 서면 확인  
**결정일**: ___________

---

## 2. 백엔드 프레임워크

### 현재 스켈레톤

프레임워크 없음 (순수 TypeScript 클래스 구조)

### 비교 (Node.js 유지 시)

| 항목 | Fastify | NestJS | Express | 없음 (현재) |
|---|---|---|---|---|
| 성능 | 최고 | 중간 | 중간 | N/A |
| 구조화 | 낮음 | 높음 (데코레이터, DI 내장) | 낮음 | 수동 관리 |
| Java Spring 개발자 친숙도 | 낮음 | 높음 (Spring과 유사한 패턴) | 낮음 | 낮음 |
| 엔터프라이즈 적합성 | 중간 | 높음 | 낮음 | 낮음 |
| 학습 곡선 | 낮음 | 중간 | 낮음 | 없음 |

### 고려사항

교보 팀이 Java Spring 배경이라면 **NestJS**가 가장 친숙하다. DI 컨테이너, 모듈 시스템, 데코레이터 방식이 Spring과 유사하다.

현재 스켈레톤은 프레임워크 없이 순수 클래스로 작성되어 있어, 어떤 프레임워크도 적용 가능하다.

### CoinCraft 추천

**NestJS** (Node.js 유지 시)

교보DTS 개발자들의 주력이 Java Spring이라면 NestJS가 가장 빠르게 적응할 수 있는 선택이다. `@Injectable()`, `@Controller()`, `@Module()` 데코레이터와 DI 컨테이너 구조가 Spring의 `@Service`, `@RestController`, `@Configuration`과 거의 1:1로 대응된다. 엔터프라이즈 수준의 모듈화와 테스트 구조도 Spring과 유사하게 가져갈 수 있다.

단, 현재 스켈레톤 교육 과정에서는 프레임워크 없이 순수 클래스로 진행한다. 핵심 비즈니스 로직과 인터페이스 구조를 먼저 이해한 후, 프레임워크는 이후 프로덕션 전환 시 적용하는 것이 학습 순서상 맞다.

### 결정

- [ ] 프레임워크 없음 유지 (교육 과정 중)
- [ ] Fastify
- [ ] NestJS (Spring 유사 구조) ← CoinCraft 추천 (프로덕션 전환 시)
- [ ] Express

**결정 주체**: 교보DTS 아키텍처팀  
**결정일**: ___________

---

## 3. 데이터베이스

### 현재 스켈레톤

미지정. `DatabaseClient` 인터페이스만 정의:

```typescript
interface DatabaseClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
```

이 인터페이스를 구현하는 어댑터를 교체하면 어떤 DB도 연결 가능하다.

### 비교

| 항목 | PostgreSQL | Oracle | MySQL / MariaDB |
|---|---|---|---|
| 국내 금융권 사용 | 증가 중 | 매우 많음 | 중간 |
| 교보 기존 인프라 | 확인 필요 | 확인 필요 | 확인 필요 |
| 라이선스 비용 | 무료 (오픈소스) | 유료 (고비용) | 무료 |
| JSON/JSONB 지원 | 우수 | 가능 | 가능 |
| 감사 로그 저장 적합성 | 우수 | 우수 | 중간 |
| TS 드라이버 (`pg`, `mysql2`) | 성숙 | `oracledb` (사용 가능) | 성숙 |

### 고려사항

교보생명 기존 Core Banking 시스템이 사용하는 DB가 있다면, 일관성을 위해 같은 DB를 사용하는 것이 운영 측면에서 유리할 수 있다. 단, 블록체인 플랫폼 DB는 기존 Core Banking DB와 **분리 운영**을 권장한다 (장애 격리, 감사 추적 독립성).

### CoinCraft 추천

**교보 내부에 Oracle이 표준이면 Oracle, 그렇지 않으면 PostgreSQL**

원칙은 하나다: **블록체인 플랫폼 DB는 기존 Core Banking DB와 분리하되, DB 엔진 종류는 교보 내부 운영 표준을 따른다.** 두 가지를 섞어 운영하면 DBA 부담이 커진다.

교보DTS 내부에 이미 Oracle DBA 조직이 있고 Oracle이 표준이라면 Oracle을 쓰는 것이 맞다. 만약 신규 시스템에 오픈소스 스택을 도입하는 방향을 고려한다면 PostgreSQL을 추천한다. PostgreSQL은 `JSONB` 타입으로 온체인 이벤트 원본 데이터를 그대로 저장할 수 있고, 감사 로그용 `APPEND ONLY` 패턴 구현에 적합하며, 라이선스 비용이 없다.

MySQL은 감사 로그 무결성 보장(행 수준 잠금, WAL 구조) 측면에서 PostgreSQL에 비해 약하다. 금융 감사 로그 용도로는 비추천.

### 결정

- [ ] Oracle (교보 내부 표준이면 이쪽)
- [ ] PostgreSQL ← CoinCraft 추천 (신규 스택 도입 시)
- [ ] MySQL / MariaDB
- [ ] 기타: ___________

**결정 주체**: 교보DTS 인프라팀  
**결정일**: ___________

---

## 4. 메시지 큐 (이벤트 파이프라인)

### 현재 스켈레톤

Redis Streams (Consumer Group + DLQ 구조)

### 역할

온체인 이벤트를 수신하고 내부 원장·감사 로그 처리에 비동기로 전달하는 파이프라인. 장애 시 메시지 유실 방지, 재처리 보장이 핵심.

### 비교

| 항목 | Redis Streams (현재) | Apache Kafka | AWS SQS / SNS | RabbitMQ |
|---|---|---|---|---|
| 운영 복잡도 | 낮음 (DB처럼 운영) | 높음 (클러스터 관리) | 낮음 (매니지드) | 중간 |
| 메시지 보존 기간 | 설정 가능 | 장기 가능 | 최대 14일 | 설정 가능 |
| 처리량 | 충분 (수만 건/초) | 매우 높음 | 높음 | 중간 |
| 금융권 사용 | 드묾 | 많음 | 많음 (클라우드) | 있음 |
| 기존 인프라 연계 | Redis 이미 있으면 추가 비용 없음 | 별도 클러스터 필요 | AWS 환경 필요 | 별도 설치 |
| 재처리 (DLQ) | 직접 구현 필요 | 내장 | 내장 | 내장 |

### 고려사항

교보생명의 클라우드 환경(AWS/Azure/온프레미스)이 어떻게 구성되어 있는지에 따라 선택이 달라진다. 이미 Kafka를 운영 중이라면 Kafka가, AWS 환경이라면 SQS가 자연스러운 선택이다. Redis Streams는 추가 인프라 없이 사용할 수 있다는 장점이 있다.

### CoinCraft 추천

**Phase 1: Redis Streams 유지 → 향후 트래픽·조직 규모에 따라 Kafka 검토**

Phase 1 규모(일 수만 건)에서 Redis Streams는 충분하다. Kafka는 강력하지만 클러스터 운영 전담 인력이 필요하고, 잘못 운영하면 오히려 장애 요인이 된다. 추가 인프라 없이 Redis 하나로 캐시와 이벤트 파이프라인을 함께 처리할 수 있다는 것이 Phase 1에서는 실질적인 이점이다.

단, 교보DTS가 이미 Kafka 클러스터를 운영 중이라면 그쪽을 쓰는 것이 맞다. 새로 배워서 운영하는 것보다 기존 운영 조직이 있는 시스템이 안전하다.

AWS 환경이라면 SQS도 좋은 선택이다. 매니지드 서비스라 운영 부담이 없고, DLQ도 기본 제공된다.

결론: **이미 쓰고 있는 게 있으면 그걸 쓴다. 없으면 Redis Streams로 시작한다.**

### 결정

- [ ] Redis Streams 유지 ← CoinCraft 추천 (기존 인프라 없을 때)
- [ ] Apache Kafka (이미 운영 중인 경우)
- [ ] AWS SQS (AWS 환경인 경우)
- [ ] RabbitMQ
- [ ] 기타: ___________

**결정 주체**: 교보DTS 인프라팀  
**결정일**: ___________

---

## 5. 스마트컨트랙트 언어 — Solidity (사실상 고정)

EVM 호환 체인을 사용하는 한 Solidity가 유일한 현실적 선택이다. Vyper 등 대안이 있으나 생태계, 도구 지원, 레퍼런스 모두 Solidity가 압도적이다.

**결론**: 별도 의사결정 불필요. Solidity 사용.

---

## 6. VASP 파트너 현황 (2026-04-25 확정)

| 업체 | 상태 | SDK | Travel Rule | 비고 |
|---|---|---|---|---|
| **월렛원 (WalletOne)** | ✅ **내부 확정** | REST API (JS/TS 중심) | 지원 | Phase 1 VASP — 내부 결정 완료 |
| 코다 (KODA) | 보류 | REST API | 지원 | KB국민은행 계열 수탁사 |
| EQBR | 보류 | REST API | 지원 | |

> **월렛원 Java SDK**: 공식 Java SDK 미제공 — Java 내부망에서 직접 연동 불가, **내부망 Node.js 서비스가 VASP 연동을 담당하는 구조의 추가 근거**.

> 파트너 확정 → ADR-002 업데이트 및 `ExternalVASPAdapter`의 baseUrl 환경변수 문서화 필요.

---

## 7. 블록체인 선택 (2026-04-25 확정)

### Phase 1 — 이더리움 메인넷 ✅ 확정

월렛원이 이더리움 메인넷을 사용하므로 Phase 1은 이더리움 메인넷으로 확정.

| 항목 | 값 |
|---|---|
| 체인 | Ethereum Mainnet |
| 런타임 라이브러리 | ethers.js v6 |
| 블록 Finality | 12 컨펌 (약 2.4분) |
| 컨트랙트 언어 | Solidity |
| 토큰 표준 | ERC-20 (기본), **ERC-1155 확정** (행동 보상 NFT — ADR-003 참조) |

### Phase 2+ — 멀티체인 확장 (추상화 레이어 기반)

향후 XRPL, Circle ARC 도입을 대비해 스켈레톤에 `ChainAdapter` 추상화 레이어를 설계한다.

```
                    ┌─────────────────────────┐
                    │   BlockchainService      │
                    │  (체인 무관 비즈니스 로직) │
                    └──────────┬──────────────┘
                               │ ChainAdapter interface
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
   EVMAdapter           XRPLAdapter*      CircleAdapter*
   (Phase 1 구현)       (Phase 2 예정)    (Phase 2 예정)
   ethers.js v6         xrpl.js           Circle API
```

**`IBlockchainAdapter` 인터페이스 (추상화 대상 메서드)**:
```typescript
interface IBlockchainAdapter {
  readonly chainId:   string;
  readonly chainType: 'EVM' | 'XRPL' | 'UTXO' | 'BFT';
  isConnected(): Promise<boolean>;
  getBlockNumber(): Promise<number>;
  mintNFT(params: MintParams): Promise<TransactionReceipt>;
  mintNFTBatch(params: MintBatchParams): Promise<TransactionReceipt>;
  burnNFT(params: BurnParams): Promise<TransactionReceipt>;
  getBalance(contractAddr: string, owner: string, tokenId: bigint): Promise<bigint>;
  call(params: ContractCallParams): Promise<unknown>;
  sendTransaction(params: ContractCallParams): Promise<TransactionReceipt>;
  getReceipt(txHash: string): Promise<TransactionReceipt | null>;
  subscribeEvents(...): Promise<() => void>;
  queryEvents(...): Promise<ChainEvent[]>;
}
```

**체인별 차이점 (추상화로 숨겨야 할 것들)**:

| 항목 | Ethereum | XRPL | Circle ARC |
|---|---|---|---|
| 주소 형식 | 0x hex | r... (base58) | 정책 기반 |
| 수수료 | gas (ETH) | drops (XRP) | API 수수료 |
| Finality | ~2.4분 (12 확인) | ~3-5초 | 즉시 |
| 스마트컨트랙트 | Solidity EVM | Hooks (제한적) | Circle 관리 |
| Travel Rule 연동 | VASP 직접 | XRPL AMM / DEX | Circle Compliance API |

---

## CoinCraft 추천 요약

| 항목 | CoinCraft 추천 | 조건 |
|---|---|---|
| 백엔드 런타임 | **Node.js / TypeScript** | 블록체인 생태계 호환성 우선 |
| 백엔드 프레임워크 | **NestJS** (프로덕션 전환 시) | Spring 배경 팀 적응 용이 |
| 데이터베이스 | **Oracle** 또는 **PostgreSQL** | 교보 내부 표준 따름 / 신규 도입이면 PostgreSQL |
| 메시지 큐 | **Redis Streams** (기존 없을 때) | 기존 Kafka·SQS 있으면 그쪽 우선 |
| 스마트컨트랙트 언어 | **Solidity** | 사실상 고정 |
| VASP | **월렛원** | Phase 1 확정 |
| 블록체인 (Phase 1) | **Ethereum Mainnet** | 월렛원 연동 |
| 블록체인 (Phase 2+) | **IBlockchainAdapter 추상화** | XRPL / Circle ARC 확장 대비 |

이 추천은 블록체인 플랫폼 특성과 교보생명의 일반적 금융기관 환경을 고려한 것이다. 교보DTS의 실제 인프라 현황, 기존 운영 조직, 내부 보안 정책에 따라 최종 결정이 달라질 수 있으며, **최종 결정 권한은 교보생명/교보DTS에 있다.**

---

## 의사결정 프로세스 제안

1. 이 문서를 교보DTS 아키텍처팀에 전달
2. 교보 내부 기준(기존 인프라, 운영 역량, 보안 정책)으로 각 항목 검토
3. 결정된 항목을 이 문서에 기록
4. 결정 사항을 스켈레톤에 반영 (CoinCraft 지원 가능)

**결정이 내려지기 전까지 스켈레톤의 임시값은 교육 실습 목적으로만 사용한다.**
