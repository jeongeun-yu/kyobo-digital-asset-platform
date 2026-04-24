# M1 — 전체 아키텍처 프리뷰 + 개발 환경 셋업
## 기술 레퍼런스

> S1~S4 · 4시간 · Day 01 (5/6)

---

# 과정 배경 — 왜 이 시스템을 만드는가

## 교보생명의 디지털 자산 전략

교보생명은 국내 1위 생명보험사다. 자산 규모 기준 국내 최대 생보사 중 하나이며, 전국 가입자 수백만 명의 계약 데이터와 보험금 흐름을 관리한다. 이 회사가 2026년부터 디지털 자산 인프라를 직접 구축하기로 결정했다.

배경은 규제 환경 변화다. 2023년 이후 국내 가상자산 규제 체계가 정비되면서(가상자산이용자보호법, 특금법 개정), 금융 회사들이 디지털 자산을 제도권 안에서 다룰 수 있는 법적 기반이 만들어졌다. 신한은행이 NFT 기반 디지털 증명서를 발행하고, 하나은행이 토큰증권 파일럿을 운영하기 시작했다. 교보생명도 이 흐름에서 내부 역량을 확보하지 않으면 외부 업체에 전적으로 의존해야 하는 구조가 된다.

교보생명이 설정한 3단계 디지털 자산 로드맵:

| 단계 | 시기 | 내용 |
|---|---|---|
| Phase 1 | 2026년 | NFT 인프라 구축 — 행동 보상 쿠폰 발행·소각·관리 |
| Phase 2 | 중기 | 스테이블코인 인프라 — 보험금·환급금 디지털 지급 |
| Phase 3 | ~2028년 | 디지털 자산 인프라 자체 구축 — VASP 인가, 자체 custody |

이 과정은 **Phase 1 구현**을 위한 기술 내재화 교육이다.

---

## Phase 1이 만들 것 — 행동 보상 NFT 시스템

Phase 1의 핵심 서비스는 **행동 보상 NFT**다. 교보생명 앱 사용자가 특정 행동(걷기 달성, 건강검진 수검, 가입기념 등)을 완료하면 NFT 형태의 쿠폰을 발급한다. 이 쿠폰은 블록체인에 기록되고, 보험료 할인이나 제휴 혜택으로 사용된다.

왜 NFT인가? 기존 쿠폰 시스템은 자사 DB에만 존재한다. 위변조가 가능하고, 발행 이력을 제3자가 검증할 수 없으며, 이전·양도가 어렵다. NFT 기반 쿠폰은:
- 발행 이력이 블록체인에 영구 기록 (위변조 불가)
- 소유권이 사용자 지갑 주소에 귀속 (회사 DB 문제와 무관), 내부 원장이 있긴 하지만 결국 블록체인과 동기화가 되도록 설계
- 제3자 검증 가능 (보험 심사, 감독 기관 확인)- 스마트 컨트랙트의 특징
- 향후 타 금융사와의 쿠폰 상호운용 기반

이 과정에서 만드는 시스템의 전체 범위:

```
[교보생명 앱 사용자]
  │ 걷기 달성 / 건강검진 등 특정 이벤트 기반 참여
  ▼
[내부 비즈니스 로직 레이어]     ← M4·M5 구현 영역
  │ 조건 판단 → NFT 발행 요청
  ▼
[VASP (월렛원 / 코다)]          ← 외부 위탁 (키 관리·TX 서명)
  │
  ▼
[KyoboNFT 스마트컨트랙트]       ← M2·M3 구현 영역
  │ (블록체인 — 미결정, 교육용 실습은 Ethereum Sepolia 테스트넷)
  ▼
[내부 원장 + 감사 로그]         ← M6 구현 영역
[DMZ 이벤트 파이프라인]         ← M7 구현 영역
[키 거버넌스 (Gnosis Safe)]     ← M8 구현 영역
```

**Phase 1 프로덕션 vs 이 커리큘럼의 범위**

여기서 반드시 짚고 가야 할 사항이 있다.

Phase 1 프로덕션에서 교보생명이 직접 하는 것과 하지 않는 것:

| 역할 | Phase 1 프로덕션 | 담당 |
|---|---|---|
| 발행 조건 판단, 대상 결정 | ✅ 직접 구축 | 교보 (M4·M5) |
| 사용자-지갑 매핑, 내부 원장 | ✅ 직접 구축 | 교보 (M5·M6) |
| 컨트랙트 오너십·Pause·업그레이드 권한 | ✅ 직접 보유 | 교보 (M2·M3) |
| **키 서명 · TX 브로드캐스트** | **❌ 직접 수행 안 함** | VASP 외부 위탁 |
| **지갑 생성 · MPC/HSM 관리** | **❌ 직접 수행 안 함** | VASP 외부 위탁 |

즉, **Phase 1에서 교보는 컨트랙트를 직접 배포·배포하고 오너십은 갖지만, 실제 TX 실행(키 서명·브로드캐스트)은 외부 인가 VASP(월렛원·코다·EQBR 중 미확정)에 API로 위탁한다.** 스켈레톤 코드에서 이 구조는 `ExternalVASPAdapter`가 담당한다.

그렇다면 왜 이 커리큘럼은 스마트 컨트랙트 직접 구현(M2·M3)부터 키 거버넌스(M8)까지 전 레이어를 직접 구현하는가?

세 가지 이유:

1. **Phase 2·3·4가 요구하는 역량**: Phase 2(스테이블코인)·Phase 3(STO)에서는 훨씬 복잡한 컨트랙트 로직이 필요하다. Phase 4에서 교보가 VASP 인가를 취득하면 `KyoboVASPAdapter`(현재 Phase 4 stub)를 직접 구현해야 한다. 그 시점에 역량이 없으면 다시 외부 의존으로 돌아간다.

2. **자사 시스템을 운영하려면 내부를 알아야 한다**: VASP가 TX를 실행하더라도, 컨트랙트의 AccessControl 구조, UUPS Proxy의 스토리지 레이아웃, 이벤트 시그니처를 모르면 — 장애 발생 시 VASP와 책임 소재를 구분할 수 없고, 감사 대응이 불가능하다.

3. **스켈레톤이 이미 Phase 구조를 반영하고 있다**: `ExternalVASPAdapter` (Phase 1, 외부 API 호출)와 `KyoboVASPAdapter` (Phase 4, `throw new Error('not implemented')`)는 동일한 `IVASPAdapter` 인터페이스를 구현한다. 커리큘럼에서 이 전체 구조를 구현함으로써, 수강자는 Phase 4 내재화가 코드 어디를 건드리는 것인지 직접 확인하게 된다.

**블록체인 선택 — Phase별로 의사결정 시점이 다르다**

Phase 1에서 사용할 블록체인은 교보생명과 VASP 파트너사 간 협의를 통해 결정된다. 중요한 것은 Phase 1에서 TX 실행을 VASP에 위탁하기 때문에, 체인 선택의 실질적 주도권도 일부 VASP에 있다는 점이다. 교보생명이 컨트랙트 오너십을 갖더라도, VASP가 지원하지 않는 체인은 선택지에서 제외된다.

**체인 선택이 진정한 자사 결정이 되는 시점은 Phase 2·3이다.** Phase 2에서 KRW 스테이블코인을 직접 발행하고, Phase 3에서 STO를 운영할 때 — 교보생명이 컨트랙트 오너십·키 관리·TX 실행을 모두 직접 책임지는 시점 — 그 때 이더리움 메인넷 vs L2 vs 사이드체인 선택은 되돌릴 수 없는 결정이 된다.

이 과정에서 이 비교를 미리 다루는 이유: 여러분 중 누군가가 Phase 2·3 아키텍처 설계에 참여하게 될 때, 각 선택지의 트레이드오프를 이미 알고 있어야 한다. 그 결정을 벤더 영업 자료가 아니라 기술적 이해를 바탕으로 내려야 한다.

**이더리움 메인넷 — 고가치 자산의 정산 레이어**

NFT 단건 발행(`mint`) 비용: 약 50,000 gas. 가스 가격 20 gwei(평시 기준) 기준 약 $1~3. 교보생명 월 수십만 건 발행 시 가스비만 수십억 원이다. 어떤 금융 서비스도 이 구조로는 대량 발행 운영을 할 수 없다. 이더리움 메인넷은 **고가치 자산의 최종 정산 레이어**로는 적합하지만, 수십만 건 대량 발행이 일어나는 애플리케이션 레이어로는 맞지 않는다. Phase 3 STO처럼 건당 금액이 크고 발행 빈도가 낮은 자산이라면 메인넷도 선택지가 된다.

**이더리움 L2 vs 사이드체인(Polygon PoS) — 보안 모델이 다르다**

이더리움 생태계는 "레이어 2(L2)" 확장 솔루션들을 발전시켜왔다. L2는 이더리움 메인넷(L1)의 보안을 그대로 상속하면서 거래 처리를 오프체인에서 수행하고 결과만 L1에 기록하는 구조다. 이더리움 L2와 사이드체인은 보안 모델이 근본적으로 다르다.

| | 이더리움 메인넷 | 이더리움 L2 (Arbitrum / Base 등) | Polygon PoS |
|---|---|---|---|
| 분류 | L1 | L2 | 사이드체인 |
| 보안 | 자체 PoS (~100만 검증자) | 이더리움 L1 직접 상속 | 자체 검증자 (~100명) + 이더리움 체크포인트 |
| 발행 비용 | $1~3/건 | $0.01~0.1/건 | $0.001 미만/건 |
| 블록 생성 | ~12초 | ~1~2초 | ~2초 |
| EVM 호환 | 기준 | 100% 호환 | 100% 호환 |
| 기관 신뢰도 | 최고 | 높음 (이더리움 보안 상속) | 중간 (사이드체인 구조) |
| 국내 금융 사례 | 거의 없음 | 일부 | 일부 (신한, 하나) |
| Phase 2·3 적합성 | STO·고가치 자산 | 스테이블코인·대량 NFT | 비용 우선 시 |

이더리움 L2는 트랜잭션 데이터나 증명(proof)을 이더리움 L1에 직접 게시한다. 이더리움 L1이 L2 상태의 유효성을 검증한다. 이더리움이 공격받지 않는 한 L2 자산도 안전하다.

Polygon PoS는 사이드체인이다. 자체 검증자 집합이 합의를 담당하고, 주기적으로 체크포인트 해시만 이더리움에 기록한다. 이더리움 L1이 Polygon의 개별 트랜잭션 유효성을 검증하지 않는다. Polygon 검증자 집합이 공모하면 이론적으로 자산을 위협할 수 있다. **금융기관이 "왜 사이드체인인가"라고 물을 때 답하기 어려운 이유**가 여기에 있다. Phase 2·3에서 교보생명이 금융감독원 심사를 받는 시점에 이 질문은 반드시 나온다.

**이 과정에서의 입장**

이 과정에서 배우는 스마트컨트랙트, VASP 연동, 원장 구조는 체인과 무관하다. 이 모든 것이 `IBlockchainAdapter` 뒤에 있기 때문이다. 체인이 어디로 결정되든 M2~M8에서 구현한 코드는 그대로 쓸 수 있다.

교육 실습에서 Ethereum Sepolia 테스트넷을 사용하는 이유는 단순하다: 이더리움 공식 테스트넷이고, 테스트 토큰이 무료이며, 이더리움 생태계 도구(Hardhat, ethers.js, Etherscan)가 동일하게 동작한다. Sepolia 배포 경험이 메인넷·L2 어디서든 그대로 적용된다.

Phase 1 목표 수치: 월간 활성 사용자 수십만 명, 쿠폰 종류 수십 가지, 일일 발행 건수 수천~수만 건. 이 규모에서 단순한 "컨트랙트 하나 배포"는 의미가 없다. 운영, 감사, 장애 복구, 규제 대응을 모두 고려한 시스템이어야 한다.

---

## 수강자 구성과 이 과정의 위치

수강자는 교보생명 IT지원담당 소속 14명이다. 아키텍처, 보험 레거시 시스템, 퇴직연금, 자산관리 등 영역별로 선발된 실무 개발자들이다. 이들이 Phase 1 시스템 오픈(2026년 9월 예정)의 실제 구현 팀이 된다.

이 과정의 전략적 위치:

```
선행 과정 (패스트캠퍼스 B-Harvest, 37h 온라인)
  → 블록체인 기초·Solidity·ERC-20·ERC-721·DeFi 개념
        ↓
이 과정 (50h 오프사이트 실습)
  → Phase 1 시스템 직접 구현
        ↓
2026년 9월 시스템 오픈
  → 수강자들이 직접 운영·유지보수
```

"블록체인을 이해하는 팀"에서 "블록체인 시스템을 운영하는 팀"으로 전환하는 것이 목표다.

---

## 50시간 커리큘럼 전체 구조

50세션 × 1시간. 8개 모듈, 4개 챕터로 구성된다.

| 모듈 | 주제 | 세션 | 핵심 산출물 |
|---|---|---|---|
| M1 | 전체 아키텍처 프리뷰 + 환경 셋업 | S1~S4 | 개발 환경 완성 |
| M2 | ERC-1155 NFT 컨트랙트 완전 구현 | S5~S10 | KyoboNFT.sol · Sepolia 배포 |
| M3 | 보안 감사 + 업그레이드 운영 | S11~S14 | Slither 감사 통과 · v2 업그레이드 |
| M4 | VASP 추상화 + 멀티체인 + 변동 처리 | S15~S24 | VASP 연동 · TX 상태머신 · 복구 로직 |
| M5 | 비즈니스 로직 레이어 | S25~S32 | 지갑 매핑 · 조건 판단 · 벌크 오케스트레이션 |
| M6 | 내부 원장 + 감사 로그 | S33~S36 | 원장 · SHA-256 감사 체인 |
| M7 | DMZ 이벤트 파이프라인 | S37~S44 | 202 패턴 · Consumer Group · DLQ |
| M8 | 키 거버넌스 + Phase 1 통합 | S45~S50 | EIP-712 SafeTx · E2E 통합 · 장애 주입 |

**커리큘럼의 2단 구조**

M1~M5와 M6~M8은 성격이 다르다.

*M1~M5 — "발행할 수 있는 시스템"*: 컨트랙트 배포, VASP 연동, 발행 요청부터 온체인 확정까지 동작하는 파이프라인. 기능 구현이 목표.

*M6~M8 — "믿을 수 있는 시스템"*: 발행이 된 것을 증명하고, 감사가 가능하고, 장애가 나도 복구되는 시스템. 금융 기관에서 실제로 더 중요하게 보는 영역이다. 기능은 당연한 것이고, 운영 가능성과 규제 대응이 관건이다.

교보생명 IT 담당자들 입장에서: M5까지 만들면 "시스템이 동작한다". M8까지 만들어야 "금융감독원 검사를 받을 수 있다".

---

## 이 과정의 진행 방식

**이 과정은 강의 + 실습의 단순 반복이 아니다.**

일반적인 기술 교육은 이렇게 진행된다: 개념 설명 → 예제 코드 실습 → 다음 개념으로 이동. 각 실습은 독립적인 예제 프로젝트이고, 과정이 끝나면 예제들만 남는다.

이 과정은 다르다. 모든 세션의 실습이 **하나의 레포지토리 위에 누적된다.** 첫 날 클론한 스켈레톤 코드가 50시간 동안 점점 채워지면서, 과정이 끝날 때 그것이 Phase 1 시스템의 실제 구현체가 된다.

```
Day 1  클론한 스켈레톤:     TODO 수십 개 / 테스트 전부 skip
  ↓
M2 완료:                   KyoboNFT.sol 구현 완료 / Sepolia 배포
  ↓
M4 완료:                   TX 상태머신 · VASP 연동 동작
  ↓
M6 완료:                   내부 원장 · 감사 로그 기록
  ↓
M8 완료:                   E2E 파이프라인 동작 · 장애 주입 통과
  = Phase 1 Prototype
```

스켈레톤의 각 `TODO` 주석이 해당 모듈의 실습 과제다. 구현이 완료되면 `TODO`가 사라지고 실제 로직이 들어간다. 단위 테스트가 `skip`에서 `pass`로 바뀐다. 이것이 진도 지표다.

**실제 Phase 1에 맞춰 학습한다**

각 모듈에서 배우는 기술이 해당 모듈의 구현에 즉시 쓰인다. 순서가 뒤집히지 않는다.

- ERC-1155 구조를 배우는 이유 → 그 날 바로 `KyoboNFT.sol`에 적용
- TX 상태머신 이론을 배우는 이유 → 그 날 바로 `TxStateMachineService.ts`에 구현
- Redis Streams를 배우는 이유 → 그 날 바로 DMZ 파이프라인에 연결

"이 개념이 나중에 어디에 쓰이는가"를 기억할 필요가 없다. 배우고 바로 쓴다.

**어떤 모듈을 담당하게 될지 모른다**

Phase 1 시스템 오픈 후, 각 컴포넌트는 담당자가 생긴다. 누가 컨트랙트를 맡고, 누가 VASP 연동을 맡고, 누가 원장 서비스를 맡을지는 지금 결정되지 않았다.

그 말은 이렇다: 지금 이 자리에서 "나는 스마트컨트랙트 개발자가 아니니 M2는 건성으로 들어도 된다"는 판단은 틀렸다. M6 원장 담당이 된 사람이 M4 VASP 연동 구조를 모르면, 원장과 VASP 상태 불일치 문제가 생겼을 때 디버깅이 불가능하다. 시스템은 레이어가 연결되어 있다. 한 레이어를 깊이 이해하려면 인접 레이어도 알아야 한다.

실무 현실: 초기 개발이 끝난 후 시스템에 문제가 생기면, 그 문제는 레이어 경계에서 나온다. 컨트랙트 이벤트가 원장에 반영되지 않는 문제는 M2(컨트랙트) + M7(DMZ) + M6(원장) 세 모듈이 교차하는 지점에 있다. 그 자리에 있는 사람이 세 모듈을 모두 이해하고 있어야 한다.

**매 모듈이 최선이어야 하는 이유**

이 과정이 끝나면 각자가 작성한 코드가 교보생명 Phase 1 시스템의 기반이 된다. 그 시스템은 실제 고객의 NFT를 다룬다. 완성도가 떨어지는 코드가 운영에 들어가면 — 쿠폰이 중복 발행되거나, 발행은 됐는데 원장에 기록이 없거나, 감사 로그 체인이 끊기거나 — 고객 자산에 직접 영향을 준다.

50시간 안에 모든 것을 완벽하게 이해할 수는 없다. 하지만 각 모듈의 핵심 개념과 자신의 구현이 시스템 전체에서 어디에 위치하는지는 반드시 알고 가야 한다. 이것이 이 과정이 요구하는 수준이다.

---

## 강사의 목표

나는 교보생명 내부자가 아니다. 이 시스템을 직접 운영할 사람도 아니다.

그렇기 때문에 이 과정의 목표를 명확하게 말할 수 있다: **이 과정이 끝난 후 내가 없어도 된다.**

구체적으로 말하면, 이 과정을 마친 여러분이 다음을 할 수 있어야 한다:

- Phase 1 시스템의 어떤 컴포넌트에 버그가 생겼을 때 원인을 스스로 찾을 수 있다
- 새로운 쿠폰 종류가 추가될 때 어느 파일을 수정해야 하는지 안다
- VASP 파트너사가 교체될 때 어디까지가 자사 코드이고 어디부터가 VASP 영역인지 구분한다
- 금감원 감사 요청이 왔을 때 어떤 로그를 어디서 꺼내야 하는지 안다
- Phase 2(스테이블코인)를 준비할 때 현재 시스템의 어느 레이어를 확장해야 하는지 판단한다

외부 컨설턴트나 벤더에 의존하지 않고, 자사 시스템을 자사 팀이 소유하고 운영하는 것. 그것이 기술 내재화의 실제 의미다.

이 과정에서 내가 할 수 있는 것과 할 수 없는 것이 있다. 기술 구조, 설계 결정, 구현 패턴은 전달할 수 있다. 하지만 교보생명의 실제 레거시 시스템과의 연동, 내부 IT 거버넌스 프로세스, 실제 VASP 계약 후 API 세부 사항은 여러분이 직접 풀어야 한다. 이 과정은 그것을 풀 수 있는 기반을 만드는 것이다.

---

## 이 시스템이 일반 블록체인 앱과 다른 점

개인 개발자가 만드는 NFT 프로젝트와 이 시스템의 차이:

| 항목 | 일반 NFT 프로젝트 | 이 시스템 |
|---|---|---|
| 자산 주체 | 개인 | 금융 기관 (수탁 의무) |
| 버그 허용 | "다음 버전에서 수정" | 허용 불가 — 자산 소실 |
| 감사 | 선택 | 금감원 검사 의무 |
| 키 관리 | MetaMask | HSM + Gnosis Safe 멀티시그 |
| 장애 대응 | 서비스 중단 가능 | 24/7 운영, RTO 정의 필요 |
| 규제 | 없음 | 전자금융거래법, 특금법, ISMS-P |
| 사용자 | 자발적 참여 | 보험 가입자 (데이터 보호 의무) |

이 차이가 커리큘럼의 기술 선택 하나하나를 설명한다. UUPS Proxy를 쓰는 이유, Gnosis Safe를 쓰는 이유, Redis Streams와 DLQ를 쓰는 이유 — 모두 이 맥락에서 나온다.

---

# S1 — 선행 과정과 이 과정의 연결 구조

## 이 과정의 출발점

수강자들은 패스트캠퍼스 B-Harvest 블록체인 개발 과정(37h, 온라인)을 수료했다. 그 과정이 끝나는 지점에서 이 과정이 시작된다. 같은 개념을 다시 설명하지 않는다.

선행 과정과 이 과정의 차이는 단순히 "심화"가 아니다. **운영 맥락**이 완전히 다르다. 선행 과정은 단일 컨트랙트를 Remix/테스트넷에서 동작시키는 것이 목표였다. 이 과정은 교보생명 IT 거버넌스 안에서, 실제 고객 자산을 다루는 시스템을 설계하고 운영하는 것이 목표다. 그 차이가 아래 8개 연결 지점 각각에서 어떻게 드러나는지 정리한다.

**왜 이 연결 구조를 먼저 보는가**

전통적인 소프트웨어 시스템과 블록체인 기반 금융 시스템의 핵심 차이는 **배포 불변성(immutability)**과 **자산 직접 조작 가능성**이다. 일반 웹 서비스는 버그가 있으면 서버를 재배포하면 된다. 블록체인에 배포된 컨트랙트는 수정이 불가능하다. 일반 DB는 실수로 잘못 입력해도 롤백이 가능하다. 컨트랙트에서 NFT를 잘못된 주소로 발행하면 되돌릴 수 없다. 이 불가역성이 선행 과정에서 배운 모든 기술을 다른 방식으로 접근하게 만든다.

---

## 선행 → 이 과정 연결 8개 지점

### 1. Solidity 개발환경: Remix → Hardhat 프로젝트

**선행 과정에서 배운 것**

B-Harvest 과정에서는 Remix IDE를 사용했다. 브라우저에서 `.sol` 파일 작성 → 컴파일 버튼 → Deploy 버튼 → MetaMask 팝업에서 서명 → 테스트넷 배포 완료. 환경 설정 없이 즉시 시작할 수 있다는 장점이 있다.

Remix가 내부적으로 처리하는 것들:
- solc(Solidity 컴파일러) 버전 선택 및 실행
- ABI, bytecode 생성
- 배포 트랜잭션 구성 + MetaMask 전달
- 배포된 컨트랙트의 함수 호출 UI 제공

Remix는 학습 도구로 이상적이지만, 팀 협업·자동화 테스트·CI/CD 파이프라인 연동이 불가하다. 파일이 브라우저 로컬에 저장되고, git과 연동이 안 되며, 배포 스크립트를 재현하기 어렵다.

**이론적 배경 — ABI와 bytecode의 본질**

Solidity 소스코드를 컴파일하면 두 가지 산출물이 나온다: **bytecode**와 **ABI**.

*bytecode*는 EVM(Ethereum Virtual Machine)이 실행하는 저수준 명령어 집합이다. EVM은 스택 기반 가상머신으로, 256비트 단어(word)를 기본 연산 단위로 쓴다. `ADD`, `MUL`, `SSTORE`(스토리지 저장), `SLOAD`(스토리지 읽기), `CALL`(외부 호출) 같은 opcode들이 순서대로 나열된 것이 bytecode다. 이 bytecode가 컨트랙트 배포 TX의 `data` 필드에 담겨 전송되고, 블록에 포함되면 그 주소에 영구히 저장된다. 이후 해당 주소로 TX를 보내면 EVM이 저장된 bytecode를 실행한다.

*ABI(Application Binary Interface)*는 컨트랙트의 함수 시그니처와 인자 타입을 JSON으로 기술한 명세서다. `contract.mint(userAddress, tokenId, 1)` 같은 호출을 EVM이 이해할 수 있는 바이너리 형태로 인코딩하는 데 사용된다. 함수 셀렉터(function selector)는 함수 시그니처의 keccak256 해시 앞 4바이트다:

```
mint(address,uint256,uint256) → keccak256 → 앞 4바이트 → 0x6a627842
```

호출 데이터(calldata)의 첫 4바이트가 이 셀렉터이고, EVM은 이것으로 어느 함수를 실행할지 결정한다. ABI 없이는 외부에서 컨트랙트 함수를 호출할 방법이 없다.

금융 시스템에서 ABI가 중요한 이유: 컨트랙트가 업그레이드될 때 함수 시그니처(이름, 파라미터 타입)가 바뀌면 기존 클라이언트 코드가 모두 깨진다. ABI를 일종의 공개 API 계약(contract)으로 관리해야 한다.

*재현 가능성(reproducibility)*: 같은 Solidity 소스코드라도 컴파일러 버전, optimizer 설정, viaIR 옵션이 다르면 다른 bytecode가 나온다. 다른 bytecode = 다른 컨트랙트 주소(CREATE 방식의 경우). 금융 시스템에서 "배포된 컨트랙트가 감사받은 소스코드와 동일하다"는 것을 증명하려면 컴파일 환경을 완전히 고정해야 한다. Hardhat이 이를 `hardhat.config.ts` 한 파일로 관리한다.

**이 과정에서의 확장**

Hardhat은 Node.js 기반 개발 프레임워크다. 프로젝트 구조:

```
packages/contracts/
├── hardhat.config.ts       ← 컴파일러 버전, 네트워크, 플러그인 설정
├── contracts/              ← .sol 파일 (git 추적)
├── scripts/deploy/         ← 배포 스크립트 (재현 가능, git 추적)
├── test/                   ← TypeScript 테스트 (Mocha + Chai)
└── .openzeppelin/          ← UUPS storage layout 기록 (hardhat-upgrades)
```

Remix 대비 핵심 차이:

| | Remix | Hardhat |
|---|---|---|
| 환경 | 브라우저 | Node.js |
| git 추적 | 불가 | 가능 |
| 자동화 테스트 | UI에서 수동 | `npx hardhat test` |
| 배포 재현 | 수동 클릭 | `npx hardhat run scripts/deploy/deploy-phase1.ts` |
| mainnet fork | 불가 | `hardhat node --fork https://...` |
| CI/CD 연동 | 불가 | GitHub Actions 등 |

**mainnet fork**가 이 과정에서 중요한 이유: 실제 메인넷 상태(배포된 VASP 컨트랙트, 실제 토큰 잔액 등)를 로컬 EVM에서 그대로 복제해서 테스트한다. 테스트넷에는 없는 실제 컨트랙트와 상호작용할 수 있다.

```typescript
// hardhat.config.ts — mainnet fork 설정
networks: {
  hardhat: {
    forking: {
      url: process.env.POLYGON_RPC_URL!,  // Alchemy/Infura RPC
      blockNumber: 65000000,              // 블록 번호 고정 (재현 가능)
    }
  }
}
```

블록 번호를 고정하는 이유: 고정하지 않으면 최신 블록에서 fork되어 실행할 때마다 체인 상태가 달라진다 → 테스트 결과가 달라진다. 고정하면 6개월 후 실행해도 동일 결과.

**mainnet fork의 내부 동작 이론**

Hardhat이 mainnet fork를 할 때 실제로 메인넷 전체 상태(수백 GB)를 복사하는 것이 아니다. **레이지 로딩(lazy loading)** 방식으로 동작한다. 처음에는 로컬 상태가 비어 있다. 테스트 중 특정 주소의 잔액이나 컨트랙트 코드를 읽으려 하면, 그 때 RPC를 통해 지정된 블록 번호 시점의 값을 가져온다. 한 번 가져온 값은 로컬에 캐싱되어 이후 요청은 RPC를 쓰지 않는다. 로컬에서 상태를 변경하면(TX 실행 등) 그 변경은 메인넷에는 전혀 영향을 주지 않고, 로컬 오버레이 레이어에만 기록된다.

이 구조 덕분에 mainnet fork는 두 레이어의 상태를 관리한다:
- **베이스 레이어**: 지정 블록 번호 시점의 메인넷 상태 (RPC로 조회, 캐시됨)
- **오버레이 레이어**: 로컬 테스트 중 변경된 상태 (메모리에만 존재)

읽기 요청이 오면 오버레이 레이어를 먼저 확인하고, 없으면 베이스 레이어(RPC)를 조회한다.

---

### 2. ERC-20 단순 구현 → UUPS Proxy + AccessControl + Pausable

**선행 과정에서 배운 것**

B-Harvest 과정에서 ERC-20 토큰을 작성했다. 핵심 구조:

```solidity
// 선행 과정 수준 ERC-20
contract MyToken {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public owner;

    constructor() { owner = msg.sender; }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "not owner");
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}
```

이 컨트랙트의 구조적 문제:
1. **업그레이드 불가** — 블록체인에 배포된 코드는 수정 불가. 버그 발생 시 새 컨트랙트 재배포 + 기존 토큰 이전(migration) 필요
2. **단일 owner** — `owner` 키 하나가 탈취되면 모든 mint 권한 탈취
3. **긴급 정지 없음** — 보안 사고 발생 시 시스템을 즉시 멈출 방법이 없음
4. **constructor 패턴** — 프록시 패턴과 호환 불가 (constructor는 프록시 경유 호출 불가)

**이 과정에서의 확장**

`KyoboNFT.sol`은 4개 OpenZeppelin 상속 조합으로 위 문제를 전부 해결한다:

```solidity
contract KyoboNFT is
    Initializable,           // constructor 대신 initialize() — 프록시 호환
    ERC1155Upgradeable,      // 다중 토큰 (ERC-20 → ERC-1155, M2에서 상세)
    AccessControlUpgradeable, // MINTER_ROLE / PAUSER_ROLE / UPGRADER_ROLE
    PausableUpgradeable,     // 긴급 정지
    UUPSUpgradeable          // 업그레이드 가능
```

각 상속이 해결하는 문제:

**`UUPSUpgradeable` — 업그레이드 가능**

UUPS(Universal Upgradeable Proxy Standard): 프록시 컨트랙트가 실제 로직 컨트랙트를 가리키는 구조.

```
사용자 → 프록시 주소 호출
           │
           ▼ delegatecall
      구현체(Implementation) 컨트랙트
      (실제 로직이 있는 컨트랙트)
```

`delegatecall`이 핵심: 구현체의 코드를 실행하되, 상태(storage)는 프록시에 저장된다. 구현체를 새 버전으로 교체해도 프록시 주소는 그대로, 저장된 데이터는 그대로.

**delegatecall의 EVM 레벨 동작**

일반 `call`과 `delegatecall`의 차이를 EVM 실행 컨텍스트로 설명한다.

`call`을 사용하면: 구현체 컨트랙트의 `msg.sender`, `msg.value`가 *프록시 주소*로 설정되고, 상태 변경도 *구현체의 storage*에 기록된다.

`delegatecall`을 사용하면: 구현체 코드가 실행되지만, `msg.sender`와 `msg.value`는 원래 호출자 그대로 유지되고, 상태 변경은 *프록시의 storage*에 기록된다. 구현체는 자신의 storage를 사용하는 것처럼 코드를 쓰지만, 실제 데이터는 프록시에 저장된다.

이 때문에 **Storage Collision(슬롯 충돌)** 문제가 생긴다. EVM storage는 0번 슬롯부터 순서대로 변수를 배치한다. 프록시가 슬롯 0에 `implementation address`를 저장하면, 구현체도 첫 번째 변수를 슬롯 0에 저장한다 — 이 두 값이 충돌한다.

ERC-1967 표준이 이 문제를 해결한다: 구현체 주소를 랜덤처럼 보이는 특수 슬롯에 저장해서 일반 변수와 충돌하지 않게 한다.

```
ERC-1967 구현체 주소 슬롯:
keccak256("eip1967.proxy.implementation") - 1
= 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
```

왜 `-1`을 하는가: 순수한 keccak256 해시값이 어떤 정해진 값의 충돌을 피하게 하기 위해서다. 일반 매핑의 슬롯 계산에 쓰이는 keccak256 결과와 의도치 않게 겹칠 가능성을 없앤다.

UUPS vs 투명 프록시(Transparent Proxy):
- 투명 프록시: 업그레이드 함수가 프록시에 있음 → 프록시가 무거워짐, admin vs user 함수 분리 로직 필요
- UUPS: 업그레이드 함수(`_authorizeUpgrade`)가 구현체에 있음 → 프록시가 단순, 가스 절약, 대신 구현체에서 권한 검사를 빠뜨리면 업그레이드 권한이 누구에게나 열림 (이것이 UUPS의 주요 위험)

**다중 상속과 C3 선형화**

`KyoboNFT`는 5개를 동시에 상속한다. Solidity는 다이아몬드 문제(diamond problem)를 C3 선형화 알고리즘으로 해결한다. 상속 선언 순서가 함수 호출 우선순위를 결정한다. `super.functionName()`은 선형화된 순서에서 다음 컨트랙트의 함수를 호출한다.

OpenZeppelin Upgradeable 컨트랙트의 `__init()` 함수들(예: `__ERC1155_init()`, `__AccessControl_init()`)이 `initialize()` 안에서 명시적으로 호출되어야 하는 이유가 여기 있다: constructor가 없으므로 각 부모 컨트랙트의 초기화 로직을 수동으로 체인해야 한다.

**`AccessControlUpgradeable` — 역할 기반 권한**

`owner` 단일 키 대신 역할(role) 분리:

```solidity
bytes32 public constant MINTER_ROLE   = keccak256("MINTER_ROLE");
bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
```

역할마다 다른 키 할당 가능. MINTER_ROLE 키가 탈취되어도 UPGRADER_ROLE로는 컨트랙트 업그레이드 불가. 최소 권한 원칙(principle of least privilege) 적용.

역할 식별자를 `keccak256("MINTER_ROLE")`로 정의하는 이유: 단순 숫자(0, 1, 2...)로 쓰면 다른 컨트랙트와 역할 ID가 충돌할 수 있다. 문자열의 해시는 사실상 충돌이 불가능하며(SHA-3 계열의 32바이트 출력), 동시에 역할의 의미를 사람이 읽을 수 있는 이름으로 표현한다.

`DEFAULT_ADMIN_ROLE`(= `bytes32(0)`)은 특수 역할로, 다른 역할의 관리자(role admin)다. 기본적으로 `DEFAULT_ADMIN_ROLE`을 가진 주소만 다른 역할을 `grantRole`/`revokeRole` 할 수 있다. 이 역할 자체의 관리자도 `DEFAULT_ADMIN_ROLE`이다 — 즉, 이 역할을 가진 주소 하나가 분실되면 역할 체계 전체가 동결될 수 있어 별도 키 관리 정책이 필요하다.

**`PausableUpgradeable` — 긴급 정지**

```solidity
function mint(...) external onlyRole(MINTER_ROLE) whenNotPaused { ... }
```

`whenNotPaused` modifier: pause 상태에서 호출하면 즉시 revert. 보안 사고 감지 시 PAUSER_ROLE이 `pause()` 호출 → 모든 mint/burn 즉시 중단. 원인 분석 후 `unpause()`로 재개.

**`Initializable` — constructor 대신 initialize()**

프록시 패턴에서 constructor를 쓸 수 없는 이유: constructor는 배포 시 단 한 번 실행되고, 그 결과가 **구현체 컨트랙트의 storage에 저장**된다. 하지만 실제 사용되는 storage는 프록시의 것이다. 즉, constructor로 설정한 값은 프록시를 통해서는 접근할 수 없다.

해결: constructor에서 `_disableInitializers()` 호출 (구현체 직접 초기화 시도 차단), 프록시 배포 후 `initialize()` 호출 (프록시 storage에 초기값 기록).

```solidity
constructor() {
    _disableInitializers(); // 구현체 직접 배포 후 initialize() 호출 공격 방지
}

function initialize(address admin) public initializer {
    __ERC1155_init("");
    __AccessControl_init();
    __Pausable_init();
    __UUPSUpgradeable_init();
    _grantRole(DEFAULT_ADMIN_ROLE, admin);
    _grantRole(MINTER_ROLE, admin);
    _grantRole(PAUSER_ROLE, admin);
    _grantRole(UPGRADER_ROLE, admin);
}
```

`initializer` modifier: 두 번 호출되면 revert. 초기화 재공격(재호출로 owner 탈취) 방지.

---

### 3. ERC-721 기초 → ERC-1155 다중 토큰 + tokenId 설계

**선행 과정에서 배운 것**

B-Harvest 과정에서 ERC-721 NFT를 실습했다. 핵심:
- 토큰마다 고유 ID (`tokenId`), 소유자는 한 명 (`ownerOf(tokenId)`)
- 메타데이터 URI (`tokenURI(tokenId)`)
- 발행: `mint(to, tokenId)` — 단건만 가능

교보생명 서비스에 ERC-721을 적용한다고 가정하면:
- 걷기달성 쿠폰 → `WalkingNFT` 컨트랙트 배포
- 건강검진 쿠폰 → `HealthCheckNFT` 컨트랙트 배포
- 가입기념 쿠폰 → `JoinNFT` 컨트랙트 배포
- ...쿠폰 종류마다 컨트랙트 하나

관리 비용이 선형적으로 증가하고, 100명에게 발행 시 100건 TX가 필요하다.

**이 과정에서의 확장**

ERC-1155: 하나의 컨트랙트에서 여러 토큰 타입을 관리.

```solidity
// ERC-721
balanceOf(address owner) → uint256 (NFT 보유 개수)
ownerOf(uint256 tokenId) → address (해당 NFT의 소유자)

// ERC-1155
balanceOf(address account, uint256 id) → uint256 (특정 tokenId 보유 수량)
balanceOfBatch(address[] accounts, uint256[] ids) → uint256[] (배치 조회)
```

ERC-1155에는 `ownerOf`가 없다. ERC-721은 각 토큰이 단 한 명의 소유자를 갖는다 (소유 수량 = 항상 1). ERC-1155는 같은 tokenId를 여러 명이, 각각 여러 개 보유할 수 있다.

교보생명 케이스에서는 같은 "걷기달성" 쿠폰을 10만 명이 각각 1개씩 보유한다. ERC-1155의 `balanceOf(user, walkingTokenId) == 1`로 보유 확인.

**이론적 배경 — ERC-1155의 탄생 배경**

**ERC 표준 제안 프로세스**

ERC(Ethereum Request for Comment)는 이더리움 커뮤니티의 표준 제안 프로세스다. EIP(Ethereum Improvement Proposal) 중 스마트컨트랙트 인터페이스에 관한 것들이 ERC로 분류된다. 누구나 EIP를 제안할 수 있고, 커뮤니티 검토와 핵심 개발자 승인을 거쳐 "Final" 상태가 되면 사실상 표준이 된다. 표준화의 핵심 가치는 **상호운용성(interoperability)**이다: 어떤 지갑이든, 어떤 마켓플레이스든 ERC-721 컨트랙트라면 동일한 인터페이스로 다룰 수 있다.

**ERC-721의 문제 — 게임 산업이 먼저 부딪혔다**

2017~2018년, 블록체인 게임이 등장하면서 ERC-721의 한계가 구체적으로 드러났다. 대표적 사례가 크립토키티(CryptoKitties)다. 크립토키티는 ERC-721 NFT로 고양이를 거래하는 게임이었는데, 2017년 12월 이더리움 네트워크를 마비시킬 정도로 트래픽을 유발했다. 이유는 간단하다: 고양이 한 마리 이전 = TX 1건, 100마리 이전 = TX 100건. 게임 아이템 시스템에서 이는 치명적이다.

게임 아이템 구조를 생각해보면 문제가 더 명확해진다:
- "금화" — 개수가 있고 서로 교환 가능 (fungible) → ERC-20 필요
- "일반 철 갑옷" — 수량은 여러 개지만 각각 동일 (semi-fungible) → ERC-20으로는 부족, ERC-721은 낭비
- "전설 검 #42" — 세상에 하나뿐인 고유 아이템 (non-fungible) → ERC-721 필요
- "마을 귀환 스크롤 ×10" — 소모성 아이템, 수량 있음 (semi-fungible)

ERC-20과 ERC-721만 쓴다면 게임 하나에 아이템 종류 수만큼 컨트랙트가 필요하다. 컨트랙트가 50개면 "칼+갑옷+포션" 일괄 거래 시 TX 3건을 따로 보내야 한다. 각 TX는 독립적으로 실패할 수 있다 — 칼 전송은 성공했는데 갑옷 전송이 실패하면? 자산이 의도치 않게 쪼개진다. 이것이 **원자적 교환(atomic swap) 문제**다.

**Enjin과 Witek Radomski — EIP-1155 제안자**

ERC-1155는 Enjin의 CTO **Witek Radomski**가 주도해 제안했다. 공동 제안자: Andrew Cooke, Philippe Castonguay, James Therien, Eric Binet, Ronan Sandford.

Enjin은 게임 개발자들이 블록체인 아이템을 쉽게 발행하고 거래할 수 있게 해주는 플랫폼이었다. 2018년 당시 Enjin은 이미 수십 개의 파트너 게임을 운영 중이었고, 게임마다 수백 종의 아이템을 다루면서 ERC-20/ERC-721의 한계를 실제 운영 데이터로 경험했다.

EIP-1155는 2018년 6월 제안, 2019년 6월 Final 상태로 확정되었다. 제안서 원문에 명시된 동기:

> "Tokens standards like ERC-20 and ERC-721 require a separate contract to be deployed for each token type or collection. This places a lot of redundant bytecode on the Ethereum blockchain and separates each token contract into its own permissioned address which limits certain blockchain capabilities."

— EIP-1155 Abstract 중

핵심 동기를 세 가지로 요약하면:
1. **컨트랙트 수 폭증 방지** — 종류마다 컨트랙트 배포하는 비효율 제거
2. **가스 절감** — `safeBatchTransferFrom`으로 여러 아이템 일괄 이전
3. **원자적 교환** — 여러 토큰 타입을 단일 TX로 교환, 부분 실패 없음

**Semi-fungible의 개념적 의미**

ERC-1155는 fungible과 non-fungible을 이분법으로 나누지 않는다. **같은 tokenId 내에서는 fungible, 다른 tokenId끼리는 구별된다**는 원리다.

- tokenId `1` → "금화". 총 발행량 100만 개, 각각 동일. 보유자 수만 명.
- tokenId `2` → "전설 검". 총 발행량 1개, 보유자 1명.
- tokenId `3` → "일반 갑옷". 총 발행량 5만 개, 각각 동일.

tokenId `2`는 사실상 ERC-721과 동일하게 동작한다. 발행량이 1이면 비대칭성이 없다. tokenId `1`은 ERC-20처럼 동작한다. 즉 ERC-1155는 **ERC-20과 ERC-721을 모두 포함하는 상위 집합**이다.

교보생명 케이스에서의 semi-fungible: "걷기달성 1분기 캠페인 쿠폰"은 10만 명이 각각 1개씩 보유한다. 이 쿠폰들은 서로 동일하므로 교환할 필요가 없다 — 어차피 같은 것이다. 하지만 "걷기달성 1분기"와 "건강검진 2분기"는 서로 다른 tokenId로 구별되고, 혼용되면 안 된다. 이 구조가 semi-fungible의 실용적 의미다.

**`setApprovalForAll` — 위임 모델**

ERC-1155는 개별 토큰 단위 approve 대신 `setApprovalForAll(operator, approved)` 방식을 쓴다. operator 주소에게 보유한 모든 tokenId에 대한 전송 권한을 일괄 위임한다. NFTIssuer가 사용자 대신 소각하거나 이전해야 할 때 이 구조가 필요하다.

ERC-721의 `approve(to, tokenId)`와 비교: ERC-721은 토큰 하나하나에 approve를 설정할 수 있어 세밀하지만, 토큰이 많으면 approve TX를 수십 번 보내야 한다. ERC-1155의 `setApprovalForAll`은 한 번으로 전체를 위임한다.

**가스 절감 — mintBatch**

```solidity
// ERC-721 방식: N명에게 발행 = N건 TX
for (uint i = 0; i < N; i++) {
    nft.mint(users[i], tokenId);   // 건당 ~50K gas
}
// 1,000명 발행 = 약 50M gas → block gas limit(30M) 초과, 여러 블록 필요

// ERC-1155 방식: N명에게 발행 = 1건 TX
nft.mintBatch(users, tokenIds, amounts);
// 1,000명 = ~100K + N×3K gas → 훨씬 저렴, 단일 TX 가능 (500건/배치 권장)
```

500건/배치 권장의 근거: 건당 ~50K gas × 500 = 25M < 이더리움 블록 가스 한도 30M. 500건 초과 시 트랜잭션이 블록에 포함되지 않고 revert.

**가스 경제학 이론 — 왜 단일 TX가 더 싼가**

EVM의 가스는 두 가지 비용 범주로 나뉜다: **고정 비용(fixed cost)**과 **변동 비용(variable cost)**. TX 하나를 처리하는 데는 고정 비용 21,000 gas가 기본으로 든다. 이것은 TX 검증, 서명 확인, 논스 체크 등의 비용이다. `SSTORE`(스토리지 새 값 기록)는 20,000 gas, `SLOAD`(읽기)는 2,100 gas.

100명에게 ERC-721 방식으로 개별 TX를 보내면: 100 × (21,000 고정 + 실행 비용) = 100번의 고정 비용 납부. ERC-1155 mintBatch 단일 TX: 21,000 고정 비용 1번 + 100명분 SSTORE 비용. 고정 비용 절감이 핵심이다.

추가로, ERC-1155는 내부적으로 `mapping(address => mapping(uint256 => uint256))` 구조를 쓴다. 한 주소가 여러 tokenId를 보유할 때 storage 접근 패턴이 최적화되어 있다. ERC-721의 `mapping(uint256 => address) ownerOf`는 tokenId별 별도 슬롯이 필요하다.

**tokenId 공간 설계**

ERC-721은 발행 시 자동 증가 ID를 쓰면 됐다. ERC-1155는 "같은 종류"를 같은 tokenId로 다루므로, 종류를 구분할 수 있는 체계적 ID 설계가 필요하다.

이 프로젝트의 비트 인코딩:

```
uint256 tokenId (256비트):
[비트 255 ~ 64]  productCode (상위 64비트): 쿠폰 종류
                  예) 0x01 = 걷기달성, 0x02 = 건강검진, 0x10 = 가입기념
[비트  63 ~  0]  eventCode  (하위 64비트): 세부 이벤트/시즌 번호
                  예) 1 = 2025년 1분기 캠페인, 2 = 2025년 2분기 캠페인

encodeTokenId(0x01, 1) = 걷기달성 1분기 = 0x0000000000000001_0000000000000001
encodeTokenId(0x01, 2) = 걷기달성 2분기 = 0x0000000000000001_0000000000000002
encodeTokenId(0x02, 1) = 건강검진 1분기 = 0x0000000000000002_0000000000000001
```

비트 시프트 구현:
```solidity
function encodeTokenId(uint64 productCode, uint64 eventCode)
    public pure returns (uint256)
{
    return (uint256(productCode) << 64) | uint256(eventCode);
}

function decodeTokenId(uint256 tokenId)
    public pure returns (uint64 productCode, uint64 eventCode)
{
    productCode = uint64(tokenId >> 64);          // 상위 64비트 추출
    eventCode   = uint64(tokenId & type(uint64).max); // 하위 64비트 추출 (마스킹)
}
```

`uint64(tokenId)` 캐스팅이 마스킹과 동일하게 동작하는 이유: `uint64`로 강제 캐스팅하면 하위 64비트만 유지되고 상위는 버려진다. `& 0xFFFFFFFFFFFFFFFF`와 동일.

---

### 4. ethers.js 기초 RPC → VASP 추상화 + TX 상태머신

**선행 과정에서 배운 것**

B-Harvest 과정에서 ethers.js로 컨트랙트와 직접 통신했다:

```typescript
// 선행 과정 수준 ethers.js 사용
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

// 컨트랙트 함수 호출
const tx = await contract.mint(userAddress, tokenId, 1);
await tx.wait();  // 채굴 완료까지 대기
console.log("발행 완료");
```

이 코드의 구조적 문제:

1. **PRIVATE_KEY 노출**: 서버 코드에 개인키가 직접 있다. 탈취 시 전체 자산 위험.
2. **`tx.wait()` 블로킹**: 블록이 채굴될 때까지(~15초) 서버 스레드가 대기. 1,000명 동시 요청 시 타임아웃 폭발.
3. **에러 처리 없음**: TX가 revert되거나 dropped되면 어떻게 되는가? 코드가 없다.
4. **재시도 로직 없음**: 네트워크 장애로 TX 전송 실패 시 재시도하면 중복 발행.
5. **EVM 가정**: 다른 블록체인(XRPL 등)으로 전환하면 코드 전체를 교체해야 한다.

**이 과정에서의 확장**

금융 시스템에서 블록체인 TX는 직접 호출하지 않는다. VASP(Virtual Asset Service Provider)에 위임한다. VASP가 키 관리, TX 서명, 가스비 관리를 담당한다.

비즈니스 로직 레이어 → VASP 어댑터 → VASP → 블록체인

```typescript
// IVASPAdapter 인터페이스 — 이 과정의 핵심 추상화
interface IVASPAdapter {
  createWallet(userId: string): Promise<Wallet>;
  mintNFT(params: MintParams): Promise<TxRequest>;
  getTransferStatus(txId: string): Promise<TransferStatus>;
  // ...
}
```

비즈니스 로직은 `IVASPAdapter`만 안다. 월렛원인지 코다인지 모른다. VASP 교체 시 어댑터 구현체만 바꾸면 된다.

**TX 상태머신 — `tx.wait()` 대신 비동기 처리**

`tx.wait()`는 동기 대기다. 블록체인 TX는 비동기다. 금융 시스템에서는 TX를 DB에 기록하고 비동기로 상태를 추적한다:

```
REQUESTED  — 발행 요청 DB 기록 (requestId 발급)
    ↓
SUBMITTED  — VASP에 TX 제출 완료 (txHash 획득)
    ↓
PENDING    — mempool 대기 중 (블록 미포함)
    ↓
MINED      — 블록에 포함됨 (confirmations = 1)
    ↓
CONFIRMED  — N개 블록 추가 확인 완료 (재조직 위험 없음)
    ↓
FINALIZED  — 이더리움 Finalized checkpoint 통과 (되돌릴 수 없음)
       ↘ FAILED    — TX revert 또는 가스 부족
       ↘ REORGED   — 체인 재조직으로 TX 무효화
```

각 상태 전이는 단방향이고, 허용되지 않은 전이는 예외 처리된다. 예: `CONFIRMED → SUBMITTED`는 불가능.

**Idempotency — 중복 발행 방지**

재시도 시나리오:
1. REQUESTED 생성 → requestId = `uuid-001`
2. VASP에 TX 제출 → 응답 수신 실패 (네트워크 장애)
3. 재시도: 같은 requestId `uuid-001`로 다시 제출

VASP가 `requestId`를 tracking하면: "이미 처리한 요청" → 두 번째 요청 무시, 첫 번째 결과 반환.

컨트랙트 레벨에서도 이중 방어:
```solidity
mapping(bytes32 => bool) public issued;

function issueNFT(..., bytes32 requestId, ...) external {
    require(!issued[requestId], "NFTIssuer: already issued");
    issued[requestId] = true;
    nft.mint(to, tokenId, amount);
}
```

DB unique 제약 + 컨트랙트 mapping = 이중 방어선.

**이론적 배경 — mempool, EIP-1559, Nonce 순서 보장**

TX가 블록체인 네트워크에 전송된 후 블록에 포함되기 전까지 머무는 곳이 **mempool(memory pool)**이다. 이더리움 노드마다 자체 mempool을 유지한다. 사용자가 TX를 전송하면 해당 노드의 mempool에 들어가고, p2p 네트워크를 통해 다른 노드들의 mempool로 전파된다.

**EIP-1559 가스 경매 메커니즘**: 이전 방식(단순 gasPrice 경쟁)에서 이더리움은 EIP-1559로 가스 가격 구조를 바꿨다.
- `baseFee`: 프로토콜이 자동 결정하는 기본 수수료. 이전 블록이 가스 한도 50% 이상 사용되면 baseFee 증가, 50% 미만이면 감소. 이 금액은 소각(burn)된다.
- `maxPriorityFeePerGas`: 채굴자(검증자)에게 주는 팁. 우선순위를 높이고 싶을 때 올린다.
- `maxFeePerGas`: 지불할 의향이 있는 최대 가스 가격. `baseFee + maxPriorityFee`가 실제 지불액. `maxFeePerGas`가 `baseFee`보다 낮으면 TX는 mempool에서 대기 또는 드랍된다.

TX가 **dropped** 되는 상황: baseFee가 급등해서 TX의 maxFeePerGas가 현재 baseFee보다 낮아진 경우. 또는 더 높은 가스 가격의 같은 Nonce TX가 먼저 확정된 경우(Replace-by-Fee). 이때 원래 TX는 mempool에서 사라지고 FAILED도 아닌 상태가 된다 — 즉, 추적이 불가능해진다. TX 상태머신에서 SUBMITTED 후 장시간 PENDING 상태인 TX를 주기적으로 폴링하는 이유가 여기 있다.

**Nonce**: 이더리움에서 각 주소는 전송한 TX 수를 추적하는 Nonce를 갖는다. TX는 반드시 Nonce 순서대로 처리된다. Nonce 2 TX가 확정되려면 반드시 Nonce 0, 1이 먼저 확정되어야 한다. VASP가 Nonce 관리를 담당하는 이유: 동시 다발적 발행 요청이 들어올 때 Nonce 충돌 없이 순서를 보장하는 것은 복잡한 동시성 문제다. 이것도 "직접 ethers.js로 쓰지 않고 VASP에 위임"하는 이유 중 하나다.

---

### 5. EVM 단일 체인 가정 → IBlockchainAdapter 멀티체인 추상화

**선행 과정에서 배운 것**

B-Harvest 과정은 이더리움(EVM) 단일 체인을 가정했다. ethers.js, ABI, gas, Nonce, event log — 이 모두가 EVM 특유의 개념이다.

**이 과정에서의 확장**

교보생명 Phase 1은 Polygon(EVM)으로 시작하지만, Phase 2에서 XRPL, Phase 3에서 Circle ARC로 확장할 가능성이 있다. EVM 가정이 코드 전체에 박혀 있으면 체인 교체 시 비즈니스 로직 전체를 다시 써야 한다.

`IBlockchainAdapter`가 그 경계를 만든다:

```typescript
interface IBlockchainAdapter {
  readonly chainId: number;
  readonly chainType: 'EVM' | 'XRPL' | 'UTXO' | 'BFT';

  mintNFT(params: MintParams): Promise<TxResult>;
  mintNFTBatch(params: MintBatchParams): Promise<TxResult>;
  burnNFT(params: BurnParams): Promise<TxResult>;
  getBalance(address: string, tokenId: string): Promise<bigint>;

  subscribeEvents(filter: EventFilter, handler: EventHandler): Promise<void>;
  queryEvents(filter: EventFilter, fromBlock: number): Promise<OnchainEvent[]>;
}
```

EVM, XRPL, Circle ARC 모두 이 인터페이스를 구현한다. 비즈니스 로직은 `IBlockchainAdapter`만 호출한다.

체인별 패러다임 차이 — 왜 추상화가 어려운가:

| | EVM (Polygon) | XRPL | Circle ARC |
|---|---|---|---|
| 스마트컨트랙트 | Solidity | XLS-20 (NFT Offer 기반) | 없음 |
| 수수료 | gas (wei) | reserve + fee (XRP) | 없음 (서비스 요금) |
| TX 서명 | ECDSA secp256k1 | ECDSA secp256k1 | 서버 측 관리 |
| 이벤트 | EVM event log | Transaction metadata | Webhook |
| NFT 전송 | `safeTransferFrom` | Offer create/accept | API call |
| Finality | ~12분 (checkpoint) | ~4초 | 즉시 |

1:1 매핑이 안 되는 개념들이 있다. `IBlockchainAdapter`는 최소 공통 집합만 노출하고, 체인별 특수 기능은 구현체 내부에 캡슐화한다.

**이론적 배경 — 각 체인의 합의 메커니즘과 Finality 차이**

체인마다 Finality 시간이 다른 이유는 합의 알고리즘이 다르기 때문이다. 이것이 TX 확정 판단 로직에 직접 영향을 준다.

**이더리움(Proof of Stake + Casper FFG)**: 이더리움은 2022년 The Merge 이후 Proof of Stake로 전환했다. 블록이 생성되면 즉시 확정되는 것이 아니라 **Casper FFG(Friendly Finality Gadget)** 투표 과정을 거친다. 32개 슬롯(약 6.4분)이 모이면 epoch가 되고, 두 epoch 연속으로 검증자 2/3 이상이 투표해야 블록이 **Finalized** 상태가 된다. Finalized = 이론적으로 되돌릴 수 없음. 이 과정에 약 12~15분 걸린다. Finalized 이전 블록은 이론적으로 재조직(reorg) 가능성이 있다.

**XRPL(Federated Byzantine Agreement, FBA)**: XRPL은 채굴도, stake도 없다. 신뢰하는 검증자 집합(UNL, Unique Node List) 간의 투표로 합의한다. 각 검증자는 자신이 신뢰하는 검증자 목록을 유지하고, 이 목록들이 충분히 겹칠 때 전체 네트워크가 합의에 도달한다. 결과: **약 3~5초 만에 Finality**. 재조직이 거의 없다.

**Circle ARC(Account Abstraction + 프로그래머블 월렛)**: Circle의 ARC(Automated Risk Control)는 서버 측에서 키를 관리하는 모델이다. Circle 인프라가 TX를 처리하고 확인해주므로, 클라이언트 입장에서는 API 응답이 오는 즉시 확정이다. 온체인 합의를 직접 기다릴 필요가 없다 — Circle이 그것을 추상화해준다.

Finality 시간의 비즈니스 임팩트: 교보생명 쿠폰 발행 요청이 들어왔을 때 "발행 완료"를 사용자에게 언제 보여줄 수 있는가? XRPL이면 5초 후, 이더리움이면 12분 후. 이 차이가 UX 설계와 TX 상태머신 설계 모두에 영향을 준다.

**이론적 배경 — Strategy Pattern (GoF)**

`IBlockchainAdapter`와 `IVASPAdapter`의 설계는 GoF(Gang of Four) 디자인 패턴 중 **Strategy Pattern**을 따른다.

Strategy Pattern의 핵심: 알고리즘(또는 동작)을 인터페이스로 정의하고, 구체적인 구현을 런타임에 교체 가능하게 만든다. 클라이언트(비즈니스 로직)는 인터페이스에만 의존하고 구현체를 모른다.

```
Context (비즈니스 로직)
    │ depends on
    ▼
Strategy Interface (IBlockchainAdapter)
    │ implements
    ├── ConcreteStrategyA (EVMAdapter)
    ├── ConcreteStrategyB (XRPLAdapter)
    └── ConcreteStrategyC (CircleARCAdapter)
```

왜 Strategy Pattern인가: 체인 교체는 비즈니스 로직 변경이 아니라 인프라 교체다. 비즈니스 로직이 인프라 세부 사항을 알면 안 된다는 원칙(Dependency Inversion Principle, SOLID의 D)을 구현하는 것이 Strategy Pattern이다.

VASP vs 블록체인 어댑터 분리 이유:

```
비즈니스 로직
    │
    ├── IVASPAdapter (VASP 교체 — 월렛원 → 코다)
    │       │
    │       └── IBlockchainAdapter (체인 교체 — EVM → XRPL)
    │               │
    │               └── 실제 체인 (블록체인 노드)
```

VASP는 키 관리와 TX 서명을 담당한다. 블록체인 어댑터는 체인별 프로토콜 차이를 추상화한다. 두 관심사는 다르므로 인터페이스를 분리한다. VASP를 바꿔도 체인 어댑터를 바꿀 필요 없고, 체인을 바꿔도 VASP 어댑터를 바꿀 필요 없다.

---

### 6. 이벤트 리스너 기초 → DMZ 파이프라인 (202 패턴·Redis Streams·DLQ)

**선행 과정에서 배운 것**

B-Harvest 과정에서 ethers.js 이벤트 리스너를 사용했다:

```typescript
// 선행 과정 수준 이벤트 처리
contract.on('Transfer', (from, to, tokenId) => {
    console.log(`토큰 ${tokenId} 전송: ${from} → ${to}`);
    // DB 업데이트...
});
```

이 방식의 구조적 문제:

1. **유실**: 서버가 재시작되는 동안 발생한 이벤트는 영구 유실.
2. **순서 보장 없음**: 이벤트가 순서대로 처리된다는 보장 없음.
3. **재처리 불가**: 처리 실패 시 이벤트가 사라짐.
4. **REORG 미처리**: 체인 재조직으로 이벤트가 무효화될 수 있음.
5. **동기 처리**: 이벤트 핸들러가 느리면 리스너 전체가 블로킹.

외부 블록체인 이벤트를 내부 시스템이 직접 수신하는 것은 금융 시스템에서 허용되지 않는다. DMZ(비무장지대) 역할을 하는 레이어가 중간에 있어야 한다.

**이 과정에서의 확장**

DMZ 파이프라인의 전체 구조:

```
블록체인 노드
    │ Webhook (HTTP POST)
    ▼
DMZ 게이트웨이 (외부 노출)
    │ 즉시 202 Accepted 반환
    │
    ▼ Redis Streams 발행
Redis Stream: "blockchain-events"
    │
    ▼ Consumer Group 소비
이벤트 프로세서 (내부망)
    │
    ├── 정상 처리 → 내부 원장 업데이트
    └── 실패 → DLQ(Dead Letter Queue) 이관
```

**202 패턴** — 왜 즉시 응답하는가

블록체인 노드가 webhook을 보냈는데 응답이 오래 걸리면 타임아웃 후 재전송한다. DMZ는 수신 즉시 `202 Accepted`를 반환하고, 실제 처리는 비동기로 한다.

```
블록체인 노드 → DMZ: POST /webhook/tx-confirmed
DMZ → 블록체인 노드: 202 Accepted  ← 즉시 (처리 전)
DMZ → Redis Streams: XADD blockchain-events * txHash 0x... ← 비동기 발행
```

**Redis Streams + Consumer Group**

Redis Streams는 메시지 큐 역할을 한다. Consumer Group은 여러 프로세서가 같은 스트림을 분담 소비하는 구조:

```
Stream: "blockchain-events"
├── msg-1: {txHash: "0xabc", event: "Transfer", blockNum: 12345}
├── msg-2: {txHash: "0xdef", event: "Mint", blockNum: 12346}
└── msg-3: {txHash: "0xghi", event: "Burn", blockNum: 12347}

Consumer Group: "tx-processors"
├── consumer-1: msg-1 처리 중
├── consumer-2: msg-2 처리 완료 (ACK)
└── consumer-3: msg-3 처리 중
```

`XACK`: 처리 완료 확인 명령. ACK 없이 일정 시간이 지나면 다른 consumer가 재처리.

**DLQ (Dead Letter Queue)**

처리 N회 실패한 메시지는 DLQ로 이관된다. DLQ는 별도 모니터링 대상이다. 자동 재처리 루프를 방지하고 (무한 재시도로 시스템 과부하), 운영자가 원인 파악 후 수동 또는 선택적 재처리.

**REORG 처리**

이더리움에서 체인 재조직(reorg)이 발생하면: 이전에 CONFIRMED로 처리했던 이벤트가 무효화될 수 있다. `finalized` checkpoint를 통과한 블록만 FINALIZED로 처리하는 이유가 여기 있다. FINALIZED 이전 상태에서는 내부 원장을 최종 확정하지 않는다.

**이론적 배경 — 이벤트 로그, Bloom Filter, at-least-once vs exactly-once**

EVM 컨트랙트의 `emit` 이벤트는 블록의 **receipt** 안에 저장된다. TX receipt는 가스 사용량, 상태(성공/실패), 그리고 이벤트 로그 배열을 포함한다. 이벤트 로그는 블록 헤더의 `logsBloom`에 압축 인덱싱된다.

**Bloom Filter**: 특정 주소나 특정 토픽의 이벤트가 해당 블록에 존재하는지를 O(1)로 빠르게 판별하는 확률적 자료구조다. False positive는 가능하지만 false negative는 없다 — 즉 "없다"고 하면 진짜 없는 것이고, "있다"고 하면 확인이 필요하다. 이더리움 RPC 노드가 `eth_getLogs` 요청을 처리할 때 Bloom Filter를 먼저 체크해서 관련 없는 블록을 빠르게 건너뛴다.

**at-least-once vs exactly-once 전달 보장**

분산 시스템에서 메시지 전달 보장 수준은 세 가지다:
- **at-most-once**: 전달 실패 시 재시도 안 함. 유실 가능. 빠르다.
- **at-least-once**: 전달 실패 시 재시도. 중복 가능. **Redis Streams Consumer Group의 기본 동작**.
- **exactly-once**: 중복 없이 정확히 한 번. 구현이 매우 어렵고 비싸다.

Redis Streams는 at-least-once를 보장한다. 즉, 이벤트가 중복 처리될 수 있다. 이를 허용하는 방법: **처리 로직을 멱등(idempotent)하게** 만든다. 같은 이벤트를 두 번 처리해도 결과가 달라지지 않도록 설계한다. `requestId` 기반 중복 방지가 이벤트 처리 레이어에도 적용되어야 하는 이유다.

**REORG의 발생 원인**: 이더리움 네트워크에서 거의 동시에 두 개의 유효한 블록이 생성될 수 있다. 두 블록이 동시에 전파되면 네트워크 일부는 블록 A를, 다른 일부는 블록 B를 최신 블록으로 인식한다. 이후 더 긴 체인(또는 PoS에서는 더 많은 투표를 받은 체인)이 canonical chain이 되고, 짧은 쪽 블록이 **uncle block** 또는 **orphaned block**이 된다. 그 블록에 포함됐던 TX들은 다음 블록에서 다시 처리되거나 mempool로 돌아간다. 이미 CONFIRMED로 처리한 이벤트가 orphaned 블록에 있었다면 무효화된다.

---

### 7. 개인키·지갑 → Gnosis Safe 2-of-3 + EIP-712 SafeTx

**선행 과정에서 배운 것**

B-Harvest 과정에서 MetaMask 개인키로 서명했다:
- 개인키(256비트 랜덤값) → ECDSA secp256k1 → 서명
- 지갑 주소 = keccak256(공개키)의 하위 20바이트
- MetaMask: 개인키를 암호화해서 브라우저에 저장, 서명 시 팝업

이 구조에서 개인키 하나가 모든 권한을 갖는다. 개인키 분실 = 자산 영구 손실, 개인키 탈취 = 자산 전량 탈취.

**이 과정에서의 확장**

금융 시스템에서 단일 개인키는 절대 사용 불가다. 내부 통제(internal control) 규정상 단일 담당자가 혼자 자산을 이동시킬 수 없어야 한다.

**Gnosis Safe 멀티시그 구조**

Gnosis Safe는 스마트컨트랙트 지갑이다. 지갑 자체가 컨트랙트이고, TX 실행 조건을 코드로 정의한다.

2-of-3 구성:
```
키 홀더 3명:
  [K1] 당사 보조키  — 교보생명 내부 보관
  [K2] VASP 주키 1 — 월렛원/코다 HSM 보관
  [K3] VASP 주키 2 — 월렛원/코다 HSM 보관 (별도 HSM)

실행 조건: 3개 중 2개 서명

시나리오별 동작:
  K1 + K2 서명 → 실행 가능 (일반 운영)
  K1 + K3 서명 → 실행 가능 (일반 운영)
  K2 + K3 서명 → 실행 가능 (당사 폐업/장애 시 VASP 주도 복구)
  K1 단독     → 실행 불가 (당사 단독 결정 불가)
  K2 단독     → 실행 불가 (VASP 단독 이동 불가)
  K1만 탈취됨 → 실행 불가 (공격자가 나머지 1개 없음)
```

왜 2-of-3인가: 1-of-1은 단일 장애점, 3-of-3은 한 키 분실 시 영구 동결. 2-of-3은 내부 통제 요건(단독 결정 불가)을 충족하면서 키 1개 분실에도 복구 가능.

**EIP-712 구조화된 서명**

Gnosis Safe가 TX를 실행하기 전, 각 키 홀더는 **SafeTx** 구조체에 서명한다. EIP-712는 이 서명 내용을 사람이 읽을 수 있는 형태로 표시하는 표준이다.

MetaMask가 서명 요청을 표시하는 방식:

```
일반 서명 (EIP-712 없음):
  서명할 데이터: 0x1901abc123def456... (알 수 없음)

EIP-712 적용:
  Kyobo NFT 컨트랙트 업그레이드 승인
  ─────────────────────────────────
  to:       0xKyoboNFTProxy
  value:    0 ETH
  data:     upgradeToAndCall(0xNewImplementation)
  operation: CALL
  safeTxGas: 200000
  nonce:    42
  ─────────────────────────────────
  위 내용에 서명하시겠습니까?
```

서명자가 무엇에 서명하는지 정확히 알 수 있다. 내용 불명확한 서명 요청을 방지한다.

**이론적 배경 — ECDSA secp256k1, HSM, MPC**

**ECDSA secp256k1 — 서명의 수학적 기반**

이더리움 지갑이 사용하는 서명 알고리즘이다. `secp256k1`은 타원 곡선의 파라미터 세트 이름이다. 타원 곡선 위의 점 연산을 기반으로 한다.

핵심 특성: 개인키(256비트 정수 `k`)로부터 공개키(`k × G`, G는 생성점)를 계산하는 것은 쉽지만, 공개키에서 개인키를 역산하는 것은 이산 로그 문제로 현재 컴퓨팅으로는 사실상 불가능하다. 이더리움 주소는 공개키의 keccak256 해시 하위 20바이트다.

서명 과정: 메시지 해시 + 개인키 + 랜덤 논스 → (r, s, v) 서명값. 이 서명값과 메시지 해시만으로 서명자의 공개키(=주소)를 복원할 수 있다 (`ecrecover`). 실제 개인키는 전혀 드러나지 않는다.

**HSM (Hardware Security Module)**

VASP가 키를 "HSM에 보관"한다는 것의 의미: HSM은 암호키를 물리적으로 격리된 하드웨어 안에 보관하는 장치다. 키는 HSM 외부로 절대 나가지 않는다. 서명 요청이 오면 HSM 내부에서 서명을 수행하고 서명 결과만 반환한다. 물리적으로 장치를 탈취해도 키 추출이 극히 어렵도록 설계된다(탬퍼-레지스턴트). AWS CloudHSM, Thales Luna 등이 대표적이다.

**MPC (Multi-Party Computation) vs 멀티시그**

Gnosis Safe 2-of-3은 **멀티시그(multisig)**: 각 키 홀더가 별도 키를 갖고, 각자의 서명을 모아서 컨트랙트가 검증한다. 서명 과정이 온체인에서 이루어진다 → 가스 비용 발생, 모든 서명이 온체인에 기록됨.

**MPC**는 다르다: 하나의 개인키를 수학적으로 분산된 "키 샤드(shard)"로 나눈다. 어떤 샤드도 단독으로는 원래 키를 복원할 수 없다. 서명 시 각 샤드 보유자가 부분 서명을 수행하고, 이 부분 서명들을 수학적으로 합산하면 원래 키로 서명한 것과 동일한 서명이 만들어진다. 블록체인 입장에서는 일반 단일 서명 TX처럼 보인다 → 멀티시그 대비 가스 절약, 프라이버시.

코다(Coda) 같은 고급 VASP가 MPC를 쓰는 이유: 서명 과정이 오프체인이고, 온체인에 멀티시그 흔적이 남지 않으며, 가스도 절약된다. 단점: MPC 라이브러리가 복잡하고, 샤드 보관·분배 프로세스가 자체적으로 복잡한 거버넌스를 요구한다.

**Travel Rule (FATF 권고사항)**

국제자금세탁방지기구(FATF)의 Travel Rule: 가상자산 전송 시 송신인과 수신인의 신원 정보를 VASP 간에 전달해야 한다. 법정 한도(국내 기준 100만원 이상)를 초과하는 가상자산 이전은 이 규칙이 적용된다.

교보생명 맥락에서: 고객이 쿠폰(NFT)을 외부 지갑으로 이전하거나, 외부에서 내부로 자산을 이전할 때 Travel Rule 데이터를 기록하고 상대방 VASP에 전달해야 한다. `IVASPAdapter.transfer()`의 `TravelRuleData` 파라미터가 이를 위한 것이다.

**이 과정에서의 적용 범위**

2-of-3 멀티시그는 M8(키 거버넌스)에서 상세히 다룬다. S1에서는 "개인키 하나"에서 "다중 서명 구조"로의 전환이 왜 필요한지, 그리고 MPC와 멀티시그의 개념적 차이가 무엇인지 이해하는 것으로 충분하다.

---

### 8. 블록체인 데이터 구조 → 내부 원장 + SHA-256 감사 체인

**선행 과정에서 배운 것**

B-Harvest 과정에서 블록체인 데이터 구조를 배웠다:
- 블록 헤더: `parentHash`, `stateRoot`, `transactionsRoot`, `receiptsRoot`, `timestamp`, `number`
- 블록 헤더의 `parentHash`가 이전 블록의 해시 → 체인 구조 → 중간 블록 변조 시 이후 모든 해시가 깨짐
- Merkle Tree: 블록 내 모든 TX를 해시로 요약 → 단일 txHash로 포함 증명 가능

**이 과정에서의 확장**

블록체인 데이터 무결성 원리를 내부 DB 감사 로그에 그대로 적용한다.

금융 규제 요건 (전자금융거래법, ISMS-P):
- 모든 자산 이동 이력 보관 (최소 5년)
- 이력이 변조되지 않았음을 증명할 수 있어야 함
- 감사 시 특정 시점의 잔액을 재현할 수 있어야 함

온체인에 모든 것을 기록하면 이 요건을 자동으로 충족하지만, 가스 비용이 prohibitive하다. 실용적 방법: 내부 DB에 로그를 저장하되, 블록체인의 해시 체인 구조를 적용해 변조를 감지할 수 있게 한다.

**SHA-256 감사 체인 구조**

```
감사 로그 1: {
    id: 1,
    timestamp: "2025-01-01T09:00:00Z",
    event: "NFT_MINT",
    userId: "user_001",
    tokenId: "0x000...001",
    amount: 1,
    prev_hash: "0x0000000000000000",   ← 체인 시작
    hash: SHA256(전체 데이터 직렬화 + prev_hash)
}

감사 로그 2: {
    id: 2,
    ...
    event: "NFT_BURN",
    prev_hash: 로그1.hash,              ← 이전 로그의 해시를 포함
    hash: SHA256(전체 데이터 직렬화 + prev_hash)
}

감사 로그 3: {
    id: 3,
    ...
    prev_hash: 로그2.hash,
    hash: SHA256(...)
}
```

로그 2의 내용을 `NFT_BURN` → `NFT_MINT`로 수정하면:
- 로그 2의 `hash`가 변경됨
- 로그 3의 `prev_hash`(= 로그2.hash)와 불일치
- 감사 시스템이 체인 끊김 감지 → 변조 경보

**온체인 Reconcile**

내부 원장과 온체인 실제 상태가 일치해야 한다. 일치하지 않는 상황:
- 이벤트 유실 (DMZ 파이프라인 재시작 중 발생한 이벤트)
- REORG로 무효화된 TX가 내부 원장에 CONFIRMED로 기록된 경우
- DB 장애로 일부 이벤트 미처리

Reconcile 프로세스: 주기적으로 온체인 `balanceOf(user, tokenId)` 실제 값을 조회해서 내부 원장 값과 비교. 차이가 있으면 불일치 알람 + 이벤트 재재생(replay)으로 복구.

**이론적 배경 — SHA-256의 특성, Merkle Tree, 규제 요건**

**SHA-256의 세 가지 핵심 특성**

SHA-256이 감사 체인에 적합한 이유는 세 가지 수학적 특성 때문이다.

1. **단방향성(preimage resistance)**: 해시값 H가 있을 때 H = SHA256(x)인 x를 찾는 것이 계산상 불가능하다. 즉, 해시에서 원본 데이터를 역산할 수 없다. 감사 로그를 수정하더라도 수정 전 해시를 다시 만들 수 없다.

2. **충돌 저항성(collision resistance)**: SHA256(x) = SHA256(y)인 서로 다른 x, y를 찾는 것이 계산상 불가능하다. "이 해시를 그대로 유지하면서 내용을 바꿔치기" 불가능.

3. **눈사태 효과(avalanche effect)**: 입력의 1비트만 바꿔도 출력이 전혀 예측 불가능하게 바뀐다. 로그 내용을 조금 수정하면 해시가 완전히 달라져서 조작 시도가 즉시 드러난다.

SHA-256의 출력은 항상 256비트(32바이트)다. 입력 크기와 무관하게 동일한 크기 출력이 나온다.

**Merkle Tree — 블록체인에서 배운 것의 심화**

선행 과정에서 배운 `transactionsRoot`는 블록 내 모든 TX의 Merkle root다. 이 구조의 장점: 블록 내 수천 개 TX 중 특정 TX가 포함되었음을 O(log N) 증명으로 검증 가능하다. 전체 TX 목록이 없어도 된다.

감사 체인에서의 적용 확장: 이 프로젝트에서는 단순 선형 SHA-256 체인을 쓰지만, 로그가 수억 건에 이르면 특정 날짜 범위의 로그가 변조되지 않았음을 증명할 때 Merkle Tree 구조가 훨씬 효율적이다. Merkle root를 주기적으로 외부(블록체인 온체인 또는 공증 시스템)에 기록하면 내부 DB 전체가 없어도 부분 검증이 가능해진다.

**금융 규제 요건 상세**

*전자금융거래법 제22조*: 전자금융업자는 거래 기록을 종류에 따라 5년 또는 1년 보관 의무. 디지털 자산 관련 거래 기록은 5년 기준 적용.

*ISMS-P(정보보호 및 개인정보보호 관리체계) 인증*: 금융권 IT 시스템은 ISMS-P 인증을 요구한다. 감사 로그는 "접근 및 사용 기록의 관리" 항목(2.9.4)에서 요구된다. 로그는 무결성을 보장할 수 있어야 하고, 권한 없는 수정이 불가능해야 한다.

*금융감독원 감사 대응*: 금감원 검사 시 "특정 날짜에 누가 어떤 자산을 발행/소각했는가"를 즉시 제시할 수 있어야 한다. 원장이 변조되지 않았음을 기술적으로 증명해야 한다. SHA-256 감사 체인은 이 두 요건을 동시에 충족한다.

---

# S2 — 5레이어 아키텍처 기술 상세

## 아키텍처 전체 구조

이 시스템은 5개의 레이어로 구성되며, 각 레이어는 명확한 신뢰 경계를 가진다.

```
[사용자 앱]              ← 신뢰 안 함. 모든 입력 검증 필요
      ↕ HTTPS / WalletConnect
[내부망]                 ← 완전 신뢰. 당사 직접 소유·운영
      ↕ 내부 API
[DMZ]                    ← 부분 신뢰. 외부와 내부 사이 완충
      ↕ VASP API (HTTPS)
[인가 VASP]              ← 계약 신뢰. SLA 기반
      ↕ 서명된 TX
[퍼블릭 블록체인]        ← 수학적 신뢰. 코드가 법
```

---

## 레이어 1 — 내부망 (당사 직접 운영)

이 과정에서 구현하는 전부가 이 레이어다.

### 비즈니스 로직 서브시스템

**이벤트 조건 판단** (`apps/issuer-service/src/services/EventConditionService.ts`)

외부 시스템(앱, IoT, 건강 데이터)에서 이벤트가 들어오면 NFT 발행 조건을 평가한다.

```typescript
// 예시: 걷기 달성 이벤트
interface ActivityEvent {
  userId: string;
  activityType: 'WALKING' | 'HEALTH_CHECK' | 'SIGN_UP';
  value: number;  // 걸음 수
  timestamp: Date;
}

// 조건 판단: 10,000보 달성 시 NFT 발행
if (event.activityType === 'WALKING' && event.value >= 10000) {
  await issuerService.issueSingle(event.userId, WALKING_TOKEN_ID);
}
```

**벌크 발행 관리** (`apps/issuer-service/src/services/BulkIssueService.ts`)

수만 명에게 동시에 NFT를 발행하는 경우 (예: 이벤트 종료 시 전체 참여자 배포).

문제: 한 번에 10만 건을 VASP에 보내면 VASP가 처리 못함.
해결: 배치 단위로 분할 + 진행률 추적 + 실패 건 재시도.

```
전체 10만 건
    ↓ 500건 단위 분할
배치 1 (500건) → VASP → 성공 → 원장 업데이트
배치 2 (500건) → VASP → 실패 → 재시도 큐
배치 3 (500건) → VASP → 성공 → ...
```

왜 500건이 한계인가: ERC-1155 `mintBatch`에서 500건 × ~50K gas = ~25M gas. Ethereum 블록 가스 한도가 ~30M이므로 500건이 안전한 상한선.

### 데이터 관리 서브시스템

**내부 원장** (`packages/core-banking/src/ledger/LedgerService.ts`)

사용자별 NFT 보유 현황을 내부 DB에 유지한다. 온체인 데이터를 매번 조회하면 느리고 비용이 든다. 내부 원장이 캐시 역할을 하면서 동시에 Reconcile의 기준점이 된다.

상태머신 기반 TX 추적: 각 발행 요청의 상태를 내부 원장에서 추적한다. TX가 REORGED 되어 사라져도 원장에서 이전 상태로 되돌릴 수 있다.

**감사 로그** (`packages/core-banking/src/audit/AuditLogService.ts`)

모든 원장 변경에 대해 append-only 로그를 남긴다. 위에서 설명한 SHA-256 체인 구조로 변조를 감지한다.

금융 규제 요건:
- 전자금융거래법: 5년 보관
- ISMS-P: 접근 로그 포함 전수 감사 가능
- 내부통제: 변경 이력 추적 가능

### 거버넌스 서브시스템

**멀티시그 보조키**

당사가 보유하는 Gnosis Safe 서명키. 대형 TX(임계값 이상 발행, 컨트랙트 업그레이드, 일시정지)에는 당사 키의 서명이 필요하다.

실제 시나리오:
```
대량 NFT 발행 (10만 건 이상)
    → VASP가 TX 생성
    → VASP 키 서명
    → 당사 보조키 서명 요청 (Admin 대시보드 알림)
    → 담당자 확인 + 서명
    → 2-of-3 충족 → TX 실행
```

---

## 레이어 2 — DMZ (게이트웨이 레이어)

DMZ는 외부(블록체인, VASP)와 내부망 사이의 완충 지대다. ISMS-P 인증에서 요구하는 망 분리 원칙을 충족한다.

### Webhook Receiver + 202 패턴

온체인 이벤트가 발생하면 (NFT 발행 완료, 소각 완료 등) VASP가 당사 Webhook URL을 호출한다.

**202 패턴이 필요한 이유:**

단순하게 Webhook을 받아서 즉시 처리하면 문제가 생긴다:
```
VASP → Webhook 호출
      ↓ (처리 시간이 길면)
VASP: 타임아웃 → 재전송
      ↓
Webhook: 같은 이벤트를 2번 처리 → 원장 2번 업데이트
```

202 패턴:
```
VASP → Webhook 호출
      ↓ 즉시
Webhook: HTTP 202 응답 (처리 완료가 아니라 "접수됨")
      ↓ 비동기
Redis Stream에 이벤트 적재
      ↓
Consumer가 꺼내서 처리
```

즉각 202를 반환하므로 VASP 타임아웃이 없다. 처리는 비동기로 진행되며, 실패 시 Stream에 그대로 남아있어서 재처리가 가능하다.

### Redis Streams

Redis의 Streams 자료구조는 메시지 큐와 비슷하지만 중요한 차이가 있다.

**일반 메시지 큐 vs Redis Streams:**

| | 일반 큐 | Redis Streams |
|---|---|---|
| 메시지 소비 | 꺼내면 사라짐 | 소비 후에도 남음 |
| Consumer Group | 없음 | 있음 (여러 Consumer가 나눠서 처리) |
| 재처리 | 불가 | 가능 (같은 메시지 ID 재처리) |
| 장애 복구 | 메시지 유실 | PEL(Pending Entry List)에서 복구 |

Consumer Group은 여러 Consumer 인스턴스가 메시지를 나눠서 처리할 수 있게 한다. PM2 cluster 모드에서 여러 프로세스가 동시에 처리해도 같은 이벤트를 두 번 처리하지 않는다.

**멱등성 보장**: `txHash + logIndex`를 멱등 키로 사용한다. 같은 온체인 이벤트가 두 번 들어와도 (VASP가 재전송한 경우) 한 번만 처리된다.

### Dead Letter Queue (DLQ)

Consumer가 이벤트 처리에 실패하면 DLQ에 이동한다.

```
정상 처리: Stream → Consumer → 원장 업데이트 → ACK
실패 처리: Stream → Consumer → 에러 → 재시도 3회 → DLQ
```

DLQ의 이벤트는 자동으로 처리되지 않는다. 운영자가 원인을 파악한 후 수동으로 재처리하거나 폐기한다. 자동으로 무한 재시도하면 같은 에러가 반복되면서 시스템 자원을 낭비한다.

### VASP 추상화 레이어 (IVASPAdapter)

내부망이 VASP에 직접 의존하지 않도록 인터페이스로 추상화한다.

```typescript
// 내부망 코드
class IssuerService {
  constructor(private vasp: IVASPAdapter) {}  // 인터페이스만 알음
  
  async issue(userId: string, tokenId: bigint) {
    const wallet = await this.vasp.getWallet(userId);  // VASP가 뭔지 모름
    await this.vasp.transfer({ to: wallet.address, ... });
  }
}

// Phase 1
const service = new IssuerService(new ExternalVASPAdapter());

// Phase 4 (교보 직접 VASP 인가 취득 후)
const service = new IssuerService(new KyoboVASPAdapter());
// IssuerService 코드 변경 없음
```

### IBlockchainAdapter

VASP 추상화와 별도로 블록체인 자체도 추상화한다.

왜 두 개의 추상화 레이어가 필요한가:

```
IVASPAdapter: 규제 레이어 추상화
  → 교보가 VASP 인가를 받으면 교체 (비즈니스/법적 결정)

IBlockchainAdapter: 기술 레이어 추상화
  → EVM에서 XRPL로 체인을 바꾸면 교체 (기술적 결정)
```

이 두 결정은 독립적이다. VASP는 그대로 쓰면서 체인만 바꿀 수 있고, 체인은 그대로 쓰면서 VASP만 바꿀 수 있다.

`IBlockchainAdapter` 핵심 메서드:

```typescript
interface IBlockchainAdapter {
  chainId: string;
  chainType: 'EVM' | 'XRPL' | 'UTXO' | 'BFT';
  
  // 연결 상태
  isConnected(): Promise<boolean>;
  getBlockNumber(): Promise<number>;
  
  // NFT 발행·소각
  mintNFT(params: MintParams): Promise<TransactionReceipt>;
  mintNFTBatch(params: MintBatchParams): Promise<TransactionReceipt>;
  burnNFT(params: BurnParams): Promise<TransactionReceipt>;
  
  // TX 조회 (REVERT/TIMEOUT/REORG 감지)
  getReceipt(txHash: string): Promise<TransactionReceipt | null>;
  
  // 이벤트 구독 (DMZ ChainEventListener 입력)
  subscribeEvents(...): Promise<() => void>;
  queryEvents(...): Promise<ChainEvent[]>;  // missed event 복구
}
```

`chainType`이 인터페이스에 있는 이유: EVM과 XRPL은 패러다임이 다르다. 상위 레이어에서 체인 타입에 따라 다르게 처리해야 하는 예외적인 경우를 위해 노출한다 (대부분은 사용하지 않는다).

### Private RPC Node

퍼블릭 RPC(예: Alchemy 무료 플랜)를 쓰면:
- Rate limit (초당 요청 수 제한)
- 데이터 의존성 (제3자 서비스 장애 = 우리 서비스 장애)
- 프라이버시 (어떤 주소를 조회하는지 Alchemy가 앎)

전용 Private RPC Node를 운영하면 이 세 가지가 해결된다. Phase 1에서는 VASP가 제공하는 BaaS(Blockchain as a Service)를 쓰거나 자체 구축한다.

---

## 레이어 3 — 인가 VASP

교보생명은 현재 특금법상 VASP 인가가 없다. 지갑 생성, 프라이빗 키 관리, TX 서명·브로드캐스트를 직접 하려면 인가가 필요하다.

### 커스터디 지갑 구조

```
핫월렛 (20%): 일상적인 발행·소각에 사용. 온라인 상태 유지.
콜드월렛 (80%): 대부분의 자산 보관. 오프라인 또는 HSM.
```

핫월렛이 해킹당해도 전체 자산의 20%만 위험.

### MPC (Multi-Party Computation)

기존 키 관리: 프라이빗 키가 하나의 장치에 존재 → 그 장치가 해킹되면 전체 키 노출.

MPC: 프라이빗 키를 여러 조각으로 나눠서 여러 장치에 분산 보관. 서명할 때만 각 조각이 계산에 참여 → 전체 키는 어느 장치에도 존재하지 않음.

```
키 조각 1 (장치 A) + 키 조각 2 (장치 B) + 키 조각 3 (장치 C)
    ↓ 서명 요청 시 MPC 프로토콜
완성된 서명 (전체 프라이빗 키는 어디에도 존재 안 함)
```

---

## 레이어 4 — 퍼블릭 블록체인 (EVM)

### KyoboNFT 컨트랙트 구성

```
KyoboNFT
    ├── ERC1155Upgradeable   (다중 토큰 표준)
    ├── AccessControlUpgradeable (역할 기반 접근 제어)
    ├── PausableUpgradeable  (일시정지)
    └── UUPSUpgradeable      (업그레이드 가능)
```

왜 이 4가지를 조합하는가:

- **ERC1155**: 다중 토큰 타입을 하나의 컨트랙트에서
- **AccessControl**: `onlyOwner` 대신 역할(Role) 기반. MINTER는 발행만, PAUSER는 정지만, UPGRADER는 업그레이드만.
- **Pausable**: 보안 사고 발생 시 즉시 모든 발행·소각·전송을 멈출 수 있는 비상 스위치
- **UUPS**: 업그레이드 가능. constructor 없이 `initialize()`로 초기화.

### 온체인 이벤트

컨트랙트에서 발행, 소각, 전송이 일어나면 이벤트가 발생한다:

```solidity
// ERC-1155 표준 이벤트 (TransferSingle, TransferBatch)
// 이 이벤트들이 Webhook → DMZ → 내부망으로 전달됨
```

이벤트 구독 흐름:
```
온체인 이벤트 발생
    ↓
VASP Webhook → DMZ Webhook Receiver → 202 응답
    ↓ (비동기)
Redis Stream 적재
    ↓
Consumer Group Worker → NFTIssuedHandler
    ↓
내부 원장 업데이트
```

---

## ADR (Architecture Decision Records)

`docs/adr/` 폴더에 핵심 아키텍처 결정들이 기록되어 있다. 각 ADR은 무엇을, 왜 결정했는지, 기각된 대안은 무엇인지를 담는다.

**ADR 001 — 체인 추상화 레이어 (`001-chain-abstraction-layer.md`)**

결정: `IBlockchainAdapter` 인터페이스 도입.
기각된 대안: ethers.js를 직접 비즈니스 로직에서 호출.
기각 이유: EVM 종속 코드가 모든 레이어에 퍼지면 XRPL 추가 시 전체 수정 필요.

**ADR 002 — VASP 외부 우선 (`002-vasp-external-first.md`)**

결정: Phase 1은 외부 인가 VASP 사용.
기각된 대안: 즉시 자체 VASP 인가 취득.
기각 이유: 인가 취득에 6~12개월 소요. Phase 1 서비스를 지금 출시하려면 외부 VASP가 현실적.

---

# S3 — 스켈레톤 코드 구조 + 의존 방향

## npm Workspaces 모노레포

`package.json` 최상위:
```json
{
  "workspaces": ["packages/*", "apps/*"]
}
```

**모노레포를 쓰는 이유:**

멀티레포(패키지마다 별도 레포) 방식은:
- 패키지 간 코드 변경 시 여러 레포에 PR을 각각 만들어야 함
- 로컬 개발 시 `npm link` 등으로 연결해야 함
- 버전 불일치 문제 (A 패키지가 vasp v1, B 패키지가 vasp v2 사용)

npm workspaces 모노레포는:
- 최상위에서 `npm install` 하면 모든 패키지 설치
- 패키지 간 import가 패키지 이름으로 가능 (`@kyobo/vasp`)
- 전체 타입체크를 한 번에 (`npm run typecheck`)

**`@kyobo/*` 네임스페이스 import:**

각 패키지의 `package.json`에 이름이 `@kyobo/[패키지명]`으로 되어있다. 워크스페이스 설정에 의해 다른 패키지에서 이 이름으로 import할 수 있다.

```typescript
// apps/issuer-service/src/services/IssuerService.ts
import { IVASPAdapter } from '@kyobo/vasp';
import { LedgerService } from '@kyobo/core-banking';
// 실제 경로: packages/vasp/src/..., packages/core-banking/src/...
```

---

## 패키지 구조와 레이어 매핑

```
packages/
├── contracts/          → 블록체인 레이어
│   ├── src/
│   │   ├── phase1/
│   │   │   ├── KyoboNFT.sol        ← M2/M3 핵심 구현
│   │   │   ├── NFTIssuer.sol
│   │   │   └── ActivityOracle.sol
│   │   ├── phase2/
│   │   │   └── KRWStablecoin.sol   ← 빈 파일 (Phase 2)
│   │   └── interfaces/
│   │       ├── IToken.sol
│   │       └── ICompliance.sol
│   ├── scripts/deploy/
│   │   └── deploy-phase1.ts        ← M2 배포 스크립트
│   ├── test/                       ← M2/M3 단위 테스트
│   └── hardhat.config.ts
│
├── chain-adapters/     → IBlockchainAdapter 레이어
│   └── src/
│       ├── interfaces/
│       │   └── IBlockchainAdapter.ts  ← M4 S16 핵심
│       ├── evm/
│       │   └── EVMAdapter.ts          ← M4 S17 구현
│       └── xrpl/
│           └── XRPLAdapter.ts         ← M4 S17 Mock
│
├── vasp/               → VASP 추상화 레이어
│   └── src/
│       ├── interfaces/
│       │   └── IVASPAdapter.ts        ← M4 핵심 인터페이스
│       ├── external/
│       │   └── ExternalVASPAdapter.ts ← Phase 1 구현체
│       ├── internal/
│       │   └── KyoboVASPAdapter.ts    ← Phase 4 (빈 파일)
│       ├── tx/
│       │   └── TxStateMachineService.ts ← M4 S15 TX 상태머신
│       ├── recovery/
│       │   └── VaspRecoveryService.ts   ← M4 S19~S24 복구
│       └── governance/
│           └── KeyGovernanceService.ts  ← M8 키 거버넌스
│
├── core-banking/       → 내부망 데이터 관리
│   └── src/
│       ├── ledger/
│       │   └── LedgerService.ts       ← M6 내부 원장
│       ├── audit/
│       │   └── AuditLogService.ts     ← M6 감사 로그
│       └── reconcile/
│           └── ReconcileService.ts    ← M6 Reconcile
│
└── event-engine/       → DMZ 레이어
    └── src/
        ├── dmz/
        │   ├── ConsumerGroupWorker.ts ← M7 Consumer
        │   ├── DLQHandler.ts          ← M7 DLQ
        │   └── RedisStreamPublisher.ts ← M7 Redis Streams
        ├── webhook/
        │   ├── WebhookServer.ts       ← M7 202 패턴
        │   ├── IdempotencyGuard.ts    ← M7 멱등성
        │   └── RetryHandler.ts        ← M7 재시도
        ├── listener/
        │   └── ChainEventListener.ts  ← M7 이벤트 구독
        └── handlers/
            └── NFTIssuedHandler.ts    ← M7 이벤트 처리

apps/
└── issuer-service/     → 내부망 비즈니스 로직
    └── src/
        ├── services/
        │   ├── IssuerService.ts          ← M5 단건 발행
        │   ├── BulkIssueService.ts       ← M5 벌크 발행
        │   ├── EventConditionService.ts  ← M5 조건 판단
        │   └── WalletMappingService.ts   ← M5 지갑 매핑
        ├── api/
        │   └── ActivityRouter.ts         ← M5 API
        └── factory/
            └── TokenIssuerFactory.ts     ← M5 팩토리
```

---

## 의존 방향 원칙 (Dependency Rule)

핵심 규칙: **의존성은 항상 안쪽(더 안정적인 레이어)으로만 향해야 한다.**

```
apps/issuer-service
    ↓ (import)
packages/vasp, packages/core-banking
    ↓ (import)
packages/chain-adapters
    ↓ (import)
packages/contracts (ABI만)
```

**역방향 의존이 금지되는 이유:**

```
chain-adapters가 vasp를 import한다고 가정:
  - chain-adapters를 빌드하려면 vasp가 먼저 빌드되어야 함
  - vasp는 chain-adapters를 import함
  - chain-adapters도 vasp를 import함
  - 누구를 먼저 빌드해야 하는가? → 순환 참조 → 빌드 불가
```

실제로 더 큰 문제: 변경의 파급 효과.

```
체인 어댑터만 바꾸고 싶은데,
chain-adapters가 vasp를 알면 vasp 코드도 바꿔야 할 수도 있음.
vasp가 issuer-service를 알면 issuer-service도 바꿔야 할 수도 있음.
→ 결국 전체를 다 건드리게 됨.
```

의존 방향이 단방향이면 chain-adapters만 바꿔도 상위 레이어는 영향 없다 — IBlockchainAdapter 인터페이스가 바뀌지 않는 한.

---

## Strategy Pattern

이 레포 전체에서 반복적으로 나타나는 패턴. `IBlockchainAdapter`와 `IVASPAdapter` 모두 이 패턴의 적용이다.

```typescript
// 인터페이스 (전략의 공통 계약)
interface IBlockchainAdapter {
  mintNFT(params: MintParams): Promise<TransactionReceipt>;
}

// 구체적인 전략 구현체들
class EVMAdapter implements IBlockchainAdapter { ... }
class XRPLAdapter implements IBlockchainAdapter { ... }
class MockAdapter implements IBlockchainAdapter { ... }  // 테스트용

// 전략을 사용하는 컨텍스트
class VaspRecoveryService {
  constructor(private blockchain: IBlockchainAdapter) {}
  // EVMAdapter인지 XRPLAdapter인지 모름. 그냥 IBlockchainAdapter.
}
```

장점:
- 테스트 시 MockAdapter로 교체 → 실제 네트워크 없이 테스트 가능
- 런타임에 어댑터 교체 가능 (예: 장애 시 fallback 체인)

---

# S4 — Hardhat 개발 환경 + Mainnet Fork

## Hardhat 아키텍처

Hardhat은 Ethereum 개발 프레임워크다. 내부적으로 다음으로 구성된다:

```
Hardhat Runner: 태스크 실행 엔진 (compile, test, run, node)
Hardhat Network: 로컬 EVM 구현체 (JavaScript)
Hardhat Toolbox: ethers.js, chai, hardhat-network-helpers 번들
```

`npx hardhat compile` → Solidity 소스를 ABI + bytecode로 컴파일 → `artifacts/` 저장  
`npx hardhat test` → Mocha 테스트 프레임워크 + Hardhat Network 위에서 실행  
`npx hardhat node` → JSON-RPC 서버 기동 (localhost:8545)

---

## Mainnet Fork 내부 동작

Mainnet fork는 Hardhat Network의 특수 모드다.

**기본 동작 원리:**

```
Hardhat node --fork [RPC_URL]
    ↓
특정 블록 시점의 메인넷 상태를 "원본"으로 설정
    ↓
로컬에서 새로운 TX가 들어오면 로컬에서만 처리 (메인넷 영향 없음)
    ↓
메인넷 상태가 필요한 경우 (기존 컨트랙트 조회 등) RPC URL로 fetch
    ↓
fetch한 데이터는 캐시에 저장 → 같은 데이터 재조회 시 RPC 불필요
```

**상태 관리:**

```
로컬 상태 오버레이
    ↑ (우선순위 높음)
메인넷 상태 (RPC fetch + 캐시)
```

로컬에서 `transfer()`를 실행하면 로컬 상태에만 반영된다. 메인넷에 실제로 있는 컨트랙트를 조회하면 RPC를 통해 메인넷 상태를 가져온다.

**캐시 메커니즘:**

```
~/.hardhat/cache/ 또는 node_modules/.cache/hardhat-network-fork/
```

처음 실행 시 메인넷에서 블록 데이터를 fetch해서 캐시에 저장. 이후 실행 시 캐시에서 로드 → Alchemy API 호출 없음 → 빠른 실행.

**블록 번호 고정의 중요성:**

```typescript
// hardhat.config.ts
forking: {
  url: process.env.MAINNET_RPC_URL!,
  blockNumber: 19000000,  // 특정 블록에서 fork
}
```

블록 번호를 고정하지 않으면: 매번 최신 블록에서 fork → 메인넷 상태가 달라짐 → 테스트가 어떤 날에는 통과하고 어떤 날에는 실패. 재현 불가능한 테스트.

블록 번호를 고정하면: 항상 같은 메인넷 상태에서 시작 → 결정론적 테스트.

---

## Solidity 컴파일러 설정 상세

### version 고정

```typescript
solidity: { version: '0.8.20' }
```

같은 소스 코드라도 컴파일러 버전이 다르면 바이트코드가 다르다. Etherscan 소스코드 검증은 업로드한 소스코드를 동일 버전으로 컴파일해서 온체인 바이트코드와 비교한다. 버전이 다르면 검증 실패.

팀원이 각자 다른 버전을 쓰지 않도록 고정한다.

### optimizer: runs 파라미터

```typescript
optimizer: { enabled: true, runs: 200 }
```

Solidity 옵티마이저는 두 가지 비용을 줄이려 한다:
- **배포 비용**: 컨트랙트를 블록체인에 올리는 비용 (바이트코드 크기에 비례)
- **실행 비용**: 함수를 호출할 때마다 드는 가스

`runs` 파라미터는 "이 컨트랙트가 배포 후 몇 번이나 호출될 것인가"를 힌트로 준다.

- `runs: 1`: 배포 비용 최소화 (바이트코드 작게). 실행 비용은 상대적으로 큼.
- `runs: 10000`: 실행 비용 최소화. 배포 비용은 상대적으로 큼.
- `runs: 200`: 일반적인 컨트랙트에 적합한 균형점.

NFT 컨트랙트는 자주 호출되므로 `runs: 200` 이상이 적합하다.

### viaIR: true

IR = Intermediate Representation. 컴파일 중간 단계.

```
Solidity 소스
    ↓ viaIR: false (기본)
EVM 바이트코드 (직접)

Solidity 소스
    ↓ viaIR: true
Yul IR (중간 표현)
    ↓
EVM 바이트코드 (Yul에서 최적화 기회 더 많음)
```

OpenZeppelin Upgradeable 4종 조합처럼 복잡한 다중 상속 구조에서 `Stack too deep` 에러가 발생할 수 있다. EVM 스택은 16개 변수만 동시에 다룰 수 있는데, 복잡한 함수에서 지역 변수가 16개를 초과하면 컴파일 실패. `viaIR: true`는 이 제약을 완화한다.

---

## .env 파일 구조와 dotenv 로딩

```typescript
// hardhat.config.ts 최상단
import * as dotenv from 'dotenv';
dotenv.config();
```

`dotenv.config()`는 `.env` 파일을 읽어서 `process.env`에 주입한다. `.env` 파일이 없거나 특정 키가 없으면 `process.env.KEY`는 `undefined`.

```typescript
url: process.env.SEPOLIA_RPC_URL ?? '',
// ?? 연산자: null 또는 undefined면 오른쪽 값 사용
// 즉: SEPOLIA_RPC_URL이 없으면 빈 문자열 → 네트워크 설정 비활성
```

`.env` 파일은 반드시 `.gitignore`에 있어야 한다:
```
# .gitignore
.env
.env.local
.env.*.local
```

프라이빗 키가 Git에 커밋되면 GitHub이 자동으로 감지해서 경고를 주지만, 이미 공개 레포에 올라간 경우 키를 교체해도 Git 히스토리에 남는다.

`.env.example` 패턴:
- `.env.example`: 실제 값 없이 키 이름만 있는 템플릿. Git에 커밋됨.
- `.env`: 실제 값. Git에 절대 커밋 안 됨.

---

## hardhat-upgrades 플러그인

`@openzeppelin/hardhat-upgrades` 플러그인이 UUPS 프록시 배포와 업그레이드를 담당한다.

```typescript
import { upgrades } from 'hardhat';

// 배포: 구현체 + 프록시 자동 생성
const nft = await upgrades.deployProxy(
  KyoboNFT,              // 컨트랙트 팩토리
  [deployer.address],    // initialize() 인자
  { kind: 'uups', initializer: 'initialize' }
);
// 반환: 프록시 인스턴스 (주소 = 프록시 주소)
```

내부 동작:
1. 구현체 컨트랙트 배포 (KyoboNFT bytecode)
2. ERC1967Proxy 배포 (프록시 컨트랙트)
3. 프록시에서 구현체의 `initialize()` 호출
4. `.openzeppelin/[network].json`에 storage layout 기록

**Storage layout 자동 검증:**

업그레이드 시:
```typescript
await upgrades.upgradeProxy(proxyAddr, KyoboNFTV2);
```

이 시점에 플러그인이 `.openzeppelin/[network].json`에 기록된 기존 layout과 KyoboNFTV2의 layout을 비교한다. 기존 변수의 순서나 타입이 바뀌면 에러를 던진다.

이 검증 덕분에 storage collision으로 인한 토큰 소실을 배포 전에 막을 수 있다.

---

## Hardhat 테스트 구조

```typescript
// test/KyoboNFT.test.ts 구조 이해
import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';

describe('KyoboNFT', () => {
  let nft: KyoboNFT;
  let admin: Signer, minter: Signer, user: Signer;

  beforeEach(async () => {
    // 각 테스트 전에 새로운 컨트랙트 배포
    // → 테스트 간 상태 격리
    [admin, minter, user] = await ethers.getSigners();
    const KyoboNFT = await ethers.getContractFactory('KyoboNFT');
    nft = await upgrades.deployProxy(KyoboNFT, [admin.address], { kind: 'uups' });
  });

  it('MINTER_ROLE 없는 주소는 mint 불가', async () => {
    await expect(
      nft.connect(user).mint(user.address, tokenId, 1)
    ).to.be.revertedWithCustomError(nft, 'AccessControlUnauthorizedAccount');
  });
});
```

`beforeEach`에서 매번 새로 배포하는 이유: 이전 테스트의 상태(토큰 잔액, 역할 부여 등)가 다음 테스트에 영향을 주지 않도록. 격리된 테스트는 실행 순서에 무관하게 결과가 동일하다.

`revertedWithCustomError` vs `revertedWith`:
- OpenZeppelin v5부터 커스텀 에러 사용 → `revertedWithCustomError`
- 이전 버전의 `require(condition, "message")` → `revertedWith("message")`

---

## packages/contracts 디렉토리 구조

```
packages/contracts/
├── src/                  ← Solidity 소스 (hardhat.config의 paths.sources)
│   ├── phase1/
│   │   ├── KyoboNFT.sol
│   │   ├── NFTIssuer.sol
│   │   └── ActivityOracle.sol
│   └── interfaces/
├── test/                 ← 테스트 파일
├── scripts/
│   └── deploy/
│       └── deploy-phase1.ts
├── artifacts/            ← 컴파일 결과 (ABI + bytecode) — gitignore
├── .openzeppelin/        ← 업그레이드 storage layout 기록 — gitignore 금지
└── hardhat.config.ts
```

`.openzeppelin/` 폴더는 Git에 커밋해야 한다. 이 폴더가 없으면 `upgradeProxy()` 시 이전 storage layout을 알 수 없어서 충돌 검증을 못 한다.

`artifacts/`는 컴파일 시 자동 생성되므로 gitignore해도 된다. CI/CD 파이프라인에서 빌드 시 재생성.

---

## M1 전체 핵심 개념 요약

| 개념 | 핵심 내용 | 코드 위치 |
|---|---|---|
| 5레이어 아키텍처 | 내부망↔DMZ↔VASP↔블록체인 신뢰 경계 | `docs/architecture/` |
| IBlockchainAdapter | 체인 교체 시 비즈니스 로직 무변경 보장 | `packages/chain-adapters/src/interfaces/` |
| IVASPAdapter | VASP 교체 시 비즈니스 로직 무변경 보장 | `packages/vasp/src/interfaces/` |
| 단방향 의존 | 순환 참조 방지, 변경 파급 최소화 | 모든 packages/ |
| Strategy Pattern | 인터페이스 + 교체 가능한 구현체 | chain-adapters, vasp |
| Hardhat mainnet fork | 로컬에서 메인넷 상태 재현, 결정론적 테스트 | `packages/contracts/hardhat.config.ts` |
| viaIR + optimizer | 복잡한 상속 구조 컴파일, 가스 최적화 | `hardhat.config.ts` |
| .openzeppelin/ | Storage layout 기록, upgrade 충돌 검증 | `packages/contracts/.openzeppelin/` |
| SHA-256 감사 체인 | DB 로그 변조 감지 (블록체인 원리 응용) | `packages/core-banking/src/audit/` |
| 202 패턴 + DLQ | Webhook 유실 없이 비동기 처리 | `packages/event-engine/src/webhook/` |
