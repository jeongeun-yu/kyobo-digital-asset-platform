# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | 스켈레톤 완성 + 전체 구조 정비 완료 |
| 교육 시작 | 4/27 (웅진씽크빅) — 교보생명 58시간 확정 |
| 계약 | 공식 확인 대기 중 (웅진씽크빅/교보DTS) |

## 마지막 작업 (2026-05-10)
- M2 실습 스텁 완성: S05 `computeHmac` export 추가 + 테스트 import 수정, S08/S09/S10 export 스텁화
- Jest worker crash 패턴 전수 수정: `throw new Error('TODO')` → `return undefined as never`
- 테스트 커버리지 전수 개선: chain-adapters 57→71%, vasp 87→93%, event-engine 91→94%, core-banking 98→100%
- EVMAdapter 미커버 메서드 테스트 추가: mintNFTBatch/burnNFT/getBalance/getReceipt/subscribeEvents/queryEvents
- IdempotencyGuard 신규 테스트 파일 생성 (InMemory/Redis store 포함)
- TxStateMachineService handleReorg/pollStale failed/catch 브랜치 테스트 추가
- core-banking 100% 달성: CircuitBreaker default param, AuditLogService queryByActor, LedgerService tokenId 브랜치
- .env / .env.example 삭제 (미사용)

## 다음 작업
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS Core Banking API 스펙 협의
- [ ] 이종건 과장 메일 (blockchain-gateway 구현 주체 + Node.js 보안점검 확인)
