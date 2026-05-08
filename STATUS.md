# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | 스켈레톤 완성 + 전체 구조 정비 완료 |
| 교육 시작 | 4/27 (웅진씽크빅) — 교보생명 58시간 확정 |
| 계약 | 공식 확인 대기 중 (웅진씽크빅/교보DTS) |

## 마지막 작업 (2026-05-08)
- env/docker 브랜치 생성: docker-compose.yml(PostgreSQL+Redis+Hardhat), .env.docker.example 추가
- README.md Docker 섹션 추가 (사전조건, docker compose up -d, healthcheck)
- M1_architecture_setup.md S4 개편: 제목 변경(Hardhat 개발환경 셋업), Mainnet Fork → [맛보기] 섹션으로 재분류, 실습 환경(로컬노드+Sepolia) 명확화
- S4 패치 슬라이드 11장 생성 (make_S4_patch.py): 수정 10장 + 신규 1장(3가지 환경 비교표)

## 다음 작업
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS Core Banking API 스펙 협의
- [ ] 이종건 과장 메일 (blockchain-gateway 구현 주체 + Node.js 보안점검 확인)
- [ ] S17_decorator_patterns.ts 실행 테스트 (ts-node 환경 확인)
