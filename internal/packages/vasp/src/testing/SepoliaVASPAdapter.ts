/**
 * SepoliaVASPAdapter — Sepolia 테스트넷 전용 IVASPAdapter
 *
 * ChainVASPAdapterBase(공통) 그대로 사용.
 * Anvil 전용 RPC(evm_snapshot 등)는 Sepolia에서 동작하지 않으므로 제공하지 않는다.
 *
 * 지원 시나리오:
 *   NORMAL   setMode('NORMAL')  → 정상 발행 + Issued 이벤트 (Etherscan에서 확인 가능)
 *   REVERT   setMode('REVERT')  → TX revert → IssuanceStatus FAILED
 *   NO_EMIT  setMode('NO_EMIT') → 민팅 성공, 이벤트 없음 → ChainEventListener 폴백
 *
 * 미지원 시나리오 (Anvil 로컬에서만 가능):
 *   PENDING  (evm_setAutomine — Sepolia 노드 제어 불가)
 *   REORG    (evm_snapshot   — Sepolia 노드 제어 불가)
 *
 * 사용:
 *   const vasp = new SepoliaVASPAdapter({
 *     rpcUrl:       process.env.SEPOLIA_RPC_URL!,   // Alchemy·Infura 등
 *     privateKey:   process.env.OPERATOR_PRIVATE_KEY!,
 *     mockVaspAddr: process.env.MOCK_VASP_ADDR!,    // Sepolia 배포 주소
 *   });
 */

import { ChainVASPAdapterBase } from './ChainVASPAdapterBase';
export type { MintMode } from './ChainVASPAdapterBase';

export class SepoliaVASPAdapter extends ChainVASPAdapterBase {
  // Sepolia는 체인 제어 RPC 없음 — 베이스 클래스만으로 완성
}
