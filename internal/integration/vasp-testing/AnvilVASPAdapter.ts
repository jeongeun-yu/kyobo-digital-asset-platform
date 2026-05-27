/**
 * AnvilVASPAdapter — 로컬 Anvil 노드 전용 IVASPAdapter
 *
 * ChainVASPAdapterBase(공통) + Anvil 전용 RPC 제어:
 *   freezeMining / resumeMining  → PENDING 시뮬레이션
 *   snapshot / revertToSnapshot  → REORG 시뮬레이션
 *   mineBlock                    → 수동 블록 생성
 *
 * 지원 시나리오:
 *   NORMAL   setMode('NORMAL')  → 정상 발행 + Issued 이벤트
 *   REVERT   setMode('REVERT')  → TX revert → IssuanceStatus FAILED
 *   NO_EMIT  setMode('NO_EMIT') → 민팅 성공, 이벤트 없음 → ChainEventListener 폴백
 *   PENDING  freezeMining()     → TX mempool 체류
 *   REORG    snapshot() → ... → revertToSnapshot(id)
 *
 * 사용:
 *   const vasp = new AnvilVASPAdapter({
 *     rpcUrl:       'http://127.0.0.1:8545',
 *     privateKey:   process.env.ANVIL_OPERATOR_KEY!,
 *     mockVaspAddr: process.env.MOCK_VASP_ADDR!,
 *   });
 */

import { ChainVASPAdapterBase } from './ChainVASPAdapterBase';
export type { MintMode } from './ChainVASPAdapterBase';

export class AnvilVASPAdapter extends ChainVASPAdapterBase {

  /**
   * 블록 자동 생성 중단 → TX가 mempool에 체류 (PENDING 시뮬레이션)
   * resumeMining() 또는 mineBlock() 전까지 TX 미확정
   */
  async freezeMining(): Promise<void> {
    await this.provider.send('evm_setAutomine', [false]);
    // evm_setIntervalMining([0])은 일부 Hardhat 버전에서 hardhat_mine을 방해할 수 있어 제거
  }

  /** 블록 자동 생성 재개 */
  async resumeMining(): Promise<void> {
    await this.provider.send('evm_setAutomine', [true]);
  }

  /** 블록 수동 생성 (freezeMining 중 특정 TX 확정용) */
  async mineBlock(count = 1): Promise<void> {
    // evm_mine(N)은 N을 timestamp로 해석 → hardhat_mine(hex_count) 사용
    await this.provider.send('hardhat_mine', [`0x${count.toString(16)}`]);
  }

  /**
   * 체인 상태 스냅샷 저장
   * @returns snapshotId — revertToSnapshot() 에 전달
   */
  async snapshot(): Promise<string> {
    return await this.provider.send('evm_snapshot', []);
  }

  /**
   * 스냅샷 시점으로 체인 롤백 (REORG 시뮬레이션)
   * snapshot() 이후 발행된 TX·블록이 모두 사라진다.
   */
  async revertToSnapshot(snapshotId: string): Promise<void> {
    const ok = await this.provider.send('evm_revert', [snapshotId]);
    if (!ok) throw new Error(`AnvilVASPAdapter: evm_revert failed (id=${snapshotId})`);
  }
}
