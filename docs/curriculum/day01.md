# Day 01 — M1: 전체 아키텍처 프리뷰 + 개발 환경 셋업 (S1~S4)

**세션**: S1~S4 | **모듈**: M1 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: 개발환경 완성, 5레이어 매핑, Hardhat fork 기동

---

## S1: 선행 과정 복습 — 온라인 코스 개념과 본 과정 매칭 포인트 (강의 60분)

### 강의

**선행 과정 6개 영역 빠른 복습:**
- TX 구조·서명·가스 / Solidity 기초·ERC-20 / 재진입 공격 / REST API / 개인키·지갑 / 블록체인 데이터 구조

**선행 → 이번 과정 연결:**
| 선행 수준 | 이번 과정 시작 수준 |
|---|---|
| Remix 배포 버튼 클릭 | Hardhat 프로젝트, 배포 스크립트, mainnet fork 테스트 |
| 단순 ERC-20 작성 | UUPS Proxy + AccessControl + Pausable |
| ERC-721 기초 | ERC-1155, tokenId 인코딩, mintBatch 가스 최적화 |
| ethers.js 기초 RPC | VASP 추상화 — TX 상태머신, Idempotency, 복구 전략 |
| EVM 단일 체인 가정 | IBlockchainAdapter — EVM·XRPL·Circle ARC 추상화 |
| 이벤트 리스너 기초 | DMZ 파이프라인 — 202 패턴, Redis Streams, DLQ |
| 개인키·지갑 개념 | Gnosis Safe 2-of-3, EIP-712 SafeTx, Travel Rule |
| 블록체인 데이터 구조 이해 | 내부 원장 + SHA-256 감사 체인, Reconcile |

**이번 과정의 출발 기준선**: 선행 과정이 끝나는 지점에서 시작. 중복 설명 없음.

---

## S2: 당사 디지털자산 로드맵과 5레이어 아키텍처 구조 이해 (강의 25분 + 실습 30분)

### 강의

**Phase 1~3 로드맵:**
- Phase 1: NFT 인프라 → Phase 2: 스테이블코인 → Phase 3: 자체 VASP 구축
- 이 팀이 만들 범위: Phase 1

**5레이어 경계선:**
```
사용자 앱 → DMZ → 내부망 → VASP → 블록체인
```
각 레이어의 신뢰 의미: DMZ는 완충, 내부망은 신뢰 영역, VASP는 외부 위임

**IBlockchainAdapter 위치**: VASP와 블록체인 사이에 삽입되는 체인 교체 가능 어댑터  
→ 비즈니스 로직·원장은 EVM·XRPL·Circle ARC 전환에 무관하게 유지됨

**당사 직접 구축(D·E 영역) vs VASP 위임(A·B·C 영역)**: 코드 책임 분리 이유

**커리큘럼 2단 구조:**
- M2~M5: 오프체인 — DMZ 파이프라인, VASP 연동, 원장, 비즈니스 로직 (Phase 1 운영 핵심)
- M6~M7: 온체인 — 컨트랙트 구현과 보안 감사 (서비스 레이어 요건을 이미 아는 상태에서 설계)

### 🔴 실습 (30분) — 수강생 직접 작성

**Step 1**: 스켈레톤 레포 클론 + 의존성 설치
```bash
# TODO: 레포 클론하고 의존성 설치
git clone [레포 URL]
cd kyobo-digital-asset-platform
# 설치 명령어는?
```

**Step 2**: 패키지 폴더를 5레이어에 매핑하는 표를 직접 채운다
```
| 패키지 경로 | 5레이어 위치 | 역할 |
|---|---|---|
| dmz/packages/chain-adapters/ | | |
| dmz/packages/event-engine/ | | |
| internal/packages/vasp/ | | |
| blockchain/ | | |
| internal/packages/ledger/ | | |
```

**Step 3**: 아래 파일 위치 확인
```bash
# IVaspAdapter 인터페이스 위치 찾기
# IBlockchainAdapter 인터페이스 위치 찾기
```

### ✅ 답안

```bash
# Step 1
git clone [레포 URL]
cd kyobo-digital-asset-platform
npm install   # 또는 yarn install
```

```
# Step 2 완성 예시
| 패키지 경로 | 5레이어 위치 | 역할 |
|---|---|---|
| dmz/packages/chain-adapters/ | DMZ | 블록체인 어댑터 |
| dmz/packages/event-engine/ | DMZ | 체인 이벤트 수신·처리 |
| internal/packages/vasp/ | 내부망 | VASP 추상화 레이어 |
| blockchain/ | 블록체인 | 스마트컨트랙트 |
| internal/packages/ledger/ | 내부망 | 내부 원장 |
```

```bash
# Step 3
find . -name "IVaspAdapter.ts"
find . -name "IBlockchainAdapter.ts"
```

### ✅ 완료 기준
- [ ] 의존성 설치 완료
- [ ] 5레이어 + 담당 패키지 매핑 문서 완성
- [ ] IVaspAdapter / IBlockchainAdapter 파일 위치 확인

---

## S3: 스켈레톤 코드 구조 파악 — 패키지·의존 방향·빈 함수 위치 (강의 20분 + 실습 35분)

### 강의

**스켈레톤 구조**: packages/ 각 폴더가 어느 아키텍처 레이어에 대응하는가

**패키지 간 의존 방향 원칙**: 순환 참조 없는 설계
- vasp는 blockchain을 알지만 반대는 안 됨
- ledger는 vasp 결과를 알지만 vasp는 ledger를 모름

**M2~M8에서 채울 파일 위치 미리 파악**: TODO 주석이 달린 함수들

### 🔴 실습 (35분) — 수강생 직접 작성

**Step 1**: 의존 방향 추적 — import 선언 따라가며 순환 참조 없음 확인
```bash
# TODO: event-engine에서 chain-adapters 방향 import 확인
# TODO: chain-adapters에서 event-engine 방향 import가 없음을 확인
grep -r "from.*event-engine" dmz/packages/chain-adapters/
```

**Step 2**: 미구현 함수 전체 목록 파악
```bash
# TODO: TODO 주석이 달린 파일 전부 나열
grep -r "TODO" --include="*.ts" . | grep -v node_modules
```

**Step 3**: 모듈별 TODO 건수 집계 표 작성
```
| 모듈 | TODO 건수 | 담당 Day |
|---|---|---|
| chain-adapters | | |
| event-engine | | |
| vasp | | |
| ledger | | |
```

**Step 4**: 빌드 통과 확인
```bash
# TODO: 타입 에러 없이 빌드 통과
npm run build
```

### ✅ 답안

```bash
# Step 1 — 순환 참조 없음 확인
grep -r "from.*event-engine" dmz/packages/chain-adapters/
# 출력 없음 = 순환 참조 없음

# Step 2 — TODO 목록
grep -rn "TODO" --include="*.ts" . | grep -v node_modules | wc -l

# Step 4 — 빌드
npm run build
# 타입 에러 0개, 빌드 성공
```

### ✅ 완료 기준
- [ ] 패키지 구조 + 레이어 대응 파악
- [ ] 빈 함수 전체 목록 확인
- [ ] 순환 참조 없음 확인

---

## S4: 개발환경 구성과 로컬 블록체인 포크 원리 (강의 25분 + 실습 30분)

### 강의

**Hardhat mainnet fork 원리:**
- 실제 메인넷 상태를 로컬에서 복제
- 가스·컨트랙트 동일하게 작동
- 왜 로컬 체인이 아닌 fork인가: 실제 운영 환경과 동일한 조건으로 테스트 가능

**환경변수 기반 RPC 설정:**
- mainnet fork URL 분리 관리
- 미설정 시 빌드 실패 경로 → `.env` 관리 필수

**Hardhat 프로젝트 설정 구조:**
- 네트워크·컴파일러·solidity 버전 고정 이유

### 🔴 실습 (30분) — 수강생 직접 작성

**Step 1**: Hardhat 설정 파일 구성
```typescript
// TODO: hardhat.config.ts에 아래 항목 채우기
// - localhost 네트워크 설정
// - mainnet fork URL을 환경변수에서 읽기
// - solidity 버전 0.8.20 고정

import { HardhatUserConfig } from 'hardhat/config';
import '@openzeppelin/hardhat-upgrades';

const config: HardhatUserConfig = {
  solidity: {
    // TODO:
  },
  networks: {
    localhost: {
      // TODO:
    },
    hardhat: {
      forking: {
        // TODO: process.env.MAINNET_RPC_URL 연결
      },
    },
  },
};

export default config;
```

**Step 2**: mainnet fork 로컬 노드 기동 → 블록 번호 확인
```bash
# TODO: Hardhat 로컬 노드 기동
npx hardhat node

# TODO: 새 터미널에서 현재 블록 번호 확인
curl -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

**Step 3**: 스켈레톤 컴파일 통과
```bash
# TODO: 컴파일 실행
npx hardhat compile
```

**Step 4**: 스켈레톤 테스트 전체 실행
```bash
# TODO: 테스트 실행 후 skip/pending 목록 파악
npx hardhat test
```

### ✅ 답안

```typescript
// hardhat.config.ts 완성 예시
import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import '@openzeppelin/hardhat-upgrades';
import * as dotenv from 'dotenv';
dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.20',
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    localhost: {
      url: 'http://localhost:8545',
    },
    hardhat: {
      forking: {
        url: process.env.MAINNET_RPC_URL ?? '',
        enabled: !!process.env.MAINNET_RPC_URL,
      },
    },
  },
};

export default config;
```

```bash
# 블록 번호 확인 — mainnet fork면 최신 블록 번호가 나옴
curl -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# 응답 예: {"jsonrpc":"2.0","id":1,"result":"0x137a5e0"}
# 이 값이 0x0이면 fork가 아닌 빈 로컬 체인

# 컴파일
npx hardhat compile
# Compiled N Solidity files successfully

# 테스트
npx hardhat test
# N passing, M pending (pending = 아직 구현 안 된 것들)
```

### ✅ M1 완료 기준
- [ ] Hardhat mainnet fork 기동
- [ ] 컴파일 통과
- [ ] 테스트 전체 실행 확인 (skip/pending 목록 파악)
