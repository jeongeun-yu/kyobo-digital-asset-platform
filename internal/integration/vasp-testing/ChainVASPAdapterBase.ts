/**
 * ChainVASPAdapterBase — AnvilVASPAdapter·SepoliaVASPAdapter 공통 베이스
 *
 * 공통 책임:
 *   - submitTransaction : ethers.js로 컨트랙트 메서드 직접 호출
 *   - screenAddress     : AML 스크리닝 (항상 통과 — 테스트 전용)
 *   - setMode / setRevertReason / getMode : MockVASP 시나리오 제어
 *
 * 네트워크별 확장:
 *   - AnvilVASPAdapter  : + freezeMining·resumeMining·snapshot·revertToSnapshot
 *   - SepoliaVASPAdapter: 추가 메서드 없음 (NORMAL·REVERT·NO_EMIT 시나리오만)
 */

import { ethers } from 'ethers';
import type {
  IVASPAdapter,
  VASPTransactionReceipt,
  SubmitTransactionParams,
  WalletInfo,
  TransferRequest,
  TransferResult,
} from '../../packages/vasp/src/interfaces/IVASPAdapter';
import MOCK_VASP_ABI from './MockVASP.abi.json';

export type MintMode = 'NORMAL' | 'REVERT' | 'NO_EMIT';

export const MINT_MODE_INDEX: Record<MintMode, number> = {
  NORMAL:  0,
  REVERT:  1,
  NO_EMIT: 2,
};

export interface ChainVASPAdapterConfig {
  rpcUrl:         string;
  privateKey:     string;
  mockVaspAddr:   string;
  confirmations?: number;
}

export abstract class ChainVASPAdapterBase implements IVASPAdapter {
  protected readonly provider:      ethers.JsonRpcProvider;
  protected readonly signer:        ethers.Wallet;
  protected readonly mockVasp:      ethers.Contract;
  protected readonly confirmations: number;

  constructor(config: ChainVASPAdapterConfig) {
    this.provider      = new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer        = new ethers.Wallet(config.privateKey, this.provider);
    this.mockVasp      = new ethers.Contract(config.mockVaspAddr, MOCK_VASP_ABI, this.signer);
    this.confirmations = config.confirmations ?? 1;
  }

  // Wallet queries chain nonce on every tx — no counter state to reset.
  // Kept for API compatibility with beforeEach callers.
  async resetNonce(): Promise<void> {}

  // ── IVASPAdapter ──────────────────────────────────────────────────────────

  async submitTransaction(params: SubmitTransactionParams): Promise<VASPTransactionReceipt> {
    const contract = new ethers.Contract(
      params.contractAddr,
      params.abi as ethers.InterfaceAbi,
      this.signer,
    );
    const tx      = await (contract as any)[params.method](...params.args);
    const receipt = await tx.wait(this.confirmations);
    return { txHash: receipt.hash, status: 'submitted', timestamp: Date.now() };
  }

  async screenAddress(_addr: string): Promise<{ flagged: boolean; reason?: string }> {
    return { flagged: false };
  }

  async createWallet(_userId: string): Promise<WalletInfo> {
    throw new Error(`${this.constructor.name}: createWallet not implemented`);
  }

  async getWallet(_userId: string): Promise<WalletInfo | null> {
    return null;
  }

  async transfer(_req: TransferRequest): Promise<TransferResult> {
    throw new Error(`${this.constructor.name}: transfer not implemented`);
  }

  async getTransferStatus(txHash: string): Promise<TransferResult> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) return { txHash, status: 'pending' };
    return { txHash, status: receipt.status === 1 ? 'completed' : 'failed' };
  }

  // ── MockVASP 시나리오 제어 (Anvil·Sepolia 공통) ──────────────────────────

  // nonce를 'latest' 태그로 직접 조회해 override로 전달한다.
  // ethers Wallet의 'pending' nonce 쿼리가 Hardhat automine 환경에서
  // 직전 tx 상태를 반영하지 못하는 타이밍 이슈를 방지하기 위함.
  private async _nonce(): Promise<number> {
    return this.provider.getTransactionCount(await this.signer.getAddress(), 'latest');
  }

  async setMode(mode: MintMode): Promise<void> {
    const fn = this.mockVasp['setMode'] as (
      m: number, overrides?: { nonce?: number }
    ) => Promise<ethers.ContractTransactionResponse>;
    await (await fn(MINT_MODE_INDEX[mode], { nonce: await this._nonce() })).wait();
  }

  async setRevertReason(reason: string): Promise<void> {
    const fn = this.mockVasp['setRevertReason'] as (
      r: string, overrides?: { nonce?: number }
    ) => Promise<ethers.ContractTransactionResponse>;
    await (await fn(reason, { nonce: await this._nonce() })).wait();
  }

  async getMode(): Promise<MintMode> {
    const fn   = this.mockVasp['mode'] as () => Promise<bigint>;
    const idx  = await fn();
    const modes: MintMode[] = ['NORMAL', 'REVERT', 'NO_EMIT'];
    return modes[Number(idx)] ?? 'NORMAL';
  }

  async blockNumber(): Promise<number> {
    return await this.provider.getBlockNumber();
  }
}
