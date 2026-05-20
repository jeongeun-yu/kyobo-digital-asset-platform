import type { ReconcileResult, NftReconcileResult } from './ReconcileService';

export interface IReconcileService {
  reconcile(): Promise<ReconcileResult>;
  reconcileNftHoldings(userId: string): Promise<NftReconcileResult>;
  reconcileAllNftHoldings(): Promise<NftReconcileResult>;
  onMintEvent(tokenId: bigint, amount: bigint, blockNumber: number): Promise<void>;
  onBurnEvent(tokenId: bigint, amount: bigint, blockNumber: number): Promise<void>;
  getLastResult(): ReconcileResult | null;
}
