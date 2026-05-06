# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | 전체 강의 노트 완성 (M1~M8, Phase3, Ops) + 중복 이슈 해결 |
| 교육 시작 | 4/27 (웅진씽크빅) — 교보생명 58시간 확정 |
| 계약 | 공식 확인 대기 중 (웅진씽크빅/교보DTS) |

## 마지막 작업 (2026-05-07)
- 전체 강의 노트 보강: M1/M2(S6-S12), M3(S14,S18,S19,S21), M5(S29-S32,S34), M6/M7(S38-S40,S43,S44), M8(S45,S47,S48,S50) — 다이어그램·실습·완료기준 확장
- 상태 전이 일관성 수정: S20 REORG 가드(MINED 기준), S22 다이어그램 정정
- 세션 간 중복 분석 및 수정: B-1(submitMintRequest 중복), B-2(XACK 원칙 반복) 제거 + A-1~A-8 연결 문구 추가
- docs/사전_준비_가이드.md 추가 (MetaMask + Sepolia ETH)

## 다음 작업
- [ ] docker-compose.yml + .env.example 추가
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS와 Core Banking API 스펙 협의
- [ ] 이종건 과장 메일 (blockchain-gateway 구현 주체 + Node.js 보안점검 확인)
