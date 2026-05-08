# Day 01 — M1: 전체 아키텍처 프리뷰 + 개발 환경 셋업 (S1~S4)

**세션**: S1~S4 | **모듈**: M1 | **시간**: 4시간 (4세션 × 1시간)  
**산출물**: 개발환경 완성, 5레이어 매핑, 로컬노드·Sepolia·Mainnet Fork 3가지 환경 체험

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

## S4: 개발환경 구성 — 3가지 실행 환경 체험 (강의 25분 + 실습 30분)

### 강의

**Hardhat 3가지 실행 환경:**

| 환경 | 명령 | 블록 번호 | 용도 |
|---|---|---|---|
| 로컬 노드 (빈 체인) | `npx hardhat node` | `0x0` | 컨트랙트 테스트·개발 |
| Sepolia 테스트넷 | 공개 RPC 직접 호출 | `0x7xxxxxx` (수백만) | 실제 테스트넷 배포·검증 |
| Mainnet Fork | `npx hardhat node` + MAINNET_RPC_URL | `0x14xxxxx` (수천만) | 메인넷 상태 재현 테스트 |

**환경변수 기반 RPC 설정:**
- `MAINNET_RPC_URL` 설정 → `hardhat.forking.enabled: true` → mainnet fork 활성화
- 미설정 → `enabled: false` → 빈 로컬 체인
- `.env` 파일에서 분리 관리 (Git 커밋 금지)

**Hardhat 프로젝트 설정 구조:**
- 네트워크·컴파일러·solidity 버전 고정 이유

### 🔴 실습 (30분) — 수강생 직접 작성

**Step 1**: Hardhat 설정 파일 구성 — 3가지 네트워크 포함
```typescript
// TODO: blockchain/hardhat.config.ts에 아래 항목 채우기
// - localhost 네트워크 설정
// - hardhat 네트워크에 mainnet fork 설정 (MAINNET_RPC_URL 환경변수 기반, 조건부 활성화)
// - sepolia 네트워크 설정 (SEPOLIA_RPC_URL 환경변수)
// - solidity 버전 0.8.24 고정

import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import '@openzeppelin/hardhat-upgrades';
import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const config: HardhatUserConfig = {
  solidity: {
    // TODO: version, optimizer
  },
  networks: {
    localhost: {
      // TODO:
    },
    hardhat: {
      forking: {
        // TODO: MAINNET_RPC_URL 연결 + enabled 조건부 처리
      },
    },
    sepolia: {
      // TODO: SEPOLIA_RPC_URL + DEPLOYER_PRIVATE_KEY
    },
  },
};

export default config;
```

---

**Step 2**: [환경 1] 로컬 노드 — 빈 체인 기동

터미널 1:
```powershell
cd blockchain
npx hardhat node
# Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545/
```

터미널 2 (새 탭):
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8545" `
  -Method POST -ContentType "application/json" `
  -Body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# result: "0x0" → 빈 체인 확인
```

터미널 1에서 `Ctrl+C` (노드 종료)

---

**Step 3**: [환경 2] Sepolia 테스트넷 — 공개 RPC 직접 연결

```powershell
# 가입 불필요 — publicnode 공개 RPC 사용
Invoke-RestMethod -Uri "https://ethereum-sepolia-rpc.publicnode.com" `
  -Method POST -ContentType "application/json" `
  -Body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# result: "0x7xxxxxx" → Sepolia 실제 블록 번호 (수백만대)
```

---

**Step 4**: [환경 3] Mainnet Fork — 메인넷 상태 재현

`.env` 파일에 추가 (publicnode 무료 공개 RPC):
```
MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com
```

터미널 1:
```powershell
npx hardhat node
# Forking mainnet at block XXXXXXXX ... 메시지 확인
```

터미널 2:
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8545" `
  -Method POST -ContentType "application/json" `
  -Body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# result: "0x14xxxxx" → 메인넷 최신 블록 번호 → fork 성공
```

터미널 1에서 `Ctrl+C` 후 `.env`에서 `MAINNET_RPC_URL` 주석 처리
```
# MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com
```
> 이후 실습 (M2~M4)은 로컬 노드·mock 기반. fork 활성화 상태로 두면 `npx hardhat test`가 느려짐.

---

**Step 5**: 스켈레톤 컴파일 + 테스트

```powershell
npx hardhat compile
# Compiled N Solidity files successfully

npx hardhat test
# N passing, M pending (pending = 아직 구현 안 된 것들)
```

### ✅ 답안

```typescript
// blockchain/hardhat.config.ts 완성 예시
import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import '@openzeppelin/hardhat-upgrades';
import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'cancun',
    },
  },
  networks: {
    localhost: {
      url: 'http://127.0.0.1:8545',
    },
    hardhat: {
      forking: {
        url:     process.env.MAINNET_RPC_URL ?? '',
        enabled: !!process.env.MAINNET_RPC_URL,
      },
    },
    sepolia: {
      url:      process.env.SEPOLIA_RPC_URL ?? '',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};

export default config;
```

**환경별 블록 번호 비교 결과:**
| 환경 | 예상 결과 |
|---|---|
| 로컬 빈 체인 | `"0x0"` |
| Sepolia | `"0x7a4f3c2"` (수백만, 날마다 증가) |
| Mainnet Fork | `"0x14a2f1e"` (수천만, 메인넷 최신) |

### ✅ M1 완료 기준
- [ ] 로컬 노드 기동 → 블록 번호 `0x0` 확인
- [ ] Sepolia RPC 블록 번호 확인 (수백만대)
- [ ] Mainnet Fork 기동 → 블록 번호 수천만대 확인
- [ ] 컴파일 통과
- [ ] 테스트 전체 실행 확인 (skip/pending 목록 파악)
