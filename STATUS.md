# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | 교보생명 강의 진행 중 — 5/11 첫날 M1 |
| 교육 시작 | 5/11 (교보생명) — 58시간 |
| 계약 | 공식 확인 대기 중 (웅진씽크빅/교보DTS) |

## 마지막 작업 (2026-05-11)
- ADR 008 작성: 이벤트 파이프라인 내부망 배치 (DMZ = Nginx 리버스 프록시만)
- CONFIRMED ↔ FINALIZED 순서 전체 교체: MINED → CONFIRMED → FINALIZED (FINALIZED 종단)
  - LedgerService.ts / LedgerService.test.ts
  - TxStateMachineService.ts / TxStateMachineService.test.ts
  - S13, S22, S23 실습·답안·채점 테스트 전부
  - day04.md / day05.md 커리큘럼 문서
- 전체 테스트 340 TC 전부 통과

## 아키텍처 결정사항
| 날짜 | 결정 | 결정자 |
|---|---|---|
| 2026-05-11 | 이벤트 파이프라인(Redis Stream + EventEngine)을 내부망에 배치 | 교보 내부 담당자 |

## 다음 작업
- [ ] 이벤트 파이프라인 internal/ 이관 반영 (아키텍처 다이어그램 업데이트)
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS Core Banking API 스펙 협의
