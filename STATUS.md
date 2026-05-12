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

## 마지막 작업 (2026-05-13)
- `blockchain-gateway` → `internal-ledger` 전체 리네이밍
  - 디렉토리, pom.xml, docker-compose.yml, TypeScript 클라이언트, 슬라이드, SQL 주석
- Java (Maven) 통합 빌드/테스트 npm scripts 추가
  - `build:java`, `build:all`, `test:java`, `test:all`
- `mvnw.cmd` Maven Wrapper 신규 작성 (Maven 3.9.6 자동 다운로드)
- Java 컴파일 버그 수정: `BlockchainGatewayController.java` — `request.rewardType()` → `request.policyId()`
- `application.yml` 인코딩 깨진 주석 수정 (SnakeYAML 파싱 오류 해결)
- `src/test/resources/application.yml` 신규 추가 (H2 in-memory DB 테스트 환경)
- `pom.xml`에 H2 test 의존성 추가
- README.md 전체 재작성 (인코딩 수정 + Java 빌드/테스트 섹션 추가)

## 아키텍처 결정사항
| 날짜 | 결정 | 결정자 |
|---|---|---|
| 2026-05-11 | 이벤트 파이프라인(Redis Stream + EventEngine)을 내부망에 배치 | 교보 내부 담당자 |

## 다음 작업
- [ ] 이벤트 파이프라인 internal/ 이관 반영 (아키텍처 다이어그램 업데이트)
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS Core Banking API 스펙 협의
