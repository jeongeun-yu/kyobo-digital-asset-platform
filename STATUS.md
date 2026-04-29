# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | **모노레포 3-레이어 구조 재편 완료 (dmz/ + internal/ + blockchain/)** |
| 교육 시작 | 4/27 (웅진씽크빅) — 교보생명 50시간 확정 |
| 계약 | 공식 확인 대기 중 (웅진씽크빅/교보DTS) |

## 마지막 작업 (2026-04-30)
- M2 커리큘럼 완성: 세션 번호 재정렬(S5~S12), 실습 파일 전체 생성(S06~S12), 채점 테스트 완성
- 신규 소스: WebhookPublishHandler, NFTIssuedProcessor + InMemoryLedgerService, DeferredProcessingError
- 인프라 기반: src/infra/logger.ts(구조화 JSON 로그) + gracefulShutdown.ts(SIGTERM/SIGINT) 추가
- 전체 프로덕션 소스 console.log → logger 교체 (7개 파일)
- 테스트 분리: jest.config.json(빌드/CI) / jest.exercises.config.json(수강생 채점) — 49 tests 전부 통과
- 강의 노트 이미지 /images 폴더 정리 (12개 이동 + 경로 6곳 수정)

## 다음 작업
- [ ] M3 S13~S22 강의노트 작성 (TxStateMachineService·EVMAdapter·REVERT/TIMEOUT/REORG)
- [ ] M4 S23~S26 강의노트 작성 (LedgerService·ReconcileService·AuditLogService)
- [ ] docker-compose.yml + .env.example 추가 (M3 시작 전)
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS와 Core Banking API 스펙 협의
