# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | **모노레포 3-레이어 구조 재편 완료 (dmz/ + internal/ + blockchain/)** |
| 교육 시작 | 4/27 (웅진씽크빅) — 교보생명 50시간 확정 |
| 계약 | 공식 확인 대기 중 (웅진씽크빅/교보DTS) |

## 마지막 작업 (2026-04-26)
- 모노레포 구조 재편: apps/ + packages/ → dmz/ (Node.js), internal/ (Java), blockchain/ (Solidity)
- InternalGatewayClient.ts 생성: Java blockchain-gateway HTTP 클라이언트
- StubCoreBankingAdapter.ts 생성: 테스트용 인메모리 어댑터
- KyoboCoreBankingAdapter.ts 전체 메서드 구현 완료
- M1 강의 노트 업데이트: 3-존 아키텍처, DMZ→내부망 RPC 섹션 추가
- dmz/packages 전체 package.json 생성 (5개 패키지)

## 다음 작업
- [ ] M1 S1 공부하며 내용 보완 (공부 병행)
- [ ] M1 통과 후 M2 강의 노트 작성
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS와 Core Banking API 스펙 협의
- [ ] blockchain-gateway Dockerfile Maven 레이어 캐시 최적화 (교육 전 선택)
