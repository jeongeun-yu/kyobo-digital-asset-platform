# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | 스켈레톤 완성 + 전체 구조 정비 완료 |
| 교육 시작 | 4/27 (웅진씽크빅) — 교보생명 58시간 확정 |
| 계약 | 공식 확인 대기 중 (웅진씽크빅/교보DTS) |

## 마지막 작업 (2026-05-10)
- M2 강의 노트 세션 순서 재조정: S6↔S8 교체 (S6=redis_streams_theory, S7=redis_streams_cli, S8=hmac_queue_service)
- M2 실습 파일 순서 동일하게 재조정: S06_redis_stream, S07_redis_streams_cli.md, S08_hmac_webhook
- S07_redis_stream_docker.ts 삭제 (S07 실습은 CLI md 파일로 대체)
- S07_redis_streams_cli.md 신규: PPT make_S7_ppt.py 기준 명령어/순서 일치, Redis Cloud 접속 가이드 포함
- S11_dlq_design.pptx / S12_finalized_e2e.pptx 생성 (z_Temp)
- `.env` 루트 통합 완료: Sepolia 단일 테스트넷, MOCK_CONTRACT_ADDR + EVM_SIGNER_KEY 실값 채움
- 디자인 패턴 4종 적용: Factory(ChainAdapterFactory), Decorator(Logging+Retry), CircuitBreaker, Observer(TxStateMachine EventEmitter)
- 스텁 실구현: ISMSChecklist 5개 항목, DeadLetterQueue DLQStore 주입, KyoboCoreBankingAdapter.syncBalance()
- 교육생 가시성: course/exercises/README.md 신규, 서비스 파일 11개 교육생 안내 헤더 추가
- 강의 노트 + 실습 파일 정비: 세션 번호 오기 수정(S28→S30, S31→S33 등), Observer(S13)/Factory(S14) 실습 섹션 추가, S17_decorator_patterns.ts 신규, M3_S13/S14/S17 강의 노트 패턴 섹션 추가
- M1_architecture_setup.md 싱크: POLYGON_RPC_URL→MAINNET_RPC_URL, TxStateMachine M4→M3, scripts/→tools/event-listener/src/
- 강의 노트 경로 전수 점검: M6/M7 9개 파일 phase1/→rewards/, S54/S55 ledger→core-banking 패키지명 수정
- 실습 파일 점검: S22 M4/→M3/ 이동, S17 answer 파일 신규 생성, M4 빈 폴더 삭제
- 전 패키지 typecheck 통과 (EXIT 0): exactOptionalPropertyTypes 제거, rootDir 교차참조 수정, issuer-service package.json 신규
- 실습 파일 실행 검증: M3 S13~S22 answer 파일 전체 ✅ 통과, Sepolia RPC rpc.sepolia.org→publicnode.com 교체

## 다음 작업
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS Core Banking API 스펙 협의
- [ ] 이종건 과장 메일 (blockchain-gateway 구현 주체 + Node.js 보안점검 확인)
- [ ] S17_decorator_patterns.ts 실행 테스트 (ts-node 환경 확인)
