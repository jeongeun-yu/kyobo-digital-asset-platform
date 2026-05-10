# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | 스켈레톤 완성 + 전체 구조 정비 완료 |
| 교육 시작 | 4/27 (웅진씽크빅) — 교보생명 58시간 확정 |
| 계약 | 공식 확인 대기 중 (웅진씽크빅/교보DTS) |

## 마지막 작업 (2026-05-10)
- 스켈레톤 TODO 정리: dmz/packages/ + blockchain/src/ 전체 `TODO (Phase X):` → `Phase X:` 변환
- M2~M8 누락 실습 파일 신규 생성: S18/S20/S23~S40/S41~S50 TypeScript 실습 + S51~S58 Ops md 파일
- 실습 파일 문제/답안 분리: `.ts` (학생 스텁, TODO throw) + `.answer.ts` (완성 구현) 패턴 M3~M8 전체 적용
- 채점 테스트 신규 생성: `__tests__/S18~S50.test.ts` 총 27개 파일, 스텁 import → 학생 미구현 시 FAIL
- package.json exercise 스크립트 전체 추가: M1~M8 85개 (student/answer 양쪽)
- docs 전수 점검 및 수정: 런북 경로 7건(internal→dmz), ADR-002 월렛원 확정, overview.md M6 오류 수정, tech-stack-decision ERC-1155 확정, Mermaid SC 노드 미정의 수정

## 다음 작업
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS Core Banking API 스펙 협의
- [ ] 이종건 과장 메일 (blockchain-gateway 구현 주체 + Node.js 보안점검 확인)
- [ ] S17_decorator_patterns.ts 실행 테스트 (ts-node 환경 확인)
