# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | **모노레포 3-레이어 구조 재편 완료 (dmz/ + internal/ + blockchain/)** |
| 교육 시작 | 4/27 (웅진씽크빅) — 교보생명 50시간 확정 |
| 계약 | 공식 확인 대기 중 (웅진씽크빅/교보DTS) |

## 마지막 작업 (2026-04-29)
- S6: dmz 소스 TODO 주석 제거, exercises/ 폴더에 S06_redis_publisher + S06_consumer_worker 실습/답안 파일 생성
- S7: CLI 강의노트 전체 6단계 완성 (Docker→XADD→XGROUP→XREADGROUP→XACK→XAUTOCLAIM→분배), 컨테이너명 오타 수정
- S8: exercises/ 폴더에 S08_hmac_webhook 실습/답안 파일 생성, 강의노트에 실행 명령 추가

## 다음 작업
- [ ] S9 강의노트 작성 (At-least-once 설계 심화)
- [ ] exercises/ 의 구버전 S07_consumer_worker.ts / S07_consumer_worker.answer.ts 수동 삭제
- [ ] M3 S13·S17~S22 강의노트 작성 (TxStateMachineService·REVERT/TIMEOUT/REORG)
- [ ] M4 S23~S26 강의노트 작성 (LedgerService·ReconcileService·AuditLogService)
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS와 Core Banking API 스펙 협의
