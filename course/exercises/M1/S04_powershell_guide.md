# S04 PowerShell 실습 가이드 — 3가지 네트워크 직접 연결

TypeScript 실습(`S04_check_networks.ts`) 전에 PowerShell로 네트워크 연결을 먼저 체험한다.  
원리 이해 → TypeScript 구현 순서로 진행한다.

---

## 사전 준비

루트에서 의존성 설치:
```powershell
cd F:\Workplace\kyobo-digital-asset-platform
npm install
```

---

## 환경 1 — 로컬 빈 체인

**터미널 1** (열어두기):
```powershell
cd F:\Workplace\kyobo-digital-asset-platform\blockchain
npx hardhat node
```

계정 목록이 주루룩 뜨면 노드 기동 완료. 이 터미널은 닫지 않는다.

**터미널 2** (새 탭):
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8545" -Method POST -ContentType "application/json" -Body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

예상 결과:
```
jsonrpc  id  result
-------  --  ------
2.0       1  0x0
```

> `result: "0x0"` = 블록이 하나도 없는 빈 체인. Hardhat이 처음부터 시작한다는 뜻.

터미널 1에서 `Ctrl+C`로 노드 종료.

---

## 환경 2 — Sepolia 테스트넷

노드 없이 공개 RPC 직접 호출:
```powershell
Invoke-RestMethod -Uri "https://ethereum-sepolia-rpc.publicnode.com" -Method POST -ContentType "application/json" -Body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

예상 결과:
```
jsonrpc  id  result
-------  --  ------
2.0       1  0xa52db7   ← 수백만 단위 (날마다 증가)
```

> 실제 Sepolia 네트워크에 연결된 것. 가입 없이 공개 RPC 사용.

---

## 환경 3 — Mainnet Fork

**Step 1**: `.env` 파일 열기 (`F:\Workplace\kyobo-digital-asset-platform\.env`)

아래 줄 추가:
```
MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com
```

**Step 2**: 터미널 1에서 노드 재기동:
```powershell
cd F:\Workplace\kyobo-digital-asset-platform\blockchain
npx hardhat node
```

`Forking mainnet at block ...` 메시지가 보이면 fork 성공.

**Step 3**: 터미널 2에서 블록 번호 확인:
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8545" -Method POST -ContentType "application/json" -Body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

예상 결과:
```
jsonrpc  id  result
-------  --  ------
2.0       1  0x17e6d61   ← 수천만 단위 (메인넷 최신 블록)
```

> 같은 `localhost:8545`인데 블록 번호가 수천만. 메인넷 상태를 복사해온 것.

**Step 4**: 실습 후 `.env` 원복 (이후 테스트 속도 유지):
```
# MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com
```

터미널 1에서 `Ctrl+C`로 노드 종료.

---

## 결과 비교표

| 환경 | RPC 주소 | 예상 블록 번호 | 의미 |
|------|---------|--------------|------|
| 로컬 빈 체인 | `http://127.0.0.1:8545` | `0x0` | 빈 체인 |
| Sepolia | `https://ethereum-sepolia-rpc.publicnode.com` | `0xa52db7` 수준 | 실제 테스트넷 |
| Mainnet Fork | `http://127.0.0.1:8545` | `0x17e6d61` 수준 | 메인넷 상태 복사 |

---

## 다음 단계

PowerShell 확인 완료 후 `S04_check_networks.ts`의 TODO를 채운다.  
같은 동작을 ethers.js `JsonRpcProvider`로 구현하는 것이 목표.
