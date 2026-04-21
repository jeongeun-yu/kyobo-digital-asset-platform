# Day 01 — 금융 인프라와 블록체인의 충돌 지점

**시간**: 3시간  
**핵심 질문**: 교보생명 IT 거버넌스 안에 블록체인 노드가 들어올 수 있는가?

---

## 목표

블록체인을 "기술 설명"으로 접근하지 않는다.  
교보생명이 현재 운영 중인 시스템 위에 블록체인이 얹힐 때 **어디서 충돌이 생기는지**를 파악한다.  
이 충돌 지점이 Day 02~08 전체 설계의 출발점이다.

---

## 실습 시나리오

### 실습 1 — 기존 아키텍처 다이어그램 분석 (40분)

교보생명 일반적인 금융 IT 구조를 화이트보드에 그린다:

```
[고객 앱] → [API Gateway] → [Core Banking] → [DB]
                                    ↓
                            [보험 계약 시스템]
```

**질문 시리즈:**
1. 이 구조에서 "불변 원장"이 필요한 지점이 있는가?
2. 현재 Core Banking DB의 데이터는 누가 수정할 수 있는가?
3. 교보생명 고객이 "내 보험 NFT"를 받았다고 할 때, 그 데이터는 어디에 저장되어야 하는가?

### 실습 2 — 프로젝트 레포 탐색 (50분)

```bash
# 레포 클론 후 전체 구조 파악
git clone [kyobo-digital-asset-platform]
cd kyobo-digital-asset-platform
```

`docs/architecture/overview.md`를 읽고 아래를 답한다:

- Phase 1~4 각각에서 교보생명의 역할은 무엇이 달라지는가?
- `IVASPAdapter`가 존재하는 이유는 무엇인가?
- `ExternalVASPAdapter`와 `KyoboVASPAdapter`의 차이는 무엇인가?

### 실습 3 — 충돌 지점 매핑 (50분)

아래 표를 직접 채운다:

| 교보 기존 시스템 | 블록체인 도입 시 충돌 지점 | 이 프로젝트의 해결 방식 |
|---|---|---|
| 내부망/외부망 분리 | 노드가 어디 있어야 하나? | DMZ (Day 02) |
| Core Banking 이벤트 | 온체인 이벤트를 어떻게 받나? | ChainEventListener (Day 03) |
| ISMS-P 인증 | 블록체인 노드가 범위에 포함되나? | ISMSChecklist (Day 08) |
| VASP 미보유 | 지갑 관리·출금을 누가 하나? | ExternalVASPAdapter (Day 02) |

### 마무리 토론 (20분)

> "패스트캠퍼스에서 블록체인 강의를 들었어도 이 표를 채울 수 없었던 이유가 뭔가?"

---

## 참조 파일

- `docs/architecture/overview.md`
- `docs/adr/002-vasp-external-first.md`
- `packages/vasp/src/interfaces/IVASPAdapter.ts`
