# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | 교보생명 강의 진행 중 — 5/11 첫날 M1 |
| 교육 시작 | 5/11 (교보생명) — 50시간 |
| 계약 | 완료 (웅진씽크빅) |

## 마지막 작업 (2026-05-11)
- ADR 008 작성: 이벤트 파이프라인 내부망 배치 (DMZ = Nginx 리버스 프록시만)
- CONFIRMED ↔ FINALIZED 순서 전체 교체: MINED → CONFIRMED → FINALIZED (FINALIZED 종단)
  - LedgerService.ts / LedgerService.test.ts
  - TxStateMachineService.ts / TxStateMachineService.test.ts
  - S13, S22, S23 실습·답안·채점 테스트 전부
  - day04.md / day05.md 커리큘럼 문서
- 전체 테스트 340 TC 전부 통과

## 작업 (2026-05-13)

### 리네이밍 및 Java 통합 빌드
- `blockchain-gateway` → `internal-ledger` 전체 리네이밍
  - 디렉토리, pom.xml, docker-compose.yml, TypeScript 클라이언트, 슬라이드, SQL 주석
- Java (Maven) 통합 빌드/테스트 npm scripts 추가: `build:java`, `build:all`, `test:java`, `test:all`
- `mvnw.cmd` Maven Wrapper 신규 작성 (Maven 3.9.6 자동 다운로드)

### 버그 수정
- Java 컴파일 버그: `BlockchainGatewayController.java` — `request.rewardType()` → `request.policyId()`
- `application.yml` 인코딩 깨진 주석 수정 (SnakeYAML 파싱 오류 해결)
- Java 테스트 경고 3종 제거: H2Dialect 명시 제거, `open-in-view: false`, Surefire JVM 인수 추가

### 테스트 환경 정비
- `src/test/resources/application.yml` 신규 추가 (H2 in-memory DB, 경고 없는 설정)
- `pom.xml`: H2 test 의존성 추가, maven-surefire-plugin JVM 인수 설정

### 문서
- README.md 전체 재작성 (인코딩 깨진 파일 UTF-8 복구 + Java 17 설치·빌드·테스트 섹션 추가)
- STATUS.md 작업 내역 추가

### 실습 파일 정비
- M2 S5 슬라이드 PPTX 변환 (38장, 5레이어 아키텍처 다이어그램 반영)
- `S06_redis_stream.ts`: 헤더 S07→S06 오기재 수정, 파이프라인 다이어그램·배경 설명·TODO 힌트 전면 보강
- `S06_redis_stream.test.ts`: describe 이름 S07→S06 수정
- `S09_atleastonce.ts` / `answer.ts`: `idempotentProcessor` 인스턴스 export 누락 추가 (5 TC 실패 버그)
- **전체 테스트 1,162 TC (Solidity 39 + Node.js 340 + 채점 782 + Java 1) 전부 통과**

## 아키텍처 결정사항
| 날짜 | 결정 | 결정자 |
|---|---|---|
| 2026-05-11 | 이벤트 파이프라인(Redis Stream + EventEngine)을 내부망에 배치 | 교보 내부 담당자 |

## 마지막 작업 (2026-05-16)
- S13 답안 파일 전면 재작성: 실제 `TxStateMachineService` 사용, 10개 블록, 순수 console.log
- 개별 S13_1~S13_6 파일 삭제, package.json 관련 스크립트 정리
- `TxStateMachineService.ts` 수정 반영

## 다음 작업
