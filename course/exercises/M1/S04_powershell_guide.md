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

노드 없이 공개 RPC 직접 호출. 아래 명령을 순서대로 실행한다.

### 2-1. 블록 번호 확인

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

### 2-2. 체인 ID 확인

```powershell
Invoke-RestMethod -Uri "https://ethereum-sepolia-rpc.publicnode.com" -Method POST -ContentType "application/json" -Body '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
```

예상 결과:
```
jsonrpc  id  result
-------  --  ------
2.0       1  0xaa36a7   ← 11155111 (Sepolia 고유 ID)
```

> 체인 ID가 다르면 같은 주소라도 다른 네트워크. Mainnet=1, Sepolia=11155111, 로컬=31337.

---

### 2-3. 내 지갑 잔액 조회

`내주소자리`를 MetaMask에서 복사한 주소로 교체 후 실행:

```powershell
Invoke-RestMethod -Uri "https://ethereum-sepolia-rpc.publicnode.com" -Method POST -ContentType "application/json" -Body '{"jsonrpc":"2.0","method":"eth_getBalance","params":["내주소자리","latest"],"id":1}'
```

예상 결과:
```
jsonrpc  id  result
-------  --  ------
2.0       1  0x27F7D0BDB92000   ← wei 단위 16진수
```

> wei → ETH 변환: `0x27F7D0BDB92000` = 11,111,000,000,000,000 wei = **0.01111 ETH**  
> PowerShell 변환: `[math]::Round([convert]::ToInt64("27F7D0BDB92000",16) / 1e18, 6)`

---

### 2-4. 최신 블록 상세 조회

```powershell
Invoke-RestMethod -Uri "https://ethereum-sepolia-rpc.publicnode.com" -Method POST -ContentType "application/json" -Body '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":1}' | Select-Object -ExpandProperty result | Select-Object number, timestamp, @{n="txCount";e={$_.transactions.Count}}
```

예상 결과:
```
number     timestamp  txCount
------     ---------  -------
0xab1234   0x68...    12
```

> `timestamp`는 Unix 초. PowerShell 변환: `[datetimeoffset]::FromUnixTimeSeconds([convert]::ToInt64("68...",16)).LocalDateTime`

---

### 2-5. 가스 가격 확인

```powershell
Invoke-RestMethod -Uri "https://ethereum-sepolia-rpc.publicnode.com" -Method POST -ContentType "application/json" -Body '{"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":1}'
```

예상 결과:
```
jsonrpc  id  result
-------  --  ------
2.0       1  0x12a05f200   ← wei 단위
```

> Gwei 변환: `[convert]::ToInt64("12a05f200",16) / 1e9` → 약 5 Gwei

---

### 2-6. Etherscan Sepolia에서 직접 확인

브라우저에서 내 주소 조회:
```
https://sepolia.etherscan.io/address/내주소자리
```

트랜잭션 탭에서 Sepolia에서 보낸 TX 이력 전체 확인 가능.

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

| 항목 | 로컬 빈 체인 | Sepolia | Mainnet Fork |
|------|------------|---------|-------------|
| RPC | `localhost:8545` | 공개 RPC | `localhost:8545` |
| 체인 ID | `0x7a69` (31337) | `0xaa36a7` (11155111) | `0x1` (1) |
| 블록 번호 | `0x0` | 수백만 | 수천만 |
| 내 잔액 | 10000 ETH (Hardhat 지급) | 실제 Sepolia 잔액 | 실제 보유량 |
| 가스 가격 | 1 Gwei | 시장가 (~5 Gwei) | 최신 메인넷가 |
| TX 내역 | 없음 | Etherscan Sepolia 조회 가능 | 실제 메인넷 TX |

---

## 다음 단계

PowerShell 확인 완료 후 `S04_check_networks.ts`의 TODO를 채운다.  
같은 동작을 ethers.js `JsonRpcProvider`로 구현하는 것이 목표.
